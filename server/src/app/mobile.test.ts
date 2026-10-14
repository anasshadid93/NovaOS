import { describe, expect, it } from 'vitest';
import { toNotification } from './mobile.js';

describe('Android app notifications (ntfy)', () => {
  it('alerts: severity → title and priority, HTML stripped', () => {
    const n = toNotification({ type: 'alert', severity: 'critical', kind: 'backup_failed', text: '💾 النسخة <b>فشلت</b>\n<code>x &amp; y</code>' })!;
    expect(n.title).toBe('Needs attention');
    expect(n.priority).toBe(5);
    expect(n.message).toBe('💾 النسخة فشلت\nx & y');
    expect(toNotification({ type: 'alert', severity: 'ok', text: 'ok' })!.priority).toBe(2);
  });
  it('notices and finished downloads become notifications; Telegram conversations do not', () => {
    expect(toNotification({ type: 'notice', text: '📶 جهاز جديد' })!.message).toBe('📶 جهاز جديد');
    expect(toNotification({ type: 'download', status: 'done', title: 'Song', filesUrl: 'https://x/files' })).toMatchObject({ title: 'Download finished', message: 'Song', click: 'https://x/files' });
    expect(toNotification({ type: 'download', status: 'running' })).toBeNull();
    expect(toNotification({ type: 'confirm', text: 'Delete?' })).toBeNull();
    expect(toNotification({ type: 'notice', text: '' })).toBeNull();
  });
});
