import type { FastifyInstance } from 'fastify';
import { requireAuth, requireElevated } from '../auth/sessions.js';
import { audit, getDb, kvGet, kvSet } from '../db.js';
import { notify } from '../notify/notify.js';
import { postHook } from '../bot/hook.js';
import { enqueue, registerTask } from '../tasks/tasks.js';
import { parseProductUrl, quote, search, STORES, toUsd, type Market, type StoreId } from './stores.js';

/**
 * Prices: a tracker for PC parts (RAM, SSD/HDD, graphics cards) in the UAE and the US.
 * A seed list of searches fills each category with real listings; the owner can add any Amazon
 * product URL. Every 12 hours each tracked listing is quoted and a point is stored, so the page can
 * show where the market moved over 1 / 3 / 7 / 30 days, per category and per product.
 */
export type Category = 'gpu' | 'ram' | 'ssd' | 'hdd';
export const CATEGORIES: Category[] = ['gpu', 'ram', 'ssd', 'hdd'];
const WINDOWS = { d1: 1, d3: 3, d7: 7, d30: 30 } as const;
type WindowKey = keyof typeof WINDOWS;
const DAY = 86_400_000;

/** What gets tracked out of the box. Each query is searched once per store; the top listings are kept. */
const SEEDS: Record<Category, string[]> = {
  gpu: ['RTX 5060', 'RTX 5060 Ti 16GB', 'RTX 5070', 'RTX 5070 Ti', 'RTX 5080', 'RTX 5090', 'RX 9060 XT 16GB', 'RX 9070 XT', 'Intel Arc B580'],
  ram: ['DDR5 32GB 6000 kit', 'DDR5 64GB 6000 kit', 'DDR5 16GB 5600', 'DDR4 16GB 3200 kit', 'DDR4 32GB 3200 kit', 'DDR5 SODIMM 32GB 5600 laptop'],
  ssd: ['NVMe SSD 1TB Gen4', 'NVMe SSD 2TB Gen4', 'NVMe SSD 4TB', 'NVMe SSD 2TB Gen5', 'SATA SSD 1TB 2.5', 'Samsung 990 Pro 2TB', 'WD Black SN850X 2TB'],
  hdd: ['HDD 4TB 3.5 internal', 'HDD 8TB internal', 'HDD 12TB internal', 'HDD 16TB internal', 'Seagate IronWolf 8TB', 'WD Red Plus 8TB', 'external hard drive 8TB'],
};
const PER_QUERY = 3;
const STORE_ORDER: StoreId[] = ['amazon_ae', 'amazon_com'];
const REFRESH_EVERY = 12 * 3600_000;

interface ProductRow {
  id: number;
  store: StoreId;
  ext_id: string;
  title: string;
  category: Category;
  url: string;
  source: string;
  enabled: number;
  created_at: number;
}
interface PointRow {
  at: number;
  price: number | null;
  currency: 'AED' | 'USD';
  in_stock: number;
}

const isCategory = (c: unknown): c is Category => typeof c === 'string' && (CATEGORIES as string[]).includes(c);

/** A listing's title decides its category when it came from a pasted URL. */
export function guessCategory(title: string): Category {
  const t = title.toLowerCase();
  if (/\b(rtx|gtx|geforce|radeon|rx ?\d{4}|arc (a|b)\d{3}|graphics card|gpu)\b/.test(t)) return 'gpu';
  if (/\b(ddr[345]|sodimm|dimm|memory kit|ram)\b/.test(t)) return 'ram';
  if (/\b(nvme|ssd|m\.2|solid state)\b/.test(t)) return 'ssd';
  if (/\b(hdd|hard drive|hard disk|ironwolf|barracuda|wd red|wd blue|wd purple|exos|skyhawk)\b/.test(t)) return 'hdd';
  return 'ssd';
}

