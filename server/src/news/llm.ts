import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { kvGet, kvSet } from '../db.js';
import { ASSETS, EVENT_TYPES, type Asset, type EventType } from './playbook.js';

/**
 * The reading part of the News Trader: a Claude model turns a batch of headlines into structured
 * events (type, affected assets, direction, confidence, horizon). It never decides trades: the
 * rules in trader.ts do, using the playbook. The key lives in var/news-trader.json (0600).
 */
export interface LlmSettings {
  anthropicKey?: string;
  model?: string;
  /** Trading rules and the assets to trade, as saved from the Settings tab (partial: defaults fill the rest). */
  rules?: Record<string, unknown>;
}
export interface Assessment {
  i: number;
  event: EventType;
  assets: Asset[];
  direction: 'up' | 'down' | 'mixed';
  confidence: number;
  horizonDays: number;
  why: string;
  importance: number; // 0-1, how market-moving the story is on its own
}

const FILE = () => path.join(config.dataDir, 'news-trader.json');
export const DEFAULT_MODEL = 'claude-haiku-5-5';
const FALLBACK_MODELS = ['claude-haiku-4-5'];

export function llmSettings(): LlmSettings {
  try {
    return JSON.parse(fs.readFileSync(FILE(), 'utf8')) as LlmSettings;
  } catch {
    return {};
  }
}
export function saveLlmSettings(patch: LlmSettings) {
  const next = { ...llmSettings(), ...patch };
  for (const k of Object.keys(next) as (keyof LlmSettings)[]) if (next[k] === '' || next[k] === undefined) delete next[k];
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(FILE(), JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
}
export const llmReady = () => !!llmSettings().anthropicKey;

/** Rough spend guard: counts calls and tokens per day (kv), so a feed storm can't run up a bill. */
export function llmUsage(): { date: string; calls: number; inTokens: number; outTokens: number } {
  const date = new Date().toISOString().slice(0, 10);
  try {
    const u = JSON.parse(kvGet('news.llm.usage') ?? '{}') as { date?: string; calls?: number; inTokens?: number; outTokens?: number };
    if (u.date === date) return { date, calls: u.calls ?? 0, inTokens: u.inTokens ?? 0, outTokens: u.outTokens ?? 0 };
  } catch {
    /* fresh day */
  }
  return { date, calls: 0, inTokens: 0, outTokens: 0 };
}
const MAX_CALLS_PER_DAY = 400;

const SYSTEM = `You are a markets analyst reading news headlines for a paper-trading bot. For each headline decide whether it describes a market-moving event and which assets it affects.
Event types: ${EVENT_TYPES.join(', ')}. Use "none" for everything that is not a clear, fresh, market-moving event (opinions, explainers, old news, minor updates, price-recap articles).
Assets: ${ASSETS.join(', ')} (GOLD = spot gold / PAXG, OIL = crude, SILVER = spot silver, SPX = US stocks, DXY = US dollar).
Rules: wars, attacks, escalations and sanctions tend to lift GOLD and OIL and hit SPX/crypto short-term; ceasefires the reverse. Fed cuts, cooling inflation and liquidity lift BTC/ETH/SPX and GOLD, weaken DXY; hikes and hot inflation the reverse. OPEC cuts lift OIL; supply increases cut it. Hacks, exchange failures and crackdowns hit crypto; ETF approvals and adoption lift it. Be strict: most headlines are "none". Confidence is how sure you are the event is real and will move the asset in that direction over the horizon. Importance is how big the event is on its own (0.9+ = war starts / Fed surprise / exchange collapse).
Answer with JSON only: an array of {"i": index, "event": type, "assets": [...], "direction": "up"|"down"|"mixed", "confidence": 0-1, "horizonDays": 1-30, "importance": 0-1, "why": "<= 20 words"} covering only headlines that are not "none".`;

async function callClaude(key: string, model: string, text: string): Promise<{ text: string; inTokens: number; outTokens: number }> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 2000, temperature: 0, system: SYSTEM, messages: [{ role: 'user', content: text }] }),
    signal: AbortSignal.timeout(60_000),
  });
  const j = (await res.json().catch(() => ({}))) as { content?: { type: string; text?: string }[]; usage?: { input_tokens: number; output_tokens: number }; error?: { type: string; message: string } };
  if (!res.ok) throw Object.assign(new Error(`${res.status} ${j.error?.type ?? ''}: ${j.error?.message ?? 'Claude call failed'}`), { status: res.status });
  return { text: j.content?.map((c) => c.text ?? '').join('') ?? '', inTokens: j.usage?.input_tokens ?? 0, outTokens: j.usage?.output_tokens ?? 0 };
}

/** Headlines → assessments (only the market-moving ones come back). */
export async function assessHeadlines(titles: string[]): Promise<Assessment[]> {
  const s = llmSettings();
  if (!s.anthropicKey) throw new Error('no_api_key');
  const usage = llmUsage();
  if (usage.calls >= MAX_CALLS_PER_DAY) throw new Error('daily_call_limit');
  const text = `Today is ${new Date().toISOString().slice(0, 10)}. Headlines:\n${titles.map((t, i) => `${i}. ${t}`).join('\n')}`;
  const models = [s.model || DEFAULT_MODEL, ...FALLBACK_MODELS.filter((m) => m !== (s.model || DEFAULT_MODEL))];
  let last: Error | null = null;
  for (const model of models) {
    try {
      const r = await callClaude(s.anthropicKey, model, text);
      kvSet('news.llm.usage', JSON.stringify({ date: usage.date, calls: usage.calls + 1, inTokens: usage.inTokens + r.inTokens, outTokens: usage.outTokens + r.outTokens, model }));
      return parseAssessments(r.text, titles.length);
    } catch (e) {
      last = e as Error;
      // A model that does not exist for this key: try the next one; anything else is final.
      if ((e as { status?: number }).status === 404 || /not_found|model/i.test(last.message)) continue;
      throw e;
    }
  }
  throw last ?? new Error('llm_failed');
}

export function parseAssessments(text: string, n: number): Assessment[] {
  const m = /\[[\s\S]*\]/.exec(text);
  if (!m) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(m[0]);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: Assessment[] = [];
  for (const x of arr as Record<string, unknown>[]) {
    const i = Number(x.i);
    const event = String(x.event ?? 'none');
    if (!Number.isInteger(i) || i < 0 || i >= n || event === 'none' || !(EVENT_TYPES as readonly string[]).includes(event)) continue;
    const assets = (Array.isArray(x.assets) ? x.assets : []).map(String).filter((a): a is Asset => (ASSETS as readonly string[]).includes(a));
    if (!assets.length) continue;
    const direction = x.direction === 'up' || x.direction === 'down' ? x.direction : 'mixed';
    out.push({
      i,
      event: event as EventType,
      assets,
      direction,
      confidence: Math.max(0, Math.min(1, Number(x.confidence) || 0)),
      horizonDays: Math.max(1, Math.min(30, Math.round(Number(x.horizonDays) || 5))),
      importance: Math.max(0, Math.min(1, Number(x.importance) || 0)),
      why: String(x.why ?? '').slice(0, 160),
    });
  }
  return out;
}
