import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { getDb } from '../db.js';
import { requireAuth } from '../auth/sessions.js';
import { fileIndex, type IndexedFile } from './files.js';
import { thumbnail } from './fsops.js';
import { listVolumes, type Volume } from './volumes.js';

/**
 * Gallery: every photo and video under /srv/data (incl. mounted drives), newest first
 * by the date it was *taken* (JPEG EXIF DateTimeOriginal), falling back to the file date.
 * EXIF dates are read lazily in the background and cached in SQLite.
 */

const MIN_IMAGE_BYTES = 12 * 1024; // skip icons/thumbnails lying around
const EXIF_READ_BYTES = 128 * 1024;

/** Minimal JPEG EXIF reader: DateTimeOriginal (0x9003), else DateTime (0x0132). */
export function exifTaken(buf: Buffer): number | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let off = 2;
  while (off + 4 < buf.length) {
    if (buf[off] !== 0xff) return null;
    const marker = buf[off + 1];
    const len = buf.readUInt16BE(off + 2);
    if (marker === 0xe1 && buf.toString('ascii', off + 4, off + 10) === 'Exif\0\0') return parseTiff(buf, off + 10);
    if (marker === 0xda) return null; // start of image data: no EXIF
    off += 2 + len;
  }
  return null;
}

function parseTiff(buf: Buffer, t: number): number | null {
  const le = buf.toString('ascii', t, t + 2) === 'II';
  const u16 = (o: number) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o: number) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const readIfd = (ifd: number): Map<number, number> => {
    const tags = new Map<number, number>();
    if (t + ifd + 2 > buf.length) return tags;
    const n = u16(t + ifd);
    for (let i = 0; i < n; i++) {
      const e = t + ifd + 2 + i * 12;
      if (e + 12 > buf.length) break;
      tags.set(u16(e), e);
    }
    return tags;
  };
  const ascii = (entry: number) => {
    const count = u32(entry + 4);
    const at = count > 4 ? t + u32(entry + 8) : entry + 8;
    return at + count <= buf.length ? buf.toString('ascii', at, at + count).replace(/\0+$/, '') : '';
  };
  const toMs = (s: string) => {
    const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(s);
    if (!m || m[1] === '0000') return null;
    const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    return Number.isFinite(ms) ? ms : null;
  };
  try {
    const ifd0 = readIfd(u32(t + 4));
    const exifPtr = ifd0.get(0x8769);
    if (exifPtr !== undefined) {
      const exif = readIfd(u32(exifPtr + 8));
      const dto = exif.get(0x9003);
      if (dto !== undefined) {
        const v = toMs(ascii(dto));
        if (v) return v;
      }
    }
    const dt = ifd0.get(0x0132);
    return dt !== undefined ? toMs(ascii(dt)) : null;
  } catch {
    return null;
  }
}

