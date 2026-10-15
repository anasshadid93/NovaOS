import type { FastifyInstance } from 'fastify';
import { requireAuth, requireElevated } from '../auth/sessions.js';
import { postHook } from '../bot/hook.js';
import { audit, getDb, kvGet, kvSet } from '../db.js';
import { notify } from '../notify/notify.js';
import { FEEDS, fetchFeed, type Headline } from './feeds.js';
import { assessHeadlines, DEFAULT_MODEL, llmReady, llmSettings, llmUsage, saveLlmSettings, type Assessment } from './llm.js';
import { ASSETS, buildPlaybook, dailyCloses, loadPlaybook, reaction, TRADABLE, type Asset, type EventType, type Playbook } from './playbook.js';
import { applyOpen, close, decide, equity, loadAccount, manage, RULES, saveAccount, freshAccount, type Account, type EventSignal } from './trader.js';

/**
 * News Trader: every 10 minutes read the feeds, ask the model which headlines are events, check each
 * against the playbook, and let the paper account act. Every minute, manage open trades on live
 * prices. Once an event's horizon has passed, record what the market really did (news_outcomes) so
 * the playbook keeps learning from the bot's own experience.
 */
const SCAN_EVERY = 10 * 60_000;
const BATCH = 40;
let account: Account = loadAccount();
let playbook: Playbook | null = loadPlaybook();
let prices: Record<string, number> = {};
let scanning = false;
let lastError: string | null = null;

async function fetchPrices() {
  const syms = Object.values(TRADABLE);
  const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbols=${encodeURIComponent(JSON.stringify(syms))}`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`binance ${res.status}`);
  const rows = (await res.json()) as { symbol: string; price: string }[];
  prices = Object.fromEntries(rows.map((r) => [r.symbol, Number(r.price)]));
}

function assetOf(symbol: string): Asset {
  return (Object.entries(TRADABLE).find(([, s]) => s === symbol)?.[0] ?? 'BTC') as Asset;
}

async function tickPrices() {
  await fetchPrices();
  const closed = manage(account, prices);
  if (closed.length) {
    saveAccount(account);
    for (const c of closed) announceClose(c.asset, c.pct, c.pnl, c.reason, c.headline);
  }
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
          const sig: EventSignal = { eventId: Number(r.lastInsertRowid), type: x.event, assets: x.assets, direction: x.direction, confidence: x.confidence, importance: x.importance, horizonDays: x.horizonDays, headline: h.title, why: x.why };
          const d = decide(account, playbook, sig, prices);
          for (const asset of d.closeAssets) for (const p of account.positions.filter((p) => p.asset === asset)) {
            const c = close(account, p, prices[p.symbol] ?? p.entry, 'news');
            announceClose(c.asset, c.pct, c.pnl, 'bearish news', h.title);
          }
          applyOpen(account, d.open, sig.eventId);
          opened += d.open.length;
          for (const s of d.skipped) if (x.importance >= 0.6) account.skipped.unshift({ at: Date.now(), headline: h.title, asset: s.asset, why: s.why });
          for (const p of d.open) {
            void postHook({ type: 'notice', text: `📰 News Trader bought ${p.asset} at ${p.entry} ($${p.margin} paper)\n${h.title.slice(0, 120)}\n${p.why}\nTarget +${Math.round(((p.target - p.entry) / p.entry) * 1000) / 10}% · stop −${RULES.stopPct}%` });
            void notify('News Trader', `Bought ${p.asset}: ${h.title.slice(0, 80)}`, '/news');
          }
          if (x.importance >= 0.85 && !d.open.length) void postHook({ type: 'notice', text: `📰 Big news (${x.event}): ${h.title.slice(0, 120)}\n${x.why}\nNo trade: ${d.skipped.map((s) => `${s.asset} ${s.why}`).join('; ').slice(0, 200)}` });
        }
      }
      saveAccount(account);
    }
    return { headlines: total, fresh: fresh.length, events, opened };
  } finally {
    scanning = false;
  }
}

/** Events older than their horizon: measure what really happened and keep it for the playbook. */
async function recordOutcomes() {
  const db = getDb();
  const due = db
    .prepare("SELECT id, title, type, assets, direction, day, horizon_days FROM news_events WHERE outcome_at IS NULL AND importance >= 0.5 AND at < ? ORDER BY at LIMIT 20")
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
    if (Date.now() - last >= SCAN_EVERY - 5000 && !scanning) void scanNow().catch((e) => (lastError = (e as Error).message));
  }, 60_000);
  const t3 = setInterval(() => void recordOutcomes().catch(() => undefined), 6 * 3600_000);
  setTimeout(() => {
    if (!playbook) void buildPlaybook().then((p) => (playbook = p)).catch((e) => (lastError = `playbook: ${(e as Error).message}`));
    void tickPrices().catch(() => undefined);
    void recordOutcomes().catch(() => undefined);
  }, 30_000);
  return () => {
    clearInterval(t1);
    clearInterval(t2);
    clearInterval(t3);
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
      rules: RULES,
      llm: { ready: !!s.anthropicKey, model: s.model || DEFAULT_MODEL, usage: llmUsage() },
      lastScan: Number(kvGet('news.lastScan') ?? 0) || null,
      lastError,
      scanning,
      feeds: FEEDS.map((f) => ({ id: f.id, name: f.name, lang: f.lang, kind: f.kind })),
      assets: ASSETS,
      tradable: Object.keys(TRADABLE),
    };
  });

  app.post<{ Body: { anthropicKey?: string; model?: string } }>('/api/news/settings', { preHandler: requireElevated }, async (req) => {
    const b = req.body ?? {};
    const patch: { anthropicKey?: string; model?: string } = {};
    if (typeof b.anthropicKey === 'string') patch.anthropicKey = b.anthropicKey.trim();
    if (typeof b.model === 'string') patch.model = b.model.trim().slice(0, 60);
    saveLlmSettings(patch);
    audit(req.session!.userId, 'news_settings', { key: patch.anthropicKey !== undefined ? (patch.anthropicKey ? 'set' : 'cleared') : 'unchanged', model: patch.model });
    return { ok: true, ready: llmReady() };
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
    const p = account.positions.find((x) => x.id === Number(req.params.id));
    if (!p) return reply.code(404).send({ error: 'not_found' });
    await fetchPrices().catch(() => undefined);
    const c = close(account, p, prices[p.symbol] ?? p.entry, 'manual');
    saveAccount(account);
    return c;
  });

  app.post('/api/news/reset', { preHandler: requireElevated }, async (req) => {
    account = freshAccount();
    saveAccount(account);
    audit(req.session!.userId, 'news_reset');
    return { ok: true };
  });
}

export const assetNames: Record<string, string> = { BTC: 'Bitcoin', ETH: 'Ethereum', SOL: 'Solana', GOLD: 'Gold (PAXG)', SILVER: 'Silver', OIL: 'Crude oil', SPX: 'S&P 500', DXY: 'US dollar' };
export const symbolAsset = assetOf;
