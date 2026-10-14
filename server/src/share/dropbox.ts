import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Transform, pipeline } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { audit, getDb } from '../db.js';
import { requireAuth, requireElevated } from '../auth/sessions.js';
import { hashPassword, verifyPassword } from '../auth/crypto.js';
import { postHook } from '../bot/hook.js';
import { relOf } from '../files/fsops.js';
import { checkUnlock, clientIp, esc, fmtSize, langOf, page, signUnlock } from './share.js';

/**
 * Upload links ("send me a file"): a public page on the share server where anyone with the link
 * can drop files, each link into its own folder on the Toshiba. Hardened for the open internet:
 *  - the link is a random token; optional password; expiry; it can be paused or deleted any time;
 *  - 4 GB per file, a total quota and a file count per link, free-space check, per-IP rate limits,
 *    three uploads at a time server-wide;
 *  - names are rebuilt from scratch (no paths, no control characters); files are written with
 *    0644 (never executable), and are never served back by the public server;
 *  - programs and scripts are refused unless the link says otherwise — by extension and by the
 *    first bytes (ELF, Windows PE, Mach-O, "#!").
 */
export interface Drop {
  id: number;
  token: string;
  name: string;
  dir: string;
  password_hash: string | null;
  expires_at: number | null;
  max_bytes: number;
  quota_bytes: number;
  max_files: number;
  allow_exec: number;
  disabled: number;
  files: number;
  bytes: number;
  last_upload: number | null;
  created_by: number | null;
  created_at: number;
}

export const MAX_FILE_BYTES = 4 * 1024 ** 3;
export const QUOTA_GB = [4, 20, 50, 100] as const;
export const UPLOADS_ROOT = () => path.join(config.mediaRoot, 'Uploads');
const TOKEN_RE = /^[\w-]{22}$/;
const MAX_CONCURRENT = 3;
export const dropUrl = (token: string) => `${config.shareBase}/u/${token}`;

const BLOCKED_EXT =
  /\.(exe|dll|sys|msi|msp|bat|cmd|com|scr|cpl|pif|ps1|psm1|vbs|vbe|wsf|wsh|js|jse|mjs|hta|lnk|reg|inf|sh|bash|zsh|ksh|csh|fish|run|bin|elf|so|dylib|o|app|command|appimage|deb|rpm|snap|flatpak|pkg|jar|class|py|pyc|pyw|pl|rb|php|phtml|php3|php5|phar|asp|aspx|jsp|cgi|apk|aab|xapk|ipa|desktop|service|timer)$/i;

/** Only safe characters; nothing that looks like a path or hides its extension. */
export function safeName(raw: string): string {
  let n = raw
    .replace(/[\\/]/g, '_')
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[.\s]+$/, '');
  if (n.length > 150) {
    const ext = path.extname(n).slice(0, 20);
    n = n.slice(0, 150 - ext.length) + ext;
  }
  return n || 'file';
}

export function looksExecutable(head: Buffer): boolean {
  if (head.length < 4) return false;
  const b0 = head.readUInt32BE(0);
  // ELF, Mach-O (both endiannesses, fat), Windows PE ("MZ"), and scripts with a shebang.
  return b0 === 0x7f454c46 || b0 === 0xfeedface || b0 === 0xfeedfacf || b0 === 0xcefaedfe || b0 === 0xcffaedfe || b0 === 0xcafebabe || head.subarray(0, 2).toString('latin1') === 'MZ' || head.subarray(0, 2).toString('latin1') === '#!';
}

function uniqueIn(dir: string, name: string): string {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let p = path.join(dir, name);
  for (let i = 2; fs.existsSync(p); i++) p = path.join(dir, `${base} (${i})${ext}`);
  return p;
}

export function findDrop(token: string): Drop | null {
  if (!TOKEN_RE.test(token)) return null;
  const d = getDb().prepare('SELECT * FROM drops WHERE token = ?').get(token) as Drop | undefined;
  if (!d || d.disabled || (d.expires_at !== null && d.expires_at < Date.now())) return null;
  return d;
}

// ---- Public pages ---------------------------------------------------------------------------

