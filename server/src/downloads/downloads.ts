import { spawn } from 'node:child_process';
import dns from 'node:dns';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { getDb } from '../db.js';
import { postHook } from '../bot/hook.js';
export { hookSecret } from '../bot/hook.js';
import { requireAuth } from '../auth/sessions.js';
import { invalidateIndex } from '../files/files.js';
import { relOf } from '../files/fsops.js';
import { createShareFor } from '../share/share.js';
import { isPrivateIp } from '../bot/ip.js';

/**
 * Video/audio downloads with yt-dlp (YouTube, Instagram, X, TikTok, Facebook and ~1800 sites),
 * started from the n8n assistant. Separate from the app task queue so a long download never
 * blocks an install; two at a time. Files go to Toshiba/Downloads/Links; when one finishes, a 7-day share
 * link is made and the assistant's webhook is told (it messages the owner on Telegram).
 */

export interface Download {
  id: number;
  url: string;
  audio: number;
  status: 'queued' | 'running' | 'done' | 'failed';
  progress: string | null;
  title: string | null;
  path: string | null;
  size: number | null;
  share_url: string | null;
  error: string | null;
  created_at: number;
  finished_at: number | null;
}

const MAX_PARALLEL = 2;
/** On the Toshiba (lots of room; the SSD stays free). files/Downloads/Links points here. */
const DIR = () => path.join(config.mediaRoot, 'Downloads', 'Links');
const active = new Map<number, { kill: (sig?: NodeJS.Signals) => unknown }>();

/** Only public http(s) URLs: yt-dlp must not be pointed at the server itself or the home network. */
export async function checkUrl(raw: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error('bad_url');
  }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) throw new Error('bad_url');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [host] : (await dns.promises.lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addrs.length) throw new Error('unknown_host');
  if (addrs.some(isPrivateIp)) throw new Error('blocked_address');
  return u;
}