/** Accessories and bundles that search results drag in: never tracked. */
const JUNK = /\b(cable|adapter|bracket|cooler|fan|case|mount|sticker|enclosure|docking|dock|riser|thermal pad|heatsink|screwdriver|usb hub|laptop|desktop pc|gaming pc|prebuilt|motherboard|combo|bundle)\b/i;
const MATCHES: Record<Category, RegExp> = {
  gpu: /\b(rtx|gtx|geforce|radeon|rx ?\d{4}|arc)\b/i,
  ram: /\b(ddr[345]|sodimm|memory)\b/i,
  ssd: /\b(ssd|nvme|m\.2)\b/i,
  hdd: /\b(hdd|hard (disk|drive)|ironwolf|barracuda|exos|wd red|wd blue|wd purple|skyhawk|\d+ ?tb)\b/i,
};

function addProduct(p: { store: StoreId; extId: string; title: string; category: Category; url: string; source: string }): number {
  const db = getDb();
  db.prepare('INSERT OR IGNORE INTO price_products(store, ext_id, title, category, url, source, created_at) VALUES(?,?,?,?,?,?,?)').run(p.store, p.extId, p.title.slice(0, 200), p.category, p.url, p.source, Date.now());
  return Number((db.prepare('SELECT id FROM price_products WHERE store = ? AND ext_id = ?').get(p.store, p.extId) as { id: number }).id);
}

function recordPoint(productId: number, price: number | null, currency: 'AED' | 'USD', inStock: boolean) {
  getDb().prepare('INSERT OR REPLACE INTO price_points(product_id, at, price, currency, in_stock) VALUES(?,?,?,?,?)').run(productId, Date.now(), price, currency, inStock ? 1 : 0);
}

/** Price at (or just before) a moment, in USD so stores compare. */
function priceAt(points: PointRow[], t: number): number | null {
  let best: PointRow | null = null;
  for (const p of points) {
    if (p.at <= t && p.price !== null) best = p;
    if (p.at > t) break;
  }
  return best && best.price !== null ? toUsd(best.price, best.currency) : null;
}

function pct(now: number, then: number | null): number | null {
  return then ? Math.round(((now - then) / then) * 1000) / 10 : null;
}

export interface ProductSummary {
  id: number;
  store: StoreId;
  storeName: string;
  market: Market;
  title: string;
  category: Category;
  url: string;
  source: string;
  price: number | null;
  currency: 'AED' | 'USD';
  usd: number | null;
  inStock: boolean;
  updatedAt: number | null;
  change: Record<WindowKey, number | null>;
  low30: number | null;
  high30: number | null;
  points: number;
}

export function summaries(): ProductSummary[] {
  const db = getDb();
  const products = db.prepare('SELECT * FROM price_products WHERE enabled = 1 ORDER BY category, title').all() as unknown as ProductRow[];
  const pointsStmt = db.prepare('SELECT at, price, currency, in_stock FROM price_points WHERE product_id = ? AND at > ? ORDER BY at');
  const now = Date.now();
  return products.map((p) => {
    const pts = pointsStmt.all(p.id, now - 31 * DAY) as unknown as PointRow[];
    const last = pts.length ? pts[pts.length - 1] : null;
    const latestPriced = [...pts].reverse().find((x) => x.price !== null) ?? null;
    const usd = latestPriced && latestPriced.price !== null ? toUsd(latestPriced.price, latestPriced.currency) : null;
    const change = {} as Record<WindowKey, number | null>;
    for (const [k, days] of Object.entries(WINDOWS) as [WindowKey, number][]) change[k] = usd !== null ? pct(usd, priceAt(pts, now - days * DAY)) : null;
    const priced = pts.filter((x) => x.price !== null).map((x) => toUsd(x.price as number, x.currency));
    return {
      id: p.id,
      store: p.store,
      storeName: STORES[p.store].name,
      market: STORES[p.store].market,
      title: p.title,
      category: p.category,
      url: p.url,
      source: p.source,
      price: latestPriced?.price ?? null,
      currency: STORES[p.store].currency,
      usd,
      inStock: !!last?.in_stock && last?.price !== null,
      updatedAt: last?.at ?? null,
      change,
      low30: priced.length ? Math.min(...priced) : null,
      high30: priced.length ? Math.max(...priced) : null,
      points: pts.length,
    };
  });
}

