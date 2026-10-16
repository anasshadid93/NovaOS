import { createHash } from 'node:crypto';
import { audit, getDb } from '../db.js';
import { tradingNotice } from '../notify/trading.js';
import { marketView } from '../news/news.js';
import { dailyBars, quotes, technical, tradeable, type Quote } from './market.js';
import { getSettings, type QuantSettings, type RiskLimits } from './settings.js';

/**
 * The decision engine: merges the signal bus into one score per asset, applies the risk rules
 * (which no AI can override), and routes orders to the active executor. Long-only spot.
 *
 * Score per asset = Σ weight × source score, where a source counts only while its latest signal
 * is unexpired. Sources: 'technical' (rules, computed here), 'agents' (TradingAgents debate),
 * 'news' (News Trader market mood). Confidence scales each contribution.
 */
export type Mode = 'paper' | 'live';
export interface Signal {
  id: number;
  at: number;
  source: string;
  asset: string;
  score: number;
  confidence: number;
  horizon_h: number;
  expires_at: number;
  detail: string | null;
}
export interface Position {
  id: number;
  mode: Mode;
  asset: string;
  qty: number;
  entry: number;
  opened_at: number;
  stop: number;
  target: number | null;
  high: number;
  deadline: number | null;
  closed_at: number | null;
  exit: number | null;
  pnl: number | null;
  reason: string | null;
  score: number | null;
  detail: string | null;
}
export interface Merged {
  asset: string;
  score: number;
  parts: Record<string, { score: number; confidence: number; at: number; weight: number }>;
  vetoed?: string;
}

const FEE = 0.001; // 0.1 % taker, both ways (paper)
const SLIP = 0.0005;

export function publishSignal(source: string, asset: string, score: number, confidence: number, horizonH: number, ttlMs: number, detail: unknown, ref: string, price?: number, priceSource?: string) {
  getDb()
    .prepare('INSERT OR REPLACE INTO quant_signals(at, source, asset, score, confidence, horizon_h, expires_at, price, price_source, detail, ref) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(
      Date.now(),
      source,
      asset,
      Math.max(-1, Math.min(1, score)),
      Math.max(0, Math.min(1, confidence)),
      horizonH,
      Date.now() + ttlMs,
      price ?? null,
      priceSource ?? null,
      JSON.stringify(detail),
      ref,
    );
}

/** Latest unexpired signal per (asset, source). */
export function latestSignals(assets: string[], now = Date.now()): Signal[] {
  const rows = getDb()
    .prepare(
      `SELECT s.* FROM quant_signals s JOIN (SELECT asset, source, MAX(at) AS at FROM quant_signals WHERE expires_at > ? GROUP BY asset, source) m
       ON m.asset = s.asset AND m.source = s.source AND m.at = s.at ORDER BY s.asset, s.source`,
    )
    .all(now) as unknown as Signal[];
  return rows.filter((r) => assets.includes(r.asset));
}

/** The technical leg: compute from daily bars and publish (valid 26 h, refreshed hourly). */
export async function refreshTechnical(assets: string[]): Promise<void> {
  for (const a of assets) {
    try {
      const bars = await dailyBars(a, 400);
      const t = technical(bars);
      if (!t) continue;
      const day = new Date().toISOString().slice(0, 13); // hourly ref → at most one row per hour
      publishSignal('technical', a, t.score, 0.8, 24 * 10, 26 * 3600_000, { ...t.detail, atrPct: Math.round(t.atrPct * 100) / 100 }, `${a}:${day}`);
    } catch {
      /* keep the previous signal until it expires */
    }
  }
}

/** The news leg: the News Trader's market mood (decayed sentiment) as a signal. */
export function refreshNews(assets: string[]): void {
  let view: ReturnType<typeof marketView> = {};
  try {
    view = marketView();
  } catch {
    return;
  }
  for (const a of assets) {
    const v = view[a as keyof typeof view];
    if (!v || !v.n) continue;
    // Mood scores run roughly −3..3; squash to [−1, 1]. Confidence grows with the number of events.
    const score = Math.tanh(v.score / 1.5);
    const conf = Math.min(1, 0.4 + 0.1 * v.n);
    const hour = new Date().toISOString().slice(0, 13);
    publishSignal('news', a, score, conf, 48, 3 * 3600_000, { n: v.n, drivers: v.drivers.slice(0, 5), raw: v.score }, `${a}:${hour}`);
  }
}

