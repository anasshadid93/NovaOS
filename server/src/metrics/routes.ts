import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { audit, getDb } from '../db.js';
import { requireAuth, requireElevated } from '../auth/sessions.js';
import { HelperError, runHelper, UNIT_RE } from '../helper.js';
import { hub, ProcDiffer, type ProcView } from './hub.js';
import { processPorts } from './ports.js';
import { groupFromCgroup, processDetails, type SortKey } from './processes.js';
import { hostInfo, parseMeminfo } from './system.js';

const execFileP = promisify(execFile);
const SORTS: SortKey[] = ['cpu', 'rss', 'pid', 'name'];
const MAX_LIMIT = 150;

function procOwnerUid(pid: number): number | null {
  try {
    return fs.statSync(`/proc/${pid}`).uid;
  } catch {
    return null;
  }
}

export async function metricsRoutes(app: FastifyInstance) {
  hub.start();
  app.addHook('onClose', async () => hub.stop());

  app.get('/api/system/info', { preHandler: requireAuth }, async () => hostInfo());

  /** "Release memory": drops the page cache via the root helper and reports what was freed. */
  app.post('/api/system/release-memory', { preHandler: requireAuth }, async (req, reply) => {
    const before = parseMeminfo(fs.readFileSync('/proc/meminfo', 'utf8'));
    try {
      await runHelper({ cmd: 'drop-caches' }, 120_000);
    } catch (err) {
      return reply.code(502).send({ error: 'helper_failed', detail: (err as HelperError).stderr });
    }
    const after = parseMeminfo(fs.readFileSync('/proc/meminfo', 'utf8'));
    audit(req.session!.userId, 'release_memory', { freed: after.free - before.free });
    return { freed: Math.max(0, after.free - before.free), before: { free: before.free, cache: before.cache }, after: { free: after.free, cache: after.cache } };
  });

  app.get<{ Querystring: { range?: string } }>('/api/metrics/history', { preHandler: requireAuth }, async (req) => {
    const range = req.query.range === '24h' || req.query.range === '7d' ? req.query.range : '1h';
    return { range, points: hub.history(range) };
  });

  app.get<{ Params: { pid: string } }>('/api/processes/:pid', { preHandler: requireAuth }, async (req, reply) => {
    const pid = Number(req.params.pid);
    if (!Number.isInteger(pid) || pid < 1 || !fs.existsSync(`/proc/${pid}`)) return reply.code(404).send({ error: 'not_found' });
    return processDetails(pid);
  });

  app.get<{ Params: { pid: string } }>('/api/processes/:pid/ports', { preHandler: requireAuth }, async (req, reply) => {
    const pid = Number(req.params.pid);
    if (!Number.isInteger(pid) || pid < 1 || !fs.existsSync(`/proc/${pid}`)) return reply.code(404).send({ error: 'not_found' });
    return processPorts(pid);
  });

  app.post<{ Params: { pid: string }; Body: { signal?: string } }>(
    '/api/processes/:pid/signal',
    { preHandler: requireElevated },
    async (req, reply) => {
      const pid = Number(req.params.pid);
      const signal = req.body?.signal ?? 'TERM';
      if (!Number.isInteger(pid) || pid <= 1 || !['TERM', 'KILL', 'HUP'].includes(signal)) return reply.code(400).send({ error: 'bad_args' });
      if (pid === process.pid || pid === process.ppid) return reply.code(400).send({ error: 'self' });
      const uid = procOwnerUid(pid);
      if (uid === null) return reply.code(404).send({ error: 'not_found' });
      try {
        if (uid === process.getuid?.()) process.kill(pid, `SIG${signal}` as NodeJS.Signals);
        else await runHelper({ cmd: 'kill', signal: signal as 'TERM', pid });
      } catch (err) {
        return reply.code(err instanceof HelperError ? 502 : 500).send({ error: 'kill_failed', detail: (err as HelperError).stderr });
      }
      audit(req.session!.userId, 'process_signal', { pid, signal });
      return { ok: true };
    },
  );

  /** Restart = restart the systemd unit that owns the process. */
  app.post<{ Params: { pid: string } }>('/api/processes/:pid/restart', { preHandler: requireElevated }, async (req, reply) => {
    const pid = Number(req.params.pid);
    let group: string;
    try {
      group = groupFromCgroup(fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8'));
    } catch {
      return reply.code(404).send({ error: 'not_found' });
    }
    const [kind, unit] = group.split(/:(.*)/s);
    if (!unit || !UNIT_RE.test(unit) || unit === 'manar.service') return reply.code(400).send({ error: 'not_restartable' });
    try {
      if (kind === 'svc') await runHelper({ cmd: 'systemctl', action: 'restart', unit });
      else if (kind === 'user') await execFileP('systemctl', ['--user', 'restart', '--', unit], { timeout: 30_000 });
      else return reply.code(400).send({ error: 'not_restartable' });
    } catch (err) {
      return reply.code(502).send({ error: 'restart_failed', detail: (err as HelperError).stderr ?? String(err) });
    }
    audit(req.session!.userId, 'service_restart', { unit, via: pid });
    return { ok: true, unit };
  });

  // ---- Live stream ------------------------------------------------------
  app.get('/api/ws', { websocket: true }, (socket: WebSocket, req) => {
    if (!req.session || req.session.locked) {
      socket.close(req.session ? 4423 : 4401, req.session ? 'locked' : 'unauthorized');
      return;
    }
    let view: ProcView | null = null;
    const differ = new ProcDiffer();
    const send = (msg: unknown) => {
      // Drop frames for slow clients instead of buffering without bound.
      if (socket.readyState === socket.OPEN && socket.bufferedAmount < 512 * 1024) socket.send(JSON.stringify(msg));
    };
    const sub = {
      wantsProcs: false,
      onSystem: (s: unknown) => send({ t: 'sys', d: s }),
      onProcs: (list: Parameters<ProcDiffer['diff']>[0], groups: Parameters<ProcDiffer['diff']>[1]) => {
        if (view) send({ t: 'procs', d: differ.diff(list, groups, view) });
      },
    };
    const unsubscribe = hub.subscribe(sub);

    socket.on('message', (raw: Buffer) => {
      let msg: { t?: string; procs?: Partial<ProcView> | null };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.t !== 'view') return;
      if (!msg.procs) {
        view = null;
        sub.wantsProcs = false;
        return;
      }
      const p = msg.procs;
      view = {
        sort: SORTS.includes(p.sort as SortKey) ? (p.sort as SortKey) : 'cpu',
        q: typeof p.q === 'string' ? p.q.slice(0, 64) : '',
        mode: p.mode === 'group' ? 'group' : 'list',
        limit: Math.min(MAX_LIMIT, Math.max(10, Number(p.limit) || MAX_LIMIT)),
      };
      const first = !sub.wantsProcs;
      sub.wantsProcs = true;
      if (first) hub.primeProcs(sub);
    });

    // Session may be revoked while the socket is open: re-check every minute.
    const sid = req.session.id;
    const recheck = setInterval(() => {
      const alive = getDb().prepare('SELECT 1 FROM sessions WHERE id = ? AND expires_at > ?').get(sid, Date.now());
      if (!alive) socket.close(4401, 'unauthorized');
    }, 60_000);
    socket.on('close', () => {
      clearInterval(recheck);
      unsubscribe();
    });
  });
}
