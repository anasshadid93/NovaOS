import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { cred, qb } from './apps.js';
import { remember } from './torrentHistory.js';

/**
 * ArabP2P (arabp2p.net), the Arabic tracker the owner has an account on: search, category lists, and
 * downloads through qBittorrent with his own passkey (inside each .torrent). The login session is
 * kept in var/arabp2p.cookies; when it expires the login is repeated with the account in
 * var/apps-credentials.json (both 0600). A ratio guard keeps his upload/download ratio at 1 or above
 * — private trackers ban members who fall behind.
 */

const BASE = 'https://www.arabp2p.net';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) NovaOS';
const jar = () => path.join(config.dataDir, 'arabp2p.cookies');
export const MIN_RATIO = 1.0;

function readJar(): Record<string, string> {
  try {
    const out: Record<string, string> = {};
    for (const l of fs.readFileSync(jar(), 'utf8').split('\n')) {
      if (!l || (l.startsWith('#') && !l.startsWith('#HttpOnly_'))) continue;
      const p = l.split('\t');
      if (p.length >= 7) out[p[5]] = p[6];
    }
    return out;
  } catch {
    return {};
  }
}
function writeJar(c: Record<string, string>) {
  const lines = ['# Netscape HTTP Cookie File', ...Object.entries(c).map(([k, v]) => `www.arabp2p.net\tFALSE\t/\tTRUE\t0\t${k}\t${v}`)];
  fs.writeFileSync(jar(), `${lines.join('\n')}\n`, { mode: 0o600 });
}
function absorb(res: Response, c: Record<string, string>) {
  for (const sc of res.headers.getSetCookie?.() ?? []) {
    const [kv] = sc.split(';');
    const i = kv.indexOf('=');
    if (i > 0) c[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  }
}
const cookieHeader = (c: Record<string, string>) =>
  Object.entries(c)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');

async function login(): Promise<void> {
  const a = cred('arabp2p');
  const c: Record<string, string> = {};
  const first = await fetch(`${BASE}/index.php?page=login`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30_000) });
  absorb(first, c);
  const r = await fetch(`${BASE}/index.php?page=login&returnto=index.php`, {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader(c), Referer: `${BASE}/index.php?page=login` },
    body: new URLSearchParams({ uid: a.username, pwd: a.password }),
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
  });
  absorb(r, c);
  writeJar(c);
}

