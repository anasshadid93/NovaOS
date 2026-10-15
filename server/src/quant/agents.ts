import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { getDb, kvGet, kvSet } from '../db.js';
import { runHelper } from '../helper.js';
import { MARKETS } from './market.js';
import { availableProviders, getSettings, type Provider, type QuantSettings } from './settings.js';

/**
 * TradingAgents (TauricResearch) as a sidecar: NovaOS asks it for one multi-agent debate per asset
 * per day, stores the rating + reports in quant_agent_runs, and publishes a signal on the bus.
 * The sidecar runs as novaos-agents.service when installed (it needs its own memory), otherwise
 * it is spawned as a child (development).
 */
const UNIT = 'novaos-agents.service';
const serverPy = () => path.join(config.agentsDir, 'server.py');
const python = () => path.join(config.agentsDir, 'venv', 'bin', 'python');
export const agentsInstalled = () => fs.existsSync(serverPy()) && fs.existsSync(python());
const hasUnit = () => fs.existsSync(`/etc/systemd/system/${UNIT}`);
const base = () => `http://127.0.0.1:${config.agentsPort}`;

let child: ChildProcess | null = null;
let alive = false;
let stopping = false;
let lastStartAsk = 0;
let lastError: string | null = null;
export const agentsAlive = () => alive;
export const agentsError = () => lastError;

async function health() {
  try {
    const r = await fetch(`${base()}/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok ? ((await r.json()) as { ok: boolean; busy: string | null; queue: number }) : null;
  } catch {
    return null;
  }
}

function spawnChild() {
  if (child || stopping) return;
  child = spawn(python(), ['-I', serverPy()], { cwd: config.agentsDir, env: { ...process.env, QUANT_AGENTS_PORT: String(config.agentsPort) }, stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr?.on('data', (d: Buffer) => {
    const s = d.toString().trim();
    if (s) lastError = s.slice(-300);
  });
  child.on('exit', () => {
    child = null;
  });
}

export async function agentsTick() {
  const h = await health();
  alive = !!h;
  if (alive || stopping) return;
  if (hasUnit()) {
    if (Date.now() - lastStartAsk > 5 * 60_000) {
      lastStartAsk = Date.now();
      runHelper({ cmd: 'systemctl', action: 'start', unit: UNIT }).catch((e: unknown) => {
        lastError = `start ${UNIT}: ${(e as Error).message}`;
      });
    }
  } else spawnChild();
}

export function stopAgents() {
  stopping = true;
  child?.kill('SIGTERM');
}

// ---- Model routing ---------------------------------------------------------------------------

/**
 * Picks the provider/model for each tier: the configured one when its key exists, else the next
 * provider in the fallback list (Ollama needs no key). Returns null when nothing can serve.
 */
export function routeModels(s: QuantSettings): { provider: Provider; quick: string; deep: string; quickProvider?: Provider; deepProvider?: Provider } | null {
  const avail = availableProviders(s);
  if (!avail.length) return null;
  const DEFAULT_MODELS: Record<Provider, { quick: string; deep: string }> = {
    anthropic: { quick: 'claude-haiku-4-5', deep: 'claude-sonnet-5' },
    openai: { quick: 'gpt-5.6-luna', deep: 'gpt-5.6-terra' },
    ollama: { quick: 'qwen3.5:9b-262k', deep: 'qwen3.5:9b-262k' },
  };
  const pick = (t: { provider: Provider; model: string }, tier: 'quick' | 'deep') => {
    if (avail.includes(t.provider)) return { provider: t.provider, model: t.model };
    const p = avail[0];
    return { provider: p, model: DEFAULT_MODELS[p][tier] };
  };
  const q = pick(s.routing.quick, 'quick');
  const d = pick(s.routing.deep, 'deep');
  return { provider: q.provider, quick: q.model, deep: d.model, quickProvider: q.provider, deepProvider: d.provider };
}

// ---- Runs --------------------------------------------------------------------------------------

export interface AgentRun {
  id: string;
  asset: string;
  ticker: string;
  day: string;
  status: 'queued' | 'running' | 'done' | 'error';
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  rating: string | null;
  score: number | null;
  llm: string | null;
  reports: string | null;
  error: string | null;
}

const today = () => new Date().toISOString().slice(0, 10);

function runsToday(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM quant_agent_runs WHERE day = ?').get(today()) as { n: number }).n;
}

/** Queues one debate for an asset (today). Returns the run id, or a reason it was not started. */
export async function requestRun(asset: string, opts: { force?: boolean } = {}): Promise<{ id?: string; skipped?: string }> {
  const s = getSettings();
  const m = MARKETS[asset];
  if (!m) return { skipped: 'unknown_asset' };
  if (!alive) return { skipped: 'agents_offline' };
  const route = routeModels(s);
  if (!route) return { skipped: 'no_provider' };
  const db = getDb();
  const day = today();
  const existing = db.prepare("SELECT id, status FROM quant_agent_runs WHERE asset = ? AND day = ? AND status IN ('queued','running','done') ORDER BY created_at DESC LIMIT 1").get(asset, day) as
    { id: string; status: string } | undefined;
  if (existing && !opts.force) return { skipped: `already_${existing.status}`, id: existing.id };
  if (!opts.force && runsToday() >= s.agentsDailyCap) return { skipped: 'daily_cap' };
  const id = randomUUID();
  const llm = {
    provider: route.provider,
    quick: route.quick,
    deep: route.deep,
    quick_provider: route.quickProvider,
    deep_provider: route.deepProvider,
    ollama_url: `${s.ollamaUrl}/v1`,
    keys: { anthropic: s.keys.anthropic, openai: s.keys.openai },
  };
  const r = await fetch(`${base()}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, ticker: m.yahoo, date: day, asset_type: 'crypto', analysts: s.analysts, llm, rounds: 1 }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) return { skipped: `sidecar_${r.status}` };
  db.prepare('INSERT INTO quant_agent_runs(id, asset, ticker, day, status, created_at, llm) VALUES(?,?,?,?,?,?,?)').run(
    id,
    asset,
    m.yahoo,
    day,
    'queued',
    Date.now(),
    JSON.stringify({ provider: route.provider, quick: route.quick, deep: route.deep }),
  );
  return { id };
}

