import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import webpush from 'web-push';
import { config } from '../config.js';
import { getDb, kvGet, kvSet } from '../db.js';
import { diskHealthAlerts } from '../smart/health.js';
import { hub } from '../metrics/hub.js';
import { mounts } from '../system/info.js';
import { docker } from '../docker/client.js';
import { postHook } from '../bot/hook.js';
import { systemStatus } from '../system/updates.js';

const execFileP = promisify(execFile);

/**
 * Alerts: failed systemd units (incl. backups), nearly-full disks, overheating.
 * New alerts are pushed via Web Push and, if configured, a WhatsApp message sent
 * through Nova (`openclaw message send`). Checked once a minute.
 */

export interface Alert {
  key: string;
  kind: 'unit_failed' | 'backup_failed' | 'disk_full' | 'hot' | 'disk_health' | 'mem_full' | 'container' | 'security';
  severity: 'warning' | 'critical';
  title: string;
  detail: string;
  since: number;
  /** Arabic text for the Telegram assistant (the owner reads it there). */
  ar?: string;
  /** Kinds that also announce when they clear ("back to normal"). */
  clears?: boolean;
}

export interface NotifySettings {
  push: boolean;
  whatsapp: { enabled: boolean; to: string };
  diskThreshold: number;
}

const DEFAULTS: NotifySettings = { push: true, whatsapp: { enabled: false, to: '' }, diskThreshold: 90 };

export function getSettings(): NotifySettings {
  try {
    return { ...DEFAULTS, ...(JSON.parse(kvGet('notify.settings') ?? '{}') as Partial<NotifySettings>) };
  } catch {
    return DEFAULTS;
  }
}

export function saveSettings(s: NotifySettings) {
  kvSet('notify.settings', JSON.stringify(s));
}

// ---- Web Push --------------------------------------------------------------

export function vapid(): { publicKey: string; privateKey: string } {
  const saved = kvGet('vapid');
  if (saved) return JSON.parse(saved) as { publicKey: string; privateKey: string };
  const keys = webpush.generateVAPIDKeys();
  kvSet('vapid', JSON.stringify(keys));
  return keys;
}

