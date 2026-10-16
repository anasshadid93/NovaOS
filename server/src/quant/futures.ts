import fs from 'node:fs';
import path from 'node:path';

/**
 * Futures leg of the Quant Desk: Binance USDⓈ-M perpetuals, both directions, intraday.
 *
 * Pure functions (no DB) so the same code runs the historical simulation and the live paper book:
 *  - data: klines + funding history from fapi (cached on disk),
 *  - regime on a short timeframe: long while close > EMA(trend) and EMA(fast) > EMA(slow), short
 *    while the mirror holds, flat otherwise,
 *  - exits: regime flip, trailing stop from the best price (×ATR or %), liquidation,
 *  - costs like the exchange: taker fee both ways, funding every 8 h, slippage, isolated-margin
 *    liquidation at ~90 % of margin lost.
 */
export interface FBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}
export interface FParams {
  tf: '15m' | '1h' | '4h';
  emaFast: number;
  emaSlow: number;
  emaTrend: number;
  /** Trailing stop as a multiple of ATR(14) on the same timeframe. */
  trailAtr: number;
  /** Isolated leverage per position. */
  leverage: number;
  /** Margin per position as % of equity. */
  marginPct: number;
  allowShort: boolean;
  /** Bars to wait after a stop-out before re-entering the same asset. */
  cooldownBars: number;
  takerFee: number; // 0.0005
  slippage: number; // 0.0003
}
export const DEFAULT_FPARAMS: FParams = {
  tf: '1h',
  emaFast: 20,
  emaSlow: 50,
  emaTrend: 200,
  trailAtr: 3,
  leverage: 3,
  marginPct: 20,
  allowShort: true,
  cooldownBars: 6,
  takerFee: 0.0005,
  slippage: 0.0003,
};

const FAPI = process.env.MANAR_BINANCE_FAPI ?? 'https://fapi.binance.com';
const TF_MS: Record<FParams['tf'], number> = { '15m': 900_000, '1h': 3600_000, '4h': 14_400_000 };

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { 'User-Agent': 'NovaOS-Quant/1.0' } });
  if (!r.ok) throw new Error(`${url.split('?')[0]} ${r.status}`);
  return (await r.json()) as T;
}

/** All klines for a symbol/timeframe since `since`, cached in `dir` and extended incrementally. */
export async function futuresBars(dir: string, symbol: string, tf: FParams['tf'], since: number): Promise<FBar[]> {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${symbol}-${tf}.json`);
  let bars: FBar[] = [];
  try {
    bars = JSON.parse(fs.readFileSync(f, 'utf8')) as FBar[];
  } catch {
    bars = [];
  }
  let start = bars.length ? bars[bars.length - 1].t + TF_MS[tf] : since;
  const now = Date.now();
  while (start < now - TF_MS[tf]) {
    const raw = await getJson<(string | number)[][]>(`${FAPI}/fapi/v1/klines?symbol=${symbol}&interval=${tf}&startTime=${start}&limit=1500`);
    if (!raw.length) break;
    for (const k of raw) if (Number(k[6]) < now) bars.push({ t: Number(k[0]), o: Number(k[1]), h: Number(k[2]), l: Number(k[3]), c: Number(k[4]), v: Number(k[5]) });
    start = Number(raw[raw.length - 1][0]) + TF_MS[tf];
    if (raw.length < 1500) break;
    await new Promise((r) => setTimeout(r, 120));
  }
  fs.writeFileSync(f, JSON.stringify(bars));
  return bars.filter((b) => b.t >= since);
}

/** Funding history (every 8 h): [time, rate]. */
export async function fundingHistory(dir: string, symbol: string, since: number): Promise<[number, number][]> {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${symbol}-funding.json`);
  let rows: [number, number][] = [];
  try {
    rows = JSON.parse(fs.readFileSync(f, 'utf8')) as [number, number][];
  } catch {
    rows = [];
  }
  let start = rows.length ? rows[rows.length - 1][0] + 1 : since;
  while (start < Date.now() - 8 * 3600_000) {
    const raw = await getJson<{ fundingTime: number; fundingRate: string }[]>(`${FAPI}/fapi/v1/fundingRate?symbol=${symbol}&startTime=${start}&limit=1000`);
    if (!raw.length) break;
    for (const r of raw) rows.push([r.fundingTime, Number(r.fundingRate)]);
    start = raw[raw.length - 1].fundingTime + 1;
    if (raw.length < 1000) break;
    await new Promise((r) => setTimeout(r, 120));
  }
  fs.writeFileSync(f, JSON.stringify(rows));
  return rows.filter((r) => r[0] >= since);
}

// ---- Indicators (incremental) --------------------------------------------------------------------

