/**
 * Price sources. Each store turns a product page (or a search) into a price quote. Plain HTTPS with a
 * browser user agent is enough for Amazon's regional sites; stores behind bot walls (Newegg, noon)
 * are left out rather than fought.
 */
export type Market = 'uae' | 'us';
export type StoreId = 'amazon_ae' | 'amazon_com' | 'microless';

export interface Quote {
  title: string;
  price: number | null; // null = no offer / out of stock
  currency: 'AED' | 'USD';
  inStock: boolean;
  url: string;
}
export interface Hit {
  extId: string;
  title: string;
  price: number | null;
  url: string;
}

export const STORES: Record<StoreId, { name: string; market: Market; currency: 'AED' | 'USD'; host: string }> = {
  amazon_ae: { name: 'Amazon.ae', market: 'uae', currency: 'AED', host: 'www.amazon.ae' },
  amazon_com: { name: 'Amazon.com', market: 'us', currency: 'USD', host: 'www.amazon.com' },
  microless: { name: 'Microless', market: 'uae', currency: 'AED', host: 'uae.microless.com' },
};

/** 1 USD = 3.6725 AED (the dirham is pegged). */
export const AED_PER_USD = 3.6725;
export const toUsd = (price: number, currency: 'AED' | 'USD') => (currency === 'AED' ? price / AED_PER_USD : price);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const decode = (s: string) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/\s+/g, ' ')
    .trim();
const num = (s: string) => Number(s.replace(/[^\d.]/g, '')) || null;

/** One request at a time per host, with a pause: polite and far below any rate limit. */
const lastHit = new Map<string, number>();
async function fetchHtml(url: string, extraHeaders: Record<string, string> = {}): Promise<string> {
  const host = new URL(url).host;
  const wait = (lastHit.get(host) ?? 0) + 2500 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastHit.set(host, Date.now());
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9', ...extraHeaders },
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${host}`);
  const html = await res.text();
  if (/captcha|automated access|robot check/i.test(html.slice(0, 20_000)) && !/productTitle|s-result-item/.test(html)) throw new Error(`${host} asked for a captcha`);
  return html;
}

const amazonHeaders = (store: StoreId) => (store === 'amazon_com' ? { Cookie: 'i18n-prefs=USD; lc-main=en_US' } : { Cookie: 'i18n-prefs=AED; lc-main=en_AE' });

/** ASIN from any Amazon URL shape. */
export function asinFrom(url: string): string | null {
  return /\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})(?:[/?]|$)/i.exec(url)?.[1]?.toUpperCase() ?? null;
}

export async function amazonProduct(store: 'amazon_ae' | 'amazon_com', asin: string): Promise<Quote> {
  const s = STORES[store];
  const url = `https://${s.host}/dp/${asin}`;
  const html = await fetchHtml(url, amazonHeaders(store));
  const title = decode(/id="productTitle"[^>]*>([^<]+)/.exec(html)?.[1] ?? '');
  if (!title) throw new Error('no product title (page layout changed or blocked)');
  // The buy box price comes first; "a-offscreen" spans elsewhere belong to other offers.
  const box = html.slice(html.indexOf('id="corePrice'), html.indexOf('id="corePrice') + 6000);
  const priceStr = /class="a-offscreen">([^<]+)/.exec(box)?.[1] ?? /"priceAmount":\s*([\d.]+)/.exec(html)?.[1] ?? null;
  const unavailable = /id="availability"[\s\S]{0,300}?(currently unavailable|out of stock)/i.test(html) || /id="outOfStock"/.test(html);
  const price = priceStr ? num(priceStr) : null;
  return { title, price: unavailable ? null : price, currency: s.currency, inStock: !unavailable && price !== null, url };
}