export function merge(assets: string[], s: QuantSettings, now = Date.now()): Merged[] {
  const sigs = latestSignals(assets, now);
  return assets.map((asset) => {
    const parts: Merged['parts'] = {};
    let num = 0;
    let den = 0;
    let vetoed: string | undefined;
    for (const sig of sigs) {
      if (sig.asset !== asset) continue;
      const w = (s.weights as Record<string, number>)[sig.source] ?? 0;
      if (w <= 0) continue;
      parts[sig.source] = { score: sig.score, confidence: sig.confidence, at: sig.at, weight: w };
      num += w * sig.confidence * sig.score;
      den += w * sig.confidence;
      // A decisive Sell from the debate vetoes new longs regardless of the other legs.
      if (sig.source === 'agents' && sig.score <= -0.9) vetoed = 'agents_sell';
    }
    // Without the technical leg there is no trade: the rules leg must be present.
    const score = den > 0 && parts.technical ? num / den : 0;
    return { asset, score: Math.round(score * 1000) / 1000, parts, vetoed };
  });
}

// ---- Book --------------------------------------------------------------------------------------

export function openPositions(mode: Mode): Position[] {
  return getDb().prepare('SELECT * FROM quant_positions WHERE mode = ? AND closed_at IS NULL ORDER BY opened_at').all(mode) as unknown as Position[];
}
export function closedPositions(mode: Mode, limit = 200): Position[] {
  return getDb().prepare('SELECT * FROM quant_positions WHERE mode = ? AND closed_at IS NOT NULL ORDER BY closed_at DESC LIMIT ?').all(mode, limit) as unknown as Position[];
}

export function cash(mode: Mode, start: number): number {
  const db = getDb();
  const r = db.prepare("SELECT COALESCE(SUM(CASE WHEN side = 'buy' THEN -(notional + fee) ELSE notional - fee END), 0) AS flow FROM quant_orders WHERE mode = ? AND status = 'filled'").get(mode) as {
    flow: number;
  };
  return start + r.flow;
}

export function equity(mode: Mode, start: number, q: Record<string, Quote>): { equity: number; cash: number; exposure: number; unrealised: number } {
  const c = cash(mode, start);
  let exposure = 0;
  let unreal = 0;
  for (const p of openPositions(mode)) {
    const px = q[p.asset]?.price ?? p.entry;
    exposure += p.qty * px;
    unreal += p.qty * (px - p.entry);
  }
  return { equity: c + exposure, cash: c, exposure, unrealised: unreal };
}

function dayPnl(mode: Mode, now: number): number {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  const r = getDb().prepare('SELECT COALESCE(SUM(pnl), 0) AS pnl FROM quant_positions WHERE mode = ? AND closed_at >= ?').get(mode, start.getTime()) as { pnl: number };
  return r.pnl;
}

function lastLossAt(mode: Mode, asset: string): number {
  const r = getDb().prepare('SELECT MAX(closed_at) AS t FROM quant_positions WHERE mode = ? AND asset = ? AND pnl < 0').get(mode, asset) as { t: number | null };
  return r.t ?? 0;
}

/** Executor interface: paper fills here; live goes through live.ts (which must be authorised). */
export interface Fill {
  price: number;
  fee: number;
}
export type Executor = (mode: Mode, asset: string, side: 'buy' | 'sell', qty: number, ref: number) => Promise<Fill>;

export const paperExecutor: Executor = async (_mode, _asset, side, qty, ref) => {
  const price = side === 'buy' ? ref * (1 + SLIP) : ref * (1 - SLIP);
  return { price, fee: qty * price * FEE };
};

let liveExecutor: Executor | null = null;
export function setLiveExecutor(e: Executor | null) {
  liveExecutor = e;
}

const idem = (parts: unknown[]) => createHash('sha1').update(JSON.stringify(parts)).digest('hex').slice(0, 24);

