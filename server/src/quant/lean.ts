import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { requireAuth, requireElevated } from '../auth/sessions.js';
import { config } from '../config.js';
import { audit, getDb } from '../db.js';
import { MARKETS } from './market.js';
import { getSettings, type RiskLimits } from './settings.js';

/**
 * QuantConnect LEAN as the backtesting / validation engine. The workspace under config.leanDir
 * holds the lean CLI venv, a LEAN data folder (Binance history exported by scripts/export_binance.py)
 * and the "novaos" project whose main.py replays the Quant Desk rules. Runs are queued one at a
 * time (each is a Docker container) and recorded in quant_lean_runs with statistics + equity curve.
 */
const execFileP = promisify(execFile);
const ws = () => path.join(config.leanDir, 'workspace');
const leanBin = () => path.join(config.leanDir, 'venv', 'bin', 'lean');
const pyBin = () => path.join(config.leanDir, 'venv', 'bin', 'python');
export const leanInstalled = () => fs.existsSync(leanBin()) && fs.existsSync(path.join(ws(), 'lean.json')) && fs.existsSync(path.join(ws(), 'novaos', 'main.py'));

export interface LeanRun {
  id: number;
  kind: 'backtest' | 'walkforward' | 'data' | 'futures';
  created_at: number;
  finished_at: number | null;
  status: 'queued' | 'running' | 'done' | 'error';
  params: string | null;
  stats: string | null;
  equity: string | null;
  log: string | null;
  folder: string | null;
}

export interface BacktestParams {
  start: string;
  end: string;
  assets?: string[];
  cash?: number;
  risk?: Partial<RiskLimits>;
  weights?: { technical?: number; agents?: number; news?: number };
  /** Include the stored agent/news signals (signals.csv) — only meaningful for recent dates. */
  withSignals?: boolean;
}

/**
 * Runs the lean CLI. manar.service has PrivateTmp, so the CLI's temp dirs must live where the Docker
 * daemon can see them (TMPDIR under the LEAN folder); failures carry the CLI's own output.
 */
async function lean(args: string[], timeoutMs = 40 * 60_000): Promise<{ stdout: string; stderr: string }> {
  const tmp = path.join(config.leanDir, 'tmp');
  fs.mkdirSync(tmp, { recursive: true });
  try {
    return await execFileP(leanBin(), args, {
      cwd: ws(),
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, HOME: process.env.HOME ?? config.leanDir, TMPDIR: tmp, TMP: tmp, TEMP: tmp },
    });
  } catch (e) {
    const err = e as Error & { stdout?: string; stderr?: string };
    const tail = `${err.stdout ?? ''}\n${err.stderr ?? ''}`
      .split('\n')
      .filter((l) => l.trim() && !/^\s*\d{8} \d{2}:\d{2}:\d{2}\.\d+ TRACE::/.test(l))
      .slice(-40)
      .join('\n');
    throw new Error(`${err.message.split('\n')[0].slice(0, 200)}\n${tail}`);
  }
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
let running = false;
const queue: number[] = [];

function paramArgs(p: BacktestParams): string[] {
  const s = getSettings();
  const R = { ...s.risk, ...(p.risk ?? {}) };
  const W = { ...s.weights, ...(p.weights ?? {}) };
  const assets = (p.assets ?? s.assets).filter((a) => MARKETS[a]).map((a) => MARKETS[a].leanTicker);
  const kv: Record<string, string | number> = {
    start: p.start,
    end: p.end,
    cash: p.cash ?? R.startBalance,
    assets: assets.join(','),
    riskPct: R.riskPct,
    maxPositionPct: R.maxPositionPct,
    maxExposurePct: R.maxExposurePct,
    maxOpen: R.maxOpen,
    stopAtr: R.stopAtr,
    stopMinPct: R.stopMinPct,
    stopMaxPct: R.stopMaxPct,
    takeProfitR: R.takeProfitR,
    trailArmR: R.trailArmR,
    trailAtr: R.trailAtr,
    dailyLossPct: R.dailyLossPct,
    maxHoldDays: R.maxHoldDays,
    cooldownMin: R.cooldownMin,
    entryScore: R.entryScore,
    exitScore: R.exitScore,
    wTechnical: W.technical,
    wAgents: W.agents,
    wNews: W.news,
    strategy: s.strategy,
    trailPct: s.regime.trailPct,
    cooldownDays: s.regime.cooldownDays,
  };
  return Object.entries(kv).flatMap(([k, v]) => ['--parameter', k, String(v)]);
}

