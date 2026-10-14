import { getDb, kvGet, kvSet } from '../db.js';
import { postHook } from './hook.js';
import { marketPrices, prayerTimes, type Prices } from './market.js';
import { config, tzOffset } from '../config.js';

/**
 * the owner's personal helpers, driven from Telegram: reminders (one-off or repeating), notes and
 * tasks, price alerts (gold, crypto, currencies) and optional prayer-time reminders. A loop here
 * fires them through the assistant's inbox (Telegram).
 */

const TZ_OFFSET = () => tzOffset();
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
type Body = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : v === undefined || v === null ? '' : String(v).trim());
const num = (v: unknown) => (v === '' || v === undefined || v === null ? NaN : Number(v));

/** "2026-10-12 09:00", "2026-10-12T09:00", or a full ISO time → epoch ms (local times are Dubai). */
export function parseWhen(s: string, now = Date.now()): number {
  const t = s.trim().replace(' ', 'T');
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(t) ? t : `${t.length === 16 ? `${t}:00` : t}${TZ_OFFSET()}`;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new Error('bad_time: use YYYY-MM-DD HH:mm (Dubai time)');
  if (ms < now - 60_000) throw new Error('time_in_the_past');
  if (ms > now + 2 * 365 * 86400_000) throw new Error('too_far');
  return ms;
}
const fmt = (ms: number) => new Date(ms).toLocaleString('en-GB', { timeZone: config.timezone, weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

// ---- reminders ---------------------------------------------------------------------------------
const REPEATS = ['none', 'daily', 'weekly', 'monthly'] as const;
type Repeat = (typeof REPEATS)[number];
interface Reminder {
  id: number;
  text: string;
  due_at: number;
  repeat: Repeat;
}

export function reminders(b: Body) {
  const db = getDb();
  const action = str(b.action) || 'list';
  if (action === 'add') {
    const text = str(b.text).slice(0, 500);
    if (!text) throw new Error('text_required');
    const due = parseWhen(str(b.when));
    const repeat = (REPEATS as readonly string[]).includes(str(b.repeat)) ? (str(b.repeat) as Repeat) : 'none';
    const r = db.prepare("INSERT INTO reminders(text, due_at, repeat, status, created_at) VALUES(?, ?, ?, 'pending', ?)").run(text, due, repeat, Date.now());
    return { ok: true, id: Number(r.lastInsertRowid), at: fmt(due), repeat };
  }
  if (action === 'cancel') {
    const changes = db.prepare("UPDATE reminders SET status = 'cancelled' WHERE id = ? AND status = 'pending'").run(num(b.id)).changes;
    return { ok: changes > 0 };
  }
  const list = db.prepare("SELECT id, text, due_at, repeat FROM reminders WHERE status = 'pending' ORDER BY due_at LIMIT 30").all() as unknown as Reminder[];
  return { reminders: list.map((r) => ({ id: r.id, text: r.text, at: fmt(r.due_at), repeat: r.repeat })) };
}

function nextDue(ms: number, repeat: Repeat): number {
  const d = new Date(ms);
  if (repeat === 'daily') return ms + 86400_000;
  if (repeat === 'weekly') return ms + 7 * 86400_000;
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.getTime();
}

async function fireReminders(now = Date.now()) {
  const db = getDb();
  const due = db.prepare("SELECT id, text, due_at, repeat FROM reminders WHERE status = 'pending' AND due_at <= ?").all(now) as unknown as Reminder[];
  for (const r of due) {
    // Mark first: a slow Telegram never makes it fire twice.
    if (r.repeat === 'none') db.prepare("UPDATE reminders SET status = 'done' WHERE id = ?").run(r.id);
    else {
      let n = nextDue(r.due_at, r.repeat);
      while (n <= now) n = nextDue(n, r.repeat);
      db.prepare('UPDATE reminders SET due_at = ? WHERE id = ?').run(n, r.id);
    }
    await postHook({ type: 'notice', text: `⏰ <b>تذكير</b>\n${esc(r.text)}` });
  }
}

// ---- notes & tasks ------------------------------------------------------------------------------
export function notes(b: Body) {
  const db = getDb();
  const action = str(b.action) || 'list';
  const kind = str(b.kind) === 'note' ? 'note' : 'task';
  if (action === 'add') {
    const text = str(b.text).slice(0, 2000);
    if (!text) throw new Error('text_required');
    const r = db.prepare('INSERT INTO notes_bot(kind, text, done, created_at) VALUES(?, ?, 0, ?)').run(kind, text, Date.now());
    return { ok: true, id: Number(r.lastInsertRowid), kind };
  }
  if (action === 'done') return { ok: db.prepare('UPDATE notes_bot SET done = 1, done_at = ? WHERE id = ?').run(Date.now(), num(b.id)).changes > 0 };
  if (action === 'delete') return { ok: db.prepare('DELETE FROM notes_bot WHERE id = ?').run(num(b.id)).changes > 0 };
  const showDone = b.include_done === true || str(b.include_done) === 'true';
  const rows = db
    .prepare(`SELECT id, kind, text, done, created_at FROM notes_bot WHERE (? = '' OR kind = ?) ${showDone ? '' : 'AND done = 0'} ORDER BY done, created_at DESC LIMIT 50`)
    .all(str(b.kind), str(b.kind)) as { id: number; kind: string; text: string; done: number; created_at: number }[];
  return { items: rows.map((r) => ({ id: r.id, kind: r.kind, text: r.text, done: !!r.done, created: fmt(r.created_at) })) };
}

// ---- price alerts -------------------------------------------------------------------------------
const ASSETS: Record<string, { ar: string; get: (p: Prices) => number; unit: string }> = {
  gold24: { ar: 'ذهب عيار 24 (غرام)', get: (p) => p.gold.aedPerGram24k, unit: 'درهم' },
  gold21: { ar: 'ذهب عيار 21 (غرام)', get: (p) => p.gold.aedPerGram21k, unit: 'درهم' },
  gold_oz: { ar: 'أونصة الذهب', get: (p) => p.gold.usdPerOunce, unit: '$' },
  btc: { ar: 'بيتكوين', get: (p) => p.crypto.btcUsd, unit: '$' },
  eth: { ar: 'إيثيريوم', get: (p) => p.crypto.ethUsd, unit: '$' },
  usd_aed: { ar: 'الدولار بالدرهم', get: (p) => p.fx.usdAed, unit: 'درهم' },
  jod_aed: { ar: 'الدينار بالدرهم', get: (p) => p.fx.jodAed, unit: 'درهم' },
  usd_jod: { ar: 'الدولار بالدينار', get: (p) => p.fx.usdJod, unit: 'دينار' },
};

export async function priceAlerts(b: Body) {
  const db = getDb();
  const action = str(b.action) || 'list';
  if (action === 'add') {
    const asset = str(b.asset);
    const op = str(b.op) === 'below' ? 'below' : 'above';
    const value = num(b.value);
    if (!ASSETS[asset]) throw new Error(`asset must be one of: ${Object.keys(ASSETS).join(', ')}`);
    if (!Number.isFinite(value) || value <= 0) throw new Error('bad_value');
    const now = ASSETS[asset].get(await marketPrices());
    const r = db.prepare("INSERT INTO price_alerts(asset, op, value, status, created_at) VALUES(?, ?, ?, 'active', ?)").run(asset, op, value, Date.now());
    return { ok: true, id: Number(r.lastInsertRowid), asset, op, value, current: now };
  }
  if (action === 'cancel') return { ok: db.prepare("UPDATE price_alerts SET status = 'cancelled' WHERE id = ? AND status = 'active'").run(num(b.id)).changes > 0 };
  const rows = db.prepare("SELECT id, asset, op, value FROM price_alerts WHERE status = 'active' ORDER BY id").all() as { id: number; asset: string; op: string; value: number }[];
  return { alerts: rows, assets: Object.keys(ASSETS) };
}

async function checkPrices() {
  const db = getDb();
  const rows = db.prepare("SELECT id, asset, op, value FROM price_alerts WHERE status = 'active'").all() as { id: number; asset: string; op: string; value: number }[];
  if (!rows.length) return;
  const p = await marketPrices();
  for (const r of rows) {
    const a = ASSETS[r.asset];
    if (!a) continue;
    const v = a.get(p);
    if (r.op === 'above' ? v >= r.value : v <= r.value) {
      db.prepare("UPDATE price_alerts SET status = 'fired', fired_at = ? WHERE id = ?").run(Date.now(), r.id);
      await postHook({ type: 'notice', text: `💰 <b>تنبيه سعر</b>\n${a.ar} صار <b>${v.toLocaleString('en-US')} ${a.unit}</b> (${r.op === 'above' ? 'فوق' : 'تحت'} ${r.value.toLocaleString('en-US')} اللي حددته).` });
    }
  }
}

// ---- prayer reminders ---------------------------------------------------------------------------
const PRAYERS: [key: 'fajr' | 'dhuhr' | 'asr' | 'maghrib' | 'isha', ar: string][] = [
  ['fajr', 'الفجر'],
  ['dhuhr', 'الظهر'],
  ['asr', 'العصر'],
  ['maghrib', 'المغرب'],
  ['isha', 'العشاء'],
];
export function prayerReminders(b: Body) {
  if (b.on !== undefined) kvSet('prayer_reminders', b.on === true || str(b.on) === 'true' ? '1' : '0');
  return { on: kvGet('prayer_reminders') === '1' };
}

async function checkPrayer(now = new Date()) {
  if (kvGet('prayer_reminders') !== '1') return;
  const p = (await prayerTimes(now)) as { date: string; times: Record<string, string> };
  const hm = now.toLocaleTimeString('en-GB', { timeZone: config.timezone, hour: '2-digit', minute: '2-digit' });
  for (const [key, ar] of PRAYERS) {
    const sentKey = `prayer_sent:${p.date}:${key}`;
    // Within the first 5 minutes of the prayer time, once.
    const [h, m] = p.times[key].split(':').map(Number);
    const [nh, nm] = hm.split(':').map(Number);
    const diff = nh * 60 + nm - (h * 60 + m);
    if (diff >= 0 && diff < 5 && !kvGet(sentKey)) {
      kvSet(sentKey, '1');
      await postHook({ type: 'notice', text: `🕌 حان وقت صلاة <b>${ar}</b> (${p.times[key]})` });
    }
  }
}

// ---- loop ---------------------------------------------------------------------------------------
export function startPersonalLoop() {
  let ticks = 0;
  const tick = async () => {
    ticks++;
    await fireReminders().catch(() => undefined);
    await checkPrayer().catch(() => undefined);
    if (ticks % 20 === 1) await checkPrices().catch(() => undefined); // every 10 minutes
  };
  const t = setInterval(() => void tick(), 30_000);
  t.unref();
  setTimeout(() => void tick(), 5_000).unref();
  return () => clearInterval(t);
}

export const _test = { fireReminders, nextDue };
