import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { audit, kvGet, kvSet } from '../db.js';
import { requireAuth, requireElevated } from '../auth/sessions.js';
import { HelperError, runHelper, DEVICE_RE } from '../helper.js';
import { hub } from '../metrics/hub.js';
import { hostInfo } from '../metrics/system.js';
import { CATEGORIES, categoryOf, ensureLibrary, fileIndex, invalidateIndex, LIBRARY_FOLDERS, libraryDir, NOTES_FOLDER, safeFileName, uniquePath, type Category } from '../files/files.js';
import { launcherItems, recordOpen, saveOrder, setHidden } from '../launcher/launcher.js';
import { canFrame } from '../launcher/frames.js';
import { checkAlerts, currentAlerts, getSettings, notify, removePushSubscription, savePushSubscription, saveSettings, startAlertLoop, vapid, type NotifySettings } from '../notify/notify.js';
import { appUrl, installedApp } from '../store/installer.js';
import { taskCounts } from '../tasks/tasks.js';
import { commandExists, disks, interfaces, mounts, scheduledShutdown, tailscale } from './info.js';


export async function systemRoutes(app: FastifyInstance) {
  const stopAlerts = startAlertLoop();
  app.addHook('onClose', async () => stopAlerts());

  // ---- Home ----------------------------------------------------------------
  app.get('/api/home', { preHandler: requireAuth }, async (req) => {
    const items = launcherItems(req.session!.userId).filter((i) => !i.hidden);
    const frequent = [...items].filter((i) => i.opens > 0).sort((a, b) => b.opens - a.opens).slice(0, 4);
    return {
      host: hostInfo(),
      net: hub.latest?.net ?? { rx: 0, tx: 0 },
      storage: mounts(),
      alerts: currentAlerts(),
      frequent,
      quick: items.slice(0, 12),
      tasks: taskCounts(),
    };
  });

  // ---- Desktop mode preferences (same on every computer) ---------------------
  app.get('/api/desktop/prefs', { preHandler: requireAuth }, async () => {
    try {
      return JSON.parse(kvGet('desktop_prefs') ?? '{}');
    } catch {
      return {};
    }
  });
  app.put<{ Body: { wallpaper?: unknown; widgets?: unknown; hidden?: unknown; pinned?: unknown; order?: unknown; groups?: unknown } }>('/api/desktop/prefs', { preHandler: requireAuth }, async (req, reply) => {
    let prefs: Record<string, unknown> = {};
    try {
      prefs = JSON.parse(kvGet('desktop_prefs') ?? '{}');
    } catch {
      /* start fresh */
    }
    const body = req.body ?? {};
    if (body.wallpaper !== undefined) {
      const w = body.wallpaper as { kind?: unknown; id?: unknown; path?: unknown } | null;
      const ok =
        w && typeof w === 'object' && ((w.kind === 'preset' && typeof w.id === 'string' && w.id.length < 40) || (w.kind === 'file' && typeof w.path === 'string' && w.path.length < 1024));
      if (!ok) return reply.code(400).send({ error: 'bad_wallpaper' });
      prefs.wallpaper = w.kind === 'preset' ? { kind: 'preset', id: w.id } : { kind: 'file', path: w.path };
    }
    // Lists of launcher keys: hidden desktop icons, taskbar pins, icon order.
    for (const k of ['hidden', 'pinned', 'order'] as const) {
      const list = body[k];
      if (list === undefined) continue;
      // App keys are plain ids; the order also holds desktop file names ("f:<name>"), which can be anything printable.
      const valid = k === 'order' ? /^[^\u0000-\u001f]{1,300}$/ : /^[\w:.\-]{1,120}$/;
      if (!Array.isArray(list) || list.length > 600 || list.some((x) => typeof x !== 'string' || !valid.test(x))) return reply.code(400).send({ error: `bad_${k}` });
      prefs[k] = [...new Set(list as string[])];
    }
    // App folders: a named group of app keys, shown on the desktop as one icon.
    if (body.groups !== undefined) {
      const list = body.groups as { id?: unknown; name?: unknown; keys?: unknown }[];
      const ok =
        Array.isArray(list) &&
        list.length <= 60 &&
        list.every(
          (g) =>
            g &&
            typeof g === 'object' &&
            typeof g.id === 'string' &&
            /^g[\w-]{1,30}$/.test(g.id) &&
            typeof g.name === 'string' &&
            /^[^\u0000-\u001f]{0,60}$/.test(g.name) &&
            Array.isArray(g.keys) &&
            g.keys.length <= 100 &&
            g.keys.every((k) => typeof k === 'string' && /^[\w:.\-]{1,120}$/.test(k)),
        );
      if (!ok) return reply.code(400).send({ error: 'bad_groups' });
      const seen = new Set<string>();
      // An app sits in one folder at most; folders left with fewer than two apps are dropped.
      prefs.groups = list
        .map((g) => ({ id: g.id as string, name: g.name as string, keys: (g.keys as string[]).filter((k) => !seen.has(k) && (seen.add(k), true)) }))
        .filter((g) => g.keys.length >= 2);
    }
    if (body.widgets !== undefined) {
      const list = body.widgets;
      if (!Array.isArray(list) || list.length > 12 || list.some((x) => typeof x !== 'string' || !/^[a-z]{2,20}$/.test(x))) return reply.code(400).send({ error: 'bad_widgets' });
      prefs.widgets = [...new Set(list as string[])];
    }
    kvSet('desktop_prefs', JSON.stringify(prefs));
    return prefs;
  });

  // ---- Launcher -----------------------------------------------------------
  app.get('/api/launcher', { preHandler: requireAuth }, async (req) => launcherItems(req.session!.userId));
  /** Which apps can open inside a desktop window (the rest open in a browser tab). */
  app.get('/api/launcher/frames', { preHandler: requireAuth }, async () => {
    const items = launcherItems().filter((i) => i.url);
    const flags = await Promise.all(items.map((i) => (i.key.startsWith('craft:') ? true : canFrame(i.url!))));
    return Object.fromEntries(items.map((i, k) => [i.key, flags[k]]));
  });
  app.put<{ Body: { keys: string[] } }>('/api/launcher/order', { preHandler: requireAuth }, async (req, reply) => {
    const keys = req.body?.keys;
    if (!Array.isArray(keys) || keys.some((k) => typeof k !== 'string' || k.length > 120)) return reply.code(400).send({ error: 'bad_keys' });
    saveOrder(keys);
    return { ok: true };
  });
  app.post<{ Body: { key: string; hidden?: boolean } }>('/api/launcher/hide', { preHandler: requireAuth }, async (req) => {
    setHidden(String(req.body?.key), req.body?.hidden !== false);
    return { ok: true };
  });
  app.post<{ Body: { key: string } }>('/api/launcher/open', { preHandler: requireAuth }, async (req) => {
    recordOpen(String(req.body?.key).slice(0, 120));
    return { ok: true };
  });

  // ---- Storage & disks ------------------------------------------------------
  app.get('/api/storage', { preHandler: requireAuth }, async () => ({ mounts: mounts(), disks: await disks() }));

  app.get<{ Params: { name: string } }>('/api/disks/:name/smart', { preHandler: requireAuth }, async (req, reply) => {
    const device = `/dev/${req.params.name}`;
    if (!DEVICE_RE.test(device)) return reply.code(400).send({ error: 'bad_device' });
    if (!(await commandExists('smartctl'))) return reply.code(501).send({ error: 'smartctl_missing' });
    try {
      const data = JSON.parse(await runHelper({ cmd: 'smartctl', device }, 60_000)) as Record<string, unknown>;
      return summarizeSmart(data);
    } catch (err) {
      return reply.code(502).send({ error: err instanceof HelperError ? 'helper_failed' : 'parse_failed' });
    }
  });

  // ---- Files ----------------------------------------------------------------
  const fileBrowser = () => {
    const fb = installedApp('filebrowser');
    return fb ? appUrl(fb) : null;
  };

  app.get('/api/files/summary', { preHandler: requireAuth }, async () => {
    const idx = await fileIndex();
    const counts: Record<string, { count: number; size: number }> = {};
    for (const f of idx.files) {
      const c = (counts[f.cat] ??= { count: 0, size: 0 });
      c.count++;
      c.size += f.size;
    }
    return { categories: [...Object.keys(CATEGORIES), 'others'].map((k) => ({ key: k, ...(counts[k] ?? { count: 0, size: 0 }) })), fileBrowser: fileBrowser(), truncated: idx.truncated, root: config.dataRoot };
  });

  app.get<{ Params: { cat: string }; Querystring: { offset?: string; q?: string } }>('/api/files/category/:cat', { preHandler: requireAuth }, async (req, reply) => {
    const cat = req.params.cat as Category;
    if (!(cat in CATEGORIES) && cat !== 'others') return reply.code(400).send({ error: 'bad_category' });
    const q = (req.query.q ?? '').toLowerCase();
    const all = (await fileIndex()).files.filter((f) => f.cat === cat && (!q || f.path.toLowerCase().includes(q)));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    return { total: all.length, files: all.slice(offset, offset + 100), fileBrowser: fileBrowser() };
  });

  // Quick upload from Home: every file goes to /srv/data/files/<Images|Videos|…> by its type.
  app.post('/api/upload', { preHandler: requireAuth }, async (req, reply) => {
    ensureLibrary();
    const saved: string[] = [];
    for await (const part of req.files()) {
      const name = safeFileName(part.filename);
      const target = uniquePath(libraryDir(LIBRARY_FOLDERS[categoryOf(name)]), name);
      await pipeline(part.file, fs.createWriteStream(target, { flags: 'wx', mode: 0o644 }));
      if (part.file.truncated) {
        fs.rmSync(target, { force: true });
        return reply.code(413).send({ error: 'too_large' });
      }
      saved.push(path.relative(config.dataRoot, target));
    }
    invalidateIndex();
    audit(req.session!.userId, 'upload', { files: saved.length });
    return { saved };
  });

  app.post<{ Body: { title?: string; text: string } }>('/api/notes', { preHandler: requireAuth }, async (req, reply) => {
    const text = String(req.body?.text ?? '');
    if (!text.trim() || text.length > 200_000) return reply.code(400).send({ error: 'empty' });
    ensureLibrary();
    const dir = libraryDir(NOTES_FOLDER);
    const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
    const title = String(req.body?.title ?? '').trim();
    const name = safeFileName(`${stamp}${title ? ` ${title}` : ''}.md`);
    const target = uniquePath(dir, name);
    fs.writeFileSync(target, `${title ? `# ${title}\n\n` : ''}${text}\n`, { flag: 'wx', mode: 0o644 });
    invalidateIndex();
    return { saved: path.relative(config.dataRoot, target) };
  });

  // ---- Settings: system, network, tailscale, firewall ------------------------
  app.get('/api/settings/system', { preHandler: requireAuth }, async () => ({ ...hostInfo(), uptime: hub.latest?.uptime ?? null }));
  app.get('/api/settings/network', { preHandler: requireAuth }, async () => interfaces());
  app.get('/api/settings/tailscale', { preHandler: requireAuth }, async (_req, reply) => (await tailscale()) ?? reply.code(503).send({ error: 'tailscale_unavailable' }));
  app.get('/api/settings/firewall', { preHandler: requireAuth }, async () => {
    if (!(await commandExists('ufw'))) return { installed: false };
    try {
      const out = await runHelper({ cmd: 'ufw-status' });
      return { installed: true, active: /Status: active/.test(out), output: out };
    } catch {
      return { installed: true, active: null, output: null, error: 'helper_unavailable' };
    }
  });

  // ---- Power ----------------------------------------------------------------
  app.get('/api/power', { preHandler: requireAuth }, async () => ({ scheduled: await scheduledShutdown() }));

  app.post<{ Params: { action: string } }>('/api/power/:action', { preHandler: requireElevated }, async (req, reply) => {
    const action = req.params.action;
    if (!['reboot', 'poweroff', 'suspend'].includes(action)) return reply.code(400).send({ error: 'bad_action' });
    audit(req.session!.userId, `power_${action}`);
    try {
      await runHelper({ cmd: action as 'reboot' });
    } catch (err) {
      return reply.code(502).send({ error: 'helper_failed', detail: (err as HelperError).stderr });
    }
    return { ok: true };
  });

  app.post<{ Body: { action: 'reboot' | 'poweroff'; at: number } }>('/api/power/schedule', { preHandler: requireElevated }, async (req, reply) => {
    const { action, at } = req.body ?? ({} as never);
    const minutes = Math.ceil((Number(at) - Date.now()) / 60_000);
    if (!['reboot', 'poweroff'].includes(action) || !Number.isFinite(minutes) || minutes < 1 || minutes > 10080) return reply.code(400).send({ error: 'bad_time' });
    try {
      await runHelper({ cmd: 'schedule', action, minutes });
    } catch (err) {
      return reply.code(502).send({ error: 'helper_failed', detail: (err as HelperError).stderr });
    }
    audit(req.session!.userId, 'power_schedule', { action, minutes });
    return { ok: true, scheduled: await scheduledShutdown() };
  });

  app.delete('/api/power/schedule', { preHandler: requireElevated }, async (_req, reply) => {
    try {
      await runHelper({ cmd: 'cancel-schedule' });
    } catch (err) {
      return reply.code(502).send({ error: 'helper_failed', detail: (err as HelperError).stderr });
    }
    return { ok: true };
  });

  // ---- Notifications ---------------------------------------------------------
  app.get('/api/notify', { preHandler: requireAuth }, async () => ({ settings: getSettings(), vapidPublicKey: vapid().publicKey, alerts: currentAlerts() }));

  app.put<{ Body: NotifySettings }>('/api/notify', { preHandler: requireAuth }, async (req, reply) => {
    const b = req.body;
    const to = String(b?.whatsapp?.to ?? '').replace(/[\s-]/g, '');
    if (b?.whatsapp?.enabled && !/^\+[1-9]\d{6,14}$/.test(to)) return reply.code(400).send({ error: 'bad_number' });
    const threshold = Math.min(99, Math.max(50, Number(b?.diskThreshold) || 90));
    saveSettings({ push: b?.push !== false, whatsapp: { enabled: !!b?.whatsapp?.enabled, to }, diskThreshold: threshold });
    return { ok: true };
  });

  app.post<{ Body: { endpoint: string; keys: { p256dh: string; auth: string } } }>('/api/notify/subscribe', { preHandler: requireAuth }, async (req, reply) => {
    const s = req.body;
    if (!s?.endpoint?.startsWith('https://') || !s.keys?.p256dh || !s.keys?.auth) return reply.code(400).send({ error: 'bad_subscription' });
    savePushSubscription(s, req.headers['user-agent']);
    return { ok: true };
  });

  app.post<{ Body: { endpoint: string } }>('/api/notify/unsubscribe', { preHandler: requireAuth }, async (req) => {
    removePushSubscription(String(req.body?.endpoint));
    return { ok: true };
  });

  app.post('/api/notify/test', { preHandler: requireAuth }, async () => {
    await notify('Test notification', 'NovaOS notifications are working.', '/settings/notifications');
    return { ok: true };
  });

  app.post('/api/alerts/check', { preHandler: requireAuth }, async () => checkAlerts());
}

/** Keep only what the Disks screen shows. */
function summarizeSmart(d: Record<string, unknown>) {
  const g = (p: string): unknown => p.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], d);
  const ata = (g('ata_smart_attributes.table') as { id: number; name: string; value: number; worst: number; thresh: number; raw: { value: number; string: string }; when_failed: string }[] | undefined) ?? [];
  return {
    model: g('model_name') ?? null,
    serial: g('serial_number') ?? null,
    firmware: g('firmware_version') ?? null,
    passed: g('smart_status.passed') ?? null,
    temperature: g('temperature.current') ?? null,
    powerOnHours: g('power_on_time.hours') ?? null,
    powerCycles: g('power_cycle_count') ?? null,
    nvme: g('nvme_smart_health_information_log') ?? null,
    attributes: ata.map((a) => ({ id: a.id, name: a.name, value: a.value, worst: a.worst, thresh: a.thresh, raw: a.raw?.string ?? String(a.raw?.value ?? ''), failed: a.when_failed || null })),
  };
}
