import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/sessions.js';
import { backupNow, backupState, EXCLUDES, listDir, repoSize, REPO, restore, snapshots, SOURCES } from './backup.js';

/** NovaOS's Backup page: status, history, browsing a snapshot and restoring from it. */
export async function backupRoutes(app: FastifyInstance) {
  // restic and du are slow on a big repository: their answers are kept a minute (the page polls).
  let cache: { at: number; lastAt?: number; snaps: Awaited<ReturnType<typeof snapshots>>; size: number } | null = null;
  app.get('/api/backup', { preHandler: requireAuth }, async () => {
    const st = backupState();
    if (!cache || (Date.now() - cache.at > 60_000 && !st.running) || cache.lastAt !== st.last?.finishedAt) {
      const [snaps, size] = st.running && cache ? [cache.snaps, cache.size] : await Promise.all([snapshots(), repoSize()]);
      cache = { at: Date.now(), lastAt: st.last?.finishedAt, snaps, size };
    }
    const { snaps, size } = cache;
    return { state: st, snapshots: snaps.map((s) => ({ id: s.id, short: s.short_id, time: s.time, paths: s.paths })), repo: REPO(), repoBytes: size, sources: SOURCES, excludes: EXCLUDES };
  });
  app.post('/api/backup/run', { preHandler: requireAuth }, async () => {
    void backupNow();
    return { ok: true };
  });
  app.get<{ Querystring: { snapshot?: string; path?: string } }>('/api/backup/ls', { preHandler: requireAuth }, async (req, reply) => {
    try {
      return { entries: await listDir(String(req.query.snapshot ?? ''), String(req.query.path ?? '/')) };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message.slice(0, 200) });
    }
  });
  app.post<{ Body: { snapshot?: string; path?: string } }>('/api/backup/restore', { preHandler: requireAuth }, async (req, reply) => {
    try {
      return { ok: true, to: await restore(String(req.body?.snapshot ?? ''), String(req.body?.path ?? '')) };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message.slice(0, 200) });
    }
  });
}