type Lang = 'ar' | 'en';
const STR = {
  en: {
    title: 'Send files to {name}',
    intro: 'Drop files here or tap to choose. Up to {max} per file.',
    choose: 'Choose files',
    sending: 'Sending…',
    done: 'Received ✓',
    tooBig: 'Too big (max {max})',
    blocked: 'This file type is not accepted',
    full: 'This link is full',
    failed: 'Failed — try again',
    password: 'This link is protected. Enter the password to continue.',
    wrong: 'Wrong password.',
    open: 'Open',
    left: '{n} files can still be sent',
    footer: 'MinisManager — files go straight to the owner, nobody else can see them.',
  },
  ar: {
    title: 'ابعت ملفات لـ {name}',
    intro: 'اسحب الملفات لهون أو اكبس لتختار. الحد الأقصى {max} للملف.',
    choose: 'اختار ملفات',
    sending: 'عم يبعت…',
    done: 'وصل ✓',
    tooBig: 'كبير كتير (الحد {max})',
    blocked: 'هالنوع من الملفات مش مقبول',
    full: 'هالرابط امتلأ',
    failed: 'فشل، جرّب مرة تانية',
    password: 'هالرابط محمي. اكتب كلمة السر لتكمّل.',
    wrong: 'كلمة السر غلط.',
    open: 'افتح',
    left: 'بعدك فيك تبعت {n} ملف',
    footer: 'MinisManager — الملفات بتروح لصاحب الرابط مباشرة، وما حدا تاني بيشوفها.',
  },
} satisfies Record<Lang, Record<string, string>>;
const tr = (lang: Lang, k: keyof (typeof STR)['en'], v: Record<string, string | number> = {}) => STR[lang][k].replace(/\{(\w+)\}/g, (_, x) => String(v[x] ?? ''));

function uploadPage(d: Drop, lang: Lang, nonce: string) {
  const left = Math.max(0, d.max_files - d.files);
  const quotaLeft = Math.max(0, d.quota_bytes - d.bytes);
  const t = (k: keyof (typeof STR)['en'], v?: Record<string, string | number>) => esc(tr(lang, k, v));
  const cfg = JSON.stringify({ token: d.token, max: Math.min(d.max_bytes, quotaLeft), left, s: { sending: tr(lang, 'sending'), done: tr(lang, 'done'), tooBig: tr(lang, 'tooBig', { max: fmtSize(d.max_bytes) }), blocked: tr(lang, 'blocked'), full: tr(lang, 'full'), failed: tr(lang, 'failed'), left: STR[lang].left } });
  const body = `<div class="card" style="max-width:560px;margin:6vh auto 0">
<h1 style="margin:0 0 6px;font-size:22px">${t('title', { name: d.name })}</h1>
<p class="muted">${t('intro', { max: fmtSize(d.max_bytes) })}</p>
<label id="zone" style="display:block;border:2px dashed #94a3b8;border-radius:16px;padding:36px 16px;text-align:center;cursor:pointer;margin:14px 0">
<input id="pick" type="file" multiple style="display:none"><span class="btn" style="display:inline-block">${t('choose')}</span></label>
<ul id="list" style="list-style:none;padding:0;margin:0"></ul>
<p id="left" class="muted" style="margin-top:10px">${t('left', { n: left })}</p>
</div>
<script nonce="${nonce}">${UPLOAD_JS}</script>`;
  return page(lang, tr(lang, 'title', { name: d.name }), body)
    .replace(/<footer class="muted">[^<]*<\/footer>/, `<footer class="muted">${t('footer')}</footer>`)
    .replace('<script nonce', `<script nonce="${nonce}">window.__cfg=${cfg.replace(/</g, '\\u003c')}</script><script nonce`);
}

