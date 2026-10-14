import { startArchiveDownloads } from './archiveDl.js';
import { enqueue, findItems, jobs, startSubTranslator, subUpdate } from './subTranslate.js';
import { keyboard, tg } from './telegram.js';
import { startMediaLibrary } from './mediaLibrary.js';
import { businessStatus, chatHistory, handleBusinessUpdate, setMuted, setRemindHours, startBusinessReminders, unanswered, type TgUpdate } from './business.js';
import { tradebotCommand, tradebotSnapshot } from '../tradebot/engine.js';
import { execFile } from 'node:child_process';
import { addTorrent, listTorrents, paperlessFile, paperlessSearch, startTorrentWatcher, searchTorrents } from './apps.js';
import { torrentUpdate } from './torrentUi.js';
import { monitorAlert, monitorKeyOk } from './monitor.js';
import crypto from 'node:crypto';
import dns from 'node:dns';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { audit, kvGet, kvSet } from '../db.js';
import { requireAuth, requireElevated } from '../auth/sessions.js';
import { hub } from '../metrics/hub.js';
import { hostInfo } from '../metrics/system.js';
import { mounts, tailscale } from '../system/info.js';
import { internetSpeed } from '../system/speed.js';
import { docker } from '../docker/client.js';
import { latestDiskHealth } from '../smart/health.js';
import { systemStatus } from '../system/updates.js';
import { marketPrices, news, prayerTimes } from './market.js';
import { decide, proposeContainerAction, proposeErpChange } from './actions.js';
import { stashIncoming } from './erpWrite.js';
import { videoText } from './video.js';
import { speak } from './tts.js';
import { erp } from './erp.js';
import { formatEvent, formatReply } from './format.js';
import { memory, memoryText } from './memory.js';
import { notes, priceAlerts, prayerReminders, reminders, startPersonalLoop } from './personal.js';
import { extractText, findFiles, rawFile, saveIncoming, sendFile, shareLink, fileTo, fitImage, sniffType } from './files.js';
import { getDownload, listDownloads, publicView, startDownload } from '../downloads/downloads.js';

/**
 * Bot API: a small, read-only summary of the server for automations (the n8n Telegram assistant).
 * It runs on its own listener bound to the docker bridge (172.17.0.1:7478), so only containers
 * on this machine can reach it — not the tailnet, not the internet — and every request needs
 * the bot token (Authorization: Bearer). Nothing here can change anything.
 */

const KEY = 'bot_token_sha256';
const sha = (s: string) => crypto.createHash('sha256').update(s).digest();

/** New token (shown once); the old one stops working. */
export function rotateBotToken(): string {
  const token = `mmbot_${crypto.randomBytes(24).toString('base64url')}`;
  kvSet(KEY, sha(token).toString('base64url'));
  return token;
}
export function revokeBotToken() {
  kvSet(KEY, '');
}
export function checkBotToken(header: string | undefined): boolean {
  const stored = kvGet(KEY);
  const m = /^Bearer (mmbot_[\w-]{32})$/.exec(header ?? '');
  if (!stored || !m) return false;
  const want = Buffer.from(stored, 'base64url');
  const got = sha(m[1]);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

const GB = 1024 ** 3;
const gb = (n: number) => Math.round((n / GB) * 10) / 10;
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
const ago = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  return d ? `${d}d ${h}h` : `${h}h ${Math.floor((s % 3600) / 60)}m`;
};

