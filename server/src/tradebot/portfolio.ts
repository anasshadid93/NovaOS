import { lossOf, rng, type BacktestResult, type Epoch, type HyperoptOpts, type RunSettings } from './backtest.js';
import { computeStats, monteCarlo } from './stats.js';
import { closeTrade, sleeveWeights, type Closed, type Params, type Position, type SleeveKind } from './strategy.js';
import { annVol, channels, trendTarget, trendWeight, type Bar } from './trend.js';

/**
 * The tested strategies as sleeves of one balance — trend breakout (Donchian), EMA trend, time-series
 * momentum, cross-sectional momentum (rank the coins) and funding carry — alone or mixed (see the
 * research in var/research). Backtests replay hourly history; each sleeve decides at the close of its
 * own bars and fills at the next hour's open. The live engine uses the same `sleeveTargets`.
 */

const H = 3600_000;
const D = 24 * H;
export const SLEEVE_TF: Record<SleeveKind, (p: Params) => number> = {
  donchian: (p) => p.trend.tf,
  ema: (p) => p.ema.tf,
  tsmom: () => 24,
  xsmom: () => 24,
  carry: () => 8,
};
export const SLEEVE_LABEL: Record<SleeveKind, string> = { donchian: 'Trend breakout', ema: 'EMA trend', tsmom: 'Momentum', xsmom: 'Coin ranking', carry: 'Funding carry' };

export function emaSeries(c: number[], n: number): number[] {
  const k = 2 / (n + 1);
  const o: number[] = [];
  let e = c[0];
  for (const v of c) {
    e = v * k + e * (1 - k);
    o.push(e);
  }
  return o;
}

/** The average funding rate per 8 h over the last `days` before `t`, as a yearly %. */
export function fundingAPR(funding: [number, number][], t: number, days: number): number | null {
  let s = 0,
    n = 0;
  for (let i = funding.length - 1; i >= 0; i--) {
    const [ft, r] = funding[i];
    if (ft > t) continue;
    if (ft <= t - days * D) break;
    s += r;
    n++;
  }
  return n ? (s / n) * 3 * 365 * 100 : null;
}

/**
 * One coin's target in a per-coin sleeve after bar i closes: 1 long, −1 short, 0 flat
 * (carry: −1 = short perp, hedged). `ema` is the bars' EMA, computed once by the caller.
 */
export function coinTarget(kind: SleeveKind, b: Bar[], i: number, pos: number, p: Params, ctx: { ema?: number[]; funding?: [number, number][] } = {}): -1 | 0 | 1 {
  switch (kind) {
    case 'donchian':
      return trendTarget(b, i, pos, p.trend);
    case 'ema': {
      const e = ctx.ema;
      if (!e || i < p.ema.n) return 0;
      if (b[i].c > e[i] * (1 + p.ema.band)) return 1;
      if (b[i].c < e[i] * (1 - p.ema.band)) return p.ema.shorts ? -1 : 0;
      return pos > 0 ? 1 : pos < 0 ? -1 : 0;
    }
    case 'tsmom': {
      if (i < p.tsmom.L) return 0;
      const m = b[i].c / b[i - p.tsmom.L].c - 1;
      return m > 0 ? 1 : p.tsmom.shorts ? -1 : 0;
    }
    case 'carry': {
      const apr = fundingAPR(ctx.funding ?? [], b[i].t + 8 * H, p.carry.lookDays);
      return apr !== null && apr > p.carry.thrAPR ? -1 : 0;
    }
    default:
      return 0;
  }
}

/** Coin ranking: the targets of every coin on a rebalance day (index of each coin's daily bar). */
export function rankTargets(daily: Record<string, Bar[]>, at: Record<string, number>, p: Params): Record<string, -1 | 0 | 1> {
  const { L, K, longOnly } = p.xsmom;
  const ranked = Object.entries(at)
    .filter(([s, i]) => i >= L && daily[s][i])
    .map(([s, i]) => ({ s, m: daily[s][i].c / daily[s][i - L].c - 1 }))
    .sort((a, b) => b.m - a.m);
  const out: Record<string, -1 | 0 | 1> = Object.fromEntries(Object.keys(at).map((s) => [s, 0]));
  if (ranked.length < 2 * K) return out;
  for (const x of ranked.slice(0, K)) out[x.s] = 1;
  if (!longOnly) for (const x of ranked.slice(-K)) out[x.s] = -1;
  return out;
}

