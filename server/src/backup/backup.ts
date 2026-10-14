import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { getDb, kvGet, kvSet } from '../db.js';
import { postHook } from '../bot/hook.js';

/**
 * Nightly backups of everything on the server that can't be downloaded again: MinisManager's database and
 * settings, every app's configuration (n8n workflows, Jellyfin library and artwork, AdGuard, …), the
 * OpenClaw workspace with its memory, the projects in /srv/data/workspace and the files share.
 * restic writes deduplicated snapshots to the Toshiba, so a night costs only what changed. Kept: 7
 * daily, 4 weekly, 6 monthly. A restore never overwrites anything: it goes to Backups/restored/<time>/.
 *
 * The repository password is kept next to the repository as well as in var/: these backups protect
 * against a dead system disk, and a password that lived only on that disk would lock them for good.
 */

const execFileP = promisify(execFile);
const ROOT = () => config.backup.root;
export const REPO = () => path.join(ROOT(), 'restic');
const PASS = () => path.join(config.dataDir, 'restic-password');
const PASS_COPY = () => path.join(ROOT(), 'restic-password.txt');
const SNAP_DIR = () => path.join(config.dataDir, 'backup');

/** What goes in (config: backupSources) and what is skipped (backupExcludes): caches, build output, things that come back by themselves. */
export const SOURCES = config.backup.sources;
export const EXCLUDES = config.backup.excludes;
const KEEP = ['--keep-daily', '7', '--keep-weekly', '4', '--keep-monthly', '6'];

export interface BackupRun {
  at: number;
  finishedAt?: number;
  ok?: boolean;
  /** some files couldn't be read (restic exit 3): the snapshot exists, with gaps */
  warnings?: number;
  filesNew?: number;
  filesChanged?: number;
  bytesAdded?: number;
  totalBytes?: number;
  snapshot?: string;
  error?: string;
}
export interface BackupState {
  running: boolean;
  phase?: 'snapshot-db' | 'backup' | 'prune';
  percent?: number;
  bytesDone?: number;
  bytesTotal?: number;
  current?: string;
  last?: BackupRun;
  lastOk?: number;
  history: BackupRun[];
}

const KV = 'backup_state';
let live: Omit<BackupState, 'last' | 'lastOk' | 'history'> = { running: false };
function stored(): Pick<BackupState, 'last' | 'lastOk' | 'history'> {
  try {
    return JSON.parse(kvGet(KV) ?? '{}') as BackupState;
  } catch {
    return { history: [] };
  }
}
export function backupState(): BackupState {
  const s = stored();
  return { ...live, last: s.last, lastOk: s.lastOk, history: s.history ?? [] };
}
function record(run: BackupRun) {
  const s = stored();
  const history = [run, ...(s.history ?? [])].slice(0, 30);
  kvSet(KV, JSON.stringify({ last: run, lastOk: run.ok ? run.finishedAt : s.lastOk, history }));
}

function password(): string {
  if (!fs.existsSync(PASS())) {
    if (fs.existsSync(PASS_COPY())) fs.copyFileSync(PASS_COPY(), PASS());
    else fs.writeFileSync(PASS(), crypto.randomBytes(24).toString('base64url'), { mode: 0o600 });
  }
  fs.chmodSync(PASS(), 0o600);
  fs.mkdirSync(ROOT(), { recursive: true });
  if (!fs.existsSync(PASS_COPY())) fs.copyFileSync(PASS(), PASS_COPY());
  return PASS();
}
const env = () => ({ ...process.env, RESTIC_REPOSITORY: REPO(), RESTIC_PASSWORD_FILE: password(), RESTIC_CACHE_DIR: path.join(os.homedir(), '.cache', 'restic') });

export async function restic<T = unknown>(args: string[], json = true): Promise<T> {
  const { stdout } = await execFileP('restic', [...args, ...(json ? ['--json'] : [])], { env: env(), maxBuffer: 256 << 20, timeout: 30 * 60_000 });
  return (json ? JSON.parse(stdout) : stdout) as T;
}

async function ensureRepo() {
  if (fs.existsSync(path.join(REPO(), 'config'))) return;
  fs.mkdirSync(REPO(), { recursive: true });
  await execFileP('restic', ['init'], { env: env() });
}

/** A consistent copy of MinisManager's live SQLite database (the file itself may be mid-write). */
function snapshotDb() {
  fs.mkdirSync(SNAP_DIR(), { recursive: true });
  const out = path.join(SNAP_DIR(), 'manar.db');
  fs.rmSync(out, { force: true });
  getDb().exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
}