async function place(
  mode: Mode,
  asset: string,
  side: 'buy' | 'sell',
  qty: number,
  ref: number,
  reason: string,
  key: string,
  signals: unknown,
  positionId: number | null,
): Promise<{ orderId: number; fill: Fill } | null> {
  const db = getDb();
  const idemKey = idem([mode, asset, side, key]);
  // Idempotency: the same decision can never be filled twice (restart, overlapping loops, retries).
  const dup = db.prepare('SELECT id FROM quant_orders WHERE idem = ?').get(idemKey) as { id: number } | undefined;
  if (dup) return null;
  const exec = mode === 'paper' ? paperExecutor : liveExecutor;
  if (!exec) throw new Error('no_live_executor');
  const res = db
    .prepare("INSERT INTO quant_orders(at, mode, asset, side, qty, price, notional, fee, reason, idem, position_id, signals, status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'pending')")
    .run(Date.now(), mode, asset, side, qty, ref, qty * ref, 0, reason, idemKey, positionId, JSON.stringify(signals ?? null));
  const orderId = Number(res.lastInsertRowid);
  try {
    const fill = await exec(mode, asset, side, qty, ref);
    db.prepare("UPDATE quant_orders SET price = ?, notional = ?, fee = ?, status = 'filled' WHERE id = ?").run(fill.price, qty * fill.price, fill.fee, orderId);
    return { orderId, fill };
  } catch (e) {
    db.prepare("UPDATE quant_orders SET status = 'failed', reason = ? WHERE id = ?").run(`${reason}: ${(e as Error).message}`.slice(0, 200), orderId);
    audit(null, 'quant_order_failed', { mode, asset, side, qty, error: (e as Error).message });
    return null;
  }
}

export interface StepResult {
  opened: { asset: string; qty: number; price: number }[];
  closed: { asset: string; pnl: number; reason: string }[];
  skipped: { asset: string; why: string }[];
  merged: Merged[];
  quotes: Record<string, Quote>;
}

let stepping = false;

/**
 * One engine step: refresh quotes, manage open positions (stop/target/trail/deadline/exit score),
 * then consider entries. Never runs twice at once.
 */
