import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/sessions.js';
import { config } from '../config.js';
import { audit, getDb, kvGet, kvSet } from '../db.js';
import { CRYPTO_HP, STOCK_HP, dipSignal, loadBars, type DBar, type DipSignal } from './hunter.js';

/**
 * "The Hunter" as a watch list, not a bot: every few hours it scans strong assets (top Binance
 * pairs by volume + large US and Saudi stocks) for sharp recent drops with the long-term trend
 * intact, attaches the latest headlines that mention them, and lists them for the owner to judge.
 * Buying the dip mechanically lost money in the 2021–2025 simulations (see docs/quant.md), so this
 * never trades on its own; "Ask the AI team" runs a TradingAgents debate on the ticker.
 */
const execFileP = promisify(execFile);
const execFileAsync = execFileP;
const cryptoDir = () => path.join(config.dataDir, 'quant-cache', 'crypto-daily');
const stockDir = () => path.join(config.dataDir, 'quant-cache', 'stocks');
const BIN = process.env.MANAR_BINANCE_URL ?? 'https://api.binance.com';

export const STOCKS: { ticker: string; name: string; market: 'US' | 'SA' }[] = [
  ...[
    'AAPL',
    'MSFT',
    'NVDA',
    'AMZN',
    'GOOGL',
    'META',
    'TSLA',
    'BRK-B',
    'JPM',
    'V',
    'UNH',
    'XOM',
    'JNJ',
    'PG',
    'MA',
    'HD',
    'COST',
    'AVGO',
    'LLY',
    'MRK',
    'ABBV',
    'PEP',
    'KO',
    'BAC',
    'WMT',
    'CVX',
    'CSCO',
    'ORCL',
    'NFLX',
    'AMD',
    'INTC',
    'DIS',
    'NKE',
    'MCD',
    'CRM',
    'ADBE',
    'QCOM',
    'TXN',
    'BA',
    'CAT',
  ].map((t) => ({ ticker: t, name: t, market: 'US' as const })),
  { ticker: '2222.SR', name: 'Aramco', market: 'SA' },
  { ticker: '1120.SR', name: 'Al Rajhi Bank', market: 'SA' },
  { ticker: '2010.SR', name: 'SABIC', market: 'SA' },
  { ticker: '1180.SR', name: 'Saudi National Bank', market: 'SA' },
  { ticker: '7010.SR', name: 'STC', market: 'SA' },
  { ticker: '2082.SR', name: 'ACWA Power', market: 'SA' },
  { ticker: '1010.SR', name: 'Riyad Bank', market: 'SA' },
  { ticker: '4030.SR', name: 'Bahri', market: 'SA' },
  { ticker: '2350.SR', name: 'Saudi Kayan', market: 'SA' },
  { ticker: '1211.SR', name: "Ma'aden", market: 'SA' },
];
const NAME_WORDS: Record<string, string[]> = {
  '2222.SR': ['aramco', 'أرامكو'],
  '1120.SR': ['rajhi', 'الراجحي'],
  '2010.SR': ['sabic', 'سابك'],
  '1180.SR': ['snb', 'الأهلي'],
  '7010.SR': ['stc', 'الاتصالات السعودية'],
  '2082.SR': ['acwa', 'أكوا'],
  '1010.SR': ['riyad bank', 'بنك الرياض'],
  '4030.SR': ['bahri', 'البحري'],
  '2350.SR': ['kayan', 'كيان'],
  '1211.SR': ['maaden', "ma'aden", 'معادن'],
  NVDA: ['nvidia', 'إنفيديا'],
  AAPL: ['apple', 'آبل'],
  TSLA: ['tesla', 'تسلا'],
  MSFT: ['microsoft'],
  AMZN: ['amazon'],
  GOOGL: ['google', 'alphabet'],
  META: ['meta', 'facebook'],
  BA: ['boeing'],
  INTC: ['intel'],
  AMD: ['amd'],
  NFLX: ['netflix'],
  DIS: ['disney'],
  XOM: ['exxon'],
  CVX: ['chevron'],
};

