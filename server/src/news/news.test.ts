import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'manar-news-'));
process.env.MANAR_DATA_DIR = tmp;
const { parseRss, headlineHash } = await import('./feeds.js');
const { parseAssessments } = await import('./llm.js');
const { reaction, summarise } = await import('./playbook.js');
const { decide, applyOpen, manage, freshAccount, RULES } = await import('./trader.js');
import type { Playbook } from './playbook.js';

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const feed = { id: 'x', name: 'X', url: 'https://x', lang: 'en' as const, kind: 'world' as const };

describe('feeds', () => {
  it('parses RSS items and hashes titles ignoring punctuation and case', () => {
    const xml = `<rss><channel><item><title><![CDATA[Oil jumps 5% after OPEC+ cut]]></title><link>https://a/1</link><pubDate>Wed, 15 Oct 2026 10:00:00 GMT</pubDate></item>
      <item><title>Short</title><link>https://a/2</link></item></channel></rss>`;
    const items = parseRss(xml, feed);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Oil jumps 5% after OPEC+ cut');
    expect(items[0].publishedAt).toBe(Date.parse('2026-10-15T10:00:00Z'));
    expect(headlineHash('Oil jumps 5% after OPEC+ cut!')).toBe(headlineHash('oil jumps 5 after opec cut'));
  });
});

describe('model output', () => {
  it('keeps only valid events with known assets', () => {
    const text = `Here you go:\n[{"i":0,"event":"war_escalation","assets":["GOLD","OIL","XYZ"],"direction":"up","confidence":0.9,"horizonDays":7,"importance":0.95,"why":"strikes"},
      {"i":1,"event":"none","assets":["BTC"],"direction":"up","confidence":0.5},
      {"i":9,"event":"fed_cut","assets":["BTC"],"direction":"up","confidence":0.8},
      {"i":2,"event":"made_up","assets":["BTC"],"direction":"up","confidence":0.8}]`;
    const as = parseAssessments(text, 3);
    expect(as).toHaveLength(1);
    expect(as[0]).toMatchObject({ i: 0, event: 'war_escalation', assets: ['GOLD', 'OIL'], direction: 'up', horizonDays: 7 });
  });
});

describe('playbook', () => {
  it('measures reactions from the close before the event and summarises direction and reliability', () => {
    const d = new Map<string, number>();
    const base = Date.parse('2024-01-01T00:00:00Z');
    for (let i = 0; i < 40; i++) d.set(new Date(base + i * 86_400_000).toISOString().slice(0, 10), 100 + i); // +1/day
    const r = reaction(d, '2024-01-11');
    expect(r[1]).toBeCloseTo(((111 - 109) / 109) * 100, 1);
    expect(r[7]).toBeCloseTo(((117 - 109) / 109) * 100, 1);
    const s = summarise('fed_cut', 'BTC', [r, r, { 1: -1, 3: -2, 7: 2, 14: 3 }]);
    expect(s?.n).toBe(3);
    expect(s?.direction).toBe('up');
    expect(s?.best).toBe(14);
    expect(s?.reliability).toBe(1);
  });
});

