import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { kvGet, kvSet } from '../db.js';
import { postHook } from './hook.js';
import { fileTo } from './files.js';
import { magnetInfo, remember } from './torrentHistory.js';

/**
 * The bot's links to store apps set up on the server: qBittorrent (start torrents, list them, tell the owner when
 * one finishes) and Paperless-ngx (file a document from the library, search the papers).
 * Logins live in var/apps-credentials.json (0600), written when the apps were set up.
 */
type Cred = { url: string; username: string; password: string };
export function cred(app: string): Cred {
  try {
    const c = (JSON.parse(fs.readFileSync(path.join(config.dataDir, 'apps-credentials.json'), 'utf8')) as Record<string, Cred>)[app];
    if (c?.url) return c;
  } catch {
    /* not set up */
  }
  throw new Error(`${app}_not_set_up`);
}
const tailnet = (localUrl: string) => localUrl.replace(/^http:\/\/127\.0\.0\.1:/, `https://${config.tailscaleHost}:`);
const esc = (s: string) => s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]!);

// ---- qBittorrent ------------------------------------------------------------------------------
let qbSid: string | null = null;
export async function qb(pathAndQuery: string, form?: Record<string, string>, retry = true): Promise<Response> {
  const c = cred('qbittorrent');
  if (!qbSid) {
    const r = await fetch(`${c.url}/api/v2/auth/login`, { method: 'POST', headers: { Referer: c.url }, body: new URLSearchParams({ username: c.username, password: c.password }), signal: AbortSignal.timeout(10_000) });
    qbSid = /SID=([^;]+)/.exec(r.headers.get('set-cookie') ?? '')?.[1] ?? null;
    if (!qbSid) throw new Error('qbittorrent_login_failed');
  }
  const r = await fetch(`${c.url}/api/v2/${pathAndQuery}`, {
    method: form ? 'POST' : 'GET',
    headers: { Cookie: `SID=${qbSid}`, Referer: c.url },
    body: form ? new URLSearchParams(form) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  if (r.status === 403 && retry) {
    qbSid = null;
    return qb(pathAndQuery, form, false);
  }
  if (!r.ok) throw new Error(`qbittorrent_${r.status}`);
  return r;
}

export interface Torrent {
  hash: string;
  name: string;
  progress: number;
  size: number;
  state: string;
  dlspeed: number;
  eta: number;
  completion_on: number;
}

// ---- torrent search (The Pirate Bay's own JSON API, apibay.org) -------------------------------------
// tpb-lite (the library the owner linked) scrapes TPB's old HTML pages and breaks on today's layout, so the
// search uses the JSON API behind thepiratebay.org: same results, no page scraping.
export const TPB_API = 'https://apibay.org';
const TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://opentracker.i2p.rocks:6969/announce',
];
/** TPB category groups (the API takes the top-level or a sub-category number). */
export const TPB_CATEGORIES: Record<string, number> = { all: 0, audio: 100, music: 101, video: 200, movies: 201, tv: 205, hd_movies: 207, hd_tv: 208, apps: 300, games: 400, ebooks: 601, other: 600 };
export const magnetOf = (hash: string, name: string) => `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(name)}${TRACKERS.map((t) => `&tr=${encodeURIComponent(t)}`).join('')}`;
export interface TpbRow {
  id: string;
  name: string;
  info_hash: string;
  seeders: string;
  leechers: string;
  size: string;
  added: string;
  category: string;
  status: string;
  num_files: string;
}
export interface SearchHit {
  hash?: string;
  n: number;
  id: string;
  name: string;
  sizeGB: number;
  seeders: number;
  leechers: number;
  added: string;
  trusted: boolean;
  category: number;
}
const LAST_SEARCH = 'torrent_last_search';

/** Searches TPB; the busiest first. Adult categories (5xx) are left out. Results are numbered for "download #2". */
export async function searchTorrents(query: string, category = 'all', limit = 8): Promise<{ query: string; results: SearchHit[] }> {
  const q = query.trim().slice(0, 120);
  if (!q) throw new Error('empty_query');
  const cat = TPB_CATEGORIES[category] ?? 0;
  const r = await fetch(`${TPB_API}/q.php?q=${encodeURIComponent(q)}&cat=${cat}`, { headers: { 'User-Agent': 'Mozilla/5.0 (MinisManager)' }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`search_failed_${r.status}`);
  const rows = ((await r.json()) as TpbRow[]).filter((x) => x.id !== '0' && x.info_hash && !/^0+$/.test(x.info_hash) && !x.category.startsWith('5'));
  const results = rows
    .sort((a, b) => +b.seeders - +a.seeders)
    .slice(0, Math.max(1, Math.min(20, limit)))
    .map((x, i) => ({
      n: i + 1,
      id: x.id,
      name: x.name,
      sizeGB: Math.round((+x.size / 1024 ** 3) * 100) / 100,
      seeders: +x.seeders,
      leechers: +x.leechers,
      added: new Date(+x.added * 1000).toISOString().slice(0, 10),
      trusted: x.status === 'vip' || x.status === 'trusted',
      category: +x.category,
      hash: x.info_hash.toUpperCase(),
    }));
  // Kept so "download number 2" (or its id) finds the right one without copying a long magnet link.
  kvSet(LAST_SEARCH, JSON.stringify({ at: Date.now(), hits: rows.slice(0, 20).sort((a, b) => +b.seeders - +a.seeders).map((x, i) => ({ n: i + 1, id: x.id, hash: x.info_hash, name: x.name })) }));
  return { query: q, results };
}

/** "#2", "2" (from the last search) or "tpb:12345" (its id) → a magnet link. */
export function resolvePick(pick: string): { magnet: string; name: string } | null {
  const raw = kvGet(LAST_SEARCH);
  if (!raw) return null;
  const last = JSON.parse(raw) as { at: number; hits: { n: number; id: string; hash: string; name: string }[] };
  if (Date.now() - last.at > 24 * 3600_000) return null;
  const m = /^(?:#|no\.?\s*)?(\d{1,2})$/i.exec(pick.trim());
  const id = /^tpb:(\d+)$/i.exec(pick.trim());
  const hit = id ? last.hits.find((h) => h.id === id[1]) : m ? last.hits.find((h) => h.n === Number(m[1])) : null;
  return hit ? { magnet: magnetOf(hit.hash, hit.name), name: hit.name } : null;
}

/** A magnet link, an http(s) link to a .torrent file, or a pick from the last search ("#2", "tpb:123"). */
export async function addTorrent(link: string, category?: string, rename?: string) {
  const picked = resolvePick(link);
  const l = picked ? picked.magnet : link.trim();
  if (!/^magnet:\?xt=urn:bt[im]h:/i.test(l) && !/^https?:\/\/\S+$/i.test(l)) return { ok: false, message: 'Send a magnet link (magnet:?xt=…), a link to a .torrent file, or a number from the last search (#2).' };
  // A category names the library shelf (see mediaLibrary CATEGORY_KIND); qBittorrent needs it to exist.
  if (category) await qb('torrents/createCategory', { category, savePath: '' }).catch(() => null);
  const r = await qb('torrents/add', { urls: l, ...(category ? { category } : {}), ...(rename ? { rename } : {}) });
  const text = (await r.text()).trim();
  if (/fail/i.test(text)) return { ok: false, message: 'qBittorrent refused the link (already added, or not a valid torrent).' };
  const info = magnetInfo(l);
  if (info) remember(info.hash, picked?.name ?? info.name ?? '');
  return { ok: true, message: `Added${picked ? `: ${picked.name}` : ''}. It downloads to Files → Downloads → Torrents; a Telegram message comes when it is done.`, web: tailnet(cred('qbittorrent').url) };
}

/** Every torrent qBittorrent knows (with hashes), for "don't show what I already have". */
export async function qbList(): Promise<Torrent[]> {
  return (await (await qb('torrents/info')).json()) as Torrent[];
}

export async function listTorrents() {
  const list = (await (await qb('torrents/info?sort=added_on&reverse=true&limit=15')).json()) as Torrent[];
  return {
    torrents: list.map((t) => ({
      name: t.name,
      percent: Math.round(t.progress * 1000) / 10,
      sizeGB: Math.round((t.size / 1024 ** 3) * 100) / 100,
      state: t.state,
      speedMBs: Math.round((t.dlspeed / 1024 ** 2) * 10) / 10,
      etaMin: t.eta > 0 && t.eta < 8640000 ? Math.round(t.eta / 60) : null,
    })),
    web: tailnet(cred('qbittorrent').url),
  };
}

const ANNOUNCED = 'torrents_announced';
/** Every minute: torrents that finished since last time → one Telegram message each. */
async function checkFinished() {
  let list: Torrent[];
  try {
    list = (await (await qb('torrents/info?filter=completed')).json()) as Torrent[];
  } catch {
    return; // qBittorrent not installed or down: Uptime Kuma reports that
  }
  const known = kvGet(ANNOUNCED);
  const seen = new Set<string>(known ? (JSON.parse(known) as string[]) : []);
  const fresh = list.filter((t) => !seen.has(t.hash));
  for (const t of fresh) {
    seen.add(t.hash);
    remember(t.hash, t.name); // finished ones stay hidden from /torrent lists, even after removal
  }
  kvSet(ANNOUNCED, JSON.stringify([...seen].slice(-500)));
  if (!known) return; // first run: what's already done is not news
  for (const t of fresh)
    await postHook({ type: 'notice', text: `🧲 <b>خلص تنزيل التورنت</b>\n${esc(t.name)} (${Math.round((t.size / 1024 ** 3) * 100) / 100} GB)\n${kvGet('media_library_on') === '1' ? 'عم رتّبه بمكانه بـ Jellyfin وجيبله ترجمة عربي…' : 'بتلاقيه بـ Files ← Downloads ← Torrents، وبيطلع لحاله بـ Jellyfin.'}` });
}

export function startTorrentWatcher(): () => void {
  if (process.env.VITEST) return () => {};
  const id = setInterval(() => void checkFinished(), 60_000);
  void checkFinished();
  return () => clearInterval(id);
}

// ---- Paperless-ngx ----------------------------------------------------------------------------
/** A document already in the library (e.g. a photo saved from Telegram) → a copy into Paperless's inbox. */
export async function paperlessFile(rel: string) {
  cred('paperless');
  const r = await fileTo({ path: rel, folder: 'Documents/Paperless Inbox', mode: 'copy' });
  return { ok: true, message: 'Copied to Paperless; it is read (OCR) and filed within a minute or two.', path: r.path, web: tailnet(cred('paperless').url) };
}

export async function paperlessSearch(q: string) {
  const c = cred('paperless');
  const auth = 'Basic ' + Buffer.from(`${c.username}:${c.password}`).toString('base64');
  const r = await fetch(`${c.url}/api/documents/?page_size=8&ordering=-created&${q.trim() ? `query=${encodeURIComponent(q.trim())}` : ''}`, { headers: { Authorization: auth, Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`paperless_${r.status}`);
  const d = (await r.json()) as { count: number; results: { id: number; title: string; created: string; correspondent?: number | null }[] };
  const web = tailnet(c.url);
  return { count: d.count, documents: d.results.map((x) => ({ title: x.title, date: String(x.created).slice(0, 10), link: `${web}/documents/${x.id}/details` })) };
}