/** Writes the stored agent/news signals for the LEAN algorithm (or removes the file). */
function writeSignals(on: boolean) {
  const f = path.join(ws(), 'novaos', 'signals.csv');
  if (!on) {
    fs.rmSync(f, { force: true });
    return;
  }
  const rows = getDb().prepare("SELECT at, asset, source, score, confidence, expires_at FROM quant_signals WHERE source IN ('agents','news') ORDER BY at").all() as {
    at: number;
    asset: string;
    source: string;
    score: number;
    confidence: number;
    expires_at: number;
  }[];
  const lines = [
    'at,asset,source,score,confidence,expires',
    ...rows.map((r) => `${new Date(r.at).toISOString()},${MARKETS[r.asset]?.leanTicker ?? r.asset},${r.source},${r.score},${r.confidence},${new Date(r.expires_at).toISOString()}`),
  ];
  fs.writeFileSync(f, lines.join('\n') + '\n');
}

interface Parsed {
  stats: Record<string, string>;
  equity: [number, number][];
  orders: number;
}

function parseOutput(folder: string): Parsed {
  const files = fs.readdirSync(folder);
  const main = files.find((f) => /^\d+\.json$/.test(f));
  if (!main) throw new Error('no result json');
  const d = JSON.parse(fs.readFileSync(path.join(folder, main), 'utf8')) as {
    statistics?: Record<string, string>;
    charts?: Record<string, { series?: Record<string, { values?: number[][] }> }>;
    orders?: Record<string, unknown>;
  };
  const values = d.charts?.['Strategy Equity']?.series?.Equity?.values ?? [];
  // Keep at most ~1500 points for the UI: [unix seconds, close].
  const stepN = Math.max(1, Math.ceil(values.length / 1500));
  const equity = values.filter((_, i) => i % stepN === 0 || i === values.length - 1).map((v) => [v[0] * 1000, v[4] ?? v[1]] as [number, number]);
  return { stats: d.statistics ?? {}, equity, orders: Object.keys(d.orders ?? {}).length };
}

async function runBacktest(id: number, p: BacktestParams): Promise<void> {
  const folder = path.join(ws(), 'backtests', `run-${id}`);
  writeSignals(!!p.withSignals);
  const args = ['backtest', 'novaos', '--output', folder, ...paramArgs(p)];
  const { stdout, stderr } = await lean(args);
  const out = (stdout + '\n' + stderr)
    .split('\n')
    .filter((l) => /STATISTICS::|ERROR|Error|Exception|Successfully ran/.test(l))
    .slice(-80)
    .join('\n');
  const parsed = parseOutput(folder);
  getDb()
    .prepare("UPDATE quant_lean_runs SET status = 'done', finished_at = ?, stats = ?, equity = ?, log = ?, folder = ? WHERE id = ?")
    .run(Date.now(), JSON.stringify({ ...parsed.stats, orders: parsed.orders }), JSON.stringify(parsed.equity), out.slice(-8000), folder, id);
}

const num = (s: string | undefined) => Number(String(s ?? '').replace(/[%$,]/g, '')) || 0;

/**
 * Walk-forward: for each window, try a small grid on the train period, keep the best Sharpe, then
 * run it on the test period. Reports per-window out-of-sample results plus the stitched summary.
 */
