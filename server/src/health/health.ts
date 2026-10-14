import fs from 'node:fs';
import os from 'node:os';
import tls from 'node:tls';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/sessions.js';
import { config } from '../config.js';
import { currentAlerts, type Alert } from '../notify/notify.js';
import { latestDiskHealth } from '../smart/health.js';
import { mounts } from '../system/info.js';
import { docker } from '../docker/client.js';
import { backupNow, backupState } from '../backup/backup.js';

/**
 * Server health on one page: every check the server runs, green or not, each with the one thing to do about
 * it (a button when MinisManager can fix it itself). Builds on the alert loop (notify.ts) and adds
 * what alerts don't cover: backup freshness, the HTTPS certificate, a pending reboot, and space
 * Docker could give back.
 */

const execFileP = promisify(execFile);
export type Level = 'ok' | 'warning' | 'critical';
export interface Check {
  id: string;
  group: 'storage' | 'disks' | 'heat' | 'memory' | 'apps' | 'services' | 'updates' | 'backup' | 'security' | 'system';
  level: Level;
  title: string;
  detail?: string;
  /** what to do: a MinisManager page, or an action this module runs */
  fix?: { kind: 'link'; href: string } | { kind: 'action'; action: string; arg?: string };
}

async function certDaysLeft(): Promise<number | null> {
  return new Promise((resolve) => {
    const s = tls.connect({ host: '127.0.0.1', port: config.port, servername: os.hostname(), rejectUnauthorized: false, timeout: 5000 }, () => {
      const c = s.getPeerCertificate();
      s.end();
      resolve(c?.valid_to ? Math.floor((Date.parse(c.valid_to) - Date.now()) / 86_400_000) : null);
    });
    s.on('error', () => resolve(null));
    s.on('timeout', () => {
      s.destroy();
      resolve(null);
    });
  });
}

let dfCache: { at: number; bytes: number } | null = null;
const toBytes = (v: string) => {
  const m = /([\d.]+)\s*([KMGT]?B)/i.exec(v);
  return m ? +m[1] * ({ B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 } as Record<string, number>)[m[2].toUpperCase()] : 0;
};
/**
 * Space Docker can safely give back: dangling images (old versions left by updates, no tag) and the
 * build cache. Not "unused" images — an app that's stopped (or Wolf's game image, started on demand)
 * still needs its image.
 */
async function dockerReclaimable(): Promise<number> {
  if (dfCache && Date.now() - dfCache.at < 10 * 60_000) return dfCache.bytes;
  try {
    const [{ stdout: dangling }, { stdout: df }] = await Promise.all([
      execFileP('docker', ['images', '-f', 'dangling=true', '--format', '{{.Size}}'], { timeout: 60_000 }),
      execFileP('docker', ['system', 'df', '--format', '{{json .}}'], { timeout: 60_000 }),
    ]);
    let bytes = dangling.split('\n').filter(Boolean).reduce((a, v) => a + toBytes(v), 0);
    for (const line of df.split('\n').filter(Boolean)) {
      const r = JSON.parse(line) as { Type: string; Reclaimable: string };
      if (r.Type === 'Build Cache') bytes += toBytes(r.Reclaimable);
    }
    dfCache = { at: Date.now(), bytes };
    return bytes;
  } catch {
    return 0;
  }
}

const GB = (n: number) => `${(n / 1e9).toFixed(n > 100e9 ? 0 : 1)} GB`;

