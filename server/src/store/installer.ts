import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { config } from '../config.js';
import { audit, getDb } from '../db.js';
import { docker } from '../docker/client.js';
import { runHelper } from '../helper.js';
import { registerTask, type TaskContext } from '../tasks/tasks.js';
import { catalog } from './catalog.js';
import { envFile, prepareCompose, type CatalogApp } from './compose.js';

/** Install / update / rollback / remove, each as a background task. */

export interface InstalledApp {
  id: string;
  title: string;
  icon: string | null;
  source: string;
  web_port: number | null;
  web_path: string | null;
  ts_port: number | null;
  images: string | null;
  prev_images: string | null;
  status: string;
  installed_at: number;
  updated_at: number | null;
}

export const appDir = (id: string) => path.join(config.appsDir, id);
export const appDataDir = (id: string) => path.join(config.appDataRoot, id);

export function installedApps(): InstalledApp[] {
  return getDb().prepare('SELECT * FROM apps ORDER BY title').all() as unknown as InstalledApp[];
}

export function installedApp(id: string): InstalledApp | undefined {
  return getDb().prepare('SELECT * FROM apps WHERE id = ?').get(id) as InstalledApp | undefined;
}

export function appUrl(a: Pick<InstalledApp, 'ts_port' | 'web_path'>): string | null {
  return a.ts_port ? `https://${config.tailscaleHost}:${a.ts_port}${a.web_path ?? '/'}` : null;
}

// ---- Port registry ---------------------------------------------------------

function listeningPorts(): Set<number> {
  const set = new Set<number>();
  for (const f of ['tcp', 'tcp6', 'udp', 'udp6']) {
    try {
      for (const line of fs.readFileSync(`/proc/net/${f}`, 'utf8').split('\n').slice(1)) {
        const local = line.trim().split(/\s+/)[1];
        if (local) set.add(parseInt(local.split(':')[1], 16));
      }
    } catch {
      /* ignore */
    }
  }
  return set;
}

export function makePortAllocator(appId: string) {
  const db = getDb();
  const taken = new Set((db.prepare('SELECT port FROM ports').all() as { port: number }[]).map((r) => r.port));
  const busy = listeningPorts();
  const reserved = new Set(config.reservedPorts);
  const [lo, hi] = config.appPortRange;
  const allocated: { port: number; service: string; target: number; protocol: string }[] = [];
  return {
    allocate(service: string, target: number, protocol: string) {
      for (let p = lo; p <= hi; p++) {
        if (taken.has(p) || busy.has(p) || reserved.has(p)) continue;
        taken.add(p);
        allocated.push({ port: p, service, target, protocol });
        return p;
      }
      throw new Error('no free ports in range');
    },
    commit() {
      const ins = db.prepare('INSERT INTO ports(port, app_id, service, target, protocol) VALUES(?, ?, ?, ?, ?)');
      for (const a of allocated) ins.run(a.port, appId, a.service, a.target, a.protocol);
    },
  };
}

// ---- Helpers ---------------------------------------------------------------

function compose(ctx: TaskContext, id: string, args: string[], timeoutMs?: number) {
  return ctx.run('docker', ['compose', '-p', `${config.containerPrefix}${id}`, '-f', 'compose.yaml', '--env-file', '.env', ...args], { cwd: appDir(id), timeoutMs });
}

async function serviceImages(id: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const c of await docker.list()) {
    if (c.Labels['manar.app'] === id) out[c.Labels['manar.service'] ?? c.Names[0]] = `${c.Image}@${c.ImageID}`;
  }
  return out;
}

