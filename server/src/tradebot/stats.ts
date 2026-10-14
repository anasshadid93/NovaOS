import type { Closed } from './strategy.js';

/**
 * Trade statistics in the spirit of freqtrade's /profit, /daily, /weekly, /monthly, /performance and
 * backtest report: win/draw/loss, profit factor, expectancy, drawdown, Sharpe, Sortino, Calmar,
 * CAGR, per pair, per exit reason and per day. Used by the live bot and by backtests.
 */
export interface PeriodRow {
  key: string;
  start: number;
  trades: number;
  profit: number;
  pct: number;
  wins: number;
}
export interface GroupRow {
  key: string;
  trades: number;
  profit: number;
  avgPct: number;
  wins: number;
  draws: number;
  losses: number;
  winrate: number;
  avgDur: number;
}
export interface Stats {
  trades: number;
  wins: number;
  draws: number;
  losses: number;
  winrate: number;
  profit: number;
  profitPct: number;
  avgPct: number;
  avgBalPct: number;
  avgDur: number;
  avgWinDur: number;
  avgLossDur: number;
  bestTrade: { sym: string; pct: number; pnl: number } | null;
  worstTrade: { sym: string; pct: number; pnl: number } | null;
  bestPair: { key: string; profit: number } | null;
  worstPair: { key: string; profit: number } | null;
  grossWin: number;
  grossLoss: number;
  profitFactor: number | null;
  expectancy: number;
  expectancyRatio: number | null;
  maxDrawdown: number;
  maxDrawdownPct: number;
  drawdownStart: number | null;
  drawdownEnd: number | null;
  maxConsecWins: number;
  maxConsecLosses: number;
  sharpe: number | null;
  sortino: number | null;
  calmar: number | null;
  cagr: number | null;
  fees: number;
  funding: number;
  longs: { trades: number; profit: number; winrate: number };
  shorts: { trades: number; profit: number; winrate: number };
  tradesPerDay: number;
  firstAt: number | null;
  lastAt: number | null;
  days: number;
  perPair: GroupRow[];
  perExit: GroupRow[];
  perTag: GroupRow[];
  daily: PeriodRow[];
  weekly: PeriodRow[];
  monthly: PeriodRow[];
}

/** A trade within ±0.01% of its margin counts as a draw, like freqtrade's break-even. */
const DRAW = 0.01;
const outcome = (t: Closed) => (t.pct > DRAW ? 'w' : t.pct < -DRAW ? 'l' : 'd');
const round = (v: number, d = 4) => +v.toFixed(d);

function group(trades: Closed[], key: (t: Closed) => string): GroupRow[] {
  const m = new Map<string, Closed[]>();
  for (const t of trades) m.set(key(t), [...(m.get(key(t)) ?? []), t]);
  return [...m.entries()]
    .map(([k, a]) => {
      const w = a.filter((t) => outcome(t) === 'w').length,
        l = a.filter((t) => outcome(t) === 'l').length;
      return {
        key: k,
        trades: a.length,
        profit: round(a.reduce((s, t) => s + t.pnl, 0)),
        avgPct: round(a.reduce((s, t) => s + t.pct, 0) / a.length, 2),
        wins: w,
        draws: a.length - w - l,
        losses: l,
        winrate: round((w / a.length) * 100, 1),
        avgDur: Math.round(a.reduce((s, t) => s + t.dur, 0) / a.length),
      };
    })
    .sort((a, b) => b.profit - a.profit);
}

/** Dubai calendar keys (UTC+4, no DST). */
const TZ = 4 * 3600_000;
const dayKey = (at: number) => new Date(at + TZ).toISOString().slice(0, 10);
const monthKey = (at: number) => new Date(at + TZ).toISOString().slice(0, 7);
function weekKey(at: number) {
  const d = new Date(at + TZ);
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7)));
  return monday.toISOString().slice(0, 10);
}
const keyStart = (k: string) => Date.parse(k.length === 7 ? `${k}-01` : k) - TZ;