const loggedOut = (html: string) => /name=["']?pwd["']?/.test(html) && !/logout/i.test(html);
/** A page of the site as the logged-in member (logging in again if the session expired). */
export async function page(pathAndQuery: string, retry = true): Promise<string> {
  const c = readJar();
  const r = await fetch(`${BASE}/${pathAndQuery}`, { headers: { 'User-Agent': UA, Cookie: cookieHeader(c) }, signal: AbortSignal.timeout(30_000) });
  absorb(r, c);
  writeJar(c);
  const html = await r.text();
  if (loggedOut(html) && retry) {
    await login();
    return page(pathAndQuery, false);
  }
  if (loggedOut(html)) throw new Error('arabp2p_login_failed');
  return html;
}

const decode = (s: string) =>
  s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
const toGB = (s: string) => {
  const m = /([\d.]+)\s*(TB|GB|MB|KB)/i.exec(s);
  if (!m) return 0;
  return +(+m[1] * ({ TB: 1024, GB: 1, MB: 1 / 1024, KB: 1 / 1024 ** 2 } as Record<string, number>)[m[2].toUpperCase()]).toFixed(2);
};

/** Upload/download totals from the page's member bar (spans mine_bar_uploaded / mine_bar_downloaded). */
export function account(html: string): { upGB: number; downGB: number; ratio: number } | null {
  const up = /class="mine_bar_uploaded"[^>]*>([^<]+)</.exec(html)?.[1];
  const down = /class="mine_bar_downloaded"[^>]*>([^<]+)</.exec(html)?.[1];
  if (!up || !down) return null;
  const u = toGB(up),
    d = toGB(down);
  return { upGB: u, downGB: d, ratio: d ? +(u / d).toFixed(2) : 99 };
}

export interface ApItem {
  id: string;
  name: string;
  category: string;
  catId: number;
  sizeGB: number;
  seeders: number;
  leechers: number;
  added: string;
  dl: string;
  /** freeleech ("مجاني"): its download doesn't count against the ratio */
  free: boolean;
}
/** The torrent list of a search or category page. */
export function parseList(html: string): ApItem[] {
  const out: ApItem[] = [];
  for (const block of html.split('<div class="file-item">').slice(1)) {
    const id = /page=torrent-details&(?:amp;)?id=(\d+)/.exec(block)?.[1];
    const name = /<span class="tor_(?:free_)?link">([\s\S]*?)<\/span>/.exec(block)?.[1];
    const dl = /href="(download\.php\?[^"]+)"/.exec(block)?.[1];
    if (!id || !name || !dl) continue;
    const cat = /name='cat_url' href='[^']*category=(\d+)'>([\s\S]*?)<\/a>/.exec(block);
    out.push({
      id,
      name: decode(name),
      category: cat ? decode(cat[2]) : '',
      catId: cat ? +cat[1] : 0,
      sizeGB: toGB(/<span class="size">([^<]+)</.exec(block)?.[1] ?? ''),
      seeders: +(/title="Seeders">[^<]*<a[^>]*>(\d+)/.exec(block)?.[1] ?? 0),
      leechers: +(/title="Leechers">[^<]*<a[^>]*>(\d+)/.exec(block)?.[1] ?? 0),
      added: (/class="upload-date"><span title='([^']+)'/.exec(block)?.[1] ?? '').split(' ')[0],
      dl: dl.replace(/&amp;/g, '&'),
      free: /tor_free_link|class='free'/.test(block),
    });
  }
  return out;
}

export async function search(q: string, catId = 0): Promise<{ items: ApItem[]; acct: ReturnType<typeof account> }> {
  const html = await page(`index.php?page=torrents&search=${encodeURIComponent(q)}&category=${catId}&active=0`);
  return { items: parseList(html), acct: account(html) };
}
export async function latest(catId: number): Promise<{ items: ApItem[]; acct: ReturnType<typeof account> }> {
  const html = await page(`index.php?page=torrents&category=${catId}&active=1`);
  return { items: parseList(html), acct: account(html) };
}

/** ArabP2P category → the library shelf (a qBittorrent category, see mediaLibrary CATEGORY_KIND). */
export function shelfFor(it: Pick<ApItem, 'catId' | 'name'>): string {
  const series = /مسلسل|حلقات|موسم|م\d|\bS\d|\[E\d|Show\b|كامل\]|سلسلة/i.test(it.name);
  switch (it.catId) {
    case 98:
    case 99:
      return 'Cartoons';
    case 100:
    case 102:
      return 'Cartoon Series';
    case 101:
    case 103:
      return 'Anime';
    case 85:
      return series ? 'Cartoon Series' : 'Cartoons';
    case 19:
    case 93:
      return 'Documentaries';
    case 44:
    case 89:
    case 71:
    case 45:
    case 57:
    case 113:
    case 115:
      return 'Series';
    case 41:
    case 88:
    case 42:
    case 74:
    case 59:
    case 86:
    case 114:
    case 116:
      return 'Movies';
    default:
      return series ? 'Series' : 'Videos';
  }
}

/** The info-hash of a .torrent (SHA-1 of its bencoded "info" dictionary). */
export function infoHash(t: Buffer): string | null {
  const key = Buffer.from('4:info');
  const at = t.indexOf(key);
  if (at < 0) return null;
  let i = at + key.length;
  const start = i;
  const skip = (): void => {
    const c = t[i];
    if (c === 0x64 || c === 0x6c) {
      i++;
      while (t[i] !== 0x65) skip();
      i++;
    } else if (c === 0x69) i = t.indexOf(0x65, i) + 1;
    else {
      const colon = t.indexOf(0x3a, i);
      i = colon + 1 + Number(t.subarray(i, colon).toString());
    }
  };
  skip();
  return crypto.createHash('sha1').update(t.subarray(start, i)).digest('hex').toUpperCase();
}

