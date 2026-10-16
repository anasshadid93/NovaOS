import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

/**
 * Market data for the Quant Desk. Every price carries its source and timestamp, and the engine
 * only trades on a price that is fresh *and* agrees with a second exchange: an AI never supplies a
 * price, and a stale or disputed quote blocks the trade instead of guessing.
 *
 * Primary: Binance spot. Second source: Kraken. Daily candles (for the technical score and ATR)
 * come from Binance and are cached on disk for an hour.
 */
export interface Quote {
  asset: string;
  price: number;
  at: number;
  source: 'binance' | 'kraken';
  /** Second-source price and the gap between the two, when available. */
  check?: { price: number; source: string; gapPct: number };
}
export interface Bar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

/** Binance spot symbol and Kraken pair per asset. GOLD trades as PAXG (one token = one troy ounce). */
export const MARKETS: Record<string, { binance: string; kraken: string; leanTicker: string; yahoo: string }> = {
  BTC: { binance: 'BTCUSDT', kraken: 'XBTUSDT', leanTicker: 'BTCUSDT', yahoo: 'BTC-USD' },
  ETH: { binance: 'ETHUSDT', kraken: 'ETHUSDT', leanTicker: 'ETHUSDT', yahoo: 'ETH-USD' },
  SOL: { binance: 'SOLUSDT', kraken: 'SOLUSDT', leanTicker: 'SOLUSDT', yahoo: 'SOL-USD' },
  GOLD: { binance: 'PAXGUSDT', kraken: 'PAXGUSD', leanTicker: 'PAXGUSDT', yahoo: 'GC=F' },
  XRP: { binance: 'XRPUSDT', kraken: 'XRPUSDT', leanTicker: 'XRPUSDT', yahoo: 'XRP-USD' },
  BNB: { binance: 'BNBUSDT', kraken: 'BNBUSD', leanTicker: 'BNBUSDT', yahoo: 'BNB-USD' },
  LINK: { binance: 'LINKUSDT', kraken: 'LINKUSDT', leanTicker: 'LINKUSDT', yahoo: 'LINK-USD' },
  AVAX: { binance: 'AVAXUSDT', kraken: 'AVAXUSDT', leanTicker: 'AVAXUSDT', yahoo: 'AVAX-USD' },
};
export const knownAsset = (a: string) => a in MARKETS;

const BINANCE = process.env.MANAR_BINANCE_URL ?? 'https://api.binance.com';
const KRAKEN = process.env.MANAR_KRAKEN_URL ?? 'https://api.kraken.com';

async function getJson<T>(url: string, timeoutMs = 10_000): Promise<T> {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'NovaOS-Quant/1.0' } });
  if (!r.ok) throw new Error(`${url.split('?')[0]} ${r.status}`);
  return (await r.json()) as T;
}

/** Live quotes for the given assets from Binance, cross-checked against Kraken. Missing assets are simply absent. */
export async function quotes(assets: string[]): Promise<Record<string, Quote>> {
  const syms = assets.filter(knownAsset);
  const out: Record<string, Quote> = {};
  if (!syms.length) return out;
  const at = Date.now();
  try {
    const list = await getJson<{ symbol: string; price: string }[]>(`${BINANCE}/api/v3/ticker/price?symbols=${encodeURIComponent(JSON.stringify(syms.map((a) => MARKETS[a].binance)))}`);
    for (const a of syms) {
      const row = list.find((x) => x.symbol === MARKETS[a].binance);
      const p = Number(row?.price);
      if (Number.isFinite(p) && p > 0) out[a] = { asset: a, price: p, at, source: 'binance' };
    }
  } catch {
    /* Binance down: fall through to Kraken as primary below */
  }
  try {
    const pairs = syms.map((a) => MARKETS[a].kraken).join(',');
    const r = await getJson<{ error: string[]; result: Record<string, { c: [string, string] }> }>(`${KRAKEN}/0/public/Ticker?pair=${pairs}`);
    for (const a of syms) {
      const want = MARKETS[a].kraken;
      // Kraken answers with its own pair names (e.g. XBTUSDT → XBTUSDT, PAXGUSD → PAXGUSD); match loosely.
      const key = Object.keys(r.result ?? {}).find((k) => k === want || k.replace(/^X|^Z/, '') === want || k.endsWith(want));
      const p = Number(key ? r.result[key].c[0] : NaN);
      if (!Number.isFinite(p) || p <= 0) continue;
      const q = out[a];
      if (q) q.check = { price: p, source: 'kraken', gapPct: (Math.abs(p - q.price) / q.price) * 100 };
      else out[a] = { asset: a, price: p, at, source: 'kraken' };
    }
  } catch {
    /* no cross-check this round; the engine treats that as "unverified" */
  }
  return out;
}

