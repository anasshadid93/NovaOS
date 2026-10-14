import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { audit, kvGet, kvSet } from '../db.js';
import { requireAuth, requireElevated } from '../auth/sessions.js';
import { docker } from '../docker/client.js';
import { enqueue, hasActiveTask, registerTask } from '../tasks/tasks.js';
import { installedApp } from '../store/installer.js';

const execFileP = promisify(execFile);

/**
 * Updates: Ubuntu packages (apt, through the root helper, run as their own systemd unit) and
 * container images (same tag rebuilt upstream, or a newer version tag on Docker Hub).
 */

// ---- System ------------------------------------------------------------------------------
export interface AptUpdate {
  name: string;
  from: string;
  to: string;
  security: boolean;
}

/** `apt list --upgradable` → packages. Works without root (reads the cached lists). */
export function parseApt(out: string): AptUpdate[] {
  const list: AptUpdate[] = [];
  for (const line of out.split('\n')) {
    const m = /^([^/\s]+)\/(\S+)\s+(\S+)\s+\S+\s+\[upgradable from: ([^\]]+)\]/.exec(line);
    if (m) list.push({ name: m[1], to: m[3], from: m[4], security: m[2].includes('-security') });
  }
  return list;
}

/** Packages whose update restarts something you'd notice. */
const DISRUPTIVE = /^(docker|containerd|tailscale|linux-image|linux-generic|systemd|openssh-server|nodejs)/;

export async function systemStatus() {
  let out = '';
  try {
    out = (await execFileP('apt', ['list', '--upgradable'], { timeout: 30_000, env: { ...process.env, LANG: 'C' } })).stdout;
  } catch (e) {
    out = (e as { stdout?: string }).stdout ?? '';
  }
  // Held packages (apt-mark hold) are never installed by "upgrade": list them apart, not as pending.
  // On the server the stock Ubuntu kernel is held because it runs its own kernel.
  let held = new Set<string>();
  try {
    held = new Set((await execFileP('apt-mark', ['showhold'], { timeout: 15_000 })).stdout.split('\n').filter(Boolean));
  } catch {
    /* none */
  }
  const all = parseApt(out);
  const updates = all.filter((u) => !held.has(u.name));
  const rebootFile = '/var/run/reboot-required';
  const rebootPkgs = fs.existsSync('/var/run/reboot-required.pkgs') ? fs.readFileSync('/var/run/reboot-required.pkgs', 'utf8').split('\n').filter(Boolean) : [];
  let listsAge: number | null = null;
  try {
    listsAge = fs.statSync('/var/lib/apt/lists').mtimeMs;
  } catch {
    /* unknown */
  }
  return {
    updates,
    held: all.filter((u) => held.has(u.name)),
    security: updates.filter((u) => u.security).length,
    disruptive: updates.filter((u) => DISRUPTIVE.test(u.name)).map((u) => u.name),
    rebootRequired: fs.existsSync(rebootFile),
    rebootPkgs,
    checkedAt: listsAge,
  };
}

registerTask('system.refresh', async (ctx) => {
  ctx.progress('Refreshing package lists');
  await ctx.run('sudo', ['-n', config.helperPath, 'apt-refresh'], { timeoutMs: 10 * 60_000 });
});

registerTask('system.upgrade', async (ctx) => {
  ctx.progress('Installing updates');
  await ctx.run('sudo', ['-n', config.helperPath, 'apt-upgrade'], { timeoutMs: 2 * 60 * 60_000 });
  if (fs.existsSync('/var/run/reboot-required')) ctx.log('A restart of the server is needed to finish (kernel or system libraries).');
});

// ---- Apps --------------------------------------------------------------------------------
export interface ImageUpdate {
  container: string;
  app: string | null;
  image: string;
  tag: string;
  /** The same tag was rebuilt upstream (e.g. :latest). */
  rebuilt: boolean;
  /** A newer version tag of the same kind (e.g. 3.1.0 → 3.2.0). */
  newerTag: string | null;
}

