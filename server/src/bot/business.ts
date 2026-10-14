import { getDb, kvGet, kvSet } from '../db.js';
import { postHook } from './hook.js';
import { config } from '../config.js';
import { telegramReady } from './telegram.js';

/**
 * Telegram Business: the owner connected the bot to his account (Settings → Telegram Business →
 * Chatbots), so Telegram forwards his private chats to it. n8n's trigger passes those updates here.
 * Read-only by design: the bot keeps track of who is waiting for his reply — for the morning
 * briefing, the assistant's tools and an optional reminder — and never writes in his chats.
 * Only the owner's own connection counts; messages older than 30 days are forgotten.
 */

/** the owner's Telegram user id (the bot's owner). */
export const OWNER_ID = config.telegramOwner;
const KEEP_MS = 30 * 86_400_000;

interface TgUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
}
interface TgMessage {
  message_id: number;
  date: number;
  business_connection_id?: string;
  chat: { id: number; type: string; first_name?: string; last_name?: string; username?: string; title?: string };
  from?: TgUser;
  text?: string;
  caption?: string;
  [k: string]: unknown;
}
export interface TgUpdate {
  business_connection?: { id: string; user: TgUser; is_enabled: boolean; can_reply?: boolean; rights?: { can_reply?: boolean } };
  business_message?: TgMessage;
  edited_business_message?: TgMessage;
  deleted_business_messages?: { business_connection_id: string; chat: { id: number }; message_ids: number[] };
}

const KINDS: [string, string][] = [
  ['photo', '📷 صورة'],
  ['video', '🎬 فيديو'],
  ['voice', '🎤 رسالة صوتية'],
  ['video_note', '⏺ فيديو دائري'],
  ['audio', '🎵 صوت'],
  ['document', '📎 ملف'],
  ['sticker', '🙂 ملصق'],
  ['animation', 'GIF'],
  ['location', '📍 موقع'],
  ['contact', '👤 جهة اتصال'],
  ['poll', '📊 تصويت'],
];
/** What a message says, in one line (media as a label, plus its caption). */
export function messageText(m: TgMessage): string {
  const kind = KINDS.find(([k]) => m[k] !== undefined)?.[1];
  const body = (m.text ?? m.caption ?? '').replace(/\s+/g, ' ').trim();
  return [kind, body].filter(Boolean).join(' · ').slice(0, 1000) || '…';
}
const nameOf = (c: TgMessage['chat']) => [c.first_name, c.last_name].filter(Boolean).join(' ') || c.title || (c.username ? `@${c.username}` : String(c.id));

function connectionOk(id: string | undefined): boolean {
  if (!id) return false;
  const row = getDb().prepare('SELECT user_id, enabled FROM biz_connections WHERE id = ?').get(id) as { user_id: number; enabled: number } | undefined;
  return !!row && row.user_id === OWNER_ID && row.enabled === 1;
}

/** One update from Telegram (via n8n). Returns what it did, for the logs. */
export function handleBusinessUpdate(u: TgUpdate, now = Date.now()): { ok: boolean; did: string } {
  const db = getDb();
  if (u.business_connection) {
    const c = u.business_connection;
    // Only the owner's account: anyone else adding the bot as their chatbot is ignored.
    if (c.user.id !== OWNER_ID) return { ok: true, did: 'ignored_foreign_connection' };
    const canReply = c.rights?.can_reply ?? c.can_reply ?? false;
    db.prepare('INSERT INTO biz_connections (id, user_id, enabled, can_reply, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, can_reply = excluded.can_reply, updated_at = excluded.updated_at').run(
      c.id,
      c.user.id,
      c.is_enabled ? 1 : 0,
      canReply ? 1 : 0,
      now,
    );
    void postHook({ type: 'notice', text: c.is_enabled ? '💼 <b>Telegram Business</b> انربط البوت بحسابك. رح أتابع مين ناطر ردك، بدون ما أكتب بمحادثاتك.' : '💼 <b>Telegram Business</b> انفصل البوت عن حسابك.' });
    return { ok: true, did: c.is_enabled ? 'connected' : 'disconnected' };
  }
  if (u.deleted_business_messages) {
    const d = u.deleted_business_messages;
    if (!connectionOk(d.business_connection_id)) return { ok: true, did: 'ignored' };
    const st = db.prepare('UPDATE biz_messages SET deleted = 1 WHERE chat_id = ? AND message_id = ?');
    for (const id of d.message_ids) st.run(d.chat.id, id);
    return { ok: true, did: 'deleted' };
  }
  const m = u.business_message ?? u.edited_business_message;
  if (!m) return { ok: true, did: 'nothing' };
  if (!connectionOk(m.business_connection_id) || m.chat.type !== 'private') return { ok: true, did: 'ignored' };
  const fromMe = m.from?.id === OWNER_ID;
  const at = m.date * 1000;
  const text = messageText(m);
  db.prepare('INSERT INTO biz_messages (chat_id, message_id, from_me, text, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(chat_id, message_id) DO UPDATE SET text = excluded.text').run(m.chat.id, m.message_id, fromMe ? 1 : 0, text, at);
  if (u.edited_business_message) return { ok: true, did: 'edited' };
  const name = nameOf(m.chat);
  db.prepare('INSERT INTO biz_chats (chat_id, name, username, connection_id) VALUES (?, ?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET name = excluded.name, username = excluded.username, connection_id = excluded.connection_id').run(
    m.chat.id,
    name,
    m.chat.username ?? null,
    m.business_connection_id ?? null,
  );
  if (fromMe) db.prepare('UPDATE biz_chats SET last_out_at = ?, waiting_since = NULL, reminded_at = NULL WHERE chat_id = ?').run(at, m.chat.id);
  else db.prepare('UPDATE biz_chats SET last_in_at = ?, last_in_text = ?, waiting_since = COALESCE(waiting_since, ?) WHERE chat_id = ?').run(at, text, at, m.chat.id);
  db.prepare('DELETE FROM biz_messages WHERE at < ?').run(now - KEEP_MS);
  return { ok: true, did: fromMe ? 'mine' : 'incoming' };
}