describe('trader rules', () => {
  const pb: Playbook = {
    builtAt: 0,
    events: 10,
    entries: [
      { type: 'war_escalation', asset: 'GOLD', n: 6, avg: { 1: 1, 3: 2.5, 7: 4, 14: 3 }, upRate: { 1: 0.8, 3: 0.8, 7: 0.83, 14: 0.7 }, best: 7, direction: 'up', reliability: 0.83 },
      { type: 'war_escalation', asset: 'BTC', n: 6, avg: { 1: -3, 3: -2, 7: -1, 14: 1 }, upRate: { 1: 0.2, 3: 0.3, 7: 0.4, 14: 0.5 }, best: 1, direction: 'down', reliability: 0.8 },
    ],
  };
  const prices = { PAXGUSDT: 4000, BTCUSDT: 80000, ETHUSDT: 2400, SOLUSDT: 100 };
  const sig = { eventId: 1, type: 'war_escalation' as const, assets: ['GOLD', 'BTC', 'OIL'] as const, direction: 'up' as const, confidence: 0.9, importance: 0.95, horizonDays: 10, headline: 'Strikes begin', why: 'escalation' };

  it('buys what history backs, skips watch-only assets and bearish history', () => {
    const a = freshAccount(1000);
    const d = decide(a, pb, { ...sig, assets: [...sig.assets] }, prices, RULES, 0);
    expect(d.open.map((p) => p.asset)).toEqual(['GOLD']);
    expect(d.open[0].margin).toBe(50);
    expect(d.open[0].target).toBeCloseTo(4000 * 1.04, 3); // history avg +4% in 7d, within 3–8%
    expect(d.open[0].deadline).toBe(10 * 86_400_000); // the model's 10-day horizon, at least the playbook's best 7
    expect(d.skipped.find((s) => s.asset === 'OIL')?.why).toMatch(/watch-only/);
    expect(d.skipped.find((s) => s.asset === 'BTC')?.why).toMatch(/history: down/);
  });

  it('takes an unknown pairing only when the story is strong, at half size, and never twice per event', () => {
    const a = freshAccount(1000);
    const weak = decide(a, pb, { ...sig, type: 'sanctions', assets: ['ETH'], confidence: 0.75, importance: 0.5 }, prices, RULES, 0);
    expect(weak.open).toHaveLength(0);
    const strong = decide(a, pb, { ...sig, type: 'sanctions', assets: ['ETH'], confidence: 0.9, importance: 0.9 }, prices, RULES, 0);
    expect(strong.open).toHaveLength(1);
    expect(strong.open[0].margin).toBe(25);
    applyOpen(a, strong.open, 1);
    expect(decide(a, pb, { ...sig, type: 'sanctions', assets: ['ETH'], confidence: 0.9, importance: 0.9 }, prices, RULES, 0).open).toHaveLength(0);
  });

  it('manages stops, targets, trailing and time', () => {
    const a = freshAccount(1000);
    const d = decide(a, pb, { ...sig, assets: ['GOLD'] }, prices, RULES, 0);
    applyOpen(a, d.open, 1);
    expect(manage(a, { PAXGUSDT: 4100 }, RULES, 1000)).toHaveLength(0); // +2.5%: nothing yet
    expect(manage(a, { PAXGUSDT: 4140 }, RULES, 2000)).toHaveLength(0); // +3.5%: trailing armed
    const trail = manage(a, { PAXGUSDT: 4010 }, RULES, 3000); // fell 3% from the peak
    expect(trail[0]?.reason).toBe('trail');
    expect(a.balance).toBeGreaterThan(1000);
    const b = freshAccount(1000);
    applyOpen(b, decide(b, pb, { ...sig, assets: ['GOLD'] }, prices, RULES, 0).open, 1);
    expect(manage(b, { PAXGUSDT: 3800 }, RULES, 10)[0]?.reason).toBe('stop');
    expect(b.balance).toBeLessThan(1000);
    const c = freshAccount(1000);
    applyOpen(c, decide(c, pb, { ...sig, assets: ['GOLD'] }, prices, RULES, 0).open, 1);
    expect(manage(c, { PAXGUSDT: 4001 }, RULES, 11 * 86_400_000)[0]?.reason).toBe('time');
  });

  it('respects the daily loss cap and the open-trade limit', () => {
    const a = freshAccount(1000);
    a.dayPnl = -31;
    expect(decide(a, pb, { ...sig, assets: ['GOLD'] }, prices, RULES, 0).skipped[0].why).toMatch(/daily loss/);
    const b = freshAccount(1000);
    b.positions = [1, 2, 3].map((id) => ({ id, asset: 'BTC' as const, symbol: 'BTCUSDT', eventId: 9, type: 'fed_cut' as const, headline: '', entry: 1, qty: 1, margin: 1, stop: 0, target: 9, peak: 1, openedAt: 0, deadline: 1e15, why: '' }));
    expect(decide(b, pb, { ...sig, assets: ['GOLD'] }, prices, RULES, 0).skipped[0].why).toMatch(/already 3 open/);
  });
});