async function runWalkForward(id: number, p: BacktestParams & { trainDays: number; testDays: number }): Promise<void> {
  const grid: Partial<RiskLimits>[] = [];
  for (const entryScore of [0.25, 0.35, 0.45]) for (const stopAtr of [1.5, 2, 3]) for (const takeProfitR of [2, 3]) grid.push({ entryScore, stopAtr, takeProfitR });
  const start = new Date(p.start);
  const end = new Date(p.end);
  const windows: { trainStart: string; trainEnd: string; testStart: string; testEnd: string }[] = [];
  for (let t = new Date(start); ;) {
    const trainEnd = new Date(t.getTime() + p.trainDays * 86400_000);
    const testEnd = new Date(trainEnd.getTime() + p.testDays * 86400_000);
    if (testEnd > end) break;
    windows.push({
      trainStart: t.toISOString().slice(0, 10),
      trainEnd: trainEnd.toISOString().slice(0, 10),
      testStart: trainEnd.toISOString().slice(0, 10),
      testEnd: testEnd.toISOString().slice(0, 10),
    });
    t = new Date(t.getTime() + p.testDays * 86400_000);
  }
  if (!windows.length) throw new Error('range too short for train+test');
  const results: { window: (typeof windows)[number]; best: Partial<RiskLimits>; trainSharpe: number; test: Record<string, string> }[] = [];
  const base = path.join(ws(), 'backtests', `wf-${id}`);
  fs.mkdirSync(base, { recursive: true });
  const db = getDb();
  let done = 0;
  const total = windows.length * (grid.length + 1);
  for (const w of windows) {
    let best: { params: Partial<RiskLimits>; sharpe: number } | null = null;
    for (const g of grid) {
      const folder = path.join(base, `train-${w.trainStart}-${Object.values(g).join('_')}`);
      await lean(['backtest', 'novaos', '--output', folder, ...paramArgs({ ...p, start: w.trainStart, end: w.trainEnd, risk: { ...(p.risk ?? {}), ...g } })]);
      const r = parseOutput(folder);
      const sharpe = num(r.stats['Sharpe Ratio']);
      if (!best || sharpe > best.sharpe) best = { params: g, sharpe };
      done++;
      db.prepare('UPDATE quant_lean_runs SET log = ? WHERE id = ?').run(`window ${results.length + 1}/${windows.length}: ${done}/${total} backtests`, id);
    }
    const folder = path.join(base, `test-${w.testStart}`);
    await lean(['backtest', 'novaos', '--output', folder, ...paramArgs({ ...p, start: w.testStart, end: w.testEnd, risk: { ...(p.risk ?? {}), ...best!.params } })]);
    const r = parseOutput(folder);
    results.push({ window: w, best: best!.params, trainSharpe: best!.sharpe, test: { ...r.stats, orders: String(r.orders) } });
    done++;
  }
  const oos = results.map((r) => num(r.test['Net Profit']) / 100);
  const compounded = oos.reduce((a, b) => a * (1 + b), 1) - 1;
  const stats = {
    windows: results.length,
    'Net Profit': `${(compounded * 100).toFixed(2)}%`,
    'Win Windows': `${results.filter((r) => num(r.test['Net Profit']) > 0).length}/${results.length}`,
    'Avg OOS Sharpe': (results.reduce((a, r) => a + num(r.test['Sharpe Ratio']), 0) / results.length).toFixed(2),
    'Worst Drawdown': `${Math.max(...results.map((r) => num(r.test.Drawdown))).toFixed(1)}%`,
    orders: results.reduce((a, r) => a + num(r.test.orders), 0),
    perWindow: results,
  };
  db.prepare("UPDATE quant_lean_runs SET status = 'done', finished_at = ?, stats = ?, equity = ?, log = ?, folder = ? WHERE id = ?").run(
    Date.now(),
    JSON.stringify(stats),
    JSON.stringify([]),
    `${results.length} windows, ${total} backtests`,
    base,
    id,
  );
}

