import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { getDb } from '../db.js';

/**
 * The playbook: how each asset actually reacted to each kind of event, measured on history.
 * It starts from a curated list of dated events (2020 → mid-2025) and grows with every event the
 * bot assesses live, once the horizon has passed and the real move is known. Trades are allowed
 * only where the playbook shows the move was reliable; that is the "study the market" part.
 */
export const EVENT_TYPES = [
  'war_escalation', // attack, invasion, strikes, major escalation
  'ceasefire', // ceasefire, peace deal, de-escalation
  'sanctions', // sanctions, embargoes, export bans
  'tariffs', // tariffs and trade-war moves
  'fed_cut', // rate cut / dovish surprise / QE
  'fed_hike', // rate hike / hawkish surprise / QT
  'inflation_hot', // inflation above expectations
  'inflation_cool', // inflation below expectations
  'banking_stress', // bank failures, credit events, bailouts
  'recession_fear', // bad jobs/GDP, growth scare, market crash
  'risk_on', // strong growth data, stimulus, relief rally triggers
  'oil_supply_cut', // OPEC+ cuts, outages, shipping disruption
  'oil_supply_up', // OPEC+ raises output, SPR release, demand drop
  'crypto_etf', // ETF approvals/inflows, big institutional adoption
  'crypto_hack', // exchange/protocol hack, collapse, bankruptcy
  'crypto_regulation', // crackdowns, lawsuits, bans
  'crypto_adoption', // nation/company adoption, favourable law
  'halving', // bitcoin halving and supply events
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const ASSETS = ['BTC', 'ETH', 'SOL', 'GOLD', 'SILVER', 'OIL', 'SPX', 'DXY'] as const;
export type Asset = (typeof ASSETS)[number];
/** Where each asset's price comes from. Crypto and PAXG (gold) from Binance spot; the rest from Yahoo (futures/index quotes). */
export const SYMBOLS: Record<Asset, { source: 'binance' | 'yahoo'; symbol: string }> = {
  BTC: { source: 'binance', symbol: 'BTCUSDT' },
  ETH: { source: 'binance', symbol: 'ETHUSDT' },
  SOL: { source: 'binance', symbol: 'SOLUSDT' },
  GOLD: { source: 'binance', symbol: 'PAXGUSDT' },
  SILVER: { source: 'yahoo', symbol: 'SI=F' },
  OIL: { source: 'yahoo', symbol: 'CL=F' },
  SPX: { source: 'yahoo', symbol: '^GSPC' },
  DXY: { source: 'yahoo', symbol: 'DX-Y.NYB' },
};
/** Assets the paper account holds out of the box (the owner can switch more on in Settings). */
export const DEFAULT_TRADABLE: Asset[] = ['BTC', 'ETH', 'SOL', 'GOLD'];
/** Kept for the price fetcher and tests: Binance symbols by asset. */
export const TRADABLE: Partial<Record<Asset, string>> = { BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT', GOLD: 'PAXGUSDT' };
const YAHOO: Partial<Record<Asset, string>> = { SILVER: 'SI=F', OIL: 'CL=F', SPX: '^GSPC', DXY: 'DX-Y.NYB' };

export interface HistEvent {
  date: string; // YYYY-MM-DD (UTC day the news broke)
  type: EventType;
  note: string;
  source: 'curated' | 'live';
}

/** Dated events the author is confident about. Later ones come from the bot's own log. */
export const CURATED: HistEvent[] = [
  { date: '2020-01-03', type: 'war_escalation', note: 'US strike kills Soleimani', source: 'curated' },
  { date: '2020-03-03', type: 'fed_cut', note: 'Fed emergency 50bp cut', source: 'curated' },
  { date: '2020-03-09', type: 'oil_supply_up', note: 'Saudi–Russia price war, oil −25%', source: 'curated' },
  { date: '2020-03-12', type: 'recession_fear', note: 'COVID crash day', source: 'curated' },
  { date: '2020-03-15', type: 'fed_cut', note: 'Fed cuts to zero, QE', source: 'curated' },
  { date: '2020-04-12', type: 'oil_supply_cut', note: 'OPEC+ record 9.7 mb/d cut', source: 'curated' },
  { date: '2020-05-11', type: 'halving', note: 'Bitcoin halving', source: 'curated' },
  { date: '2020-11-09', type: 'risk_on', note: 'Pfizer vaccine news', source: 'curated' },
  { date: '2021-02-08', type: 'crypto_adoption', note: 'Tesla buys $1.5B BTC', source: 'curated' },
  { date: '2021-04-14', type: 'crypto_adoption', note: 'Coinbase lists on Nasdaq', source: 'curated' },
  { date: '2021-05-19', type: 'crypto_regulation', note: 'China bans crypto payments; crash', source: 'curated' },
  { date: '2021-06-09', type: 'crypto_adoption', note: 'El Salvador adopts BTC', source: 'curated' },
  { date: '2021-09-24', type: 'crypto_regulation', note: 'PBOC declares all crypto illegal', source: 'curated' },
  { date: '2021-10-19', type: 'crypto_etf', note: 'First US BTC futures ETF (BITO)', source: 'curated' },
  { date: '2021-11-10', type: 'inflation_hot', note: 'US CPI 6.2%, 30-year high', source: 'curated' },
  { date: '2022-02-24', type: 'war_escalation', note: 'Russia invades Ukraine', source: 'curated' },
  { date: '2022-03-16', type: 'fed_hike', note: 'Fed first hike of cycle', source: 'curated' },
  { date: '2022-05-09', type: 'crypto_hack', note: 'Terra/UST collapse', source: 'curated' },
  { date: '2022-06-13', type: 'crypto_hack', note: 'Celsius halts withdrawals', source: 'curated' },
  { date: '2022-06-15', type: 'fed_hike', note: 'Fed hikes 75bp', source: 'curated' },
  { date: '2022-10-05', type: 'oil_supply_cut', note: 'OPEC+ cuts 2 mb/d', source: 'curated' },
  { date: '2022-11-08', type: 'crypto_hack', note: 'FTX collapse', source: 'curated' },
  { date: '2022-11-10', type: 'inflation_cool', note: 'CPI cooler than expected', source: 'curated' },
  { date: '2023-03-10', type: 'banking_stress', note: 'Silicon Valley Bank fails', source: 'curated' },
  { date: '2023-04-02', type: 'oil_supply_cut', note: 'OPEC+ surprise 1.16 mb/d cut', source: 'curated' },
  { date: '2023-06-05', type: 'crypto_regulation', note: 'SEC sues Binance and Coinbase', source: 'curated' },
  { date: '2023-06-15', type: 'crypto_etf', note: 'BlackRock files spot BTC ETF', source: 'curated' },
  { date: '2023-10-07', type: 'war_escalation', note: 'Hamas attack, Gaza war begins', source: 'curated' },
  { date: '2024-01-10', type: 'crypto_etf', note: 'SEC approves spot BTC ETFs', source: 'curated' },
  { date: '2024-04-13', type: 'war_escalation', note: 'Iran missile/drone attack on Israel', source: 'curated' },
  { date: '2024-04-19', type: 'halving', note: 'Bitcoin halving', source: 'curated' },
  { date: '2024-05-23', type: 'crypto_etf', note: 'SEC approves spot ETH ETFs', source: 'curated' },
  { date: '2024-08-05', type: 'recession_fear', note: 'Yen carry unwind crash', source: 'curated' },
  { date: '2024-09-18', type: 'fed_cut', note: 'Fed first cut, 50bp', source: 'curated' },
  { date: '2024-11-05', type: 'risk_on', note: 'US election result', source: 'curated' },
  { date: '2025-02-01', type: 'tariffs', note: 'Tariffs on Canada, Mexico, China', source: 'curated' },
  { date: '2025-02-21', type: 'crypto_hack', note: 'Bybit $1.5B hack', source: 'curated' },
  { date: '2025-04-02', type: 'tariffs', note: '"Liberation Day" tariffs', source: 'curated' },
  { date: '2025-04-09', type: 'risk_on', note: '90-day tariff pause', source: 'curated' },
  { date: '2025-06-13', type: 'war_escalation', note: 'Israel strikes Iran', source: 'curated' },
  { date: '2025-06-24', type: 'ceasefire', note: 'Israel–Iran ceasefire', source: 'curated' },
];

export const HORIZONS = [1, 3, 7, 14] as const;
export type Horizon = (typeof HORIZONS)[number];
export interface PlayEntry {
  type: EventType;
  asset: Asset;
  n: number;
  /** average move (%) at each horizon and how often it was up */
  avg: Record<Horizon, number>;
  upRate: Record<Horizon, number>;
  /** the horizon with the strongest average move, and its sign */
  best: Horizon;
  direction: 'up' | 'down' | 'mixed';
  reliability: number; // 0-1: how often the move went the "best" way
}
export interface Playbook {
  builtAt: number;
  events: number;
  entries: PlayEntry[];
}

const CACHE = () => path.join(config.dataDir, 'news-cache');
type Daily = Map<string, number>; // YYYY-MM-DD → close

async function binanceDaily(symbol: string): Promise<Daily> {
  const file = path.join(CACHE(), `${symbol}.json`);
  let rows: [number, number][] = [];
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8')) as { at: number; rows: [number, number][] };
    if (Date.now() - c.at < 20 * 3600_000) rows = c.rows;
  } catch {
    /* fetch */
  }
  if (!rows.length) {
    let start = Date.UTC(2019, 11, 1);
    for (let i = 0; i < 10; i++) {
      const res = await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1d&limit=1000&startTime=${start}`, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`binance ${symbol} ${res.status}`);
      const k = (await res.json()) as [number, string, string, string, string][];
      if (!k.length) break;
      rows.push(...k.map((r) => [r[0], Number(r[4])] as [number, number]));
      start = k[k.length - 1][0] + 86_400_000;
      if (k.length < 1000) break;
    }
    fs.mkdirSync(CACHE(), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ at: Date.now(), rows }));
  }
  return new Map(rows.map(([t, c]) => [new Date(t).toISOString().slice(0, 10), c]));
}

async function yahooDaily(symbol: string): Promise<Daily> {
  const file = path.join(CACHE(), `${symbol.replace(/[^\w]/g, '_')}.json`);
  let rows: [number, number][] = [];
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8')) as { at: number; rows: [number, number][] };
    if (Date.now() - c.at < 20 * 3600_000) rows = c.rows;
  } catch {
    /* fetch */
  }
  if (!rows.length) {
    const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=1575158400&period2=${Math.floor(Date.now() / 1000)}&interval=1d`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`yahoo ${symbol} ${res.status}`);
    const j = (await res.json()) as { chart: { result: { timestamp: number[]; indicators: { quote: { close: (number | null)[] }[] } }[] } };
    const r = j.chart.result[0];
    rows = r.timestamp.map((t, i) => [t * 1000, r.indicators.quote[0].close[i] ?? NaN] as [number, number]).filter((x) => Number.isFinite(x[1]));
    fs.mkdirSync(CACHE(), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ at: Date.now(), rows }));
  }
  return new Map(rows.map(([t, c]) => [new Date(t).toISOString().slice(0, 10), c]));
}

