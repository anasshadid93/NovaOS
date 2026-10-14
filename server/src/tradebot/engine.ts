import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import { postHook } from '../bot/hook.js';
import { config } from '../config.js';
import { LOSSES, SPACES, type Epoch, type HyperoptOpts, type LossName, type Space } from './backtest.js';
import type { JobInput, JobMessage } from './jobs.worker.js';
import { adoptKnowledge, cleanBrainCfg, factorsOf, freshBrain, insights, labelOf, learn, level, loadBrain, think, type Brain, type Moment } from './brain.js';
import { coinTarget, emaSeries, isRebalanceDay, openSleeve, rankTargets, SLEEVE_TF, sleeveSizing } from './portfolio.js';
import { annVol, channels, trendWeight, type Bar } from './trend.js';
import { activeLocks, cleanProtections, DEFAULT_PROTECTIONS, lockedBy, maxLookbackMs, protectionsAfter, type Lock, type ProtectionCfg } from './protections.js';
import { computeStats, type Stats } from './stats.js';
import {
  ALL_SYMS,
  cleanParams,
  closeTrade,
  DEFAULT_PARAMS,
  exitCheck,
  fundingPay,
  openPosition,
  pairlist,
  pnlOf,
  signal,
  updateTrail,
  zScore,
  type Candle,
  type Closed,
  type ExitWhy,
  type Params,
  type Position,
  sleeveWeights,
  SLEEVES,
  type SleeveKind,
} from './strategy.js';

/**
 * Trade Bot engine (paper trading, fake money) — runs inside MinisManager so it trades around the
 * clock on live Binance USDⓈ-M futures prices; nothing is ever sent to an exchange.
 *
 * Files shared with the Trade Bot page (~/ArtCraft/tradebot, a writable craft app), in data/:
 *  - state.json    written here: balance, open trades, latest closed trades, stats, locks, settings;
 *  - trades.json   written here: every closed trade (up to 2000), for the stats page;
 *  - job.json      written here: the running/last backtest or hyperopt (phase, progress);
 *  - backtest.json / hyperopt.json  written here: their results;
 *  - control.json  written by the page: { cmd, …, at } (start, pause, reset, settings, forceexit,
 *                  forceentry, unlock, backtest, hyperopt, applyHyperopt, cancelJob).
 *
 * Strategy and the freqtrade-style extras (ROI table, trailing stop, fees, slippage, funding,
 * protections, pairlist, backtesting, hyperopt) live in strategy.ts, protections.ts, stats.ts and
 * backtest.ts; heavy jobs run in a worker thread (jobs.worker.ts).
 */

export type { Params } from './strategy.js';

export interface Notify {
  entry: boolean;
  exit: boolean;
  protection: boolean;
  daily: boolean;
  jobs: boolean;
  /** a Telegram line for each lesson the brain learns */
  lessons: boolean;
}
const DEFAULT_NOTIFY: Notify = { entry: false, exit: false, protection: true, daily: true, jobs: true, lessons: false };