/** Plain JS: one request per file, streamed as the body, with a progress bar. Nothing external. */
const UPLOAD_JS = `(function(){var c=window.__cfg,s=c.s,list=document.getElementById('list'),zone=document.getElementById('zone'),pick=document.getElementById('pick'),leftEl=document.getElementById('left'),left=c.left,q=[],busy=false;
function row(f){var li=document.createElement('li');li.style.cssText='display:flex;align-items:center;gap:10px;padding:8px 0;border-top:1px solid rgba(148,163,184,.3)';li.innerHTML='<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span><span class="muted" style="white-space:nowrap"></span>';li.firstChild.textContent=f.name;var bar=document.createElement('div');bar.style.cssText='height:4px;background:rgba(148,163,184,.3);border-radius:2px;margin:-4px 0 6px';var fill=document.createElement('div');fill.style.cssText='height:100%;width:0;background:#2f6fe4;border-radius:2px';bar.appendChild(fill);list.appendChild(li);list.appendChild(bar);return{st:li.lastChild,fill:fill}}
function setLeft(){leftEl.textContent=s.left.replace('{n}',left)}
function next(){if(busy||!q.length)return;busy=true;var it=q.shift(),f=it.f,r=it.r;if(f.size>c.max){r.st.textContent=s.tooBig;busy=false;return next()}if(left<=0){r.st.textContent=s.full;busy=false;return next()}
var x=new XMLHttpRequest();x.open('POST','/u/'+c.token+'/file?name='+encodeURIComponent(f.name));x.setRequestHeader('Content-Type','application/octet-stream');x.upload.onprogress=function(e){if(e.lengthComputable){r.fill.style.width=Math.round(e.loaded/e.total*100)+'%';r.st.textContent=s.sending+' '+Math.round(e.loaded/e.total*100)+'%'}};
x.onload=function(){if(x.status==200){r.st.textContent=s.done;r.fill.style.width='100%';r.fill.style.background='#16a34a';left--;setLeft()}else{var m=s.failed;try{var j=JSON.parse(x.responseText);if(j.error=='blocked')m=s.blocked;if(j.error=='too_big')m=s.tooBig;if(j.error=='full'||j.error=='no_space')m=s.full}catch(e){}r.st.textContent=m;r.fill.style.background='#dc2626'}busy=false;next()};
x.onerror=function(){r.st.textContent=s.failed;r.fill.style.background='#dc2626';busy=false;next()};r.st.textContent=s.sending;x.send(f)}
function add(files){for(var i=0;i<files.length;i++){q.push({f:files[i],r:row(files[i])})}next()}
pick.addEventListener('change',function(){add(pick.files);pick.value=''});
['dragenter','dragover'].forEach(function(ev){zone.addEventListener(ev,function(e){e.preventDefault();zone.style.borderColor='#2f6fe4'})});
['dragleave','drop'].forEach(function(ev){zone.addEventListener(ev,function(e){e.preventDefault();zone.style.borderColor='#94a3b8'})});
zone.addEventListener('drop',function(e){if(e.dataTransfer&&e.dataTransfer.files)add(e.dataTransfer.files)});
})();`;

function passwordPage(d: Drop, lang: Lang, wrong: boolean) {
  const t = (k: keyof (typeof STR)['en']) => esc(tr(lang, k));
  return page(
    lang,
    tr(lang, 'title', { name: d.name }),
    `<div class="card" style="max-width:420px;margin:12vh auto 0"><p>${t('password')}</p>${wrong ? `<p class="err">${t('wrong')}</p>` : ''}
<form method="post" action="/u/${d.token}/unlock"><input type="password" name="password" autocomplete="current-password" required autofocus><button class="btn" type="submit">${t('open')}</button></form></div>`,
  );
}

let active = 0;