export async function dailyCloses(asset: Asset): Promise<Daily> {
  const b = TRADABLE[asset];
  if (b) return binanceDaily(b);
  return yahooDaily(YAHOO[asset]!);
}

/** Close on or just before a day (markets close on weekends; crypto does not). */
function closeAt(d: Daily, day: string, back = 5): number | null {
  const t = Date.parse(day + 'T00:00:00Z');
  for (let i = 0; i <= back; i++) {
    const k = new Date(t - i * 86_400_000).toISOString().slice(0, 10);
    const v = d.get(k);
    if (v !== undefined) return v;
  }
  return null;
}
function closeAfter(d: Daily, day: string, days: number): number | null {
  const t = Date.parse(day + 'T00:00:00Z') + days * 86_400_000;
  for (let i = 0; i <= 4; i++) {
    const k = new Date(t + i * 86_400_000).toISOString().slice(0, 10);
    const v = d.get(k);
    if (v !== undefined) return v;
  }
  return null;
}

/** Moves (%) of one asset after one event, per horizon; null where there is no price. */
export function reaction(d: Daily, day: string): Partial<Record<Horizon, number>> {
  const base = closeAt(d, new Date(Date.parse(day + 'T00:00:00Z') - 86_400_000).toISOString().slice(0, 10));
  const out: Partial<Record<Horizon, number>> = {};
  if (!base) return out;
  for (const h of HORIZONS) {
    const c = closeAfter(d, day, h);
    if (!c) continue;
    const pct = Math.round(((c - base) / base) * 1000) / 10;
    // A move beyond ±60% in two weeks is a data artefact (oil's negative-price day in 2020), not a lesson.
    if (Math.abs(pct) <= 60) out[h] = pct;
  }
  return out;
}

