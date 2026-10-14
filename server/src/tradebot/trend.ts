import { lossOf, rng, type BacktestResult, type Epoch, type HyperoptOpts, type RunSettings } from './backtest.js';
import { computeStats } from './stats.js';
import { closeTrade, type Closed, type Params, type Position, type TrendParams } from './strategy.js';

/**
 * Trend following — a Donchian / Turtle breakout on 4-hour bars. Chosen after testing the classic
 * strategies on Binance perps since 2020 (after fees, slippage and real funding), picking settings
 * on 2020–2023 only and judging them on 2024–2026: long-only breakouts kept ≈ +22 %/yr with a 13 %
 * worst drop and no losing year, against buy-and-hold's −71 % (2022) and −36 % (2025) years. Every
 * setting tried stayed positive out of sample, on BTC+ETH alone too, and with doubled costs.
 *
 * Rules: at a bar's close, a close above the highest high of the previous N bars → long (a close
 * below the lowest low → short, if shorts are on); a long ends on a close below the lowest low of
 * the previous M bars. Orders fill at the next bar's open. Each coin gets an equal share of the
 * balance, sized so its yearly volatility is about `volTarget`.
 */

export interface Bar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** funding rates paid inside the bar, summed */
  f: number;
}

/** Hourly rows [t, o, h, l, c, …] → bars of `tf` hours, with funding events summed per bar. */
export function toBars(rows: number[][], tf: number, funding: [number, number][] = []): Bar[] {
  const H = 3600_000;
  const out: Bar[] = [];
  let fi = 0;
  for (const r of rows) {
    const t = Math.floor(r[0] / (tf * H)) * tf * H;
    let b = out.at(-1);
    if (!b || b.t !== t) {
      b = { t, o: r[1], h: r[2], l: r[3], c: r[4], f: 0 };
      out.push(b);
    }
    b.h = Math.max(b.h, r[2]);
    b.l = Math.min(b.l, r[3]);
    b.c = r[4];
    while (fi < funding.length && funding[fi][0] < r[0] + H) {
      if (funding[fi][0] >= r[0]) b.f += funding[fi][1];
      fi++;
    }
  }
  return out;
}

/** The target position after bar i closes: 1 long, −1 short, 0 flat. */
export function trendTarget(b: Bar[], i: number, pos: number, t: TrendParams): -1 | 0 | 1 {
  if (i < t.N + 1) return 0;
  let hi = -Infinity,
    lo = Infinity,
    xh = -Infinity,
    xl = Infinity;
  for (let k = i - t.N; k < i; k++) {
    if (b[k].h > hi) hi = b[k].h;
    if (b[k].l < lo) lo = b[k].l;
  }
  for (let k = i - t.M; k < i; k++) {
    if (b[k].h > xh) xh = b[k].h;
    if (b[k].l < xl) xl = b[k].l;
  }
  const c = b[i].c;
  if (c > hi) return 1;
  if (t.shorts && c < lo) return -1;
  if (pos > 0 && c < xl) return 0;
  if (pos < 0 && c > xh) return 0;
  return pos > 0 ? 1 : pos < 0 ? -1 : 0;
}

/** The levels that matter after bar i: the breakout line and the exit line for the next close. */
export function channels(b: Bar[], i: number, t: TrendParams): { entry: number; exit: number; shortEntry: number; shortExit: number } | null {
  if (i < t.N) return null;
  let hi = -Infinity,
    lo = Infinity,
    xh = -Infinity,
    xl = Infinity;
  for (let k = i - t.N + 1; k <= i; k++) {
    hi = Math.max(hi, b[k].h);
    lo = Math.min(lo, b[k].l);
  }
  for (let k = i - t.M + 1; k <= i; k++) {
    xh = Math.max(xh, b[k].h);
    xl = Math.min(xl, b[k].l);
  }
  return { entry: hi, exit: xl, shortEntry: lo, shortExit: xh };
}

/** Yearly volatility of bar returns over ~30 days, up to bar i. */
export function annVol(b: Bar[], i: number, tf: number): number | null {
  const n = Math.round((30 * 24) / tf);
  if (i < n + 1) return null;
  let s = 0,
    s2 = 0;
  for (let k = i - n + 1; k <= i; k++) {
    const r = Math.log(b[k].c / b[k - 1].c);
    s += r;
    s2 += r * r;
  }
  return Math.sqrt(Math.max(s2 / n - (s / n) ** 2, 1e-12) * (8760 / tf));
}