/** Runs restic at low priority in its own memory-capped scope, streaming its JSON progress. */
function runBackup(): Promise<{ code: number; summary?: Record<string, number | string>; errors: string[] }> {
  return new Promise((resolve) => {
    const restic = ['restic', 'backup', '--json', '--one-file-system', '--exclude-caches'];
    for (const e of EXCLUDES) restic.push('--exclude', e);
    restic.push(...SOURCES.filter((s) => fs.existsSync(s)));
    // Its own memory-capped, low-priority scope when the user's systemd is reachable (as for the
    // Trade Bot's jobs); otherwise plain, at low priority.
    const runtime = `/run/user/${process.getuid?.() ?? 1000}`;
    const scoped = fs.existsSync('/usr/bin/systemd-run') && fs.existsSync(`${runtime}/bus`);
    const e = { ...env(), XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus` };
    const child = scoped
      ? spawn('/usr/bin/systemd-run', ['--user', '--scope', '--quiet', '--collect', '-p', 'MemoryMax=2G', '-p', 'CPUWeight=20', '-p', 'IOWeight=20', '--nice=15', `--unit=minismanager-backup-${Date.now()}`, ...restic], { env: e })
      : spawn('nice', ['-n', '15', ...restic], { env: e });
    let summary: Record<string, number | string> | undefined;
    const errors: string[] = [];
    let buf = '';
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try {
          const m = JSON.parse(line) as Record<string, unknown>;
          if (m.message_type === 'status') {
            live.percent = Number(m.percent_done ?? 0);
            live.bytesDone = Number(m.bytes_done ?? 0);
            live.bytesTotal = Number(m.total_bytes ?? 0);
            live.current = ((m.current_files as string[] | undefined) ?? [])[0];
          } else if (m.message_type === 'summary') summary = m as Record<string, number | string>;
          else if (m.message_type === 'error') errors.push(String((m.error as { message?: string })?.message ?? m.item ?? 'error'));
        } catch {
          // not JSON
        }
      }
    });
    child.stderr.on('data', (d: Buffer) => errors.push(...d.toString().split('\n').filter(Boolean).slice(0, 20)));
    child.on('close', (code) => resolve({ code: code ?? 1, summary, errors }));
  });
}

let running: Promise<BackupRun> | null = null;
/** One backup now (or the one already running). */
export function backupNow(): Promise<BackupRun> {
  running ??= (async () => {
    const run: BackupRun = { at: Date.now() };
    live = { running: true, phase: 'snapshot-db', percent: 0 };
    try {
      if (!fs.existsSync(path.dirname(ROOT()))) throw new Error('backup disk not mounted');
      await ensureRepo();
      snapshotDb();
      live.phase = 'backup';
      const r = await runBackup();
      // 3 = "some source files could not be read": the snapshot was still made.
      if (r.code !== 0 && r.code !== 3) throw new Error(r.errors.slice(-3).join(' · ') || `restic exited ${r.code}`);
      Object.assign(run, {
        ok: true,
        warnings: r.code === 3 ? r.errors.length || 1 : 0,
        filesNew: Number(r.summary?.files_new ?? 0),
        filesChanged: Number(r.summary?.files_changed ?? 0),
        bytesAdded: Number(r.summary?.data_added ?? 0),
        totalBytes: Number(r.summary?.total_bytes_processed ?? 0),
        snapshot: String(r.summary?.snapshot_id ?? '').slice(0, 8),
      });
      live.phase = 'prune';
      // Tidying old snapshots can wait for tomorrow (e.g. the repository is locked by another run):
      // tonight's snapshot is already safe, so that isn't a failed backup.
      await restic(['forget', ...KEEP, '--prune'], false).catch((e: Error) => {
        run.warnings = (run.warnings ?? 0) + 1;
        run.error = `prune skipped: ${(e.message.split('\n').map((l) => l.trim()).filter(Boolean).at(-1) ?? e.message).slice(0, 200)}`;
      });
    } catch (e) {
      run.ok = false;
      run.error = (e as Error).message.slice(0, 500);
      void postHook({ type: 'alert', severity: 'critical', kind: 'backup_failed', text: `💾 النسخة الاحتياطية الليلية فشلت.\n<code>${run.error.replace(/[<>&]/g, '')}</code>\nبتشوف التفاصيل بـ MinisManager ← النسخ الاحتياطي.` });
    } finally {
      run.finishedAt = Date.now();
      record(run);
      live = { running: false };
      running = null;
    }
    return run;
  })();
  return running;
}

export interface Snapshot {
  id: string;
  short_id: string;
  time: string;
  paths: string[];
  summary?: { total_bytes_processed?: number; data_added?: number };
}
export const snapshots = () => restic<Snapshot[]>(['snapshots']).then((s) => s.reverse()).catch(() => [] as Snapshot[]);

export interface Entry {
  name: string;
  type: 'dir' | 'file' | 'symlink';
  path: string;
  size?: number;
  mtime?: string;
}
/** One folder of a snapshot (its direct contents). */
export async function listDir(snapshot: string, dir: string): Promise<Entry[]> {
  if (!/^[a-f0-9]{8,64}$/.test(snapshot)) throw new Error('bad_snapshot');
  const { stdout } = await execFileP('restic', ['ls', '--json', snapshot, dir || '/'], { env: env(), maxBuffer: 64 << 20, timeout: 120_000 });
  const out: Entry[] = [];
  for (const line of stdout.split('\n')) {
    try {
      const e = JSON.parse(line) as Entry & { struct_type?: string };
      if (e.struct_type === 'node' && e.path !== (dir || '/')) out.push({ name: e.name, type: e.type, path: e.path, size: e.size, mtime: e.mtime });
    } catch {
      // the snapshot header line, or blank
    }
  }
  return out.sort((a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || a.name.localeCompare(b.name));
}

/** A file or folder back from a snapshot, into Backups/restored/<time>/ (never over the original). */
export async function restore(snapshot: string, p: string): Promise<string> {
  if (!/^[a-f0-9]{8,64}$/.test(snapshot) || !p.startsWith('/')) throw new Error('bad_request');
  const target = path.join(ROOT(), 'restored', new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(target, { recursive: true });
  await execFileP('restic', ['restore', `${snapshot}:${path.dirname(p)}`, '--target', target, '--include', `/${path.basename(p)}`], { env: env(), timeout: 2 * 3600_000 });
  return path.join(target, path.basename(p));
}

export async function repoSize(): Promise<number> {
  try {
    const { stdout } = await execFileP('du', ['-sb', REPO()], { timeout: 60_000 });
    return Number(stdout.split('\t')[0]);
  } catch {
    return 0;
  }
}

/** A restic backup still running from before MinisManager restarted (it lives in its own scope). */
async function orphanRunning(): Promise<boolean> {
  try {
    await execFileP('pgrep', ['-f', '^(/usr/bin/)?restic backup'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}
let adopted: number | null = null;
/** Follows an orphaned run until it ends, then records it from the snapshot it made. */
async function followOrphan() {
  if (await orphanRunning()) {
    adopted ??= Date.now();
    live = { running: true, phase: 'backup' };
    return true;
  }
  if (adopted) {
    const at = adopted;
    adopted = null;
    live = { running: false };
    const last = (await snapshots())[0];
    const ok = !!last && Date.parse(last.time) >= at - 6 * 3600_000;
    record({ at, finishedAt: Date.now(), ok, snapshot: last?.short_id, totalBytes: last?.summary?.total_bytes_processed, bytesAdded: last?.summary?.data_added, ...(ok ? {} : { error: 'the run ended without a snapshot' }) });
  }
  return false;
}

/** Every night at 03:15 (the server's time), once. A missed night (the server off) runs at the next start. */
export function startBackupLoop(): () => void {
  if (process.env.VITEST) return () => {};
  const tick = async () => {
    if (!running && (await followOrphan())) return;
    const now = new Date();
    const due = new Date(now);
    due.setHours(3, 15, 0, 0);
    if (now < due) due.setDate(due.getDate() - 1);
    const { last, lastOk } = stored();
    // Tonight's not done yet — or it failed: try again an hour later (the disk may have been busy).
    const retry = last && !last.ok && Date.now() - (last.finishedAt ?? 0) > 3600_000 && (lastOk ?? 0) < due.getTime();
    if (((last?.at ?? 0) < due.getTime() || retry) && !live.running) void backupNow();
  };
  const t = setInterval(() => void tick(), 60_000);
  setTimeout(() => void tick(), 20_000); // an orphaned run is picked up at once; a new one waits for 03:15
  return () => clearInterval(t);
}
