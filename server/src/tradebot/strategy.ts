/**
 * Trade Bot strategy — the pure pieces shared by the live engine and the backtester, so a backtest
 * trades exactly like the bot does. Ideas taken from freqtrade (github.com/freqtrade/freqtrade):
 * a minimal-ROI table, a trailing stop, separate maker/taker fees, slippage, funding fees, several
 * open trades at once, a volume pairlist and a pessimistic exit order inside one candle.
 * Paper money only: nothing here talks to an exchange.
 */

export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** quote volume (USDT) of the minute */
  v: number;
  closed: boolean;
}

/** Max leverage per coin, and the coins the bot may trade. */
export const COINS: Record<string, number> = { BTC: 50, ETH: 40, SOL: 25, AVAX: 20, SUI: 20, BNB: 25, XRP: 25, DOGE: 20, LINK: 20, ADA: 20 };
export const ALL_SYMS = Object.keys(COINS);

/** Trend following (Donchian breakout) — the strategy with a tested edge (see trend.ts). */
export interface TrendParams {
  /** bar length in hours (Binance intervals: 1, 2, 4, 6, 8, 12, 24) */
  tf: number;
  /** enter on a close above the highest high of the last N bars */
  N: number;
  /** leave on a close below the lowest low of the last M bars */
  M: number;
  /** size each coin so its yearly volatility is about this (0.5 = 50%) */
  volTarget: number;
  /** most notional per coin, × its share of the balance */
  maxW: number;
  /** also short breakdowns (tested worse; off by default) */
  shorts: boolean;
}
export const DEFAULT_TREND: TrendParams = { tf: 4, N: 100, M: 10, volTarget: 0.5, maxW: 2, shorts: false };

/** The other tested strategies (portfolio.ts runs them, alone or mixed). */
export interface EmaParams {
  tf: number;
  /** long while the close is above the EMA(n) by more than `band`, flat (or short) below it */
  n: number;
  band: number;
  shorts: boolean;
}
export interface TsmomParams {
  /** long when the last L days went up (daily bars) */
  L: number;
  shorts: boolean;
}
export interface XsmomParams {
  /** rank the coins by their last L days; long the K strongest (and short the K weakest) */
  L: number;
  K: number;
  longOnly: boolean;
  /** rebalance every N days */
  everyDays: number;
}
export interface CarryParams {
  /** short the perp + hold the coin (no price risk) while funding pays more than this a year */
  thrAPR: number;
  /** average funding over the last N days */
  lookDays: number;
  /** spot trading fee for the hedge leg */
  spotFee: number;
}
export type SleeveKind = 'donchian' | 'ema' | 'tsmom' | 'xsmom' | 'carry';
export const SLEEVES: SleeveKind[] = ['donchian', 'ema', 'tsmom', 'xsmom', 'carry'];
export type StrategyName = 'scalp' | 'trend' | 'ema' | 'tsmom' | 'xsmom' | 'carry' | 'mix';
export const DEFAULT_EMA: EmaParams = { tf: 4, n: 200, band: 0.01, shorts: false };
export const DEFAULT_TSMOM: TsmomParams = { L: 7, shorts: false };
export const DEFAULT_XSMOM: XsmomParams = { L: 14, K: 2, longOnly: false, everyDays: 7 };
export const DEFAULT_CARRY: CarryParams = { thrAPR: 10, lookDays: 7, spotFee: 0.001 };
/** Chosen on 2020–23 (Sharpe 2.39), judged on 2024–26: +22 %/yr, Sharpe 1.43, max drop 11 %. */
export const DEFAULT_MIX: Record<SleeveKind, number> = { donchian: 0.4, ema: 0.2, tsmom: 0, xsmom: 0.2, carry: 0.2 };

/** The sleeves a strategy runs and their share of the balance. */
export function sleeveWeights(p: Pick<Params, 'strategy' | 'mix'>): Partial<Record<SleeveKind, number>> {
  switch (p.strategy) {
    case 'trend':
      return { donchian: 1 };
    case 'ema':
    case 'tsmom':
    case 'xsmom':
    case 'carry':
      return { [p.strategy]: 1 };
    case 'mix': {
      const sum = SLEEVES.reduce((s, k) => s + Math.max(0, p.mix[k] ?? 0), 0) || 1;
      return Object.fromEntries(SLEEVES.filter((k) => (p.mix[k] ?? 0) > 0).map((k) => [k, +(p.mix[k] / sum).toFixed(4)]));
    }
    default:
      return {};
  }
}
const TFS = [1, 2, 4, 6, 8, 12, 24];