export class Ema {
  v = 0;
  n = 0;
  constructor(readonly len: number) {}
  push(x: number) {
    this.n++;
    this.v = this.n === 1 ? x : x * (2 / (this.len + 1)) + this.v * (1 - 2 / (this.len + 1));
    return this.v;
  }
  get ready() {
    return this.n >= this.len;
  }
}
export class Atr {
  v = 0;
  n = 0;
  prevC = 0;
  constructor(readonly len = 14) {}
  push(b: FBar) {
    const tr = this.n === 0 ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - this.prevC), Math.abs(b.l - this.prevC));
    this.n++;
    this.v = this.n === 1 ? tr : (this.v * (this.len - 1) + tr) / this.len;
    this.prevC = b.c;
    return this.v;
  }
  get ready() {
    return this.n >= this.len;
  }
}

export type Side = 1 | -1;
export interface FPosition {
  side: Side;
  entry: number;
  qty: number;
  margin: number;
  leverage: number;
  best: number;
  stop: number;
  liq: number;
  openedAt: number;
}
export interface FState {
  equity: number;
  pos: FPosition | null;
  cooldownUntil: number;
  ema: { fast: Ema; slow: Ema; trend: Ema; atr: Atr };
}

/** Regime from the indicator state: 1 long, -1 short, 0 flat. */
export function regimeSignal(st: FState, close: number, allowShort: boolean): Side | 0 {
  const { fast, slow, trend } = st.ema;
  if (!trend.ready) return 0;
  if (close > trend.v && fast.v > slow.v) return 1;
  if (allowShort && close < trend.v && fast.v < slow.v) return -1;
  return 0;
}

export function liquidationPrice(side: Side, entry: number, leverage: number): number {
  // Isolated margin: lose ~90 % of margin → liquidated (maintenance margin + fees).
  return side === 1 ? entry * (1 - 0.9 / leverage) : entry * (1 + 0.9 / leverage);
}

export interface FTrade {
  side: Side;
  entry: number;
  exit: number;
  qty: number;
  pnl: number;
  fees: number;
  funding: number;
  openedAt: number;
  closedAt: number;
  reason: 'flip' | 'trail' | 'liq' | 'end';
}

/**
 * Simulates one symbol over bars. Entries/exits at bar close (flip) or intrabar (trail/liq by
 * high/low). Funding applied on the position at each funding time.
 */
export function simulate(bars: FBar[], funding: [number, number][], p: FParams, startEquity = 10_000) {
  const st: FState = { equity: startEquity, pos: null, cooldownUntil: 0, ema: { fast: new Ema(p.emaFast), slow: new Ema(p.emaSlow), trend: new Ema(p.emaTrend), atr: new Atr(14) } };
  const trades: FTrade[] = [];
  const curve: [number, number][] = [];
  let fi = 0;
  let peak = startEquity;
  let maxDd = 0;
  let fundingPaid = 0;
  let feesPaid = 0;
  const close = (b: FBar, price: number, reason: FTrade['reason'], fundingAcc: number) => {
    const pos = st.pos!;
    const px = pos.side === 1 ? price * (1 - p.slippage) : price * (1 + p.slippage);
    const gross = (px - pos.entry) * pos.qty * pos.side;
    const fee = px * pos.qty * p.takerFee;
    const pnl = Math.max(-pos.margin, gross - fee - fundingAcc);
    st.equity += pnl;
    feesPaid += fee;
    trades.push({ side: pos.side, entry: pos.entry, exit: px, qty: pos.qty, pnl, fees: fee + pos.entry * pos.qty * p.takerFee, funding: fundingAcc, openedAt: pos.openedAt, closedAt: b.t, reason });
    st.pos = null;
    if (reason === 'trail' || reason === 'liq') st.cooldownUntil = b.t + p.cooldownBars * TF_MS[p.tf];
  };
  let fundingAcc = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    // Funding events inside this bar.
    while (fi < funding.length && funding[fi][0] <= b.t + TF_MS[p.tf]) {
      if (st.pos && funding[fi][0] >= st.pos.openedAt) {
        const pay = funding[fi][1] * st.pos.qty * b.c * st.pos.side; // longs pay positive funding
        fundingAcc += pay;
        fundingPaid += pay;
      }
      fi++;
    }
    const pos = st.pos;
    if (pos) {
      // Intrabar liquidation / trailing stop (worst case first).
      if (pos.side === 1 ? b.l <= pos.liq : b.h >= pos.liq) {
        close(b, pos.liq, 'liq', fundingAcc);
        fundingAcc = 0;
      } else if (pos.side === 1 ? b.l <= pos.stop : b.h >= pos.stop) {
        close(b, pos.stop, 'trail', fundingAcc);
        fundingAcc = 0;
      } else {
        pos.best = pos.side === 1 ? Math.max(pos.best, b.h) : Math.min(pos.best, b.l);
        const trail = pos.side === 1 ? pos.best - p.trailAtr * st.ema.atr.v : pos.best + p.trailAtr * st.ema.atr.v;
        pos.stop = pos.side === 1 ? Math.max(pos.stop, trail) : Math.min(pos.stop, trail);
      }
    }
    st.ema.fast.push(b.c);
    st.ema.slow.push(b.c);
    st.ema.trend.push(b.c);
    st.ema.atr.push(b);
    const sig = regimeSignal(st, b.c, p.allowShort);
    if (st.pos && sig !== st.pos.side) {
      close(b, b.c, 'flip', fundingAcc);
      fundingAcc = 0;
    }
    if (!st.pos && sig !== 0 && b.t >= st.cooldownUntil && st.ema.atr.ready && st.equity > 10) {
      const margin = (p.marginPct / 100) * st.equity;
      const px = sig === 1 ? b.c * (1 + p.slippage) : b.c * (1 - p.slippage);
      const qty = (margin * p.leverage) / px;
      const fee = px * qty * p.takerFee;
      st.equity -= fee;
      feesPaid += fee;
      const atr = st.ema.atr.v;
      st.pos = {
        side: sig,
        entry: px,
        qty,
        margin,
        leverage: p.leverage,
        best: px,
        stop: sig === 1 ? px - p.trailAtr * atr : px + p.trailAtr * atr,
        liq: liquidationPrice(sig, px, p.leverage),
        openedAt: b.t,
      };
    }
    const unreal = st.pos ? (b.c - st.pos.entry) * st.pos.qty * st.pos.side - fundingAcc : 0;
    const eq = st.equity + unreal;
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, (peak - eq) / peak);
    if (i % Math.max(1, Math.floor(bars.length / 1500)) === 0) curve.push([b.t, Math.round(eq * 100) / 100]);
  }
  if (st.pos) close(bars[bars.length - 1], bars[bars.length - 1].c, 'end', fundingAcc);
  const wins = trades.filter((t) => t.pnl > 0);
  const gross = wins.reduce((a, t) => a + t.pnl, 0);
  const loss = -trades.filter((t) => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0);
  const days = bars.length ? (bars[bars.length - 1].t - bars[0].t) / 86400_000 : 0;
  return {
    netPct: ((st.equity - startEquity) / startEquity) * 100,
    maxDdPct: maxDd * 100,
    trades: trades.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    profitFactor: loss > 0 ? gross / loss : gross > 0 ? Infinity : 0,
    liquidations: trades.filter((t) => t.reason === 'liq').length,
    feesPaid,
    fundingPaid,
    tradesPerDay: days ? trades.length / days : 0,
    byReason: trades.reduce<Record<string, number>>((m, t) => ((m[t.reason] = (m[t.reason] ?? 0) + 1), m), {}),
    curve,
    tradesList: trades,
    endEquity: st.equity,
  };
}

