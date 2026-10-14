import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/sessions.js';
import { config } from '../config.js';
import { addTorrent } from '../bot/apps.js';
import { startDownload } from '../downloads/downloads.js';

/**
 * The NovaOS Android app (phones and Android TV, android/ in this repo). It shows this web app
 * in a WebView and adds what a browser can't: notifications through ntfy (self-hosted on the server, no
 * Firebase), "Share to the server" from any app, and a biometric lock. This module gives the app its
 * notification settings and takes shared links; files are uploaded through /api/fs/upload.
 */

export interface NtfyConfig {
  /** what the app connects to (over Tailscale) */
  url: string;
  /** what this server publishes to (the container on loopback) */
  local: string;
  topic: string;
  token: string;
}
export function ntfyConfig(): NtfyConfig | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(config.dataDir, 'ntfy.json'), 'utf8')) as NtfyConfig;
  } catch {
    return null;
  }
}

const decode = (s: string) =>
  s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();

/** One hook payload (the same ones that go to Telegram) → a notification, or null if it isn't one. */
export function toNotification(p: Record<string, unknown>): { title: string; message: string; priority: number; tags: string[]; click?: string } | null {
  const type = String(p.type ?? '');
  if (type === 'alert') {
    const sev = String(p.severity ?? 'warning');
    return {
      title: sev === 'ok' ? 'Back to normal' : sev === 'critical' ? 'Needs attention' : 'Heads-up',
      message: decode(String(p.text ?? '')),
      priority: sev === 'critical' ? 5 : sev === 'ok' ? 2 : 4,
      tags: [sev === 'ok' ? 'white_check_mark' : sev === 'critical' ? 'rotating_light' : 'warning'],
      click: `${config.publicOrigin}/health`,
    };
  }
  if (type === 'notice') {
    const text = decode(String(p.text ?? ''));
    return text ? { title: 'NovaOS', message: text, priority: 3, tags: [], click: config.publicOrigin } : null;
  }
  if (type === 'download') {
    const done = p.status === 'done';
    if (p.status !== 'done' && p.status !== 'failed') return null;
    return {
      title: done ? 'Download finished' : 'Download failed',
      message: String(p.title ?? p.url ?? ''),
      priority: done ? 3 : 4,
      tags: [done ? 'arrow_down' : 'x'],
      click: typeof p.filesUrl === 'string' ? p.filesUrl : undefined,
    };
  }
  return null; // confirmations and file sends are Telegram conversations
}

/** Best effort; never throws. */
export async function publishNtfy(p: Record<string, unknown>): Promise<boolean> {
  const n = toNotification(p);
  const c = ntfyConfig();
  if (!n || !c || !n.message) return false;
  try {
    const r = await fetch(c.local, {
      method: 'POST',
      headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: c.topic, title: n.title, message: n.message.slice(0, 3500), priority: n.priority, tags: n.tags, click: n.click }),
      signal: AbortSignal.timeout(10_000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

const MAGNET = /^magnet:\?xt=urn:bt[im]h:/i;
/** A locally provided APK (var/NovaOS.apk) wins over the GitHub release download. */
const apkFile = () => path.join(config.dataDir, 'NovaOS.apk');

export async function mobileRoutes(app: FastifyInstance) {
  app.get('/api/app/info', { preHandler: requireAuth }, async () => {
    let local: { size: number; mtime: number } | null = null;
    try {
      const st = fs.statSync(apkFile());
      local = { size: st.size, mtime: st.mtimeMs };
    } catch {
      /* no local apk */
    }
    return { local, github: `https://github.com/${config.updateRepo}/releases/latest/download/NovaOS.apk`, repo: config.updateRepo, origin: config.publicOrigin };
  });
  app.get('/api/app/apk', { preHandler: requireAuth }, async (_req, reply) => {
    if (!fs.existsSync(apkFile())) return reply.code(404).send({ error: 'no_apk' });
    return reply
      .header('Content-Type', 'application/vnd.android.package-archive')
      .header('Content-Disposition', 'attachment; filename="NovaOS.apk"')
      .header('Content-Length', String(fs.statSync(apkFile()).size))
      .send(fs.createReadStream(apkFile()));
  });
  app.get('/api/app/config', { preHandler: requireAuth }, async () => {
    const c = ntfyConfig();
    return { origin: config.publicOrigin, ntfy: c ? { url: c.url, topic: c.topic, token: c.token } : null };
  });
  // "Share to the server": a magnet / .torrent link → qBittorrent; any other web link → yt-dlp (video or audio).
  app.post<{ Body: { kind?: string; value?: string; audio?: boolean } }>('/api/app/share', { preHandler: requireAuth }, async (req, reply) => {
    const value = String(req.body?.value ?? '').trim();
    const kind = req.body?.kind;
    if (!value) return reply.code(400).send({ ok: false, message: 'Nothing to send' });
    if (kind === 'torrent' || MAGNET.test(value) || /\.torrent(\?|$)/i.test(value)) {
      const r = await addTorrent(value);
      return { ok: r.ok, message: r.ok ? 'Torrent added — it goes into Jellyfin when it finishes.' : r.message };
    }
    try {
      const d = await startDownload(value, !!req.body?.audio);
      return { ok: true, message: req.body?.audio ? 'Downloading the audio…' : 'Downloading…', id: d.id };
    } catch (e) {
      return reply.code(400).send({ ok: false, message: (e as Error).message });
    }
  });
}
