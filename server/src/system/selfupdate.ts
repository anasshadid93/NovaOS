import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { requireAuth, requireElevated } from '../auth/sessions.js';
import { audit } from '../db.js';
import { config } from '../config.js';
import { enqueue, registerTask } from '../tasks/tasks.js';

/**
 * Updating NovaOS itself from GitHub Releases, with a way back.
 *
 *   check   → the newest release of `updateRepo` (tag, notes, source tarball)
 *   update  → task: download the tarball into var/updates/staging, `npm ci` + build there, keep a
 *             hard-linked snapshot of the current tree in var/updates/rollback, rsync the staged
 *             tree over the install (var/ and .git/ untouched), write var/updates/pending.json and
 *             exit 3 so systemd starts the new code.
 *   boot    → finishSelfUpdate(): a pending update that fails to boot three times is rolled back
 *             automatically; a clean boot marks it done.
 *   rollback→ the snapshot goes back the same way (also offered in the UI).
 */
const execFileP = promisify(execFile);
const UPDATES = () => path.join(config.dataDir, 'updates');
const STAGING = () => path.join(UPDATES(), 'staging');
const ROLLBACK = () => path.join(UPDATES(), 'rollback');
const PENDING = () => path.join(UPDATES(), 'pending.json');
const LAST = () => path.join(UPDATES(), 'last.json');
const RELEASE = () => path.join(UPDATES(), 'release.json');
/** Files that belong to the install, not to a release. */
const KEEP = ['/var', '/.git', '/android/local.properties', '/android/*.jks', '/android/keystore.properties'];

export interface Release {
  tag: string;
  name: string;
  notes: string;
  publishedAt: string;
  tarball: string;
  url: string;
}
interface Pending {
  tag: string;
  from: string;
  attempts: number;
  at: number;
}
interface Last {
  status: 'ok' | 'rolled_back' | 'failed';
  tag: string;
  from?: string;
  at: number;
  reason?: string;
}

const readJson = <T>(file: string): T | null => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
};
const writeJson = (file: string, v: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(v, null, 2) + '\n');
};

export function currentVersion(): { version: string; tag: string | null; commit: string | null } {
  const version = (readJson<{ version: string }>(path.join(config.repoRoot, 'package.json')) ?? { version: '0' }).version;
  const rel = readJson<{ tag: string }>(RELEASE());
  let commit: string | null = null;
  try {
    const head = fs.readFileSync(path.join(config.repoRoot, '.git', 'HEAD'), 'utf8').trim();
    const ref = head.startsWith('ref: ') ? fs.readFileSync(path.join(config.repoRoot, '.git', head.slice(5)), 'utf8').trim() : head;
    commit = ref.slice(0, 7);
  } catch {
    /* not a git checkout */
  }
  return { version, tag: rel?.tag ?? null, commit };
}

/** "v1.2.3" vs "1.2.10": numeric parts compared left to right; a tag with a suffix (-rc1) is older than without. */
export function newerThan(candidate: string, current: string | null): boolean {
  if (!current) return true;
  const parse = (t: string) => {
    const m = /^v?(\d+(?:\.\d+)*)(?:[-+](.*))?$/.exec(t.trim());
    return m ? { nums: m[1].split('.').map(Number), pre: m[2] ?? '' } : null;
  };
  const a = parse(candidate);
  const b = parse(current);
  if (!a || !b) return candidate !== current;
  for (let i = 0; i < Math.max(a.nums.length, b.nums.length); i++) {
    const d = (a.nums[i] ?? 0) - (b.nums[i] ?? 0);
    if (d) return d > 0;
  }
  if (a.pre !== b.pre) return a.pre === '' || (b.pre !== '' && a.pre > b.pre);
  return false;
}

let cached: { at: number; release: Release | null; error?: string } | null = null;