/** Is this daily bar a rebalance day for coin ranking? (Absolute day number, so live = backtest.) */
export const isRebalanceDay = (barStart: number, everyDays: number) => Math.floor(barStart / D) % everyDays === 0;

/** Capital per position of a sleeve, and its notional multiple. */
export function sleeveSizing(kind: SleeveKind, p: Params, balance: number, weight: number, nCoins: number, vol: number | null): { alloc: number; w: number } {
  switch (kind) {
    case 'xsmom': {
      const share = p.xsmom.longOnly ? 1 / p.xsmom.K : 0.5 / p.xsmom.K;
      return { alloc: balance * weight * share, w: 1 };
    }
    case 'carry':
      return { alloc: (balance * weight) / Math.max(1, nCoins), w: 0.8 };
    default:
      return { alloc: (balance * weight) / Math.max(1, nCoins), w: trendWeight(vol, p.trend) };
  }
}

/** Opens a sleeve position: a market order; carry is a hedged short (perp + spot fees, both legs). */
export function openSleeve(kind: SleeveKind, o: { alloc: number; id: number }, sym: string, side: 'LONG' | 'SHORT', price: number, w: number, exit: number | null, p: Params, now: number): Position | null {
  const dir = side === 'LONG' ? 1 : -1;
  const slip = p.slippageBps / 10_000;
  const margin = +o.alloc.toFixed(2);
  if (!(margin >= 1) || !(w > 0)) return null;
  const size = margin * w;
  const hedged = kind === 'carry';
  const entry = hedged ? price : price * (1 + dir * slip);
  // Carry pays perp and spot fees and slippage on both legs, in and out; the perp exit fee comes at the close.
  const fees = hedged ? size * (p.feeTaker + p.carry.spotFee + 2 * slip + p.carry.spotFee + slip) : size * p.feeTaker;
  return {
    id: o.id,
    sym,
    side,
    lev: Math.max(1, Math.ceil(w)),
    entry,
    tp: entry * (1 + dir * 0.2),
    sl: exit ?? entry * (1 - dir * 0.1),
    liq: hedged ? (side === 'SHORT' ? entry * 100 : 0) : entry * (1 - (dir * 0.9) / Math.max(1, w)),
    margin,
    size,
    openedAt: now,
    tpDist: 0.2,
    peak: entry,
    trailing: false,
    fees: +fees.toFixed(6),
    funding: 0,
    tag: kind,
    hedged,
  };
}

/** One coin's hourly history as compact columns (NaN where an hour is missing) plus funding per hour. */
interface Col {
  t0: number;
  n: number;
  o: Float64Array;
  h: Float64Array;
  l: Float64Array;
  c: Float64Array;
  f: Float64Array;
}
interface Cache {
  col: Record<string, Col>;
  /** bars per timeframe: contiguous (an empty slot repeats the last close), so index = (start − first) / length */
  bars: Map<number, Record<string, Bar[]>>;
}
const caches = new WeakMap<MarketData, Cache>();
function columns(rows: number[][], funding: [number, number][]): Col {
  const t0 = rows[0][0];
  const n = Math.round((rows.at(-1)![0] - t0) / H) + 1;
  const mk = () => new Float64Array(n).fill(NaN);
  const col: Col = { t0, n, o: mk(), h: mk(), l: mk(), c: mk(), f: new Float64Array(n) };
  for (const r of rows) {
    const i = Math.round((r[0] - t0) / H);
    col.o[i] = r[1];
    col.h[i] = r[2];
    col.l[i] = r[3];
    col.c[i] = r[4];
  }
  for (const [t, r] of funding) {
    const i = Math.floor((t - t0) / H);
    if (i >= 0 && i < n) col.f[i] += r;
  }
  return col;
}
function barsOf(col: Col, tf: number): Bar[] {
  const tfMs = tf * H;
  const out: Bar[] = [];
  const first = Math.floor(col.t0 / tfMs) * tfMs;
  let prev = NaN;
  for (let bt = first; bt < col.t0 + col.n * H; bt += tfMs) {
    let o = NaN,
      h = -Infinity,
      l = Infinity,
      c = NaN,
      f = 0;
    for (let t = bt; t < bt + tfMs; t += H) {
      const i = (t - col.t0) / H;
      if (i < 0 || i >= col.n) continue;
      f += col.f[i];
      if (Number.isNaN(col.c[i])) continue;
      if (Number.isNaN(o)) o = col.o[i];
      h = Math.max(h, col.h[i]);
      l = Math.min(l, col.l[i]);
      c = col.c[i];
    }
    if (Number.isNaN(c)) {
      if (Number.isNaN(prev)) continue; // before the coin was listed
      o = h = l = c = prev;
    }
    prev = c;
    out.push({ t: bt, o, h, l, c, f });
  }
  return out;
}
function cacheOf(md: MarketData): Cache {
  let c = caches.get(md);
  if (!c) {
    const col: Record<string, Col> = {};
    for (const s of Object.keys(md.rows)) if (md.rows[s]?.length) col[s] = columns(md.rows[s], md.funding[s] ?? []);
    c = { col, bars: new Map() };
    caches.set(md, c);
  }
  return c;
}
/** Builds the compact copy now and lets the bulky rows go (the worker calls this before long jobs). */
export function compactMarket(md: MarketData) {
  cacheOf(md);
  for (const s of Object.keys(md.rows)) md.rows[s] = [];
}

