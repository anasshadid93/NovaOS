import fs from 'node:fs';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { hyperopt, prepareMarket, simulate, type HyperoptOpts, type RunSettings } from './backtest.js';
import type { Brain } from './brain.js';
import { compactMarket, hyperoptPortfolio, simulatePortfolio, walkForward, type MarketData } from './portfolio.js';
import type { Candle } from './strategy.js';

/**
 * Worker thread for the Trade Bot's backtests and hyperopt runs, so the heavy replay never slows
 * MinisManager. Downloads Binance USDⓈ-M 1-minute candles and funding rates (public endpoints,
 * cached on disk) and posts progress and results back to the engine.
 */
export interface JobInput {
  kind: 'backtest' | 'hyperopt' | 'train' | 'walkforward';
  walk?: { trainDays: number; testDays: number; epochs: number; loss: HyperoptOpts['loss']; minTrades: number };
  days: number;
  /** end of the period (ms); defaults to now */
  to?: number;
  settings: RunSettings;
  hyperopt?: HyperoptOpts;
  /** a copy of the live brain: a backtest can think with it, training teaches it */
  brain?: Brain;
  useBrain?: boolean;
  cacheDir: string;
}
export type JobMessage =
  | { type: 'progress'; phase: 'download' | 'prepare' | 'simulate' | 'hyperopt' | 'walkforward'; done: number; total: number; note?: string }
  | { type: 'epoch'; epoch: unknown; best: unknown }
  | { type: 'result'; data: unknown }
  | { type: 'error'; message: string };

const API = 'https://fapi.binance.com/fapi/v1';
// Run as a worker thread (tests, tools) or as its own process (the engine: `--input <file>`, JSON lines out).
const post = (m: JobMessage) => (parentPort ? parentPort.postMessage(m) : process.stdout.write(`${JSON.stringify(m)}\n`));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Row = [number, number, number, number, number, number]; // t, o, h, l, c, quote volume

async function getJson<T>(url: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, { signal: AbortSignal.timeout(20_000) }).catch((e: Error) => e);
    if (!(r instanceof Error) && r.ok) return (await r.json()) as T;
    if (attempt >= 4) throw new Error(r instanceof Error ? r.message : `binance_${r.status}`);
    // 429/418 = slow down (Binance rate limit); anything else: a short retry.
    await sleep(r instanceof Error || (r.status !== 429 && r.status !== 418) ? 1500 : 15_000);
  }
}

/** Candles for [from, to) from the cache, downloading only the missing ends. */
async function candles(sym: string, from: number, to: number, cacheDir: string, tick: () => void, plan: { add: (n: number) => void }): Promise<Candle[]> {
  const f = path.join(cacheDir, `${sym}-1m.json`);
  let rows: Row[] = [];
  try {
    rows = JSON.parse(fs.readFileSync(f, 'utf8')) as Row[];
  } catch {
    /* no cache yet */
  }
  const have0 = rows[0]?.[0] ?? Infinity;
  const have1 = rows.length ? rows.at(-1)![0] + 60_000 : -Infinity;
  const ranges: [number, number][] = [];
  if (!rows.length) ranges.push([from, to]);
  else {
    if (from < have0) ranges.push([from, Math.min(have0, to)]);
    if (to > have1) ranges.push([Math.max(have1, from), to]);
  }
  plan.add(ranges.reduce((s, [a, b]) => s + Math.ceil((b - a) / 60_000 / 1500), 0));
  const got: Row[] = [];
  for (const [a, b] of ranges) {
    for (let s = a; s < b; s += 1500 * 60_000) {
      const e = Math.min(b, s + 1500 * 60_000) - 1;
      const k = await getJson<(string | number)[][]>(`${API}/klines?symbol=${sym}USDT&interval=1m&startTime=${s}&endTime=${e}&limit=1500`);
      for (const x of k) got.push([+x[0], +x[1], +x[2], +x[3], +x[4], Math.round(+x[7])]);
      tick();
      await sleep(120);
    }
  }
  if (got.length) {
    const m = new Map<number, Row>();
    for (const r of rows) m.set(r[0], r);
    for (const r of got) m.set(r[0], r);
    // Keep at most 90 days per coin, and never the still-open minute.
    const now = Date.now();
    rows = [...m.values()].filter((r) => r[0] + 60_000 <= now && r[0] >= now - 90 * 86_400_000).sort((x, y) => x[0] - y[0]);
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(`${f}.tmp`, JSON.stringify(rows));
    fs.renameSync(`${f}.tmp`, f);
  }
  return rows.filter((r) => r[0] >= from && r[0] < to).map((r) => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5], closed: true }));
}