/** Portfolio simulation: equal split of the start equity across symbols, each run independently. */
export function simulatePortfolio(data: { symbol: string; bars: FBar[]; funding: [number, number][] }[], p: FParams, startEquity = 10_000) {
  const per = startEquity / data.length;
  const runs = data.map((d) => ({ symbol: d.symbol, ...simulate(d.bars, d.funding, p, per) }));
  const end = runs.reduce((a, r) => a + r.endEquity, 0);
  // Combined curve: sum per-asset curves on the union of timestamps (nearest previous value).
  const times = [...new Set(runs.flatMap((r) => r.curve.map((c) => c[0])))].sort((a, b) => a - b);
  const idx = runs.map(() => 0);
  const last = runs.map(() => per);
  const curve: [number, number][] = [];
  let peak = startEquity;
  let maxDd = 0;
  for (const t of times) {
    let sum = 0;
    runs.forEach((r, k) => {
      while (idx[k] < r.curve.length && r.curve[idx[k]][0] <= t) last[k] = r.curve[idx[k]++][1];
      sum += last[k];
    });
    peak = Math.max(peak, sum);
    maxDd = Math.max(maxDd, (peak - sum) / peak);
    curve.push([t, Math.round(sum * 100) / 100]);
  }
  return {
    netPct: ((end - startEquity) / startEquity) * 100,
    maxDdPct: maxDd * 100,
    trades: runs.reduce((a, r) => a + r.trades, 0),
    liquidations: runs.reduce((a, r) => a + r.liquidations, 0),
    winRate:
      runs.reduce((a, r) => a + r.winRate * r.trades, 0) /
      Math.max(
        1,
        runs.reduce((a, r) => a + r.trades, 0),
      ),
    tradesPerDay: runs.reduce((a, r) => a + r.tradesPerDay, 0),
    feesPaid: runs.reduce((a, r) => a + r.feesPaid, 0),
    fundingPaid: runs.reduce((a, r) => a + r.fundingPaid, 0),
    perSymbol: runs.map((r) => ({ symbol: r.symbol, netPct: r.netPct, maxDdPct: r.maxDdPct, trades: r.trades, winRate: r.winRate, liquidations: r.liquidations })),
    curve: curve.filter((_, i, a) => i % Math.max(1, Math.floor(a.length / 1500)) === 0),
  };
}
