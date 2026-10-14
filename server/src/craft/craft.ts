import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { allowedOrigins, config } from '../config.js';
import { loadSession, requireAuth } from '../auth/sessions.js';
import { getDb, kvGet, kvSet } from '../db.js';

/**
 * ArtCraft "Crafting Apps" (PhotoCraft, VectorCraft, …): static WebAssembly builds kept in
 * ~/ArtCraft/<id>/web by ~/ArtCraft/update.sh.
 *
 * They are third-party code, so they are served from their own origin (a separate port,
 * https://<host>:7444) and never from MinisManager's: a page there can't read or call
 * MinisManager's API (cross-origin, and the API's Origin check rejects it).
 *
 * Login: the launcher links carry a short-lived signed ticket (`?t=`). The app server swaps it
 * for its own cookie, so the apps also open in a browser that doesn't share MinisManager's
 * cookies (an installed PWA opens links in a separate browser on phones).
 */

export interface CraftApp {
  id: string;
  title: string;
  description: string;
  version: string;
}

const ID_RE = /^[a-z][a-z0-9-]{1,40}$/;

export function craftApps(): CraftApp[] {
  let dirs: string[];
  try {
    dirs = fs.readdirSync(config.craftRoot);
  } catch {
    return [];
  }
  const out: CraftApp[] = [];
  for (const id of dirs.sort()) {
    if (!ID_RE.test(id) || !fs.existsSync(path.join(config.craftRoot, id, 'web', 'index.html'))) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(config.craftRoot, id, 'app.json'), 'utf8')) as Partial<CraftApp>;
      out.push({ id, title: meta.title ?? id, description: meta.description ?? '', version: meta.version ?? '' });
    } catch {
      out.push({ id, title: id, description: '', version: '' });
    }
  }
  return out;
}

/** app.json flags: `mobile` (a phone-first page: no forced desktop layout or GPU check),
 *  `writable` (the page may save JSON files to <app>/data/ — e.g. a takeoff the owner edits by touch) and
 *  `connect` (extra https:/wss: origins this one app may fetch from, e.g. a market-price feed). */
function appMeta(id: string): { mobile?: boolean; writable?: boolean; connect?: unknown } {
  try {
    return JSON.parse(fs.readFileSync(path.join(config.craftRoot, id, 'app.json'), 'utf8'));
  } catch {
    return {};
  }
}
const DATA_RE = /^\/([a-z][a-z0-9-]{1,40})\/data\/([A-Za-z0-9_-]{1,60})\.json$/;
const DATA_MAX = 4 * 1024 * 1024;
const DATA_BACKUPS = 30;

// Links sit in an open launcher for a while; a ticket only logs in to these static apps.
const TICKET_MS = 2 * 3600 * 1000;
const COOKIE_MS = 30 * 24 * 3600 * 1000;
const COOKIE = config.dev ? 'manar_craft' : '__Host-manar_craft';

function secret(): Buffer {
  let s = kvGet('craft_secret');
  if (!s) kvSet('craft_secret', (s = crypto.randomBytes(32).toString('base64url')));
  return Buffer.from(s, 'base64url');
}
const mac = (body: string) => crypto.createHmac('sha256', secret()).update(body).digest('base64url');

/** `<kind>.<userId>.<expires>.<hmac>`; kinds keep a ticket from being used as a cookie and back. */
export function signCraft(kind: 't' | 'c', userId: number, ttlMs: number, now = Date.now()): string {
  const body = `${kind}.${userId}.${now + ttlMs}`;
  return `${body}.${mac(body)}`;
}

export function verifyCraft(kind: 't' | 'c', token: string | undefined, now = Date.now()): number | null {
  const m = /^([tc])\.(\d{1,9})\.(\d{13})\.([\w-]{43})$/.exec(token ?? '');
  if (!m || m[1] !== kind || Number(m[3]) < now) return null;
  const want = Buffer.from(mac(`${m[1]}.${m[2]}.${m[3]}`));
  const got = Buffer.from(m[4]);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  const userId = Number(m[2]);
  return getDb().prepare('SELECT 1 FROM users WHERE id = ?').get(userId) ? userId : null;
}

export const craftUrl = (id: string, userId?: number) => `${config.craftOrigin}/${id}/${userId ? `?t=${signCraft('t', userId, TICKET_MS)}` : ''}`;

