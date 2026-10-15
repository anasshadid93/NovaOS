import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { requireElevated } from '../auth/sessions.js';
import { audit } from '../db.js';
import { MARKETS } from './market.js';
import { setLiveExecutor, type Executor } from './engine.js';
import { getSettings, publicSettings, saveSettings } from './settings.js';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

/**
 * Live execution. OFF by default and impossible to switch on by accident:
 *  1. the owner must store exchange keys (never shown again),
 *  2. then explicitly authorise live trading in an elevated session, typing the phrase,
 *  3. with a hard cap on notional per order and a kill switch that closes nothing but blocks everything.
 * The engine's own risk limits still apply on top, and every order is audited.
 *
 * Broker: Binance spot (or its testnet) through the signed REST API. Kraken is listed but not
 * implemented yet; selecting it refuses to authorise.
 */
interface ExchangeKeys {
  key: string;
  secret: string;
}
const keysFile = () => path.join(config.dataDir, 'quant-exchange.json');
function loadKeys(): Partial<Record<string, ExchangeKeys>> {
  try {
    return JSON.parse(fs.readFileSync(keysFile(), 'utf8')) as Partial<Record<string, ExchangeKeys>>;
  } catch {
    return {};
  }
}
function saveKeys(all: Partial<Record<string, ExchangeKeys>>) {
  const tmp = `${keysFile()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 });
  fs.renameSync(tmp, keysFile());
}

const HOSTS = { binance: 'https://api.binance.com', 'binance-testnet': 'https://testnet.binance.vision' } as const;
type Broker = keyof typeof HOSTS;

async function binanceSigned(broker: Broker, k: ExchangeKeys, method: 'GET' | 'POST', route: string, params: Record<string, string | number>) {
  const qs = new URLSearchParams({ ...Object.fromEntries(Object.entries(params).map(([a, b]) => [a, String(b)])), timestamp: String(Date.now()), recvWindow: '5000' });
  const sig = createHmac('sha256', k.secret).update(qs.toString()).digest('hex');
  const url = `${HOSTS[broker]}${route}?${qs.toString()}&signature=${sig}`;
  const r = await fetch(url, { method, headers: { 'X-MBX-APIKEY': k.key }, signal: AbortSignal.timeout(15_000) });
  const j = (await r.json()) as Record<string, unknown>;
  if (!r.ok) throw new Error(`binance ${r.status}: ${String(j.msg ?? JSON.stringify(j)).slice(0, 160)}`);
  return j;
}

/** Live executor: a market order on the exchange; the fill price/fee come back from the exchange, never guessed. */
const binanceExecutor: Executor = async (_mode, asset, side, qty, ref) => {
  const s = getSettings();
  const broker = s.live.broker;
  if (!s.live.enabled || s.live.killSwitch || !s.live.authorizedAt) throw new Error('live_not_authorized');
  if (broker !== 'binance' && broker !== 'binance-testnet') throw new Error('broker_unsupported');
  const k = loadKeys()[broker];
  if (!k) throw new Error('no_exchange_keys');
  if (qty * ref > s.live.maxNotionalUsd) throw new Error('over_max_notional');
  const sym = MARKETS[asset]?.binance;
  if (!sym) throw new Error('unknown_asset');
  // Respect the exchange lot size by rounding to the step from exchangeInfo (cached per symbol).
  const step = await lotStep(broker, sym);
  const q = Math.floor(qty / step) * step;
  if (q <= 0) throw new Error('qty_below_lot');
  const res = await binanceSigned(broker, k, 'POST', '/api/v3/order', {
    symbol: sym,
    side: side.toUpperCase(),
    type: 'MARKET',
    quantity: q.toFixed(8).replace(/\.?0+$/, ''),
    newOrderRespType: 'FULL',
  });
  const fills = (res.fills as { price: string; qty: string; commission: string; commissionAsset: string }[]) ?? [];
  const filledQty = fills.reduce((a, f) => a + Number(f.qty), 0) || Number(res.executedQty);
  const notional = fills.reduce((a, f) => a + Number(f.price) * Number(f.qty), 0) || Number(res.cummulativeQuoteQty);
  const price = filledQty > 0 ? notional / filledQty : ref;
  // Commission may be charged in BNB or the base asset; convert roughly to quote.
  const fee = fills.reduce((a, f) => a + (f.commissionAsset === 'USDT' ? Number(f.commission) : f.commissionAsset === sym.replace('USDT', '') ? Number(f.commission) * Number(f.price) : 0), 0);
  audit(null, 'quant_live_fill', { broker, asset, side, qty: filledQty, price, fee, orderId: res.orderId });
  return { price, fee };
};

const lots = new Map<string, { step: number; at: number }>();
async function lotStep(broker: Broker, sym: string): Promise<number> {
  const c = lots.get(`${broker}:${sym}`);
  if (c && Date.now() - c.at < 6 * 3600_000) return c.step;
  const r = await fetch(`${HOSTS[broker]}/api/v3/exchangeInfo?symbol=${sym}`, { signal: AbortSignal.timeout(10_000) });
  const j = (await r.json()) as { symbols: { filters: { filterType: string; stepSize?: string }[] }[] };
  const f = j.symbols?.[0]?.filters.find((x) => x.filterType === 'LOT_SIZE');
  const step = Number(f?.stepSize ?? '0.00001');
  lots.set(`${broker}:${sym}`, { step, at: Date.now() });
  return step;
}

/** Verifies keys by reading the account (no order). Returns balances of the traded quote asset. */
export async function verifyKeys(broker: Broker, k: ExchangeKeys): Promise<{ ok: true; usdt: number; canTrade: boolean }> {
  const acct = (await binanceSigned(broker, k, 'GET', '/api/v3/account', {})) as { canTrade: boolean; balances: { asset: string; free: string }[] };
  const usdt = Number(acct.balances.find((b) => b.asset === 'USDT')?.free ?? 0);
  return { ok: true, usdt, canTrade: acct.canTrade };
}

export function liveStatus() {
  const s = getSettings();
  const keys = loadKeys();
  return {
    enabled: s.live.enabled,
    broker: s.live.broker,
    authorizedAt: s.live.authorizedAt,
    killSwitch: s.live.killSwitch,
    maxNotionalUsd: s.live.maxNotionalUsd,
    keysFor: Object.keys(keys),
    executor: s.live.enabled ? 'binance' : null,
  };
}

export function startLive(): () => void {
  setLiveExecutor(binanceExecutor);
  return () => setLiveExecutor(null);
}
export function stopLive() {
  /* nothing persistent to stop */
}

const PHRASE = 'I AUTHORIZE LIVE TRADING WITH REAL FUNDS';

export async function liveRoutes(app: FastifyInstance) {
  app.post<{ Body: { broker?: Broker; key?: string; secret?: string } }>('/api/quant/live/keys', { preHandler: requireElevated }, async (req, reply) => {
    const broker = req.body?.broker;
    if (broker !== 'binance' && broker !== 'binance-testnet') return reply.code(400).send({ error: 'broker_unsupported' });
    const key = String(req.body?.key ?? '').trim();
    const secret = String(req.body?.secret ?? '').trim();
    if (!key || !secret) return reply.code(400).send({ error: 'missing' });
    let check: Awaited<ReturnType<typeof verifyKeys>>;
    try {
      check = await verifyKeys(broker, { key, secret });
    } catch (e) {
      return reply.code(400).send({ error: 'verify_failed', detail: (e as Error).message });
    }
    const all = loadKeys();
    all[broker] = { key, secret };
    saveKeys(all);
    audit(req.session!.userId, 'quant_live_keys', { broker, canTrade: check.canTrade });
    return { ok: true, usdt: check.usdt, canTrade: check.canTrade };
  });
  app.delete<{ Params: { broker: string } }>('/api/quant/live/keys/:broker', { preHandler: requireElevated }, async (req) => {
    const all = loadKeys();
    delete all[req.params.broker];
    saveKeys(all);
    saveSettings({ live: { ...getSettings().live, enabled: false, authorizedAt: null, authorizedBy: null } });
    audit(req.session!.userId, 'quant_live_keys_removed', { broker: req.params.broker });
    return { ok: true };
  });

  /** The only way to switch live on. Elevated session + the exact phrase + keys verified minutes ago. */
  app.post<{ Body: { broker?: Broker; phrase?: string; maxNotionalUsd?: number } }>('/api/quant/live/authorize', { preHandler: requireElevated }, async (req, reply) => {
    const broker = req.body?.broker;
    if (broker !== 'binance' && broker !== 'binance-testnet') return reply.code(400).send({ error: 'broker_unsupported' });
    if (String(req.body?.phrase ?? '') !== PHRASE) return reply.code(400).send({ error: 'phrase_mismatch', phrase: PHRASE });
    const k = loadKeys()[broker];
    if (!k) return reply.code(400).send({ error: 'no_exchange_keys' });
    try {
      const v = await verifyKeys(broker, k);
      if (!v.canTrade) return reply.code(400).send({ error: 'account_cannot_trade' });
    } catch (e) {
      return reply.code(400).send({ error: 'verify_failed', detail: (e as Error).message });
    }
    const maxNotionalUsd = Math.max(10, Math.min(1e6, Number(req.body?.maxNotionalUsd ?? 100)));
    const saved = saveSettings({ live: { enabled: true, broker, authorizedAt: Date.now(), authorizedBy: req.session!.userId, maxNotionalUsd, killSwitch: false } });
    audit(req.session!.userId, 'quant_live_authorized', { broker, maxNotionalUsd });
    return publicSettings(saved);
  });
  app.post<{ Body: { killSwitch?: boolean } }>('/api/quant/live/stop', { preHandler: requireElevated }, async (req) => {
    const kill = req.body?.killSwitch !== false;
    const saved = saveSettings({ live: { ...getSettings().live, enabled: false, killSwitch: kill } });
    audit(req.session!.userId, 'quant_live_stopped', { killSwitch: kill });
    return publicSettings(saved);
  });
}
