import fs from 'node:fs';
import path from 'node:path';

/**
 * "The Hunter": buy strong assets after a sharp drop, hold until they recover.
 *
 * Rule (daily bars): an asset is a candidate when it has fallen `dipPct` or more from its
 * `lookback`-day high within the last `fastDays` days, while its long-term picture is intact
 * (close above `qualityPct` of its 200-day SMA, so a crash that broke the trend is skipped).
 * Entry at the close. Exit: back at the pre-dip high (target, capped at `maxGainPct`), stop at
 * `stopPct` below entry, or `maxHoldDays`. Equal-sized positions, shared cash, at most `maxOpen`.
 * Pure functions: the simulation and the live scanner share them.
 */
export interface DBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}
export interface HParams {
  dipPct: number;
  lookback: number;
  fastDays: number;
  qualityPct: number;
  stopPct: number;
  maxGainPct: number;
  maxHoldDays: number;
  maxOpen: number;
  positionPct: number;
  fee: number;
  /** Days to wait before re-buying the same asset after a stop-out. */
  cooldownDays: number;
}
export const CRYPTO_HP: HParams = { dipPct: 15, lookback: 60, fastDays: 10, qualityPct: 90, stopPct: 15, maxGainPct: 40, maxHoldDays: 90, maxOpen: 8, positionPct: 12, fee: 0.001, cooldownDays: 20 };
export const STOCK_HP: HParams = { dipPct: 8, lookback: 60, fastDays: 10, qualityPct: 92, stopPct: 10, maxGainPct: 25, maxHoldDays: 90, maxOpen: 8, positionPct: 12, fee: 0.0005, cooldownDays: 20 };

export interface DipSignal {
  symbol: string;
  close: number;
  high: number;
  dropPct: number;
  sma200: number;
  targetPct: number;
}

/** Evaluates the dip rule on the last bar of `bars` (needs ≥ 200 bars). */
export function dipSignal(symbol: string, bars: DBar[], p: HParams): DipSignal | null {
  if (bars.length < 200) return null;
  const n = bars.length;
  const c = bars[n - 1].c;
  const win = bars.slice(n - p.lookback, n);
  const high = Math.max(...win.map((b) => b.h));
  const drop = (1 - c / high) * 100;
  if (drop < p.dipPct) return null;
  // The drop must be recent: the high was reached within lookback and the price was within 3 % of it `fastDays` ago or later.
  const recent = bars.slice(n - p.fastDays - 1, n - 1);
  if (!recent.some((b) => b.c >= high * 0.97)) return null;
  const sma200 = bars.slice(n - 200, n).reduce((a, b) => a + b.c, 0) / 200;
  if (c < (p.qualityPct / 100) * sma200) return null;
  return { symbol, close: c, high, dropPct: drop, sma200, targetPct: Math.min(p.maxGainPct, (high / c - 1) * 100) };
}

export interface HTrade {
  symbol: string;
  entry: number;
  exit: number;
  qty: number;
  pnl: number;
  openedAt: number;
  closedAt: number;
  reason: 'target' | 'stop' | 'time' | 'end';
  dropPct: number;
}

