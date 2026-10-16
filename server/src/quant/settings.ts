import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

/**
 * Quant Desk settings: model providers and routing, the assets traded, and the risk limits the
 * engine enforces *independently of any AI opinion*. Stored in var/quant.json (mode 0600). Keys are
 * never returned to the browser; the API only says whether each one is set.
 */
export type Provider = 'anthropic' | 'openai' | 'ollama';
export interface Tier {
  provider: Provider;
  model: string;
}
export interface RiskLimits {
  /** Paper/live starting cash (USD). */
  startBalance: number;
  /** Risk per trade as % of equity (distance to the stop decides the size). */
  riskPct: number;
  /** Largest single position, % of equity. */
  maxPositionPct: number;
  /** Total open exposure, % of equity. */
  maxExposurePct: number;
  maxOpen: number;
  /** Initial stop as a multiple of the 14-day ATR, and the hard floor/ceiling in %. */
  stopAtr: number;
  stopMinPct: number;
  stopMaxPct: number;
  /** Take-profit as reward:risk; trailing stop arms after trailArmR and follows at trailAtr × ATR. */
  takeProfitR: number;
  trailArmR: number;
  trailAtr: number;
  /** Stop trading for the day once realised + unrealised loss reaches this % of equity. */
  dailyLossPct: number;
  /** Give up on a position after this many days without hitting target or stop. */
  maxHoldDays: number;
  /** Minutes to wait after a loss before re-entering the same asset. */
  cooldownMin: number;
  /** Entry needs a merged score at least this high; exit below this. */
  entryScore: number;
  exitScore: number;
  /** A price older than this is never traded on; two sources further apart than this % are suspect. */
  maxPriceAgeSec: number;
  maxSourceGapPct: number;
}
export interface QuantSettings {
  /** 'regime': long while price > SMA200 and EMA20 > EMA50, 15 % trailing stop (best in LEAN tests). 'rules': merged-score engine. */
  strategy: 'regime' | 'rules';
  regime: { trailPct: number; cooldownDays: number };
  /** Let a decisive agents Sell veto/close trades (untested on history; off by default). */
  agentsVeto: boolean;
  /** Futures (Binance USDⓈ-M perpetuals) paper book: regime on a short timeframe, both directions, leverage. */
  futures: {
    enabled: boolean;
    assets: string[];
    tf: '1h' | '4h';
    leverage: number;
    marginPct: number;
    trailAtr: number;
    allowShort: boolean;
    cooldownBars: number;
    startBalance: number;
    emaFast: number;
    emaSlow: number;
    emaTrend: number;
  };
  assets: string[];
  keys: { anthropic: string; openai: string };
  ollamaUrl: string;
  routing: { quick: Tier; deep: Tier; fallback: Provider[] };
  analysts: string[];
  /** Agents run once per asset per day at this UTC hour; 0 scans/day = off. */
  agentsHourUtc: number;
  agentsEnabled: boolean;
  /** Max agent runs per day (cost guard). */
  agentsDailyCap: number;
  weights: { technical: number; agents: number; news: number };
  risk: RiskLimits;
  /** The engine opens paper positions when on. */
  paperEnabled: boolean;
  /** Live execution: off unless the owner explicitly authorised it (see live.ts). */
  live: { enabled: boolean; broker: 'binance' | 'binance-testnet' | 'kraken' | 'none'; authorizedAt: number | null; authorizedBy: number | null; maxNotionalUsd: number; killSwitch: boolean };
  updatedAt: number;
}

export const DEFAULT_RISK: RiskLimits = {
  startBalance: 10_000,
  riskPct: 1,
  maxPositionPct: 25,
  maxExposurePct: 60,
  maxOpen: 4,
  stopAtr: 2,
  stopMinPct: 2,
  stopMaxPct: 10,
  takeProfitR: 2.5,
  trailArmR: 1,
  trailAtr: 2,
  dailyLossPct: 3,
  maxHoldDays: 14,
  cooldownMin: 240,
  entryScore: 0.35,
  exitScore: -0.15,
  maxPriceAgeSec: 120,
  maxSourceGapPct: 2,
};

export const DEFAULTS: QuantSettings = {
  strategy: 'regime',
  regime: { trailPct: 15, cooldownDays: 10 },
  agentsVeto: false,
  futures: {
    enabled: true,
    assets: ['BTC', 'ETH', 'SOL'],
    tf: '4h',
    leverage: 2,
    marginPct: 20,
    trailAtr: 10,
    allowShort: true,
    cooldownBars: 6,
    startBalance: 10_000,
    emaFast: 20,
    emaSlow: 50,
    emaTrend: 200,
  },
  assets: ['BTC', 'ETH', 'SOL', 'GOLD'],
  keys: { anthropic: '', openai: '' },
  ollamaUrl: 'http://127.0.0.1:11434',
  routing: { quick: { provider: 'anthropic', model: 'claude-haiku-4-5' }, deep: { provider: 'anthropic', model: 'claude-sonnet-5' }, fallback: ['anthropic', 'openai', 'ollama'] },
  analysts: ['market', 'news', 'social'],
  agentsHourUtc: 6,
  agentsEnabled: true,
  agentsDailyCap: 12,
  weights: { technical: 0.4, agents: 0.4, news: 0.2 },
  risk: DEFAULT_RISK,
  paperEnabled: true,
  live: { enabled: false, broker: 'none', authorizedAt: null, authorizedBy: null, maxNotionalUsd: 0, killSwitch: false },
  updatedAt: 0,
};