/** Newest release (GitHub API, or `updateFeed` for mirrors/tests: same JSON shape). Cached 10 minutes. */
export async function latestRelease(force = false): Promise<{ at: number; release: Release | null; error?: string }> {
  if (!force && cached && Date.now() - cached.at < 10 * 60_000) return cached;
  const url = config.updateFeed || `https://api.github.com/repos/${config.updateRepo}/releases/latest`;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'NovaOS' }, signal: AbortSignal.timeout(15_000) });
    if (res.status === 404) return (cached = { at: Date.now(), release: null, error: 'no_releases' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = (await res.json()) as { tag_name?: string; name?: string; body?: string; published_at?: string; tarball_url?: string; html_url?: string; draft?: boolean; prerelease?: boolean };
    if (!j.tag_name || !j.tarball_url) throw new Error('bad_release');
    const release: Release = { tag: j.tag_name, name: j.name || j.tag_name, notes: (j.body ?? '').slice(0, 4000), publishedAt: j.published_at ?? '', tarball: j.tarball_url, url: j.html_url ?? '' };
    return (cached = { at: Date.now(), release });
  } catch (e) {
    return (cached = { at: Date.now(), release: null, error: (e as Error).message.slice(0, 120) });
  }
}

/** Updates are refused on a developer checkout with local changes: they would be overwritten. */
export async function localChanges(root = config.repoRoot): Promise<string | null> {
  if (!fs.existsSync(path.join(root, '.git'))) return null;
  try {
    const { stdout } = await execFileP('git', ['-C', root, 'status', '--porcelain', '--untracked-files=no'], { timeout: 10_000 });
    return stdout.trim() ? stdout.trim().split('\n').slice(0, 5).join('\n') : null;
  } catch {
    return null;
  }
}

// -I: copy every file even when size and mtime match (a rebuilt file can look identical to rsync).
// rsync writes a new file and renames it, so hard links in the rollback snapshot keep the old content.
const rsyncArgs = (from: string, to: string) => ['-a', '-I', '--delete', ...KEEP.flatMap((k) => ['--exclude', k]), `${from}/`, `${to}/`];

/** Hard-linked copy of the install (fast, no extra space) to come back to. */
export async function snapshot(root: string, dest: string): Promise<void> {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  await execFileP('rsync', ['--link-dest', root, ...rsyncArgs(root, dest)], { timeout: 600_000, maxBuffer: 50 * 1024 ** 2 });
}

/** Replaces the install with `from` (var/, .git/ and local Android signing files stay). */
export async function applyTree(from: string, root: string): Promise<void> {
  await execFileP('rsync', rsyncArgs(from, root), { timeout: 600_000, maxBuffer: 50 * 1024 ** 2 });
}

/** GitHub tarballs unpack into one "owner-repo-sha/" folder: returns the folder that holds package.json. */
export function sourceRoot(extracted: string): string {
  if (fs.existsSync(path.join(extracted, 'package.json'))) return extracted;
  const dirs = fs.readdirSync(extracted).filter((n) => fs.statSync(path.join(extracted, n)).isDirectory());
  const hit = dirs.find((d) => fs.existsSync(path.join(extracted, d, 'package.json')));
  if (!hit) throw new Error('no package.json in the release');
  return path.join(extracted, hit);
}

function restart(): void {
  setTimeout(() => process.exit(3), 800).unref();
}