export async function step(mode: Mode, now = Date.now()): Promise<StepResult | null> {
  if (stepping) return null;
  stepping = true;
  try {
    const s = getSettings();
    const R = s.risk;
    const q = await quotes(s.assets);
    const merged = merge(s.assets, s, now);
    const out: StepResult = { opened: [], closed: [], skipped: [], merged, quotes: q };
    const open = openPositions(mode);

    // 1. Manage what is open.
    for (const p of open) {
      const quote = q[p.asset];
      const ok = tradeable(quote, now, R.maxPriceAgeSec, R.maxSourceGapPct);
      if (!ok.ok) {
        out.skipped.push({ asset: p.asset, why: `manage:${ok.why}` });
        continue;
      }
      const px = quote!.price;
      const db = getDb();
      if (px > p.high) {
        p.high = px;
        db.prepare('UPDATE quant_positions SET high = ? WHERE id = ?').run(px, p.id);
      }
      // Trailing stop: once the trade is trailArmR × risk in profit, the stop follows the high.
      const riskPerUnit = p.entry - p.stop;
      const atrAbs = Number(JSON.parse(p.detail ?? '{}').atrAbs ?? riskPerUnit / R.stopAtr);
      if (riskPerUnit > 0 && p.high - p.entry >= R.trailArmR * riskPerUnit) {
        const trail = p.high - R.trailAtr * atrAbs;
        if (trail > p.stop) {
          p.stop = trail;
          db.prepare('UPDATE quant_positions SET stop = ? WHERE id = ?').run(trail, p.id);
        }
      }
      const m = merged.find((x) => x.asset === p.asset);
      let reason: string | null = null;
      if (px <= p.stop) reason = 'stop';
      else if (p.target && px >= p.target) reason = 'target';
      else if (p.deadline && now >= p.deadline) reason = 'deadline';
      else if (m && m.score <= R.exitScore && m.parts.technical) reason = 'score';
      else if (m?.vetoed) reason = m.vetoed;
      if (reason) {
        const r = await closePosition(mode, p, px, reason, `${p.id}:${reason}:${Math.floor(now / 60_000)}`);
        if (r) out.closed.push({ asset: p.asset, pnl: r, reason });
      }
    }

    // 2. Entries.
    const enabled = mode === 'paper' ? s.paperEnabled : s.live.enabled && !s.live.killSwitch;
    if (!enabled) {
      out.skipped.push({ asset: '*', why: 'disabled' });
      return out;
    }
    const eq = equity(mode, R.startBalance, q);
    if (eq.equity <= 0) return out;
    const dp = dayPnl(mode, now) + eq.unrealised;
    if (dp <= -(R.dailyLossPct / 100) * eq.equity) {
      out.skipped.push({ asset: '*', why: 'daily_loss' });
      return out;
    }
    const held = new Set(openPositions(mode).map((p) => p.asset));
    const ranked = merged.filter((m) => !held.has(m.asset)).sort((a, b) => b.score - a.score);
    for (const m of ranked) {
      if (openPositions(mode).length >= R.maxOpen) {
        out.skipped.push({ asset: m.asset, why: 'max_open' });
        break;
      }
      if (m.score < R.entryScore) {
        out.skipped.push({ asset: m.asset, why: 'score' });
        continue;
      }
      if (m.vetoed) {
        out.skipped.push({ asset: m.asset, why: m.vetoed });
        continue;
      }
      const quote = q[m.asset];
      const ok = tradeable(quote, now, R.maxPriceAgeSec, R.maxSourceGapPct);
      if (!ok.ok) {
        out.skipped.push({ asset: m.asset, why: ok.why! });
        continue;
      }
      if (now - lastLossAt(mode, m.asset) < R.cooldownMin * 60_000) {
        out.skipped.push({ asset: m.asset, why: 'cooldown' });
        continue;
      }
      const px = quote!.price;
      const atrPct = Number(m.parts.technical ? (JSON.parse(latestSignals([m.asset], now).find((x) => x.source === 'technical')?.detail ?? '{}').atrPct ?? 3) : 3);
      const stopPct = Math.min(R.stopMaxPct, Math.max(R.stopMinPct, R.stopAtr * atrPct));
      // Risk-based size, then the per-position and total-exposure caps.
      const eqNow = equity(mode, R.startBalance, q);
      let notional = ((R.riskPct / 100) * eqNow.equity) / (stopPct / 100);
      notional = Math.min(notional, (R.maxPositionPct / 100) * eqNow.equity, (R.maxExposurePct / 100) * eqNow.equity - eqNow.exposure, eqNow.cash * 0.98);
      if (mode === 'live') notional = Math.min(notional, s.live.maxNotionalUsd);
      if (notional < 10) {
        out.skipped.push({ asset: m.asset, why: 'exposure' });
        continue;
      }
      const qty = Number((notional / px).toPrecision(6));
      // Idempotency key: same asset, hour and score can only fill once — unless an order has happened since (re-entry after a close).
      const nOrders = (getDb().prepare('SELECT COUNT(*) AS n FROM quant_orders WHERE mode = ? AND asset = ?').get(mode, m.asset) as { n: number }).n;
      const key = `${m.asset}:${Math.floor(now / 3600_000)}:${m.score}:${nOrders}`;
      const placed = await place(mode, m.asset, 'buy', qty, px, 'entry', key, m.parts, null);
      if (!placed) continue;
      const db = getDb();
      // Stop and target are measured from the actual fill, not the reference quote.
      const stop = placed.fill.price * (1 - stopPct / 100);
      const target = placed.fill.price * (1 + (stopPct * R.takeProfitR) / 100);
      const detail = { atrAbs: px * (atrPct / 100), stopPct, parts: m.parts, price: { source: quote!.source, check: quote!.check } };
      const res = db
        .prepare('INSERT INTO quant_positions(mode, asset, qty, entry, opened_at, stop, target, high, deadline, score, detail) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(mode, m.asset, qty, placed.fill.price, now, stop, target, placed.fill.price, now + R.maxHoldDays * 86400_000, m.score, JSON.stringify(detail));
      db.prepare('UPDATE quant_orders SET position_id = ? WHERE id = ?').run(Number(res.lastInsertRowid), placed.orderId);
      audit(null, 'quant_open', { mode, asset: m.asset, qty, price: placed.fill.price, stop, target, score: m.score, parts: m.parts });
      tradingNotice(
        `🟢 Quant Desk bought ${m.asset} at ${placed.fill.price.toFixed(2)} ($${(qty * placed.fill.price).toFixed(0)} ${mode})\nstop ${stop.toFixed(2)} · target ${target.toFixed(2)} · score ${m.score}`,
      );
      out.opened.push({ asset: m.asset, qty, price: placed.fill.price });
      held.add(m.asset);
    }
    return out;
  } finally {
    stepping = false;
  }
}

/** Closes a position at `px` (market). Returns realised PnL, or null if the order was a duplicate/failed. */
export async function closePosition(mode: Mode, p: Position, px: number, reason: string, key: string): Promise<number | null> {
  const placed = await place(mode, p.asset, 'sell', p.qty, px, reason, key, null, p.id);
  if (!placed) return null;
  const entryFee = (getDb().prepare("SELECT fee FROM quant_orders WHERE position_id = ? AND side = 'buy' AND status = 'filled'").get(p.id) as { fee: number } | undefined)?.fee ?? 0;
  const pnl = p.qty * (placed.fill.price - p.entry) - placed.fill.fee - entryFee;
  getDb().prepare('UPDATE quant_positions SET closed_at = ?, exit = ?, pnl = ?, reason = ? WHERE id = ? AND closed_at IS NULL').run(Date.now(), placed.fill.price, pnl, reason, p.id);
  audit(null, 'quant_close', { mode, asset: p.asset, qty: p.qty, entry: p.entry, exit: placed.fill.price, pnl, reason });
  tradingNotice(`${pnl >= 0 ? '✅' : '❌'} Quant Desk sold ${p.asset} (${reason}) ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${(((placed.fill.price - p.entry) / p.entry) * 100).toFixed(1)}%)`);
  return pnl;
}

export function snapshotEquity(mode: Mode, q: Record<string, Quote>) {
  const s = getSettings();
  const e = equity(mode, s.risk.startBalance, q);
  const slot = Math.floor(Date.now() / 600_000) * 600_000;
  getDb().prepare('INSERT OR REPLACE INTO quant_equity(mode, at, equity, cash, exposure) VALUES(?,?,?,?,?)').run(mode, slot, e.equity, e.cash, e.exposure);
  return e;
}

export function performance(mode: Mode, start: number) {
  const closed = getDb().prepare('SELECT pnl, opened_at, closed_at, reason FROM quant_positions WHERE mode = ? AND closed_at IS NOT NULL ORDER BY closed_at').all(mode) as {
    pnl: number;
    opened_at: number;
    closed_at: number;
    reason: string;
  }[];
  const wins = closed.filter((c) => c.pnl > 0);
  const losses = closed.filter((c) => c.pnl <= 0);
  const gross = wins.reduce((a, c) => a + c.pnl, 0);
  const lossSum = -losses.reduce((a, c) => a + c.pnl, 0);
  const curve = getDb().prepare('SELECT at, equity FROM quant_equity WHERE mode = ? ORDER BY at').all(mode) as { at: number; equity: number }[];
  let peak = start;
  let maxDd = 0;
  for (const c of curve) {
    peak = Math.max(peak, c.equity);
    maxDd = Math.max(maxDd, (peak - c.equity) / peak);
  }
  const rets: number[] = [];
  for (let i = 1; i < curve.length; i++) if (curve[i - 1].equity > 0) rets.push(curve[i].equity / curve[i - 1].equity - 1);
  const mean = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
  const sd = rets.length > 1 ? Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1)) : 0;
  const perYear = (365 * 24 * 6) ** 0.5; // 10-minute slots
  return {
    trades: closed.length,
    winRate: closed.length ? wins.length / closed.length : 0,
    profitFactor: lossSum > 0 ? gross / lossSum : gross > 0 ? Infinity : 0,
    avgWin: wins.length ? gross / wins.length : 0,
    avgLoss: losses.length ? lossSum / losses.length : 0,
    realised: closed.reduce((a, c) => a + c.pnl, 0),
    maxDrawdownPct: maxDd * 100,
    sharpe: sd > 0 ? (mean / sd) * perYear : 0,
    byReason: closed.reduce<Record<string, number>>((m, c) => ((m[c.reason] = (m[c.reason] ?? 0) + 1), m), {}),
    curve: curve.slice(-1500),
  };
}

export type { RiskLimits };
