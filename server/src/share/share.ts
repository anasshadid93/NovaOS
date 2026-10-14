import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { config } from '../config.js';
import { audit, getDb, kvGet, kvSet } from '../db.js';
import { requireAuth, requireElevated } from '../auth/sessions.js';
import { hashPassword, verifyPassword } from '../auth/crypto.js';
import { categoryOf } from '../files/files.js';
import { FsError, relOf, resolveInRoot, thumbnail } from '../files/fsops.js';
import { MIME, sendFile } from '../files/routes.js';
import { registerDropPublic } from './dropbox.js';

/**
 * Share links. NovaOS (tailnet only) creates them; a second, tiny server on
 * 127.0.0.1:7475 serves *only* the shared files, and that one is published on the internet
 * (VPS Traefik → the server over Tailscale). It has no login, no API, no scripts: a link is a random
 * token, optionally with a password and an expiry, and it can never reach outside its folder.
 */

interface Share {
  id: number;
  token: string;
  path: string;
  is_dir: number;
  password_hash: string | null;
  expires_at: number | null;
  views: number;
  downloads: number;
  last_access: number | null;
  created_at: number;
}

export const EXPIRY_DAYS = [1, 7, 30, 90] as const;
const TOKEN_RE = /^[\w-]{22}$/;
const UNLOCK_MS = 12 * 3600_000;
const MAX_LIST = 2000;

export const shareUrl = (token: string) => `${config.shareBase}/s/${token}`;

function secret(): Buffer {
  let s = kvGet('share_secret');
  if (!s) kvSet('share_secret', (s = crypto.randomBytes(32).toString('base64url')));
  return Buffer.from(s, 'base64url');
}
const mac = (body: string) => crypto.createHmac('sha256', secret()).update(body).digest('base64url');

/** Cookie proving the password was entered: `<expires>.<hmac(id.token.expires)>`. */
export function signUnlock(s: Pick<Share, 'id' | 'token'>, now = Date.now()): string {
  const exp = now + UNLOCK_MS;
  return `${exp}.${mac(`${s.id}.${s.token}.${exp}`)}`;
}
export function checkUnlock(s: Pick<Share, 'id' | 'token'>, value: string | undefined, now = Date.now()): boolean {
  const m = /^(\d{13})\.([\w-]{43})$/.exec(value ?? '');
  if (!m || Number(m[1]) < now) return false;
  const want = Buffer.from(mac(`${s.id}.${s.token}.${m[1]}`));
  const got = Buffer.from(m[2]);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

function findShare(token: string): Share | null {
  if (!TOKEN_RE.test(token)) return null;
  const s = getDb().prepare('SELECT * FROM shares WHERE token = ?').get(token) as Share | undefined;
  if (!s || (s.expires_at !== null && s.expires_at < Date.now())) return null;
  return s;
}

/**
 * `sub` (from the URL) inside the share → absolute path. Hidden names are refused and the real
 * path (symlinks followed) must stay inside the shared folder.
 */
export function resolveInShare(s: Pick<Share, 'path' | 'is_dir'>, sub: string): string {
  const base = resolveInRoot(s.path);
  if (!s.is_dir) {
    if (sub) throw new FsError(404, 'not_found');
    return base;
  }
  const parts = sub.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.some((p) => p === '..' || p === '.' || p.startsWith('.') || p.includes('\0'))) throw new FsError(404, 'not_found');
  const abs = path.join(base, ...parts);
  let real: string;
  try {
    real = fs.realpathSync(abs);
  } catch {
    throw new FsError(404, 'not_found');
  }
  if (real !== base && !real.startsWith(base + path.sep)) throw new FsError(404, 'not_found');
  return real;
}

// ---------------------------------------------------------------------------------------------
// The public pages (server-rendered, no JavaScript).

