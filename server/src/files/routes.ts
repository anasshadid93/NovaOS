import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { audit } from '../db.js';
import { requireAuth, requireElevated } from '../auth/sessions.js';
import { categoryOf, ensureLibrary, fileIndex, invalidateIndex, LIBRARY_FOLDERS, libraryDir, safeFileName, uniquePath } from './files.js';
import { FsError, list, relOf as resolveRel, listTrash, mkdir, pruneTrash, purge, rename, resolveInRoot, restore, thumbnail, transfer, trash, validName } from './fsops.js';

export const MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif', heic: 'image/heic',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac',
  pdf: 'application/pdf', txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', log: 'text/plain; charset=utf-8', csv: 'text/plain; charset=utf-8', json: 'text/plain; charset=utf-8',
};

function fail(reply: FastifyReply, e: unknown) {
  if (e instanceof FsError) return reply.code(e.status).send({ error: e.code });
  throw e;
}

/** Streams a file with HTTP Range support (needed for seeking in videos). */
export function sendFile(reply: FastifyReply, abs: string, range: string | undefined, download: boolean) {
  const st = fs.statSync(abs);
  if (!st.isFile()) throw new FsError(400, 'not_a_file');
  const ext = path.extname(abs).slice(1).toLowerCase();
  // Anything not in the allow-list (html, svg, js…) is served as a download so it can never run in Manar's origin.
  const inlineType = MIME[ext];
  const type = download || !inlineType ? 'application/octet-stream' : inlineType;
  const name = path.basename(abs);
  reply
    .header('Content-Type', type)
    .header('Accept-Ranges', 'bytes')
    .header('Cache-Control', 'private, max-age=60')
    .header('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox")
    .header('Content-Disposition', `${download || !inlineType ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(name)}`);
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : st.size - Number(m[2]);
    let end = m[1] && m[2] ? Number(m[2]) : st.size - 1;
    start = Math.max(0, start);
    end = Math.min(end, st.size - 1);
    if (start > end) return reply.code(416).header('Content-Range', `bytes */${st.size}`).send();
    return reply
      .code(206)
      .header('Content-Range', `bytes ${start}-${end}/${st.size}`)
      .header('Content-Length', end - start + 1)
      .send(fs.createReadStream(abs, { start, end }));
  }
  return reply.header('Content-Length', st.size).send(fs.createReadStream(abs));
}