export interface Waiting {
  chat_id: number;
  name: string;
  username: string | null;
  waitingMin: number;
  lastText: string;
  messages: number;
}
/** Chats where the other person wrote last and the owner hasn't answered (muted ones left out). */
export function unanswered(minMinutes = 0, now = Date.now()): Waiting[] {
  const db = getDb();
  const rows = db.prepare('SELECT chat_id, name, username, waiting_since, last_in_text FROM biz_chats WHERE waiting_since IS NOT NULL AND muted = 0 ORDER BY waiting_since').all() as {
    chat_id: number;
    name: string;
    username: string | null;
    waiting_since: number;
    last_in_text: string;
  }[];
  return rows
    .map((r) => ({
      chat_id: r.chat_id,
      name: r.name,
      username: r.username,
      waitingMin: Math.round((now - r.waiting_since) / 60_000),
      lastText: r.last_in_text,
      messages: (db.prepare('SELECT COUNT(*) AS n FROM biz_messages WHERE chat_id = ? AND from_me = 0 AND deleted = 0 AND at >= ?').get(r.chat_id, r.waiting_since) as { n: number }).n,
    }))
    .filter((w) => w.waitingMin >= minMinutes);
}

/** Finds a chat by (part of) a name or @username. */
export function findChat(q: string): { chat_id: number; name: string; muted: number } | undefined {
  const s = q.trim().replace(/^@/, '').toLowerCase();
  if (!s) return undefined;
  const rows = getDb().prepare('SELECT chat_id, name, username, muted FROM biz_chats').all() as { chat_id: number; name: string; username: string | null; muted: number }[];
  return rows.find((r) => r.name.toLowerCase() === s || r.username?.toLowerCase() === s) ?? rows.find((r) => r.name.toLowerCase().includes(s) || r.username?.toLowerCase().includes(s));
}

/** The latest messages of one chat (for the assistant: "what did X say?", or to draft a reply). */
export function chatHistory(q: string, limit = 20) {
  const c = findChat(q);
  if (!c) return null;
  const msgs = getDb().prepare('SELECT from_me, text, at, deleted FROM biz_messages WHERE chat_id = ? ORDER BY at DESC LIMIT ?').all(c.chat_id, Math.min(50, Math.max(1, limit))) as { from_me: number; text: string; at: number; deleted: number }[];
  return { name: c.name, muted: !!c.muted, messages: msgs.reverse().map((m) => ({ who: m.from_me ? 'the owner' : c.name, text: m.deleted ? `(deleted) ${m.text}` : m.text, at: new Date(m.at).toISOString() })) };
}

export function setMuted(q: string, muted: boolean) {
  const c = findChat(q);
  if (!c) return null;
  getDb().prepare('UPDATE biz_chats SET muted = ? WHERE chat_id = ?').run(muted ? 1 : 0, c.chat_id);
  return { name: c.name, muted };
}

export function businessStatus() {
  const db = getDb();
  const conn = db.prepare('SELECT enabled, can_reply, updated_at FROM biz_connections WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1').get(OWNER_ID) as { enabled: number; can_reply: number; updated_at: number } | undefined;
  const chats = (db.prepare('SELECT COUNT(*) AS n FROM biz_chats').get() as { n: number }).n;
  return { connected: !!conn?.enabled, since: conn?.updated_at ?? null, chats, remindAfterHours: remindHours(), waiting: unanswered().length };
}

// ---- reminder ---------------------------------------------------------------------------------
/** Hours a chat may wait before one Telegram nudge (0 = off, the default — he didn't want more noise). */
export const remindHours = () => Number(kvGet('biz_remind_hours') ?? 0);
export const setRemindHours = (h: number) => kvSet('biz_remind_hours', String(Math.max(0, Math.min(72, Math.round(h)))));

/** One nudge per waiting chat, between 09:00 and 21:00 Dubai time. */
export function remindTick(now = Date.now()) {
  const h = remindHours();
  if (!h) return 0;
  const hour = new Date(now + 4 * 3600_000).getUTCHours();
  if (hour < 9 || hour >= 21) return 0;
  const due = unanswered(h * 60, now).filter((w) => {
    const r = getDb().prepare('SELECT reminded_at FROM biz_chats WHERE chat_id = ?').get(w.chat_id) as { reminded_at: number | null };
    return !r.reminded_at;
  });
  for (const w of due) getDb().prepare('UPDATE biz_chats SET reminded_at = ? WHERE chat_id = ?').run(now, w.chat_id);
  if (due.length) {
    const esc = (s: string) => s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]!);
    const wait = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} س` : `${m} د`);
    void postHook({ type: 'notice', text: `💬 <b>ناطرين ردك</b>\n${due.map((w) => `• <b>${esc(w.name)}</b> (${wait(w.waitingMin)}): ${esc(w.lastText.slice(0, 80))}`).join('\n')}` });
  }
  return due.length;
}

export function startBusinessReminders(): () => void {
  if (process.env.VITEST || !OWNER_ID || !telegramReady()) return () => {};
  const t = setInterval(() => remindTick(), 10 * 60_000);
  return () => clearInterval(t);
}