export interface Opportunity extends DipSignal {
  kind: 'crypto' | 'stock';
  name: string;
  market: string;
  trendIntact: boolean;
  /** 1-year return, a rough "quality" hint. */
  yearPct: number | null;
  headlines: { title: string; link: string; at: number }[];
  /** Latest TradingAgents rating for the ticker today, if any. */
  ai: { rating: string; score: number | null; id: string } | null;
}

async function refreshCrypto(): Promise<string[]> {
  fs.mkdirSync(cryptoDir(), { recursive: true });
  const r = await fetch(`${BIN}/api/v3/ticker/24hr`, { signal: AbortSignal.timeout(15_000) });
  const all = (await r.json()) as { symbol: string; quoteVolume: string }[];
  const bad = /UP|DOWN|BULL|BEAR|USDC|FDUSD|TUSD|BUSD|DAI|EUR|TRY|BRL|USD1|USDE|USDP|RLUSD|PAXG/;
  const top = all
    .filter((x) => x.symbol.endsWith('USDT') && !bad.test(x.symbol.slice(0, -4)) && Number(x.quoteVolume) > 1e7)
    .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume))
    .slice(0, 60)
    .map((x) => x.symbol);
  for (const s of top) {
    const f = path.join(cryptoDir(), `${s}.json`);
    let bars: DBar[] = [];
    try {
      bars = JSON.parse(fs.readFileSync(f, 'utf8')) as DBar[];
    } catch {
      bars = [];
    }
    let since = bars.length ? bars[bars.length - 1].t + 86400_000 : Date.parse('2020-01-01');
    for (;;) {
      if (since > Date.now() - 86400_000) break;
      const rr = await fetch(`${BIN}/api/v3/klines?symbol=${s}&interval=1d&startTime=${since}&limit=1000`, { signal: AbortSignal.timeout(15_000) });
      if (!rr.ok) break;
      const rows = (await rr.json()) as (string | number)[][];
      if (!rows.length) break;
      for (const k of rows) if (Number(k[6]) < Date.now()) bars.push({ t: Number(k[0]), o: Number(k[1]), h: Number(k[2]), l: Number(k[3]), c: Number(k[4]), v: Number(k[5]) });
      since = Number(rows[rows.length - 1][0]) + 86400_000;
      if (rows.length < 1000) break;
      await new Promise((x) => setTimeout(x, 120));
    }
    fs.writeFileSync(f, JSON.stringify(bars));
  }
  return top;
}

async function refreshStocks(): Promise<void> {
  const py = path.join(config.agentsDir, 'venv', 'bin', 'python');
  const script = path.join(config.agentsDir, 'export_stocks.py');
  if (!fs.existsSync(py) || !fs.existsSync(script)) return;
  await execFileAsync(py, ['-I', script, stockDir(), '2', ...STOCKS.map((s) => s.ticker)], { timeout: 10 * 60_000, maxBuffer: 4 * 1024 * 1024 });
}

function headlinesFor(words: string[], limit = 4) {
  if (!words.length) return [];
  const db = getDb();
  const rows = db.prepare('SELECT title, link, published_at FROM news_items WHERE seen_at > ? ORDER BY published_at DESC LIMIT 1500').all(Date.now() - 7 * 86400_000) as {
    title: string;
    link: string;
    published_at: number;
  }[];
  const ws = words.map((w) => w.toLowerCase());
  return rows
    .filter((r) => {
      const t = r.title.toLowerCase();
      return ws.some((w) => t.includes(w));
    })
    .slice(0, limit)
    .map((r) => ({ title: r.title, link: r.link, at: r.published_at }));
}

function aiFor(ticker: string) {
  const r = getDb().prepare("SELECT id, rating, score FROM quant_agent_runs WHERE ticker = ? AND status = 'done' ORDER BY created_at DESC LIMIT 1").get(ticker) as
    { id: string; rating: string; score: number | null } | undefined;
  return r ? { rating: r.rating, score: r.score, id: r.id } : null;
}