export async function fileRoutes(app: FastifyInstance) {
  try {
    ensureLibrary();
  } catch {
    /* data root not writable (tests/dev) */
  }
  void pruneTrash().catch(() => undefined);
  const t = setInterval(() => void pruneTrash().catch(() => undefined), 6 * 3600_000);
  t.unref();
  app.addHook('onClose', async () => clearInterval(t));

  app.get<{ Querystring: { path?: string; hidden?: string } }>('/api/fs/list', { preHandler: requireAuth }, async (req, reply) => {
    try {
      return list(req.query.path ?? '', req.query.hidden === '1');
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get<{ Querystring: { path: string; dl?: string } }>('/api/fs/file', { preHandler: requireAuth }, async (req, reply) => {
    try {
      return sendFile(reply, resolveInRoot(req.query.path), req.headers.range, req.query.dl === '1');
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get<{ Querystring: { path: string } }>('/api/fs/text', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const abs = resolveInRoot(req.query.path);
      const fd = fs.openSync(abs, 'r');
      const buf = Buffer.alloc(Math.min(fs.fstatSync(fd).size, 256 * 1024));
      fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      if (buf.includes(0)) return reply.code(415).send({ error: 'binary' });
      return { text: buf.toString('utf8'), truncated: buf.length === 256 * 1024 };
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get<{ Querystring: { path: string } }>('/api/fs/thumb', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const file = await thumbnail(req.query.path);
      return reply.header('Content-Type', 'image/jpeg').header('Cache-Control', 'private, max-age=86400').send(fs.createReadStream(file));
    } catch (e) {
      if (e instanceof FsError && e.status !== 415) return fail(reply, e);
      return reply.code(204).header('Cache-Control', 'private, max-age=3600').send();
    }
  });

  app.get<{ Querystring: { q: string; path?: string } }>('/api/fs/search', { preHandler: requireAuth }, async (req) => {
    const q = String(req.query.q ?? '').trim().toLowerCase();
    if (q.length < 2) return { results: [] };
    const under = (req.query.path ?? '').replace(/^\/+|\/+$/g, '');
    const results = (await fileIndex()).files
      .filter((f) => (!under || f.path.startsWith(under + '/')) && path.basename(f.path).toLowerCase().includes(q))
      .slice(0, 200);
    return { results };
  });

  app.post<{ Body: { path: string; name: string } }>('/api/fs/mkdir', { preHandler: requireAuth }, async (req, reply) => {
    try {
      return { path: mkdir(req.body?.path ?? '', req.body?.name) };
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** Text editor: save an existing file (`path`) or create a new one (`dir` + `name`, never overwriting). */
  app.post<{ Body: { path?: string; dir?: string; name?: string; text: string } }>('/api/fs/write', { preHandler: requireAuth }, async (req, reply) => {
    const { path: rel, dir, name, text } = req.body ?? ({} as never);
    if (typeof text !== 'string' || Buffer.byteLength(text) > 2 * 1024 ** 2) return reply.code(400).send({ error: 'bad_text' });
    try {
      let abs: string;
      if (typeof rel === 'string') {
        abs = resolveInRoot(rel);
        if (!fs.statSync(abs).isFile()) throw new FsError(400, 'not_a_file');
      } else {
        const parent = resolveInRoot(dir ?? '');
        if (!fs.statSync(parent).isDirectory()) throw new FsError(400, 'not_a_directory');
        abs = uniquePath(parent, validName(name));
      }
      fs.writeFileSync(abs, text);
      invalidateIndex();
      audit(req.session!.userId, 'file_write', { path: resolveRel(abs) });
      return { path: resolveRel(abs) };
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post<{ Body: { path: string; name: string } }>('/api/fs/rename', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const p = rename(req.body?.path, req.body?.name);
      invalidateIndex();
      return { path: p };
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post<{ Body: { paths: string[]; dest: string; mode: 'move' | 'copy' } }>('/api/fs/transfer', { preHandler: requireAuth }, async (req, reply) => {
    const { paths, dest, mode } = req.body ?? ({} as never);
    if (!Array.isArray(paths) || !paths.length || paths.length > 500 || (mode !== 'move' && mode !== 'copy')) return reply.code(400).send({ error: 'bad_args' });
    try {
      const out = await transfer(paths, dest ?? '', mode);
      invalidateIndex();
      audit(req.session!.userId, `fs_${mode}`, { count: paths.length, dest });
      return { paths: out };
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post<{ Body: { paths: string[] } }>('/api/fs/delete', { preHandler: requireAuth }, async (req, reply) => {
    const paths = req.body?.paths;
    if (!Array.isArray(paths) || !paths.length || paths.length > 500) return reply.code(400).send({ error: 'bad_args' });
    try {
      const n = await trash(paths);
      invalidateIndex();
      audit(req.session!.userId, 'fs_trash', { count: n });
      return { trashed: n };
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get('/api/fs/trash', { preHandler: requireAuth }, async () => listTrash());

  app.post<{ Body: { ids: string[] } }>('/api/fs/trash/restore', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const n = await restore(Array.isArray(req.body?.ids) ? req.body.ids : []);
      invalidateIndex();
      return { restored: n };
    } catch (e) {
      return fail(reply, e);
    }
  });

  // Permanent deletion needs a fresh passkey/TOTP confirmation.
  app.post<{ Body: { ids?: string[]; all?: boolean } }>('/api/fs/trash/purge', { preHandler: requireElevated }, async (req) => {
    const n = await purge(req.body?.all ? 'all' : Array.isArray(req.body?.ids) ? req.body.ids : []);
    audit(req.session!.userId, 'fs_purge', { count: n });
    return { purged: n };
  });

  app.post<{ Querystring: { path?: string } }>('/api/fs/upload', { preHandler: requireAuth }, async (req, reply) => {
    let dir: string;
    // Uploading at the top level (Data or Data/files) sorts files into files/<type>; inside any other folder they stay there.
    const autoSort = ['', 'files'].includes((req.query.path ?? '').replace(/^\/+|\/+$/g, ''));
    try {
      if (autoSort) ensureLibrary();
      dir = resolveInRoot(req.query.path ?? '');
      if (!fs.statSync(dir).isDirectory()) throw new FsError(400, 'not_a_directory');
    } catch (e) {
      return fail(reply, e);
    }
    const saved: string[] = [];
    try {
      for await (const part of req.files()) {
        const name = safeFileName(part.filename);
        const target = uniquePath(autoSort ? libraryDir(LIBRARY_FOLDERS[categoryOf(name)]) : dir, name);
        await pipeline(part.file, fs.createWriteStream(target, { flags: 'wx', mode: 0o644 }));
        if (part.file.truncated) {
          fs.rmSync(target, { force: true });
          return reply.code(413).send({ error: 'too_large' });
        }
        saved.push(resolveRel(target));
      }
    } catch (e) {
      const c = (e as NodeJS.ErrnoException).code;
      if (c === 'EACCES') return reply.code(403).send({ error: 'permission_denied' });
      if (c === 'ENOSPC') return reply.code(507).send({ error: 'disk_full' });
      throw e;
    }
    invalidateIndex();
    audit(req.session!.userId, 'upload', { files: saved.length, dir: req.query.path ?? '' });
    return { saved };
  });
}