export interface BotState {
  version: 2;
  start: number;
  marginPct: number;
  hours: number;
  balance: number;
  running: boolean;
  startedAt: number | null;
  elapsed: number;
  params: Params;
  protections: ProtectionCfg;
  notify: Notify;
  positions: BrainPos[];
  /** signals the brain skipped, followed without money to learn from them */
  shadows: BrainPos[];
  /** the brain at a glance (brain.json has all of it) */
  brain: { enabled: boolean; points: number; trading: number; judgment: number; xp: number; level: number; title: string; progress: number; last: unknown; lesson: unknown };
  /** newest first; the page gets the latest 30 here, all of them in trades.json */
  closed: Closed[];
  locks: Lock[];
  equity: [number, number][];
  prices: Record<string, number>;
  z: Record<string, number>;
  funding: Record<string, { rate: number; next: number }>;
  vol24: Record<string, number>;
  /** trend strategy: each coin's channel after the last closed bar (for the page's market and radar) */
  trend: Record<string, { entry: number; exit: number; close: number; at: number; vol: number | null; w: number; target: number }>;
  /** each sleeve's latest decision per coin */
  sleeves: Partial<Record<SleeveKind, Record<string, { target: number; at: number; close: number }>>>;
  /** the pairs being traded right now (after the volume pairlist) */
  active: string[];
  stats: Stats;
  nextId: number;
  lastDaily: string;
  feed: 'ok' | 'down';
  engine: 'server';
  savedAt: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const cleanNotify = (n: Partial<Notify> = {}, base = DEFAULT_NOTIFY): Notify =>
  Object.fromEntries(Object.entries(base).map(([k, d]) => [k, typeof n[k as keyof Notify] === 'boolean' ? n[k as keyof Notify] : d])) as unknown as Notify;

export interface SettingsInput {
  start?: number;
  marginPct?: number;
  hours?: number;
  /** legacy (v1 pages): win:loss distance */
  ratio?: number;
  params?: Partial<Params>;
  protections?: Partial<Record<keyof ProtectionCfg, Record<string, unknown>>>;
  notify?: Partial<Notify>;
}

export function freshState(s: SettingsInput = {}, base?: BotState): BotState {
  const start = clamp(Number(s.start) || base?.start || 54, 10, 1e7);
  const params = cleanParams({ ...(s.ratio ? { ratio: Number(s.ratio) } : {}), ...(s.params ?? {}) }, base?.params ?? DEFAULT_PARAMS);
  return {
    version: 2,
    start,
    marginPct: clamp(Number(s.marginPct) || base?.marginPct || 60, 5, 90),
    hours: clamp(Number(s.hours) || base?.hours || 22, 1, 720),
    balance: start,
    running: false,
    startedAt: null,
    elapsed: 0,
    params,
    protections: cleanProtections(s.protections ?? {}, base?.protections ?? DEFAULT_PROTECTIONS),
    notify: cleanNotify(s.notify ?? {}, base?.notify ?? DEFAULT_NOTIFY),
    positions: [],
    shadows: [],
    brain: { enabled: true, points: 0, trading: 0, judgment: 0, xp: 0, level: 1, title: 'Rookie', progress: 0, last: null, lesson: null },
    closed: [],
    locks: [],
    equity: [[Date.now(), start]],
    prices: {},
    z: {},
    funding: {},
    vol24: {},
    trend: {},
    sleeves: {},
    active: params.pairs,
    stats: computeStats([], start),
    nextId: 1,
    lastDaily: '',
    feed: 'down',
    engine: 'server',
    savedAt: Date.now(),
  };
}

/** A v1 state file (one position, fixed 5:1, no fees split) carried over into v2. */
export function migrate(s: Record<string, unknown>): BotState {
  if (s.version === 2) {
    const v = s as unknown as BotState;
    const base = freshState({ start: v.start, marginPct: v.marginPct, hours: v.hours, params: v.params, protections: v.protections as never, notify: v.notify });
    return { ...base, ...v, params: base.params, protections: base.protections, notify: base.notify, engine: 'server', feed: 'down' };
  }
  const st = freshState({ start: Number(s.start), marginPct: Number(s.marginPct), hours: Number(s.hours), ratio: Number(s.ratio) });
  const fee = DEFAULT_PARAMS.feeTaker;
  const old = s.pos as (Omit<Position, 'id' | 'tpDist' | 'peak' | 'trailing' | 'fees' | 'funding' | 'tag'> & Record<string, unknown>) | null;
  st.positions = old ? [{ ...old, id: old.openedAt, tpDist: Math.abs(old.tp / old.entry - 1), peak: old.entry, trailing: false, fees: old.size * fee, funding: 0, tag: 'signal' }] : [];
  st.closed = ((s.closed as Record<string, unknown>[]) ?? []).map((t, i) => ({
    id: i + 1,
    sym: String(t.sym),
    side: t.side === 'LONG' ? 'LONG' : 'SHORT',
    lev: Number(t.lev),
    entry: Number(t.entry),
    exit: Number(t.exit),
    pnl: Number(t.pnl),
    pct: Number(t.pct),
    balPct: Number(t.balPct),
    why: String(t.why) as ExitWhy,
    at: Number(t.at),
    openedAt: Number(t.at) - Number(t.dur ?? 0),
    dur: Number(t.dur ?? 0),
    margin: Number(t.pct) ? Math.abs(Number(t.pnl) / (Number(t.pct) / 100)) : 0,
    fees: 0,
    funding: 0,
    tag: 'signal',
  }));
  st.balance = Number(s.balance) || st.start;
  st.running = !!s.running;
  st.startedAt = (s.startedAt as number | null) ?? null;
  st.elapsed = Number(s.elapsed) || 0;
  st.equity = Array.isArray(s.equity) && s.equity.length ? (s.equity as [number, number][]) : st.equity;
  st.nextId = st.closed.length + 2;
  st.stats = computeStats(st.closed, st.start);
  return st;
}

// Legacy exports (the v1 tests and any old callers).
export { atrPct, exitCheck, openPosition, pnlOf, signal } from './strategy.js';

// ---- the running bot ----------------------------------------------------------------------------
const API = 'https://fapi.binance.com/fapi/v1';
const WS_URL = `wss://fstream.binance.com/stream?streams=${ALL_SYMS.map((s) => `${s.toLowerCase()}usdt@kline_1m`).join('/')}`;
const dir = () => path.join(config.craftRoot, 'tradebot', 'data');
const file = (n: string) => path.join(dir(), n);
const CLOSED_KEEP = 2000;
const fmt = (v: number) => (v >= 1000 ? v.toFixed(1) : v >= 10 ? v.toFixed(2) : v.toFixed(4));
const money = (v: number) => `${v >= 0 ? '+' : '−'}$${Math.abs(v).toFixed(2)}`;
const WHY_AR: Record<string, string> = { TP: 'الهدف', SL: 'وقف الخسارة', TRAIL: 'الوقف المتحرك', ROI: 'ربح كافي (ROI)', TIME: 'انتهى الوقت', LIQ: 'تصفية', FORCE: 'إغلاق يدوي', TREND: 'انكسر الترند' };
/** A position's sleeve (old 'trend' tags are the breakout sleeve). */
const sleeveOf = (tag: string): SleeveKind | null => (tag === 'trend' ? 'donchian' : (SLEEVES as string[]).includes(tag) ? (tag as SleeveKind) : null);
const SLEEVE_AR: Record<SleeveKind, string> = { donchian: 'كسر ترند', ema: 'ترند EMA', tsmom: 'زخم', xsmom: 'ترتيب العملات', carry: 'جمع التمويل' };
const dubaiDay = (at: number) => new Date(at + 4 * 3600_000).toISOString().slice(0, 10);

interface JobState {
  id: number;
  kind: 'backtest' | 'hyperopt' | 'train' | 'walkforward';
  status: 'running' | 'done' | 'error' | 'cancelled';
  phase: string;
  done: number;
  total: number;
  note: string;
  startedAt: number;
  endedAt: number | null;
  error: string | null;
  days: number;
  epochs?: number;
  loss?: string;
  spaces?: string[];
}

export type Command = { cmd: string; [k: string]: unknown };
/** A position with the factors the brain saw when it opened (for learning when it closes). */
export type BrainPos = Position & { keys?: string[]; labels?: Record<string, string> };

/**
 * Heavy jobs (backtests, hyperopt, walk-forward, training) run as their own process in a systemd
 * scope with its own memory cap and a lower CPU share: a job that runs out of memory stops alone
 * instead of taking MinisManager (capped at 512 MB) down with it. The input goes through a file,
 * messages come back as JSON lines on stdout.
 */
function spawnJob(input: JobInput): ChildProcess {
  const f = path.join(config.dataDir, `tradebot-job-${Date.now()}.json`);
  fs.writeFileSync(f, JSON.stringify(input), { mode: 0o600 });
  const script = new URL('./jobs.worker.js', import.meta.url).pathname;
  const args = ['--max-old-space-size=1100', script, '--input', f];
  const uid = process.getuid?.() ?? 1000;
  const runtime = `/run/user/${uid}`;
  const scoped = fs.existsSync('/usr/bin/systemd-run') && fs.existsSync(`${runtime}/bus`);
  const env = { ...process.env, XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus` };
  const p = scoped
    ? spawn('/usr/bin/systemd-run', ['--user', '--scope', '--quiet', '--collect', '-p', 'MemoryMax=1500M', '-p', 'CPUWeight=20', '--nice=10', `--unit=minismanager-tradebot-${Date.now()}`, process.execPath, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  p.on('exit', () => fs.rmSync(f, { force: true }));
  return p;
}

class Engine {
  st: BotState = freshState();
  candles: Record<string, Candle[]> = Object.fromEntries(ALL_SYMS.map((s) => [s, []]));
  job: JobState | null = null;
  brain: Brain = freshBrain();
  private brainDirty = true;
  private trendSeen: Record<string, number> = {};
  private trendSeenKey: Record<string, string> = {};
  private worker: ChildProcess | null = null;
  private hyper: { epochs: Epoch[]; best: Epoch | null } | null = null;
  private ws: WebSocket | null = null;
  private timers: NodeJS.Timeout[] = [];
  private dirty = false;
  private tradesDirty = true;
  private lastControl = 0;
  private stopped = false;

  load() {
    try {
      const s = JSON.parse(fs.readFileSync(file('state.json'), 'utf8')) as Record<string, unknown>;
      if (s && typeof s.balance === 'number') this.st = migrate(s);
    } catch {
      /* first run */
    }
    // The full trade list (state.json only carries the latest).
    try {
      const all = JSON.parse(fs.readFileSync(file('trades.json'), 'utf8')) as { closed?: Closed[] };
      if (Array.isArray(all.closed) && all.closed.length > this.st.closed.length) this.st.closed = all.closed;
    } catch {
      /* none yet */
    }
    this.st.stats = computeStats(this.st.closed, this.st.start);
    this.st.shadows ??= [];
    this.st.trend ??= {};
    this.st.sleeves ??= {};
    try {
      this.brain = loadBrain(JSON.parse(fs.readFileSync(file('brain.json'), 'utf8')));
    } catch {
      /* a new brain */
    }
    try {
      this.job = JSON.parse(fs.readFileSync(file('job.json'), 'utf8')) as JobState;
      if (this.job?.status === 'running') {
        this.job = { ...this.job, status: 'cancelled', endedAt: Date.now(), note: 'MinisManager restarted' };
        this.writeJob();
      }
    } catch {
      /* no job yet */
    }
    try {
      this.lastControl = fs.statSync(file('control.json')).mtimeMs;
    } catch {
      /* no command yet */
    }
  }

  private writeJson(name: string, v: unknown) {
    fs.mkdirSync(dir(), { recursive: true });
    const tmp = file(`.${name}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(v));
    fs.renameSync(tmp, file(name));
  }

