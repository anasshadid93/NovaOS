import { config } from '../config.js';
/**
 * Small public data the assistant uses every day: prayer times (Dubai, Dubai method) and market
 * prices (gold via PAX Gold, which tracks one troy ounce; BTC/ETH; currency rates). Cached.
 */
const UA = { 'User-Agent': 'the server-assistant/1.0 (MinisManager)' };
const OZ_GRAMS = 31.1034768;

let prayerCache: { day: string; data: unknown } | null = null;
export async function prayerTimes(now = new Date()) {
  const day = now.toLocaleDateString('en-CA', { timeZone: config.timezone });
  if (prayerCache?.day === day) return prayerCache.data;
  const [y, m, d] = day.split('-');
  const r = await fetch(`https://api.aladhan.com/v1/timingsByCity/${d}-${m}-${y}?city=Dubai&country=AE&method=16`, { headers: UA, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`prayer_${r.status}`);
  const j = (await r.json()) as { data: { timings: Record<string, string>; date: { hijri: { day: string; month: { ar: string }; year: string } } } };
  const t = j.data.timings;
  const data = {
    city: 'Dubai',
    date: day,
    hijri: `${j.data.date.hijri.day} ${j.data.date.hijri.month.ar} ${j.data.date.hijri.year}`,
    times: { fajr: t.Fajr, sunrise: t.Sunrise, dhuhr: t.Dhuhr, asr: t.Asr, maghrib: t.Maghrib, isha: t.Isha },
  };
  prayerCache = { day, data };
  return data;
}

export interface Prices {
  at: string;
  gold: { usdPerOunce: number; aedPerOunce: number; aedPerGram24k: number; aedPerGram21k: number; aedPerGram18k: number };
  crypto: { btcUsd: number; ethUsd: number };
  fx: { usdAed: number; usdJod: number; usdEur: number; jodAed: number };
}
let priceCache: { at: number; data: Prices } | null = null;
export async function marketPrices(): Promise<Prices> {
  if (priceCache && Date.now() - priceCache.at < 5 * 60_000) return priceCache.data;
  const [cg, fx] = await Promise.all([
    fetch('https://api.coingecko.com/api/v3/simple/price?ids=pax-gold,bitcoin,ethereum&vs_currencies=usd,aed', { headers: UA, signal: AbortSignal.timeout(15_000) }).then((r) => r.json() as Promise<Record<string, { usd: number; aed: number }>>),
    fetch('https://open.er-api.com/v6/latest/USD', { headers: UA, signal: AbortSignal.timeout(15_000) }).then((r) => r.json() as Promise<{ rates: Record<string, number> }>),
  ]);
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const gram = cg['pax-gold'].aed / OZ_GRAMS;
  const data: Prices = {
    at: new Date().toISOString(),
    gold: { usdPerOunce: r2(cg['pax-gold'].usd), aedPerOunce: r2(cg['pax-gold'].aed), aedPerGram24k: r2(gram), aedPerGram21k: r2((gram * 21) / 24), aedPerGram18k: r2((gram * 18) / 24) },
    crypto: { btcUsd: cg.bitcoin.usd, ethUsd: cg.ethereum.usd },
    fx: { usdAed: fx.rates.AED, usdJod: fx.rates.JOD, usdEur: fx.rates.EUR, jodAed: r2(fx.rates.AED / fx.rates.JOD) },
  };
  priceCache = { at: Date.now(), data };
  return data;
}

// ---- News headlines from RSS (titles + links only; the model reads articles with read_webpage) ----
const FEEDS: { source: string; lang: 'ar' | 'en'; url: string }[] = [
  { source: 'BBC عربي', lang: 'ar', url: 'https://feeds.bbci.co.uk/arabic/rss.xml' },
  { source: 'سكاي نيوز عربية', lang: 'ar', url: 'https://www.skynewsarabia.com/rss.xml' },
  { source: 'الجزيرة نت', lang: 'ar', url: 'https://www.aljazeera.net/rss' },
  { source: 'RT عربي', lang: 'ar', url: 'https://arabic.rt.com/rss/' },
  { source: 'الإمارات اليوم', lang: 'ar', url: 'https://www.emaratalyoum.com/1.533091?ot=ot.AjaxPageLayout' },
  { source: 'BBC World', lang: 'en', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
  { source: 'Al Jazeera English', lang: 'en', url: 'https://www.aljazeera.com/xml/rss/all.xml' },
];

export interface Headline {
  title: string;
  source: string;
  link: string;
  time: string | null;
}

const decode = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

export function parseRss(xml: string, source: string): Headline[] {
  const out: Headline[] = [];
  for (const m of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/g)) {
    const tag = (n: string) => decode(new RegExp(`<${n}\\b[^>]*>([\\s\\S]*?)<\\/${n}>`).exec(m[1])?.[1] ?? '');
    const title = tag('title');
    const link = tag('link') || (/<guid[^>]*>(https?:[^<]+)<\/guid>/.exec(m[1])?.[1] ?? '');
    const date = tag('pubDate') || tag('dc:date');
    const t = date ? new Date(date) : null;
    if (title) out.push({ title, source, link, time: t && !Number.isNaN(t.getTime()) ? t.toISOString() : null });
  }
  return out;
}

let newsCache: { at: number; items: Headline[]; lang: Record<string, 'ar' | 'en'> } | null = null;
export async function news(lang: 'ar' | 'en' | 'all' = 'ar', limit = 15): Promise<{ headlines: Headline[] }> {
  if (!newsCache || Date.now() - newsCache.at > 15 * 60_000) {
    const res = await Promise.allSettled(
      FEEDS.map(async (f) => {
        const r = await fetch(f.url, { headers: { ...UA, Accept: 'application/rss+xml, application/xml, text/xml' }, signal: AbortSignal.timeout(12_000) });
        return parseRss(await r.text(), f.source);
      }),
    );
    const items = res.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
    newsCache = { at: Date.now(), items, lang: Object.fromEntries(FEEDS.map((f) => [f.source, f.lang])) };
  }
  const { items, lang: langOf } = newsCache;
  const seen = new Set<string>();
  const dayAgo = Date.now() - 36 * 3600_000;
  // Newest first, but mix the sources: at most 4 per source.
  const perSource = new Map<string, number>();
  const headlines = items
    .filter((h) => (lang === 'all' || langOf[h.source] === lang) && (!h.time || Date.parse(h.time) > dayAgo))
    .sort((a, b) => (b.time ? Date.parse(b.time) : 0) - (a.time ? Date.parse(a.time) : 0))
    .filter((h) => {
      const k = h.title.slice(0, 40);
      if (seen.has(k) || (perSource.get(h.source) ?? 0) >= 4) return false;
      seen.add(k);
      perSource.set(h.source, (perSource.get(h.source) ?? 0) + 1);
      return true;
    })
    .slice(0, Math.min(limit, 40));
  return { headlines };
}
