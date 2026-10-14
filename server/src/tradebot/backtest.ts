import { factorsOf, learn, think, type Brain, type Moment } from './brain.js';
import { activeLocks, lockedBy, maxLookbackMs, protectionsAfter, type Lock, type ProtectionCfg } from './protections.js';
import { computeStats, monteCarlo, type Stats } from './stats.js';
import { closeTrade, exitCheck, fundingPay, openPosition, pairlist, pnlOf, signalFrom, updateTrail, zScore, type Candle, type Closed, type Params, type Position } from './strategy.js';

/**
 * Backtesting and hyperopt, after freqtrade: replay Binance 1-minute candles through exactly the
 * strategy, exits, fees, slippage, funding and protections the live bot uses, then report the same
 * statistics. Hyperopt searches the strategy's numbers for the best score of a loss function.
 * Pure: the data comes in, results go out (the worker thread does the downloading).
 */

export interface Series {
  sym: string;
  o: Float64Array;
  h: Float64Array;
  l: Float64Array;
  c: Float64Array;
  z: Float64Array;
  atr: Float64Array;
  rising: Uint8Array;
  vol24: Float64Array;
}
export interface Market {
  /** open time of the first minute */
  t0: number;
  n: number;
  series: Record<string, Series>;
  /** funding events per coin: [time, rate] ascending */
  funding: Record<string, [number, number][]>;
}

/** Aligns candles minute by minute (gaps stay NaN) and precomputes the signal inputs once. */
export function prepareMarket(candles: Record<string, Candle[]>, t0: number, n: number, funding: Record<string, [number, number][]> = {}): Market {
  const series: Record<string, Series> = {};
  for (const [sym, arr] of Object.entries(candles)) {
    const s: Series = {
      sym,
      o: new Float64Array(n).fill(NaN),
      h: new Float64Array(n).fill(NaN),
      l: new Float64Array(n).fill(NaN),
      c: new Float64Array(n).fill(NaN),
      z: new Float64Array(n).fill(NaN),
      atr: new Float64Array(n).fill(NaN),
      rising: new Uint8Array(n),
      vol24: new Float64Array(n),
    };
    const vol = new Float64Array(n);
    for (const k of arr) {
      const i = Math.round((k.t - t0) / 60_000);
      if (i < 0 || i >= n) continue;
      s.o[i] = k.o;
      s.h[i] = k.h;
      s.l[i] = k.l;
      s.c[i] = k.c;
      vol[i] = k.v;
    }
    // A rolling window of the last 30 candles (reset on a gap), so z matches the live bot.
    const win: Candle[] = [];
    let v24 = 0;
    for (let i = 0; i < n; i++) {
      v24 += vol[i] - (i >= 1440 ? vol[i - 1440] : 0);
      s.vol24[i] = v24;
      if (Number.isNaN(s.c[i])) {
        win.length = 0;
        continue;
      }
      win.push({ t: t0 + i * 60_000, o: s.o[i], h: s.h[i], l: s.l[i], c: s.c[i], v: vol[i], closed: true });
      if (win.length > 30) win.shift();
      const r = zScore(win);
      if (r) {
        s.z[i] = r.z;
        s.atr[i] = r.atr;
        s.rising[i] = r.rising ? 1 : 0;
      }
    }
    series[sym] = s;
  }
  return { t0, n, series, funding };
}

export interface RunSettings {
  start: number;
  marginPct: number;
  params: Params;
  protections: ProtectionCfg;
  useProtections: boolean;
}

/** A position the brain thinks about: its factors, kept for learning when it closes. */
type BrainPos = Position & { keys?: string[]; labels?: Record<string, string>; fundIdx?: number };

export interface BacktestResult {
  from: number;
  to: number;
  start: number;
  final: number;
  stats: Stats;
  closed: Closed[];
  equity: [number, number][];
  /** buy-and-hold change of each coin over the period, % */
  marketChange: Record<string, number>;
  marketAvg: number;
  locks: Lock[];
  openAtEnd: number;
  stoppedEarly: boolean;
  /** the same trades resampled 1000×: how it could have gone with other luck */
  monteCarlo?: ReturnType<typeof monteCarlo>;
}