function periods(trades: Closed[], start: number, key: (at: number) => string, limit: number): PeriodRow[] {
  // Balance at the start of each period, to give each period's profit as a % like freqtrade.
  const asc = [...trades].sort((a, b) => a.at - b.at);
  const rows = new Map<string, PeriodRow>();
  let bal = start;
  for (const t of asc) {
    const k = key(t.at);
    let r = rows.get(k);
    if (!r) rows.set(k, (r = { key: k, start: keyStart(k), trades: 0, profit: 0, pct: 0, wins: 0, _bal: bal } as PeriodRow & { _bal: number }));
    r.trades++;
    r.profit += t.pnl;
    if (outcome(t) === 'w') r.wins++;
    bal += t.pnl;
  }
  return [...rows.values()]
    .map((r) => {
      const b = (r as PeriodRow & { _bal: number })._bal;
      return { key: r.key, start: r.start, trades: r.trades, profit: round(r.profit), pct: b > 0 ? round((r.profit / b) * 100, 2) : 0, wins: r.wins };
    })
    .sort((a, b) => b.start - a.start)
    .slice(0, limit);
}

export function computeStats(closedNewestFirst: Closed[], start: number, opts: { from?: number; to?: number } = {}): Stats {
  const trades = [...closedNewestFirst].sort((a, b) => a.at - b.at);
  const n = trades.length;
  const wins = trades.filter((t) => outcome(t) === 'w'),
    losses = trades.filter((t) => outcome(t) === 'l');
  const profit = trades.reduce((s, t) => s + t.pnl, 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = -losses.reduce((s, t) => s + t.pnl, 0);
  const avgWin = wins.length ? grossWin / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  const winrate = n ? wins.length / n : 0;

  // Drawdown on the closed-trade balance path.
  let bal = start,
    peak = start,
    peakAt: number | null = trades[0]?.openedAt ?? null,
    dd = 0,
    ddPct = 0,
    ddStart: number | null = null,
    ddEnd: number | null = null;
  let cw = 0,
    cl = 0,
    mcw = 0,
    mcl = 0;
  for (const t of trades) {
    bal += t.pnl;
    if (bal > peak) {
      peak = bal;
      peakAt = t.at;
    }
    const d = peak - bal;
    if (d > dd) {
      dd = d;
      ddPct = peak > 0 ? d / peak : 0;
      ddStart = peakAt;
      ddEnd = t.at;
    }
    const o = outcome(t);
    cw = o === 'w' ? cw + 1 : 0;
    cl = o === 'l' ? cl + 1 : 0;
    mcw = Math.max(mcw, cw);
    mcl = Math.max(mcl, cl);
  }

  const firstAt = opts.from ?? trades[0]?.openedAt ?? null;
  const lastAt = opts.to ?? trades.at(-1)?.at ?? null;
  const days = firstAt && lastAt ? Math.max(1 / 24, (lastAt - firstAt) / 86_400_000) : 0;

  // Daily returns (every calendar day in the range, empty days = 0) for Sharpe and Sortino.
  let sharpe: number | null = null,
    sortino: number | null = null;
  if (n >= 2 && firstAt && lastAt) {
    const byDay = new Map<string, number>();
    for (const t of trades) byDay.set(dayKey(t.at), (byDay.get(dayKey(t.at)) ?? 0) + t.pnl);
    const rets: number[] = [];
    let b = start;
    for (let d = firstAt; d <= lastAt + 86_400_000 - 1; d += 86_400_000) {
      const p = byDay.get(dayKey(d)) ?? 0;
      rets.push(b > 0 ? p / b : 0);
      b += p;
    }
    if (rets.length >= 2) {
      const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
      const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1));
      const down = Math.sqrt(rets.reduce((s, r) => s + Math.min(0, r) ** 2, 0) / rets.length);
      sharpe = sd > 0 ? round((mean / sd) * Math.sqrt(365), 2) : null;
      sortino = down > 0 ? round((mean / down) * Math.sqrt(365), 2) : null;
    }
  }
  const finalBal = start + profit;
  const cagr = days >= 1 && start > 0 && finalBal > 0 ? round(((finalBal / start) ** (365 / days) - 1) * 100, 1) : null;
  const yearly = days > 0 && start > 0 ? (profit / start) * (365 / days) : 0;
  const calmar = ddPct > 0 && days >= 1 ? round(yearly / ddPct, 2) : null;

  const side = (s: string) => {
    const a = trades.filter((t) => t.side === s);
    return { trades: a.length, profit: round(a.reduce((x, t) => x + t.pnl, 0)), winrate: a.length ? round((a.filter((t) => outcome(t) === 'w').length / a.length) * 100, 1) : 0 };
  };
  const perPair = group(trades, (t) => t.sym);
  const best = trades.reduce<Closed | null>((b, t) => (!b || t.pct > b.pct ? t : b), null);
  const worst = trades.reduce<Closed | null>((b, t) => (!b || t.pct < b.pct ? t : b), null);
  const avgDur = (a: Closed[]) => (a.length ? Math.round(a.reduce((s, t) => s + t.dur, 0) / a.length) : 0);

  return {
    trades: n,
    wins: wins.length,
    draws: n - wins.length - losses.length,
    losses: losses.length,
    winrate: round(winrate * 100, 1),
    profit: round(profit),
    profitPct: start > 0 ? round((profit / start) * 100, 2) : 0,
    avgPct: n ? round(trades.reduce((s, t) => s + t.pct, 0) / n, 2) : 0,
    avgBalPct: n ? round(trades.reduce((s, t) => s + t.balPct, 0) / n, 3) : 0,
    avgDur: avgDur(trades),
    avgWinDur: avgDur(wins),
    avgLossDur: avgDur(losses),
    bestTrade: best ? { sym: best.sym, pct: best.pct, pnl: best.pnl } : null,
    worstTrade: worst ? { sym: worst.sym, pct: worst.pct, pnl: worst.pnl } : null,
    bestPair: perPair[0] ? { key: perPair[0].key, profit: perPair[0].profit } : null,
    worstPair: perPair.length ? { key: perPair.at(-1)!.key, profit: perPair.at(-1)!.profit } : null,
    grossWin: round(grossWin),
    grossLoss: round(grossLoss),
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss, 2) : null,
    expectancy: n ? round(profit / n) : 0,
    expectancyRatio: avgLoss > 0 ? round((1 + avgWin / avgLoss) * winrate - 1, 2) : null,
    maxDrawdown: round(dd),
    maxDrawdownPct: round(ddPct * 100, 2),
    drawdownStart: ddStart,
    drawdownEnd: ddEnd,
    maxConsecWins: mcw,
    maxConsecLosses: mcl,
    sharpe,
    sortino,
    calmar,
    cagr,
    fees: round(trades.reduce((s, t) => s + (t.fees ?? 0), 0)),
    funding: round(trades.reduce((s, t) => s + (t.funding ?? 0), 0)),
    longs: side('LONG'),
    shorts: side('SHORT'),
    tradesPerDay: days > 0 ? round(n / days, 2) : 0,
    firstAt,
    lastAt,
    days: round(days, 2),
    perPair,
    perExit: group(trades, (t) => t.why),
    perTag: group(trades, (t) => t.tag ?? 'signal'),
    daily: periods(trades, start, dayKey, 30),
    weekly: periods(trades, start, weekKey, 12),
    monthly: periods(trades, start, monthKey, 12),
  };
}

