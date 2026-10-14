import type { Closed, Params, Signal } from './strategy.js';

/**
 * The Trade Bot's brain: it learns from its own trades with rewards and penalties.
 *
 *  - Points: every dollar a trade wins is +1 point, every dollar it loses is −1 ("trading points").
 *    Signals it chose to skip are still followed as shadow trades: a skipped loser is a dodged loss
 *    (+1 per dollar), a skipped winner a missed chance (−1 per dollar) ("judgment points").
 *  - Deep think: before each trade it breaks the moment into factors (coin, side, strength,
 *    volatility, the 1-hour trend, session, funding, its last result…), looks up what each factor
 *    has earned it so far, adds them up with a bonus for what it hasn't tried enough, and decides to
 *    TAKE or SKIP — with the reasons kept for the page.
 *  - Learning: after every real or shadow trade, each factor of that moment moves towards the
 *    result (online linear regression on return on margin), and it writes a short lesson.
 * Pure, so the live engine and the backtester (training on history) share it.
 */

export interface Factor {
  key: string;
  label: string;
  w: number;
  n: number;
}
export interface Thought {
  at: number;
  sym: string;
  side: 'LONG' | 'SHORT';
  factors: Factor[];
  /** what the factors add up to (expected return on margin) */
  pred: number;
  /** curiosity: extra for factors it hasn't seen enough */
  bonus: number;
  value: number;
  decision: 'TAKE' | 'SKIP';
  explore: boolean;
  /** margin multiplier from its confidence */
  size: number;
  reason: string;
}
export interface Lesson {
  at: number;
  sym: string;
  side: 'LONG' | 'SHORT';
  pnl: number;
  took: boolean;
  kind: 'win' | 'mistake' | 'dodged' | 'missed';
  text: string;
  key: string | null;
  w: number | null;
  n: number | null;
  points: number;
}
export interface BrainCfg {
  /** off: takes every signal (like before) but still learns and scores */
  enabled: boolean;
  /** how sure it must be to take a trade (expected return on margin) */
  minEdge: number;
  /** curiosity: weight of the bonus for factors with few trades */
  explore: number;
  /** share of skips taken anyway, to keep testing (0–0.3) */
  randomTry: number;
  /** bet a bit more when confident, a bit less when unsure */
  sizeByConfidence: boolean;
  learningRate: number;
}
export interface Brain {
  version: 1;
  cfg: BrainCfg;
  w: Record<string, number>;
  n: Record<string, number>;
  /** dollars won/lost per factor (real and shadow) */
  usd: Record<string, number>;
  wins: Record<string, number>;
  trades: number;
  shadows: number;
  /** +1 per $ won, −1 per $ lost, real trades */
  tradingPoints: number;
  /** +1 per $ dodged, −1 per $ missed, skipped signals */
  judgmentPoints: number;
  /** one per lesson */
  xp: number;
  history: [number, number][];
  lessons: Lesson[];
  thoughts: Thought[];
  /** last real trade result, a factor of the next decision */
  last: 'win' | 'loss' | null;
  trainedOn: { at: number; days: number; trades: number; points: number }[];
}

export const DEFAULT_BRAIN_CFG: BrainCfg = { enabled: true, minEdge: 0.01, explore: 0.08, randomTry: 0, sizeByConfidence: true, learningRate: 0.08 };