/**
 * Replays the market. `light` skips the per-trade list and the equity curve (hyperopt epochs).
 * Within a minute: open trades are checked against the candle's range first (pessimistic: the stop
 * before the target), then new trades open at the candle's close, the strongest signals first.
 */
export function simulate(m: Market, rs: RunSettings, opts: { light?: boolean; brain?: Brain } = {}): BacktestResult {
  const p = rs.params;
  const prot = rs.protections;
  const syms = Object.keys(m.series).filter((s) => p.pairs.includes(s));
  const lookback = maxLookbackMs(prot);
  let balance = rs.start;
  let id = 1;
  const open: BrainPos[] = [];
  const shadows: BrainPos[] = []; // signals the brain skipped, followed to learn from them
  const brain = opts.brain;
  const rand = rng(42);
  const closed: Closed[] = []; // oldest first
  const recent: Closed[] = []; // newest first, within the longest lookback
  const equity: [number, number][] = [];
  let locks: Lock[] = [];
  const allLocks: Lock[] = [];
  const fundPtr: Record<string, number> = Object.fromEntries(syms.map((s) => [s, 0]));
  let active = syms;
  let stoppedEarly = false;

  for (let i = 0; i < m.n; i++) {
    const now = m.t0 + (i + 1) * 60_000; // the candle's close
    // Exits
    for (let k = open.length - 1; k >= 0; k--) {
      const pos = open[k];
      const s = m.series[pos.sym];
      const c = s.c[i];
      if (Number.isNaN(c)) continue;
      if (p.funding) {
        const ev = m.funding[pos.sym];
        if (ev) {
          let j = fundPtr[pos.sym] ?? 0;
          while (j < ev.length && ev[j][0] <= now) {
            if (ev[j][0] > pos.openedAt) pos.funding += fundingPay(pos, ev[j][1], c);
            j++;
          }
          fundPtr[pos.sym] = j;
        }
      }
      const ex = exitCheck(pos, { h: s.h[i], l: s.l[i], c }, p, now);
      if (!ex) {
        updateTrail(pos, pos.side === 'LONG' ? s.h[i] : s.l[i], p);
        continue;
      }
      const t = closeTrade(pos, ex, balance, p, now);
      balance = Math.max(0, balance + t.pnl);
      open.splice(k, 1);
      closed.push(t);
      if (brain && pos.keys) learn(brain, t, pos.keys, pos.labels ?? {}, true);
      recent.unshift(t);
      while (recent.length && recent.at(-1)!.at < now - lookback) recent.pop();
      if (rs.useProtections) {
        const add = protectionsAfter(prot, recent, t, now, balance);
        if (add.length) {
          locks = activeLocks(locks, now).concat(add);
          if (!opts.light) allLocks.push(...add.filter((l) => l.by !== 'cooldown'));
        }
      } else locks = [{ pair: t.sym, until: now + 2 * 60_000, at: now, by: 'cooldown', reason: '' }, ...activeLocks(locks, now)];
    }
    // Shadow trades (skipped signals): same exits, no money — only the lesson.
    if (brain)
      for (let k = shadows.length - 1; k >= 0; k--) {
        const pos = shadows[k];
        const s = m.series[pos.sym];
        const c = s.c[i];
        if (Number.isNaN(c)) continue;
        const ev = p.funding ? m.funding[pos.sym] : undefined;
        while (ev && (pos.fundIdx ?? ev.length) < ev.length && ev[pos.fundIdx!][0] <= now) pos.funding += fundingPay(pos, ev[pos.fundIdx!++][1], c);
        const ex = exitCheck(pos, { h: s.h[i], l: s.l[i], c }, p, now);
        if (!ex) {
          updateTrail(pos, pos.side === 'LONG' ? s.h[i] : s.l[i], p);
          continue;
        }
        shadows.splice(k, 1);
        learn(brain, closeTrade(pos, ex, balance, p, now), pos.keys ?? [], pos.labels ?? {}, false);
      }
    // Funding pointers advance for coins without a trade too.
    if (p.funding)
      for (const sym of syms) {
        const ev = m.funding[sym];
        if (!ev || open.some((o) => o.sym === sym)) continue;
        let j = fundPtr[sym] ?? 0;
        while (j < ev.length && ev[j][0] <= now) j++;
        fundPtr[sym] = j;
      }
    if (balance <= 1 && !open.length) {
      stoppedEarly = true;
      break;
    }
    // Pairlist refresh every 30 minutes.
    if (p.volumeTopN && i % 30 === 0) {
      const vol: Record<string, number> = {};
      for (const s of syms) vol[s] = m.series[s].vol24[i];
      active = pairlist({ ...p, pairs: syms }, vol);
    }
    // Entries
    if (open.length < p.maxOpen && balance > 1) {
      const sigs = [];
      for (const sym of active) {
        if (open.some((o) => o.sym === sym) || lockedBy(locks, sym, now)) continue;
        const s = m.series[sym];
        const z = s.z[i];
        if (Number.isNaN(z)) continue;
        const sig = signalFrom(sym, { z, atr: s.atr[i], rising: s.rising[i] === 1 }, p.zEntry, p.mode);
        if (sig) sigs.push(sig);
      }
      sigs.sort((a, b) => b.strength - a.strength);
      for (const sig of sigs) {
        if (open.length >= p.maxOpen) break;
        const used = open.reduce((x, o) => x + o.margin, 0);
        const s = m.series[sig.sym];
        let size = 1;
        let keys: string[] | undefined, labels: Record<string, string> | undefined;
        if (brain) {
          // Deep think first: the moment's factors against what they've earned so far.
          const ev = m.funding[sig.sym];
          const fi = fundPtr[sig.sym] ?? 0;
          const moment: Moment = {
            sym: sig.sym,
            side: sig.side,
            z: s.z[i],
            atr: sig.atr,
            trend1h: i >= 60 && !Number.isNaN(s.c[i - 60]) ? s.c[i] / s.c[i - 60] - 1 : null,
            hour: new Date(now).getUTCHours(),
            fundingRate: ev && fi > 0 ? ev[fi - 1][1] : null,
            last: brain.last,
            mode: p.mode,
          };
          const th = think(brain, sig, moment, now, rand);
          const fs = factorsOf(moment);
          keys = fs.map((f) => f.key);
          labels = Object.fromEntries(fs.map((f) => [f.key, f.label]));
          if (th.decision === 'SKIP') {
            if (shadows.length < 10 && !shadows.some((x) => x.sym === sig.sym)) {
              const sh: BrainPos | null = openPosition({ balance, marginPct: rs.marginPct, id: -id++ }, sig, s.c[i], p, now, 'shadow');
              if (sh) shadows.push(Object.assign(sh, { keys, labels, fundIdx: fi }));
            }
            continue;
          }
          size = th.size;
        }
        const pos: BrainPos | null = openPosition({ balance, marginPct: Math.min(90, rs.marginPct * size), usedMargin: used, id: id++ }, sig, s.c[i], p, now, brain ? 'brain' : 'signal');
        if (!pos) break;
        if (keys) Object.assign(pos, { keys, labels });
        open.push(pos);
      }
    }
    if (!opts.light && i % 60 === 59) {
      const unreal = open.reduce((x, o) => x + pnlOf(o, m.series[o.sym].c[i] || o.entry) - o.fees + o.funding, 0);
      equity.push([now, +(balance + unreal).toFixed(4)]);
    }
  }

  // Trades still open at the end are closed at the last price (freqtrade's "force_exit" at the end).
  const endAt = m.t0 + m.n * 60_000;
  const openAtEnd = open.length;
  for (const pos of open) {
    const s = m.series[pos.sym];
    let last = pos.entry;
    for (let i = m.n - 1; i >= 0; i--)
      if (!Number.isNaN(s.c[i])) {
        last = s.c[i];
        break;
      }
    const t = closeTrade(pos, { why: 'FORCE', at: last, maker: false }, balance, p, endAt);
    balance = Math.max(0, balance + t.pnl);
    closed.push(t);
    if (brain && pos.keys) learn(brain, t, pos.keys, pos.labels ?? {}, true);
  }
  if (!opts.light) equity.push([endAt, +balance.toFixed(4)]);

  const marketChange: Record<string, number> = {};
  for (const sym of syms) {
    const c = m.series[sym].c;
    let a = NaN,
      b = NaN;
    for (let i = 0; i < m.n && Number.isNaN(a); i++) a = c[i];
    for (let i = m.n - 1; i >= 0 && Number.isNaN(b); i--) b = c[i];
    if (a > 0 && b > 0) marketChange[sym] = +((b / a - 1) * 100).toFixed(2);
  }
  const mc = Object.values(marketChange);
  const desc = closed.slice().reverse();
  return {
    from: m.t0,
    to: endAt,
    start: rs.start,
    final: +balance.toFixed(4),
    stats: computeStats(desc, rs.start, { from: m.t0, to: endAt }),
    closed: opts.light ? [] : desc.slice(0, 500),
    equity: opts.light ? [] : downsample(equity, 400),
    marketChange,
    marketAvg: mc.length ? +(mc.reduce((x, v) => x + v, 0) / mc.length).toFixed(2) : 0,
    monteCarlo: opts.light ? null : monteCarlo(desc),
    locks: allLocks.slice(-100),
    openAtEnd,
    stoppedEarly,
  };
}

