import type { FastifyInstance } from 'fastify';
import { requireAuth, requireElevated } from '../auth/sessions.js';
import { postHook } from '../bot/hook.js';
import { audit, getDb, kvGet, kvSet } from '../db.js';
import { notify } from '../notify/notify.js';
import { FEEDS, fetchFeed, type Headline } from './feeds.js';
import { assessHeadlines, DEFAULT_MODEL, llmReady, llmSettings, llmUsage, saveLlmSettings, type Assessment } from './llm.js';
import { ASSETS, buildPlaybook, dailyCloses, loadPlaybook, reaction, SYMBOLS, type Asset, type EventType, type Playbook } from './playbook.js';
import { applyOpen, close, decide, equity, loadAccount, manage, moodTrades, rulesFrom, saveAccount, freshAccount, type Account, type EventSignal, type Rules } from './trader.js';

/**
 * News Trader: every N minutes read the feeds, ask the model which headlines are events, check each
 * against the playbook, and let the paper account act under the saved rules. Every minute, manage
 * open trades on live prices and keep an equity snapshot. Once an event's horizon has passed, record
 * what the market really did (news_outcomes) so the playbook keeps learning from the bot's own log.
 */
const BATCH = 40;
let account: Account = loadAccount();
let playbook: Playbook | null = loadPlaybook();
let rules: Rules = rulesFrom(llmSettings().rules);
let prices: Record<string, number> = {};
let scanning = false;
let lastError: string | null = null;