// ---- Monte Carlo ------------------------------------------------------------------------------
/**
 * Resamples the backtest's trades (with replacement, in random order) many times: how the same
 * edge could have turned out with different luck — final result and worst drop, as percentiles.
 */
export function monteCarlo(closedNewestFirst: Closed[], runs = 1000, seed = 1) {
  const r = closedNewestFirst
    .slice()
    .reverse()
    .map((t) => t.balPct / 100)
    .filter((x) => Number.isFinite(x));
  if (r.length < 5) return null;
  const rand = mulberry(seed);
  const finals: number[] = [];
  const dds: number[] = [];
  for (let k = 0; k < runs; k++) {
    let eq = 1,
      peak = 1,
      dd = 0;
    for (let i = 0; i < r.length; i++) {
      eq *= 1 + r[Math.floor(rand() * r.length)];
      if (eq > peak) peak = eq;
      dd = Math.max(dd, 1 - eq / peak);
    }
    finals.push((eq - 1) * 100);
    dds.push(dd * 100);
  }
  finals.sort((a, b) => a - b);
  dds.sort((a, b) => a - b);
  const pct = (a: number[], q: number) => +a[Math.min(a.length - 1, Math.floor(q * a.length))].toFixed(2);
  // A histogram of final results (30 bins) for the page.
  const lo = finals[0],
    hi = finals.at(-1)!;
  const bins = Array.from({ length: 30 }, () => 0);
  for (const f of finals) bins[Math.min(29, Math.floor(((f - lo) / (hi - lo || 1)) * 30))]++;
  return {
    runs,
    trades: r.length,
    final: { p5: pct(finals, 0.05), p25: pct(finals, 0.25), p50: pct(finals, 0.5), p75: pct(finals, 0.75), p95: pct(finals, 0.95) },
    maxDD: { p50: pct(dds, 0.5), p95: pct(dds, 0.95), p99: pct(dds, 0.99) },
    lossChance: +((finals.filter((f) => f < 0).length / runs) * 100).toFixed(1),
    hist: { lo: +lo.toFixed(2), hi: +hi.toFixed(2), bins },
  };
}

function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