export function summarise(type: EventType, asset: Asset, moves: Partial<Record<Horizon, number>>[]): PlayEntry | null {
  const n = moves.length;
  if (!n) return null;
  const avg = {} as Record<Horizon, number>;
  const upRate = {} as Record<Horizon, number>;
  for (const h of HORIZONS) {
    const xs = moves.map((m) => m[h]).filter((x): x is number => x !== undefined);
    avg[h] = xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : 0;
    upRate[h] = xs.length ? Math.round((xs.filter((x) => x > 0).length / xs.length) * 100) / 100 : 0.5;
  }
  const best = HORIZONS.reduce((a, b) => (Math.abs(avg[b]) > Math.abs(avg[a]) ? b : a), HORIZONS[0]);
  const direction = avg[best] > 0.5 ? 'up' : avg[best] < -0.5 ? 'down' : 'mixed';
  const reliability = direction === 'up' ? upRate[best] : direction === 'down' ? 1 - upRate[best] : 0.5;
  return { type, asset, n, avg, upRate, best, direction, reliability: Math.round(reliability * 100) / 100 };
}

/** Events the bot saw live whose horizon has passed, kept in news_outcomes (see news.ts). */
function liveEvents(): HistEvent[] {
  try {
    const rows = getDb().prepare("SELECT day, type, note FROM news_outcomes WHERE day < date('now', '-15 days') ORDER BY day").all() as { day: string; type: EventType; note: string }[];
    return rows.map((r) => ({ date: r.day, type: r.type, note: r.note, source: 'live' as const }));
  } catch {
    return [];
  }
}

