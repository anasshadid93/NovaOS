import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { ASSETS, TRADABLE, playFor, type Asset, type EventType, type Playbook } from './playbook.js';

/**
 * The paper account of the News Trader and its rules. Pure decisions in `decide()` / `manage()`,
 * so they can be unit-tested; the state is one JSON file in var/.
 *
 * Rules (chosen by the owner): 5% of balance per trade, at most 3 open, stop-loss 4%, target the
 * playbook's average move capped at 8% (never below 3%), a 3% trailing stop once +3% is reached,
 * a time stop at the event horizon, a 3% daily loss cap, one trade per event, long-only on spot.
 */
export interface Position {
  id: number;
  asset: Asset;
  symbol: string;
  eventId: number;
  type: EventType;
  headline: string;
  entry: number;
  qty: number;
  margin: number;
  stop: number;
  target: number;
  peak: number;
  openedAt: number;
  deadline: number;
  why: string;
}
export interface Closed extends Position {
  exit: number;
  pnl: number;
  pct: number;
  closedAt: number;
  reason: 'target' | 'stop' | 'trail' | 'time' | 'news' | 'manual';
}
export interface Account {
  start: number;
  balance: number;
  running: boolean;
  positions: Position[];
  closed: Closed[];
  nextId: number;
  day: string;
  dayPnl: number;
  tradedEvents: number[];
  skipped: { at: number; headline: string; asset: Asset; why: string }[];
  updatedAt: number;
}
export interface Rules {
  riskPct: number;
  maxOpen: number;
  stopPct: number;
  targetCapPct: number;
  targetMinPct: number;
  trailArmPct: number;
  trailPct: number;
  dailyLossPct: number;
  minConfidence: number;
  minReliability: number;
  minAvgMove: number;
}
export const RULES: Rules = { riskPct: 5, maxOpen: 3, stopPct: 4, targetCapPct: 8, targetMinPct: 3, trailArmPct: 3, trailPct: 3, dailyLossPct: 3, minConfidence: 0.7, minReliability: 0.6, minAvgMove: 2 };

export interface EventSignal {
  eventId: number;
  type: EventType;
  assets: Asset[];
  direction: 'up' | 'down' | 'mixed';
  confidence: number;
  importance: number;
  horizonDays: number;
  headline: string;
  why: string;
}

const FILE = () => path.join(config.dataDir, 'news-trader-state.json');
const today = () => new Date().toISOString().slice(0, 10);

export function freshAccount(start = 1000): Account {
  return { start, balance: start, running: true, positions: [], closed: [], nextId: 1, day: today(), dayPnl: 0, tradedEvents: [], skipped: [], updatedAt: Date.now() };
}
export function loadAccount(): Account {
  try {
    const a = JSON.parse(fs.readFileSync(FILE(), 'utf8')) as Account;
    if (a.day !== today()) {
      a.day = today();
      a.dayPnl = 0;
    }
    return a;
  } catch {
    return freshAccount();
  }
}
export function saveAccount(a: Account) {
  a.updatedAt = Date.now();
  a.closed = a.closed.slice(0, 500);
  a.skipped = a.skipped.slice(0, 100);
  a.tradedEvents = a.tradedEvents.slice(-500);
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(FILE(), JSON.stringify(a, null, 1));
}

const r2 = (x: number) => Math.round(x * 100) / 100;

