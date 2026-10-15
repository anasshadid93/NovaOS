import crypto from 'node:crypto';

/**
 * Headlines for the News Trader: world, markets and crypto feeds in English and Arabic. Parsed with
 * a small RSS reader (title, link, time); no body text is kept, the model only needs headlines.
 */
export interface Feed {
  id: string;
  name: string;
  url: string;
  lang: 'en' | 'ar';
  kind: 'world' | 'markets' | 'crypto' | 'central_bank';
}
export interface Headline {
  hash: string;
  feed: string;
  lang: 'en' | 'ar';
  title: string;
  link: string;
  publishedAt: number;
}

export const FEEDS: Feed[] = [
  { id: 'bbc_world', name: 'BBC World', url: 'http://feeds.bbci.co.uk/news/world/rss.xml', lang: 'en', kind: 'world' },
  { id: 'aljazeera_en', name: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml', lang: 'en', kind: 'world' },
  { id: 'aljazeera_ar', name: 'الجزيرة', url: 'https://www.aljazeera.net/aljazeerarss/a7c186be-1baa-4bd4-9d80-a84db769f779/73d0e1b4-532f-45ef-b135-bfdff8b8cab9', lang: 'ar', kind: 'world' },
  { id: 'cnbc_top', name: 'CNBC', url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html', lang: 'en', kind: 'markets' },
  { id: 'cnbc_markets', name: 'CNBC Markets', url: 'https://www.cnbc.com/id/10000664/device/rss/rss.html', lang: 'en', kind: 'markets' },
  { id: 'marketwatch', name: 'MarketWatch', url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories', lang: 'en', kind: 'markets' },
  { id: 'investing', name: 'Investing.com', url: 'https://www.investing.com/rss/news.rss', lang: 'en', kind: 'markets' },
  { id: 'fed', name: 'Federal Reserve', url: 'https://www.federalreserve.gov/feeds/press_all.xml', lang: 'en', kind: 'central_bank' },
  { id: 'coindesk', name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', lang: 'en', kind: 'crypto' },
  { id: 'theblock', name: 'The Block', url: 'https://www.theblock.co/rss.xml', lang: 'en', kind: 'crypto' },
  { id: 'cointelegraph', name: 'Cointelegraph', url: 'https://cointelegraph.com/rss', lang: 'en', kind: 'crypto' },
  { id: 'gnews_commod', name: 'Google News · oil, gold, war', url: 'https://news.google.com/rss/search?q=oil+OR+gold+OR+bitcoin+OR+war+OR+tariffs+OR+sanctions&hl=en-US&gl=US&ceid=US:en', lang: 'en', kind: 'markets' },
  { id: 'gnews_ar', name: 'Google News · أسواق', url: 'https://news.google.com/rss/search?q=%D8%A7%D9%84%D9%86%D9%81%D8%B7+OR+%D8%A7%D9%84%D8%B0%D9%87%D8%A8+OR+%D8%A8%D9%8A%D8%AA%D9%83%D9%88%D9%8A%D9%86+OR+%D8%AD%D8%B1%D8%A8&hl=ar&gl=AE&ceid=AE:ar', lang: 'ar', kind: 'markets' },
];

const UA = 'Mozilla/5.0 (compatible; NovaOS news reader)';
const decode = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/\s+/g, ' ')
    .trim();

const tag = (block: string, name: string) => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i').exec(block);
  return m ? decode(m[1]) : '';
};

/** Titles are normalised before hashing so the same story from two feeds counts once. */
export const headlineHash = (title: string) =>
  crypto
    .createHash('sha1')
    .update(title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim())
    .digest('hex')
    .slice(0, 16);

export function parseRss(xml: string, feed: Feed): Headline[] {
  const out: Headline[] = [];
  const items = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) ?? [];
  for (const it of items) {
    const title = tag(it, 'title');
    if (!title || title.length < 12) continue;
    let link = tag(it, 'link');
    if (!link) link = /<link[^>]*href="([^"]+)"/i.exec(it)?.[1] ?? '';
    const when = tag(it, 'pubDate') || tag(it, 'published') || tag(it, 'updated') || tag(it, 'dc:date');
    const publishedAt = when ? Date.parse(when) || Date.now() : Date.now();
    out.push({ hash: headlineHash(title), feed: feed.id, lang: feed.lang, title: title.slice(0, 300), link: link.slice(0, 500), publishedAt });
  }
  return out;
}

export async function fetchFeed(feed: Feed): Promise<Headline[]> {
  const res = await fetch(feed.url, { headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml, */*' }, redirect: 'follow', signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseRss(await res.text(), feed);
}