function downsample(a: [number, number][], max: number): [number, number][] {
  if (a.length <= max) return a;
  const out: [number, number][] = [];
  const step = a.length / max;
  for (let i = 0; i < max; i++) out.push(a[Math.floor(i * step)]);
  out.push(a.at(-1)!);
  return out;
}

// ---- hyperopt ---------------------------------------------------------------------------------
export type LossName = 'shortduration' | 'onlyprofit' | 'sharpe' | 'sortino' | 'calmar' | 'maxdrawdown' | 'profitdrawdown';
export type Space = 'buy' | 'sell' | 'roi' | 'trailing' | 'protection' | 'risk';
export const LOSSES: LossName[] = ['shortduration', 'onlyprofit', 'sharpe', 'sortino', 'calmar', 'maxdrawdown', 'profitdrawdown'];
export const SPACES: Space[] = ['buy', 'sell', 'roi', 'trailing', 'protection', 'risk'];

/** freqtrade's loss functions (lower is better). */
export function lossOf(name: LossName, s: Stats, minTrades: number): number {
  if (s.trades < minTrades) return 1e6 - s.trades;
  const profitRatio = s.profitPct / 100;
  switch (name) {
    case 'onlyprofit':
      return -profitRatio;
    case 'sharpe':
      return -(s.sharpe ?? -100);
    case 'sortino':
      return -(s.sortino ?? (s.profit > 0 ? 100 : -100));
    case 'calmar':
      return -(s.calmar ?? (s.profit > 0 ? 100 : -100));
    case 'maxdrawdown':
      return s.profit <= 0 ? 1000 - s.profitPct : s.maxDrawdownPct;
    case 'profitdrawdown':
      return -(profitRatio - (s.maxDrawdownPct / 100) * Math.abs(profitRatio));
    case 'shortduration':
    default: {
      // freqtrade's ShortTradeDurHyperOptLoss: many trades, high profit, short trades.
      const tradeLoss = 1 - 0.25 * Math.exp(-((s.trades - 600) ** 2) / 10 ** 5.8);
      const profitLoss = Math.max(0, 1 - profitRatio / 3);
      const durLoss = 0.4 * Math.min(s.avgDur / 60_000 / 300, 1);
      return tradeLoss + profitLoss + durLoss;
    }
  }
}