/** Notional per unit of the coin's capital share: volTarget / volatility, capped. */
export const trendWeight = (vol: number | null, t: TrendParams) => (vol ? Math.min(t.maxW, t.volTarget / vol) : 0);

/** Opens a trend trade: a market order (slippage, taker fee), no take-profit; the exit is the channel. */
export function openTrend(o: { alloc: number; id: number }, sym: string, side: 'LONG' | 'SHORT', price: number, w: number, exit: number | null, p: Params, now: number): Position | null {
  const dir = side === 'LONG' ? 1 : -1;
  const entry = price * (1 + (dir * p.slippageBps) / 10_000);
  const margin = +o.alloc.toFixed(2);
  if (!(margin >= 1) || !(w > 0)) return null;
  const size = margin * w;
  const lev = Math.max(1, Math.ceil(w));
  return {
    id: o.id,
    sym,
    side,
    lev,
    entry,
    // No take-profit: winners run until the trend turns. tp is only drawn as the breakout line.
    tp: entry * (1 + dir * 0.2),
    sl: exit ?? entry * (1 - dir * 0.1),
    liq: entry * (1 - (dir * 0.9) / Math.max(1, w)),
    margin,
    size,
    openedAt: now,
    tpDist: 0.2,
    peak: entry,
    trailing: false,
    fees: +(size * p.feeTaker).toFixed(6),
    funding: 0,
    tag: 'trend',
  };
}

/**
 * Backtests the trend strategy on bars per coin (all the same `tf`). Each coin's trade uses an equal
 * share of the balance at entry; results come out in the same shape as the scalp backtest.
 */
export function simulateTrend(bars: Record<string, Bar[]>, rs: RunSettings, opts: { from?: number; light?: boolean } = {}): BacktestResult {
  const p = rs.params;
  const t = p.trend;
  const syms = Object.keys(bars).filter((s) => p.pairs.includes(s) && bars[s].length);
  const from = opts.from ?? Math.min(...syms.map((s) => bars[s][0].t));
  const times = [...new Set(syms.flatMap((s) => bars[s].map((b) => b.t)))].filter((x) => x >= from).sort((a, b) => a - b);
  const idx: Record<string, Map<number, number>> = Object.fromEntries(syms.map((s) => [s, new Map(bars[s].map((b, i) => [b.t, i]))]));
  const tfMs = t.tf * 3600_000;
  let balance = rs.start;
  let id = 1;
  const open: Record<string, Position> = {};
  const want: Record<string, number> = {};
  const closed: Closed[] = [];
  const equity: [number, number][] = [];
  const share = 1 / Math.max(1, syms.length);
  for (const ts of times) {
    for (const s of syms) {
      const i = idx[s].get(ts);
      if (i === undefined) continue;
      const b = bars[s][i];
      const pos = open[s];
      const cur = pos ? (pos.side === 'LONG' ? 1 : -1) : 0;
      const tgt = want[s] ?? 0;
      // Orders decided at the last close fill at this bar's open.
      if (tgt !== cur) {
        if (pos) {
          const tr = closeTrade(pos, { why: 'TREND', at: b.o, maker: false }, balance, p, b.t);
          balance = Math.max(0, balance + tr.pnl);
          closed.push(tr);
          delete open[s];
        }
        if (tgt !== 0 && balance > 1) {
          const w = trendWeight(annVol(bars[s], i - 1, t.tf), t);
          const ch = channels(bars[s], i - 1, t);
          const np = openTrend({ alloc: balance * share, id: id++ }, s, tgt > 0 ? 'LONG' : 'SHORT', b.o, w, ch ? (tgt > 0 ? ch.exit : ch.shortExit) : null, p, b.t);
          if (np) open[s] = np;
        }
      }
      const o = open[s];
      if (o) {
        if (p.funding && b.f) o.funding += -(o.side === 'LONG' ? 1 : -1) * o.size * (b.c / o.entry) * b.f;
        // Liquidation inside the bar (rare at these sizes).
        if (o.side === 'LONG' ? b.l <= o.liq : b.h >= o.liq) {
          const tr = closeTrade(o, { why: 'LIQ', at: o.liq, maker: false }, balance, p, b.t + tfMs);
          balance = Math.max(0, balance + tr.pnl);
          closed.push(tr);
          delete open[s];
        }
      }
      const now = open[s] ? (open[s].side === 'LONG' ? 1 : -1) : 0;
      want[s] = trendTarget(bars[s], i, now, t);
      const ch = open[s] && channels(bars[s], i, t);
      if (ch && open[s]) open[s].sl = open[s].side === 'LONG' ? ch.exit : ch.shortExit;
    }
    if (!opts.light) {
      let unreal = 0;
      for (const [s, o] of Object.entries(open)) {
        const i = idx[s].get(ts);
        const c = i !== undefined ? bars[s][i].c : o.entry;
        unreal += o.size * (o.side === 'LONG' ? 1 : -1) * (c / o.entry - 1) - o.fees + o.funding;
      }
      equity.push([ts + tfMs, +(balance + unreal).toFixed(4)]);
    }
  }
  // Trades still open at the end close at the last price.
  const endAt = (times.at(-1) ?? from) + tfMs;
  const openAtEnd = Object.keys(open).length;
  for (const [s, o] of Object.entries(open)) {
    const tr = closeTrade(o, { why: 'FORCE', at: bars[s].at(-1)!.c, maker: false }, balance, p, endAt);
    balance = Math.max(0, balance + tr.pnl);
    closed.push(tr);
  }
  const marketChange: Record<string, number> = {};
  for (const s of syms) {
    const a = bars[s].find((b) => b.t >= from)?.o;
    const z = bars[s].at(-1)?.c;
    if (a && z) marketChange[s] = +((z / a - 1) * 100).toFixed(2);
  }
  const mc = Object.values(marketChange);
  const desc = closed.slice().reverse();
  const step = Math.max(1, Math.ceil(equity.length / 400));
  return {
    from,
    to: endAt,
    start: rs.start,
    final: +balance.toFixed(4),
    stats: computeStats(desc, rs.start, { from, to: endAt }),
    closed: opts.light ? [] : desc.slice(0, 500),
    equity: opts.light ? [] : [...equity.filter((_, i) => i % step === 0), ...(equity.length ? [equity.at(-1)!] : [])],
    marketChange,
    marketAvg: mc.length ? +(mc.reduce((x, v) => x + v, 0) / mc.length).toFixed(2) : 0,
    locks: [],
    openAtEnd,
    stoppedEarly: false,
  };
}

