import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/sessions.js';
import { qb, qbList } from './apps.js';
import { archiveSnapshot, fileAction, setJobPaused } from './archiveDl.js';
import { placed } from './mediaLibrary.js';

/**
 * MinisManager's Downloads page: every torrent in qBittorrent and every Internet Archive item, with
 * progress, speed and whether each piece reached the Jellyfin library — and pause/resume, "download
 * next", skip and retry.
 */
export async function downloadsRoutes(app: FastifyInstance) {
  app.get('/api/media/downloads', { preHandler: requireAuth }, async () => {
    const list = placed();
    const srcs = new Set(list.map((p) => p.src));
    const hashes = new Map<string, number>();
    for (const p of list) hashes.set(p.hash, (hashes.get(p.hash) ?? 0) + 1);
    const torrents = await qbList().catch(() => []);
    return {
      archive: archiveSnapshot((local) => srcs.has(local)),
      torrents: torrents.map((t) => {
        const x = t as typeof t & { category?: string; num_seeds?: number; upspeed?: number; added_on?: number };
        return {
          hash: t.hash,
          name: t.name,
          size: t.size,
          progress: t.progress,
          state: t.state,
          speed: t.dlspeed,
          up: x.upspeed ?? 0,
          etaSec: t.eta > 0 && t.eta < 8_640_000 ? t.eta : null,
          shelf: x.category || null,
          seeds: x.num_seeds ?? null,
          added: (x.added_on ?? 0) * 1000,
          inLibrary: hashes.get(t.hash) ?? 0,
        };
      }),
    };
  });
  app.post<{ Params: { id: string; act: string } }>('/api/media/downloads/archive/:id/:act', { preHandler: requireAuth }, async (req, reply) => {
    if (req.params.act !== 'pause' && req.params.act !== 'resume') return reply.code(400).send({ error: 'bad_action' });
    return setJobPaused(req.params.id, req.params.act === 'pause') ?? reply.code(404).send({ error: 'not_found' });
  });
  app.post<{ Params: { id: string }; Body: { name?: string; action?: string } }>('/api/media/downloads/archive/:id/file', { preHandler: requireAuth }, async (req, reply) => {
    const action = req.body?.action;
    if (action !== 'first' && action !== 'skip' && action !== 'retry' && action !== 'unskip') return reply.code(400).send({ error: 'bad_action' });
    return fileAction(req.params.id, String(req.body?.name ?? ''), action) ? { ok: true } : reply.code(404).send({ error: 'not_found' });
  });
  app.post<{ Params: { hash: string; act: string } }>('/api/media/downloads/torrent/:hash/:act', { preHandler: requireAuth }, async (req, reply) => {
    if (!/^[a-f0-9]{40}$/i.test(req.params.hash) || (req.params.act !== 'pause' && req.params.act !== 'resume')) return reply.code(400).send({ error: 'bad_request' });
    // qBittorrent 5 says stop/start; older versions pause/resume.
    const v5 = req.params.act === 'pause' ? 'stop' : 'start';
    const r = await qb(`torrents/${v5}`, { hashes: req.params.hash });
    if (r.status === 404) await qb(`torrents/${req.params.act}`, { hashes: req.params.hash });
    return { ok: true };
  });
}