/** `tailscale serve` needs operator rights, so it goes through the root helper (app ports only). */
async function tailscaleServe(ctx: TaskContext, port: number, on: boolean) {
  try {
    ctx.log(`tailscale serve --https=${port} ${on ? `http://127.0.0.1:${port}` : 'off'}`);
    await runHelper({ cmd: 'ts-serve', port, on }, 30_000);
  } catch (err) {
    ctx.log(`tailscale serve ${on ? 'setup' : 'removal'} failed: ${(err as { stderr?: string }).stderr || (err as Error).message}`);
    if (on) throw err;
  }
}

async function requireDocker() {
  const p = await docker.ping();
  if (!p.ok) throw new Error(`Docker is not available (${p.error})`);
}

// ---- Tasks -----------------------------------------------------------------

registerTask('app.install', async (ctx, params) => {
  const id = String(params.id);
  const app = catalog().byId.get(id);
  if (!app) throw new Error('unknown app');
  if (installedApp(id)) throw new Error('already installed');
  await requireDocker();

  ctx.progress('Preparing files');
  const ports = makePortAllocator(id);
  const prepared = prepareCompose(app, {
    appsDataRoot: config.appDataRoot,
    dataRoot: config.dataRoot,
    craftRoot: config.craftRoot,
    tailscaleHost: config.tailscaleHost,
    uid: config.appUid,
    gid: config.appGid,
    tz: config.timezone,
    allocatePort: (s, t, p) => ports.allocate(s, t, p),
  });
  for (const w of prepared.warnings) ctx.log(`warning: ${w}`);
  fs.mkdirSync(appDir(id), { recursive: true, mode: 0o750 });
  // Missing bind sources become folders; an existing file (e.g. a config file the app ships with) is kept as is.
  for (const d of prepared.bindDirs) if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(appDir(id), 'compose.yaml'), `# Generated by Manar from ${app.source.repo} ${app.source.commit ?? ''} ${app.source.path ?? ''}\n` + YAML.stringify(prepared.compose));
  fs.writeFileSync(path.join(appDir(id), '.env'), envFile(prepared.env), { mode: 0o600 });
  ports.commit();

  const db = getDb();
  db.prepare(
    `INSERT INTO apps(id, title, icon, source, catalog, web_port, web_path, ts_port, status, installed_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'installing', ?)`,
  ).run(id, app.title, app.icon, app.source.repo, JSON.stringify(app), prepared.webPort, app.web?.path ?? '/', prepared.webPort, Date.now());

  try {
    ctx.progress('Pulling images');
    await compose(ctx, id, ['pull'], 60 * 60_000);
    ctx.progress('Starting containers');
    await compose(ctx, id, ['up', '-d', '--remove-orphans']);
    if (prepared.webPort) {
      ctx.progress('Publishing on Tailscale');
      await tailscaleServe(ctx, prepared.webPort, true);
    }
    db.prepare("UPDATE apps SET status = 'installed', images = ? WHERE id = ?").run(JSON.stringify(await serviceImages(id)), id);
    db.prepare('INSERT OR IGNORE INTO launcher(key, position) VALUES(?, (SELECT COALESCE(MAX(position), 0) + 1 FROM launcher))').run(`app:${id}`);
    ctx.log(`Installed. ${appUrl({ ts_port: prepared.webPort, web_path: app.web?.path ?? '/' }) ?? ''}`);
  } catch (err) {
    db.prepare("UPDATE apps SET status = 'error' WHERE id = ?").run(id);
    throw err;
  }
});

registerTask('app.update', async (ctx, params) => {
  const id = String(params.id);
  const app = installedApp(id);
  if (!app) throw new Error('not installed');
  await requireDocker();
  const before = await serviceImages(id);
  ctx.log(`current images: ${JSON.stringify(before)}`);
  ctx.progress('Pulling new images');
  await compose(ctx, id, ['pull'], 60 * 60_000);
  ctx.progress('Recreating containers');
  await compose(ctx, id, ['up', '-d', '--remove-orphans']);
  const after = await serviceImages(id);
  const changed = JSON.stringify(after) !== JSON.stringify(before);
  getDb()
    .prepare("UPDATE apps SET images = ?, prev_images = CASE WHEN ? THEN ? ELSE prev_images END, status = 'installed', updated_at = ? WHERE id = ?")
    .run(JSON.stringify(after), changed ? 1 : 0, JSON.stringify(before), Date.now(), id);
  ctx.log(changed ? 'Updated. Previous images kept for rollback.' : 'Already up to date.');
});

registerTask('app.rollback', async (ctx, params) => {
  const id = String(params.id);
  const app = installedApp(id);
  if (!app?.prev_images) throw new Error('nothing to roll back to');
  await requireDocker();
  const prev = JSON.parse(app.prev_images) as Record<string, string>;
  for (const [svc, ref] of Object.entries(prev)) {
    const [image, imageId] = ref.split('@');
    const [repo, tag = 'latest'] = image.split(/:(?=[^/:]+$)/);
    ctx.progress(`Restoring ${svc} → ${imageId.slice(7, 19)}`);
    await docker.tag(imageId, repo, tag);
  }
  await compose(ctx, id, ['up', '-d', '--remove-orphans']);
  getDb()
    .prepare('UPDATE apps SET images = prev_images, prev_images = NULL, updated_at = ? WHERE id = ?')
    .run(Date.now(), id);
});

registerTask('app.remove', async (ctx, params) => {
  const id = String(params.id);
  const deleteData = params.deleteData === true;
  const app = installedApp(id);
  if (!app) throw new Error('not installed');
  if (fs.existsSync(path.join(appDir(id), 'compose.yaml')) && (await docker.ping()).ok) {
    ctx.progress('Stopping and removing containers');
    await compose(ctx, id, ['down', '--remove-orphans']);
  }
  if (app.ts_port) await tailscaleServe(ctx, app.ts_port, false);
  ctx.progress('Removing app files');
  fs.rmSync(appDir(id), { recursive: true, force: true });
  if (deleteData) {
    ctx.progress('Deleting app data');
    // Containers may have created root-owned files, so the root helper does this (path-checked there).
    await runHelper({ cmd: 'rm-appdata', app: id }, 10 * 60_000);
  } else ctx.log(`Data kept in ${appDataDir(id)}`);
  const db = getDb();
  db.prepare('DELETE FROM ports WHERE app_id = ?').run(id);
  db.prepare('DELETE FROM launcher WHERE key = ?').run(`app:${id}`);
  db.prepare('DELETE FROM apps WHERE id = ?').run(id);
  audit(null, 'app_removed', { id, deleteData });
});

export function isCatalogApp(id: string): CatalogApp | undefined {
  return catalog().byId.get(id);
}
