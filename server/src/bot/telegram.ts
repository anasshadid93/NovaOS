import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

/**
 * Direct Telegram Bot API calls, for replies n8n's Telegram node can't make (a variable number of
 * buttons, editing a message in place). The bot token lives in var/telegram-bot.json
 * ({"token": "...", "owner": <chat id>}, 0600, never logged); without it this is off.
 */
interface Cfg {
  token: string;
  baseUrl?: string;
  owner?: number;
}
let cached: Cfg | null | undefined;
function cfg(): Cfg | null {
  if (cached !== undefined) return cached;
  try {
    const c = JSON.parse(fs.readFileSync(path.join(config.dataDir, 'telegram-bot.json'), 'utf8')) as Cfg;
    cached = c.token ? c : null;
  } catch {
    cached = null;
  }
  return cached;
}
export const telegramReady = () => !!cfg();

export async function tg<T = unknown>(method: string, body: Record<string, unknown>): Promise<T> {
  if (process.env.VITEST) throw new Error('telegram_disabled_in_tests');
  const c = cfg();
  if (!c) throw new Error('telegram_token_missing');
  const r = await fetch(`${(c.baseUrl ?? 'https://api.telegram.org').replace(/\/$/, '')}/bot${c.token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const j = (await r.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
  // Editing a message to the same content is not an error worth failing on.
  if (!j.ok && !/message is not modified/i.test(j.description ?? '')) throw new Error(`telegram_${method}: ${(j.description ?? r.status).toString().slice(0, 120)}`);
  return j.result as T;
}

export interface Button {
  text: string;
  data: string;
}
/** Buttons as rows (up to `perRow` per row). */
export const keyboard = (rows: Button[][]) => ({ inline_keyboard: rows.filter((r) => r.length).map((r) => r.map((b) => ({ text: b.text, callback_data: b.data }))) });
