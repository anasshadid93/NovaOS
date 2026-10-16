import crypto from 'node:crypto';
import { config } from '../config.js';
import { kvGet, kvSet } from '../db.js';

/**
 * An assistant's inbox (an n8n webhook, config `downloadHook`): finished downloads, alerts,
 * reminders… become a chat message to the owner. Requests carry X-MM-Hook so nobody else can post
 * when the webhook is reachable from the internet.
 */
export function hookSecret(): string {
  let s = kvGet('download_hook_secret');
  if (!s) kvSet('download_hook_secret', (s = crypto.randomBytes(24).toString('base64url')));
  return s;
}

/** Best effort: false if n8n is down. */
export async function postHook(payload: Record<string, unknown>, opts: { ntfy?: boolean } = {}): Promise<boolean> {
  if (process.env.VITEST) return false;
  // The same events also go to the Android app's notifications (ntfy), whether or not n8n is up.
  if (opts.ntfy !== false) void import('../app/mobile.js').then((m) => m.publishNtfy(payload)).catch(() => false);
  if (!config.downloadHook) return false;
  try {
    const r = await fetch(config.downloadHook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-MM-Hook': hookSecret() },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    return r.ok;
  } catch {
    return false;
  }
}
