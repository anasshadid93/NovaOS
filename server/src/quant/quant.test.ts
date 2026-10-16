import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'manar-quant-'));
process.env.MANAR_DATA_DIR = tmp;
const { normalize, DEFAULTS, saveSettings, getSettings } = await import('./settings.js');
const { technical, tradeable } = await import('./market.js');
import type { Bar } from './market.js';
const { merge, publishSignal, step, openPositions, closePosition, equity, latestSignals } = await import('./engine.js');
const { routeModels } = await import('./agents.js');
const { getDb } = await import('../db.js');

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function bars(n: number, start = 100, drift = 0.004): Bar[] {
  const out: Bar[] = [];
  let c = start;
  for (let i = 0; i < n; i++) {
    const o = c;
    c = c * (1 + drift + (i % 7 === 0 ? -0.01 : 0));
    out.push({ t: Date.UTC(2025, 0, 1) + i * 86400_000, o, h: Math.max(o, c) * 1.01, l: Math.min(o, c) * 0.99, c, v: 1000 });
  }
  return out;
}

describe('settings', () => {
  it('clamps risk limits so a bad request can never widen them past the hard bounds', () => {
    const s = normalize({ risk: { riskPct: 99, maxOpen: 50, stopMinPct: 20, stopMaxPct: 1, dailyLossPct: -5 } as never });
    expect(s.risk.riskPct).toBe(5);
    expect(s.risk.maxOpen).toBe(10);
    expect(s.risk.stopMaxPct).toBeGreaterThanOrEqual(s.risk.stopMinPct);
    expect(s.risk.dailyLossPct).toBe(0.5);
    expect(s.live.enabled).toBe(false);
  });
  it('keeps live off and the kill switch sane by default', () => {
    expect(DEFAULTS.live.enabled).toBe(false);
    expect(DEFAULTS.paperEnabled).toBe(true);
  });
  it('routes to the first provider with a key and falls back to Ollama without any', () => {
    const none = normalize({ keys: { anthropic: '', openai: '' } });
    expect(routeModels(none)?.provider).toBe('ollama');
    const oa = normalize({
      keys: { anthropic: '', openai: 'sk-x' },
      routing: { quick: { provider: 'anthropic', model: 'claude-haiku-4-5' }, deep: { provider: 'anthropic', model: 'claude-sonnet-5' }, fallback: ['anthropic', 'openai', 'ollama'] },
    });
    const r = routeModels(oa)!;
    expect(r.quickProvider).toBe('openai');
    expect(r.quick).toMatch(/gpt/);
  });
});

describe('market', () => {
  it('scores an uptrend positive and a downtrend negative', () => {
    const up = technical(bars(260))!;
    const down = technical(bars(260, 100, -0.004))!;
    expect(up.score).toBeGreaterThan(0.3);
    expect(down.score).toBeLessThan(-0.3);
    expect(up.atrPct).toBeGreaterThan(0);
  });
  it('refuses stale, unverified or disputed prices', () => {
    const now = Date.now();
    expect(tradeable(undefined, now, 120, 2).why).toBe('no_price');
    expect(tradeable({ asset: 'BTC', price: 1, at: now - 300_000, source: 'binance', check: { price: 1, source: 'kraken', gapPct: 0 } }, now, 120, 2).why).toBe('stale_price');
    expect(tradeable({ asset: 'BTC', price: 1, at: now, source: 'binance' }, now, 120, 2).why).toBe('unverified_price');
    expect(tradeable({ asset: 'BTC', price: 100, at: now, source: 'binance', check: { price: 105, source: 'kraken', gapPct: 5 } }, now, 120, 2).why).toBe('sources_disagree');
    expect(tradeable({ asset: 'BTC', price: 100, at: now, source: 'binance', check: { price: 100.5, source: 'kraken', gapPct: 0.5 } }, now, 120, 2).ok).toBe(true);
  });
});

