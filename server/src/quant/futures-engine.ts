import path from 'node:path';
import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { audit, getDb } from '../db.js';
import { tradingNotice } from '../notify/trading.js';
import { Atr, Ema, fundingHistory, futuresBars, liquidationPrice, type FBar, type FParams, type Side } from './futures.js';
import { MARKETS, quotes } from './market.js';
import { getSettings } from './settings.js';

/**
 * Live paper book for perpetual futures. Same rules as futures.ts's simulation:
 *  - every closed bar of the chosen timeframe: recompute the regime (EMA trend/fast/slow) and
 *    flip / open positions at the bar close,
 *  - every minute: mark price from Binance futures (cross-checked against spot), trailing stop and
 *    liquidation on the live price, funding applied at each funding time.
 * Positions live in quant_positions with mode 'futures'; `detail` carries side, leverage, margin,
 * liquidation price and accrued funding. Equity = start + Σ realised + Σ unrealised.
 */
const MODE = 'futures';
const FAPI = process.env.MANAR_BINANCE_FAPI ?? 'https://fapi.binance.com';
const TF_MS = { '1h': 3600_000, '4h': 14_400_000 } as const;
const cacheDir = () => path.join(config.dataDir, 'quant-cache', 'futures');

interface Detail {
  side: Side;
  leverage: number;
  margin: number;
  liq: number;
  fundingAcc: number;
  entryFee: number;
  tf: string;
  atr: number;
  lastFunding: number;
}
export interface FPos {
  id: number;
  asset: string;
  qty: number;
  entry: number;
  opened_at: number;
  stop: number;
  high: number;
  closed_at: number | null;
  exit: number | null;
  pnl: number | null;
  reason: string | null;
  detail: string | null;
}
interface Mark {
  asset: string;
  mark: number;
  index: number;
  at: number;
  fundingRate: number;
  nextFunding: number;
  spotGapPct: number | null;
}

let marks: Record<string, Mark> = {};
let lastBar: Record<string, number> = {};
let regimes: Record<string, { signal: Side | 0; atr: number; emaFast: number; emaSlow: number; emaTrend: number; close: number; at: number }> = {};
let cooldown: Record<string, number> = {};
let lastError: string | null = null;
let busy = false;

export const futuresState = () => ({ marks, regimes, lastError });

function params(): FParams & { tf: '1h' | '4h' } {
  const f = getSettings().futures;
  return {
    tf: f.tf,
    emaFast: f.emaFast,
    emaSlow: f.emaSlow,
    emaTrend: f.emaTrend,
    trailAtr: f.trailAtr,
    leverage: f.leverage,
    marginPct: f.marginPct,
    allowShort: f.allowShort,
    cooldownBars: f.cooldownBars,
    takerFee: 0.0005,
    slippage: 0.0003,
  };
}
const sym = (asset: string) => MARKETS[asset]?.binance;

export function openFutures(): (FPos & { d: Detail })[] {
  return (getDb().prepare('SELECT * FROM quant_positions WHERE mode = ? AND closed_at IS NULL ORDER BY opened_at').all(MODE) as unknown as FPos[]).map((p) => ({
    ...p,
    d: JSON.parse(p.detail ?? '{}') as Detail,
  }));
}
export function closedFutures(limit = 200): FPos[] {
  return getDb().prepare('SELECT * FROM quant_positions WHERE mode = ? AND closed_at IS NOT NULL ORDER BY closed_at DESC LIMIT ?').all(MODE, limit) as unknown as FPos[];
}

export function futuresEquity() {
  const start = getSettings().futures.startBalance;
  const realised = (getDb().prepare('SELECT COALESCE(SUM(pnl), 0) AS s FROM quant_positions WHERE mode = ? AND closed_at IS NOT NULL').get(MODE) as { s: number }).s;
  let unreal = 0;
  let margin = 0;
  for (const p of openFutures()) {
    const px = marks[p.asset]?.mark ?? p.entry;
    unreal += (px - p.entry) * p.qty * p.d.side - p.d.fundingAcc - p.d.entryFee;
    margin += p.d.margin;
  }
  return { equity: start + realised + unreal, cash: start + realised - margin, exposure: margin, unrealised: unreal, realised };
}

async function refreshMarks(assets: string[]): Promise<void> {
  const spot = await quotes(assets).catch(() => ({}) as Awaited<ReturnType<typeof quotes>>);
  const next: Record<string, Mark> = {};
  for (const a of assets) {
    const s = sym(a);
    if (!s) continue;
    try {
      const r = await fetch(`${FAPI}/fapi/v1/premiumIndex?symbol=${s}`, { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'NovaOS-Quant/1.0' } });
      if (!r.ok) continue;
      const j = (await r.json()) as { markPrice: string; indexPrice: string; lastFundingRate: string; nextFundingTime: number; time: number };
      const mark = Number(j.markPrice);
      const sp = spot[a]?.price;
      next[a] = {
        asset: a,
        mark,
        index: Number(j.indexPrice),
        at: Number(j.time) || Date.now(),
        fundingRate: Number(j.lastFundingRate),
        nextFunding: Number(j.nextFundingTime),
        spotGapPct: sp ? (Math.abs(mark - sp) / sp) * 100 : null,
      };
    } catch {
      /* keep the old mark; it will be too old to trade on */
    }
  }
  marks = { ...marks, ...next };
}