export function freshBrain(cfg: Partial<BrainCfg> = {}): Brain {
  return { version: 1, cfg: cleanBrainCfg(cfg), w: {}, n: {}, usd: {}, wins: {}, trades: 0, shadows: 0, tradingPoints: 0, judgmentPoints: 0, xp: 0, history: [], lessons: [], thoughts: [], last: null, trainedOn: [] };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const num = (v: unknown, d: number, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : d);
export function cleanBrainCfg(c: Partial<BrainCfg> = {}, base: BrainCfg = DEFAULT_BRAIN_CFG): BrainCfg {
  return {
    enabled: typeof c.enabled === 'boolean' ? c.enabled : base.enabled,
    minEdge: +num(c.minEdge, base.minEdge, -0.5, 0.5).toFixed(3),
    explore: +num(c.explore, base.explore, 0, 0.5).toFixed(3),
    randomTry: +num(c.randomTry, base.randomTry, 0, 0.3).toFixed(3),
    sizeByConfidence: typeof c.sizeByConfidence === 'boolean' ? c.sizeByConfidence : base.sizeByConfidence,
    learningRate: +num(c.learningRate, base.learningRate, 0.005, 0.5).toFixed(3),
  };
}

export const LEVELS = ['Rookie', 'Apprentice', 'Trader', 'Analyst', 'Strategist', 'Pro', 'Master', 'Legend'];
/** Level from experience: 0, 10, 40, 90, 160, 250, 360, 490 lessons… */
export function level(xp: number) {
  const l = Math.min(LEVELS.length - 1, Math.floor(Math.sqrt(xp / 10)));
  const from = 10 * l * l,
    to = 10 * (l + 1) * (l + 1);
  return { level: l + 1, title: LEVELS[l], from, to, progress: l === LEVELS.length - 1 ? 1 : (xp - from) / (to - from) };
}

// ---- the moment, as factors ---------------------------------------------------------------------
export interface Moment {
  sym: string;
  side: 'LONG' | 'SHORT';
  z: number;
  /** ATR per minute, share of price */
  atr: number;
  /** price change over the last hour, share */
  trend1h: number | null;
  /** UTC hour */
  hour: number;
  fundingRate: number | null;
  last: 'win' | 'loss' | null;
  mode: Params['mode'];
}

export function factorsOf(m: Moment): { key: string; label: string }[] {
  const dir = m.side === 'LONG' ? 1 : -1;
  const az = Math.abs(m.z);
  const strength = az < 1.5 ? '<1.5' : az < 2 ? '1.5–2' : az < 3 ? '2–3' : '3+';
  const vol = m.atr < 0.0008 ? 'low' : m.atr < 0.0018 ? 'normal' : 'high';
  const t = m.trend1h === null ? null : dir * m.trend1h;
  const trend = t === null ? null : t > 0.002 ? 'with' : t < -0.002 ? 'against' : 'flat';
  const session = m.hour < 7 ? 'Asia' : m.hour < 13 ? 'Europe' : m.hour < 21 ? 'US' : 'Late';
  const f = m.fundingRate === null ? null : Math.abs(m.fundingRate) < 0.00005 ? 'flat' : dir * m.fundingRate > 0 ? 'pays' : 'earns';
  const out = [
    { key: 'bias', label: 'Trading at all' },
    { key: `mode:${m.mode}`, label: m.mode === 'reversion' ? 'Fading moves' : 'Following moves' },
    { key: `coin:${m.sym}`, label: m.sym },
    { key: `side:${m.side}`, label: m.side === 'LONG' ? 'Going long' : 'Going short' },
    { key: `coinside:${m.sym}:${m.side}`, label: `${m.sym} ${m.side}` },
    { key: `strength:${strength}`, label: `Signal strength ${strength}` },
    { key: `vol:${vol}`, label: `${vol[0].toUpperCase()}${vol.slice(1)} volatility` },
    { key: `session:${session}`, label: `${session} session` },
  ];
  if (trend) out.push({ key: `trend:${trend}`, label: trend === 'with' ? 'With the 1h trend' : trend === 'against' ? 'Against the 1h trend' : 'Flat 1h trend' });
  if (f) out.push({ key: `funding:${f}`, label: f === 'pays' ? 'Pays funding' : f === 'earns' ? 'Earns funding' : 'Funding near zero' });
  if (m.last) out.push({ key: `after:${m.last}`, label: m.last === 'win' ? 'Right after a win' : 'Right after a loss' });
  return out;
}

// ---- deep think ---------------------------------------------------------------------------------
/** Thinks about a signal: the factors' track record → TAKE or SKIP, with how much to bet. */
export function think(b: Brain, sig: Signal, m: Moment, now: number, rand: () => number = Math.random): Thought {
  const fs = factorsOf(m).map((f) => ({ ...f, w: +(b.w[f.key] ?? 0).toFixed(4), n: b.n[f.key] ?? 0 }));
  const pred = fs.reduce((s, f) => s + f.w, 0);
  const bonus = b.cfg.explore * (fs.reduce((s, f) => s + 1 / Math.sqrt(1 + f.n), 0) / fs.length);
  const value = pred + bonus;
  let decision: 'TAKE' | 'SKIP' = !b.cfg.enabled || value >= b.cfg.minEdge ? 'TAKE' : 'SKIP';
  let explore = false;
  if (decision === 'SKIP' && rand() < b.cfg.randomTry) {
    decision = 'TAKE';
    explore = true;
  }
  const seen = fs.filter((f) => f.n >= 3);
  const confidence = seen.length / fs.length;
  const size = b.cfg.sizeByConfidence && b.cfg.enabled && !explore ? +clamp(1 + 2 * pred * confidence, 0.5, 1.5).toFixed(2) : explore ? 0.25 : 1;
  const sorted = [...seen].sort((a, x) => a.w - x.w);
  const worst = sorted[0],
    best = sorted.at(-1);
  let reason: string;
  if (!b.cfg.enabled) reason = 'Brain off: taking every signal, still learning';
  else if (explore) reason = 'Would skip, but trying it small to keep learning';
  else if (b.trades + b.shadows < 5) reason = 'Still new: trying signals to learn';
  else if (decision === 'TAKE') reason = best && best.w > 0 ? `${best.label} has paid off (${best.n} trades)` : 'Nothing known against it; curious';
  else reason = worst && worst.w < 0 ? `${worst.label} keeps losing (${worst.n} trades)` : 'Not enough edge';
  const t: Thought = { at: now, sym: sig.sym, side: sig.side, factors: fs, pred: +pred.toFixed(4), bonus: +bonus.toFixed(4), value: +value.toFixed(4), decision, explore, size, reason };
  b.thoughts.unshift(t);
  if (b.thoughts.length > 30) b.thoughts.length = 30;
  return t;
}

// ---- learning -----------------------------------------------------------------------------------
/** Learns from a finished trade (real if `took`, else a shadow of a skipped signal). */
export function learn(b: Brain, t: Closed, keys: string[], labels: Record<string, string>, took: boolean): Lesson {
  const r = clamp(t.margin > 0 ? t.pnl / t.margin : 0, -1, 1);
  const pred = keys.reduce((s, k) => s + (b.w[k] ?? 0), 0);
  const err = r - pred;
  const step = (b.cfg.learningRate * err) / Math.max(1, keys.length);
  for (const k of keys) {
    b.w[k] = +((b.w[k] ?? 0) + step).toFixed(6);
    b.n[k] = (b.n[k] ?? 0) + 1;
    b.usd[k] = +((b.usd[k] ?? 0) + t.pnl).toFixed(4);
    if (t.pnl > 0) b.wins[k] = (b.wins[k] ?? 0) + 1;
  }
  let points: number;
  let kind: Lesson['kind'];
  if (took) {
    b.trades++;
    b.tradingPoints = +(b.tradingPoints + t.pnl).toFixed(4);
    b.last = t.pnl > 0 ? 'win' : 'loss';
    points = t.pnl;
    kind = t.pnl > 0 ? 'win' : 'mistake';
  } else {
    b.shadows++;
    points = -t.pnl; // a skipped loser is a good call, a skipped winner a missed one
    b.judgmentPoints = +(b.judgmentPoints + points).toFixed(4);
    kind = t.pnl > 0 ? 'missed' : 'dodged';
  }
  b.xp++;
  // The factor that explains it best: the most negative after a loss, the most positive after a win.
  const scored = keys.filter((k) => k !== 'bias').map((k) => ({ k, w: b.w[k] ?? 0, n: b.n[k] ?? 0 }));
  const pick = t.pnl > 0 ? scored.sort((a, x) => x.w - a.w)[0] : scored.sort((a, x) => a.w - x.w)[0];
  const lbl = pick ? labels[pick.k] ?? pick.k : '';
  const usd = `$${Math.abs(t.pnl).toFixed(2)}`;
  const what = `${t.sym} ${t.side}`;
  const text =
    kind === 'win'
      ? `Won ${usd} on ${what}. "${lbl}" gets more trust (${pick ? fmtW(pick.w) : ''}).`
      : kind === 'mistake'
        ? `Lost ${usd} on ${what} (${t.why}). Mistake noted: "${lbl}" now ${pick ? fmtW(pick.w) : ''} after ${pick?.n ?? 0} trades — I'll be pickier.`
        : kind === 'dodged'
          ? `Skipped ${what} and it would have lost ${usd}. Good call — "${lbl}" was right to worry about.`
          : `Skipped ${what} but it would have won ${usd}. Too careful about "${lbl}" — adjusting.`;
  const lesson: Lesson = { at: t.at, sym: t.sym, side: t.side, pnl: t.pnl, took, kind, text, key: pick?.k ?? null, w: pick ? +pick.w.toFixed(4) : null, n: pick?.n ?? null, points: +points.toFixed(2) };
  b.lessons.unshift(lesson);
  if (b.lessons.length > 60) b.lessons.length = 60;
  b.history.push([t.at, +(b.tradingPoints + b.judgmentPoints).toFixed(2)]);
  if (b.history.length > 800) b.history.splice(0, b.history.length - 800);
  return lesson;
}
const fmtW = (w: number) => `${w >= 0 ? '+' : ''}${(w * 100).toFixed(1)}%`;

/** What it has learned: factors it trusts and avoids (with enough trades), best and worst first. */
export function insights(b: Brain, labelOf: (k: string) => string, minN = 3) {
  const rows = Object.keys(b.w)
    .filter((k) => k !== 'bias' && (b.n[k] ?? 0) >= minN)
    .map((k) => ({ key: k, label: labelOf(k), w: +b.w[k].toFixed(4), n: b.n[k], usd: +(b.usd[k] ?? 0).toFixed(2), winrate: +(((b.wins[k] ?? 0) / b.n[k]) * 100).toFixed(0) }));
  return { trusts: rows.filter((r) => r.w > 0).sort((a, x) => x.w - a.w).slice(0, 8), avoids: rows.filter((r) => r.w < 0).sort((a, x) => a.w - x.w).slice(0, 8) };
}

/** Readable name of a factor key (for keys learned before their label was seen). */
export function labelOf(key: string): string {
  const [kind, a, b2] = key.split(':');
  switch (kind) {
    case 'coin':
      return a;
    case 'side':
      return a === 'LONG' ? 'Going long' : 'Going short';
    case 'coinside':
      return `${a} ${b2}`;
    case 'strength':
      return `Signal strength ${a}`;
    case 'vol':
      return `${a[0].toUpperCase()}${a.slice(1)} volatility`;
    case 'session':
      return `${a} session`;
    case 'trend':
      return a === 'with' ? 'With the 1h trend' : a === 'against' ? 'Against the 1h trend' : 'Flat 1h trend';
    case 'funding':
      return a === 'pays' ? 'Pays funding' : a === 'earns' ? 'Earns funding' : 'Funding near zero';
    case 'after':
      return a === 'win' ? 'Right after a win' : 'Right after a loss';
    case 'mode':
      return a === 'reversion' ? 'Fading moves' : 'Following moves';
    case 'bias':
      return 'Trading at all';
    default:
      return key;
  }
}

/** Takes what a training run learned (weights and counts); keeps the live score and journal. */
export function adoptKnowledge(live: Brain, trained: Brain, info: { days: number; trades: number; points: number }, now: number) {
  live.w = { ...trained.w };
  live.n = { ...trained.n };
  live.usd = { ...trained.usd };
  live.wins = { ...trained.wins };
  // Practice counts for a little: one level point per 50 lessons studied (live lessons count fully),
  // and studying the same period again within 12 hours adds knowledge but no level points.
  const repeat = live.trainedOn.some((x) => x.days === info.days && now - x.at < 12 * 3600_000);
  if (!repeat) live.xp += Math.round(Math.max(0, trained.xp - live.xp) / 50);
  live.trainedOn.unshift({ at: now, ...info });
  if (live.trainedOn.length > 20) live.trainedOn.length = 20;
}

/** A brain from a file, with defaults for anything missing. */
export function loadBrain(v: unknown): Brain {
  const b = (v ?? {}) as Partial<Brain>;
  const f = freshBrain(b.cfg);
  return { ...f, ...b, cfg: cleanBrainCfg(b.cfg ?? {}), version: 1 } as Brain;
}