export interface Params {
  /** scalp: the 1-minute signal; trend: Donchian breakout; ema/tsmom/xsmom/carry: the other tested ones; mix: several at once */
  strategy: StrategyName;
  trend: TrendParams;
  ema: EmaParams;
  tsmom: TsmomParams;
  xsmom: XsmomParams;
  carry: CarryParams;
  /** mix: each sleeve's share of the balance */
  mix: Record<SleeveKind, number>;
  /** momentum: follow a sharp move; reversion: bet on it snapping back */
  mode: 'momentum' | 'reversion';
  /** entry: the 5-minute move against its own volatility must reach this (z-score) */
  zEntry: number;
  /** leverage cap on top of each coin's own cap (freqtrade's leverage callback) */
  maxLev: number;
  /** take-profit distance = max(minTp, tpAtr × ATR) */
  tpAtr: number;
  minTp: number;
  /** stop distance = TP distance / ratio */
  ratio: number;
  /** close a trade after this many minutes */
  timeStopMin: number;
  /** trailing stop: starts once the move reaches trailOffset × TP distance, trails at trailDist × TP distance */
  trailing: boolean;
  trailOffset: number;
  trailDist: number;
  /** minimal ROI: [minutes open, share of the TP distance] — after N minutes a smaller profit is enough */
  roi: boolean;
  roiTable: [number, number][];
  /** how many trades may be open at once */
  maxOpen: number;
  feeTaker: number;
  feeMaker: number;
  /** slippage on market orders (entries, stops, ROI, time), in basis points */
  slippageBps: number;
  funding: boolean;
  /** pairs the bot may trade */
  pairs: string[];
  /** VolumePairList: only the N pairs (of `pairs`) with the most 24h volume; 0 = off */
  volumeTopN: number;
}

export interface Position {
  id: number;
  sym: string;
  side: 'LONG' | 'SHORT';
  lev: number;
  entry: number;
  tp: number;
  sl: number;
  liq: number;
  margin: number;
  size: number;
  openedAt: number;
  /** TP distance as a share of the entry price */
  tpDist: number;
  /** best price reached so far (for the trailing stop) */
  peak: number;
  trailing: boolean;
  fees: number;
  funding: number;
  tag: string;
  /** funding carry: short perp + the coin held, so price moves cancel out */
  hedged?: boolean;
}

export interface Closed {
  id: number;
  sym: string;
  side: 'LONG' | 'SHORT';
  lev: number;
  entry: number;
  exit: number;
  pnl: number;
  pct: number;
  balPct: number;
  why: ExitWhy;
  at: number;
  openedAt: number;
  dur: number;
  margin: number;
  fees: number;
  funding: number;
  tag: string;
}

export type ExitWhy = 'TP' | 'SL' | 'TRAIL' | 'ROI' | 'TIME' | 'LIQ' | 'FORCE' | 'TREND';

export const DEFAULT_PARAMS: Params = {
  strategy: 'scalp',
  trend: DEFAULT_TREND,
  ema: DEFAULT_EMA,
  tsmom: DEFAULT_TSMOM,
  xsmom: DEFAULT_XSMOM,
  carry: DEFAULT_CARRY,
  mix: DEFAULT_MIX,
  mode: 'momentum',
  zEntry: 1.25,
  maxLev: 50,
  tpAtr: 2.2,
  minTp: 0.0035,
  ratio: 5,
  timeStopMin: 30,
  trailing: false,
  trailOffset: 0.6,
  trailDist: 0.3,
  roi: false,
  roiTable: [
    [0, 1],
    [10, 0.6],
    [20, 0.3],
  ],
  maxOpen: 1,
  feeTaker: 0.0005,
  feeMaker: 0.0002,
  slippageBps: 2,
  funding: true,
  pairs: ['BTC', 'ETH', 'SOL', 'AVAX', 'SUI'],
  volumeTopN: 0,
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const num = (v: unknown, d: number, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : d);
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);