async function fundingRates(sym: string, from: number, to: number): Promise<[number, number][]> {
  const out: [number, number][] = [];
  for (let s = from; s < to; ) {
    const k = await getJson<{ fundingTime: number; fundingRate: string }[]>(`${API}/fundingRate?symbol=${sym}USDT&startTime=${s}&endTime=${to}&limit=1000`);
    for (const x of k) out.push([+x.fundingTime, +x.fundingRate]);
    if (k.length < 1000) break;
    s = +k.at(-1)!.fundingTime + 1;
    await sleep(120);
  }
  return out;
}

/** Hourly candles [t, o, h, l, c, quoteVol] for [from, to), cached on disk (the trend strategy's history). */
async function hourly(sym: string, from: number, to: number, cacheDir: string, tick: () => void): Promise<number[][]> {
  const H = 3600_000;
  const f = path.join(cacheDir, `${sym}-1h.json`);
  let rows: number[][] = [];
  try {
    rows = JSON.parse(fs.readFileSync(f, 'utf8')) as number[][];
  } catch {
    /* no cache yet */
  }
  const ranges: [number, number][] = [];
  if (!rows.length) ranges.push([from, to]);
  else {
    if (from < rows[0][0]) ranges.push([from, rows[0][0]]);
    if (to > rows.at(-1)![0] + H) ranges.push([rows.at(-1)![0] + H, to]);
  }
  const got: number[][] = [];
  for (const [a, b] of ranges)
    for (let s = a; s < b; ) {
      const k = await getJson<(string | number)[][]>(`${API}/klines?symbol=${sym}USDT&interval=1h&startTime=${s}&endTime=${b - 1}&limit=1500`);
      tick();
      if (!k.length) {
        s += 1500 * H; // before the coin was listed
        continue;
      }
      for (const x of k) got.push([+x[0], +x[1], +x[2], +x[3], +x[4], Math.round(+x[7])]);
      s = +k.at(-1)![0] + H;
      await sleep(120);
    }
  if (got.length) {
    const m = new Map<number, number[]>();
    for (const r of rows) m.set(r[0], r);
    for (const r of got) m.set(r[0], r);
    const now = Date.now();
    rows = [...m.values()].filter((r) => r[0] + H <= now).sort((x, y) => x[0] - y[0]);
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(`${f}.tmp`, JSON.stringify(rows));
    fs.renameSync(`${f}.tmp`, f);
  }
  return rows.filter((r) => r[0] >= from && r[0] < to);
}

/** The portfolio strategies (trend, EMA, momentum, coin ranking, carry, mix): backtest, hyperopt, walk-forward on hourly history. */
async function runPortfolio(job: JobInput) {
  const H = 3600_000;
  const D = 24 * H;
  const to = Math.floor((job.to ?? Date.now()) / H) * H;
  const from = to - Math.round(job.days * 24) * H;
  // Warm-up before `from`: the longest channel/EMA/lookback any setting may use, plus 30 days of volatility.
  const warm = 260 * D;
  const syms = job.settings.params.pairs;
  let done = 0;
  const total = syms.length * (Math.ceil((to - from + warm) / H / 1500) + 2);
  const tick = () => post({ type: 'progress', phase: 'download', done: ++done, total: Math.max(total, done + 1) });
  const md: MarketData = { rows: {}, funding: {} };
  for (const s of syms) {
    post({ type: 'progress', phase: 'download', done, total, note: `${s} history` });
    md.rows[s] = await hourly(s, from - warm, to, job.cacheDir, tick);
    md.funding[s] = await fundingRates(s, from - warm, to);
    tick();
  }
  for (const s of syms) if (!md.rows[s].length) {
    delete md.rows[s];
    delete md.funding[s];
  }
  const candlesCount = Object.values(md.rows).reduce((s, a) => s + a.length, 0);
  compactMarket(md); // compact columns; the bulky rows go
  if (job.kind === 'walkforward') {
    const wf = job.walk!;
    const res = await walkForward(md, job.settings, { from, to, trainDays: wf.trainDays, testDays: wf.testDays, epochs: wf.epochs, loss: wf.loss, minTrades: wf.minTrades, seed: Math.floor(Math.random() * 1e9) }, async (d, n) => {
      post({ type: 'progress', phase: 'walkforward', done: d, total: n });
      await sleep(0);
    });
    post({ type: 'result', data: { ...res, days: job.days, candles: candlesCount, settings: job.settings, walk: wf, strategy: job.settings.params.strategy } });
    return;
  }
  if (job.kind !== 'hyperopt') {
    post({ type: 'progress', phase: 'simulate', done: 0, total: 1 });
    const r = simulatePortfolio(md, job.settings, { from, to });
    post({ type: 'result', data: { ...r, days: job.days, candles: candlesCount, settings: job.settings, strategy: job.settings.params.strategy } });
    return;
  }
  const o = job.hyperopt!;
  let last = 0;
  const res = await hyperoptPortfolio(md, job.settings, o, { from, to }, async (e, best, i) => {
    post({ type: 'epoch', epoch: e, best });
    if (Date.now() - last > 400 || i === o.epochs - 1) {
      last = Date.now();
      post({ type: 'progress', phase: 'hyperopt', done: i + 1, total: o.epochs });
      await sleep(0);
    }
  });
  const full = res.best ? simulatePortfolio(md, { ...job.settings, params: { ...job.settings.params, ...res.best.params } }, { from, to }) : null;
  post({ type: 'result', data: { best: res.best, top: [...res.epochs].sort((a, b) => a.loss - b.loss).slice(0, 15), bestRun: full && { stats: full.stats, equity: full.equity, final: full.final }, days: job.days, candles: candlesCount, from, to, strategy: job.settings.params.strategy } });
}