export interface MarketData {
  /** hourly rows per coin: [t, o, h, l, c, quoteVol] */
  rows: Record<string, number[][]>;
  funding: Record<string, [number, number][]>;
}

/**
 * Replays [from, to) hour by hour. Bars before `from` only warm the signals up. Sleeves follow
 * `sleeveWeights(params)`; each position's capital is fixed at entry from the balance then.
 */
export function simulatePortfolio(md: MarketData, rs: RunSettings, opts: { from: number; to?: number; light?: boolean; start?: number }): BacktestResult & { perSleeve: Record<string, number> } {
  const p = rs.params;
  const weights = sleeveWeights(p);
  const kinds = Object.keys(weights) as SleeveKind[];
  // Bars per timeframe (cached per data set: hyperopt and walk-forward replay the same data often).
  // Bars after `to` exist in the cache but are never reached: the loop stops at `to`.
  const c = cacheOf(md);
  const syms = p.pairs.filter((s) => c.col[s]);
  const to = opts.to ?? Math.max(...syms.map((s) => c.col[s].t0 + c.col[s].n * H));
  const bars = (tf: number) => {
    let b = c.bars.get(tf);
    if (!b) c.bars.set(tf, (b = Object.fromEntries(Object.keys(c.col).map((s) => [s, barsOf(c.col[s], tf)]))));
    return b;
  };
  /** Index of the bar starting at `start` (bars are contiguous). */
  const barAt = (tf: number, s: string, start: number): number | undefined => {
    const b = bars(tf)[s];
    if (!b.length) return undefined;
    const i = (start - b[0].t) / (tf * H);
    return i >= 0 && i < b.length && b[i].t === start ? i : undefined;
  };
  const emas: Record<string, number[]> = {};
  // EMAs are cheap and hyperopt tries many lengths: computed per run, never cached (a cache grew without bound).
  if (kinds.includes('ema')) for (const s of syms) emas[s] = emaSeries(bars(p.ema.tf)[s].map((x) => x.c), p.ema.n);
  for (const k of kinds) bars(SLEEVE_TF[k](p));
  let balance = opts.start ?? rs.start;
  const start = balance;
  let id = 1;
  const open = new Map<string, Position>(); // `${kind}:${sym}`
  const pending = new Map<string, number>();
  const closed: Closed[] = [];
  const equity: [number, number][] = [];
  const perSleeve: Record<string, number> = Object.fromEntries(kinds.map((k) => [k, 0]));
  const close = (key: string, why: 'TREND' | 'LIQ' | 'FORCE', at: number, t: number) => {
    const pos = open.get(key)!;
    const tr = closeTrade(pos, { why, at, maker: false }, balance, p, t);
    balance = Math.max(0, balance + tr.pnl);
    perSleeve[pos.tag] = (perSleeve[pos.tag] ?? 0) + tr.pnl;
    closed.push(tr);
    open.delete(key);
  };
  const lastRow: Record<string, number[]> = {}; // [t, o, h, l, c]
  for (let t = Math.floor(opts.from / H) * H; t < to; t += H) {
    for (const s of syms) {
      const col = c.col[s];
      const ri = (t - col.t0) / H;
      if (ri < 0 || ri >= col.n || Number.isNaN(col.c[ri])) continue;
      const r = [t, col.o[ri], col.h[ri], col.l[ri], col.c[ri]];
      lastRow[s] = r;
      // 1. Orders decided at the last close fill at this hour's open.
      for (const k of kinds) {
        const key = `${k}:${s}`;
        if (!pending.has(key)) continue;
        const tgt = pending.get(key)!;
        pending.delete(key);
        const pos = open.get(key);
        const cur = pos ? (pos.side === 'LONG' ? 1 : -1) : 0;
        if (tgt === cur) continue;
        if (pos) close(key, 'TREND', r[1], t);
        if (tgt !== 0 && balance > 1) {
          const tf = SLEEVE_TF[k](p);
          const b = bars(tf)[s];
          const bi = barAt(tf, s, Math.floor(t / (tf * H)) * tf * H - tf * H);
          const vol = bi !== undefined ? annVol(b, bi, tf) : null;
          const size = sleeveSizing(k, p, balance, weights[k]!, syms.length, k === 'xsmom' || k === 'carry' ? null : vol);
          const ch = k === 'donchian' && bi !== undefined ? channels(b, bi, p.trend) : null;
          const np = openSleeve(k, { alloc: size.alloc, id: id++ }, s, tgt > 0 ? 'LONG' : 'SHORT', r[1], size.w, ch ? (tgt > 0 ? ch.exit : ch.shortExit) : null, p, t);
          if (np) open.set(key, np);
        }
      }
      // 2. Funding paid inside this hour; liquidations.
      for (const k of kinds) {
        const key = `${k}:${s}`;
        const pos = open.get(key);
        if (!pos) continue;
        const f = col.f[ri];
        if (f && p.funding) pos.funding += -(pos.side === 'LONG' ? 1 : -1) * pos.size * (pos.hedged ? 1 : r[4] / pos.entry) * f;
        if (!pos.hedged && (pos.side === 'LONG' ? r[3] <= pos.liq : r[2] >= pos.liq)) close(key, 'LIQ', pos.liq, t + H);
      }
      // 3. Bars that close at the end of this hour: decide.
      for (const k of kinds) {
        if (k === 'xsmom') continue;
        const tf = SLEEVE_TF[k](p);
        const barStart = Math.floor(t / (tf * H)) * tf * H;
        if (t + H !== barStart + tf * H) continue;
        const bi = barAt(tf, s, barStart);
        if (bi === undefined) continue;
        const key = `${k}:${s}`;
        const pos = open.get(key);
        const cur = pos ? (pos.side === 'LONG' ? 1 : -1) : 0;
        const tgt = coinTarget(k, bars(tf)[s], bi, cur, p, { ema: emas[s], funding: md.funding[s] });
        if (tgt !== cur) pending.set(key, tgt);
        if (k === 'donchian' && pos) {
          const ch = channels(bars(tf)[s], bi, p.trend);
          if (ch) pos.sl = pos.side === 'LONG' ? ch.exit : ch.shortExit;
        }
      }
    }
    // Coin ranking: at a day's close, every N days.
    if (kinds.includes('xsmom') && (t + H) % D === 0 && isRebalanceDay(t + H - D, p.xsmom.everyDays)) {
      const daily = bars(24);
      const at: Record<string, number> = {};
      for (const s of syms) {
        const i = barAt(24, s, t + H - D);
        if (i !== undefined) at[s] = i;
      }
      const targets = rankTargets(daily, at, p);
      for (const s of syms) {
        const key = `xsmom:${s}`;
        const pos = open.get(key);
        const cur = pos ? (pos.side === 'LONG' ? 1 : -1) : 0;
        const tgt = targets[s] ?? 0;
        if (tgt !== cur) pending.set(key, tgt);
      }
    }
    if (!opts.light && (t + H) % (4 * H) === 0) {
      let unreal = 0;
      for (const pos of open.values()) {
        const r = lastRow[pos.sym];
        const c = r ? r[4] : pos.entry;
        unreal += (pos.hedged ? 0 : pos.size * (pos.side === 'LONG' ? 1 : -1) * (c / pos.entry - 1)) - pos.fees + pos.funding;
      }
      equity.push([t + H, +(balance + unreal).toFixed(4)]);
    }
  }
  const openAtEnd = open.size;
  for (const [key, pos] of [...open.entries()]) close(key, 'FORCE', lastRow[pos.sym]?.[4] ?? pos.entry, to);
  if (!opts.light) equity.push([to, +balance.toFixed(4)]);
  const marketChange: Record<string, number> = {};
  for (const s of syms) {
    const col = c.col[s];
    let a: number | undefined;
    for (let i = Math.max(0, Math.ceil((opts.from - col.t0) / H)); i < col.n && a === undefined; i++) if (!Number.isNaN(col.o[i])) a = col.o[i];
    const z = lastRow[s]?.[4];
    if (a && z) marketChange[s] = +((z / a - 1) * 100).toFixed(2);
  }
  const mc = Object.values(marketChange);
  const desc = closed.slice().reverse();
  const step = Math.max(1, Math.ceil(equity.length / 400));
  return {
    from: opts.from,
    to,
    start,
    final: +balance.toFixed(4),
    stats: computeStats(desc, start, { from: opts.from, to }),
    closed: opts.light ? [] : desc.slice(0, 500),
    equity: opts.light ? [] : [...equity.filter((_, i) => i % step === 0), ...(equity.length ? [equity.at(-1)!] : [])],
    marketChange,
    marketAvg: mc.length ? +(mc.reduce((x, v) => x + v, 0) / mc.length).toFixed(2) : 0,
    locks: [],
    openAtEnd,
    stoppedEarly: false,
    monteCarlo: opts.light ? null : monteCarlo(desc),
    perSleeve: Object.fromEntries(Object.entries(perSleeve).map(([k, v]) => [k, +v.toFixed(4)])),
  };
}