describe('engine', () => {
  saveSettings({ strategy: 'rules' });
  const s = getSettings();
  it('merges weighted signals and lets a decisive agent Sell veto', () => {
    publishSignal('technical', 'BTC', 0.8, 0.8, 240, 3600_000, { atrPct: 3 }, 'BTC:t1');
    publishSignal('agents', 'BTC', -1, 1, 120, 3600_000, { rating: 'Sell' }, 'BTC:a1');
    publishSignal('news', 'BTC', 0.2, 0.5, 48, 3600_000, {}, 'BTC:n1');
    const m = merge(['BTC', 'ETH'], s)[0];
    expect(m.asset).toBe('BTC');
    expect(m.vetoed).toBe('agents_sell');
    expect(m.score).toBeLessThan(0.3);
    // ETH has no technical leg → no score at all.
    expect(merge(['BTC', 'ETH'], s)[1].score).toBe(0);
    expect(latestSignals(['BTC']).length).toBe(3);
  });

  it('opens a risk-sized paper position on a strong score, never twice, and closes on the stop', async () => {
    // Stub both price sources: Binance primary, Kraken check.
    let px = 100;
    vi.stubGlobal('fetch', async (url: string) => {
      const u = String(url);
      if (u.includes('/api/v3/ticker/price')) return new Response(JSON.stringify([{ symbol: 'ETHUSDT', price: String(px) }]));
      if (u.includes('/0/public/Ticker')) return new Response(JSON.stringify({ error: [], result: { ETHUSDT: { c: [String(px * 1.001), '1'] } } }));
      if (u.includes('/api/v3/klines')) return new Response(JSON.stringify(bars(300).map((b) => [b.t, b.o, b.h, b.l, b.c, b.v])));
      return new Response('{}', { status: 404 });
    });
    saveSettings({ assets: ['ETH'], risk: { startBalance: 10_000, riskPct: 1, stopAtr: 2, stopMinPct: 2, stopMaxPct: 10, maxPositionPct: 25, takeProfitR: 2, entryScore: 0.35 } });
    publishSignal('technical', 'ETH', 0.9, 0.8, 240, 3600_000, { atrPct: 2 }, 'ETH:t1');
    const r1 = (await step('paper'))!;
    expect(r1.opened).toHaveLength(1);
    const p = openPositions('paper')[0];
    // stop = 2 × ATR 2 % = 4 % → risk 1 % of 10 000 = $100 → notional $2 500 (capped at 25 % = $2 500).
    expect(p.entry).toBeCloseTo(100.05, 2);
    expect(p.stop).toBeCloseTo(100.05 * 0.96, 2);
    expect(p.qty * p.entry).toBeGreaterThan(2400);
    expect(p.qty * p.entry).toBeLessThanOrEqual(2502); // 2 500 at the quote, filled 0.05 % higher
    // Same minute, same score: nothing new (one position per asset; idempotent orders).
    const r2 = (await step('paper'))!;
    expect(r2.opened).toHaveLength(0);
    expect(openPositions('paper')).toHaveLength(1);
    // Price falls through the stop → closed with a loss, booked exactly once.
    px = 95;
    const r3 = (await step('paper'))!;
    expect(r3.closed).toHaveLength(1);
    expect(r3.closed[0].reason).toBe('stop');
    expect(openPositions('paper')).toHaveLength(0);
    const orders = getDb().prepare("SELECT COUNT(*) AS n FROM quant_orders WHERE status = 'filled'").get() as { n: number };
    expect(orders.n).toBe(2);
    const eq = equity('paper', 10_000, {});
    expect(eq.equity).toBeLessThan(10_000);
    expect(eq.equity).toBeGreaterThan(9_850);
    // Cooldown blocks an immediate re-entry after the loss.
    px = 100;
    const r4 = (await step('paper'))!;
    expect(r4.opened).toHaveLength(0);
    expect(r4.skipped.some((x) => x.why === 'cooldown')).toBe(true);
    vi.unstubAllGlobals();
  });

  it('refuses to trade on a disputed price and blocks live orders without authorisation', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      const u = String(url);
      if (u.includes('/api/v3/ticker/price')) return new Response(JSON.stringify([{ symbol: 'ETHUSDT', price: '100' }]));
      if (u.includes('/0/public/Ticker')) return new Response(JSON.stringify({ error: [], result: { ETHUSDT: { c: ['110', '1'] } } }));
      return new Response('{}', { status: 404 });
    });
    saveSettings({ risk: { cooldownMin: 0 } });
    const r = (await step('paper'))!;
    expect(r.opened).toHaveLength(0);
    expect(JSON.stringify(r.skipped)).toContain('sources_disagree');
    const live = (await step('live'))!;
    expect(live.skipped.some((x) => x.why === 'disabled')).toBe(true);
    vi.unstubAllGlobals();
  });

  it('manual close is idempotent', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      const u = String(url);
      if (u.includes('/api/v3/ticker/price')) return new Response(JSON.stringify([{ symbol: 'ETHUSDT', price: '100' }]));
      if (u.includes('/0/public/Ticker')) return new Response(JSON.stringify({ error: [], result: { ETHUSDT: { c: ['100', '1'] } } }));
      return new Response('{}', { status: 404 });
    });
    publishSignal('technical', 'ETH', 0.9, 0.8, 240, 3600_000, { atrPct: 2 }, 'ETH:t2');
    await step('paper');
    const p = openPositions('paper')[0];
    expect(p).toBeTruthy();
    const a = await closePosition('paper', p, 101, 'manual', `${p.id}:manual:x`);
    const b = await closePosition('paper', p, 101, 'manual', `${p.id}:manual:x`);
    expect(a).not.toBeNull();
    expect(b).toBeNull();
    vi.unstubAllGlobals();
  });
});