const get = (id: number) => getDb().prepare('SELECT * FROM downloads WHERE id = ?').get(id) as Download | undefined;
const set = (id: number, patch: Partial<Download>) => {
  const keys = Object.keys(patch);
  getDb()
    .prepare(`UPDATE downloads SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(...keys.map((k) => (patch as Record<string, string | number | null>)[k]), id);
};

export async function startDownload(raw: string, audio: boolean): Promise<Download> {
  const u = await checkUrl(raw);
  const r = getDb().prepare("INSERT INTO downloads(url, audio, status, created_at) VALUES(?, ?, 'queued', ?)").run(u.toString(), audio ? 1 : 0, Date.now());
  setImmediate(pump);
  return get(Number(r.lastInsertRowid))!;
}

export function ytDlpArgs(url: string, audio: boolean, dir: string): string[] {
  return [
    '--no-playlist',
    '--newline',
    '--progress',
    '--no-colors',
    '--no-mtime',
    '--no-part',
    '--max-filesize',
    '8G',
    '--js-runtimes',
    'node',
    '-P',
    dir,
    '-o',
    '%(title).150B [%(id)s].%(ext)s',
    '--progress-template',
    'download:PROG %(progress._percent_str)s of %(progress._total_bytes_str)s%(progress._total_bytes_estimate_str)s at %(progress._speed_str)s ETA %(progress._eta_str)s',
    '--print',
    'before_dl:TITLE %(title)s',
    '--print',
    'after_move:FILE %(filepath)s',
    ...(audio ? ['-x', '--audio-format', 'mp3', '--audio-quality', '0'] : ['-f', 'bv*[height<=1080]+ba/b[height<=1080]/bv*+ba/b', '--merge-output-format', 'mp4']),
    '--',
    url,
  ];
}

function pump() {
  if (active.size >= MAX_PARALLEL) return;
  const next = getDb().prepare("SELECT * FROM downloads WHERE status = 'queued' ORDER BY id LIMIT 1").get() as Download | undefined;
  if (!next) return;
  set(next.id, { status: 'running', progress: 'starting' });
  run(next);
  setImmediate(pump);
}

/** Pages and video sites go to yt-dlp; anything else that isn't a web page is a plain file. */
const VIDEO_SITES = /(^|\.)(youtube\.com|youtu\.be|instagram\.com|tiktok\.com|x\.com|twitter\.com|facebook\.com|fb\.watch|vimeo\.com|dailymotion\.com|twitch\.tv|reddit\.com|soundcloud\.com)$/i;
const MAX_FILE = 100 * 1024 ** 3;

/** Follow redirects by hand so every hop is checked against private addresses. */
async function openDirect(raw: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
  let url = raw;
  for (let hop = 0; hop < 6; hop++) {
    await checkUrl(url);
    const r = await fetch(url, { ...init, redirect: 'manual', signal, headers: { 'user-agent': 'Mozilla/5.0 NovaOS', ...(init.headers ?? {}) } });
    const loc = r.headers.get('location');
    if (r.status >= 300 && r.status < 400 && loc) {
      url = new URL(loc, url).toString();
      continue;
    }
    return Object.assign(r, { finalUrl: url });
  }
  throw new Error('too_many_redirects');
}

export function fileNameFor(url: string, disposition: string | null): string {
  const m = disposition && (/filename\*=UTF-8''([^;]+)/i.exec(disposition) ?? /filename="?([^";]+)"?/i.exec(disposition));
  let name = m ? decodeURIComponent(m[1]) : '';
  if (!name) {
    try {
      name = decodeURIComponent(path.posix.basename(new URL(url).pathname));
    } catch {
      name = '';
    }
  }
  name = name.replace(/[\/\\\0]/g, '_').replace(/^\.+/, '').trim().slice(0, 180);
  return name || `download-${Date.now()}`;
}

function uniquePath(dir: string, name: string): string {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let p = path.join(dir, name);
  for (let i = 2; fs.existsSync(p) || fs.existsSync(`${p}.part`); i++) p = path.join(dir, `${base} (${i})${ext}`);
  return p;
}

const fmtBytes = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)}GiB` : `${(n / 1024 ** 2).toFixed(1)}MiB`);

/** A direct file link: stream it into Downloads with progress. Returns false when it is a web page (→ yt-dlp). */
async function runDirect(d: Download): Promise<boolean> {
  if (d.audio || VIDEO_SITES.test(new URL(d.url).hostname)) return false;
  const ctl = new AbortController();
  let r: Response & { finalUrl?: string };
  try {
    r = await openDirect(d.url, { method: 'GET' }, ctl.signal);
  } catch {
    return false;
  }
  const type = (r.headers.get('content-type') ?? '').toLowerCase();
  if (!r.ok || !r.body || /text\/html|application\/xhtml/.test(type)) {
    ctl.abort();
    return false;
  }
  const total = Number(r.headers.get('content-length')) || 0;
  if (total > MAX_FILE) {
    ctl.abort();
    await finish(d.id, null, 'file larger than 100 GB');
    return true;
  }
  fs.mkdirSync(DIR(), { recursive: true });
  const name = fileNameFor(r.finalUrl ?? d.url, r.headers.get('content-disposition'));
  const dest = uniquePath(DIR(), name);
  set(d.id, { title: path.basename(dest) });
  active.set(d.id, { kill: () => ctl.abort() });
  const out = fs.createWriteStream(`${dest}.part`);
  let got = 0;
  let last = { at: Date.now(), got: 0 };
  let error = '';
  try {
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      if (got > MAX_FILE) throw new Error('file larger than 100 GB');
      if (!out.write(value)) await new Promise((res) => out.once('drain', res));
      const now = Date.now();
      if (now - last.at > 2000) {
        const speed = ((got - last.got) * 1000) / (now - last.at);
        const pct = total ? `${((got / total) * 100).toFixed(1)}%` : fmtBytes(got);
        const eta = total && speed > 0 ? ` ETA ${Math.round((total - got) / speed)}s` : '';
        set(d.id, { progress: `${pct}${total ? ` of ${fmtBytes(total)}` : ''} at ${fmtBytes(speed)}/s${eta}` });
        last = { at: now, got };
      }
    }
    await new Promise<void>((res, rej) => out.end((e?: Error | null) => (e ? rej(e) : res())));
    if (total && got !== total) throw new Error(`incomplete (${fmtBytes(got)} of ${fmtBytes(total)})`);
    fs.renameSync(`${dest}.part`, dest);
  } catch (e) {
    error = ctl.signal.aborted ? 'cancelled' : (e as Error).message;
    out.destroy();
    fs.rmSync(`${dest}.part`, { force: true });
  } finally {
    active.delete(d.id);
  }
  await finish(d.id, error ? null : dest, error);
  return true;
}

function run(d: Download) {
  void runDirect(d)
    .catch(() => false)
    .then((handled) => {
      if (!handled) runYtDlp(d);
      else setImmediate(pump);
    });
}