  private write() {
    if (this.tradesDirty) {
      this.tradesDirty = false;
      this.writeJson('trades.json', { closed: this.st.closed, start: this.st.start, savedAt: Date.now() });
    }
    if (this.brainDirty) {
      this.brainDirty = false;
      const b = this.brain;
      this.writeJson('brain.json', { ...b, level: level(b.xp), insights: insights(b, (k) => labelOf(k)), points: +(b.tradingPoints + b.judgmentPoints).toFixed(2), savedAt: Date.now() });
      const lv = level(b.xp);
      this.st.brain = { enabled: b.cfg.enabled, points: +(b.tradingPoints + b.judgmentPoints).toFixed(2), trading: b.tradingPoints, judgment: b.judgmentPoints, xp: b.xp, level: lv.level, title: lv.title, progress: +lv.progress.toFixed(3), last: b.thoughts[0] ?? null, lesson: b.lessons[0] ?? null };
      this.dirty = true;
    }
    if (!this.dirty) return;
    this.dirty = false;
    this.st.savedAt = Date.now();
    this.writeJson('state.json', { ...this.st, closed: this.st.closed.slice(0, 30) });
  }
  private touch() {
    this.dirty = true;
  }

  elapsed() {
    return this.st.elapsed + (this.st.running && this.st.startedAt ? Date.now() - this.st.startedAt : 0);
  }

  /** The page's commands (written through the craft server's data route). */
  private readControl() {
    let m = 0;
    try {
      m = fs.statSync(file('control.json')).mtimeMs;
    } catch {
      return;
    }
    if (m <= this.lastControl) return;
    this.lastControl = m;
    try {
      this.apply(JSON.parse(fs.readFileSync(file('control.json'), 'utf8')) as Command);
    } catch {
      /* a bad file */
    }
  }

  /** One command, from the page or from the Telegram assistant. */
  apply(c: Command): { ok: boolean; error?: string; [k: string]: unknown } {
    const st = this.st;
    const now = Date.now();
    const settings = (c.settings ?? {}) as SettingsInput;
    switch (c.cmd) {
      case 'start':
        if (!st.running) {
          if (this.elapsed() >= st.hours * 3600_000) st.elapsed = 0;
          st.running = true;
          st.startedAt = now;
        }
        break;
      case 'pause':
        if (st.running) {
          st.elapsed = this.elapsed();
          st.running = false;
          st.startedAt = null;
        }
        break;
      case 'reset': {
        const keep = { prices: st.prices, z: st.z, funding: st.funding, vol24: st.vol24, feed: st.feed };
        this.st = { ...freshState(settings, st), ...keep };
        this.st.active = pairlist(this.st.params, this.st.vol24);
        this.tradesDirty = true;
        break;
      }
      case 'settings': {
        // Change the rules without resetting the run (open trades keep their targets).
        const next = freshState({ ...settings, start: st.start }, st);
        st.marginPct = next.marginPct;
        st.hours = next.hours;
        st.params = next.params;
        st.protections = next.protections;
        st.notify = next.notify;
        st.active = pairlist(st.params, st.vol24);
        break;
      }
      case 'forceexit': {
        const ids = c.id === 'all' ? st.positions.map((p) => p.id) : [Number(c.id)];
        let n = 0;
        for (const id of ids) {
          const pos = st.positions.find((p) => p.id === id);
          const px = pos && (st.prices[pos.sym] ?? pos.entry);
          if (pos && px) {
            this.close(pos, { why: 'FORCE', at: px, maker: false });
            n++;
          }
        }
        if (!n) return { ok: false, error: 'no_such_trade' };
        break;
      }
      case 'forceentry': {
        const sym = String(c.sym ?? '');
        const side = c.side === 'SHORT' ? 'SHORT' : 'LONG';
        if (!ALL_SYMS.includes(sym)) return { ok: false, error: 'unknown_pair' };
        if (st.positions.some((p) => p.sym === sym)) return { ok: false, error: 'already_open' };
        if (st.positions.length >= st.params.maxOpen) return { ok: false, error: 'max_open_trades' };
        const r = zScore(this.candles[sym]);
        const px = st.prices[sym];
        if (!r || !px) return { ok: false, error: 'no_price_yet' };
        const pos = this.open({ sym, side, atr: r.atr }, px, 'force');
        if (!pos) return { ok: false, error: 'not_enough_balance' };
        break;
      }
      case 'unlock':
        st.locks = c.pair === 'all' ? [] : st.locks.filter((l) => l.pair !== c.pair);
        break;
      case 'lock': {
        const pair = c.pair === '*' || ALL_SYMS.includes(String(c.pair)) ? String(c.pair) : null;
        if (!pair) return { ok: false, error: 'unknown_pair' };
        const mins = clamp(Number(c.minutes) || 60, 1, 10_080);
        st.locks.push({ pair, until: now + mins * 60_000, at: now, by: 'manual', reason: `Locked by hand for ${mins} min` });
        break;
      }
      case 'backtest':
      case 'hyperopt':
      case 'train':
      case 'walkforward':
        return this.startJob(c);
      case 'brain':
        this.brain.cfg = cleanBrainCfg((c.cfg ?? {}) as never, this.brain.cfg);
        this.brainDirty = true;
        break;
      case 'resetBrain':
        this.brain = freshBrain(this.brain.cfg);
        st.shadows = [];
        this.brainDirty = true;
        break;
      case 'cancelJob':
        if (this.worker && this.job?.status === 'running') {
          this.worker.kill('SIGTERM');
          this.worker = null;
          this.finishJob('cancelled', null);
        }
        break;
      case 'applyHyperopt': {
        let best: Epoch | null = this.hyper?.best ?? null;
        if (!best)
          try {
            best = (JSON.parse(fs.readFileSync(file('hyperopt.json'), 'utf8')) as { best?: Epoch }).best ?? null;
          } catch {
            /* none */
          }
        if (!best) return { ok: false, error: 'no_hyperopt_result' };
        st.params = cleanParams(best.params, st.params);
        if (best.marginPct) st.marginPct = clamp(best.marginPct, 5, 90);
        if (best.protections) st.protections = cleanProtections(best.protections as never, st.protections);
        break;
      }
      default:
        return { ok: false, error: 'unknown_command' };
    }
    this.touch();
    return { ok: true };
  }

