import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { getDb } from '../db.js';
import { requireAuth } from '../auth/sessions.js';
import { fileIndex } from './files.js';
import { resolveInRoot } from './fsops.js';

const execFileP = promisify(execFile);

/**
 * Music and video: song tags and covers (ffprobe/ffmpeg, cached), playlists, resume positions,
 * on-the-fly conversion for videos the browser can't play (Radeon VAAPI, else x264), subtitles.
 */

// ---- Music library -------------------------------------------------------------------------
export interface Track {
  path: string;
  title: string;
  artist: string | null;
  album: string | null;
  track: number | null;
  duration: number | null;
  mtime: number;
}

async function probeTags(abs: string) {
  const { stdout } = await execFileP('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', abs], { timeout: 15_000 });
  const j = JSON.parse(stdout) as { format?: { duration?: string; tags?: Record<string, string> }; streams?: { codec_type: string; disposition?: { attached_pic?: number } }[] };
  const tags = Object.fromEntries(Object.entries(j.format?.tags ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    title: tags.title ?? null,
    artist: tags.artist ?? tags.album_artist ?? null,
    album: tags.album ?? null,
    track: tags.track ? parseInt(tags.track, 10) || null : null,
    duration: j.format?.duration ? Math.round(Number(j.format.duration)) : null,
    cover: (j.streams ?? []).some((s) => s.codec_type === 'video' && s.disposition?.attached_pic),
  };
}

let filling = false;
/** Reads tags for songs not cached yet, a few at a time in the background. */
function fillTags(files: { path: string; mtime: number }[]) {
  if (filling) return;
  const db = getDb();
  const known = new Map((db.prepare('SELECT path, mtime FROM audio_meta').all() as { path: string; mtime: number }[]).map((r) => [r.path, r.mtime]));
  const todo = files.filter((f) => known.get(f.path) !== f.mtime);
  if (!todo.length) return;
  filling = true;
  const ins = db.prepare('INSERT OR REPLACE INTO audio_meta(path, mtime, title, artist, album, track, duration, cover) VALUES(?, ?, ?, ?, ?, ?, ?, ?)');
  void (async () => {
    try {
      for (let i = 0; i < todo.length; i += 4) {
        const batch = todo.slice(i, i + 4);
        const tags = await Promise.all(batch.map((f) => probeTags(path.join(config.dataRoot, f.path)).catch(() => null)));
        batch.forEach((f, k) => {
          const t = tags[k];
          ins.run(f.path, f.mtime, t?.title ?? null, t?.artist ?? null, t?.album ?? null, t?.track ?? null, t?.duration ?? null, t?.cover ? 1 : 0);
        });
      }
    } finally {
      filling = false;
    }
  })();
}

async function library(): Promise<Track[]> {
  const files = (await fileIndex()).files.filter((f) => f.cat === 'audio');
  fillTags(files);
  const meta = new Map(
    (getDb().prepare('SELECT path, title, artist, album, track, duration FROM audio_meta').all() as Omit<Track, 'mtime'>[]).map((r) => [r.path, r]),
  );
  return files.map((f) => {
    const m = meta.get(f.path);
    const name = path.basename(f.path).replace(/\.[^.]+$/, '');
    return {
      path: f.path,
      mtime: f.mtime,
      title: m?.title || name,
      artist: m?.artist ?? null,
      // No album tag: the folder is the album.
      album: m?.album ?? (path.basename(path.dirname(f.path)) || null),
      track: m?.track ?? null,
      duration: m?.duration ?? null,
    };
  });
}