describe('regime strategy', () => {
  it('buys 1/N in a bull regime, stays out in a bear one, and trails the stop from the high', async () => {
    let px = 100;
    vi.stubGlobal('fetch', async (url: string) => {
      const u = String(url);
      if (u.includes('/api/v3/ticker/price')) return new Response(JSON.stringify([{ symbol: 'ETHUSDT', price: String(px) }]));
      if (u.includes('/0/public/Ticker')) return new Response(JSON.stringify({ error: [], result: { ETHUSDT: { c: [String(px), '1'] } } }));
      return new Response('{}', { status: 404 });
    });
    getDb().exec('DELETE FROM quant_positions; DELETE FROM quant_orders; DELETE FROM quant_signals');
    saveSettings({ strategy: 'regime', assets: ['ETH'], regime: { trailPct: 15, cooldownDays: 0 }, risk: { startBalance: 10_000, cooldownMin: 0, maxExposurePct: 100 } });
    publishSignal('technical', 'ETH', 0.1, 0.8, 240, 3600_000, { bull: false, sma200: 120, ema20: 95, ema50: 100 }, 'ETH:r1');
    const bear = (await step('paper'))!;
    expect(bear.opened).toHaveLength(0);
    expect(bear.skipped.some((x) => x.why === 'bear')).toBe(true);
    publishSignal('technical', 'ETH', 0.1, 0.8, 240, 3600_000, { bull: true, sma200: 90, ema20: 101, ema50: 100 }, 'ETH:r2');
    const bull = (await step('paper'))!;
    expect(bull.opened).toHaveLength(1);
    const p = openPositions('paper')[0];
    expect(p.qty * p.entry).toBeCloseTo(9700, -1);
    expect(p.stop).toBeCloseTo(p.entry * 0.85, 1);
    px = 130;
    await step('paper');
    const p2 = openPositions('paper')[0];
    expect(p2.stop).toBeCloseTo(130 * 0.85, 1);
    px = 110; // 15 % under the 130 high → trailing stop
    const r = (await step('paper'))!;
    expect(r.closed[0]?.reason).toBe('stop');
    expect(r.closed[0].pnl).toBeGreaterThan(0);
    vi.unstubAllGlobals();
  });
});
