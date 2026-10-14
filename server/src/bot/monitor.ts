import crypto from 'node:crypto';
import { kvGet, kvSet } from '../db.js';
import { postHook } from './hook.js';

/**
 * Uptime Kuma and Scrutiny (store apps) → Telegram. Their webhook notification posts here on the bot API with its
 * own key (X-Monitor-Key header, or ?key= for Scrutiny, which can't set headers), which opens this one route only — not the rest of the bot API.
 */
export function monitorKey(): string {
  let k = kvGet('monitor_alert_key');
  if (!k) kvSet('monitor_alert_key', (k = crypto.randomBytes(24).toString('base64url')));
  return k;
}

export function monitorKeyOk(given: unknown): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(monitorKey());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const esc = (s: string) => s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]!);

/**
 * Uptime Kuma's webhook body: heartbeat.status 0 = down, 1 = up; no heartbeat = a test.
 * Scrutiny's webhook body has event_type (EmailTest = a test) and device_name/failure_type.
 */
export function monitorMessage(body: unknown): { severity: 'critical' | 'ok' | 'info'; kind: string; text: string } {
  const sc = (body ?? {}) as { event_type?: string; device_name?: string; failure_type?: string; message?: string };
  if (typeof sc.event_type === 'string') {
    const dev = esc(String(sc.device_name ?? '').slice(0, 60));
    const msg = esc(String(sc.message ?? '').slice(0, 300));
    if (sc.event_type === 'EmailTest') return { severity: 'info', kind: 'scrutiny:test', text: `🔔 <b>Scrutiny</b>\nتجربة تنبيه الهاردات` };
    return { severity: 'critical', kind: `scrutiny:${dev}`, text: `💽 <b>Scrutiny</b> — مشكلة بالهارد ${dev}${sc.failure_type ? ` (${esc(String(sc.failure_type).slice(0, 40))})` : ''}${msg ? `\n${msg}` : ''}` };
  }
  const b = (body ?? {}) as { heartbeat?: { status?: number; msg?: string } | null; monitor?: { name?: string } | null; msg?: string };
  const name = esc(String(b.monitor?.name ?? 'Uptime Kuma').slice(0, 80));
  const detail = esc(String(b.heartbeat?.msg ?? b.msg ?? '').slice(0, 300));
  if (!b.heartbeat) return { severity: 'info', kind: 'uptime:test', text: `🔔 <b>Uptime Kuma</b>\n${esc(String(b.msg ?? 'test').slice(0, 300))}` };
  if (b.heartbeat.status === 1) return { severity: 'ok', kind: `uptime:${name}`, text: `✅ <b>${name}</b> رجع شغّال` };
  return { severity: 'critical', kind: `uptime:${name}`, text: `🔴 <b>${name}</b> واقف${detail ? `\n${detail}` : ''}` };
}

export async function monitorAlert(body: unknown) {
  const m = monitorMessage(body);
  return { ok: await postHook({ type: 'alert', ...m }) };
}