/** Per category and market: the median move of its tracked listings (a crude but honest index). */
export function marketIndex(list: ProductSummary[]) {
  const median = (xs: number[]) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : Math.round(((s[m - 1] + s[m]) / 2) * 10) / 10;
  };
  const out: { category: Category; market: Market | 'all'; tracked: number; inStock: number; change: Record<WindowKey, number | null>; cheapest: ProductSummary | null }[] = [];
  for (const category of CATEGORIES) {
    for (const market of ['all', 'uae', 'us'] as const) {
      const items = list.filter((p) => p.category === category && (market === 'all' || p.market === market));
      const change = {} as Record<WindowKey, number | null>;
      for (const k of Object.keys(WINDOWS) as WindowKey[]) change[k] = median(items.map((p) => p.change[k]).filter((x): x is number => x !== null));
      const priced = items.filter((p) => p.usd !== null && p.inStock).sort((a, b) => (a.usd as number) - (b.usd as number));
      out.push({ category, market, tracked: items.length, inStock: priced.length, change, cheapest: priced[0] ?? null });
    }
  }
  return out;
}

export function history(productId: number, days = 90): PointRow[] {
  return getDb().prepare('SELECT at, price, currency, in_stock FROM price_points WHERE product_id = ? AND at > ? ORDER BY at').all(productId, Date.now() - days * DAY) as unknown as PointRow[];
}

// ---- Collecting ------------------------------------------------------------------------------

registerTask('prices.refresh', async (ctx, params) => {
  const seed = params.seed !== false;
  const db = getDb();
  if (seed) {
    ctx.progress('discover');
    for (const category of CATEGORIES) {
      for (const store of STORE_ORDER) {
        const have = (db.prepare("SELECT COUNT(*) AS n FROM price_products WHERE category = ? AND store = ? AND source = 'seed'").get(category, store) as { n: number }).n;
        if (have >= SEEDS[category].length * PER_QUERY) continue;
        for (const q of SEEDS[category]) {
          const key = `prices.seeded:${store}:${q}`;
          if (kvGet(key)) continue;
          try {
            // Search cards don't always show a price (graphics cards often say "See options"); the quote does.
            const hits = (await search(store, q, 10)).filter((h) => !JUNK.test(h.title) && MATCHES[category].test(h.title)).slice(0, PER_QUERY);
            for (const h of hits) addProduct({ store, extId: h.extId, title: h.title, category, url: h.url, source: 'seed' });
            // An empty answer (a light page, a hiccup) is retried next time; only real results settle a query.
            if (hits.length) kvSet(key, String(Date.now()));
            ctx.log(`${STORES[store].name} · ${q}: ${hits.length} listings`);
          } catch (e) {
            ctx.log(`${STORES[store].name} · ${q}: ${(e as Error).message}`);
          }
        }
      }
    }
  }
  ctx.progress('quote');
  const products = db.prepare('SELECT * FROM price_products WHERE enabled = 1').all() as unknown as ProductRow[];
  const before = new Map(summaries().map((s) => [s.id, s]));
  let ok = 0;
  let failed = 0;
  const drops: string[] = [];
  for (const [i, p] of products.entries()) {
    ctx.progress(`quote ${i + 1}/${products.length}`);
    try {
      const q = await quote(p.store, p.ext_id);
      recordPoint(p.id, q.price, q.currency, q.inStock);
      if (q.title && q.title !== p.title) db.prepare('UPDATE price_products SET title = ? WHERE id = ?').run(q.title.slice(0, 200), p.id);
      ok++;
      const prev = before.get(p.id);
      if (prev?.usd && q.price !== null && q.inStock) {
        const drop = pct(toUsd(q.price, q.currency), prev.usd);
        if (drop !== null && drop <= -10) drops.push(`${p.title.slice(0, 60)}: ${q.currency} ${q.price} (${drop}%)`);
      }
    } catch (e) {
      failed++;
      ctx.log(`${p.title.slice(0, 50)}: ${(e as Error).message}`);
    }
  }
  kvSet('prices.lastRefresh', String(Date.now()));
  ctx.log(`Quoted ${ok} listings, ${failed} failed`);
  if (drops.length) {
    const text = drops.slice(0, 6).join('\n');
    void notify('Price drop', text, '/prices');
    void postHook({ type: 'notice', text: `📉 Price drops:\n${text}` });
  }
});