/** Pulls results for queued/running runs into the DB and publishes finished ones as signals. */
export async function pollRuns(): Promise<void> {
  if (!alive) return;
  const db = getDb();
  const pending = db.prepare("SELECT id, asset, created_at FROM quant_agent_runs WHERE status IN ('queued','running')").all() as { id: string; asset: string; created_at: number }[];
  for (const p of pending) {
    let j: { status: string; started?: number; finished?: number; result?: { rating: string; score: number | null; reports: Record<string, string>; llm: unknown }; error?: string } | null = null;
    try {
      const r = await fetch(`${base()}/run/${p.id}`, { signal: AbortSignal.timeout(5000) });
      if (r.status === 404) j = { status: 'error', error: 'lost after sidecar restart' };
      else if (r.ok) j = (await r.json()) as typeof j;
    } catch {
      continue;
    }
    if (!j) continue;
    if (j.status === 'running') db.prepare("UPDATE quant_agent_runs SET status = 'running', started_at = ? WHERE id = ?").run(Math.round((j.started ?? Date.now() / 1000) * 1000), p.id);
    else if (j.status === 'done' && j.result) {
      const res = j.result;
      db.prepare("UPDATE quant_agent_runs SET status = 'done', started_at = ?, finished_at = ?, rating = ?, score = ?, reports = ? WHERE id = ?").run(
        Math.round((j.started ?? 0) * 1000),
        Math.round((j.finished ?? Date.now() / 1000) * 1000),
        res.rating,
        res.score,
        JSON.stringify(res.reports),
        p.id,
      );
      if (res.score !== null && res.score !== undefined) {
        // One signal per run; confidence from how decisive the rating is. Valid for 36 h (a daily opinion).
        const conf = Math.min(1, 0.5 + Math.abs(res.score) * 0.5);
        db.prepare('INSERT OR IGNORE INTO quant_signals(at, source, asset, score, confidence, horizon_h, expires_at, price, price_source, detail, ref) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(
          Date.now(),
          'agents',
          p.asset,
          res.score,
          conf,
          5 * 24,
          Date.now() + 36 * 3600_000,
          null,
          null,
          JSON.stringify({ rating: res.rating, final: (res.reports?.final ?? '').slice(0, 400) }),
          p.id,
        );
      }
    } else if (j.status === 'error') db.prepare("UPDATE quant_agent_runs SET status = 'error', finished_at = ?, error = ? WHERE id = ?").run(Date.now(), (j.error ?? 'error').slice(0, 600), p.id);
    // A run that has been "running" for over 2 hours is dead.
    if (j.status !== 'done' && j.status !== 'error' && Date.now() - p.created_at > 2 * 3600_000)
      db.prepare("UPDATE quant_agent_runs SET status = 'error', finished_at = ?, error = 'timeout' WHERE id = ?").run(Date.now(), p.id);
  }
}

/** Daily schedule: at agentsHourUtc, queue every traded asset (once). */
export async function scheduleRuns(): Promise<void> {
  const s = getSettings();
  if (!s.agentsEnabled || !alive) return;
  const now = new Date();
  if (now.getUTCHours() < s.agentsHourUtc) return;
  const key = `quant.agents.day`;
  if (kvGet(key) === today()) return;
  for (const a of s.assets) await requestRun(a).catch(() => undefined);
  kvSet(key, today());
}

export function listRuns(limit = 40): AgentRun[] {
  return getDb().prepare('SELECT * FROM quant_agent_runs ORDER BY created_at DESC LIMIT ?').all(limit) as unknown as AgentRun[];
}
export function getRun(id: string): AgentRun | undefined {
  return getDb().prepare('SELECT * FROM quant_agent_runs WHERE id = ?').get(id) as unknown as AgentRun | undefined;
}
