import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'manar-biz-'));
process.env.MANAR_DATA_DIR = path.join(tmp, 'var');
process.env.MANAR_DEV = '1';

const { chatHistory, handleBusinessUpdate, messageText, OWNER_ID, remindTick, setMuted, setRemindHours, unanswered } = await import('./business.js');

const T = Date.UTC(2026, 9, 13, 8, 0); // 12:00 in Dubai
const msg = (id: number, from: number, text: string, at: number, extra: Record<string, unknown> = {}) => ({
  business_message: { message_id: id, date: Math.floor(at / 1000), business_connection_id: 'c1', chat: { id: 555, type: 'private', first_name: 'Ahmad', last_name: 'Site' }, from: { id: from }, text, ...extra },
});

describe('Telegram Business (read-only)', () => {
  it('only listens to the owner’s own connection', () => {
    expect(handleBusinessUpdate(msg(1, 555, 'hi', T)).did).toBe('ignored'); // not connected yet
    expect(handleBusinessUpdate({ business_connection: { id: 'x9', user: { id: 42 }, is_enabled: true } }).did).toBe('ignored_foreign_connection');
    expect(handleBusinessUpdate({ business_connection: { id: 'c1', user: { id: OWNER_ID }, is_enabled: true, rights: { can_reply: false } } }).did).toBe('connected');
  });

  it('tracks who waits for a reply, and clears it when the owner answers', () => {
    handleBusinessUpdate(msg(2, 555, 'متى نصب الصبة؟', T));
    handleBusinessUpdate(msg(3, 555, '', T + 60_000, { text: undefined, photo: [{}], caption: 'الموقع' }));
    let w = unanswered(0, T + 3 * 3600_000);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ name: 'Ahmad Site', waitingMin: 180, messages: 2, lastText: '📷 صورة · الموقع' });
    expect(unanswered(240, T + 3 * 3600_000)).toHaveLength(0);
    handleBusinessUpdate(msg(4, OWNER_ID, 'بكرا الصبح', T + 4 * 3600_000));
    w = unanswered(0, T + 5 * 3600_000);
    expect(w).toHaveLength(0);
    expect(chatHistory('ahmad')!.messages.map((m) => m.who)).toEqual(['Ahmad Site', 'Ahmad Site', 'the owner']);
  });

  it('skips groups, mutes a chat, and labels media', () => {
    expect(handleBusinessUpdate({ business_message: { message_id: 9, date: T / 1000, business_connection_id: 'c1', chat: { id: -100, type: 'group', title: 'g' }, from: { id: 7 }, text: 'x' } }).did).toBe('ignored');
    handleBusinessUpdate(msg(5, 555, 'وينك؟', T + 6 * 3600_000));
    expect(setMuted('Ahmad', true)).toMatchObject({ muted: true });
    expect(unanswered(0, T + 7 * 3600_000)).toHaveLength(0);
    setMuted('Ahmad', false);
    expect(messageText({ message_id: 1, date: 0, chat: { id: 1, type: 'private' }, voice: {} })).toBe('🎤 رسالة صوتية');
  });

  it('reminds once per waiting chat, only when turned on and in the day', () => {
    expect(remindTick(T + 10 * 3600_000)).toBe(0); // off by default
    setRemindHours(2);
    expect(remindTick(T + 10 * 3600_000)).toBe(0); // 22:00 Dubai: quiet
    expect(remindTick(T + 8 * 3600_000)).toBe(1); // 20:00 Dubai, waiting 2 h
    expect(remindTick(T + 8.5 * 3600_000)).toBe(0); // already reminded
  });
});