/** A small seeded random generator (mulberry32), so a run can be repeated. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Dim {
  key: string;
  space: Space;
  lo: number;
  hi: number;
  int?: boolean;
  bool?: boolean;
}
const DIMS: Dim[] = [
  { key: 'reversion', space: 'buy', lo: 0, hi: 1, bool: true },
  { key: 'zEntry', space: 'buy', lo: 0.6, hi: 3.5 },
  { key: 'maxLev', space: 'risk', lo: 1, hi: 50, int: true },
  { key: 'marginPct', space: 'risk', lo: 5, hi: 60, int: true },
  { key: 'tpAtr', space: 'sell', lo: 0.8, hi: 5 },
  { key: 'ratio', space: 'sell', lo: 1.5, hi: 6 },
  { key: 'timeStopMin', space: 'sell', lo: 5, hi: 180, int: true },
  { key: 'roi1m', space: 'roi', lo: 3, hi: 30, int: true },
  { key: 'roi1f', space: 'roi', lo: 0.3, hi: 0.95 },
  { key: 'roi2m', space: 'roi', lo: 5, hi: 60, int: true },
  { key: 'roi2f', space: 'roi', lo: 0.05, hi: 0.6 },
  { key: 'roi3m', space: 'roi', lo: 10, hi: 120, int: true },
  { key: 'trailing', space: 'trailing', lo: 0, hi: 1, bool: true },
  { key: 'trailOffset', space: 'trailing', lo: 0.2, hi: 1 },
  { key: 'trailDist', space: 'trailing', lo: 0.1, hi: 0.8 },
  { key: 'cooldownMin', space: 'protection', lo: 0, hi: 30, int: true },
  { key: 'sgLimit', space: 'protection', lo: 2, hi: 8, int: true },
  { key: 'sgStopMin', space: 'protection', lo: 10, hi: 180, int: true },
];

type Point = Record<string, number>;

function toSettings(base: RunSettings, pt: Point): RunSettings {
  const p = { ...base.params };
  const prot = structuredClone(base.protections);
  if ('zEntry' in pt) p.zEntry = +pt.zEntry.toFixed(3);
  if ('reversion' in pt) p.mode = pt.reversion >= 0.5 ? 'reversion' : 'momentum';
  if ('maxLev' in pt) p.maxLev = Math.round(pt.maxLev);
  if ('tpAtr' in pt) p.tpAtr = +pt.tpAtr.toFixed(3);
  if ('ratio' in pt) p.ratio = +pt.ratio.toFixed(2);
  if ('timeStopMin' in pt) p.timeStopMin = Math.round(pt.timeStopMin);
  if ('roi1m' in pt) {
    // Increasing minutes, shrinking targets; the last row is "any profit".
    const m1 = Math.round(pt.roi1m),
      m2 = m1 + Math.round(pt.roi2m),
      m3 = m2 + Math.round(pt.roi3m);
    const f1 = +pt.roi1f.toFixed(3),
      f2 = +Math.min(f1, pt.roi2f).toFixed(3);
    p.roi = true;
    p.roiTable = [
      [0, 1],
      [m1, f1],
      [m2, f2],
      [m3, 0],
    ];
  }
  if ('trailing' in pt) {
    p.trailing = pt.trailing >= 0.5;
    p.trailOffset = +pt.trailOffset.toFixed(3);
    p.trailDist = +pt.trailDist.toFixed(3);
  }
  if ('cooldownMin' in pt) {
    prot.cooldown = { on: pt.cooldownMin > 0, minutes: Math.round(pt.cooldownMin) };
    prot.stoplossGuard = { ...prot.stoplossGuard, on: true, tradeLimit: Math.round(pt.sgLimit), stopMin: Math.round(pt.sgStopMin) };
  }
  const marginPct = 'marginPct' in pt ? Math.round(pt.marginPct) : base.marginPct;
  return { ...base, marginPct, params: p, protections: prot, useProtections: base.useProtections || 'cooldownMin' in pt };
}

export interface Epoch {
  epoch: number;
  loss: number;
  trades: number;
  profit: number;
  profitPct: number;
  winrate: number;
  ddPct: number;
  avgDurMin: number;
  sharpe: number | null;
  params: Partial<Params>;
  protections?: ProtectionCfg;
  marginPct?: number;
}

export interface HyperoptOpts {
  epochs: number;
  loss: LossName;
  spaces: Space[];
  minTrades: number;
  seed: number;
}

/** Random search first, then mutations around the best few — a light stand-in for freqtrade's optuna sampler. */
export async function hyperopt(m: Market, base: RunSettings, o: HyperoptOpts, onEpoch: (e: Epoch, best: Epoch | null, i: number) => void | Promise<void>): Promise<{ epochs: Epoch[]; best: Epoch | null }> {
  const dims = DIMS.filter((d) => o.spaces.includes(d.space));
  const rand = rng(o.seed);
  const sample = (): Point => Object.fromEntries(dims.map((d) => [d.key, d.bool ? (rand() < 0.5 ? 0 : 1) : d.lo + rand() * (d.hi - d.lo)]));
  const mutate = (pt: Point): Point =>
    Object.fromEntries(
      dims.map((d) => {
        if (d.bool) return [d.key, rand() < 0.15 ? 1 - pt[d.key] : pt[d.key]];
        const v = pt[d.key] + (rand() + rand() + rand() - 1.5) * 0.25 * (d.hi - d.lo);
        return [d.key, Math.min(d.hi, Math.max(d.lo, v))];
      }),
    );
  const seen: { pt: Point; loss: number }[] = [];
  const epochs: Epoch[] = [];
  let best: Epoch | null = null;
  const warm = Math.max(10, Math.round(o.epochs * 0.3));
  for (let i = 0; i < o.epochs; i++) {
    let pt: Point;
    if (i === 0) pt = Object.fromEntries(dims.map((d) => [d.key, currentValue(base, d)]));
    else if (i < warm || rand() < 0.3) pt = sample();
    else {
      const top = [...seen].sort((a, b) => a.loss - b.loss).slice(0, 5);
      pt = mutate(top[Math.floor(rand() * top.length)].pt);
    }
    const rs = toSettings(base, pt);
    const r = simulate(m, rs, { light: true });
    const loss = lossOf(o.loss, r.stats, o.minTrades);
    seen.push({ pt, loss });
    const e: Epoch = {
      epoch: i + 1,
      loss: +loss.toFixed(5),
      trades: r.stats.trades,
      profit: r.stats.profit,
      profitPct: r.stats.profitPct,
      winrate: r.stats.winrate,
      ddPct: r.stats.maxDrawdownPct,
      avgDurMin: +(r.stats.avgDur / 60_000).toFixed(1),
      sharpe: r.stats.sharpe,
      params: pick(rs.params, dims),
      protections: o.spaces.includes('protection') ? rs.protections : undefined,
      marginPct: o.spaces.includes('risk') ? rs.marginPct : undefined,
    };
    epochs.push(e);
    if (!best || e.loss < best.loss) best = e;
    await onEpoch(e, best, i);
  }
  return { epochs, best };
}

