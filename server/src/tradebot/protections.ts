import type { Closed } from './strategy.js';

/**
 * Protections, as in freqtrade: after each closed trade they may lock one pair or the whole bot
 * for a while — a cooldown per pair, a stop-loss guard, a max-drawdown guard and a low-profit-pairs
 * guard. Shared by the live engine and the backtester.
 */
export interface ProtectionCfg {
  cooldown: { on: boolean; minutes: number };
  stoplossGuard: { on: boolean; lookbackMin: number; tradeLimit: number; stopMin: number; onlyPerPair: boolean };
  maxDrawdown: { on: boolean; lookbackMin: number; tradeLimit: number; maxPct: number; stopMin: number };
  lowProfitPairs: { on: boolean; lookbackMin: number; tradeLimit: number; requiredProfitPct: number; stopMin: number };
}

export interface Lock {
  /** a coin, or '*' for every pair */
  pair: string;
  until: number;
  at: number;
  reason: string;
  by: 'cooldown' | 'stoplossGuard' | 'maxDrawdown' | 'lowProfitPairs' | 'manual';
}

export const DEFAULT_PROTECTIONS: ProtectionCfg = {
  cooldown: { on: true, minutes: 2 },
  stoplossGuard: { on: true, lookbackMin: 60, tradeLimit: 4, stopMin: 30, onlyPerPair: false },
  maxDrawdown: { on: true, lookbackMin: 360, tradeLimit: 6, maxPct: 20, stopMin: 120 },
  lowProfitPairs: { on: false, lookbackMin: 720, tradeLimit: 4, requiredProfitPct: 0, stopMin: 240 },
};

const clamp = (v: unknown, d: number, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const on = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);

export function cleanProtections(p: Partial<Record<keyof ProtectionCfg, Record<string, unknown>>> = {}, base: ProtectionCfg = DEFAULT_PROTECTIONS): ProtectionCfg {
  const c = p.cooldown ?? {},
    s = p.stoplossGuard ?? {},
    m = p.maxDrawdown ?? {},
    l = p.lowProfitPairs ?? {};
  return {
    cooldown: { on: on(c.on, base.cooldown.on), minutes: Math.round(clamp(c.minutes, base.cooldown.minutes, 0, 1440)) },
    stoplossGuard: {
      on: on(s.on, base.stoplossGuard.on),
      lookbackMin: Math.round(clamp(s.lookbackMin, base.stoplossGuard.lookbackMin, 5, 10_080)),
      tradeLimit: Math.round(clamp(s.tradeLimit, base.stoplossGuard.tradeLimit, 1, 50)),
      stopMin: Math.round(clamp(s.stopMin, base.stoplossGuard.stopMin, 1, 10_080)),
      onlyPerPair: on(s.onlyPerPair, base.stoplossGuard.onlyPerPair),
    },
    maxDrawdown: {
      on: on(m.on, base.maxDrawdown.on),
      lookbackMin: Math.round(clamp(m.lookbackMin, base.maxDrawdown.lookbackMin, 5, 10_080)),
      tradeLimit: Math.round(clamp(m.tradeLimit, base.maxDrawdown.tradeLimit, 1, 100)),
      maxPct: +clamp(m.maxPct, base.maxDrawdown.maxPct, 1, 100).toFixed(1),
      stopMin: Math.round(clamp(m.stopMin, base.maxDrawdown.stopMin, 1, 10_080)),
    },
    lowProfitPairs: {
      on: on(l.on, base.lowProfitPairs.on),
      lookbackMin: Math.round(clamp(l.lookbackMin, base.lowProfitPairs.lookbackMin, 5, 10_080)),
      tradeLimit: Math.round(clamp(l.tradeLimit, base.lowProfitPairs.tradeLimit, 1, 50)),
      requiredProfitPct: +clamp(l.requiredProfitPct, base.lowProfitPairs.requiredProfitPct, -100, 100).toFixed(2),
      stopMin: Math.round(clamp(l.stopMin, base.lowProfitPairs.stopMin, 1, 10_080)),
    },
  };
}

const isStop = (t: Closed) => t.why === 'SL' || t.why === 'TRAIL' || t.why === 'LIQ';

/**
 * The locks to add after `last` closed. `closed` is newest first and includes `last` (only the
 * longest lookback is needed); `balanceNow` is the balance after it, for the drawdown guard.
 */
export function protectionsAfter(cfg: ProtectionCfg, closed: Closed[], last: Closed, now: number, balanceNow: number): Lock[] {
  const out: Lock[] = [];
  if (cfg.cooldown.on && cfg.cooldown.minutes > 0)
    out.push({ pair: last.sym, until: now + cfg.cooldown.minutes * 60_000, at: now, by: 'cooldown', reason: `Cooldown ${cfg.cooldown.minutes} min after a trade` });

  const sg = cfg.stoplossGuard;
  if (sg.on && isStop(last)) {
    const since = now - sg.lookbackMin * 60_000;
    const stops = closed.filter((t) => t.at >= since && isStop(t) && (!sg.onlyPerPair || t.sym === last.sym));
    if (stops.length >= sg.tradeLimit)
      out.push({ pair: sg.onlyPerPair ? last.sym : '*', until: now + sg.stopMin * 60_000, at: now, by: 'stoplossGuard', reason: `${stops.length} stop-losses in ${sg.lookbackMin} min` });
  }

  const md = cfg.maxDrawdown;
  if (md.on) {
    const since = now - md.lookbackMin * 60_000;
    const recent = closed.filter((t) => t.at >= since).reverse(); // oldest first
    if (recent.length >= md.tradeLimit) {
      // Balance path over the window: today's balance minus the window's results gives its start.
      let bal = balanceNow - recent.reduce((x, t) => x + t.pnl, 0);
      let peak = bal,
        dd = 0;
      for (const t of recent) {
        bal += t.pnl;
        peak = Math.max(peak, bal);
        if (peak > 0) dd = Math.max(dd, (peak - bal) / peak);
      }
      if (dd * 100 >= md.maxPct)
        out.push({ pair: '*', until: now + md.stopMin * 60_000, at: now, by: 'maxDrawdown', reason: `Drawdown ${(dd * 100).toFixed(1)}% in ${md.lookbackMin} min` });
    }
  }

  const lp = cfg.lowProfitPairs;
  if (lp.on) {
    const since = now - lp.lookbackMin * 60_000;
    const mine = closed.filter((t) => t.at >= since && t.sym === last.sym);
    if (mine.length >= lp.tradeLimit) {
      const profitPct = mine.reduce((s, t) => s + t.pct, 0) / mine.length;
      if (profitPct < lp.requiredProfitPct)
        out.push({ pair: last.sym, until: now + lp.stopMin * 60_000, at: now, by: 'lowProfitPairs', reason: `${last.sym} averaged ${profitPct.toFixed(1)}% over ${mine.length} trades` });
    }
  }
  return out;
}

/** Is this pair (or every pair) locked right now? Expired locks are ignored. */
export function lockedBy(locks: Lock[], pair: string, now: number): Lock | null {
  let best: Lock | null = null;
  for (const l of locks) if (l.until > now && (l.pair === '*' || l.pair === pair) && (!best || l.until > best.until)) best = l;
  return best;
}

export const activeLocks = (locks: Lock[], now: number) => locks.filter((l) => l.until > now);

/** The longest lookback any protection needs (older trades can be dropped from the working list). */
export const maxLookbackMs = (cfg: ProtectionCfg) => Math.max(cfg.stoplossGuard.lookbackMin, cfg.maxDrawdown.lookbackMin, cfg.lowProfitPairs.lookbackMin) * 60_000;