/** Settings from the page (or a hyperopt result) kept inside safe ranges. */
export function cleanParams(p: Partial<Params> = {}, base: Params = DEFAULT_PARAMS): Params {
  const pairs = Array.isArray(p.pairs) ? [...new Set(p.pairs.filter((s): s is string => typeof s === 'string' && s in COINS))] : base.pairs;
  const table = Array.isArray(p.roiTable)
    ? p.roiTable
        .filter((r): r is [number, number] => Array.isArray(r) && r.length === 2 && r.every((x) => typeof x === 'number' && Number.isFinite(x)))
        .map(([m, f]) => [Math.round(clamp(m, 0, 1440)), +clamp(f, 0, 1).toFixed(3)] as [number, number])
        .sort((a, b) => a[0] - b[0])
        .slice(0, 8)
    : base.roiTable;
  const t = (p.trend ?? {}) as Partial<TrendParams>;
  const bt = base.trend ?? DEFAULT_TREND;
  const trend: TrendParams = {
    tf: TFS.includes(Number(t.tf)) ? Number(t.tf) : bt.tf,
    N: Math.round(num(t.N, bt.N, 5, 500)),
    M: Math.round(num(t.M, bt.M, 2, 300)),
    volTarget: +num(t.volTarget, bt.volTarget, 0.05, 3).toFixed(3),
    maxW: +num(t.maxW, bt.maxW, 0.25, 5).toFixed(2),
    shorts: typeof t.shorts === 'boolean' ? t.shorts : bt.shorts,
  };
  if (trend.M >= trend.N) trend.M = Math.max(2, Math.floor(trend.N / 2));
  const o = <T>(v: unknown) => (v ?? {}) as Partial<T>;
  const be = base.ema ?? DEFAULT_EMA,
    bm = base.tsmom ?? DEFAULT_TSMOM,
    bx = base.xsmom ?? DEFAULT_XSMOM,
    bc = base.carry ?? DEFAULT_CARRY,
    bmix = base.mix ?? DEFAULT_MIX;
  const e = o<EmaParams>(p.ema),
    m = o<TsmomParams>(p.tsmom),
    x = o<XsmomParams>(p.xsmom),
    c = o<CarryParams>(p.carry),
    mx = o<Record<SleeveKind, number>>(p.mix);
  const STRATS: StrategyName[] = ['scalp', 'trend', 'ema', 'tsmom', 'xsmom', 'carry', 'mix'];
  return {
    strategy: STRATS.includes(p.strategy as StrategyName) ? (p.strategy as StrategyName) : base.strategy ?? 'scalp',
    trend,
    ema: { tf: TFS.includes(Number(e.tf)) ? Number(e.tf) : be.tf, n: Math.round(num(e.n, be.n, 5, 1000)), band: +num(e.band, be.band, 0, 0.1).toFixed(4), shorts: bool(e.shorts, be.shorts) },
    tsmom: { L: Math.round(num(m.L, bm.L, 2, 365)), shorts: bool(m.shorts, bm.shorts) },
    xsmom: { L: Math.round(num(x.L, bx.L, 2, 365)), K: Math.round(num(x.K, bx.K, 1, 5)), longOnly: bool(x.longOnly, bx.longOnly), everyDays: Math.round(num(x.everyDays, bx.everyDays, 1, 60)) },
    carry: { thrAPR: +num(c.thrAPR, bc.thrAPR, 0, 200).toFixed(2), lookDays: Math.round(num(c.lookDays, bc.lookDays, 1, 30)), spotFee: +num(c.spotFee, bc.spotFee, 0, 0.01).toFixed(5) },
    mix: Object.fromEntries(SLEEVES.map((k) => [k, +num(mx[k], bmix[k] ?? 0, 0, 1).toFixed(3)])) as Record<SleeveKind, number>,
    mode: p.mode === 'reversion' || p.mode === 'momentum' ? p.mode : base.mode,
    zEntry: +num(p.zEntry, base.zEntry, 0.5, 4).toFixed(3),
    maxLev: Math.round(num(p.maxLev, base.maxLev, 1, 50)),
    tpAtr: +num(p.tpAtr, base.tpAtr, 0.5, 8).toFixed(3),
    minTp: +num(p.minTp, base.minTp, 0.001, 0.03).toFixed(5),
    ratio: +num(p.ratio, base.ratio, 1, 8).toFixed(2),
    timeStopMin: Math.round(num(p.timeStopMin, base.timeStopMin, 2, 1440)),
    trailing: bool(p.trailing, base.trailing),
    trailOffset: +num(p.trailOffset, base.trailOffset, 0.05, 1).toFixed(3),
    trailDist: +num(p.trailDist, base.trailDist, 0.05, 1).toFixed(3),
    roi: bool(p.roi, base.roi),
    roiTable: table.length ? table : base.roiTable,
    maxOpen: Math.round(num(p.maxOpen, base.maxOpen, 1, 5)),
    feeTaker: +num(p.feeTaker, base.feeTaker, 0, 0.005).toFixed(6),
    feeMaker: +num(p.feeMaker, base.feeMaker, 0, 0.005).toFixed(6),
    slippageBps: +num(p.slippageBps, base.slippageBps, 0, 50).toFixed(1),
    funding: bool(p.funding, base.funding),
    pairs: pairs.length ? pairs : base.pairs,
    volumeTopN: Math.round(num(p.volumeTopN, base.volumeTopN, 0, ALL_SYMS.length)),
  };
}