export async function checks(): Promise<Check[]> {
  const out: Check[] = [];
  const alerts = currentAlerts();
  const byKind = (k: Alert['kind']) => alerts.filter((a) => a.kind === k);
  const lvl = (a: Alert): Level => (a.severity === 'critical' ? 'critical' : 'warning');

  // Storage: each disk's fill level, and what Docker could give back on the system disk.
  const reclaim = await dockerReclaimable();
  for (const m of mounts().filter((x) => x.size > 5e9)) {
    const pct = Math.round((m.used / m.size) * 100);
    const level: Level = pct >= 95 ? 'critical' : pct >= 85 ? 'warning' : 'ok';
    out.push({
      id: `disk:${m.mount}`,
      group: 'storage',
      level,
      title: `${m.mount} — ${pct}%`,
      detail: `${GB(m.avail)} free of ${GB(m.size)}`,
      fix: m.mount === '/' && reclaim > 1e9 ? { kind: 'action', action: 'docker-prune', arg: GB(reclaim) } : level !== 'ok' ? { kind: 'link', href: `/files?path=${encodeURIComponent(m.mount)}` } : undefined,
    });
  }

  // Disk health (SMART): one line per disk.
  for (const d of latestDiskHealth()) {
    out.push({ id: `smart:${d.name}`, group: 'disks', level: d.status === 'failing' ? 'critical' : d.status === 'warning' ? 'warning' : 'ok', title: `${d.model ?? d.name}`, detail: d.status === 'good' ? `${d.temperature ?? '—'}°C` : d.reasons.map((r) => r.code).join(', '), fix: { kind: 'link', href: '/disks' } });
  }

  // Heat and memory (from the alert loop, which watches them every minute).
  const hot = byKind('hot');
  out.push(hot.length ? { id: 'heat', group: 'heat', level: lvl(hot[0]), title: hot[0].title, detail: hot[0].detail, fix: { kind: 'link', href: '/processes' } } : { id: 'heat', group: 'heat', level: 'ok', title: 'Temperature' });
  const mem = byKind('mem_full');
  const usedPct = Math.round((1 - os.freemem() / os.totalmem()) * 100);
  out.push(mem.length ? { id: 'memory', group: 'memory', level: lvl(mem[0]), title: mem[0].title, detail: mem[0].detail, fix: { kind: 'link', href: '/processes' } } : { id: 'memory', group: 'memory', level: 'ok', title: 'Memory', detail: `${usedPct}%` });

  // Apps (containers): crashed, restarting or unhealthy — with a restart button.
  const ctr = byKind('container');
  if (ctr.length) for (const a of ctr) out.push({ id: a.key, group: 'apps', level: lvl(a), title: a.title, detail: a.detail, fix: { kind: 'action', action: 'container-restart', arg: a.key.split(':')[1] } });
  else {
    const list = await docker.list().catch(() => []);
    out.push({ id: 'apps', group: 'apps', level: 'ok', title: 'Apps', detail: `${list.filter((c) => c.State === 'running').length} running` });
  }

  // Services (systemd) that stopped with an error.
  const units = byKind('unit_failed');
  if (units.length) for (const a of units) out.push({ id: a.key, group: 'services', level: lvl(a), title: a.title, detail: a.detail });
  else out.push({ id: 'services', group: 'services', level: 'ok', title: 'Services' });

  // Updates.
  const sec = byKind('security');
  out.push(sec.length ? { id: 'security', group: 'updates', level: 'warning', title: sec[0].title, detail: sec[0].detail, fix: { kind: 'link', href: '/updates' } } : { id: 'security', group: 'updates', level: 'ok', title: 'Security updates' });
  if (fs.existsSync('/var/run/reboot-required')) out.push({ id: 'reboot', group: 'updates', level: 'warning', title: 'Restart needed', detail: 'An update (kernel or system library) takes effect after a restart.', fix: { kind: 'link', href: '/settings/power' } });

  // Backup: the last good one should be under ~a day and a half old.
  const b = backupState();
  const age = b.lastOk ? (Date.now() - b.lastOk) / 3600_000 : Infinity;
  out.push({ id: 'backup', group: 'backup', level: b.running ? 'ok' : age > 72 ? 'critical' : age > 36 ? 'warning' : 'ok', title: 'Backup', detail: b.running ? 'running' : b.lastOk ? `${Math.round(age)} h ago` : 'none yet', fix: !b.running && age > 36 ? { kind: 'action', action: 'backup-now' } : { kind: 'link', href: '/backup' } });

  // HTTPS certificate of MinisManager itself.
  const days = await certDaysLeft();
  if (days !== null) out.push({ id: 'cert', group: 'security', level: days < 7 ? 'critical' : days < 20 ? 'warning' : 'ok', title: 'HTTPS certificate', detail: `${days} days left` });

  // Anything else the alert loop raised that isn't covered above.
  const covered = new Set(['hot', 'mem_full', 'container', 'unit_failed', 'security', 'disk_full', 'disk_health']);
  for (const a of alerts.filter((x) => !covered.has(x.kind))) out.push({ id: a.key, group: 'system', level: lvl(a), title: a.title, detail: a.detail });
  return out;
}

export async function healthRoutes(app: FastifyInstance) {
  app.get('/api/health/checks', { preHandler: requireAuth }, async () => {
    const list = await checks();
    return { checks: list, worst: list.some((c) => c.level === 'critical') ? 'critical' : list.some((c) => c.level === 'warning') ? 'warning' : 'ok', uptimeSec: os.uptime() };
  });
  app.post<{ Body: { action?: string; arg?: string } }>('/api/health/fix', { preHandler: requireAuth }, async (req, reply) => {
    const { action, arg } = req.body ?? {};
    if (action === 'docker-prune') {
      // Dangling images and the build cache only (see dockerReclaimable): never volumes, never an app's image.
      await execFileP('docker', ['image', 'prune', '-f'], { timeout: 10 * 60_000 }).catch(() => null);
      await execFileP('docker', ['builder', 'prune', '-f'], { timeout: 10 * 60_000 }).catch(() => null);
      dfCache = null;
      return { ok: true };
    }
    if (action === 'container-restart' && arg && /^[\w.-]+$/.test(arg)) {
      await docker.restart(arg);
      return { ok: true };
    }
    if (action === 'backup-now') {
      void backupNow();
      return { ok: true };
    }
    return reply.code(400).send({ ok: false });
  });
}