function currentValue(base: RunSettings, d: Dim): number {
  const p = base.params;
  const t = p.roiTable;
  const v: Record<string, number> = {
    reversion: p.mode === 'reversion' ? 1 : 0,
    zEntry: p.zEntry,
    maxLev: p.maxLev,
    marginPct: base.marginPct,
    tpAtr: p.tpAtr,
    ratio: p.ratio,
    timeStopMin: p.timeStopMin,
    roi1m: t[1]?.[0] ?? 10,
    roi1f: t[1]?.[1] ?? 0.6,
    roi2m: (t[2]?.[0] ?? 20) - (t[1]?.[0] ?? 10),
    roi2f: t[2]?.[1] ?? 0.3,
    roi3m: 30,
    trailing: p.trailing ? 1 : 0,
    trailOffset: p.trailOffset,
    trailDist: p.trailDist,
    cooldownMin: base.protections.cooldown.on ? base.protections.cooldown.minutes : 0,
    sgLimit: base.protections.stoplossGuard.tradeLimit,
    sgStopMin: base.protections.stoplossGuard.stopMin,
  };
  return Math.min(d.hi, Math.max(d.lo, v[d.key]));
}

function pick(p: Params, dims: Dim[]): Partial<Params> {
  const out: Partial<Params> = {};
  const sp = new Set(dims.map((d) => d.space));
  if (sp.has('buy')) Object.assign(out, { mode: p.mode, zEntry: p.zEntry });
  if (sp.has('risk')) out.maxLev = p.maxLev;
  if (sp.has('sell')) Object.assign(out, { tpAtr: p.tpAtr, ratio: p.ratio, timeStopMin: p.timeStopMin });
  if (sp.has('roi')) Object.assign(out, { roi: p.roi, roiTable: p.roiTable });
  if (sp.has('trailing')) Object.assign(out, { trailing: p.trailing, trailOffset: p.trailOffset, trailDist: p.trailDist });
  return out;
}