/** Cover: embedded picture, else cover.jpg/folder.jpg next to the song. Cached as JPEG. */
async function cover(rel: string): Promise<string | null> {
  const abs = resolveInRoot(rel);
  const st = fs.statSync(abs);
  const dir = path.join(config.dataDir, 'covers');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, crypto.createHash('sha1').update(`${abs}\0${st.mtimeMs}`).digest('hex') + '.jpg');
  if (fs.existsSync(out)) return out;
  try {
    await execFileP('ffmpeg', ['-v', 'error', '-i', abs, '-an', '-frames:v', '1', '-vf', 'scale=400:400:force_original_aspect_ratio=increase,crop=400:400', '-q:v', '4', '-y', out], { timeout: 15_000 });
    if (fs.existsSync(out) && fs.statSync(out).size > 0) return out;
  } catch {
    /* no embedded picture */
  }
  for (const n of ['cover.jpg', 'folder.jpg', 'Cover.jpg', 'Folder.jpg', 'front.jpg', 'cover.png']) {
    const p = path.join(path.dirname(abs), n);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ---- Video ----------------------------------------------------------------------------------
let vaapi: boolean | null = null;
async function hasVaapi(): Promise<boolean> {
  if (vaapi !== null) return vaapi;
  try {
    await execFileP('ffmpeg', ['-v', 'error', '-vaapi_device', config.renderNode, '-f', 'lavfi', '-i', 'testsrc=size=320x240:duration=0.2', '-vf', 'format=nv12,hwupload', '-c:v', 'h264_vaapi', '-f', 'null', '-'], { timeout: 15_000 });
    vaapi = true;
  } catch {
    vaapi = false;
  }
  return vaapi;
}

/** SRT → WebVTT. */
export function srtToVtt(srt: string): string {
  return 'WEBVTT\n\n' + srt.replace(/\r/g, '').replace(/(\d\d:\d\d:\d\d),(\d\d\d)/g, '$1.$2').trim() + '\n';
}

const SUB_EXT = /\.(srt|vtt)$/i;

export async function mediaRoutes(app: FastifyInstance) {
  app.get('/api/music/library', { preHandler: requireAuth }, async () => ({ tracks: await library(), filling }));

  app.get<{ Querystring: { path: string } }>('/api/music/cover', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const file = await cover(req.query.path);
      if (!file) return reply.code(204).header('Cache-Control', 'private, max-age=86400').send();
      reply.header('Cache-Control', 'private, max-age=86400').type(file.endsWith('.png') ? 'image/png' : 'image/jpeg');
      return reply.send(fs.createReadStream(file));
    } catch {
      return reply.code(204).send();
    }
  });

  // Playlists.
  app.get('/api/music/playlists', { preHandler: requireAuth }, async () =>
    (getDb().prepare('SELECT id, name, items, updated_at AS updatedAt FROM playlists ORDER BY name').all() as { id: number; name: string; items: string; updatedAt: number }[]).map((p) => ({ ...p, items: JSON.parse(p.items) as string[] })),
  );
  app.post<{ Body: { name: string; items?: string[] } }>('/api/music/playlists', { preHandler: requireAuth }, async (req, reply) => {
    const name = String(req.body?.name ?? '').trim().slice(0, 80);
    const items = Array.isArray(req.body?.items) ? req.body.items.filter((x) => typeof x === 'string').slice(0, 5000) : [];
    if (!name) return reply.code(400).send({ error: 'bad_name' });
    const r = getDb().prepare('INSERT INTO playlists(name, items, updated_at) VALUES(?, ?, ?)').run(name, JSON.stringify(items), Date.now());
    return { id: Number(r.lastInsertRowid) };
  });
  app.put<{ Params: { id: string }; Body: { name?: string; items?: string[] } }>('/api/music/playlists/:id', { preHandler: requireAuth }, async (req, reply) => {
    const row = getDb().prepare('SELECT name, items FROM playlists WHERE id = ?').get(Number(req.params.id)) as { name: string; items: string } | undefined;
    if (!row) return reply.code(404).send({ error: 'not_found' });
    const name = typeof req.body?.name === 'string' && req.body.name.trim() ? req.body.name.trim().slice(0, 80) : row.name;
    const items = Array.isArray(req.body?.items) ? req.body.items.filter((x) => typeof x === 'string').slice(0, 5000) : (JSON.parse(row.items) as string[]);
    getDb().prepare('UPDATE playlists SET name = ?, items = ?, updated_at = ? WHERE id = ?').run(name, JSON.stringify(items), Date.now(), Number(req.params.id));
    return { ok: true };
  });
  app.delete<{ Params: { id: string } }>('/api/music/playlists/:id', { preHandler: requireAuth }, async (req) => {
    getDb().prepare('DELETE FROM playlists WHERE id = ?').run(Number(req.params.id));
    return { ok: true };
  });

  // Where you stopped (videos, long audio).
  app.get<{ Querystring: { path: string } }>('/api/media/progress', { preHandler: requireAuth }, async (req) => {
    return getDb().prepare('SELECT position, duration FROM media_progress WHERE path = ?').get(String(req.query.path)) ?? { position: 0, duration: 0 };
  });
  app.put<{ Body: { path: string; position: number; duration: number } }>('/api/media/progress', { preHandler: requireAuth }, async (req, reply) => {
    const { path: p, position, duration } = req.body ?? ({} as never);
    if (typeof p !== 'string' || !Number.isFinite(position) || !Number.isFinite(duration)) return reply.code(400).send({ error: 'bad_args' });
    // Finished (last 5%) counts as watched: start from the beginning next time.
    const pos = duration > 0 && position / duration > 0.95 ? 0 : Math.max(0, position);
    getDb().prepare('INSERT OR REPLACE INTO media_progress(path, position, duration, updated_at) VALUES(?, ?, ?, ?)').run(p, pos, duration, Date.now());
    return { ok: true };
  });

  // Subtitles next to a video: movie.srt, movie.en.srt, movie.ar.vtt…
  app.get<{ Querystring: { path: string } }>('/api/media/subtitles', { preHandler: requireAuth }, async (req) => {
    try {
      const abs = resolveInRoot(req.query.path);
      const stem = path.basename(abs).replace(/\.[^.]+$/, '');
      const dir = path.dirname(abs);
      return {
        subs: fs
          .readdirSync(dir)
          .filter((n) => SUB_EXT.test(n) && n.startsWith(stem))
          .map((n) => ({ path: path.relative(config.dataRoot, path.join(dir, n)), label: n.slice(stem.length).replace(SUB_EXT, '').replace(/^[._-]/, '') || 'Subtitles' })),
      };
    } catch {
      return { subs: [] };
    }
  });
  app.get<{ Querystring: { path: string } }>('/api/media/subtitle', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const abs = resolveInRoot(req.query.path);
      if (!SUB_EXT.test(abs)) return reply.code(400).send({ error: 'not_subtitles' });
      const text = fs.readFileSync(abs, 'utf8');
      return reply.type('text/vtt; charset=utf-8').send(abs.toLowerCase().endsWith('.vtt') ? text : srtToVtt(text));
    } catch {
      return reply.code(404).send({ error: 'not_found' });
    }
  });

  // Videos the browser can't decode: converted while streaming (fragmented MP4). `t` = start second.
  app.get<{ Querystring: { path: string; t?: string } }>('/api/media/transcode', { preHandler: requireAuth }, async (req, reply) => {
    let abs: string;
    try {
      abs = resolveInRoot(req.query.path);
    } catch {
      return reply.code(404).send({ error: 'not_found' });
    }
    const start = Math.max(0, Number(req.query.t) || 0);
    const hw = await hasVaapi();
    const args = [
      '-v', 'error',
      ...(hw ? ['-vaapi_device', config.renderNode] : []),
      '-ss', String(start), '-i', abs,
      '-map', '0:v:0', '-map', '0:a:0?',
      ...(hw ? ['-vf', "scale='min(1920,iw)':-2,format=nv12,hwupload", '-c:v', 'h264_vaapi', '-qp', '24'] : ['-vf', "scale='min(1920,iw)':-2", '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p']),
      '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1',
    ];
    const ff = spawn('nice', ['-n', '10', 'ffmpeg', ...args], { stdio: ['ignore', 'pipe', 'ignore'] });
    req.raw.on('close', () => ff.kill('SIGKILL'));
    reply.header('Content-Type', 'video/mp4').header('Cache-Control', 'no-store');
    return reply.send(ff.stdout);
  });

  app.get<{ Querystring: { path: string } }>('/api/media/probe', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const abs = resolveInRoot(req.query.path);
      const { stdout } = await execFileP('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', abs], { timeout: 15_000 });
      const j = JSON.parse(stdout) as { format?: { duration?: string }; streams?: { codec_type: string; codec_name: string }[] };
      return { duration: Number(j.format?.duration ?? 0), video: j.streams?.find((s) => s.codec_type === 'video')?.codec_name ?? null, audio: j.streams?.find((s) => s.codec_type === 'audio')?.codec_name ?? null };
    } catch {
      return reply.code(404).send({ error: 'not_found' });
    }
  });
}