// ---- hyperopt / walk-forward ------------------------------------------------------------------
type Dim = { get: (p: Params) => number; set: (p: Params, v: number) => void; lo: number; hi: number; int?: boolean; pick?: number[] };
/** The searchable numbers of the sleeves a strategy runs (and the mix weights). */
export function dimsFor(p: Params): Dim[] {
  const k = Object.keys(sleeveWeights(p)) as SleeveKind[];
  const d: Dim[] = [];
  if (k.includes('donchian'))
    d.push(
      { get: (x) => x.trend.tf, set: (x, v) => void (x.trend.tf = v), lo: 0, hi: 0, pick: [2, 4, 8, 12, 24] },
      { get: (x) => x.trend.N, set: (x, v) => void (x.trend.N = v), lo: 20, hi: 220, int: true },
      { get: (x) => x.trend.M, set: (x, v) => void (x.trend.M = Math.min(v, x.trend.N - 1)), lo: 3, hi: 80, int: true },
    );
  if (k.includes('ema')) d.push({ get: (x) => x.ema.tf, set: (x, v) => void (x.ema.tf = v), lo: 0, hi: 0, pick: [4, 8, 24] }, { get: (x) => x.ema.n, set: (x, v) => void (x.ema.n = v), lo: 20, hi: 300, int: true });
  if (k.includes('tsmom')) d.push({ get: (x) => x.tsmom.L, set: (x, v) => void (x.tsmom.L = v), lo: 3, hi: 120, int: true });
  if (k.includes('xsmom')) d.push({ get: (x) => x.xsmom.L, set: (x, v) => void (x.xsmom.L = v), lo: 3, hi: 90, int: true }, { get: (x) => x.xsmom.K, set: (x, v) => void (x.xsmom.K = v), lo: 1, hi: 3, int: true });
  if (k.includes('carry')) d.push({ get: (x) => x.carry.thrAPR, set: (x, v) => void (x.carry.thrAPR = v), lo: 2, hi: 40 }, { get: (x) => x.carry.lookDays, set: (x, v) => void (x.carry.lookDays = v), lo: 1, hi: 14, int: true });
  if (p.strategy !== 'carry' && k.some((x) => x !== 'carry' && x !== 'xsmom')) d.push({ get: (x) => x.trend.volTarget, set: (x, v) => void (x.trend.volTarget = v), lo: 0.2, hi: 1.2 });
  if (p.strategy === 'mix') for (const s of k) d.push({ get: (x) => x.mix[s], set: (x, v) => void (x.mix[s] = v), lo: 0.05, hi: 1 });
  return d;
}