const file = () => path.join(config.dataDir, 'quant.json');
let cache: QuantSettings | null = null;

const clamp = (v: unknown, lo: number, hi: number, d: number) => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};
const PROVIDERS: Provider[] = ['anthropic', 'openai', 'ollama'];
const tier = (t: unknown, d: Tier): Tier => {
  const o = (t ?? {}) as Partial<Tier>;
  return { provider: PROVIDERS.includes(o.provider as Provider) ? (o.provider as Provider) : d.provider, model: typeof o.model === 'string' && o.model.trim() ? o.model.trim().slice(0, 80) : d.model };
};

/** Validates and clamps everything so a bad file or request can never produce unsafe limits. */
export function normalize(raw: Partial<QuantSettings> | undefined, base: QuantSettings = DEFAULTS): QuantSettings {
  const r = raw ?? {};
  const rk = (r.risk ?? {}) as Partial<RiskLimits>;
  const b = base.risk;
  const risk: RiskLimits = {
    startBalance: clamp(rk.startBalance, 100, 1e8, b.startBalance),
    riskPct: clamp(rk.riskPct, 0.1, 5, b.riskPct),
    maxPositionPct: clamp(rk.maxPositionPct, 1, 50, b.maxPositionPct),
    maxExposurePct: clamp(rk.maxExposurePct, 1, 100, b.maxExposurePct),
    maxOpen: Math.round(clamp(rk.maxOpen, 1, 10, b.maxOpen)),
    stopAtr: clamp(rk.stopAtr, 0.5, 6, b.stopAtr),
    stopMinPct: clamp(rk.stopMinPct, 0.5, 20, b.stopMinPct),
    stopMaxPct: clamp(rk.stopMaxPct, 1, 30, b.stopMaxPct),
    takeProfitR: clamp(rk.takeProfitR, 0.5, 10, b.takeProfitR),
    trailArmR: clamp(rk.trailArmR, 0.2, 5, b.trailArmR),
    trailAtr: clamp(rk.trailAtr, 0.5, 6, b.trailAtr),
    dailyLossPct: clamp(rk.dailyLossPct, 0.5, 20, b.dailyLossPct),
    maxHoldDays: Math.round(clamp(rk.maxHoldDays, 1, 90, b.maxHoldDays)),
    cooldownMin: Math.round(clamp(rk.cooldownMin, 0, 10080, b.cooldownMin)),
    entryScore: clamp(rk.entryScore, 0.05, 1, b.entryScore),
    exitScore: clamp(rk.exitScore, -1, 0, b.exitScore),
    maxPriceAgeSec: Math.round(clamp(rk.maxPriceAgeSec, 10, 3600, b.maxPriceAgeSec)),
    maxSourceGapPct: clamp(rk.maxSourceGapPct, 0.1, 20, b.maxSourceGapPct),
  };
  if (risk.stopMaxPct < risk.stopMinPct) risk.stopMaxPct = risk.stopMinPct;
  const w = (r.weights ?? {}) as Partial<QuantSettings['weights']>;
  const live = (r.live ?? {}) as Partial<QuantSettings['live']>;
  const keys = (r.keys ?? {}) as Partial<QuantSettings['keys']>;
  const routing = (r.routing ?? {}) as Partial<QuantSettings['routing']>;
  const assets = Array.isArray(r.assets) ? r.assets.filter((a): a is string => typeof a === 'string' && /^[A-Z]{2,10}$/.test(a)).slice(0, 12) : base.assets;
  const rg = (r.regime ?? {}) as Partial<QuantSettings['regime']>;
  return {
    strategy: r.strategy === 'rules' || r.strategy === 'regime' ? r.strategy : base.strategy,
    regime: { trailPct: clamp(rg.trailPct, 3, 40, base.regime.trailPct), cooldownDays: Math.round(clamp(rg.cooldownDays, 0, 60, base.regime.cooldownDays)) },
    agentsVeto: typeof r.agentsVeto === 'boolean' ? r.agentsVeto : base.agentsVeto,
    futures: (() => {
      const f = (r.futures ?? {}) as Partial<QuantSettings['futures']>;
      const b = base.futures;
      const fa = Array.isArray(f.assets) ? f.assets.filter((a): a is string => typeof a === 'string' && /^[A-Z]{2,10}$/.test(a)).slice(0, 8) : b.assets;
      return {
        enabled: typeof f.enabled === 'boolean' ? f.enabled : b.enabled,
        assets: fa.length ? fa : b.assets,
        tf: f.tf === '1h' || f.tf === '4h' ? f.tf : b.tf,
        leverage: Math.round(clamp(f.leverage, 1, 10, b.leverage)),
        marginPct: clamp(f.marginPct, 5, 50, b.marginPct),
        trailAtr: clamp(f.trailAtr, 1, 20, b.trailAtr),
        allowShort: typeof f.allowShort === 'boolean' ? f.allowShort : b.allowShort,
        cooldownBars: Math.round(clamp(f.cooldownBars, 0, 48, b.cooldownBars)),
        startBalance: clamp(f.startBalance, 100, 1e8, b.startBalance),
        emaFast: Math.round(clamp(f.emaFast, 3, 100, b.emaFast)),
        emaSlow: Math.round(clamp(f.emaSlow, 5, 300, b.emaSlow)),
        emaTrend: Math.round(clamp(f.emaTrend, 20, 500, b.emaTrend)),
      };
    })(),
    assets: assets.length ? assets : base.assets,
    keys: { anthropic: typeof keys.anthropic === 'string' ? keys.anthropic.trim() : base.keys.anthropic, openai: typeof keys.openai === 'string' ? keys.openai.trim() : base.keys.openai },
    ollamaUrl: typeof r.ollamaUrl === 'string' && /^https?:\/\//.test(r.ollamaUrl) ? r.ollamaUrl.replace(/\/+$/, '') : base.ollamaUrl,
    routing: {
      quick: tier(routing.quick, base.routing.quick),
      deep: tier(routing.deep, base.routing.deep),
      fallback: Array.isArray(routing.fallback) && routing.fallback.length ? routing.fallback.filter((p): p is Provider => PROVIDERS.includes(p as Provider)) : base.routing.fallback,
    },
    analysts: Array.isArray(r.analysts) ? r.analysts.filter((a): a is string => ['market', 'news', 'social', 'fundamentals'].includes(a as string)) : base.analysts,
    agentsHourUtc: Math.round(clamp(r.agentsHourUtc, 0, 23, base.agentsHourUtc)),
    agentsEnabled: typeof r.agentsEnabled === 'boolean' ? r.agentsEnabled : base.agentsEnabled,
    agentsDailyCap: Math.round(clamp(r.agentsDailyCap, 0, 100, base.agentsDailyCap)),
    weights: { technical: clamp(w.technical, 0, 1, base.weights.technical), agents: clamp(w.agents, 0, 1, base.weights.agents), news: clamp(w.news, 0, 1, base.weights.news) },
    risk,
    paperEnabled: typeof r.paperEnabled === 'boolean' ? r.paperEnabled : base.paperEnabled,
    live: {
      enabled: typeof live.enabled === 'boolean' ? live.enabled : base.live.enabled,
      broker: (['binance', 'binance-testnet', 'kraken', 'none'] as const).includes(live.broker as never) ? (live.broker as QuantSettings['live']['broker']) : base.live.broker,
      authorizedAt: typeof live.authorizedAt === 'number' ? live.authorizedAt : base.live.authorizedAt,
      authorizedBy: typeof live.authorizedBy === 'number' ? live.authorizedBy : base.live.authorizedBy,
      maxNotionalUsd: clamp(live.maxNotionalUsd, 0, 1e7, base.live.maxNotionalUsd),
      killSwitch: typeof live.killSwitch === 'boolean' ? live.killSwitch : base.live.killSwitch,
    },
    updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : base.updatedAt,
  };
}