// ---- signal -----------------------------------------------------------------------------------
export function atrPct(a: Candle[], n = 14): number {
  const s = a.slice(-n - 1);
  if (s.length < 2) return 0;
  let sum = 0;
  for (let i = 1; i < s.length; i++) sum += Math.max(s[i].h - s[i].l, Math.abs(s[i].h - s[i - 1].c), Math.abs(s[i].l - s[i - 1].c));
  return sum / (s.length - 1) / s.at(-1)!.c;
}

/** The 5-minute move against its own volatility; the page's market meter shows the same number. */
export function zScore(a: Candle[]): { z: number; atr: number; rising: boolean } | null {
  if (a.length < 30) return null;
  const atr = atrPct(a);
  if (!(atr > 0)) return null;
  const z = (a.at(-1)!.c / a.at(-6)!.c - 1) / (atr * Math.sqrt(5));
  const [x, y, w] = a.slice(-3);
  return { z, atr, rising: w.c > y.c && y.c > x.c };
}

export interface Signal {
  sym: string;
  side: 'LONG' | 'SHORT';
  strength: number;
  atr: number;
}

export function signalFrom(sym: string, r: { z: number; atr: number; rising: boolean } | null, zEntry = DEFAULT_PARAMS.zEntry, mode: Params['mode'] = 'momentum'): Signal | null {
  if (!r || Math.abs(r.z) < zEntry) return null;
  if (mode === 'reversion') {
    // Fade the move, but only once it stalls: no long into a dump still falling hard.
    if (r.z < 0 && !r.rising) return null;
    return { sym, side: r.z < 0 ? 'LONG' : 'SHORT', strength: Math.abs(r.z), atr: r.atr };
  }
  if (r.z < 0 && r.rising) return null; // a dump that already turned: no short into a bounce
  return { sym, side: r.z < 0 ? 'SHORT' : 'LONG', strength: Math.abs(r.z), atr: r.atr };
}

export function signal(sym: string, a: Candle[], zEntry = DEFAULT_PARAMS.zEntry, mode: Params['mode'] = 'momentum'): Signal | null {
  return signalFrom(sym, zScore(a), zEntry, mode);
}

// ---- positions --------------------------------------------------------------------------------
const slip = (price: number, bps: number, worse: 1 | -1) => price * (1 + (worse * bps) / 10_000);

/**
 * Opens a trade at `price` (a market order: slippage against us, taker fee). Margin is the share of
 * the balance from the settings, never more than what's still free.
 */
export function openPosition(
  o: { balance: number; marginPct: number; usedMargin?: number; id?: number },
  sig: { sym: string; side: 'LONG' | 'SHORT'; atr: number },
  price: number,
  p: Params = DEFAULT_PARAMS,
  now = Date.now(),
  tag = 'signal',
): Position | null {
  const dir = sig.side === 'LONG' ? 1 : -1;
  const entry = slip(price, p.slippageBps, dir);
  const tpDist = Math.max(p.minTp, p.tpAtr * sig.atr);
  const slDist = tpDist / p.ratio;
  const cap = Math.min(COINS[sig.sym] ?? 20, p.maxLev);
  const lev = clamp(Math.round(1 / tpDist), Math.min(3, cap), cap);
  const free = o.balance - (o.usedMargin ?? 0);
  const margin = +Math.min((o.balance * o.marginPct) / 100, free).toFixed(2);
  if (!(margin >= 1)) return null;
  const size = margin * lev;
  return {
    id: o.id ?? now,
    sym: sig.sym,
    side: sig.side,
    lev,
    entry,
    tp: entry * (1 + dir * tpDist),
    sl: entry * (1 - dir * slDist),
    liq: entry * (1 - (dir * 0.9) / lev),
    margin,
    size,
    openedAt: now,
    tpDist,
    peak: entry,
    trailing: false,
    fees: +(size * p.feeTaker).toFixed(6),
    funding: 0,
    tag,
  };
}

export const pnlOf = (p: { size: number; side: string; entry: number; hedged?: boolean }, price: number) => (p.hedged ? 0 : p.size * (p.side === 'LONG' ? 1 : -1) * (price / p.entry - 1));

/** Minimal ROI now: the share of the TP distance that's enough after `mins` minutes. */
export function roiNow(table: [number, number][], mins: number): number | null {
  let r: number | null = null;
  for (const [m, f] of table) if (mins >= m) r = f;
  return r;
}