type Lang = 'ar' | 'en';
const STR = {
  en: {
    notFound: 'This link has expired or does not exist.',
    password: 'This link is protected. Enter the password to continue.',
    wrong: 'Wrong password.',
    open: 'Open',
    download: 'Download',
    downloadAll: 'Download all (ZIP)',
    expires: 'Link expires',
    empty: 'This folder is empty.',
    tooMany: 'Showing the first {n} items.',
    footer: 'Shared from NovaOS',
    back: 'Back',
  },
  ar: {
    notFound: 'هالرابط انتهى أو مش موجود.',
    password: 'هالرابط محمي. اكتب كلمة السر لتكمّل.',
    wrong: 'كلمة السر غلط.',
    open: 'افتح',
    download: 'نزّل',
    downloadAll: 'نزّل الكل (ZIP)',
    expires: 'الرابط بينتهي',
    empty: 'هالمجلد فاضي.',
    tooMany: 'عم نعرض أول {n} عنصر.',
    footer: 'مشارك من NovaOS',
    back: 'رجوع',
  },
} satisfies Record<Lang, Record<string, string>>;

export const langOf = (req: FastifyRequest): Lang => (/^\s*ar\b/i.test(String(req.headers['accept-language'] ?? '')) ? 'ar' : 'en');
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`);
// Simple drawn icons (inline SVG: no emoji fonts needed, nothing loaded from elsewhere).
const svg = (body: string, color: string, size = 44) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const DOC = '<path d="M6 2.5h8l4 4V21a.5.5 0 0 1-.5.5h-11A.5.5 0 0 1 6 21z"/><path d="M14 2.5v4h4"/>';
const ICON: Record<string, string> = {
  dir: svg('<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2h9A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" fill="#fbbf24" stroke="#d97706"/>', '#d97706'),
  audio: svg('<path d="M9 18V5l11-2v13"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>', '#db2777'),
  videos: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3z"/>', '#7c3aed'),
  images: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 17-5-5-9 8"/>', '#0284c7'),
  archives: svg(DOC + '<path d="M11 8h1M11 11h1M11 14h1"/>', '#a16207'),
  others: svg(DOC, '#475569'),
};
const LOCK = svg('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>', '#2563eb', 40);
const DL = svg('<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>', 'currentColor', 18);

const CSS = `*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans Arabic",sans-serif;background:#f3f6fb;color:#0f172a}
main{max-width:960px;margin:0 auto;padding:24px 16px 48px}h1{font-size:20px;margin:0 0 4px;word-break:break-word}.muted{color:#64748b;font-size:13px}
.card{background:#fff;border-radius:16px;box-shadow:0 1px 3px rgb(15 23 42/.08);padding:16px;margin-top:16px}
.btn{display:inline-flex;align-items:center;gap:6px;background:#2563eb;color:#fff;border:0;border-radius:12px;padding:10px 18px;font:inherit;font-weight:600;text-decoration:none;cursor:pointer}
.btn.soft{background:#e0e9fb;color:#1e3a8a}.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}
.item{display:block;text-decoration:none;color:inherit;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgb(15 23 42/.08)}
.thumb{aspect-ratio:1;display:flex;align-items:center;justify-content:center;font-size:42px;background:#eef2f8}.thumb img{width:100%;height:100%;object-fit:cover}
.name{padding:8px 10px 2px;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.size{padding:0 10px 8px;font-size:12px;color:#64748b}
.preview{display:flex;justify-content:center;background:#0b1220;border-radius:12px;overflow:hidden}.preview img,.preview video{max-width:100%;max-height:75vh}
audio{width:100%}input[type=password]{width:100%;padding:12px;border:1px solid #cbd5e1;border-radius:12px;font:inherit;margin:12px 0}
.err{color:#dc2626}.crumbs a{color:#2563eb;text-decoration:none}footer{text-align:center;margin-top:32px}
@media (prefers-color-scheme:dark){body{background:#0b1220;color:#e2e8f0}.card,.item{background:#111a2e}.thumb{background:#16213a}.btn.soft{background:#1e2b4a;color:#c7d7fb}input[type=password]{background:#0b1220;color:inherit;border-color:#334155}}`;

export function page(lang: Lang, title: string, body: string) {
  return `<!doctype html><html lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title><style>${CSS}</style></head><body><main>${body}<footer class="muted">${esc(STR[lang].footer)}</footer></main></body></html>`;
}

const q = (sub: string) => (sub ? `?p=${encodeURIComponent(sub)}` : '');
const fileHref = (s: Share, sub: string, dl = false) => `/s/${s.token}/f${q(sub)}${dl ? `${sub ? '&' : '?'}dl=1` : ''}`;

function expiresLine(s: Share, lang: Lang) {
  if (!s.expires_at) return '';
  const when = new Intl.DateTimeFormat(lang === 'ar' ? 'ar' : 'en', { dateStyle: 'medium', timeStyle: 'short', timeZone: config.timezone }).format(s.expires_at);
  return `<p class="muted">${esc(STR[lang].expires)}: ${esc(when)}</p>`;
}

function filePage(s: Share, sub: string, abs: string, lang: Lang) {
  const t = STR[lang];
  const name = path.basename(abs);
  const st = fs.statSync(abs);
  const cat = categoryOf(name);
  const inline = !!MIME[path.extname(name).slice(1).toLowerCase()];
  const src = esc(fileHref(s, sub));
  const preview =
    inline && cat === 'images'
      ? `<div class="preview"><img src="${src}" alt=""></div>`
      : inline && cat === 'videos'
        ? `<div class="preview"><video src="${src}" controls playsinline preload="metadata"></video></div>`
        : inline && cat === 'audio'
          ? `<audio src="${src}" controls preload="metadata"></audio>`
          : '';
  const parent = sub.split('/').slice(0, -1).join('/');
  return page(
    lang,
    name,
    `${s.is_dir ? `<p class="crumbs"><a href="/s/${s.token}${q(parent)}">${lang === 'ar' ? '›' : '‹'} ${esc(t.back)}</a></p>` : ''}
<h1 dir="auto">${esc(name)}</h1><p class="muted">${fmtSize(st.size)}</p>${expiresLine(s, lang)}
${preview ? `<div class="card">${preview}</div>` : ''}
<div class="row" style="margin-top:16px"><a class="btn" href="${esc(fileHref(s, sub, true))}">${DL} ${esc(t.download)}</a>${inline && !preview ? `<a class="btn soft" href="${src}">${esc(t.open)}</a>` : ''}</div>`,
  );
}

function folderPage(s: Share, sub: string, abs: string, lang: Lang) {
  const t = STR[lang];
  const rootName = path.basename(resolveInRoot(s.path));
  const entries = fs
    .readdirSync(abs, { withFileTypes: true })
    .filter((e) => !e.name.startsWith('.') && (e.isDirectory() || e.isFile()))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  const shown = entries.slice(0, MAX_LIST);
  const items = shown
    .map((e) => {
      const p = sub ? `${sub}/${e.name}` : e.name;
      if (e.isDirectory()) return `<a class="item" href="/s/${s.token}${esc(q(p))}"><div class="thumb">${ICON.dir}</div><div class="name" dir="auto">${esc(e.name)}</div><div class="size">&nbsp;</div></a>`;
      const cat = categoryOf(e.name);
      let size = 0;
      try {
        size = fs.statSync(path.join(abs, e.name)).size;
      } catch {
        /* vanished */
      }
      const thumb = cat === 'images' || cat === 'videos' ? `<img loading="lazy" src="/s/${s.token}/thumb${esc(q(p))}" alt="">` : (ICON[cat] ?? ICON.others);
      return `<a class="item" href="/s/${s.token}/v${esc(q(p))}"><div class="thumb">${thumb}</div><div class="name" dir="auto">${esc(e.name)}</div><div class="size">${fmtSize(size)}</div></a>`;
    })
    .join('');
  const parts = sub ? sub.split('/') : [];
  const crumbs = [`<a href="/s/${s.token}">${esc(rootName)}</a>`, ...parts.map((p, i) => (i === parts.length - 1 ? esc(p) : `<a href="/s/${s.token}${esc(q(parts.slice(0, i + 1).join('/')))}">${esc(p)}</a>`))].join(' / ');
  return page(
    lang,
    parts.at(-1) ?? rootName,
    `<h1 dir="auto" style="display:flex;align-items:center;gap:8px">${ICON.dir.replace(/44/g, '28')}${esc(parts.at(-1) ?? rootName)}</h1>${parts.length ? `<p class="crumbs muted" dir="auto">${crumbs}</p>` : ''}${expiresLine(s, lang)}
<div class="row" style="margin:12px 0 16px">${entries.length ? `<a class="btn" href="/s/${s.token}/zip${esc(q(sub))}">${DL} ${esc(t.downloadAll)}</a>` : ''}</div>
${entries.length ? `<div class="grid">${items}</div>` : `<div class="card muted">${esc(t.empty)}</div>`}
${entries.length > MAX_LIST ? `<p class="muted">${esc(t.tooMany.replace('{n}', String(MAX_LIST)))}</p>` : ''}`,
  );
}

function passwordPage(s: Share, lang: Lang, wrong: boolean) {
  const t = STR[lang];
  return page(
    lang,
    'NovaOS',
    `<div class="card" style="max-width:420px;margin:12vh auto 0">${LOCK}<p>${esc(t.password)}</p>${wrong ? `<p class="err">${esc(t.wrong)}</p>` : ''}
<form method="post" action="/s/${s.token}/unlock"><input type="password" name="password" autocomplete="current-password" required autofocus><button class="btn" type="submit">${esc(t.open)}</button></form></div>`,
  );
}

/** Python's zipfile streams to a pipe (no temp file, ZIP64 for big files); hidden files and symlinks are left out. */
const ZIP_PY = `import os,sys,zipfile
root=sys.argv[1];base=os.path.basename(root.rstrip('/'))
z=zipfile.ZipFile(sys.stdout.buffer,'w',zipfile.ZIP_STORED,allowZip64=True)
for d,ds,fs in os.walk(root):
  ds[:]=sorted(x for x in ds if not x.startswith('.') and not os.path.islink(os.path.join(d,x)))
  for n in sorted(fs):
    p=os.path.join(d,n)
    if n.startswith('.') or os.path.islink(p) or not os.path.isfile(p): continue
    try: z.write(p,os.path.join(base,os.path.relpath(p,root)))
    except OSError: pass
z.close()`;

/** The client's IP as Traefik saw it (last X-Forwarded-For hop), for rate limiting. */
export function clientIp(req: FastifyRequest): string {
  const xff = String(req.headers['x-forwarded-for'] ?? '');
  return xff.split(',').pop()?.trim() || req.ip;
}

export async function buildShareServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: 'warn' }, bodyLimit: 4096 });
  await app.register(cookie);
  await app.register(rateLimit, { global: true, max: 600, timeWindow: '1 minute', keyGenerator: clientIp });
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body)))));

  app.addHook('onRequest', async (req, reply) => {
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') return reply.code(405).send();
  });
  app.addHook('onSend', async (_req, reply, payload) => {
    if (!reply.getHeader('Content-Security-Policy'))
      reply.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; media-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Robots-Tag', 'noindex, nofollow');
    reply.header('X-Frame-Options', 'DENY');
    return payload;
  });
  app.setNotFoundHandler((req, reply) => reply.code(404).type('text/html; charset=utf-8').send(page(langOf(req), '404', `<div class="card" style="text-align:center;margin-top:12vh">${ICON.others}<p>${esc(STR[langOf(req)].notFound)}</p></div>`)));
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof FsError || (err as { statusCode?: number }).statusCode === 404) return reply.callNotFound();
    if ((err as { statusCode?: number }).statusCode === 429) return reply.code(429).send('Too many requests');
    req.log.error({ err }, 'share error');
    return reply.code(500).send('Error');
  });

  const cookieName = (s: Share) => `sh${s.id}`;
  type Req = FastifyRequest<{ Params: { token: string }; Querystring: { p?: string; dl?: string } }>;
  /** The share for this request, or null after replying (missing → 404, locked → password form). */
  const open = (req: Req, reply: FastifyReply): Share | null => {
    const s = findShare(req.params.token);
    if (!s) {
      void reply.callNotFound();
      return null;
    }
    if (s.password_hash && !checkUnlock(s, req.cookies[cookieName(s)])) {
      void reply.code(200).header('Cache-Control', 'no-store').type('text/html; charset=utf-8').send(passwordPage(s, langOf(req), false));
      return null;
    }
    return s;
  };
  const touch = (s: Share, field: 'views' | 'downloads') => getDb().prepare(`UPDATE shares SET ${field} = ${field} + 1, last_access = ? WHERE id = ?`).run(Date.now(), s.id);

  registerDropPublic(app);

  app.get('/', async (_req, reply) => reply.callNotFound());
  app.get('/robots.txt', async (_req, reply) => reply.type('text/plain').send('User-agent: *\nDisallow: /\n'));

  // The share: a file page, or a folder (?p= for subfolders).
  app.get('/s/:token', async (req: Req, reply) => {
    const s = open(req, reply);
    if (!s) return reply;
    const sub = req.query.p ?? '';
    const abs = resolveInShare(s, sub);
    touch(s, 'views');
    reply.header('Cache-Control', 'no-store').type('text/html; charset=utf-8');
    return fs.statSync(abs).isDirectory() ? folderPage(s, sub, abs, langOf(req)) : filePage(s, sub, abs, langOf(req));
  });
  // A file inside a shared folder.
  app.get('/s/:token/v', async (req: Req, reply) => {
    const s = open(req, reply);
    if (!s) return reply;
    const sub = req.query.p ?? '';
    const abs = resolveInShare(s, sub);
    if (fs.statSync(abs).isDirectory()) return reply.redirect(`/s/${s.token}${q(sub)}`, 302);
    return reply.header('Cache-Control', 'no-store').type('text/html; charset=utf-8').send(filePage(s, sub, abs, langOf(req)));
  });
  app.get('/s/:token/f', async (req: Req, reply) => {
    const s = open(req, reply);
    if (!s) return reply;
    const abs = resolveInShare(s, req.query.p ?? '');
    const download = req.query.dl === '1';
    const range = req.headers.range;
    if (download && (!range || /^bytes=0-/.test(range))) touch(s, 'downloads');
    return sendFile(reply, abs, range, download);
  });
  app.get('/s/:token/thumb', async (req: Req, reply) => {
    const s = open(req, reply);
    if (!s) return reply;
    const file = await thumbnail(relOf(resolveInShare(s, req.query.p ?? '')));
    return reply.header('Cache-Control', 'private, max-age=86400').type('image/jpeg').send(fs.createReadStream(file));
  });
  app.get('/s/:token/zip', async (req: Req, reply) => {
    const s = open(req, reply);
    if (!s) return reply;
    const abs = resolveInShare(s, req.query.p ?? '');
    if (!fs.statSync(abs).isDirectory()) return reply.callNotFound();
    touch(s, 'downloads');
    const py = spawn('python3', ['-I', '-c', ZIP_PY, abs], { stdio: ['ignore', 'pipe', 'ignore'] });
    req.raw.on('close', () => py.exitCode === null && py.kill());
    return reply
      .header('Content-Type', 'application/zip')
      .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(abs))}.zip`)
      .header('Cache-Control', 'no-store')
      .send(py.stdout);
  });
  app.post<{ Params: { token: string }; Body: { password?: string } }>(
    '/s/:token/unlock',
    { config: { rateLimit: { max: 8, timeWindow: '1 minute', keyGenerator: clientIp } } },
    async (req, reply) => {
      const s = findShare(req.params.token);
      if (!s) return reply.callNotFound();
      const pw = String(req.body?.password ?? '').slice(0, 200);
      if (!s.password_hash || !(await verifyPassword(pw, s.password_hash)))
        return reply.code(200).header('Cache-Control', 'no-store').type('text/html; charset=utf-8').send(passwordPage(s, langOf(req), true));
      const secure = req.headers['x-forwarded-proto'] === 'https';
      reply.setCookie(cookieName(s), signUnlock(s), { path: `/s/${s.token}`, httpOnly: true, secure, sameSite: 'lax', maxAge: UNLOCK_MS / 1000 });
      return reply.redirect(`/s/${s.token}`, 303);
    },
  );
  return app;
}

/** A link for a file created by NovaOS itself (e.g. a finished download). */
export function createShareFor(rel: string, days: number, userId: number | null = null): string {
  const abs = resolveInRoot(rel);
  const token = crypto.randomBytes(16).toString('base64url');
  const now = Date.now();
  getDb()
    .prepare('INSERT INTO shares(token, path, is_dir, password_hash, expires_at, created_by, created_at) VALUES(?, ?, ?, NULL, ?, ?, ?)')
    .run(token, relOf(abs), fs.statSync(abs).isDirectory() ? 1 : 0, now + days * 86400_000, userId, now);
  return shareUrl(token);
}

// ---------------------------------------------------------------------------------------------
// NovaOS side: create, list, remove.

export async function shareRoutes(app: FastifyInstance) {
  app.get('/api/shares', { preHandler: requireAuth }, async () => {
    const rows = getDb().prepare('SELECT * FROM shares ORDER BY created_at DESC').all() as unknown as Share[];
    const now = Date.now();
    return {
      base: config.shareBase,
      shares: rows.map((s) => {
        let exists = true;
        try {
          resolveInRoot(s.path);
        } catch {
          exists = false;
        }
        return { id: s.id, url: shareUrl(s.token), path: s.path, name: path.basename(s.path), isDir: !!s.is_dir, hasPassword: !!s.password_hash, expiresAt: s.expires_at, expired: s.expires_at !== null && s.expires_at < now, views: s.views, downloads: s.downloads, lastAccess: s.last_access, createdAt: s.created_at, exists };
      }),
    };
  });

  // Making something public: needs a recent sign-in confirmation.
  app.post<{ Body: { path: string; expiresDays?: number | null; password?: string } }>('/api/shares', { preHandler: requireElevated }, async (req, reply) => {
    const { path: rel, expiresDays = 7, password } = req.body ?? ({} as never);
    if (typeof rel !== 'string' || !rel.replace(/\/+/g, '')) return reply.code(400).send({ error: 'bad_path' });
    if (expiresDays !== null && !(EXPIRY_DAYS as readonly number[]).includes(expiresDays)) return reply.code(400).send({ error: 'bad_expiry' });
    if (password !== undefined && password !== '' && (typeof password !== 'string' || password.length < 4 || password.length > 128)) return reply.code(400).send({ error: 'bad_password' });
    let abs: string;
    try {
      abs = resolveInRoot(rel);
    } catch (e) {
      if (e instanceof FsError) return reply.code(e.status).send({ error: e.code });
      throw e;
    }
    const st = fs.statSync(abs);
    if (!st.isFile() && !st.isDirectory()) return reply.code(400).send({ error: 'bad_path' });
    const token = crypto.randomBytes(16).toString('base64url');
    const now = Date.now();
    const r = getDb()
      .prepare('INSERT INTO shares(token, path, is_dir, password_hash, expires_at, created_by, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)')
      .run(token, relOf(abs), st.isDirectory() ? 1 : 0, password ? await hashPassword(password) : null, expiresDays === null ? null : now + expiresDays * 86400_000, req.session!.userId, now);
    audit(req.session!.userId, 'share.create', { path: relOf(abs), expiresDays, password: !!password });
    return { id: Number(r.lastInsertRowid), url: shareUrl(token) };
  });

  app.delete<{ Params: { id: string } }>('/api/shares/:id', { preHandler: requireAuth }, async (req) => {
    getDb().prepare('DELETE FROM shares WHERE id = ?').run(Number(req.params.id));
    audit(req.session!.userId, 'share.delete', { id: Number(req.params.id) });
    return { ok: true };
  });

  // Expired links are kept a week (so they still show as "expired"), then removed.
  const prune = () => getDb().prepare('DELETE FROM shares WHERE expires_at IS NOT NULL AND expires_at < ?').run(Date.now() - 7 * 86400_000);
  prune();
  const t = setInterval(prune, 6 * 3600_000);
  t.unref();
  app.addHook('onClose', async () => clearInterval(t));
}