  // ---- trading ----------------------------------------------------------------------------------
  private open(sig: { sym: string; side: 'LONG' | 'SHORT'; atr: number }, price: number, tag = 'signal', size = 1, mind?: { keys: string[]; labels: Record<string, string> }): Position | null {
    const st = this.st;
    const used = st.positions.reduce((s, p) => s + p.margin, 0);
    const pos: BrainPos | null = openPosition({ balance: st.balance, marginPct: Math.min(90, st.marginPct * size), usedMargin: used, id: st.nextId++ }, sig, price, st.params, Date.now(), tag);
    if (!pos) return null;
    if (mind) Object.assign(pos, mind);
    st.positions.push(pos);
    this.touch();
    if (st.notify.entry)
      void postHook({
        type: 'notice',
        text: `🤖 <b>Trade Bot</b> فتح ${pos.side === 'LONG' ? '🟢 LONG' : '🔴 SHORT'} <b>${pos.sym}</b> ${pos.lev}x\nدخول ${fmt(pos.entry)} · هدف ${fmt(pos.tp)} · وقف ${fmt(pos.sl)}\nهامش $${pos.margin.toFixed(2)}${tag === 'force' ? ' · يدوي' : ''}\n<i>تداول وهمي</i>`,
      });
    return pos;
  }

  private close(pos: BrainPos, ex: { why: ExitWhy; at: number; maker: boolean }) {
    const st = this.st;
    const now = Date.now();
    const t = closeTrade(pos, ex, st.balance, st.params, now);
    if (pos.keys) this.lesson(learn(this.brain, t, pos.keys, pos.labels ?? {}, true));
    st.balance = +Math.max(0, st.balance + t.pnl).toFixed(4);
    st.positions = st.positions.filter((p) => p.id !== pos.id);
    st.closed.unshift(t);
    if (st.closed.length > CLOSED_KEEP) st.closed.length = CLOSED_KEEP;
    st.equity.push([now, +st.balance.toFixed(2)]);
    if (st.equity.length > 1500) st.equity.splice(0, st.equity.length - 1500);
    // Protections see the trades within their longest lookback.
    const since = now - maxLookbackMs(st.protections);
    const recent = st.closed.filter((x) => x.at >= since);
    const add = protectionsAfter(st.protections, recent, t, now, st.balance);
    st.locks = activeLocks(st.locks, now).concat(add);
    st.stats = computeStats(st.closed, st.start);
    this.tradesDirty = true;
    this.touch();
    if (st.notify.exit)
      void postHook({
        type: 'notice',
        text: `${t.pnl > 0 ? '✅' : '❌'} <b>Trade Bot</b> سكّر <b>${t.sym}</b> ${t.side} ${t.lev}x — ${WHY_AR[t.why] ?? t.why}\n${money(t.pnl)} (${t.pct > 0 ? '+' : ''}${t.pct}%) · الرصيد $${st.balance.toFixed(2)}\n<i>تداول وهمي</i>`,
      });
    if (st.notify.protection)
      for (const l of add.filter((x) => x.by !== 'cooldown'))
        void postHook({ type: 'notice', text: `🛡️ <b>Trade Bot</b> وقّف ${l.pair === '*' ? 'كل التداول' : l.pair} لـ ${Math.round((l.until - now) / 60_000)} دقيقة\n${l.reason}` });
  }

  private lesson(l: ReturnType<typeof learn>) {
    this.brainDirty = true;
    if (this.st.notify.lessons)
      void postHook({ type: 'notice', text: `🧠 <b>Trade Bot</b> ${l.kind === 'win' ? '✅' : l.kind === 'mistake' ? '❌' : l.kind === 'dodged' ? '🛡️' : '😬'} ${l.points >= 0 ? '+' : ''}${l.points.toFixed(2)} نقطة\n${l.text}\n<i>تداول وهمي</i>` });
  }

  private tick(sym: string, c: Candle) {
    const st = this.st;
    st.prices[sym] = c.c;
    if (c.closed) {
      const r = zScore(this.candles[sym]);
      if (r) st.z[sym] = +r.z.toFixed(3);
    }
    if (!st.running) return;
    const now = Date.now();
    for (const pos of st.positions.filter((p) => p.sym === sym)) {
      if (sleeveOf(pos.tag)) {
        if (pos.hedged) continue; // carry: hedged, no liquidation
        // Trend trades end on the channel at a bar's close (trendStep); only a liquidation is checked live.
        if (pos.side === 'LONG' ? c.c <= pos.liq : c.c >= pos.liq) this.close(pos, { why: 'LIQ', at: pos.liq, maker: false });
        continue;
      }
      const ex = exitCheck(pos, { h: c.c, l: c.c, c: c.c }, st.params, now);
      if (ex) this.close(pos, ex);
      else if (updateTrail(pos, c.c, st.params)) this.touch();
    }
    // Shadow trades of skipped signals: no money, only the lesson.
    for (const sh of st.shadows.filter((p) => p.sym === sym)) {
      const ex = exitCheck(sh, { h: c.c, l: c.c, c: c.c }, st.params, now);
      if (!ex) {
        updateTrail(sh, c.c, st.params);
        continue;
      }
      st.shadows = st.shadows.filter((x) => x.id !== sh.id);
      this.lesson(learn(this.brain, closeTrade(sh, ex, st.balance, st.params, now), sh.keys ?? [], sh.labels ?? {}, false));
      this.touch();
    }
    if (st.params.strategy === 'scalp' && c.closed && st.balance > 1 && st.positions.length < st.params.maxOpen) {
      const sigs = st.active
        .filter((s) => !st.positions.some((p) => p.sym === s) && !lockedBy(st.locks, s, now))
        .map((s) => signal(s, this.candles[s], st.params.zEntry, st.params.mode))
        .filter((x): x is NonNullable<typeof x> => !!x)
        .sort((a, b) => b.strength - a.strength);
      for (const sig of sigs) {
        if (st.positions.length >= st.params.maxOpen) break;
        // Deep think: the moment's factors against what each has earned so far.
        const arr = this.candles[sig.sym];
        const px = arr.at(-1)!.c;
        const z = zScore(arr);
        const moment: Moment = {
          sym: sig.sym,
          side: sig.side,
          z: z?.z ?? sig.strength,
          atr: sig.atr,
          trend1h: arr.length > 61 ? px / arr.at(-61)!.c - 1 : null,
          hour: new Date(now).getUTCHours(),
          fundingRate: st.funding[sig.sym]?.rate ?? null,
          last: this.brain.last,
          mode: st.params.mode,
        };
        const th = think(this.brain, sig, moment, now);
        const fs = factorsOf(moment);
        const mind = { keys: fs.map((f) => f.key), labels: Object.fromEntries(fs.map((f) => [f.key, f.label])) };
        this.brainDirty = true;
        if (th.decision === 'SKIP') {
          if (st.shadows.length < 10 && !st.shadows.some((x) => x.sym === sig.sym)) {
            const sh = openPosition({ balance: st.balance, marginPct: st.marginPct, id: -st.nextId++ }, sig, px, st.params, now, 'shadow');
            if (sh) st.shadows.push(Object.assign(sh, mind));
          }
          continue;
        }
        if (!this.open(sig, px, th.explore ? 'explore' : 'brain', th.size, mind)) break;
      }
    }
  }