export function getSettings(): QuantSettings {
  if (cache) return cache;
  try {
    cache = normalize(JSON.parse(fs.readFileSync(file(), 'utf8')) as Partial<QuantSettings>);
  } catch {
    cache = { ...DEFAULTS, risk: { ...DEFAULT_RISK } };
  }
  return cache;
}

/** Merges a partial update (deep for keys/routing/risk/live/weights) and persists it. */
export function saveSettings(patch: Partial<QuantSettings>): QuantSettings {
  const cur = getSettings();
  const merged: Partial<QuantSettings> = {
    ...cur,
    ...patch,
    keys: { ...cur.keys, ...(patch.keys ?? {}) },
    routing: { ...cur.routing, ...(patch.routing ?? {}) },
    weights: { ...cur.weights, ...(patch.weights ?? {}) },
    risk: { ...cur.risk, ...(patch.risk ?? {}) },
    regime: { ...cur.regime, ...(patch.regime ?? {}) },
    futures: { ...cur.futures, ...(patch.futures ?? {}) },
    live: { ...cur.live, ...(patch.live ?? {}) },
    updatedAt: Date.now(),
  };
  cache = normalize(merged, cur);
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  const tmp = `${file()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file());
  return cache;
}

/** What the browser may see: everything except the key values. */
export function publicSettings(s = getSettings()) {
  return { ...s, keys: { anthropic: !!s.keys.anthropic, openai: !!s.keys.openai } };
}

/** Providers that can actually serve a request right now, in fallback order. */
export function availableProviders(s = getSettings()): Provider[] {
  return s.routing.fallback.filter((p) => (p === 'anthropic' ? !!s.keys.anthropic : p === 'openai' ? !!s.keys.openai : true));
}