async function readTaken(abs: string): Promise<number | null> {
  let fh: fs.promises.FileHandle | undefined;
  try {
    fh = await fs.promises.open(abs, 'r');
    const buf = Buffer.alloc(EXIF_READ_BYTES);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return exifTaken(buf.subarray(0, bytesRead));
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}

let filling = false;
/**
 * Reads EXIF dates for photos not cached yet, in the background. Reads are async and a few at a
 * time, so thousands of photos on a slow USB stick never hold up other requests.
 */
function fillExifCache(files: IndexedFile[]) {
  if (filling) return;
  const db = getDb();
  const known = new Map((db.prepare('SELECT path, mtime FROM media_meta').all() as { path: string; mtime: number }[]).map((r) => [r.path, r.mtime]));
  const todo = files.filter((f) => f.cat === 'images' && /\.jpe?g$/i.test(f.path) && known.get(f.path) !== f.mtime);
  if (!todo.length) return;
  filling = true;
  const ins = db.prepare('INSERT OR REPLACE INTO media_meta(path, mtime, taken) VALUES(?, ?, ?)');
  void (async () => {
    try {
      for (let i = 0; i < todo.length; i += 8) {
        const batch = todo.slice(i, i + 8);
        const taken = await Promise.all(batch.map((f) => readTaken(path.join(config.dataRoot, f.path))));
        db.exec('BEGIN');
        batch.forEach((f, k) => ins.run(f.path, f.mtime, taken[k]));
        db.exec('COMMIT');
      }
    } finally {
      filling = false;
    }
  })();
}

let warming = false;
/**
 * Makes gallery thumbnails ahead of time, newest first, one at a time (ffmpeg runs at low
 * priority), so scrolling the gallery finds them ready. Already-made ones are skipped quickly.
 */
function warmThumbs(list: MediaItem[]) {
  if (warming || config.dev || process.env.VITEST) return;
  warming = true;
  void (async () => {
    try {
      for (const m of list.slice(0, 20_000)) await thumbnail(m.path).catch(() => {});
    } finally {
      warming = false;
    }
  })();
}

export interface MediaItem {
  path: string;
  cat: 'images' | 'videos';
  size: number;
  mtime: number;
  taken: number;
}

/** Game artwork (covers, screenshots, marquees under Games/) and backup folders are not photos. */
const NOT_GALLERY = /(^|\/)(Games|Backups|\.trash|\.thumbs|thumbnails|extrafanart|extrathumbs)\//i;
/** Media-library artwork Jellyfin keeps next to films and episodes. */
const ARTWORK = /(^|\/)(poster|fanart|backdrop|banner|logo|landscape|thumb|clearart|clearlogo|disc|folder|season\d*-poster|[^/]*-thumb)\.(jpe?g|png|webp)$/i;

async function media(): Promise<MediaItem[]> {
  const files = (await fileIndex()).files.filter((f) => !NOT_GALLERY.test(f.path) && !ARTWORK.test(f.path) && (f.cat === 'videos' || (f.cat === 'images' && f.size >= MIN_IMAGE_BYTES)));
  fillExifCache(files);
  const taken = new Map((getDb().prepare('SELECT path, taken FROM media_meta WHERE taken IS NOT NULL').all() as { path: string; taken: number }[]).map((r) => [r.path, r.taken]));
  const list = files
    .map((f) => ({ path: f.path, cat: f.cat as MediaItem['cat'], size: f.size, mtime: f.mtime, taken: taken.get(f.path) ?? f.mtime }))
    .sort((a, b) => b.taken - a.taken);
  warmThumbs(list);
  return list;
}

let volCache: { at: number; vols: Volume[] } | null = null;
async function volumes(): Promise<Volume[]> {
  if (!volCache || Date.now() - volCache.at > 5000) volCache = { at: Date.now(), vols: await listVolumes() };
  return volCache.vols;
}

const under = (p: string, dir: string) => p.startsWith(dir + '/');

/**
 * Drive filter: "internal" = everything not on a mounted external drive, a partition id = only
 * that drive, anything else = all drives. Returns null for an unknown/unmounted drive.
 */
async function byDrive(list: MediaItem[], drive: string | undefined): Promise<MediaItem[] | null> {
  if (!drive || drive === 'all') return list;
  const ext = (await volumes()).filter((v) => v.id !== 'internal' && v.state === 'mounted' && v.path);
  if (drive === 'internal') return list.filter((m) => !ext.some((v) => under(m.path, v.path!)));
  const vol = ext.find((v) => v.id === drive);
  return vol ? list.filter((m) => under(m.path, vol.path!)) : null;
}

export async function galleryRoutes(app: FastifyInstance) {
  // Thumbnails are made in the background (3 min after start, then every 6 h), so the first
  // visit to the gallery finds them ready instead of waiting for ffmpeg.
  if (!config.dev && !process.env.VITEST) {
    const warm = () => void media().catch(() => null);
    const first = setTimeout(warm, 3 * 60_000);
    const every = setInterval(warm, 6 * 3600_000);
    app.addHook('onClose', async () => {
      clearTimeout(first);
      clearInterval(every);
    });
  }
  /** Drives to pick from, with how many photos/videos each holds (unmounted ones can be mounted). */
  app.get('/api/gallery/drives', { preHandler: requireAuth }, async () => {
    const all = await media();
    const vols = await volumes();
    const ext = vols.filter((v) => v.id !== 'internal' && v.state === 'mounted' && v.path);
    return vols
      .filter((v) => v.id === 'internal' || v.state === 'mounted' || v.state === 'unmounted')
      .map((v) => ({
        id: v.id,
        name: v.name,
        removable: v.removable || v.transport === 'usb',
        state: v.state,
        count:
          v.id === 'internal'
            ? all.filter((m) => !ext.some((e) => under(m.path, e.path!))).length
            : v.state === 'mounted' && v.path
              ? all.filter((m) => under(m.path, v.path!)).length
              : null,
      }));
  });

  app.get<{ Querystring: { kind?: string; album?: string; drive?: string; offset?: string; limit?: string } }>('/api/gallery', { preHandler: requireAuth }, async (req, reply) => {
    const kind = req.query.kind === 'photos' ? 'images' : req.query.kind === 'videos' ? 'videos' : null;
    const album = req.query.album;
    let list = await byDrive(await media(), req.query.drive);
    if (!list) return reply.code(404).send({ error: 'no_drive' });
    if (kind) list = list.filter((m) => m.cat === kind);
    if (album !== undefined) list = list.filter((m) => path.posix.dirname(m.path) === album);
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 240));
    const counts = { all: list.length, photos: list.filter((m) => m.cat === 'images').length, videos: list.filter((m) => m.cat === 'videos').length };
    return { total: list.length, counts, items: list.slice(offset, offset + limit) };
  });

  /** Albums = folders that contain photos/videos, newest first, with a cover. */
  app.get<{ Querystring: { drive?: string } }>('/api/gallery/albums', { preHandler: requireAuth }, async (req, reply) => {
    const list = await byDrive(await media(), req.query.drive);
    if (!list) return reply.code(404).send({ error: 'no_drive' });
    const byDir = new Map<string, { path: string; count: number; cover: MediaItem; latest: number }>();
    for (const m of list) {
      const dir = path.posix.dirname(m.path);
      const a = byDir.get(dir);
      if (!a) byDir.set(dir, { path: dir, count: 1, cover: m, latest: m.taken });
      else a.count++;
    }
    return [...byDir.values()].sort((a, b) => b.latest - a.latest);
  });
}