export function simulateHunter(data: { symbol: string; bars: DBar[] }[], p: HParams, start: number, end: number, startEquity = 10_000) {
  // Align on the union of trading days.
  const days = [...new Set(data.flatMap((d) => d.bars.map((b) => b.t)))].sort((a, b) => a - b).filter((t) => t >= start && t < end);
  const idx = new Map(data.map((d) => [d.symbol, new Map(d.bars.map((b, i) => [b.t, i]))]));
  let cash = startEquity;
  const open = new Map<string, { entry: number; qty: number; target: number; stop: number; openedAt: number; dropPct: number }>();
  const cooldown = new Map<string, number>();
  const trades: HTrade[] = [];
  const curve: [number, number][] = [];
  let peak = startEquity;
  let maxDd = 0;
  const close = (sym: string, px: number, t: number, reason: HTrade['reason']) => {
    const pos = open.get(sym)!;
    const proceeds = pos.qty * px * (1 - p.fee);
    const pnl = proceeds - pos.qty * pos.entry * (1 + p.fee);
    cash += proceeds;
    trades.push({ symbol: sym, entry: pos.entry, exit: px, qty: pos.qty, pnl, openedAt: pos.openedAt, closedAt: t, reason, dropPct: pos.dropPct });
    open.delete(sym);
    if (reason === 'stop') cooldown.set(sym, t + p.cooldownDays * 86400_000);
  };
  for (const t of days) {
    // 1. manage
    for (const [sym, pos] of [...open]) {
      const i = idx.get(sym)!.get(t);
      if (i === undefined) continue;
      const b = data.find((d) => d.symbol === sym)!.bars[i];
      if (b.l <= pos.stop) close(sym, pos.stop, t, 'stop');
      else if (b.h >= pos.target) close(sym, pos.target, t, 'target');
      else if (t - pos.openedAt >= p.maxHoldDays * 86400_000) close(sym, b.c, t, 'time');
    }
    // 2. scan
    const cands: DipSignal[] = [];
    for (const d of data) {
      if (open.has(d.symbol) || (cooldown.get(d.symbol) ?? 0) > t) continue;
      const i = idx.get(d.symbol)!.get(t);
      if (i === undefined || i < 200) continue;
      const s = dipSignal(d.symbol, d.bars.slice(0, i + 1), p);
      if (s) cands.push(s);
    }
    cands.sort((a, b) => b.dropPct - a.dropPct);
    let equity =
      cash +
      [...open].reduce((a, [sym, pos]) => {
        const i = idx.get(sym)!.get(t);
        const px = i === undefined ? pos.entry : data.find((d) => d.symbol === sym)!.bars[i].c;
        return a + pos.qty * px;
      }, 0);
    for (const s of cands) {
      if (open.size >= p.maxOpen) break;
      const notional = Math.min((p.positionPct / 100) * equity, cash * 0.98);
      if (notional < 10) break;
      const qty = notional / s.close;
      cash -= qty * s.close * (1 + p.fee);
      open.set(s.symbol, { entry: s.close, qty, target: s.close * (1 + s.targetPct / 100), stop: s.close * (1 - p.stopPct / 100), openedAt: t, dropPct: s.dropPct });
    }
    equity =
      cash +
      [...open].reduce((a, [sym, pos]) => {
        const i = idx.get(sym)!.get(t);
        const px = i === undefined ? pos.entry : data.find((d) => d.symbol === sym)!.bars[i].c;
        return a + pos.qty * px;
      }, 0);
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, (peak - equity) / peak);
    curve.push([t, Math.round(equity * 100) / 100]);
  }
  for (const [sym, pos] of [...open]) {
    const bars = data.find((d) => d.symbol === sym)!.bars;
    close(sym, bars[bars.length - 1].c, days[days.length - 1], 'end');
  }
  const wins = trades.filter((x) => x.pnl > 0);
  const gross = wins.reduce((a, x) => a + x.pnl, 0);
  const loss = -trades.filter((x) => x.pnl <= 0).reduce((a, x) => a + x.pnl, 0);
  const end$ = cash;
  return {
    netPct: ((end$ - startEquity) / startEquity) * 100,
    maxDdPct: maxDd * 100,
    trades: trades.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    profitFactor: loss > 0 ? gross / loss : gross > 0 ? Infinity : 0,
    avgHoldDays: trades.length ? trades.reduce((a, x) => a + (x.closedAt - x.openedAt), 0) / trades.length / 86400_000 : 0,
    byReason: trades.reduce<Record<string, number>>((m, x) => ((m[x.reason] = (m[x.reason] ?? 0) + 1), m), {}),
    bySymbol: Object.entries(trades.reduce<Record<string, number>>((m, x) => ((m[x.symbol] = (m[x.symbol] ?? 0) + x.pnl), m), {})).sort((a, b) => b[1] - a[1]),
    curve: curve.filter((_, i, a) => i % Math.max(1, Math.floor(a.length / 1500)) === 0),
    tradesList: trades,
  };
}

/** Daily bars from a cache folder of <SYMBOL>.json files. */
export function loadBars(dir: string, symbol: string): DBar[] {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, `${symbol}.json`), 'utf8')) as DBar[];
  } catch {
    return [];
  }
}