/** Trade-safety check for a quote: fresh, cross-checked and within the allowed gap. */
export function tradeable(q: Quote | undefined, now: number, maxAgeSec: number, maxGapPct: number): { ok: boolean; why?: string } {
  if (!q) return { ok: false, why: 'no_price' };
  if (now - q.at > maxAgeSec * 1000) return { ok: false, why: 'stale_price' };
  if (!q.check) return { ok: false, why: 'unverified_price' };
  if (q.check.gapPct > maxGapPct) return { ok: false, why: 'sources_disagree' };
  return { ok: true };
}

const cacheDir = () => path.join(config.dataDir, 'quant-cache');

/** Daily candles (UTC) for an asset, newest last. Cached for an hour; up to 1000 days. */
export async function dailyBars(asset: string, days = 400): Promise<Bar[]> {
  const m = MARKETS[asset];
  if (!m) return [];
  fs.mkdirSync(cacheDir(), { recursive: true });
  const f = path.join(cacheDir(), `${asset}-1d.json`);
  try {
    const st = fs.statSync(f);
    if (Date.now() - st.mtimeMs < 3600_000) {
      const bars = JSON.parse(fs.readFileSync(f, 'utf8')) as Bar[];
      if (bars.length >= Math.min(days, 300)) return bars.slice(-days);
    }
  } catch {
    /* fetch below */
  }
  const raw = await getJson<(string | number)[][]>(`${BINANCE}/api/v3/klines?symbol=${m.binance}&interval=1d&limit=${Math.min(1000, Math.max(days, 300))}`, 15_000);
  const bars: Bar[] = raw.map((k) => ({ t: Number(k[0]), o: Number(k[1]), h: Number(k[2]), l: Number(k[3]), c: Number(k[4]), v: Number(k[5]) }));
  fs.writeFileSync(f, JSON.stringify(bars));
  return bars.slice(-days);
}

export function ema(values: number[], n: number): number[] {
  const k = 2 / (n + 1);
  const out: number[] = [];
  let e = values[0] ?? 0;
  values.forEach((v, i) => {
    e = i === 0 ? v : v * k + e * (1 - k);
    out.push(e);
  });
  return out;
}

export function atr(bars: Bar[], n = 14): number {
  if (bars.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i];
    const pc = bars[i - 1].c;
    trs.push(Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc)));
  }
  const last = trs.slice(-n);
  return last.reduce((a, b) => a + b, 0) / last.length;
}

export function rsi(closes: number[], n = 14): number {
  if (closes.length <= n) return 50;
  let g = 0;
  let l = 0;
  for (let i = closes.length - n; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) g += d;
    else l -= d;
  }
  if (l === 0) return 100;
  const rs = g / l;
  return 100 - 100 / (1 + rs);
}

export interface Technical {
  score: number;
  atrPct: number;
  detail: { trend: number; breakout: number; momentum: number; rsi: number; ema20: number; ema50: number; ema200: number; sma200: number; bull: boolean; donchianHigh: number; donchianLow: number };
}

/**
 * Deterministic technical score in [-1, 1] from daily bars: trend (price vs EMA50/EMA200),
 * Donchian position (where the close sits in the 55-day channel) and 20-day momentum, with RSI
 * extremes damping chases. This is the "rules decide" leg that never needs an LLM.
 */
export function technical(bars: Bar[]): Technical | null {
  if (bars.length < 60) return null;
  const closes = bars.map((b) => b.c);
  const c = closes[closes.length - 1];
  const e20 = ema(closes, 20).at(-1)!;
  const e50 = ema(closes, 50).at(-1)!;
  const s200 = closes.slice(-200).reduce((a, b) => a + b, 0) / Math.min(200, closes.length);
  const e200 = ema(closes, Math.min(200, closes.length - 1)).at(-1)!;
  const win = bars.slice(-55);
  const hi = Math.max(...win.map((b) => b.h));
  const lo = Math.min(...win.map((b) => b.l));
  const trend = (c > e50 ? 0.5 : -0.5) + (c > e200 ? 0.5 : -0.5);
  const breakout = hi === lo ? 0 : ((c - lo) / (hi - lo)) * 2 - 1;
  const mom = closes.length > 21 ? Math.max(-1, Math.min(1, (c / closes[closes.length - 21] - 1) / 0.15)) : 0;
  const r = rsi(closes);
  let score = 0.4 * trend + 0.35 * breakout + 0.25 * mom;
  if (r > 78) score -= 0.25;
  if (r < 25) score += 0.15;
  score = Math.max(-1, Math.min(1, score));
  const a = atr(bars);
  return {
    score: Math.round(score * 1000) / 1000,
    atrPct: (a / c) * 100,
    detail: {
      trend,
      breakout: Math.round(breakout * 100) / 100,
      momentum: Math.round(mom * 100) / 100,
      rsi: Math.round(r),
      ema20: e20,
      ema50: e50,
      ema200: e200,
      sma200: s200,
      bull: c > s200 && e20 > e50,
      donchianHigh: hi,
      donchianLow: lo,
    },
  };
}