function runYtDlp(d: Download) {
  fs.mkdirSync(DIR(), { recursive: true });
  const child = spawn(config.ytDlp, ytDlpArgs(d.url, !!d.audio, DIR()), { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PATH: `/usr/bin:/bin:${process.env.PATH ?? ''}` } });
  active.set(d.id, child);
  let file: string | null = null;
  let err = '';
  let lastSave = 0;
  const onLine = (line: string) => {
    if (line.startsWith('TITLE ')) set(d.id, { title: line.slice(6).trim() });
    else if (line.startsWith('FILE ')) file = line.slice(5).trim();
    else if (line.startsWith('PROG ') && Date.now() - lastSave > 2000) {
      lastSave = Date.now();
      set(d.id, { progress: line.slice(5).replace(/NA/g, '').replace(/\s+/g, ' ').trim() });
    } else if (/^ERROR:/.test(line)) err = line.replace(/^ERROR:\s*/, '');
  };
  for (const s of [child.stdout, child.stderr]) {
    let buf = '';
    s.on('data', (c: Buffer) => {
      buf += c.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? '';
      lines.forEach(onLine);
    });
  }
  const timeout = setTimeout(() => child.kill('SIGTERM'), 3 * 3600_000);
  child.on('close', (code) => {
    clearTimeout(timeout);
    active.delete(d.id);
    void finish(d.id, code === 0 && file && fs.existsSync(file) ? file : null, err || (code === 0 ? 'no file produced' : `yt-dlp exited with ${code}`)).finally(() => setImmediate(pump));
  });
  child.on('error', (e) => {
    clearTimeout(timeout);
    active.delete(d.id);
    void finish(d.id, null, e.message).finally(() => setImmediate(pump));
  });
}

async function finish(id: number, file: string | null, error: string) {
  if (file) {
    const rel = relOf(fs.realpathSync(file));
    let share: string | null = null;
    try {
      share = createShareFor(rel, 7);
    } catch {
      /* the file is still there; just no link */
    }
    set(id, { status: 'done', path: rel, size: fs.statSync(file).size, share_url: share, progress: null, finished_at: Date.now() });
    invalidateIndex();
  } else set(id, { status: 'failed', error: error.slice(0, 500), progress: null, finished_at: Date.now() });
  await announce(get(id)!);
}

/** Tell the assistant (n8n webhook on this machine). Best effort. */
async function announce(d: Download) {
  await postHook({ type: 'download', ...publicView(d) });
}

export function publicView(d: Download) {
  return {
    id: d.id,
    url: d.url,
    audio: !!d.audio,
    status: d.status,
    progress: d.progress,
    title: d.title,
    file: d.path ? path.basename(d.path) : null,
    sizeMB: d.size ? Math.round((d.size / 1024 ** 2) * 10) / 10 : null,
    shareUrl: d.share_url,
    filesUrl: d.path ? `${config.publicOrigin}/files?path=${encodeURIComponent(path.posix.dirname(d.path))}` : null,
    error: d.error,
  };
}

export const listDownloads = (limit = 20) => (getDb().prepare('SELECT * FROM downloads ORDER BY id DESC LIMIT ?').all(limit) as unknown as Download[]).map(publicView);
export const getDownload = (id: number) => {
  const d = get(id);
  return d ? publicView(d) : null;
};

/** On startup: downloads cut off by a restart are retried. */
export function recoverDownloads() {
  getDb().prepare("UPDATE downloads SET status = 'queued', progress = NULL WHERE status = 'running'").run();
  setImmediate(pump);
}

export async function downloadRoutes(app: FastifyInstance) {
  if (!process.env.VITEST) recoverDownloads();
  app.get('/api/downloads', { preHandler: requireAuth }, async () => ({ downloads: listDownloads(50) }));
  app.post<{ Params: { id: string } }>('/api/downloads/:id/cancel', { preHandler: requireAuth }, async (req, reply) => {
    const id = Number(req.params.id);
    const d = get(id);
    if (!d) return reply.code(404).send({ error: 'not_found' });
    if (d.status === 'queued') set(id, { status: 'failed', error: 'cancelled', finished_at: Date.now() });
    else active.get(id)?.kill('SIGTERM');
    return { ok: true };
  });
  app.addHook('onClose', async () => {
    for (const c of active.values()) c.kill('SIGTERM');
  });
}