async function containers() {
  if (!docker.socketExists()) return [];
  return (await docker.list()).map((c) => ({
    name: c.Names[0]?.replace(/^\//, '') ?? c.Id.slice(0, 12),
    app: c.Labels['manar.app'] ?? null,
    state: c.State,
    status: c.Status,
    image: c.Image,
  }));
}

export async function botStatus() {
  const s = hub.latest;
  const info = hostInfo();
  const list = await containers().catch(() => []);
  const upd = await systemStatus().catch(() => null);
  return {
    host: info.hostname,
    os: info.os,
    uptime: ago(os.uptime() * 1000),
    cpu: s ? { usedPct: Math.round(s.cpu.total), load: s.load, cores: info.cores, tempC: s.temps.cpu } : null,
    memory: s ? { usedGB: gb(s.mem.total - s.mem.available), totalGB: gb(s.mem.total), usedPct: pct(s.mem.total - s.mem.available, s.mem.total) } : null,
    gpu: s?.gpu.busy !== null && s ? { busyPct: s.gpu.busy, tempC: s.temps.gpu } : null,
    storage: mounts().map((m) => ({ mount: m.mount, usedGB: gb(m.used), totalGB: gb(m.size), usedPct: pct(m.used, m.size) })),
    diskHealth: latestDiskHealth().map((d) => ({ disk: d.name, model: d.model, status: d.status, problems: d.reasons.map((r) => `${r.code}${r.n !== undefined ? ` ${r.n}` : ''}`), tempC: d.temperature })),
    containers: { running: list.filter((c) => c.state === 'running').length, stopped: list.filter((c) => c.state !== 'running').map((c) => c.name) },
    updates: upd ? { pending: upd.updates.length, security: upd.security, rebootRequired: upd.rebootRequired } : null,
  };
}

// ---- read_webpage: fetch a public page as plain text --------------------------------------
// The bot gets URLs from search results (i.e. from the internet), so only public addresses are
// allowed: every DNS answer is checked at connect time (no rebinding), redirects re-checked.

export { isPrivateIp } from './ip.js';
import { isPrivateIp } from './ip.js';

const safeLookup: net.LookupFunction = (host, opts, cb) => {
  dns.lookup(host, { ...opts, all: true }, (err, addrs) => {
    if (err) return cb(err, '', 4);
    const list = addrs as dns.LookupAddress[];
    const bad = list.find((a) => isPrivateIp(a.address));
    if (bad || !list.length) return cb(Object.assign(new Error('blocked_address'), { code: 'EBLOCKED' }), '', 4);
    if ((opts as { all?: boolean }).all) return (cb as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list);
    cb(null, list[0].address, list[0].family);
  });
};

const MAX_BYTES = 3 * 1024 * 1024;
function get(url: URL, hops = 0): Promise<{ url: URL; type: string; body: string }> {
  return new Promise((resolve, reject) => {
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return reject(new Error('bad_url'));
    if (net.isIP(url.hostname.replace(/^\[|\]$/g, '')) && isPrivateIp(url.hostname.replace(/^\[|\]$/g, ''))) return reject(new Error('blocked_address'));
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.get(url, { lookup: safeLookup, timeout: 15_000, headers: { 'User-Agent': 'Mozilla/5.0 (the server assistant; +read-only)', Accept: 'text/html,text/plain;q=0.9,*/*;q=0.1', 'Accept-Language': 'en,ar;q=0.8' } }, (res) => {
      const code = res.statusCode ?? 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        if (hops >= 4) return reject(new Error('too_many_redirects'));
        return get(new URL(res.headers.location, url), hops + 1).then(resolve, reject);
      }
      if (code >= 400) {
        res.resume();
        return reject(new Error(`http_${code}`));
      }
      const type = String(res.headers['content-type'] ?? '');
      if (!/text\/(html|plain)|application\/(xhtml|json)/.test(type)) {
        res.resume();
        return reject(new Error('not_text'));
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BYTES) return req.destroy(new Error('too_large'));
        chunks.push(c);
      });
      res.on('end', () => resolve({ url, type, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
/** HTML → readable text: drops scripts, styles, navigation and footers; keeps headings and paragraphs. */
export function htmlToText(html: string): { title: string; text: string } {
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').trim();
  const main = /<(main|article)\b[\s\S]*<\/\1>/i.exec(html)?.[0] ?? html;
  const text = main
    .replace(/<(script|style|noscript|svg|nav|footer|header|aside|form|iframe|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e: string) => (e[0] === '#' ? String.fromCodePoint(parseInt(e.slice(e[1].toLowerCase() === 'x' ? 2 : 1), e[1].toLowerCase() === 'x' ? 16 : 10)) : (ENTITIES[e.toLowerCase()] ?? m)))
    .replace(/[ \t\f\v\r]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title: title.replace(/\s+/g, ' '), text };
}

export async function readPage(raw: string, maxChars = 8000) {
  const r = await get(new URL(raw));
  const { title, text } = /html/.test(r.type) ? htmlToText(r.body) : { title: '', text: r.body };
  return { url: r.url.toString(), title, text: text.slice(0, maxChars), truncated: text.length > maxChars };
}

// ---- transcribe: voice messages → text, with the local multimodal model (gemma4 hears audio) ----
const BLANK_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAXklEQVR4nO3PMQ0AMAzAsPInvYLYYVWKESTzjhsd8KsBrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BbQHKU9LC7/CP1AAAAABJRU5ErkJggg==', 'base64'); // 64×64 white
const execFileP = promisify(execFile);
const OLLAMA = process.env.MANAR_OLLAMA_URL ?? 'http://127.0.0.1:11434';
const STT_MODEL = process.env.MANAR_STT_MODEL ?? 'gemma4:latest';
const CHUNK_S = 120;
const MAX_S = 600;

/** Any audio Telegram sends (OGG/Opus, M4A, MP3…) → 16 kHz mono WAV chunks of ≤2 min, at most 10 min. */
export async function audioChunks(input: Buffer): Promise<Buffer[]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-stt-'));
  try {
    const src = path.join(dir, 'in');
    fs.writeFileSync(src, input);
    await execFileP('ffmpeg', ['-v', 'error', '-nostdin', '-i', src, '-t', String(MAX_S), '-vn', '-ac', '1', '-ar', '16000', '-f', 'segment', '-segment_time', String(CHUNK_S), path.join(dir, 'c%03d.wav')], { timeout: 120_000 });
    return fs.readdirSync(dir).filter((f) => /^c\d+\.wav$/.test(f)).sort().map((f) => fs.readFileSync(path.join(dir, f)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export async function transcribe(input: Buffer): Promise<string> {
  const parts: string[] = [];
  for (const wav of await audioChunks(input)) {
    const res = await fetch(`${OLLAMA}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: STT_MODEL,
        stream: false,
        think: false,
        keep_alive: '30m',
        options: { temperature: 0 },
        messages: [{ role: 'user', content: 'Transcribe this audio exactly as spoken, in its original language and dialect. Output only the transcript, nothing else.', images: [wav.toString('base64')] }],
      }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) throw new Error(`model_${res.status}`);
    parts.push(((await res.json()) as { message?: { content?: string } }).message?.content?.trim() ?? '');
  }
  return parts.filter(Boolean).join(' ');
}

const clientIp = (req: FastifyRequest) => req.ip;

export async function buildBotServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: 'warn' }, bodyLimit: 1024 });
  await app.register(rateLimit, { global: true, max: 120, timeWindow: '1 minute', keyGenerator: clientIp });
  app.addHook('onRequest', async (req, reply) => {
    // Uptime Kuma's alerts: their own key, this route only.
    if (req.method === 'POST' && req.url.split('?')[0] === '/monitor-alert') {
      if (!monitorKeyOk(req.headers['x-monitor-key'] ?? (req.query as { key?: string }).key)) return reply.code(401).send({ error: 'unauthorized' });
      return;
    }
    // Read-only, except /transcribe (audio in, text out), /download (saves into files/Downloads) and
    // actions, which only *propose*: they run when the owner presses the Telegram button (see actions.ts).
    if (req.method !== 'GET' && !(req.method === 'POST' && (['/transcribe', '/download', '/actions/container', '/files/send', '/files/save', '/files/text', '/share', '/reminders', '/notes', '/price-alerts', '/prayer-reminders', '/tts', '/format', '/format-event', '/memory', '/erp/change', '/erp/stash', '/image/fit', '/files/move', '/torrent', '/torrent/update', '/commands/update', '/subtitles/translate', '/paperless/file', '/tradebot/command', '/business/update', '/business/mute', '/business/remind'].includes(req.url.split('?')[0]) || /^\/actions\/[\w-]{16}\/(yes|no)$/.test(req.url.split('?')[0])))) return reply.code(405).send({ error: 'read_only' });
    if (!checkBotToken(req.headers.authorization)) return reply.code(401).send({ error: 'unauthorized' });
  });
  app.addContentTypeParser(['application/octet-stream', 'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/x-wav', 'audio/webm'], { parseAs: 'buffer', bodyLimit: 25 * 1024 * 1024 }, (_req, body, done) => done(null, body));
  app.addContentTypeParser(/^(image\/|application\/pdf)/, { parseAs: 'buffer', bodyLimit: 25 * 1024 * 1024 }, (_req, body, done) => done(null, body));
  // Store apps (bot/apps.ts): torrents and papers.
  const stopTorrents = startTorrentWatcher();
  app.addHook('onClose', async () => stopTorrents());
  const appErr = (reply: FastifyReply, e: unknown) => reply.code(422).send({ error: (e as Error).message });
  app.post<{ Body: { link?: string } }>('/torrent', async (req, reply) => addTorrent(String(req.body?.link ?? '')).catch((e) => appErr(reply, e)));
  app.get('/torrents', async (_req, reply) => listTorrents().catch((e) => appErr(reply, e)));
  // Telegram commands answered by MinisManager itself (n8n passes the update): /torrent, /torrents, /sub.
  const stopSubs = startSubTranslator();
  app.addHook('onClose', async () => stopSubs());
  app.post<{ Body: Record<string, unknown> }>('/commands/update', { bodyLimit: 64 * 1024 }, async (req) => {
    const u = (req.body ?? {}) as { message?: { text?: string }; callback_query?: { data?: string } };
    const isSub = /^\/sub(@\w+)?(\s|$)/i.test(u.message?.text ?? '') || /^sub:/.test(u.callback_query?.data ?? '');
    if (!isSub) return torrentUpdate(u as never).catch((e: Error) => ({ ok: false, did: e.message.slice(0, 120) }));
    const html = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };
    return subUpdate(
      u as never,
      (chat_id, text, rows) => tg('sendMessage', { chat_id, text, ...html, ...(rows ? { reply_markup: keyboard(rows) } : {}) }),
      (chat_id, message_id, text) => tg('editMessageText', { chat_id, message_id, text, ...html }),
      (id, text) => tg('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) }),
    ).catch((e: Error) => ({ ok: false, did: e.message.slice(0, 120) }));
  });
  // For the assistant: translate a film's English subtitle to Arabic, and the queue.
  app.post<{ Body: { q?: string } }>('/subtitles/translate', async (req, reply) => {
    const items = await findItems(String(req.body?.q ?? '')).catch(() => []);
    if (!items.length) return reply.code(404).send({ error: 'not_in_jellyfin' });
    return { queued: enqueue(items[0].id, items[0].name), others: items.slice(1).map((x) => x.name) };
  });
  app.get('/subtitles/jobs', async () => ({ jobs: jobs().slice(-10) }));
  // /torrent and its buttons: n8n passes the Telegram update; MinisManager answers on Telegram itself.
  app.post<{ Body: Record<string, unknown> }>('/torrent/update', { bodyLimit: 64 * 1024 }, async (req) => torrentUpdate((req.body ?? {}) as never).catch((e: Error) => ({ ok: false, did: e.message.slice(0, 120) })));
  app.get<{ Querystring: { q?: string; cat?: string; limit?: string } }>('/torrents/search', async (req, reply) => searchTorrents(String(req.query.q ?? ''), String(req.query.cat ?? 'all'), Number(req.query.limit) || 8).catch((e) => appErr(reply, e)));
  app.post<{ Body: { path?: string } }>('/paperless/file', async (req, reply) => paperlessFile(String(req.body?.path ?? '')).catch((e) => appErr(reply, e)));
  app.get<{ Querystring: { q?: string } }>('/paperless/search', async (req, reply) => paperlessSearch(String(req.query.q ?? '')).catch((e) => appErr(reply, e)));
  // Telegram Business (the owner's private chats, read-only): updates from n8n, and the assistant's tools.
  const stopMedia = startMediaLibrary();
  const stopArchive = startArchiveDownloads();
  app.addHook('onClose', async () => stopArchive());
  app.addHook('onClose', async () => stopMedia());
  const stopBiz = startBusinessReminders();
  app.addHook('onClose', async () => stopBiz());
  app.post<{ Body: TgUpdate }>('/business/update', { bodyLimit: 256 * 1024 }, async (req) => handleBusinessUpdate(req.body ?? {}));
  app.get<{ Querystring: { min?: string } }>('/business/unanswered', async (req) => ({ ...businessStatus(), chats: unanswered(Number(req.query.min) || 0) }));
  app.get<{ Querystring: { q?: string; limit?: string } }>('/business/chat', async (req, reply) => chatHistory(String(req.query.q ?? ''), Number(req.query.limit) || 20) ?? reply.code(404).send({ error: 'no_such_chat' }));
  app.post<{ Body: { q?: string; muted?: boolean } }>('/business/mute', async (req, reply) => setMuted(String(req.body?.q ?? ''), req.body?.muted !== false) ?? reply.code(404).send({ error: 'no_such_chat' }));
  app.post<{ Body: { hours?: number } }>('/business/remind', async (req) => {
    setRemindHours(Number(req.body?.hours) || 0);
    return businessStatus();
  });
  // Trade Bot (paper trading): status/stats and its commands, for the assistant's trade_bot tool.
  app.get('/tradebot', async (_req, reply) => tradebotSnapshot() ?? reply.code(503).send({ error: 'tradebot_not_running' }));
  app.post<{ Body: Record<string, unknown> }>('/tradebot/command', async (req, reply) => {
    const r = tradebotCommand({ ...(req.body ?? {}), cmd: String(req.body?.cmd ?? '') });
    return r.ok ? r : reply.code(422).send(r);
  });
  app.post('/monitor-alert', { bodyLimit: 64 * 1024, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => monitorAlert(req.body));
  app.post('/transcribe', { bodyLimit: 25 * 1024 * 1024, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = req.body as Buffer | undefined;
    if (!Buffer.isBuffer(body) || body.length < 100) return reply.code(400).send({ error: 'no_audio' });
    try {
      const text = await transcribe(body);
      return { text };
    } catch (e) {
      return reply.code(422).send({ error: (e as Error).message.slice(0, 200) });
    }
  });
  app.post<{ Body: { url?: string; audio?: boolean } }>('/download', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    try {
      return publicView(await startDownload(String(req.body?.url ?? ''), req.body?.audio === true));
    } catch (e) {
      return reply.code(422).send({ error: (e as Error).message });
    }
  });
  app.get('/downloads', async () => ({ downloads: listDownloads(10) }));
  app.get<{ Params: { id: string } }>('/downloads/:id', async (req, reply) => getDownload(Number(req.params.id)) ?? reply.code(404).send({ error: 'not_found' }));
  app.get('/prayer', async (_req, reply) => prayerTimes().catch((e) => reply.code(502).send({ error: (e as Error).message })));
  app.get<{ Querystring: { lang?: string; limit?: string } }>('/news', async (req) => news(req.query.lang === 'en' || req.query.lang === 'all' ? req.query.lang : 'ar', Number(req.query.limit) || 15));
  app.get('/prices', async (_req, reply) => marketPrices().catch((e) => reply.code(502).send({ error: (e as Error).message })));
  app.post<{ Body: { name?: string; action?: string } }>('/actions/container', async (req, reply) => {
    try {
      return await proposeContainerAction(String(req.body?.name ?? ''), String(req.body?.action ?? ''));
    } catch (e) {
      return reply.code(422).send({ error: (e as Error).message });
    }
  });
  // A smaller copy of a photo for the vision model; with ?save=1 the original also goes to files/Telegram
  // (its path comes back in the X-Saved-Path header).
  app.post<{ Querystring: { save?: string; name?: string } }>('/image/fit', { bodyLimit: 25 * 1024 * 1024 }, async (req, reply) => {
    const body = req.body as Buffer | undefined;
    if (!Buffer.isBuffer(body) || !body.length) return reply.code(400).send({ error: 'no_file' });
    if (req.query.save === '1') {
      const saved = await saveIncoming(body, String(req.query.name ?? '') || `photo-${Date.now()}.jpg`).catch(() => null);
      if (saved) reply.header('X-Saved-Path', encodeURI(saved.path));
    }
    // Not a picture after all (e.g. a DWG named .jpg): say what it is, and hand the model a blank
    // stand-in so the request still works.
    const kind = sniffType(body);
    if (kind && !kind.image) return reply.header('X-File-Type', kind.ext).type('image/png').send(BLANK_PNG);
    try {
      return reply.type('image/jpeg').send(await fitImage(body));
    } catch {
      return reply.header('X-File-Type', kind?.ext ?? 'unknown').type('image/png').send(BLANK_PNG);
    }
  });
  app.post<{ Body: { path?: string; folder?: string; mode?: string; name?: string } }>('/files/move', async (req, reply) => fileTo(req.body ?? {}).catch((e) => reply.code(422).send({ error: (e as Error).message })));
  // Every photo/document the owner sends is kept here briefly, so an ERP draft can carry it.
  app.post<{ Querystring: { name?: string } }>('/erp/stash', { bodyLimit: 15 * 1024 * 1024 }, async (req, reply) => {
    const body = req.body as Buffer | undefined;
    if (!Buffer.isBuffer(body) || !body.length) return reply.code(400).send({ error: 'no_file' });
    return stashIncoming(body, String(req.query.name ?? ''));
  });
  // GRERPS change → ✅ confirmation on Telegram (bot/erpWrite.ts). Fields flat in the body, or as a JSON string in `fields`.
  app.post<{ Body: Record<string, unknown> }>('/erp/change', async (req) => {
    const { operation, fields, ...rest } = req.body ?? {};
    let f: Record<string, unknown> = rest;
    if (typeof fields === 'string' && fields.trim()) {
      try {
        f = { ...rest, ...JSON.parse(fields) };
      } catch {
        return { ok: false, needsInput: true, message: 'fields must be a JSON object string' };
      }
    } else if (fields && typeof fields === 'object') f = { ...rest, ...(fields as Record<string, unknown>) };
    return proposeErpChange(String(operation ?? ''), f);
  });
  app.post<{ Params: { token: string; answer: string } }>('/actions/:token/:answer', async (req) => decide(req.params.token, req.params.answer === 'yes'));
  app.get('/tailscale', async () => {
    const t = await tailscale();
    if (!t) return { error: 'tailscale_unavailable' };
    const p = t.peers as { name: string; online: boolean; ip: string; os?: string; link?: string; lastSeen?: string }[];
    return { self: t.self.name, online: p.filter((x) => x.online).map((x) => ({ name: x.name, ip: x.ip, os: x.os, link: x.link })), offline: p.filter((x) => !x.online).map((x) => ({ name: x.name, lastSeen: x.lastSeen })) };
  });
  // A real download/upload test (~25 MB): rate-limited.
  app.get('/speedtest', { config: { rateLimit: { max: 3, timeWindow: '10 minutes' } } }, async (_req, reply) => internetSpeed().catch((e) => reply.code(502).send({ error: (e as Error).message })));
  const fail = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, e: unknown) => reply.code(422).send({ error: (e as Error).message });
  app.get<{ Querystring: { q?: string } }>('/files/search', async (req) => findFiles(String(req.query.q ?? '')));
  app.get<{ Querystring: { path?: string } }>('/files/raw', async (req, reply) => {
    try {
      const abs = rawFile(String(req.query.path ?? ''));
      return reply.type('application/octet-stream').header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(abs))}`).send(fs.createReadStream(abs));
    } catch (e) {
      return fail(reply, e);
    }
  });
  app.post<{ Body: { path?: string } }>('/files/send', async (req, reply) => sendFile(String(req.body?.path ?? '')).catch((e) => fail(reply, e)));
  app.post<{ Body: { path?: string } }>('/files/text', async (req, reply) => {
    try {
      const abs = rawFile(String(req.body?.path ?? ''));
      return { name: path.basename(abs), text: await extractText(abs) };
    } catch (e) {
      return fail(reply, e);
    }
  });
  app.post<{ Body: { path?: string; days?: number } }>('/share', async (req, reply) => {
    try {
      return shareLink(String(req.body?.path ?? ''), Number(req.body?.days) || 7);
    } catch (e) {
      return fail(reply, e);
    }
  });
  app.post<{ Querystring: { name?: string } }>('/files/save', { bodyLimit: 25 * 1024 * 1024 }, async (req, reply) => {
    const body = req.body as Buffer | undefined;
    if (!Buffer.isBuffer(body) || !body.length) return reply.code(400).send({ error: 'no_file' });
    return saveIncoming(body, String(req.query.name ?? '')).catch((e) => fail(reply, e));
  });
  // Personal helpers: one endpoint each, with an "action" (add / list / cancel / done…).
  const wrap = (fn: (b: Record<string, unknown>) => unknown) => async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      return await fn((req.body ?? {}) as Record<string, unknown>);
    } catch (e) {
      return reply.code(422).send({ error: (e as Error).message });
    }
  };
  app.post('/reminders', wrap(reminders));
  app.post('/notes', wrap(notes));
  app.post('/price-alerts', wrap(priceAlerts));
  app.post('/prayer-reminders', wrap(prayerReminders));
  app.get<{ Querystring: { url?: string } }>('/video-text', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req, reply) => {
    try {
      return await videoText(String(req.query.url ?? ''));
    } catch (e) {
      return reply.code(422).send({ error: (e as Error).message.slice(0, 300) });
    }
  });
  app.post<{ Body: { text?: string } }>('/tts', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    try {
      return reply.type('audio/ogg').header('Content-Disposition', 'attachment; filename="reply.ogg"').send(await speak(String(req.body?.text ?? '')));
    } catch (e) {
      return reply.code(422).send({ error: (e as Error).message });
    }
  });
  app.get<{ Querystring: { topic?: string } }>('/erp', async (req, reply) => {
    try {
      return erp(String(req.query.topic ?? 'overview'));
    } catch (e) {
      return reply.code(422).send({ error: (e as Error).message });
    }
  });
  // Formatting for Telegram (replaces n8n Code nodes, whose task runner can hang).
  app.post<{ Body: { output?: string; heard?: string } }>('/format', async (req) => formatReply(String(req.body?.output ?? ''), String(req.body?.heard ?? '')));
  app.post<{ Body: Record<string, unknown> }>('/format-event', async (req) => formatEvent((req.body ?? {}) as Record<string, unknown>));
  app.post('/memory', wrap(memory));
  app.get('/memory/text', async () => ({ text: memoryText() }));
  app.get('/status', async () => botStatus());
  app.get('/containers', async () => ({ containers: await containers() }));
  app.get<{ Querystring: { url?: string; max?: string } }>('/read', async (req, reply) => {
    try {
      return await readPage(String(req.query.url ?? ''), Math.min(Number(req.query.max) || 8000, 20000));
    } catch (e) {
      return reply.code(422).send({ error: (e as Error).message });
    }
  });
  app.get('/disks', async () => ({ storage: (await botStatus()).storage, health: latestDiskHealth() }));
  return app;
}

/** MinisManager side: turn the bot token on (rotate) or off. */
export async function botRoutes(app: FastifyInstance) {
  if (!process.env.VITEST) {
    const stop = startPersonalLoop();
    app.addHook('onClose', async () => stop());
  }
  app.get('/api/bot', { preHandler: requireAuth }, async () => ({ enabled: !!kvGet(KEY) }));
  app.post('/api/bot/token', { preHandler: requireElevated }, async (req) => {
    audit(req.session!.userId, 'bot.token');
    return { token: rotateBotToken() };
  });
  app.delete('/api/bot/token', { preHandler: requireElevated }, async (req) => {
    audit(req.session!.userId, 'bot.revoke');
    revokeBotToken();
    return { ok: true };
  });
}
