import { config } from '../config.js';
import { postHook } from '../bot/hook.js';
import { publishNtfy } from '../app/mobile.js';

/**
 * One notification per trading event, on one channel. Trading bots used to call every channel at
 * once (web push + Telegram via n8n + the Android app), so a single closed trade rang three times.
 * `tradingNotify` in manar.json picks the channel: 'app' (default, the NovaOS Android app),
 * 'telegram', 'all', or 'none'.
 */
export function tradingNotice(text: string): void {
  if (process.env.VITEST) return;
  const mode = config.tradingNotify;
  if (mode === 'none') return;
  if (mode === 'app' || mode === 'all') void publishNtfy({ type: 'notice', text }).catch(() => false);
  if (mode === 'telegram' || mode === 'all') void postHook({ type: 'notice', text }, { ntfy: false }).catch(() => false);
}