const signInPage = (id: string) => `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>MinisManager</title>
<body style="font:16px system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;background:#eef3fb;color:#1a3a7c;text-align:center">
<div><p>Open this app from <b>MinisManager</b> → All apps.</p><p dir="rtl">افتح التطبيق من <b>MinisManager</b> ← كل التطبيقات.</p>
<p><a href="${config.publicOrigin}/launcher" style="display:inline-block;padding:12px 22px;border-radius:12px;background:#2f6fe4;color:#fff;text-decoration:none">MinisManager</a></p>
<p style="font-size:12px;color:#64748b">${id}</p></div></body>`;

const ORIGIN_RE = /^(https|wss):\/\/[a-z0-9.-]{3,100}(:\d{2,5})?$/;
/** The app's own extra connect-src origins (from app.json `connect`), checked one by one. */
export function appConnect(id: string): string[] {
  const c = ID_RE.test(id) ? appMeta(id).connect : undefined;
  return Array.isArray(c) ? c.filter((o): o is string => typeof o === 'string' && ORIGIN_RE.test(o)).slice(0, 8) : [];
}

const CRAFT_CSP = [
  "default-src 'self'",
  // Trunk's loader is an inline module script; the app itself is WebAssembly.
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' data: blob:",
  "worker-src 'self' blob:",
  // Only MinisManager's desktop may show these apps inside its windows.
  `frame-ancestors ${allowedOrigins().join(' ')}`,
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/**
 * The apps are desktop layouts. On a phone they always open in "desktop mode": the page is laid
 * out 1280px wide and the browser scales it to the screen (pinch to zoom in). Desktop browsers
 * ignore the viewport tag, so nothing changes there.
 */
export const DESKTOP_WIDTH = 1280;
export function desktopMode(html: string): string {
  const tag = `<meta name="viewport" content="width=${DESKTOP_WIDTH}">`;
  const out = html.replace(/<meta\s+name=["']viewport["'][^>]*>/i, tag);
  return out === html && !html.includes(tag) ? html.replace(/<head[^>]*>/i, (m) => `${m}\n  ${tag}`) : out;
}

/**
 * The apps ask WebGPU for 8192-pixel textures; many tablet/phone GPUs allow only 4096 and the app
 * then fails to start ("max_texture_dimension_2d … better than allowed"). Before it starts, check
 * the device and fall back to the apps' own WebGL2 mode (`?webgl`) when WebGPU can't do it, or to
 * their CPU mode (`?cpu`, slower but GPU-independent) when WebGL2 can't either.
 */
export const GPU_FALLBACK = `<script>(async()=>{try{const q=new URLSearchParams(location.search);if(q.has('cpu'))return;const need=8192;const gl=()=>{try{const c=document.createElement('canvas').getContext('webgl2');return c?c.getParameter(c.MAX_TEXTURE_SIZE):0}catch(e){return 0}};let mode=null;if(q.has('webgl')){if(gl()<need)mode='cpu'}else{const a=navigator.gpu&&await navigator.gpu.requestAdapter();if(!(a&&a.limits.maxTextureDimension2D>=need))mode=gl()>=need?'webgl':'cpu'}if(!mode)return;q.delete('webgl');q.set(mode,'');location.replace(location.pathname+'?'+q.toString().replace(/=(?=&|$)/g,''))}catch(e){}})()</script>`;

export function patchIndex(html: string): string {
  return desktopMode(html).replace(/<head[^>]*>/i, (m) => `${m}\n  ${GPU_FALLBACK}`);
}

/** The separate server for the apps (127.0.0.1:7472, published as https://<host>:7444). */
export async function buildCraftServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: 'warn' }, trustProxy: '127.0.0.1' });
  await app.register(cookie);
  await app.register(fastifyStatic, { root: config.craftRoot, serve: false, preCompressed: true, cacheControl: false });

  app.addHook('onRequest', async (req, reply) => {
    const url = new URL(req.url, 'http://x');
    const data = DATA_RE.exec(url.pathname);
    if (req.method !== 'GET' && req.method !== 'HEAD' && !(req.method === 'PUT' && data && appMeta(data[1]).writable)) return reply.code(405).send();
    const ticket = url.searchParams.get('t');
    if (ticket !== null) {
      const userId = verifyCraft('t', ticket);
      url.searchParams.delete('t');
      const clean = url.pathname + url.search;
      if (userId) {
        reply.setCookie(COOKIE, signCraft('c', userId, COOKIE_MS), { path: '/', httpOnly: true, secure: !config.dev, sameSite: 'lax', maxAge: COOKIE_MS / 1000 });
        return reply.header('Cache-Control', 'no-store').redirect(clean, 302);
      }
    }
    if (verifyCraft('c', req.cookies[COOKIE]) || loadSession(req)) return;
    const id = url.pathname.split('/')[1] ?? '';
    return reply.code(401).header('Cache-Control', 'no-store').type('text/html; charset=utf-8').send(signInPage(ID_RE.test(id) ? id : ''));
  });
  app.addHook('onSend', async (req, reply, payload) => {
    const extra = appConnect(new URL(req.url, 'http://x').pathname.split('/')[1] ?? '');
    reply.header('Content-Security-Policy', extra.length ? CRAFT_CSP.replace("connect-src 'self' data: blob:", `connect-src 'self' data: blob: ${extra.join(' ')}`) : CRAFT_CSP);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    return payload;
  });

  app.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: DATA_MAX }, (_req, body, done) => done(null, body));
  // Saved state of a writable app (JSON only; the last versions are kept in data/.history).
  app.get('/:id/data/:file', async (req, reply) => {
    const m = DATA_RE.exec(new URL(req.url, 'http://x').pathname);
    const f = m && appMeta(m[1]).writable ? path.join(config.craftRoot, m[1], 'data', `${m[2]}.json`) : null;
    if (!f || !fs.existsSync(f)) return reply.code(404).send({ error: 'not_found' });
    return reply.header('Cache-Control', 'no-store').type('application/json').send(fs.readFileSync(f));
  });
  app.put('/:id/data/:file', async (req, reply) => {
    const m = DATA_RE.exec(new URL(req.url, 'http://x').pathname)!;
    try {
      const v = JSON.parse(String(req.body ?? ''));
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('object');
    } catch {
      return reply.code(400).send({ error: 'json_object_required' });
    }
    const dir = path.join(config.craftRoot, m[1], 'data');
    const hist = path.join(dir, '.history');
    fs.mkdirSync(hist, { recursive: true });
    const f = path.join(dir, `${m[2]}.json`);
    if (fs.existsSync(f)) {
      fs.copyFileSync(f, path.join(hist, `${m[2]}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
      const old = fs.readdirSync(hist).filter((n) => n.startsWith(`${m[2]}-`)).sort();
      for (const n of old.slice(0, Math.max(0, old.length - DATA_BACKUPS))) fs.rmSync(path.join(hist, n), { force: true });
    }
    fs.writeFileSync(`${f}.tmp`, String(req.body));
    fs.renameSync(`${f}.tmp`, f);
    return { ok: true, savedAt: Date.now() };
  });

  app.get('/', async (_req, reply) => reply.redirect(`${config.publicOrigin}/launcher`, 302));
  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => reply.redirect(`/${req.params.id}/`, 301));
  app.get<{ Params: { id: string; '*': string } }>('/:id/*', async (req, reply) => {
    const { id } = req.params;
    const rel = req.params['*'] || 'index.html';
    if (!ID_RE.test(id) || rel.split('/').some((p) => p === '..' || p.startsWith('.'))) return reply.code(404).send('Not found');
    const dir = path.join(config.craftRoot, id, 'web');
    if (!fs.existsSync(path.join(dir, rel))) return reply.code(404).send('Not found');
    const cache = rel === 'index.html' ? 'no-cache' : /-[0-9a-f]{16}(_bg)?\.(wasm|js)$/.test(rel) ? 'public, max-age=31536000, immutable' : 'public, max-age=3600';
    reply.header('Cache-Control', cache);
    if (rel.endsWith('.wasm')) reply.type('application/wasm');
    if (rel === 'index.html') {
      const html = fs.readFileSync(path.join(dir, rel), 'utf8');
      return reply.type('text/html; charset=utf-8').send(appMeta(id).mobile ? html : patchIndex(html));
    }
    return reply.sendFile(rel, dir);
  });
  return app;
}

/** MinisManager-side API: the list (for the launcher) and the icons. */
export async function craftRoutes(app: FastifyInstance) {
  app.get('/api/craft', { preHandler: requireAuth }, async (req) => craftApps().map((a) => ({ ...a, url: craftUrl(a.id, req.session!.userId) })));
  app.get<{ Params: { id: string } }>('/api/icons/craft/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params;
    const file = path.join(config.craftRoot, id, 'icon.webp');
    if (!ID_RE.test(id) || !fs.existsSync(file)) return reply.code(404).send({ error: 'not_found' });
    return reply
      .header('Content-Type', 'image/webp')
      .header('Cache-Control', 'public, max-age=86400')
      .send(fs.readFileSync(file));
  });
}
