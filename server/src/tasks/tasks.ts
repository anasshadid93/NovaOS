import { spawn } from 'node:child_process';
import { getDb } from '../db.js';

/**
 * Background tasks (install/update/remove apps, …). Persisted in SQLite, run one
 * at a time so two compose operations never race. Records older than 7 days are pruned.
 */

export type TaskStatus = 'queued' | 'running' | 'failed' | 'succeeded';

export interface TaskContext {
  id: number;
  log(line: string): void;
  progress(text: string): void;
  /** Runs a command, streaming its output into the task log. Rejects on non-zero exit. */
  run(cmd: string, args: string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<string>;
}

type Handler = (ctx: TaskContext, params: Record<string, unknown>) => Promise<void>;

const handlers = new Map<string, Handler>();
const MAX_LOG = 200_000;
let running = false;

export function registerTask(kind: string, handler: Handler) {
  handlers.set(kind, handler);
}

export function enqueue(kind: string, title: string, params: Record<string, unknown> = {}, appId?: string): number {
  if (!handlers.has(kind)) throw new Error(`unknown task kind ${kind}`);
  const res = getDb()
    .prepare('INSERT INTO tasks(kind, title, app_id, params, status, created_at) VALUES(?, ?, ?, ?, ?, ?)')
    .run(kind, title, appId ?? null, JSON.stringify(params), 'queued', Date.now());
  setImmediate(pump);
  return Number(res.lastInsertRowid);
}

export function hasActiveTask(appId: string): boolean {
  return !!getDb().prepare("SELECT 1 FROM tasks WHERE app_id = ? AND status IN ('queued','running')").get(appId);
}

export function listTasks(status?: TaskStatus, limit = 100) {
  const cols = 'id, kind, title, app_id AS appId, status, progress, error, created_at AS createdAt, started_at AS startedAt, finished_at AS finishedAt';
  return status
    ? getDb().prepare(`SELECT ${cols} FROM tasks WHERE status = ? ORDER BY id DESC LIMIT ?`).all(status, limit)
    : getDb().prepare(`SELECT ${cols} FROM tasks ORDER BY id DESC LIMIT ?`).all(limit);
}

export function getTask(id: number) {
  return getDb()
    .prepare(
      'SELECT id, kind, title, app_id AS appId, status, progress, log, error, created_at AS createdAt, started_at AS startedAt, finished_at AS finishedAt FROM tasks WHERE id = ?',
    )
    .get(id);
}

export function taskCounts() {
  const rows = getDb().prepare('SELECT status, COUNT(*) AS n FROM tasks GROUP BY status').all() as { status: TaskStatus; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

/** On startup: anything left "running" by a crash is marked failed; prune old records. */
export function recoverTasks() {
  getDb()
    .prepare("UPDATE tasks SET status = 'failed', error = 'interrupted (NovaOS restarted)', finished_at = ? WHERE status = 'running'")
    .run(Date.now());
  getDb().prepare("DELETE FROM tasks WHERE finished_at IS NOT NULL AND finished_at < ?").run(Date.now() - 7 * 86400_000);
  setImmediate(pump);
}

function append(id: number, text: string) {
  getDb()
    .prepare(`UPDATE tasks SET log = substr(log || ?, -${MAX_LOG}) WHERE id = ?`)
    .run(text, id);
}

async function pump() {
  if (running) return;
  const next = getDb().prepare("SELECT id, kind, params FROM tasks WHERE status = 'queued' ORDER BY id LIMIT 1").get() as
    | { id: number; kind: string; params: string }
    | undefined;
  if (!next) return;
  running = true;
  const db = getDb();
  db.prepare("UPDATE tasks SET status = 'running', started_at = ? WHERE id = ?").run(Date.now(), next.id);
  const ctx: TaskContext = {
    id: next.id,
    log: (line) => append(next.id, `${new Date().toISOString().slice(11, 19)} ${line}\n`),
    progress: (text) => {
      db.prepare('UPDATE tasks SET progress = ? WHERE id = ?').run(text, next.id);
      append(next.id, `${new Date().toISOString().slice(11, 19)} » ${text}\n`);
    },
    run: (cmd, args, opts = {}) =>
      new Promise((resolve, reject) => {
        append(next.id, `$ ${cmd} ${args.join(' ')}\n`);
        const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        let pending = '';
        const flush = () => {
          if (pending) append(next.id, pending);
          pending = '';
        };
        const timer = setInterval(flush, 1000);
        const onData = (c: Buffer) => {
          const s = c.toString();
          out = (out + s).slice(-50_000);
          pending += s;
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        const kill = setTimeout(() => child.kill('SIGTERM'), opts.timeoutMs ?? 30 * 60_000);
        child.on('error', (e) => {
          clearInterval(timer);
          clearTimeout(kill);
          flush();
          reject(e);
        });
        child.on('close', (code) => {
          clearInterval(timer);
          clearTimeout(kill);
          flush();
          if (code === 0) resolve(out);
          else reject(new Error(`${cmd} exited with ${code}`));
        });
      }),
  };
  try {
    await handlers.get(next.kind)!(ctx, JSON.parse(next.params ?? '{}'));
    db.prepare("UPDATE tasks SET status = 'succeeded', finished_at = ?, progress = NULL WHERE id = ?").run(Date.now(), next.id);
  } catch (err) {
    ctx.log(`ERROR: ${(err as Error).message}`);
    db.prepare("UPDATE tasks SET status = 'failed', error = ?, finished_at = ? WHERE id = ?").run(String((err as Error).message).slice(0, 500), Date.now(), next.id);
    taskFailedHook?.(next.id, String((err as Error).message));
  } finally {
    running = false;
    setImmediate(pump);
  }
}

let taskFailedHook: ((id: number, error: string) => void) | null = null;
export function onTaskFailed(fn: (id: number, error: string) => void) {
  taskFailedHook = fn;
}