export async function buildPlaybook(): Promise<Playbook> {
  const events = [...CURATED, ...liveEvents()];
  const prices = new Map<Asset, Daily>();
  for (const a of ASSETS) {
    try {
      prices.set(a, await dailyCloses(a));
    } catch {
      /* that asset stays out of the playbook this time */
    }
  }
  const entries: PlayEntry[] = [];
  for (const type of EVENT_TYPES) {
    const evs = events.filter((e) => e.type === type);
    if (!evs.length) continue;
    for (const asset of ASSETS) {
      const d = prices.get(asset);
      if (!d) continue;
      const moves = evs.map((e) => reaction(d, e.date)).filter((m) => Object.keys(m).length);
      const s = summarise(type, asset, moves);
      if (s) entries.push(s);
    }
  }
  const pb = { builtAt: Date.now(), events: events.length, entries };
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(path.join(config.dataDir, 'news-playbook.json'), JSON.stringify(pb, null, 1));
  return pb;
}

export function loadPlaybook(): Playbook | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(config.dataDir, 'news-playbook.json'), 'utf8')) as Playbook;
  } catch {
    return null;
  }
}

export const playFor = (pb: Playbook | null, type: EventType, asset: Asset) => pb?.entries.find((e) => e.type === type && e.asset === asset) ?? null;