  /** Funding every 8 h: the rate Binance announced, paid or received on open trades. */
  private async pollFunding() {
    try {
      const r = await fetch(`${API}/premiumIndex`, { signal: AbortSignal.timeout(15_000) });
      if (!r.ok) return;
      const all = (await r.json()) as { symbol: string; lastFundingRate: string; nextFundingTime: number; markPrice: string }[];
      const now = Date.now();
      for (const x of all) {
        const sym = x.symbol.replace(/USDT$/, '');
        if (!ALL_SYMS.includes(sym) || x.symbol !== `${sym}USDT`) continue;
        const prev = this.st.funding[sym];
        if (prev && prev.next <= now && this.st.params.funding)
          for (const pos of this.st.positions.filter((p) => p.sym === sym && p.openedAt < prev.next)) pos.funding += fundingPay(pos, prev.rate, +x.markPrice || pos.entry);
        this.st.funding[sym] = { rate: +x.lastFundingRate, next: +x.nextFundingTime };
      }
      this.touch();
    } catch {
      /* next time */
    }
  }

  /**
   * The portfolio strategies, once a minute: when a sleeve's bar has closed (4 h trend/EMA, daily
   * momentum and coin ranking, 8 h carry), read it and act at once — ≈ the next bar's open, like the
   * backtest. Sleeves dropped from the strategy close their trades at their next bar.
   */
  private async portfolioStep() {
    const st = this.st;
    const p = st.params;
    const weights = sleeveWeights(p);
    const kinds = new Set<SleeveKind>([...(Object.keys(weights) as SleeveKind[]), ...st.positions.map((x) => sleeveOf(x.tag)).filter((k): k is SleeveKind => !!k)]);
    if (!kinds.size) return;
    const now = Date.now();
    const H = 3600_000;
    const barCache = new Map<string, Bar[] | null>();
    const getBars = async (sym: string, tf: number, need: number): Promise<Bar[] | null> => {
      const key = `${sym}:${tf}:${need}`;
      if (barCache.has(key)) return barCache.get(key)!;
      let bars: Bar[] | null = null;
      try {
        const r = await fetch(`${API}/klines?symbol=${sym}USDT&interval=${tf === 24 ? '1d' : `${tf}h`}&limit=${Math.min(1500, need + 1)}`, { signal: AbortSignal.timeout(15_000) });
        if (r.ok) bars = ((await r.json()) as string[][]).map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], f: 0 })).filter((b) => b.t + tf * H <= Date.now());
      } catch {
        /* next minute */
      }
      barCache.set(key, bars);
      return bars;
    };
    for (const k of kinds) {
      const tf = SLEEVE_TF[k](p);
      const tfMs = tf * H;
      const lastOpen = Math.floor(now / tfMs) * tfMs - tfMs; // the latest closed bar
      const pkey = `${k}:${JSON.stringify(k === 'donchian' ? p.trend : p[k])}:${weights[k] ?? 0}`;
      const live = weights[k] ? st.active : [];
      const mine = st.positions.filter((x) => sleeveOf(x.tag) === k);
      const need = k === 'donchian' ? p.trend.N + Math.round((30 * 24) / tf) + 5 : k === 'ema' ? Math.max(p.ema.n * 3, Math.round((30 * 24) / tf)) + 5 : k === 'tsmom' ? Math.max(p.tsmom.L, 31) + 5 : k === 'xsmom' ? p.xsmom.L + 3 : 5;
      // Coin ranking decides for all coins at once, on its rebalance days.
      let ranks: Record<string, -1 | 0 | 1> | null = null;
      if (k === 'xsmom' && this.trendSeen[`xsmom:*`] !== lastOpen + pkey.length && weights.xsmom && isRebalanceDay(lastOpen, p.xsmom.everyDays)) {
        const daily: Record<string, Bar[]> = {};
        const at: Record<string, number> = {};
        for (const sym of live) {
          const b = await getBars(sym, 24, need);
          if (b?.length && b.at(-1)!.t === lastOpen) {
            daily[sym] = b;
            at[sym] = b.length - 1;
          }
        }
        if (Object.keys(at).length === live.length) ranks = rankTargets(daily, at, p);
      }
      for (const sym of new Set([...live, ...mine.map((x) => x.sym)])) {
        const seenKey = `${k}:${sym}`;
        if (this.trendSeen[seenKey] === lastOpen && this.trendSeenKey[seenKey] === pkey) continue;
        const bars = await getBars(sym, tf, need);
        if (!bars?.length || bars.at(-1)!.t !== lastOpen) continue;
        const i = bars.length - 1;
        const pos = mine.find((x) => x.sym === sym);
        const cur = pos ? (pos.side === 'LONG' ? 1 : -1) : 0;
        let target: number;
        if (!weights[k] || !live.includes(sym)) target = 0; // sleeve or pair switched off: close at its bar
        else if (k === 'xsmom') {
          if (!isRebalanceDay(lastOpen, p.xsmom.everyDays)) target = cur;
          else if (!ranks) continue; // ranking needs every coin's bar; try again next minute
          else target = ranks[sym] ?? 0;
        } else {
          let funding: [number, number][] | undefined;
          if (k === 'carry') {
            try {
              const r = await fetch(`${API}/fundingRate?symbol=${sym}USDT&limit=${p.carry.lookDays * 3 + 3}`, { signal: AbortSignal.timeout(15_000) });
              funding = r.ok ? ((await r.json()) as { fundingTime: number; fundingRate: string }[]).map((x) => [+x.fundingTime, +x.fundingRate] as [number, number]) : undefined;
            } catch {
              funding = undefined;
            }
            if (!funding) continue;
          }
          target = coinTarget(k, bars, i, cur, p, { ema: k === 'ema' ? emaSeries(bars.map((b) => b.c), p.ema.n) : undefined, funding });
        }
        this.trendSeen[seenKey] = lastOpen;
        this.trendSeenKey[seenKey] = pkey;
        const vol = k === 'xsmom' || k === 'carry' ? null : annVol(bars, i, tf);
        const ch = k === 'donchian' ? channels(bars, i, p.trend) : null;
        if (k === 'donchian' && ch) st.trend[sym] = { entry: ch.entry, exit: ch.exit, close: bars[i].c, at: bars[i].t + tfMs, vol: vol && +vol.toFixed(3), w: +trendWeight(vol, p.trend).toFixed(3), target };
        (st.sleeves[k] ??= {})[sym] = { target, at: bars[i].t + tfMs, close: bars[i].c };
        this.touch();
        if (!st.running) continue;
        const px = st.prices[sym] ?? bars[i].c;
        if (target !== cur) {
          if (pos) this.close(pos, { why: 'TREND', at: px, maker: false });
          if (target !== 0 && st.balance > 1) {
            const used = st.positions.reduce((x, q) => x + q.margin, 0);
            const size = sleeveSizing(k, p, st.balance, weights[k]!, st.active.length, vol);
            const np = openSleeve(k, { alloc: Math.min(size.alloc, st.balance - used), id: st.nextId++ }, sym, target > 0 ? 'LONG' : 'SHORT', px, size.w, ch ? (target > 0 ? ch.exit : ch.shortExit) : null, p, Date.now());
            if (np) {
              st.positions.push(np);
              if (st.notify.entry)
                void postHook({ type: 'notice', text: `📈 <b>Trade Bot</b> ${SLEEVE_AR[k]}: ${np.hedged ? '🛡️ تحوّط وجمع تمويل' : np.side === 'LONG' ? '🟢 LONG' : '🔴 SHORT'} <b>${sym}</b>\nدخول ${fmt(np.entry)}${k === 'donchian' ? ` · الخروج تحت ${fmt(np.sl)}` : ''}\nحجم $${np.size.toFixed(2)}\n<i>تداول وهمي</i>` });
            }
          }
        } else if (pos && ch) pos.sl = pos.side === 'LONG' ? ch.exit : ch.shortExit; // the exit line follows the channel
      }
      if (ranks) this.trendSeen['xsmom:*'] = lastOpen + pkey.length;
    }
  }

  /** 24h volume per coin, for the volume pairlist. */
  private async pollVolume() {
    try {
      const r = await fetch(`${API}/ticker/24hr`, { signal: AbortSignal.timeout(15_000) });
      if (!r.ok) return;
      for (const x of (await r.json()) as { symbol: string; quoteVolume: string }[]) {
        const sym = x.symbol.replace(/USDT$/, '');
        if (ALL_SYMS.includes(sym) && x.symbol === `${sym}USDT`) this.st.vol24[sym] = Math.round(+x.quoteVolume);
      }
      this.st.active = pairlist(this.st.params, this.st.vol24);
      this.touch();
    } catch {
      /* next time */
    }
  }

  /** A short summary on Telegram at 23:55 Dubai time, on days the bot ran. */
  private daily() {
    const st = this.st;
    const now = Date.now();
    const d = new Date(now + 4 * 3600_000);
    if (!st.notify.daily || d.getUTCHours() !== 23 || d.getUTCMinutes() < 55) return;
    const today = dubaiDay(now);
    if (st.lastDaily === today) return;
    st.lastDaily = today;
    this.touch();
    const row = st.stats.daily.find((r) => r.key === today);
    if (!row && !st.running) return;
    const t = row ?? { trades: 0, profit: 0, pct: 0, wins: 0 };
    void postHook({
      type: 'notice',
      text: `📊 <b>Trade Bot — ملخص اليوم</b>\n${t.trades} صفقة · ${t.wins} رابحة\nالربح ${money(t.profit)} (${t.pct > 0 ? '+' : ''}${t.pct}%)\nالرصيد $${st.balance.toFixed(2)} من $${st.start} · المجموع ${st.stats.profitPct > 0 ? '+' : ''}${st.stats.profitPct}%\n🧠 النقاط ${st.brain.points} · ${st.brain.title}\n<i>تداول وهمي</i>`,
    });
  }

  // ---- backtest / hyperopt jobs -------------------------------------------------------------------
  private startJob(c: Command): { ok: boolean; error?: string; job?: number } {
    if (this.job?.status === 'running') return { ok: false, error: 'job_running' };
    const st = this.st;
    const kind = c.cmd === 'hyperopt' ? 'hyperopt' : c.cmd === 'train' ? 'train' : c.cmd === 'walkforward' ? 'walkforward' : 'backtest';
    const trendJob = cleanParams(((c.settings ?? {}) as SettingsInput).params ?? {}, st.params).strategy !== 'scalp' && kind !== 'train' && c.brain !== true;
    if (kind === 'walkforward' && !trendJob) return { ok: false, error: 'walkforward_needs_a_portfolio_strategy' };
    const days = clamp(Number(c.days) || 7, 1, trendJob ? 2200 : kind === 'backtest' ? 60 : 30);
    const useBrain = kind === 'train' || (kind === 'backtest' && c.brain === true);
    const s = (c.settings ?? {}) as SettingsInput;
    const params = cleanParams(s.params ?? {}, st.params);
    const protections = cleanProtections(s.protections ?? {}, st.protections);
    const useProtections = c.protections !== false;
    let ho: HyperoptOpts | undefined;
    if (kind === 'hyperopt') {
      const spaces: Space[] = Array.isArray(c.spaces) ? (c.spaces.filter((x) => SPACES.includes(x as Space)) as Space[]) : ['buy', 'sell'];
      ho = {
        epochs: clamp(Math.round(Number(c.epochs) || 200), 10, 2000),
        loss: LOSSES.includes(c.loss as LossName) ? (c.loss as LossName) : 'sharpe',
        spaces: spaces.length ? spaces : ['buy', 'sell'],
        minTrades: clamp(Math.round(Number(c.minTrades) || 10), 1, 1000),
        seed: Math.floor(Math.random() * 1e9),
      };
    }
    const input: JobInput = {
      kind,
      days,
      settings: { start: clamp(Number(s.start) || st.start, 10, 1e7), marginPct: clamp(Number(s.marginPct) || st.marginPct, 5, 90), params, protections, useProtections },
      hyperopt: ho,
      brain: useBrain ? structuredClone(this.brain) : undefined,
      walk:
        kind === 'walkforward'
          ? {
              trainDays: clamp(Math.round(Number(c.trainDays) || 365), 60, 1500),
              testDays: clamp(Math.round(Number(c.testDays) || 90), 14, 365),
              epochs: clamp(Math.round(Number(c.epochs) || 30), 5, 300),
              loss: LOSSES.includes(c.loss as LossName) ? (c.loss as LossName) : 'sharpe',
              minTrades: clamp(Math.round(Number(c.minTrades) || 10), 1, 1000),
            }
          : undefined,
      useBrain,
      cacheDir: path.join(config.dataDir, 'tradebot-cache'),
    };
    this.job = { id: Date.now(), kind, status: 'running', phase: 'download', done: 0, total: 1, note: '', startedAt: Date.now(), endedAt: null, error: null, days, epochs: ho?.epochs, loss: ho?.loss, spaces: ho?.spaces };
    this.hyper = kind === 'hyperopt' ? { epochs: [], best: null } : null;
    if (kind === 'hyperopt') this.writeJson('hyperopt.json', { status: 'running', job: this.job, epochs: [], best: null, spaces: ho!.spaces, loss: ho!.loss });
    this.writeJob();
    const w = spawnJob(input);
    this.worker = w;
    let lastWrite = 0;
    readline.createInterface({ input: w.stdout! }).on('line', (line) => {
      let m: JobMessage;
      try {
        m = JSON.parse(line) as JobMessage;
      } catch {
        return;
      }
      const job = this.job;
      if (!job || this.worker !== w) return;
      if (m.type === 'progress') {
        Object.assign(job, { phase: m.phase, done: m.done, total: m.total, note: m.note ?? job.note });
        if (Date.now() - lastWrite > 500) {
          lastWrite = Date.now();
          this.writeJob();
        }
      } else if (m.type === 'epoch' && this.hyper) {
        const e = m.epoch as Epoch;
        this.hyper.epochs.push(e);
        this.hyper.best = m.best as Epoch;
        if (Date.now() - lastWrite > 700) {
          lastWrite = Date.now();
          this.writeHyper('running');
          this.writeJob();
        }
      } else if (m.type === 'result') {
        if (kind === 'backtest') this.writeJson('backtest.json', { ...(m.data as object), job: { ...job, status: 'done' }, at: Date.now() });
        else if (kind === 'train') this.adoptTraining(m.data as Record<string, unknown>);
        else if (kind === 'walkforward') this.writeJson('walkforward.json', { ...(m.data as object), job: { ...job, status: 'done' }, at: Date.now() });
        else this.writeHyper('done', m.data as Record<string, unknown>);
        this.finishJob('done', m.data as Record<string, unknown>);
      } else if (m.type === 'error') this.finishJob('error', null, m.message);
    });
    let errText = '';
    w.stderr?.on('data', (d: Buffer) => (errText = (errText + d.toString()).slice(-400)));
    w.on('error', (e: Error) => this.worker === w && this.finishJob('error', null, e.message));
    w.on('exit', (code, signal) => {
      if (this.worker !== w) return;
      this.worker = null;
      if (this.job?.status === 'running') this.finishJob('error', null, signal === 'SIGKILL' || code === 137 ? 'the job ran out of memory (it was stopped; MinisManager is fine)' : `job exited (${code ?? signal}) ${errText.split('\n').filter(Boolean).at(-1) ?? ''}`.trim());
    });
    return { ok: true, job: this.job.id };
  }

  /** A training run: the brain keeps what it learned on history; the live score stays its own. */
  private adoptTraining(d: Record<string, unknown>) {
    const trained = d.brain ? loadBrain(d.brain) : null;
    const pr = (d.practice ?? { trading: 0, judgment: 0, trades: 0, shadows: 0 }) as { trading: number; judgment: number; trades: number; shadows: number };
    if (trained) adoptKnowledge(this.brain, trained, { days: Number(d.days) || 0, trades: pr.trades + pr.shadows, points: +(pr.trading + pr.judgment).toFixed(2) }, Date.now());
    this.brainDirty = true;
    const { brain: _b, closed: _c, ...rest } = d as Record<string, unknown>;
    void _b;
    void _c;
    this.writeJson('train.json', { ...rest, lessons: trained?.lessons.slice(0, 20) ?? [], job: { ...this.job, status: 'done' }, at: Date.now() });
  }

  private writeJob() {
    if (this.job) this.writeJson('job.json', this.job);
  }

  private writeHyper(status: string, result?: Record<string, unknown>) {
    const h = this.hyper;
    if (!h || !this.job) return;
    // Every epoch as a light point for the page's scatter; the full numbers for the best ones.
    this.writeJson('hyperopt.json', {
      status,
      job: this.job,
      loss: this.job.loss,
      spaces: this.job.spaces,
      points: h.epochs.map((e) => [e.epoch, e.profitPct, e.ddPct, e.trades, e.loss]),
      latest: h.epochs.slice(-12).reverse(),
      best: h.best,
      ...(result ?? {}),
      at: Date.now(),
    });
  }

  private finishJob(status: JobState['status'], data: Record<string, unknown> | null, error?: string) {
    const job = this.job;
    if (!job) return;
    Object.assign(job, { status, endedAt: Date.now(), error: error ?? null });
    if (status !== 'done' && job.kind === 'hyperopt') this.writeHyper(status);
    this.writeJob();
    this.worker = null;
    if (!this.st.notify.jobs) return;
    const mins = Math.max(1, Math.round((Date.now() - job.startedAt) / 60_000));
    if (status === 'error') void postHook({ type: 'notice', text: `⚠️ <b>Trade Bot</b> ما زبط ${job.kind === 'backtest' ? 'الباك تست' : job.kind === 'train' ? 'التدريب' : job.kind === 'walkforward' ? 'الـ Walk-forward' : 'الـ Hyperopt'}\n<code>${(error ?? '').slice(0, 200)}</code>` });
    else if (status === 'done' && data) {
      if (job.kind === 'walkforward') {
        const d = data as { stats: Stats; windows: { testProfitPct: number }[] };
        void postHook({
          type: 'notice',
          text: `🚶 <b>Trade Bot — Walk-forward</b> (${mins} د)\n${d.windows.length} نافذة · ${d.windows.filter((w) => w.testProfitPct > 0).length} رابحة\nالنتيجة ${d.stats.profitPct > 0 ? '+' : ''}${d.stats.profitPct}% · ${d.stats.cagr ?? '—'}% بالسنة · أقصى هبوط ${d.stats.maxDrawdownPct}%`,
        });
      } else if (job.kind === 'train') {
        const pr = (data as { practice?: { trading: number; judgment: number; trades: number; shadows: number } }).practice;
        void postHook({
          type: 'notice',
          text: `🧠 <b>Trade Bot — تدرّب على ${job.days} يوم</b> (${mins} د)\nدرس ${pr ? pr.trades + pr.shadows : 0} موقف (${pr?.trades ?? 0} صفقة + ${pr?.shadows ?? 0} تخطّاها)\nنقاط التمرين: ${pr ? (pr.trading + pr.judgment).toFixed(1) : 0}\nالمستوى الآن: ${level(this.brain.xp).title}`,
        });
      } else if (job.kind === 'backtest') {
        const s = (data as { stats: Stats }).stats;
        void postHook({
          type: 'notice',
          text: `🧪 <b>Trade Bot — باك تست ${job.days} يوم</b> (${mins} د)\n${s.trades} صفقة · فوز ${s.winrate}%\nالربح ${money(s.profit)} (${s.profitPct > 0 ? '+' : ''}${s.profitPct}%) · أقصى هبوط ${s.maxDrawdownPct}%\nProfit factor ${s.profitFactor ?? '—'} · Sharpe ${s.sharpe ?? '—'}`,
        });
      } else {
        const b = (data as { best: Epoch | null }).best;
        void postHook({
          type: 'notice',
          text: b
            ? `🧬 <b>Trade Bot — Hyperopt خلص</b> (${job.epochs} محاولة، ${mins} د)\nأحسن نتيجة: ${b.trades} صفقة · ${b.profitPct > 0 ? '+' : ''}${b.profitPct}% · هبوط ${b.ddPct}%\nافتح البوت واضغط Apply إذا بدك تعتمدها.`
            : `🧬 <b>Trade Bot — Hyperopt خلص</b> بدون نتيجة`,
        });
      }
    }
  }

  // ---- feed -----------------------------------------------------------------------------------------
  private async history() {
    for (const s of ALL_SYMS) {
      const r = await fetch(`${API}/klines?symbol=${s}USDT&interval=1m&limit=120`, { signal: AbortSignal.timeout(15_000) });
      if (!r.ok) throw new Error(`binance_${r.status}`);
      this.candles[s] = ((await r.json()) as string[][]).map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[7], closed: true }));
      this.st.prices[s] = this.candles[s].at(-1)!.c;
      const z = zScore(this.candles[s]);
      if (z) this.st.z[s] = +z.z.toFixed(3);
    }
  }

  private connect() {
    if (this.stopped) return;
    const ws = new WebSocket(WS_URL);
    this.ws = ws;
    ws.onopen = () => {
      this.st.feed = 'ok';
      this.touch();
    };
    ws.onmessage = (e) => {
      try {
        const d = JSON.parse(String(e.data)).data as { s: string; k: { t: number; o: string; h: string; l: string; c: string; q: string; x: boolean } };
        const sym = d.s.replace('USDT', '');
        const arr = this.candles[sym];
        if (!arr) return;
        const c: Candle = { t: d.k.t, o: +d.k.o, h: +d.k.h, l: +d.k.l, c: +d.k.c, v: +d.k.q, closed: d.k.x };
        if (arr.length && arr.at(-1)!.t === c.t) arr[arr.length - 1] = c;
        else {
          arr.push(c);
          if (arr.length > 200) arr.shift();
        }
        this.tick(sym, c);
      } catch {
        /* bad frame */
      }
    };
    ws.onclose = () => {
      this.st.feed = 'down';
      this.touch();
      if (!this.stopped) this.timers.push(setTimeout(() => void this.resync(), 5000));
    };
    ws.onerror = () => ws.close();
  }

  /** After a drop: fresh candles (no gaps in the signal), then the live feed again. */
  private async resync() {
    try {
      await this.history();
    } catch {
      /* keep the old candles; the feed fills in */
    }
    this.connect();
  }

  async start() {
    this.load();
    this.timers.push(
      setInterval(() => {
        this.readControl();
        const st = this.st;
        if (st.running && this.elapsed() >= st.hours * 3600_000) {
          st.elapsed = this.elapsed();
          st.running = false;
          st.startedAt = null;
          this.touch();
        }
        const before = st.locks.length;
        st.locks = activeLocks(st.locks, Date.now());
        if (st.locks.length !== before) this.touch();
        this.daily();
        // A heartbeat every 30 s shows the engine is alive; open trades refresh every 2 s.
        if (Date.now() - st.savedAt > 30_000 || (st.positions.length && Date.now() - st.savedAt > 2000)) this.touch();
        this.write();
      }, 2000),
      // The equity curve: a point every 5 minutes while running.
      setInterval(() => {
        const st = this.st;
        if (!st.running) return;
        const unreal = st.positions.reduce((s, p) => s + (st.prices[p.sym] ? pnlOf(p, st.prices[p.sym]) - p.fees + p.funding : 0), 0);
        st.equity.push([Date.now(), +(st.balance + unreal).toFixed(2)]);
        if (st.equity.length > 1500) st.equity.splice(0, st.equity.length - 1500);
      }, 5 * 60_000),
      setInterval(() => void this.pollFunding(), 60_000),
      setInterval(() => void this.pollVolume(), 10 * 60_000),
      setInterval(() => void this.portfolioStep(), 60_000),
    );
    void this.pollFunding();
    void this.pollVolume();
    setTimeout(() => void this.portfolioStep(), 5000);
    await this.resync();
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.ws?.close();
    this.worker?.kill('SIGTERM');
    this.write();
  }
}