/** Moves the trailing stop with the best price seen. Returns true when the stop moved. */
export function updateTrail(pos: Position, best: number, p: Params): boolean {
  const long = pos.side === 'LONG';
  if (long ? best > pos.peak : best < pos.peak) pos.peak = best;
  if (!p.trailing) return false;
  const moved = (long ? pos.peak / pos.entry - 1 : 1 - pos.peak / pos.entry) / pos.tpDist;
  if (moved < p.trailOffset) return false;
  const stop = pos.peak * (1 - (long ? 1 : -1) * p.trailDist * pos.tpDist);
  if (long ? stop > pos.sl : stop < pos.sl) {
    pos.sl = stop;
    pos.trailing = true;
    return true;
  }
  return false;
}

export interface Exit {
  why: ExitWhy;
  /** fill price before slippage */
  at: number;
  /** limit order (TP) → maker fee, no slippage */
  maker: boolean;
}

/**
 * Exit check inside one candle (backtests) or at one price (live: h = l = c = price).
 * Pessimistic like freqtrade: liquidation, then the stop, then targets, then the clock.
 */
export function exitCheck(pos: Position, c: { h: number; l: number; c: number }, p: Params, now: number): Exit | null {
  const long = pos.side === 'LONG';
  const worst = long ? c.l : c.h;
  const best = long ? c.h : c.l;
  if (long ? worst <= pos.liq : worst >= pos.liq) return { why: 'LIQ', at: pos.liq, maker: false };
  if (long ? worst <= pos.sl : worst >= pos.sl) return { why: pos.trailing ? 'TRAIL' : 'SL', at: long ? Math.min(pos.sl, c.h) : Math.max(pos.sl, c.l), maker: false };
  if (long ? best >= pos.tp : best <= pos.tp) return { why: 'TP', at: pos.tp, maker: true };
  const mins = (now - pos.openedAt) / 60_000;
  if (p.roi) {
    const f = roiNow(p.roiTable, mins);
    if (f !== null) {
      // At least enough to pay both fees, so a "0" row means "any real profit".
      const need = Math.max(f * pos.tpDist, p.feeTaker * 2 + (p.slippageBps * 2) / 10_000);
      const target = pos.entry * (1 + (long ? 1 : -1) * need);
      if (long ? best >= target : best <= target) return { why: 'ROI', at: long ? Math.max(target, c.l) : Math.min(target, c.h), maker: false };
    }
  }
  if (mins >= p.timeStopMin) return { why: 'TIME', at: c.c, maker: false };
  return null;
}

/** Closes a trade: the fill price with slippage, the exit fee, and the result (a liquidation loses the margin). */
export function closeTrade(pos: Position, ex: { why: ExitWhy; at: number; maker: boolean }, balance: number, p: Params, now: number): Closed {
  const dir = pos.side === 'LONG' ? 1 : -1;
  const fill = ex.maker || ex.why === 'LIQ' ? ex.at : slip(ex.at, p.slippageBps, (-dir) as 1 | -1);
  const exitFee = pos.size * (ex.maker ? p.feeMaker : p.feeTaker) * (pos.hedged ? 1 : fill / pos.entry);
  const fees = pos.fees + exitFee;
  const gross = ex.why === 'LIQ' ? -pos.margin : pnlOf(pos, fill);
  const pnl = gross - fees + pos.funding;
  return {
    id: pos.id,
    sym: pos.sym,
    side: pos.side,
    lev: pos.lev,
    entry: pos.entry,
    exit: fill,
    pnl: +pnl.toFixed(4),
    pct: +((pnl / pos.margin) * 100).toFixed(2),
    balPct: balance > 0 ? +((pnl / balance) * 100).toFixed(3) : 0,
    why: ex.why,
    at: now,
    openedAt: pos.openedAt,
    dur: now - pos.openedAt,
    margin: pos.margin,
    fees: +fees.toFixed(4),
    funding: +pos.funding.toFixed(4),
    tag: pos.tag,
  };
}

/** Funding on an open trade (positive rate: longs pay shorts). */
export function fundingPay(pos: Position, rate: number, markPrice: number): number {
  const notional = pos.size * (markPrice / pos.entry);
  return -(pos.side === 'LONG' ? 1 : -1) * notional * rate;
}

/** VolumePairList: the allowed pairs, the busiest first, cut to N (0 = all). */
export function pairlist(p: Params, vol24: Record<string, number>): string[] {
  if (!p.volumeTopN) return p.pairs;
  return [...p.pairs].sort((a, b) => (vol24[b] ?? 0) - (vol24[a] ?? 0)).slice(0, p.volumeTopN);
}