/** Hyperopt for the trend strategy: bar length, both channels and the volatility target. */
export async function hyperoptTrend(
  barsFor: (tf: number) => Record<string, Bar[]>,
  base: RunSettings,
  o: HyperoptOpts,
  from: number,
  onEpoch: (e: Epoch, best: Epoch | null, i: number) => void | Promise<void>,
): Promise<{ epochs: Epoch[]; best: Epoch | null }> {
  const rand = rng(o.seed);
  const TF = [2, 4, 8, 12, 24];
  const sample = (): TrendParams => {
    const N = Math.round(20 + rand() * 180);
    return { ...base.params.trend, tf: TF[Math.floor(rand() * TF.length)], N, M: Math.max(3, Math.round(N * (0.05 + rand() * 0.5))), volTarget: +(0.2 + rand() * 1).toFixed(2) };
  };
  const mutate = (t: TrendParams): TrendParams => {
    const N = Math.max(10, Math.min(250, Math.round(t.N * (0.8 + rand() * 0.4))));
    return { ...t, tf: rand() < 0.15 ? TF[Math.floor(rand() * TF.length)] : t.tf, N, M: Math.max(3, Math.min(N - 1, Math.round(t.M * (0.8 + rand() * 0.4)))), volTarget: +Math.max(0.1, Math.min(1.5, t.volTarget * (0.85 + rand() * 0.3))).toFixed(2) };
  };
  const seen: { t: TrendParams; loss: number }[] = [];
  const epochs: Epoch[] = [];
  let best: Epoch | null = null;
  const warm = Math.max(10, Math.round(o.epochs * 0.3));
  for (let i = 0; i < o.epochs; i++) {
    const tp = i === 0 ? base.params.trend : i < warm || rand() < 0.3 ? sample() : mutate([...seen].sort((a, b) => a.loss - b.loss)[Math.floor(rand() * Math.min(5, seen.length))].t);
    const rs = { ...base, params: { ...base.params, trend: tp } };
    const r = simulateTrend(barsFor(tp.tf), rs, { from, light: true });
    const loss = lossOf(o.loss, r.stats, o.minTrades);
    seen.push({ t: tp, loss });
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
      params: { trend: tp },
    };
    epochs.push(e);
    if (!best || e.loss < best.loss) best = e;
    await onEpoch(e, best, i);
  }
  return { epochs, best };
}