let engine: Engine | null = null;
/** Starts the bot engine when the Trade Bot app is installed (~/ArtCraft/tradebot). */
export function startTradeBot(): () => void {
  if (process.env.VITEST || engine || !fs.existsSync(path.join(config.craftRoot, 'tradebot', 'app.json'))) return () => {};
  engine = new Engine();
  void engine.start().catch(() => {});
  return () => {
    engine?.stop();
    engine = null;
  };
}

/** For the Telegram assistant (bot API): what the bot is doing, in short. */
export function tradebotSnapshot() {
  if (!engine) return null;
  const st = engine.st;
  const now = Date.now();
  return {
    paper: true,
    running: st.running,
    balance: st.balance,
    start: st.start,
    hours: st.hours,
    elapsedHours: +(engine.elapsed() / 3600_000).toFixed(2),
    open: st.positions.map((p) => ({ id: p.id, sym: p.sym, side: p.side, lev: p.lev, entry: p.entry, price: st.prices[p.sym] ?? null, tp: p.tp, sl: p.sl, unrealized: st.prices[p.sym] ? +(pnlOf(p, st.prices[p.sym]) - p.fees + p.funding).toFixed(2) : null, minutes: Math.round((now - p.openedAt) / 60_000) })),
    stats: { ...st.stats, perTag: undefined, weekly: undefined, monthly: undefined, daily: st.stats.daily.slice(0, 7) },
    recent: st.closed.slice(0, 5),
    locks: activeLocks(st.locks, now).filter((l) => l.by !== 'cooldown'),
    pairs: st.active,
    settings: { marginPct: st.marginPct, ...st.params },
    job: engine.job,
    brain: { ...st.brain, last: undefined, cfg: engine.brain.cfg, lessons: engine.brain.lessons.slice(0, 5).map((l) => l.text), learned: insights(engine.brain, labelOf) },
  };
}

/** Commands the Telegram assistant may send (all paper trading). */
export const BOT_COMMANDS = ['start', 'pause', 'forceexit', 'unlock', 'backtest', 'hyperopt', 'applyHyperopt', 'cancelJob', 'train', 'walkforward'];
export function tradebotCommand(c: Command) {
  if (!engine) return { ok: false, error: 'tradebot_not_running' };
  if (!BOT_COMMANDS.includes(c.cmd)) return { ok: false, error: 'not_allowed' };
  return engine.apply(c);
}