function setDim(d: Dim, p: Params, v: number) {
  const x = d.pick ? d.pick[Math.max(0, Math.min(d.pick.length - 1, Math.round(v)))] : d.int ? Math.round(v) : +v.toFixed(3);
  d.set(p, x);
}

/** Random search, then mutations around the best few (as for the scalp hyperopt). */
export async function hyperoptPortfolio(
  md: MarketData,
  base: RunSettings,
  o: HyperoptOpts,
  range: { from: number; to: number },
  onEpoch: (e: Epoch, best: Epoch | null, i: number) => void | Promise<void> = () => {},
): Promise<{ epochs: Epoch[]; best: Epoch | null }> {
  const rand = rng(o.seed);
  const dims = dimsFor(base.params);
  const span = (d: Dim) => (d.pick ? d.pick.length - 1 : d.hi - d.lo);
  const lo = (d: Dim) => (d.pick ? 0 : d.lo);
  const cur = (p: Params) => dims.map((d) => (d.pick ? Math.max(0, d.pick.indexOf(d.get(p))) : d.get(p)));
  const seen: { v: number[]; loss: number }[] = [];
  const epochs: Epoch[] = [];
  let best: Epoch | null = null;
  const warm = Math.max(8, Math.round(o.epochs * 0.3));
  for (let i = 0; i < o.epochs; i++) {
    let v: number[];
    if (i === 0) v = cur(base.params);
    else if (i < warm || rand() < 0.3) v = dims.map((d) => lo(d) + rand() * span(d));
    else {
      const top = [...seen].sort((a, b) => a.loss - b.loss).slice(0, 5);
      v = top[Math.floor(rand() * top.length)].v.map((x, j) => Math.min(lo(dims[j]) + span(dims[j]), Math.max(lo(dims[j]), x + (rand() + rand() + rand() - 1.5) * 0.25 * span(dims[j]))));
    }
    const params: Params = structuredClone(base.params);
    dims.forEach((d, j) => setDim(d, params, v[j]));
    const r = simulatePortfolio(md, { ...base, params }, { from: range.from, to: range.to, light: true });
    const loss = lossOf(o.loss, r.stats, o.minTrades);
    seen.push({ v, loss });
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
      params: { trend: params.trend, ema: params.ema, tsmom: params.tsmom, xsmom: params.xsmom, carry: params.carry, mix: params.mix },
    };
    epochs.push(e);
    if (!best || e.loss < best.loss) best = e;
    await onEpoch(e, best, i);
  }
  return { epochs, best };
}