/** The public part: served by the share server (no login, internet-facing). */
export function registerDropPublic(app: FastifyInstance) {
  // Uploads arrive as the raw request body (not parsed, not buffered): the route streams it to disk.
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));

  const cookieName = (d: Drop) => `dr${d.id}`;
  type Req = FastifyRequest<{ Params: { token: string }; Querystring: { name?: string } }>;
  const open = (req: Req, reply: FastifyReply): Drop | null => {
    const d = findDrop(req.params.token);
    if (!d) {
      void reply.callNotFound();
      return null;
    }
    if (d.password_hash && !checkUnlock(d, req.cookies[cookieName(d)])) {
      void reply.code(200).header('Cache-Control', 'no-store').type('text/html; charset=utf-8').send(passwordPage(d, langOf(req), false));
      return null;
    }
    return d;
  };

  app.get('/u/:token', async (req: Req, reply) => {
    const d = open(req, reply);
    if (!d) return;
    const nonce = crypto.randomBytes(16).toString('base64url');
    return reply
      .header('Cache-Control', 'no-store')
      .header('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`)
      .type('text/html; charset=utf-8')
      .send(uploadPage(d, langOf(req), nonce));
  });

  app.post<{ Params: { token: string }; Body: { password?: string } }>('/u/:token/unlock', { config: { rateLimit: { max: 8, timeWindow: '1 minute', keyGenerator: clientIp } } }, async (req, reply) => {
    const d = findDrop(req.params.token);
    if (!d) return reply.callNotFound();
    const pw = String(req.body?.password ?? '').slice(0, 200);
    if (!d.password_hash || !(await verifyPassword(pw, d.password_hash))) return reply.code(200).header('Cache-Control', 'no-store').type('text/html; charset=utf-8').send(passwordPage(d, langOf(req), true));
    return reply.setCookie(cookieName(d), signUnlock(d), { path: `/u/${d.token}`, httpOnly: true, sameSite: 'lax', secure: true, maxAge: 12 * 3600 }).redirect(`/u/${d.token}`, 303);
  });

  app.post('/u/:token/file', { config: { rateLimit: { max: 40, timeWindow: '10 minutes', keyGenerator: clientIp } } }, async (req: Req, reply) => {
    const d = findDrop(req.params.token);
    if (!d) return reply.code(404).send({ error: 'not_found' });
    if (d.password_hash && !checkUnlock(d, req.cookies[cookieName(d)])) return reply.code(401).send({ error: 'locked' });
    const lang = langOf(req);
    const name = safeName(String(req.query.name ?? ''));
    const declared = Number(req.headers['content-length'] ?? 0);
    const maxBytes = Math.min(d.max_bytes, Math.max(0, d.quota_bytes - d.bytes));
    if (!d.allow_exec && BLOCKED_EXT.test(name)) return reply.code(415).send({ error: 'blocked' });
    if (d.files >= d.max_files) return reply.code(409).send({ error: 'full' });
    if (declared > maxBytes) return reply.code(413).send({ error: 'too_big' });
    if (active >= MAX_CONCURRENT) return reply.code(503).header('Retry-After', '10').send({ error: 'busy' });
    try {
      const st = fs.statfsSync(d.dir);
      if (st.bavail * st.bsize < (declared || maxBytes) + 2 * 1024 ** 3) return reply.code(507).send({ error: 'no_space' });
    } catch {
      return reply.code(500).send({ error: 'folder_missing' });
    }
    fs.mkdirSync(d.dir, { recursive: true, mode: 0o755 });
    const part = path.join(d.dir, `.upload-${crypto.randomBytes(6).toString('hex')}.part`);
    let got = 0;
    let head = Buffer.alloc(0);
    let tooBig = false;
    const body = req.body as NodeJS.ReadableStream;
    active++;
    try {
      await new Promise<void>((resolve, reject) => {
        const counter = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            got += chunk.length;
            if (head.length < 8) head = Buffer.concat([head, chunk]).subarray(0, 8);
            if (got > maxBytes) {
              tooBig = true;
              return cb(new Error('too_big'));
            }
            cb(null, chunk);
          },
        });
        pipeline(body, counter, fs.createWriteStream(part, { mode: 0o644 }), (err) => (err ? reject(err) : resolve()));
      });
      if (!d.allow_exec && looksExecutable(head)) {
        fs.rmSync(part, { force: true });
        return reply.code(415).send({ error: 'blocked' });
      }
      const final = uniqueIn(d.dir, name);
      fs.renameSync(part, final);
      fs.chmodSync(final, 0o644);
      getDb().prepare('UPDATE drops SET files = files + 1, bytes = bytes + ?, last_upload = ? WHERE id = ?').run(got, Date.now(), d.id);
      getDb().prepare('INSERT INTO drop_files(drop_id, name, size, ip, created_at) VALUES(?, ?, ?, ?, ?)').run(d.id, path.basename(final), got, clientIp(req).slice(0, 64), Date.now());
      void postHook({ type: 'notice', text: `📥 ملف جديد على رابط «${d.name}»\n${path.basename(final)} (${fmtSize(got)})` });
      return { ok: true, name: path.basename(final), size: got };
    } catch (e) {
      fs.rmSync(part, { force: true });
      if (tooBig) return reply.code(413).send({ error: 'too_big' });
      req.log.warn({ err: e, drop: d.id }, 'upload failed');
      return reply.code(400).send({ error: 'failed', lang });
    } finally {
      active--;
    }
  });
}

// ---- Management (MinisManager, tailnet only) ------------------------------------------------