interface PushSub {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export function savePushSubscription(sub: PushSub, userAgent?: string) {
  const subs = pushSubs().filter((s) => s.endpoint !== sub.endpoint);
  subs.push({ endpoint: sub.endpoint, keys: sub.keys, ua: userAgent?.slice(0, 120) });
  kvSet('push.subs', JSON.stringify(subs.slice(-20)));
}

export function removePushSubscription(endpoint: string) {
  kvSet('push.subs', JSON.stringify(pushSubs().filter((s) => s.endpoint !== endpoint)));
}

function pushSubs(): (PushSub & { ua?: string })[] {
  try {
    return JSON.parse(kvGet('push.subs') ?? '[]');
  } catch {
    return [];
  }
}

export async function sendPush(title: string, body: string, url = '/') {
  const { publicKey, privateKey } = vapid();
  webpush.setVapidDetails(`https://${config.tailscaleHost}`, publicKey, privateKey);
  const payload = JSON.stringify({ title, body, url });
  const dead: string[] = [];
  await Promise.all(
    pushSubs().map(async (s) => {
      try {
        await webpush.sendNotification(s, payload, { TTL: 3600 });
      } catch (err) {
        const code = (err as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) dead.push(s.endpoint);
      }
    }),
  );
  for (const d of dead) removePushSubscription(d);
}

// ---- WhatsApp via Nova -------------------------------------------------------

export async function sendWhatsApp(to: string, text: string) {
  if (!/^\+[1-9]\d{6,14}$/.test(to)) throw new Error('bad_number');
  await execFileP('openclaw', ['message', 'send', '--channel', 'whatsapp', '--target', to, '--message', text], { timeout: 60_000 });
}

export async function notify(title: string, body: string, url = '/') {
  const s = getSettings();
  const jobs: Promise<unknown>[] = [];
  if (s.push) jobs.push(sendPush(title, body, url));
  if (s.whatsapp.enabled && s.whatsapp.to) jobs.push(sendWhatsApp(s.whatsapp.to, `MinisManager · ${title}\n${body}`));
  const results = await Promise.allSettled(jobs);
  getDb()
    .prepare('INSERT INTO audit(ts, user_id, action, detail) VALUES(?, NULL, ?, ?)')
    .run(Date.now(), 'notify', JSON.stringify({ title, failed: results.filter((r) => r.status === 'rejected').length }));
}

// ---- Alert checks ------------------------------------------------------------

async function failedUnits(user: boolean): Promise<string[]> {
  try {
    const args = [...(user ? ['--user'] : []), 'list-units', '--failed', '--all', '-o', 'json'];
    const { stdout } = await execFileP('systemctl', args, { timeout: 10_000 });
    return (JSON.parse(stdout) as { unit: string }[])
      .map((u) => u.unit)
      // Ignore transient one-off units from `systemd-run` (run-u123.service, run-r1a2b.scope).
      .filter((u) => !/^run-[a-z]?[0-9a-f]+\.(service|scope)$/.test(u) && !/^manar-term-[0-9]+\.service$/.test(u));
  } catch {
    return [];
  }
}

let current: Alert[] = [];

export function currentAlerts(): Alert[] {
  return current;
}

// Sustained conditions only: one hot second or a short RAM spike is not worth a message.
let hotRuns = 0;
let memRuns = 0;
let updatesCache: { at: number; security: number; names: string[] } | null = null;

/** Exit codes of a deliberate stop (docker stop / Ctrl+C): not a crash. */
const CLEAN_EXIT = new Set([0, 130, 143]);

async function containerAlerts(): Promise<Omit<Alert, 'since'>[]> {
  if (!docker.socketExists()) return [];
  const out: Omit<Alert, 'since'>[] = [];
  for (const c of await docker.list().catch(() => [])) {
    const name = c.Names[0]?.replace(/^\//, '') ?? c.Id.slice(0, 12);
    const code = Number(/Exited \((-?\d+)\)/.exec(c.Status)?.[1] ?? NaN);
    // Only fresh problems: an app that crashed weeks ago is not news.
    const recent = !/(weeks?|months?|years?) ago/.test(c.Status);
    if (c.State === 'restarting')
      out.push({ key: `ctr:${name}:restarting`, kind: 'container', severity: 'critical', title: `Container restarting: ${name}`, detail: c.Status, ar: `🔁 الـ container <b>${name}</b> عم يعيد تشغيل حاله بشكل متكرر (عم يوقع).`, clears: true });
    else if (c.State === 'exited' && recent && Number.isFinite(code) && !CLEAN_EXIT.has(code))
      out.push({ key: `ctr:${name}:exited`, kind: 'container', severity: 'critical', title: `Container crashed: ${name}`, detail: c.Status, ar: `🛑 الـ container <b>${name}</b> وقف لحاله (كود ${code}${code === 137 ? '، غالبًا خلصت الذاكرة' : ''}).`, clears: true });
    else if (/\(unhealthy\)/.test(c.Status))
      out.push({ key: `ctr:${name}:unhealthy`, kind: 'container', severity: 'warning', title: `Container unhealthy: ${name}`, detail: c.Status, ar: `🩺 الـ container <b>${name}</b> شغّال بس فحصه الصحي فاشل (unhealthy).`, clears: true });
  }
  return out;
}

async function securityAlert(): Promise<Omit<Alert, 'since'> | null> {
  if (!updatesCache || Date.now() - updatesCache.at > 6 * 3600_000) {
    const st = await systemStatus().catch(() => null);
    if (st) updatesCache = { at: Date.now(), security: st.security, names: st.updates.filter((u) => u.security).map((u) => u.name) };
  }
  if (!updatesCache?.security) return null;
  const names = updatesCache.names.slice(0, 5).join(', ');
  // The key carries the package list, so a new security update is a new message.
  return { key: `security:${updatesCache.names.join(',')}`, kind: 'security', severity: 'warning', title: `${updatesCache.security} security update(s)`, detail: names, ar: `🛡️ في ${updatesCache.security === 1 ? 'تحديث أمني جديد' : `${updatesCache.security} تحديثات أمنية`} لـ the server: <code>${names}</code>\nبتثبّتهم من MinisManager ← التحديثات.` };
}

export async function checkAlerts(): Promise<Alert[]> {
  const prev = new Map(current.map((a) => [a.key, a]));
  const next: Alert[] = [];
  const keep = (a: Omit<Alert, 'since'>) => next.push({ ...a, since: prev.get(a.key)?.since ?? Date.now() });

  for (const [user, units] of [
    [false, await failedUnits(false)],
    [true, await failedUnits(true)],
  ] as const) {
    for (const u of units) {
      const backup = /backup/i.test(u);
      const name = u.replace(/\.service$/, '');
      keep({
        key: `unit:${user ? 'user:' : ''}${u}`,
        kind: backup ? 'backup_failed' : 'unit_failed',
        severity: 'critical',
        title: backup ? `Backup failed: ${name}` : `Service stopped: ${name}`,
        detail: `${u} is in the failed state${user ? ' (user service)' : ''}.`,
        ar: backup ? `💾 النسخ الاحتياطي فشل: <code>${name}</code>` : `⚙️ خدمة وقفت بخطأ: <code>${name}</code>`,
        clears: true,
      });
    }
  }

  const threshold = getSettings().diskThreshold;
  for (const m of mounts()) {
    const pct = m.size ? (m.used / m.size) * 100 : 0;
    if (pct >= threshold)
      keep({
        key: `disk:${m.mount}`,
        kind: 'disk_full',
        severity: pct >= 97 ? 'critical' : 'warning',
        title: `Disk ${m.mount} is ${pct.toFixed(0)}% full`,
        detail: `${m.device} has ${(m.avail / 1e9).toFixed(1)} GB free.`,
        ar: `💽 القرص <code>${m.mount}</code> صار مليان ${pct.toFixed(0)}% (باقي ${(m.avail / 1e9).toFixed(1)} GB).`,
        clears: true,
      });
  }

  const s = hub.latest;
  const t = s?.temps.cpu;
  hotRuns = t !== null && t !== undefined && t >= 85 ? hotRuns + 1 : 0;
  if (hotRuns >= 2 || (prev.has('temp:cpu') && t !== null && t !== undefined && t >= 80))
    keep({ key: 'temp:cpu', kind: 'hot', severity: t! >= 95 ? 'critical' : 'warning', title: `CPU is hot (${Math.round(t!)}°C)`, detail: 'Check cooling and heavy processes.', ar: `🔥 حرارة المعالج عالية: <b>${Math.round(t!)}°C</b> صرلها أكتر من دقيقة.`, clears: true });

  const memFree = s ? s.mem.available / s.mem.total : 1;
  memRuns = memFree < 0.08 ? memRuns + 1 : 0;
  if (s && (memRuns >= 3 || (prev.has('mem:full') && memFree < 0.12))) {
    const usedGB = (s.mem.total - s.mem.available) / 1024 ** 3;
    keep({ key: 'mem:full', kind: 'mem_full', severity: memFree < 0.04 ? 'critical' : 'warning', title: `Memory almost full (${Math.round((1 - memFree) * 100)}%)`, detail: `${usedGB.toFixed(1)} GB in use.`, ar: `🧠 الرام شبه مليانة: <b>${Math.round((1 - memFree) * 100)}%</b> (${usedGB.toFixed(1)} GB). إذا ضلت هيك ممكن تقع برامج.`, clears: true });
  }

  for (const a of await containerAlerts()) keep(a);
  const sec = await securityAlert();
  if (sec) keep(sec);

  // Disk health: the key carries the error counters, so it only speaks up again when it gets worse.
  for (const a of diskHealthAlerts()) keep(a);

  current = next;
  // Notify once per alert, even across Manar restarts; resolved alerts can fire again later.
  let notified: string[] = [];
  try {
    notified = JSON.parse(kvGet('alerts.notified') ?? '[]') as string[];
  } catch {
    /* reset */
  }
  // First run with Telegram alerts: problems that already exist (the failing disk…) are not re-announced.
  const firstRun = !kvGet('alerts.telegram.v1');
  if (firstRun) kvSet('alerts.telegram.v1', '1');
  const active = new Set(next.map((a) => a.key));
  for (const a of next) {
    if (notified.includes(a.key) || firstRun) continue;
    void notify(a.title, a.detail, '/').catch(() => undefined);
    void postHook({ type: 'alert', severity: a.severity, kind: a.kind, text: a.ar ?? `${a.title}\n${a.detail}` });
  }
  // Cleared problems that were announced: say so (for kinds where that's useful).
  for (const key of notified) {
    if (active.has(key)) continue;
    const was = prev.get(key);
    if (was?.clears) void postHook({ type: 'alert', severity: 'ok', kind: was.kind, text: `✅ رجع طبيعي: ${(was.ar ?? was.title).replace(/^\S+\s/, '')}` });
  }
  kvSet('alerts.notified', JSON.stringify([...active]));
  return next;
}

export function startAlertLoop() {
  const run = () => void checkAlerts().catch(() => undefined);
  setTimeout(run, 10_000).unref();
  const t = setInterval(run, 60_000);
  t.unref();
  return () => clearInterval(t);
}