export async function amazonSearch(store: 'amazon_ae' | 'amazon_com', query: string, limit = 8): Promise<Hit[]> {
  const s = STORES[store];
  const html = await fetchHtml(`https://${s.host}/s?k=${encodeURIComponent(query)}`, amazonHeaders(store));
  const out: Hit[] = [];
  const seen = new Set<string>();
  // Each result is a div[data-asin]; sponsored ones carry "AdHolder".
  const re = /<div[^>]*data-asin="([A-Z0-9]{10})"[^>]*data-component-type="s-search-result"[^>]*>([\s\S]*?)(?=<div[^>]*data-asin="[A-Z0-9]{10}"[^>]*data-component-type="s-search-result"|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < limit) {
    const [, asin, block] = m;
    if (seen.has(asin) || /AdHolder|Sponsored/.test(block.slice(0, 3000))) continue;
    const title = decode(/<h2[^>]*>[\s\S]*?<span[^>]*>([^<]+)<\/span>/.exec(block)?.[1] ?? /aria-label="([^"]{10,})"/.exec(block)?.[1] ?? '');
    const priceStr = /class="a-offscreen">([^<]+)/.exec(block)?.[1];
    if (!title) continue;
    seen.add(asin);
    out.push({ extId: asin, title, price: priceStr ? num(priceStr) : null, url: `https://${s.host}/dp/${asin}` });
  }
  return out;
}

/** Microless: the search page answers an XHR request with the result fragment. */
export async function microlessSearch(query: string, limit = 8): Promise<Hit[]> {
  const html = await fetchHtml(`https://uae.microless.com/search/?q=${encodeURIComponent(query)}`, { 'X-Requested-With': 'XMLHttpRequest' });
  const out: Hit[] = [];
  const re = /href="(https:\/\/uae\.microless\.com\/product\/([^"/]+)\/?)"[^>]*>([\s\S]{0,3000}?)AED\s?([\d,]+(?:\.\d+)?)/g;
  let m: RegExpExecArray | null;
  const seen = new Set<string>();
  while ((m = re.exec(html)) && out.length < limit) {
    const [, url, slug, block, price] = m;
    if (seen.has(slug)) continue;
    const title = decode(/title="([^"]{8,})"/.exec(block)?.[1] ?? /alt="([^"]{8,})"/.exec(block)?.[1] ?? slug.replace(/-/g, ' '));
    seen.add(slug);
    out.push({ extId: slug, title, price: num(price), url });
  }
  return out;
}

export async function microlessProduct(slug: string): Promise<Quote> {
  const url = `https://uae.microless.com/product/${slug}/`;
  const html = await fetchHtml(url);
  const title = decode(/<h1[^>]*>([^<]+)/.exec(html)?.[1] ?? /property="og:title" content="([^"]+)"/.exec(html)?.[1] ?? '');
  if (!title) throw new Error('no product title');
  const priceStr = /property="product:price:amount" content="([\d.]+)"/.exec(html)?.[1] ?? /itemprop="price" content="([\d.]+)"/.exec(html)?.[1] ?? /AED\s?([\d,]+(?:\.\d+)?)/.exec(html)?.[1] ?? null;
  const out = /out of stock|sold out/i.test(html.slice(0, 60_000)) && !/in stock/i.test(html.slice(0, 60_000));
  const price = priceStr ? num(priceStr) : null;
  return { title, price: out ? null : price, currency: 'AED', inStock: !out && price !== null, url };
}

export function quote(store: StoreId, extId: string): Promise<Quote> {
  if (store === 'microless') return microlessProduct(extId);
  return amazonProduct(store, extId);
}

export function search(store: StoreId, query: string, limit?: number): Promise<Hit[]> {
  if (store === 'microless') return microlessSearch(query, limit);
  return amazonSearch(store, query, limit);
}

/** Store + external id from a pasted URL, or null when the shop is not supported. */
export function parseProductUrl(url: string): { store: StoreId; extId: string } | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./, '');
  if (host === 'amazon.ae' || host === 'amazon.com') {
    const asin = asinFrom(u.pathname);
    return asin ? { store: host === 'amazon.ae' ? 'amazon_ae' : 'amazon_com', extId: asin } : null;
  }
  if (host === 'uae.microless.com' || host === 'microless.com') {
    const slug = /\/product\/([^/]+)/.exec(u.pathname)?.[1];
    return slug ? { store: 'microless', extId: slug } : null;
  }
  return null;
}