export interface WalkWindow {
  trainFrom: number;
  testFrom: number;
  testTo: number;
  params: Partial<Params>;
  trainProfitPct: number;
  testProfitPct: number;
  testTrades: number;
}

/**
 * Walk-forward: pick settings on a training window (hyperopt), trade the next window with them,
 * roll forward, repeat. Only the test windows count — every result comes from settings chosen
 * before that data existed.
 */
export async function walkForward(
  md: MarketData,
  base: RunSettings,
  o: { from: number; to: number; trainDays: number; testDays: number; epochs: number; loss: HyperoptOpts['loss']; minTrades: number; seed: number },
  onWindow: (done: number, total: number) => void | Promise<void> = () => {},
) {
  const windows: WalkWindow[] = [];
  const closed: Closed[] = [];
  const equity: [number, number][] = [];
  let balance = base.start;
  const total = Math.max(0, Math.floor((o.to - o.from - o.trainDays * D) / (o.testDays * D)));
  for (let w = 0; w < total; w++) {
    const trainFrom = o.from + w * o.testDays * D;
    const testFrom = trainFrom + o.trainDays * D;
    const testTo = Math.min(o.to, testFrom + o.testDays * D);
    const ho = await hyperoptPortfolio(md, base, { epochs: o.epochs, loss: o.loss, spaces: [], minTrades: o.minTrades, seed: o.seed + w }, { from: trainFrom, to: testFrom });
    const params: Params = { ...structuredClone(base.params), ...(ho.best?.params ?? {}) } as Params;
    const r = simulatePortfolio(md, { ...base, params }, { from: testFrom, to: testTo, start: balance });
    windows.push({ trainFrom, testFrom, testTo, params: ho.best?.params ?? {}, trainProfitPct: ho.best?.profitPct ?? 0, testProfitPct: r.stats.profitPct, testTrades: r.stats.trades });
    closed.push(...r.closed.slice().reverse());
    equity.push(...r.equity);
    balance = r.final;
    await onWindow(w + 1, total);
  }
  const from = windows[0]?.testFrom ?? o.from;
  const to = windows.at(-1)?.testTo ?? o.to;
  const step = Math.max(1, Math.ceil(equity.length / 400));
  return {
    windows,
    from,
    to,
    start: base.start,
    final: +balance.toFixed(4),
    stats: computeStats(closed.slice().reverse(), base.start, { from, to }),
    equity: equity.filter((_, i) => i % step === 0),
    closed: closed.slice().reverse().slice(0, 300),
    monteCarlo: monteCarlo(closed.slice().reverse()),
  };
}