/** Which trades a fresh event justifies. Returns the positions to open, and the reasons it skipped. */
export function decide(a: Account, pb: Playbook | null, sig: EventSignal, prices: Record<string, number>, rules = RULES, now = Date.now()): { open: Position[]; skipped: { asset: Asset; why: string }[]; closeAssets: Asset[] } {
  const open: Position[] = [];
  const skipped: { asset: Asset; why: string }[] = [];
  const closeAssets: Asset[] = [];
  if (!a.running) return { open, skipped: [{ asset: sig.assets[0], why: 'paused' }], closeAssets };
  if (a.tradedEvents.includes(sig.eventId)) return { open, skipped, closeAssets };
  const dayLoss = -a.dayPnl / a.balance;
  for (const asset of sig.assets) {
    const symbol = TRADABLE[asset];
    if (!symbol) {
      skipped.push({ asset, why: 'watch-only asset' });
      continue;
    }
    const play = playFor(pb, sig.type, asset);
    // Direction: the model's view and the playbook must agree; "down" on a held asset means get out.
    if (sig.direction === 'down' || (play && play.direction === 'down' && sig.direction !== 'up')) {
      if (a.positions.some((p) => p.asset === asset)) closeAssets.push(asset);
      skipped.push({ asset, why: 'bearish for a long-only account' });
      continue;
    }
    if (sig.direction !== 'up') {
      skipped.push({ asset, why: 'direction unclear' });
      continue;
    }
    if (sig.confidence < rules.minConfidence) {
      skipped.push({ asset, why: `confidence ${Math.round(sig.confidence * 100)}% < ${Math.round(rules.minConfidence * 100)}%` });
      continue;
    }
    // Without history for this pairing, only a very strong, important story qualifies, at half size.
    const unknown = !play || play.n < 2;
    if (!unknown && (play!.direction !== 'up' || play!.reliability < rules.minReliability || play!.avg[play!.best] < rules.minAvgMove)) {
      skipped.push({ asset, why: `history: ${play!.direction} ${play!.avg[play!.best]}% in ${play!.best}d, reliable ${Math.round(play!.reliability * 100)}% (n=${play!.n})` });
      continue;
    }
    if (unknown && (sig.confidence < 0.85 || sig.importance < 0.7)) {
      skipped.push({ asset, why: 'no history for this event type and asset; story not strong enough' });
      continue;
    }
    if (a.positions.length + open.length >= rules.maxOpen) {
      skipped.push({ asset, why: `already ${rules.maxOpen} open` });
      continue;
    }
    if (dayLoss >= rules.dailyLossPct / 100) {
      skipped.push({ asset, why: 'daily loss cap reached' });
      continue;
    }
    if (a.positions.some((p) => p.asset === asset) || open.some((p) => p.asset === asset)) {
      skipped.push({ asset, why: 'already holding it' });
      continue;
    }
    const price = prices[symbol];
    if (!price) {
      skipped.push({ asset, why: 'no price' });
      continue;
    }
    const margin = r2((a.balance * rules.riskPct) / 100 / (unknown ? 2 : 1));
    const targetPct = unknown ? rules.targetMinPct : Math.min(rules.targetCapPct, Math.max(rules.targetMinPct, play!.avg[play!.best]));
    const horizon = unknown ? sig.horizonDays : Math.max(play!.best, Math.min(sig.horizonDays, 14));
    open.push({
      id: 0,
      asset,
      symbol,
      eventId: sig.eventId,
      type: sig.type,
      headline: sig.headline,
      entry: price,
      qty: margin / price,
      margin,
      stop: price * (1 - rules.stopPct / 100),
      target: price * (1 + targetPct / 100),
      peak: price,
      openedAt: now,
      deadline: now + horizon * 86_400_000,
      why: unknown ? `${sig.why} (no history: half size)` : `${sig.why} · history: +${play!.avg[play!.best]}% in ${play!.best}d, ${Math.round(play!.reliability * 100)}% reliable`,
    });
  }
  return { open, skipped, closeAssets };
}

export function applyOpen(a: Account, ps: Position[], eventId: number) {
  for (const p of ps) {
    p.id = a.nextId++;
    a.positions.push(p);
  }
  if (ps.length) a.tradedEvents.push(eventId);
}

export function close(a: Account, p: Position, exit: number, reason: Closed['reason'], now = Date.now()): Closed {
  const pnl = r2((exit - p.entry) * p.qty - p.margin * 0.001 * 2); // 0.1% fee each way, like spot
  const c: Closed = { ...p, exit, pnl, pct: r2(((exit - p.entry) / p.entry) * 100), closedAt: now, reason };
  a.positions = a.positions.filter((x) => x.id !== p.id);
  a.closed.unshift(c);
  a.balance = r2(a.balance + pnl);
  a.dayPnl = r2(a.dayPnl + pnl);
  return c;
}

/** Stops, targets, trailing and time stops against the latest prices. */
export function manage(a: Account, prices: Record<string, number>, rules = RULES, now = Date.now()): Closed[] {
  const out: Closed[] = [];
  for (const p of [...a.positions]) {
    const price = prices[p.symbol];
    if (!price) continue;
    if (price > p.peak) p.peak = price;
    const armed = p.peak >= p.entry * (1 + rules.trailArmPct / 100);
    const trail = armed ? p.peak * (1 - rules.trailPct / 100) : 0;
    if (price <= p.stop) out.push(close(a, p, price, 'stop', now));
    else if (price >= p.target) out.push(close(a, p, price, 'target', now));
    else if (armed && price <= trail) out.push(close(a, p, price, 'trail', now));
    else if (now >= p.deadline) out.push(close(a, p, price, 'time', now));
  }
  return out;
}

export function equity(a: Account, prices: Record<string, number>) {
  return r2(a.balance + a.positions.reduce((s, p) => s + ((prices[p.symbol] ?? p.entry) - p.entry) * p.qty, 0));
}

export const tradableAssets = () => ASSETS.filter((x) => TRADABLE[x]);