function view(d: Drop) {
  const now = Date.now();
  return {
    id: d.id,
    name: d.name,
    url: dropUrl(d.token),
    dir: relOf(d.dir),
    hasPassword: !!d.password_hash,
    expiresAt: d.expires_at,
    expired: d.expires_at !== null && d.expires_at < now,
    disabled: !!d.disabled,
    allowExec: !!d.allow_exec,
    maxBytes: d.max_bytes,
    quotaBytes: d.quota_bytes,
    maxFiles: d.max_files,
    files: d.files,
    bytes: d.bytes,
    lastUpload: d.last_upload,
    createdAt: d.created_at,
  };
}

export async function dropRoutes(app: FastifyInstance) {
  app.get('/api/drops', { preHandler: requireAuth }, async () => ({
    drops: (getDb().prepare('SELECT * FROM drops ORDER BY created_at DESC').all() as unknown as Drop[]).map(view),
  }));

  app.get<{ Params: { id: string } }>('/api/drops/:id/files', { preHandler: requireAuth }, async (req) => ({
    files: getDb().prepare('SELECT name, size, ip, created_at AS at FROM drop_files WHERE drop_id = ? ORDER BY id DESC LIMIT 500').all(Number(req.params.id)),
  }));

  app.post<{ Body: { name?: string; expiresDays?: number | null; password?: string; allowExec?: boolean; quotaGB?: number; maxFiles?: number } }>('/api/drops', { preHandler: requireElevated }, async (req, reply) => {
    const b = req.body ?? {};
    const name = safeName(String(b.name ?? '')).slice(0, 60);
    if (!name || name === 'file') return reply.code(400).send({ error: 'bad_name' });
    const days = b.expiresDays === null || b.expiresDays === undefined ? 30 : Number(b.expiresDays);
    if (b.expiresDays !== null && ![1, 7, 30, 90].includes(days)) return reply.code(400).send({ error: 'bad_expiry' });
    const pw = b.password === undefined || b.password === '' ? null : String(b.password);
    if (pw !== null && (pw.length < 4 || pw.length > 128)) return reply.code(400).send({ error: 'bad_password' });
    const quota = (QUOTA_GB as readonly number[]).includes(Number(b.quotaGB)) ? Number(b.quotaGB) : 20;
    const maxFiles = Math.min(1000, Math.max(1, Number(b.maxFiles) || 200));
    const token = crypto.randomBytes(16).toString('base64url');
    const dir = path.join(UPLOADS_ROOT(), `${name}-${token.slice(0, 6)}`);
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    const now = Date.now();
    const r = getDb()
      .prepare('INSERT INTO drops(token, name, dir, password_hash, expires_at, max_bytes, quota_bytes, max_files, allow_exec, disabled, files, bytes, created_by, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?)')
      .run(token, name, dir, pw ? await hashPassword(pw) : null, b.expiresDays === null ? null : now + days * 86400_000, MAX_FILE_BYTES, quota * 1024 ** 3, maxFiles, b.allowExec ? 1 : 0, req.session!.userId, now);
    audit(req.session!.userId, 'drop_create', { name, days: b.expiresDays === null ? null : days, allowExec: !!b.allowExec });
    return view(getDb().prepare('SELECT * FROM drops WHERE id = ?').get(Number(r.lastInsertRowid)) as unknown as Drop);
  });

  app.post<{ Params: { id: string }; Body: { disabled?: boolean } }>('/api/drops/:id/toggle', { preHandler: requireAuth }, async (req, reply) => {
    const id = Number(req.params.id);
    const r = getDb().prepare('UPDATE drops SET disabled = ? WHERE id = ?').run(req.body?.disabled ? 1 : 0, id);
    if (!r.changes) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });

  // Deleting a link keeps the folder and its files (they are yours now).
  app.delete<{ Params: { id: string } }>('/api/drops/:id', { preHandler: requireAuth }, async (req, reply) => {
    const id = Number(req.params.id);
    const r = getDb().prepare('DELETE FROM drops WHERE id = ?').run(id);
    if (!r.changes) return reply.code(404).send({ error: 'not_found' });
    getDb().prepare('DELETE FROM drop_files WHERE drop_id = ?').run(id);
    audit(req.session!.userId, 'drop_delete', { id });
    return { ok: true };
  });
}