let scanning = false;
let lastScan: { at: number; items: Opportunity[]; universe: { crypto: number; stocks: number } } | null = null;

export async function scanOpportunities(refresh = true): Promise<NonNullable<typeof lastScan>> {
  if (scanning && lastScan) return lastScan;
  scanning = true;
  try {
    let cryptoSyms: string[] = [];
    if (refresh) {
      cryptoSyms = await refreshCrypto().catch(() => []);
      await refreshStocks().catch(() => undefined);
    }
    if (!cryptoSyms.length)
      cryptoSyms = fs.existsSync(cryptoDir())
        ? fs
            .readdirSync(cryptoDir())
            .filter((f) => f.endsWith('.json'))
            .map((f) => f.replace('.json', ''))
        : [];
    const items: Opportunity[] = [];
    const year = (bars: DBar[]) => (bars.length > 260 ? (bars[bars.length - 1].c / bars[bars.length - 261].c - 1) * 100 : null);
    for (const s of cryptoSyms) {
      const bars = loadBars(cryptoDir(), s);
      const sig = dipSignal(s, bars, { ...CRYPTO_HP, qualityPct: 85 });
      if (!sig) continue;
      const base = s.replace('USDT', '');
      items.push({
        ...sig,
        kind: 'crypto',
        name: base,
        market: 'Binance',
        trendIntact: sig.close > sig.sma200,
        yearPct: year(bars),
        headlines: headlinesFor([base.toLowerCase(), ...(base === 'BTC' ? ['bitcoin', 'بيتكوين'] : base === 'ETH' ? ['ethereum', 'إيثريوم'] : base === 'SOL' ? ['solana', 'سولانا'] : [])]),
        ai: aiFor(`${base}-USD`),
      });
    }
    for (const st of STOCKS) {
      const bars = loadBars(stockDir(), st.ticker);
      const sig = dipSignal(st.ticker, bars, { ...STOCK_HP, qualityPct: 90 });
      if (!sig) continue;
      items.push({
        ...sig,
        kind: 'stock',
        name: st.name,
        market: st.market,
        trendIntact: sig.close > sig.sma200,
        yearPct: year(bars),
        headlines: headlinesFor([st.name.toLowerCase(), ...(NAME_WORDS[st.ticker] ?? [])]),
        ai: aiFor(st.ticker),
      });
    }
    items.sort((a, b) => b.dropPct - a.dropPct);
    lastScan = { at: Date.now(), items, universe: { crypto: cryptoSyms.length, stocks: STOCKS.length } };
    kvSet('quant.scan', JSON.stringify({ at: lastScan.at, n: items.length }));
    return lastScan;
  } finally {
    scanning = false;
  }
}

export function scannerStatus() {
  const k = kvGet('quant.scan');
  return { scanning, last: lastScan ? { at: lastScan.at, n: lastScan.items.length, universe: lastScan.universe } : k ? (JSON.parse(k) as { at: number; n: number }) : null };
}

export function startScanner(): () => void {
  if (process.env.VITEST) return () => {};
  const t1 = setTimeout(() => void scanOpportunities(true).catch(() => undefined), 90_000);
  const t2 = setInterval(() => void scanOpportunities(true).catch(() => undefined), 4 * 3600_000);
  return () => {
    clearTimeout(t1);
    clearInterval(t2);
  };
}

export async function scannerRoutes(app: FastifyInstance) {
  app.get('/api/quant/opportunities', { preHandler: requireAuth }, async () => {
    const s = lastScan ?? (await scanOpportunities(false));
    return { ...s, status: scannerStatus(), stocks: STOCKS };
  });
  app.post('/api/quant/opportunities/scan', { preHandler: requireAuth }, async (req) => {
    const s = await scanOpportunities(true);
    audit(req.session!.userId, 'quant_scan', { n: s.items.length });
    return { at: s.at, n: s.items.length };
  });
}