/** Downloads one torrent into qBittorrent (on its shelf), if the ratio allows it. */
export async function addApTorrent(it: ApItem, acct: ReturnType<typeof account>): Promise<{ ok: boolean; message: string; hash?: string }> {
  if (!it.free && acct && acct.downGB + it.sizeGB > 0 && acct.upGB / (acct.downGB + it.sizeGB) < MIN_RATIO)
    return { ok: false, message: `نسبتك رح تنزل تحت ${MIN_RATIO} (${acct.ratio} حالياً)، فما نزّلت. لازم ترفع أكتر أولاً.` };
  if (!it.seeders) return { ok: false, message: 'ما في حدا عم يشارك هالملف هلأ (0 seeders).' };
  const c = readJar();
  const r = await fetch(`${BASE}/${it.dl}`, { headers: { 'User-Agent': UA, Cookie: cookieHeader(c) }, signal: AbortSignal.timeout(30_000) });
  const buf = Buffer.from(await r.arrayBuffer());
  if (!r.ok || buf[0] !== 0x64) {
    // Not a torrent: the session probably expired. Log in once and try again.
    await login();
    const again = await fetch(`${BASE}/${it.dl}`, { headers: { 'User-Agent': UA, Cookie: cookieHeader(readJar()) }, signal: AbortSignal.timeout(30_000) });
    const b2 = Buffer.from(await again.arrayBuffer());
    if (b2[0] !== 0x64) return { ok: false, message: 'ما قدرت آخد ملف التورنت من ArabP2P.' };
    return upload(it, b2);
  }
  return upload(it, buf);
}

async function upload(it: ApItem, torrent: Buffer) {
  const shelf = shelfFor(it);
  await qb('torrents/createCategory', { category: shelf, savePath: '' }).catch(() => null);
  const fd = new FormData();
  fd.append('torrents', new Blob([new Uint8Array(torrent)], { type: 'application/x-bittorrent' }), `${it.id}.torrent`);
  fd.append('category', shelf);
  fd.append('rename', it.name.slice(0, 180));
  const c = cred('qbittorrent');
  // qb() sends forms; a file upload needs multipart, with the same login session.
  const r = await qbMultipart(c.url, fd);
  if (!r.ok || /fail/i.test(await r.text())) return { ok: false, message: 'qBittorrent رفض التورنت (يمكن مضاف من قبل).' };
  const hash = infoHash(torrent) ?? undefined;
  if (hash) remember(hash, it.name);
  // qBittorrent stops public torrents as soon as they finish (the owner doesn't seed); this private
  // tracker needs the upload for his ratio, so its torrents keep seeding.
  if (hash) {
    await new Promise((res) => setTimeout(res, 1500));
    await qb('torrents/setShareLimits', { hashes: hash.toLowerCase(), ratioLimit: '-1', seedingTimeLimit: '-1', inactiveSeedingTimeLimit: '-1' }).catch(() => null);
  }
  return { ok: true, message: `بلش التنزيل · ${shelf}`, hash };
}

let qbSidCache: string | null = null;
async function qbMultipart(url: string, fd: FormData, retry = true): Promise<Response> {
  const c = cred('qbittorrent');
  if (!qbSidCache) {
    const l = await fetch(`${url}/api/v2/auth/login`, { method: 'POST', headers: { Referer: url }, body: new URLSearchParams({ username: c.username, password: c.password }) });
    qbSidCache = /SID=([^;]+)/.exec(l.headers.get('set-cookie') ?? '')?.[1] ?? null;
  }
  const r = await fetch(`${url}/api/v2/torrents/add`, { method: 'POST', headers: { Referer: url, Cookie: `SID=${qbSidCache}` }, body: fd });
  if (r.status === 403 && retry) {
    qbSidCache = null;
    return qbMultipart(url, fd, false);
  }
  return r;
}