registerTask('system.selfUpdate', async (ctx, params) => {
  const tag = String(params.tag);
  const tarball = String(params.tarball);
  const root = config.repoRoot;
  const cur = currentVersion();
  const from = cur.tag ?? `${cur.version}${cur.commit ? `+${cur.commit}` : ''}`;
  if (!/^https:\/\//.test(tarball) && !tarball.startsWith('http://127.0.0.1')) throw new Error('bad_tarball_url');

  ctx.log(`Updating ${from} → ${tag}`);
  const stage = path.join(STAGING(), tag.replace(/[^\w.-]/g, '_'));
  fs.rmSync(STAGING(), { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  const tgz = path.join(STAGING(), 'release.tgz');

  ctx.progress('download');
  ctx.log(`Downloading ${tarball}`);
  const res = await fetch(tarball, { headers: { 'User-Agent': 'NovaOS' }, redirect: 'follow', signal: AbortSignal.timeout(600_000) });
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  const { Readable } = await import('node:stream');
  const { pipeline } = await import('node:stream/promises');
  await pipeline(Readable.fromWeb(res.body as never), fs.createWriteStream(tgz));
  ctx.log(`Downloaded ${(fs.statSync(tgz).size / 1024 ** 2).toFixed(1)} MB`);

  ctx.progress('extract');
  await ctx.run('tar', ['-xzf', tgz, '-C', stage]);
  const src = sourceRoot(stage);
  const pkg = readJson<{ version?: string; name?: string }>(path.join(src, 'package.json'));
  if (pkg?.name !== 'manar') throw new Error('that tarball is not NovaOS');

  ctx.progress('install');
  ctx.log('npm ci');
  const env = { ...process.env, HOME: process.env.HOME ?? os.homedir(), CI: '1', npm_config_fund: 'false', npm_config_audit: 'false' };
  await ctx.run('npm', ['ci', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: src, env, timeoutMs: 1_800_000 });
  ctx.progress('build');
  ctx.log('npm run build');
  await ctx.run('npm', ['run', 'build', '--silent'], { cwd: src, env, timeoutMs: 1_800_000 });
  for (const f of ['server/dist/index.js', 'web/dist/index.html']) if (!fs.existsSync(path.join(src, f))) throw new Error(`build produced no ${f}`);

  ctx.progress('snapshot');
  ctx.log('Keeping a copy of the current version for rollback');
  await snapshot(root, ROLLBACK());

  ctx.progress('apply');
  ctx.log('Installing the new version');
  await applyTree(src, root);
  writeJson(RELEASE(), { tag, at: Date.now() });
  writeJson(PENDING(), { tag, from, attempts: 0, at: Date.now() } satisfies Pending);
  fs.rmSync(STAGING(), { recursive: true, force: true });
  ctx.log('Restarting NovaOS');
  restart();
});

export async function rollback(reason: string): Promise<void> {
  if (!fs.existsSync(path.join(ROLLBACK(), 'package.json'))) throw new Error('no_rollback');
  const pending = readJson<Pending>(PENDING());
  const cur = currentVersion();
  await applyTree(ROLLBACK(), config.repoRoot);
  if (pending?.from) writeJson(RELEASE(), { tag: pending.from, at: Date.now() });
  else fs.rmSync(RELEASE(), { force: true });
  fs.rmSync(PENDING(), { force: true });
  writeJson(LAST(), { status: 'rolled_back', tag: cur.tag ?? cur.version, from: pending?.from, at: Date.now(), reason } satisfies Last);
}

/** Called at boot (before listening) and again once the server listens. */
export async function finishSelfUpdate(phase: 'boot' | 'listening', log: { warn(msg: string): void; info(msg: string): void }): Promise<void> {
  const pending = readJson<Pending>(PENDING());
  if (!pending) return;
  if (phase === 'listening') {
    fs.rmSync(PENDING(), { force: true });
    writeJson(LAST(), { status: 'ok', tag: pending.tag, from: pending.from, at: Date.now() } satisfies Last);
    log.info(`Update to ${pending.tag} is live`);
    return;
  }
  pending.attempts += 1;
  writeJson(PENDING(), pending);
  if (pending.attempts > 3) {
    log.warn(`Update to ${pending.tag} failed to start ${pending.attempts - 1} times: rolling back to ${pending.from}`);
    try {
      await rollback('did not start');
    } catch (e) {
      log.warn(`Rollback failed: ${(e as Error).message}`);
      return;
    }
    process.exit(3);
  }
}

export async function selfUpdateRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { refresh?: string } }>('/api/updates/self', { preHandler: requireAuth }, async (req) => {
    const cur = currentVersion();
    const { release, error } = await latestRelease(req.query.refresh === '1');
    const changes = await localChanges();
    return {
      current: cur,
      repo: config.updateRepo,
      latest: release,
      error: error ?? null,
      available: !!release && newerThan(release.tag, cur.tag ?? cur.version),
      blocked: changes ? 'local_changes' : null,
      canRollback: fs.existsSync(path.join(ROLLBACK(), 'package.json')),
      last: readJson<Last>(LAST()),
      pending: readJson<Pending>(PENDING()),
    };
  });

  app.post('/api/updates/self', { preHandler: requireElevated }, async (req, reply) => {
    const { release, error } = await latestRelease(true);
    if (!release) return reply.code(503).send({ error: error ?? 'no_release' });
    if (await localChanges()) return reply.code(409).send({ error: 'local_changes' });
    audit(req.session!.userId, 'self_update', { tag: release.tag });
    return { task: enqueue('system.selfUpdate', `Update NovaOS to ${release.tag}`, { tag: release.tag, tarball: release.tarball }) };
  });

  app.post('/api/updates/self/rollback', { preHandler: requireElevated }, async (req, reply) => {
    try {
      await rollback('requested');
    } catch (e) {
      return reply.code(409).send({ error: (e as Error).message });
    }
    audit(req.session!.userId, 'self_rollback');
    restart();
    return { ok: true, restarting: true };
  });
}