async function runData(id: number, assets: string[]): Promise<void> {
  const syms = assets.filter((a) => MARKETS[a]).map((a) => MARKETS[a].leanTicker);
  const { stdout } = await execFileP(pyBin(), ['-I', path.join(config.leanDir, 'scripts', 'export_binance.py'), 'data', 'daily', ...syms, '--since', '2019-01-01'], {
    cwd: ws(),
    timeout: 15 * 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  getDb().prepare("UPDATE quant_lean_runs SET status = 'done', finished_at = ?, stats = ?, log = ? WHERE id = ?").run(Date.now(), stdout.trim().slice(0, 4000), 'exported', id);
}

async function pump() {
  if (running) return;
  const id = queue.shift();
  if (id === undefined) return;
  running = true;
  const db = getDb();
  const row = db.prepare('SELECT * FROM quant_lean_runs WHERE id = ?').get(id) as unknown as LeanRun | undefined;
  if (!row) {
    running = false;
    return pump();
  }
  db.prepare("UPDATE quant_lean_runs SET status = 'running' WHERE id = ?").run(id);
  try {
    const p = JSON.parse(row.params ?? '{}') as BacktestParams & { trainDays?: number; testDays?: number; assets?: string[] };
    if (row.kind === 'backtest') await runBacktest(id, p);
    else if (row.kind === 'walkforward') await runWalkForward(id, { ...p, trainDays: p.trainDays ?? 365, testDays: p.testDays ?? 90 });
    else await runData(id, p.assets ?? getSettings().assets);
  } catch (e) {
    db.prepare("UPDATE quant_lean_runs SET status = 'error', finished_at = ?, log = ? WHERE id = ?").run(Date.now(), String((e as Error).message ?? e).slice(-4000), id);
  } finally {
    running = false;
    void pump();
  }
}

function enqueueRun(kind: LeanRun['kind'], params: unknown): number {
  const res = getDb().prepare("INSERT INTO quant_lean_runs(kind, created_at, status, params) VALUES(?,?,'queued',?)").run(kind, Date.now(), JSON.stringify(params));
  const id = Number(res.lastInsertRowid);
  queue.push(id);
  void pump();
  return id;
}

export function leanStatus() {
  const db = getDb();
  const runs = db.prepare('SELECT id, kind, created_at, finished_at, status, params, stats, log FROM quant_lean_runs ORDER BY created_at DESC LIMIT 20').all() as unknown as Omit<
    LeanRun,
    'equity' | 'folder'
  >[];
  let data: Record<string, { bars: number; first: string | null; last: string | null }> | null = null;
  try {
    const dir = path.join(ws(), 'data', 'crypto', 'binance', 'daily');
    data = Object.fromEntries(
      fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('_trade.zip'))
        .map((f) => [f.replace('_trade.zip', '').toUpperCase(), { bars: 0, first: null, last: fs.statSync(path.join(dir, f)).mtime.toISOString().slice(0, 10) }]),
    );
  } catch {
    data = null;
  }
  return {
    installed: leanInstalled(),
    running,
    queue: queue.length,
    runs: runs.map((r) => ({ ...r, params: r.params ? JSON.parse(r.params) : null, stats: r.stats ? (JSON.parse(r.stats) as unknown) : null })),
    data,
  };
}

export function startLean(): () => void {
  // Anything left 'running' or 'queued' by a crash is marked failed; the user can start it again.
  if (leanInstalled()) getDb().prepare("UPDATE quant_lean_runs SET status = 'error', log = 'interrupted by restart' WHERE status IN ('queued','running')").run();
  return () => {};
}
export function stopLean() {
  /* docker runs finish or get killed with the container */
}

export async function leanRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>('/api/quant/lean/runs/:id', { preHandler: requireAuth }, async (req, reply) => {
    const r = getDb().prepare('SELECT * FROM quant_lean_runs WHERE id = ?').get(Number(req.params.id)) as unknown as LeanRun | undefined;
    if (!r) return reply.code(404).send({ error: 'not_found' });
    return { ...r, params: r.params ? JSON.parse(r.params) : null, stats: r.stats ? JSON.parse(r.stats) : null, equity: r.equity ? JSON.parse(r.equity) : [] };
  });
  app.post<{ Body: BacktestParams }>('/api/quant/lean/backtest', { preHandler: requireAuth }, async (req, reply) => {
    if (!leanInstalled()) return reply.code(503).send({ error: 'lean_not_installed' });
    const b = req.body ?? ({} as BacktestParams);
    if (!DAY.test(String(b.start)) || !DAY.test(String(b.end)) || b.start >= b.end) return reply.code(400).send({ error: 'bad_range' });
    const id = enqueueRun('backtest', { start: b.start, end: b.end, assets: b.assets, cash: b.cash, risk: b.risk, weights: b.weights, withSignals: !!b.withSignals });
    audit(req.session!.userId, 'quant_lean_backtest', { id, start: b.start, end: b.end });
    return { id };
  });
  app.post<{ Body: BacktestParams & { trainDays?: number; testDays?: number } }>('/api/quant/lean/walkforward', { preHandler: requireAuth }, async (req, reply) => {
    if (!leanInstalled()) return reply.code(503).send({ error: 'lean_not_installed' });
    const b = req.body ?? ({} as BacktestParams);
    if (!DAY.test(String(b.start)) || !DAY.test(String(b.end)) || b.start >= b.end) return reply.code(400).send({ error: 'bad_range' });
    const trainDays = Math.min(1500, Math.max(90, Number(b.trainDays ?? 365)));
    const testDays = Math.min(365, Math.max(30, Number(b.testDays ?? 90)));
    const id = enqueueRun('walkforward', { start: b.start, end: b.end, assets: b.assets, cash: b.cash, risk: b.risk, weights: b.weights, trainDays, testDays });
    audit(req.session!.userId, 'quant_lean_walkforward', { id, start: b.start, end: b.end, trainDays, testDays });
    return { id };
  });
  app.post('/api/quant/lean/data', { preHandler: requireElevated }, async (req, reply) => {
    if (!leanInstalled()) return reply.code(503).send({ error: 'lean_not_installed' });
    const id = enqueueRun('data', { assets: getSettings().assets });
    audit(req.session!.userId, 'quant_lean_data', { id });
    return { id };
  });
}