const safeMark = (a: string, now: number): Mark | null => {
  const m = marks[a];
  if (!m || now - m.at > 120_000) return null;
  if (m.spotGapPct !== null && m.spotGapPct > 1.5) return null; // futures and spot disagree: do not trade
  return m;
};

const idem = (parts: unknown[]) => createHash('sha1').update(JSON.stringify(parts)).digest('hex').slice(0, 24);

function order(asset: string, side: 'buy' | 'sell', qty: number, price: number, fee: number, reason: string, key: string, positionId: number | null): number | null {
  const db = getDb();
  const k = idem([MODE, asset, side, key]);
  if (db.prepare('SELECT id FROM quant_orders WHERE idem = ?').get(k)) return null;
  const r = db
    .prepare("INSERT INTO quant_orders(at, mode, asset, side, qty, price, notional, fee, reason, idem, position_id, signals, status) VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL,'filled')")
    .run(Date.now(), MODE, asset, side, qty, price, qty * price, fee, reason, k, positionId);
  return Number(r.lastInsertRowid);
}

async function closeAt(p: FPos & { d: Detail }, price: number, reason: string, key: string): Promise<number | null> {
  const P = params();
  const px = p.d.side === 1 ? price * (1 - P.slippage) : price * (1 + P.slippage);
  const fee = px * p.qty * P.takerFee;
  const gross = (px - p.entry) * p.qty * p.d.side;
  const pnl = Math.max(-p.d.margin, gross - fee - p.d.fundingAcc - p.d.entryFee);
  const oid = order(p.asset, p.d.side === 1 ? 'sell' : 'buy', p.qty, px, fee, reason, key, p.id);
  if (oid === null) return null;
  getDb().prepare('UPDATE quant_positions SET closed_at = ?, exit = ?, pnl = ?, reason = ? WHERE id = ? AND closed_at IS NULL').run(Date.now(), px, pnl, reason, p.id);
  audit(null, 'quant_futures_close', { asset: p.asset, side: p.d.side, entry: p.entry, exit: px, pnl, reason, leverage: p.d.leverage });
  tradingNotice(
    `${pnl >= 0 ? '✅' : '❌'} Futures ${p.d.side === 1 ? 'long' : 'short'} ${p.asset} closed (${reason}) ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${(((px - p.entry) / p.entry) * 100 * p.d.side * p.d.leverage).toFixed(1)}% on margin)`,
  );
  if (reason === 'trail' || reason === 'liq') cooldown[p.asset] = Date.now() + P.cooldownBars * TF_MS[P.tf];
  return pnl;
}

function openAt(asset: string, side: Side, price: number, atr: number, key: string): boolean {
  const P = params();
  const eq = futuresEquity();
  const margin = (P.marginPct / 100) * eq.equity;
  if (margin < 10 || eq.cash < margin) return false;
  const px = side === 1 ? price * (1 + P.slippage) : price * (1 - P.slippage);
  const qty = Number(((margin * P.leverage) / px).toPrecision(6));
  const fee = px * qty * P.takerFee;
  const oid = order(asset, side === 1 ? 'buy' : 'sell', qty, px, fee, 'entry', key, null);
  if (oid === null) return false;
  const d: Detail = { side, leverage: P.leverage, margin, liq: liquidationPrice(side, px, P.leverage), fundingAcc: 0, entryFee: fee, tf: P.tf, atr, lastFunding: Date.now() };
  const stop = side === 1 ? px - P.trailAtr * atr : px + P.trailAtr * atr;
  const r = getDb()
    .prepare('INSERT INTO quant_positions(mode, asset, qty, entry, opened_at, stop, target, high, deadline, score, detail) VALUES(?,?,?,?,?,?,NULL,?,NULL,NULL,?)')
    .run(MODE, asset, qty, px, Date.now(), stop, px, JSON.stringify(d));
  getDb().prepare('UPDATE quant_orders SET position_id = ? WHERE id = ?').run(Number(r.lastInsertRowid), oid);
  audit(null, 'quant_futures_open', { asset, side, price: px, qty, margin, leverage: P.leverage, stop, liq: d.liq });
  tradingNotice(`${side === 1 ? '🟢 Long' : '🔴 Short'} ${asset} futures at ${px.toFixed(2)} (${P.leverage}x, $${margin.toFixed(0)} margin, paper)\nstop ${stop.toFixed(2)} · liq ${d.liq.toFixed(2)}`);
  return true;
}