let refreshing = false;
export function refreshNow(seed = true): number | null {
  const db = getDb();
  const running = db.prepare("SELECT id FROM tasks WHERE kind = 'prices.refresh' AND status IN ('queued','running')").get() as { id: number } | undefined;
  if (running) return running.id;
  refreshing = true;
  setTimeout(() => (refreshing = false), 1000);
  return enqueue('prices.refresh', 'Refresh part prices', { seed });
}

/** Twice a day, plus once at start when the last run is old. */
export function startPricesLoop(): () => void {
  if (process.env.VITEST) return () => {};
  const tick = () => {
    const last = Number(kvGet('prices.lastRefresh') ?? 0);
    if (Date.now() - last > REFRESH_EVERY && !refreshing) refreshNow();
  };
  const t = setInterval(tick, 10 * 60_000);
  setTimeout(tick, 90_000);
  return () => clearInterval(t);
}

// ---- API -------------------------------------------------------------------------------------

export async function pricesRoutes(app: FastifyInstance) {
  app.get('/api/prices', { preHandler: requireAuth }, async () => {
    const list = summaries();
    return { products: list, index: marketIndex(list), lastRefresh: Number(kvGet('prices.lastRefresh') ?? 0) || null, stores: STORES, aedPerUsd: 3.6725 };
  });

  app.get<{ Params: { id: string }; Querystring: { days?: string } }>('/api/prices/:id/history', { preHandler: requireAuth }, async (req, reply) => {
    const id = Number(req.params.id);
    const product = summaries().find((p) => p.id === id);
    if (!product) return reply.code(404).send({ error: 'not_found' });
    const days = Math.min(365, Math.max(1, Number(req.query.days ?? 90) || 90));
    return { product, points: history(id, days).map((p) => ({ at: p.at, price: p.price, usd: p.price === null ? null : toUsd(p.price, p.currency), inStock: !!p.in_stock })) };
  });

  app.post<{ Body: { url?: string; category?: string } }>('/api/prices/products', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = parseProductUrl(String(req.body?.url ?? ''));
    if (!parsed) return reply.code(400).send({ error: 'unsupported_url' });
    let q;
    try {
      q = await quote(parsed.store, parsed.extId);
    } catch (e) {
      return reply.code(502).send({ error: 'fetch_failed', detail: (e as Error).message.slice(0, 120) });
    }
    const category = isCategory(req.body?.category) ? req.body.category : guessCategory(q.title);
    const id = addProduct({ store: parsed.store, extId: parsed.extId, title: q.title, category, url: q.url, source: 'user' });
    getDb().prepare('UPDATE price_products SET enabled = 1 WHERE id = ?').run(id);
    recordPoint(id, q.price, q.currency, q.inStock);
    audit(req.session!.userId, 'prices_add', { store: parsed.store, extId: parsed.extId });
    return summaries().find((p) => p.id === id);
  });

  app.delete<{ Params: { id: string } }>('/api/prices/products/:id', { preHandler: requireAuth }, async (req, reply) => {
    const r = getDb().prepare('UPDATE price_products SET enabled = 0 WHERE id = ?').run(Number(req.params.id));
    if (!r.changes) return reply.code(404).send({ error: 'not_found' });
    audit(req.session!.userId, 'prices_remove', { id: Number(req.params.id) });
    return { ok: true };
  });

  app.post('/api/prices/refresh', { preHandler: requireAuth }, async () => ({ task: refreshNow() }));

  app.post('/api/prices/reset', { preHandler: requireElevated }, async (req) => {
    const db = getDb();
    db.exec("DELETE FROM price_points; DELETE FROM price_products; DELETE FROM kv WHERE key LIKE 'prices.%';");
    audit(req.session!.userId, 'prices_reset');
    return { task: refreshNow() };
  });
}