/** Prices for every asset that is traded or held: Binance in one call, Yahoo one symbol at a time. */
async function fetchPrices() {
  const want = new Set<Asset>([...rules.assets, ...(account.positions.map((p) => p.asset) as Asset[])]);
  const binance = [...want].filter((a) => SYMBOLS[a].source === 'binance').map((a) => SYMBOLS[a].symbol);
  const next: Record<string, number> = { ...prices };
  if (binance.length) {
    const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbols=${encodeURIComponent(JSON.stringify(binance))}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`binance ${res.status}`);
    for (const r of (await res.json()) as { symbol: string; price: string }[]) next[r.symbol] = Number(r.price);
  }
  for (const a of want) {
    if (SYMBOLS[a].source !== 'yahoo') continue;
    try {
      const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(SYMBOLS[a].symbol)}?range=1d&interval=5m`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) continue;
      const j = (await res.json()) as { chart: { result?: { meta: { regularMarketPrice?: number } }[] } };
      const p = j.chart.result?.[0]?.meta.regularMarketPrice;
      if (p) next[SYMBOLS[a].symbol] = p;
    } catch {
      /* keep the last price */
    }
  }
  prices = next;
}

function snapshotEquity() {
  const db = getDb();
  const at = Math.floor(Date.now() / 600_000) * 600_000; // one point per 10 minutes
  db.prepare('INSERT OR REPLACE INTO news_equity(at, equity, balance) VALUES(?,?,?)').run(at, equity(account, prices), account.balance);
}

async function tickPrices() {
  await fetchPrices();
  const closed = manage(account, prices, rules);
  if (closed.length) {
    saveAccount(account);
    for (const c of closed) announceClose(c.asset, c.pct, c.pnl, c.reason, c.headline);
  }
  snapshotEquity();
}

function announceClose(asset: Asset, pct: number, pnl: number, reason: string, headline: string) {
  const text = `${pnl >= 0 ? '✅' : '❌'} News Trader closed ${asset} ${pct >= 0 ? '+' : ''}${pct}% ($${pnl}) · ${reason}\n${headline.slice(0, 100)}\nBalance $${account.balance} (paper)`;
  void postHook({ type: 'notice', text });
  void notify('News Trader', `${asset} ${pct >= 0 ? '+' : ''}${pct}% (${reason})`, '/news');
}

/** One scan: feeds → new headlines → model → playbook → trades. */
export async function scanNow(): Promise<{ headlines: number; fresh: number; events: number; opened: number }> {
  if (scanning) throw new Error('scan_running');
  scanning = true;
  try {
    const db = getDb();
    const seen = db.prepare('SELECT 1 FROM news_items WHERE hash = ?');
    const ins = db.prepare('INSERT OR IGNORE INTO news_items(hash, feed, lang, title, link, published_at, seen_at) VALUES(?,?,?,?,?,?,?)');
    const fresh: Headline[] = [];
    let total = 0;
    for (const f of FEEDS) {
      try {
        const items = await fetchFeed(f);
        total += items.length;
        for (const h of items) {
          if (Date.now() - h.publishedAt > 36 * 3600_000) continue; // stale items that feeds keep around
          if (seen.get(h.hash)) continue;
          ins.run(h.hash, h.feed, h.lang, h.title, h.link, h.publishedAt, Date.now());
          if (!fresh.some((x) => x.hash === h.hash)) fresh.push(h);
        }
      } catch (e) {
        lastError = `${f.name}: ${(e as Error).message}`;
      }
    }
    kvSet('news.lastScan', String(Date.now()));
    let events = 0;
    let opened = 0;
    if (fresh.length && llmReady()) {
      await fetchPrices().catch(() => undefined);
      for (let i = 0; i < fresh.length; i += BATCH) {
        const batch = fresh.slice(i, i + BATCH);
        let as: Assessment[] = [];
        try {
          as = await assessHeadlines(batch.map((h) => h.title));
          lastError = null;
        } catch (e) {
          lastError = `model: ${(e as Error).message}`;
          break;
        }
        for (const x of as) {
          const h = batch[x.i];
          const r = db
            .prepare('INSERT INTO news_events(item_hash, title, type, assets, direction, confidence, importance, horizon_days, why, at, day) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
            .run(h.hash, h.title, x.event, JSON.stringify(x.assets), x.direction, x.confidence, x.importance, x.horizonDays, x.why, Date.now(), new Date().toISOString().slice(0, 10));
          events++;
          const sig: EventSignal = {
            eventId: Number(r.lastInsertRowid),
            type: x.event,
            assets: x.assets,
            direction: x.direction,
            confidence: x.confidence,
            importance: x.importance,
            horizonDays: x.horizonDays,
            headline: h.title,
            why: x.why,
          };
          const d = decide(account, playbook, sig, prices, rules);
          for (const asset of d.closeAssets)
            for (const p of account.positions.filter((p) => p.asset === asset)) {
              const c = close(account, p, prices[p.symbol] ?? p.entry, 'news');
              announceClose(c.asset, c.pct, c.pnl, 'bearish news', h.title);
            }
          applyOpen(account, d.open, sig.eventId);
          opened += d.open.length;
          for (const s of d.skipped) if (x.importance >= 0.5) account.skipped.unshift({ at: Date.now(), headline: h.title, asset: s.asset, why: s.why });
          for (const p of d.open) {
            void postHook({
              type: 'notice',
              text: `📰 News Trader bought ${p.asset} at ${p.entry} ($${p.margin} paper)\n${h.title.slice(0, 120)}\n${p.why}\nTarget +${Math.round(((p.target - p.entry) / p.entry) * 1000) / 10}% · stop −${rules.stopPct}%`,
            });
            void notify('News Trader', `Bought ${p.asset}: ${h.title.slice(0, 80)}`, '/news');
          }
          if (x.importance >= 0.85 && !d.open.length)
            void postHook({
              type: 'notice',
              text: `📰 Big news (${x.event}): ${h.title.slice(0, 120)}\n${x.why}\nNo trade: ${d.skipped
                .map((s) => `${s.asset} ${s.why}`)
                .join('; ')
                .slice(0, 200)}`,
            });
        }
      }
      saveAccount(account);
    }
    if (llmReady()) tradeTheMood();
    snapshotEquity();
    return { headlines: total, fresh: fresh.length, events, opened };
  } finally {
    scanning = false;
  }
}

/** The market mood per asset from the recent news flow: Σ direction × confidence × importance × decay. */
export function marketView(): Partial<Record<Asset, { score: number; n: number; drivers: string[] }>> {
  const db = getDb();
  const since = Date.now() - rules.sentimentHours * 3600_000;
  const rows = db.prepare('SELECT title, assets, direction, confidence, importance, at FROM news_events WHERE at > ? ORDER BY at DESC').all(since) as {
    title: string;
    assets: string;
    direction: string;
    confidence: number;
    importance: number;
    at: number;
  }[];
  const out: Partial<Record<Asset, { score: number; n: number; drivers: { w: number; t: string }[] }>> = {};
  for (const r of rows) {
    const sign = r.direction === 'up' ? 1 : r.direction === 'down' ? -1 : 0;
    if (!sign) continue;
    const age = (Date.now() - r.at) / 3600_000;
    const decay = Math.max(0, 1 - age / rules.sentimentHours);
    const w = sign * r.confidence * r.importance * decay * 2;
    for (const a of JSON.parse(r.assets) as Asset[]) {
      const o = (out[a] ??= { score: 0, n: 0, drivers: [] });
      o.score += w;
      o.n++;
      o.drivers.push({ w, t: `${sign > 0 ? '↑' : '↓'} ${r.title.slice(0, 80)}` });
    }
  }
  const res: Partial<Record<Asset, { score: number; n: number; drivers: string[] }>> = {};
  for (const [a, o] of Object.entries(out) as [Asset, { score: number; n: number; drivers: { w: number; t: string }[] }][])
    res[a] = {
      score: Math.round(o.score * 100) / 100,
      n: o.n,
      drivers: o.drivers
        .sort((x, y) => Math.abs(y.w) - Math.abs(x.w))
        .slice(0, 3)
        .map((x) => x.t),
    };
  return res;
}

function tradeTheMood() {
  const view = marketView();
  const d = moodTrades(account, view, prices, rules);
  for (const asset of d.closeAssets)
    for (const p of account.positions.filter((p) => p.asset === asset)) {
      const c = close(account, p, prices[p.symbol] ?? p.entry, 'news');
      announceClose(c.asset, c.pct, c.pnl, 'mood turned negative', p.headline);
    }
  applyOpen(account, d.open, -1);
  for (const p of d.open) {
    void postHook({
      type: 'notice',
      text: `📰 News Trader bought ${p.asset} at ${p.entry} ($${p.margin} paper) on market mood
${p.why}
Target +${Math.round(((p.target - p.entry) / p.entry) * 1000) / 10}% · stop −${rules.stopPct}%`,
    });
    void notify('News Trader', `Bought ${p.asset} on market mood`, '/news');
  }
  if (d.open.length || d.closeAssets.length) saveAccount(account);
}

/** Events older than their horizon: measure what really happened and keep it for the playbook. */
async function recordOutcomes() {
  const db = getDb();
  const due = db
    .prepare('SELECT id, title, type, assets, direction, day, horizon_days FROM news_events WHERE outcome_at IS NULL AND importance >= 0.5 AND at < ? ORDER BY at LIMIT 20')
    .all(Date.now() - 15 * 86_400_000) as { id: number; title: string; type: EventType; assets: string; direction: string; day: string; horizon_days: number }[];
  if (!due.length) return;
  const cache = new Map<Asset, Awaited<ReturnType<typeof dailyCloses>>>();
  for (const e of due) {
    const moves: Record<string, unknown> = {};
    for (const a of JSON.parse(e.assets) as Asset[]) {
      if (!cache.has(a)) {
        try {
          cache.set(a, await dailyCloses(a));
        } catch {
          continue;
        }
      }
      moves[a] = reaction(cache.get(a)!, e.day);
    }
    db.prepare('INSERT OR IGNORE INTO news_outcomes(event_id, day, type, note, moves) VALUES(?,?,?,?,?)').run(e.id, e.day, e.type, e.title.slice(0, 120), JSON.stringify(moves));
    db.prepare('UPDATE news_events SET outcome_at = ? WHERE id = ?').run(Date.now(), e.id);
  }
  playbook = await buildPlaybook();
}

export function startNewsTrader(): () => void {
  if (process.env.VITEST) return () => {};
  const t1 = setInterval(() => void tickPrices().catch((e) => (lastError = `prices: ${(e as Error).message}`)), 60_000);
  const t2 = setInterval(() => {
    const last = Number(kvGet('news.lastScan') ?? 0);
    if (Date.now() - last >= rules.scanEveryMin * 60_000 - 5000 && !scanning) void scanNow().catch((e) => (lastError = (e as Error).message));
  }, 60_000);
  const t3 = setInterval(() => void recordOutcomes().catch(() => undefined), 6 * 3600_000);
  setTimeout(() => {
    if (!playbook)
      void buildPlaybook()
        .then((p) => (playbook = p))
        .catch((e) => (lastError = `playbook: ${(e as Error).message}`));
    void tickPrices().catch(() => undefined);
    void recordOutcomes().catch(() => undefined);
  }, 30_000);
  return () => {
    clearInterval(t1);
    clearInterval(t2);
    clearInterval(t3);
  };
}

/** Numbers for the dashboard: results so far, by asset, by event type, by exit reason; activity per day. */
export function stats() {
  const db = getDb();
  const closed = account.closed;
  const wins = closed.filter((c) => c.pnl > 0);
  const losses = closed.filter((c) => c.pnl <= 0);
  const sum = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100;
  const grossWin = sum(wins.map((c) => c.pnl));
  const grossLoss = Math.abs(sum(losses.map((c) => c.pnl)));
  const group = <K extends string>(key: (c: (typeof closed)[number]) => K) => {
    const m = new Map<K, { n: number; wins: number; pnl: number }>();
    for (const c of closed) {
      const g = m.get(key(c)) ?? { n: 0, wins: 0, pnl: 0 };
      g.n++;
      if (c.pnl > 0) g.wins++;
      g.pnl = Math.round((g.pnl + c.pnl) * 100) / 100;
      m.set(key(c), g);
    }
    return [...m.entries()].map(([k, v]) => ({ key: k, ...v })).sort((a, b) => b.pnl - a.pnl);
  };
  const days = 14;
  const since = Date.now() - days * 86_400_000;
  const perDay = new Map<string, { headlines: number; events: number; trades: number }>();
  for (let i = days - 1; i >= 0; i--) perDay.set(new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10), { headlines: 0, events: 0, trades: 0 });
  for (const r of db.prepare("SELECT date(seen_at / 1000, 'unixepoch') AS d, COUNT(*) AS n FROM news_items WHERE seen_at > ? GROUP BY d").all(since) as { d: string; n: number }[])
    if (perDay.has(r.d)) perDay.get(r.d)!.headlines = r.n;
  for (const r of db.prepare('SELECT day AS d, COUNT(*) AS n FROM news_events WHERE at > ? GROUP BY day').all(since) as { d: string; n: number }[]) if (perDay.has(r.d)) perDay.get(r.d)!.events = r.n;
  for (const c of closed) {
    const d = new Date(c.openedAt).toISOString().slice(0, 10);
    if (perDay.has(d)) perDay.get(d)!.trades++;
  }
  for (const p of account.positions) {
    const d = new Date(p.openedAt).toISOString().slice(0, 10);
    if (perDay.has(d)) perDay.get(d)!.trades++;
  }
  const eq = db.prepare('SELECT at, equity FROM news_equity WHERE at > ? ORDER BY at').all(Date.now() - 90 * 86_400_000) as { at: number; equity: number }[];
  const feeds = db.prepare('SELECT feed, COUNT(*) AS n FROM news_items WHERE seen_at > ? GROUP BY feed ORDER BY n DESC').all(Date.now() - 86_400_000) as { feed: string; n: number }[];
  const types = db.prepare('SELECT type, COUNT(*) AS n FROM news_events WHERE at > ? GROUP BY type ORDER BY n DESC').all(since) as { type: string; n: number }[];
  const eqNow = equity(account, prices);
  return {
    equity: eqNow,
    returnPct: Math.round(((eqNow - account.start) / account.start) * 1000) / 10,
    trades: closed.length,
    open: account.positions.length,
    winRate: closed.length ? Math.round((wins.length / closed.length) * 100) : null,
    profitFactor: grossLoss ? Math.round((grossWin / grossLoss) * 100) / 100 : null,
    avgPct: closed.length ? Math.round((closed.reduce((a, c) => a + c.pct, 0) / closed.length) * 10) / 10 : null,
    best: closed.length ? closed.reduce((a, c) => (c.pct > a.pct ? c : a)) : null,
    worst: closed.length ? closed.reduce((a, c) => (c.pct < a.pct ? c : a)) : null,
    dayPnl: account.dayPnl,
    byAsset: group((c) => c.asset),
    byType: group((c) => c.type),
    byReason: group((c) => c.reason),
    perDay: [...perDay.entries()].map(([day, v]) => ({ day, ...v })),
    equitySeries: eq,
    feeds24h: feeds,
    eventTypes14d: types,
  };
}

export async function newsRoutes(app: FastifyInstance) {
  app.get('/api/news', { preHandler: requireAuth }, async () => {
    const db = getDb();
    const events = db.prepare('SELECT id, title, type, assets, direction, confidence, importance, horizon_days, why, at FROM news_events ORDER BY at DESC LIMIT 60').all() as Record<string, unknown>[];
    const headlines = db.prepare('SELECT title, feed, lang, link, published_at FROM news_items ORDER BY published_at DESC LIMIT 40').all();
    const s = llmSettings();
    return {
      account: { ...account, equity: equity(account, prices) },
      prices,
      events: events.map((e) => ({ ...e, assets: JSON.parse(String(e.assets)) })),
      headlines,
      playbook: playbook ? { builtAt: playbook.builtAt, events: playbook.events, entries: playbook.entries } : null,
      rules,
      symbols: SYMBOLS,
      llm: { ready: !!s.anthropicKey, model: s.model || DEFAULT_MODEL, usage: llmUsage() },
      lastScan: Number(kvGet('news.lastScan') ?? 0) || null,
      lastError,
      scanning,
      feeds: FEEDS.map((f) => ({ id: f.id, name: f.name, lang: f.lang, kind: f.kind })),
      assets: ASSETS,
      stats: stats(),
      mood: marketView(),
    };
  });

  app.post<{ Body: { anthropicKey?: string; model?: string; rules?: Record<string, unknown> } }>('/api/news/settings', { preHandler: requireElevated }, async (req) => {
    const b = req.body ?? {};
    const patch: { anthropicKey?: string; model?: string; rules?: Record<string, unknown> } = {};
    if (typeof b.anthropicKey === 'string') patch.anthropicKey = b.anthropicKey.trim();
    if (typeof b.model === 'string') patch.model = b.model.trim().slice(0, 60);
    if (b.rules && typeof b.rules === 'object') {
      const r = rulesFrom({ ...(llmSettings().rules ?? {}), ...b.rules });
      patch.rules = { ...r };
      rules = r;
      await fetchPrices().catch(() => undefined);
    }
    saveLlmSettings(patch);
    audit(req.session!.userId, 'news_settings', { key: patch.anthropicKey !== undefined ? (patch.anthropicKey ? 'set' : 'cleared') : 'unchanged', model: patch.model, rules: !!patch.rules });
    return { ok: true, ready: llmReady(), rules };
  });

  app.post('/api/news/scan', { preHandler: requireAuth }, async (_req, reply) => {
    try {
      return await scanNow();
    } catch (e) {
      return reply.code(409).send({ error: (e as Error).message });
    }
  });

  app.post('/api/news/playbook', { preHandler: requireAuth }, async () => {
    playbook = await buildPlaybook();
    return { events: playbook.events, entries: playbook.entries.length };
  });

  app.post<{ Body: { running?: boolean } }>('/api/news/run', { preHandler: requireAuth }, async (req) => {
    account.running = req.body?.running !== false;
    saveAccount(account);
    return { running: account.running };
  });

  app.post<{ Params: { id: string } }>('/api/news/positions/:id/close', { preHandler: requireAuth }, async (req, reply) => {
    if (!account.positions.some((x) => x.id === Number(req.params.id))) return reply.code(404).send({ error: 'not_found' });
    await fetchPrices().catch(() => undefined);
    // Re-find after the await: the minute loop may have closed it meanwhile (stop/target), which must not be booked twice.
    const p = account.positions.find((x) => x.id === Number(req.params.id));
    if (!p) return reply.code(409).send({ error: 'already_closed' });
    const c = close(account, p, prices[p.symbol] ?? p.entry, 'manual');
    audit(req.session!.userId, 'news_manual_close', { id: p.id, asset: p.asset, pnl: c.pnl });
    saveAccount(account);
    snapshotEquity();
    return c;
  });

  app.post('/api/news/reset', { preHandler: requireElevated }, async (req) => {
    account = freshAccount(rules.startBalance);
    saveAccount(account);
    getDb().exec('DELETE FROM news_equity');
    snapshotEquity();
    audit(req.session!.userId, 'news_reset');
    return { ok: true };
  });
}