/** Docker Hub repository for an image reference, or null for registries we can't list. */
export function hubRepo(image: string): { repo: string; tag: string } | null {
  const [ref, tag = 'latest'] = image.split('@')[0].split(/:(?=[^/]+$)/);
  let name = ref;
  if (name.startsWith('lscr.io/linuxserver/')) name = name.replace('lscr.io/', '');
  else if (name.startsWith('docker.io/')) name = name.slice('docker.io/'.length);
  else if (/^[^/]+\.[^/]+\//.test(name)) return null; // other registries (ghcr.io, quay.io…)
  if (!name.includes('/')) name = `library/${name}`;
  return { repo: name, tag };
}

/** The "shape" of a tag, so 3.1.0 is compared with 3.2.0 and 627c19be-ls57 with d2f5e718-ls58. */
export function tagShape(tag: string): RegExp {
  const esc = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${esc.replace(/[0-9a-f]{7,}/g, '[0-9a-f]+').replace(/\d+/g, '\\d+')}$`);
}

async function newerTag(image: string): Promise<string | null> {
  const r = hubRepo(image);
  if (!r || r.tag === 'latest') return null;
  const res = await fetch(`https://hub.docker.com/v2/repositories/${r.repo}/tags?page_size=60&ordering=last_updated`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return null;
  const tags = ((await res.json()) as { results: { name: string; last_updated: string }[] }).results;
  const shape = tagShape(r.tag);
  const same = tags.filter((t) => shape.test(t.name));
  const mine = same.find((t) => t.name === r.tag);
  const newest = same[0];
  if (!newest || newest.name === r.tag) return null;
  // Only if it's really newer than ours (ours may be missing from this page: then it's older).
  return !mine || newest.last_updated > mine.last_updated ? newest.name : null;
}

async function rebuilt(image: string, localDigests: string[]): Promise<boolean> {
  try {
    const d = (await docker.distribution(image)).Descriptor.digest;
    return !!d && localDigests.length > 0 && !localDigests.some((x) => x.endsWith(d));
  } catch {
    return false;
  }
}

async function checkApps(): Promise<ImageUpdate[]> {
  const out: ImageUpdate[] = [];
  for (const c of await docker.list()) {
    const image = c.Image;
    if (image.startsWith('sha256:')) continue;
    let digests: string[] = [];
    try {
      digests = (await docker.imageInspect(c.ImageID)).RepoDigests ?? [];
    } catch {
      /* gone */
    }
    const [isRebuilt, newer] = await Promise.all([rebuilt(image, digests), newerTag(image).catch(() => null)]);
    out.push({ container: c.Names[0]?.replace(/^\//, '') ?? c.Id.slice(0, 12), app: c.Labels['manar.app'] ?? null, image, tag: hubRepo(image)?.tag ?? image.split(':').pop() ?? '', rebuilt: isRebuilt, newerTag: newer });
  }
  kvSet('app_updates', JSON.stringify({ at: Date.now(), list: out }));
  return out;
}

/** Store app: switch its compose file to the newer tag, then pull and recreate (rollback kept). */
registerTask('app.retag', async (ctx, params) => {
  const id = String(params.id);
  const from = String(params.from);
  const to = String(params.to);
  const file = path.join(config.appsDir, id, 'compose.yaml');
  const text = fs.readFileSync(file, 'utf8');
  if (!text.includes(from)) throw new Error(`image ${from} not found in compose.yaml`);
  fs.copyFileSync(file, `${file}.bak-${Date.now()}`);
  const target = from.replace(/:[^:/]+$/, `:${to}`);
  fs.writeFileSync(file, text.split(from).join(target));
  ctx.log(`compose.yaml: ${from} → ${target}`);
  ctx.progress('Pulling and recreating');
  enqueue('app.update', `Update ${id}`, { id }, id);
});

export async function updateRoutes(app: FastifyInstance) {
  app.get('/api/updates/system', { preHandler: requireAuth }, async () => systemStatus());
  app.post('/api/updates/system/refresh', { preHandler: requireAuth }, async () => ({ task: enqueue('system.refresh', 'Check for system updates') }));
  app.post('/api/updates/system/install', { preHandler: requireElevated }, async (req) => {
    audit(req.session!.userId, 'system_upgrade');
    return { task: enqueue('system.upgrade', 'Install system updates') };
  });

  app.get('/api/updates/apps', { preHandler: requireAuth }, async () => {
    try {
      return JSON.parse(kvGet('app_updates') ?? '{"at":0,"list":[]}');
    } catch {
      return { at: 0, list: [] };
    }
  });
  app.post('/api/updates/apps/check', { preHandler: requireAuth }, async () => ({ at: Date.now(), list: await checkApps() }));
  app.post<{ Body: { app: string; from: string; to: string } }>('/api/updates/apps/retag', { preHandler: requireElevated }, async (req, reply) => {
    const { app: id, from, to } = req.body ?? ({} as never);
    if (!installedApp(String(id))) return reply.code(404).send({ error: 'not_found' });
    if (typeof to !== 'string' || !/^[\w][\w.-]{0,127}$/.test(to) || typeof from !== 'string') return reply.code(400).send({ error: 'bad_tag' });
    if (hasActiveTask(id)) return reply.code(409).send({ error: 'busy' });
    audit(req.session!.userId, 'app_retag', { id, from, to });
    return { task: enqueue('app.retag', `Update ${id} to ${to}`, { id, from, to }, id) };
  });

  // Check apps once a day in the background.
  if (!process.env.VITEST) {
    const tick = () => void checkApps().catch(() => undefined);
    const first = setTimeout(tick, 5 * 60_000);
    first.unref();
    const t = setInterval(tick, 24 * 3600_000);
    t.unref();
    app.addHook('onClose', async () => (clearTimeout(first), clearInterval(t)));
  }
}