/** Bar step: on each closed bar, recompute the regime per asset and flip/open. */
async function barStep(now: number): Promise<void> {
  const P = params();
  const f = getSettings().futures;
  const tfMs = TF_MS[P.tf];
  const curBar = Math.floor(now / tfMs) * tfMs; // bar that just closed starts at curBar - tfMs
  for (const a of f.assets) {
    const s = sym(a);
    if (!s || lastBar[a] === curBar) continue;
    try {
      const bars = await futuresBars(cacheDir(), s, P.tf, now - 800 * tfMs);
      const closed = bars.filter((b) => b.t + tfMs <= now);
      if (closed.length < P.emaTrend + 5) continue;
      const fast = new Ema(P.emaFast);
      const slow = new Ema(P.emaSlow);
      const trend = new Ema(P.emaTrend);
      const atr = new Atr(14);
      for (const b of closed) {
        fast.push(b.c);
        slow.push(b.c);
        trend.push(b.c);
        atr.push(b);
      }
      const last = closed[closed.length - 1];
      const signal: Side | 0 = last.c > trend.v && fast.v > slow.v ? 1 : P.allowShort && last.c < trend.v && fast.v < slow.v ? -1 : 0;
      regimes[a] = { signal, atr: atr.v, emaFast: fast.v, emaSlow: slow.v, emaTrend: trend.v, close: last.c, at: last.t };
      lastBar[a] = curBar;
      const m = safeMark(a, now);
      const price = m?.mark ?? last.c;
      const pos = openFutures().find((p) => p.asset === a);
      if (pos && signal !== pos.d.side) await closeAt(pos, price, 'flip', `${pos.id}:flip:${curBar}`);
      const stillOpen = openFutures().some((p) => p.asset === a);
      if (!stillOpen && signal !== 0 && f.enabled && m && (cooldown[a] ?? 0) <= now) openAt(a, signal, price, atr.v, `${a}:${signal}:${curBar}`);
    } catch (e) {
      lastError = `${a}: ${(e as Error).message}`.slice(0, 200);
    }
  }
}

/** Minute step: marks, funding, trailing stop and liquidation on the live price. */
export async function futuresStep(now = Date.now()): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const f = getSettings().futures;
    await refreshMarks(f.assets);
    const P = params();
    for (const p of openFutures()) {
      const m = safeMark(p.asset, now);
      if (!m) continue;
      const db = getDb();
      // Funding: apply once per funding time that has passed since the last one applied.
      if (m.nextFunding && p.d.lastFunding < m.nextFunding - 8 * 3600_000 && now >= m.nextFunding - 8 * 3600_000) {
        p.d.fundingAcc += m.fundingRate * p.qty * m.mark * p.d.side;
        p.d.lastFunding = m.nextFunding - 8 * 3600_000;
        db.prepare('UPDATE quant_positions SET detail = ? WHERE id = ?').run(JSON.stringify(p.d), p.id);
      }
      const px = m.mark;
      if (p.d.side === 1 ? px <= p.d.liq : px >= p.d.liq) {
        await closeAt(p, p.d.liq, 'liq', `${p.id}:liq`);
        continue;
      }
      if (p.d.side === 1 ? px <= p.stop : px >= p.stop) {
        await closeAt(p, p.stop, 'trail', `${p.id}:trail:${Math.floor(now / 60_000)}`);
        continue;
      }
      const best = p.d.side === 1 ? Math.max(p.high, px) : Math.min(p.high, px);
      const trail = p.d.side === 1 ? best - P.trailAtr * p.d.atr : best + P.trailAtr * p.d.atr;
      const stop = p.d.side === 1 ? Math.max(p.stop, trail) : Math.min(p.stop, trail);
      if (best !== p.high || stop !== p.stop) db.prepare('UPDATE quant_positions SET high = ?, stop = ? WHERE id = ?').run(best, stop, p.id);
    }
    await barStep(now);
    const e = futuresEquity();
    const slot = Math.floor(now / 600_000) * 600_000;
    getDb().prepare('INSERT OR REPLACE INTO quant_equity(mode, at, equity, cash, exposure) VALUES(?,?,?,?,?)').run(MODE, slot, e.equity, e.cash, e.exposure);
  } finally {
    busy = false;
  }
}

export async function closeFuturesManual(id: number, userId: number): Promise<number | null> {
  const p = openFutures().find((x) => x.id === id);
  if (!p) return null;
  await refreshMarks([p.asset]);
  const m = marks[p.asset];
  if (!m) throw new Error('no_price');
  const pnl = await closeAt(p, m.mark, 'manual', `${p.id}:manual:${userId}:${Date.now()}`);
  audit(userId, 'quant_futures_manual_close', { id, asset: p.asset, pnl });
  return pnl;
}

/** Loads bars for the research/backtest route (cached). */
export async function futuresData(assets: string[], tf: '1h' | '4h', since: number, until: number) {
  const out: { symbol: string; bars: FBar[]; funding: [number, number][] }[] = [];
  for (const a of assets) {
    const s = sym(a);
    if (!s) continue;
    const tfMs = TF_MS[tf];
    const bars = (await futuresBars(cacheDir(), s, tf, Date.parse('2020-06-01'))).filter((b) => b.t >= since - 220 * tfMs && b.t < until);
    const funding = (await fundingHistory(cacheDir(), s, Date.parse('2020-06-01'))).filter((x) => x[0] >= since && x[0] < until);
    out.push({ symbol: a, bars, funding });
  }
  return out;
}