async function run(job: JobInput) {
  if (job.settings.params.strategy !== 'scalp' && job.kind !== 'train' && !job.useBrain) return runPortfolio(job);
  // Whole minutes, ending at the last closed one.
  const to = Math.floor((job.to ?? Date.now()) / 60_000) * 60_000 - 60_000;
  const from = to - Math.round(job.days * 1440) * 60_000;
  const syms = job.settings.params.pairs;
  let done = 0,
    total = syms.length * 2;
  const plan = { add: (n: number) => (total += n) };
  const tick = () => post({ type: 'progress', phase: 'download', done: ++done, total });
  const data: Record<string, Candle[]> = {};
  const funding: Record<string, [number, number][]> = {};
  for (const s of syms) {
    post({ type: 'progress', phase: 'download', done, total, note: `${s} candles` });
    data[s] = await candles(s, from, to, job.cacheDir, tick, plan);
    tick();
    if (job.settings.params.funding) funding[s] = await fundingRates(s, from, to);
    tick();
  }
  post({ type: 'progress', phase: 'prepare', done: 0, total: 1 });
  const n = Math.round((to - from) / 60_000);
  const market = prepareMarket(data, from, n, funding);
  const candlesCount = Object.values(data).reduce((s, a) => s + a.length, 0);

  if (job.kind === 'backtest' || job.kind === 'train') {
    post({ type: 'progress', phase: 'simulate', done: 0, total: 1 });
    const brain = job.kind === 'train' || job.useBrain ? job.brain : undefined;
    const before = brain ? { trading: brain.tradingPoints, judgment: brain.judgmentPoints, trades: brain.trades, shadows: brain.shadows, lessons: brain.lessons.length } : null;
    const r = simulate(market, job.settings, { brain });
    const practice = brain && before && { trading: +(brain.tradingPoints - before.trading).toFixed(2), judgment: +(brain.judgmentPoints - before.judgment).toFixed(2), trades: brain.trades - before.trades, shadows: brain.shadows - before.shadows };
    post({ type: 'result', data: { ...r, days: job.days, candles: candlesCount, settings: job.settings, useBrain: !!brain, practice, brain: job.kind === 'train' ? brain : undefined } });
    return;
  }
  const o = job.hyperopt!;
  let last = 0;
  const res = await hyperopt(market, job.settings, o, async (e, best, i) => {
    post({ type: 'epoch', epoch: e, best });
    if (Date.now() - last > 400 || i === o.epochs - 1) {
      last = Date.now();
      post({ type: 'progress', phase: 'hyperopt', done: i + 1, total: o.epochs });
      await sleep(0);
    }
  });
  // The winner, replayed in full so the page can show its curve and trades.
  const full = res.best ? simulate(market, { ...job.settings, marginPct: res.best.marginPct ?? job.settings.marginPct, params: { ...job.settings.params, ...res.best.params }, protections: res.best.protections ?? job.settings.protections, useProtections: job.settings.useProtections || !!res.best.protections }) : null;
  post({ type: 'result', data: { best: res.best, top: [...res.epochs].sort((a, b) => a.loss - b.loss).slice(0, 15), bestRun: full && { stats: full.stats, equity: full.equity, final: full.final }, days: job.days, candles: candlesCount, from, to } });
}

const argIdx = process.argv.indexOf('--input');
const input = (argIdx > 0 ? JSON.parse(fs.readFileSync(process.argv[argIdx + 1], 'utf8')) : workerData) as JobInput;
run(input)
  .catch((e: Error) => post({ type: 'error', message: e.message.slice(0, 300) }))
  .finally(() => {
    // As a process: leave once stdout has drained.
    if (!parentPort) process.stdout.write('', () => process.exit(0));
  });
