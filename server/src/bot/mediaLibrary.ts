import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { kvGet, kvSet } from '../db.js';
import { cred, qb, qbList } from './apps.js';
import { postHook } from './hook.js';
import { enqueue } from './subTranslate.js';
import { archiveDownloads } from './archiveDl.js';
import { fetchArabicFallback } from './subsFallback.js';
import { config } from '../config.js';

/**
 * The media library on the Toshiba 6TB: finished torrents land in Downloads/Torrents (qBittorrent
 * keeps seeding them) and get a hardlink — no extra space — under Media/<kind>/ with the names
 * Jellyfin understands ("Title (Year)/Title (Year).mkv", "Show (Year)/Season 01/Show S01E02.mkv").
 * Series are identified on TVmaze (anime, cartoon or documentary series go to their folders); films
 * are sorted by Jellyfin's own metadata after its scan (Animation → Cartoons, Japanese animation →
 * Anime, Documentary → Documentaries). Then an Arabic subtitle comes from OpenSubtitles through
 * Jellyfin's plugin, and the owner gets one Telegram line per title.
 * Inactive until the switch (mediaSetup.ts) turns it on after the disk passed its full scan.
 */

export const LIB = {
  root: config.mediaRoot,
  get media() {
    return path.join(this.root, 'Media');
  },
  get downloads() {
    return path.join(this.root, 'Downloads');
  },
  /** where the containers see them */
  qbDownloads: '/downloads',
  jfMedia: '/media/Library',
};
export type Kind = 'movies' | 'series' | 'cartoons' | 'cartoonSeries' | 'anime' | 'documentaries' | 'videos';
export const FOLDERS: Record<Kind, string> = { movies: 'Movies', series: 'Series', cartoons: 'Cartoons', cartoonSeries: 'Cartoon Series', anime: 'Anime', documentaries: 'Documentaries', videos: 'Videos' };
export const LIBRARIES: { kind: Kind; name: string; type: 'movies' | 'tvshows' | 'homevideos' }[] = [
  { kind: 'movies', name: 'أفلام · Movies', type: 'movies' },
  { kind: 'series', name: 'مسلسلات · Series', type: 'tvshows' },
  { kind: 'cartoons', name: 'كرتون · Cartoons', type: 'movies' },
  { kind: 'cartoonSeries', name: 'مسلسلات كرتون · Cartoon Series', type: 'tvshows' },
  { kind: 'anime', name: 'أنمي · Anime', type: 'tvshows' },
  { kind: 'documentaries', name: 'وثائقي · Documentaries', type: 'movies' },
  { kind: 'videos', name: 'فيديوهات · Videos', type: 'homevideos' },
];
export const libraryOn = () => kvGet('media_library_on') === '1';

const VIDEO = /\.(mkv|mp4|avi|m4v|mov|wmv|ts|webm|mpg|mpeg)$/i;
const SUBS = /\.(srt|ass|ssa|sub|vtt)$/i;
const QUALITY = /^(2160p|1080p|720p|576p|480p|4k|uhd|hdr|hdr10|dv|web|webdl|web-dl|webrip|bluray|blu-ray|brrip|bdrip|hdrip|dvdrip|hdtv|x264|x265|h264|h265|hevc|avc|10bit|8bit|aac|ac3|dts|ddp5|ddp|dd5|atmos|truehd|remux|proper|repack|extended|unrated|imax|internal|multi|dual|subbed|dubbed|complete)$/i;

export interface Release {
  title: string;
  year?: number;
  season?: number;
  episode?: number;
  /** a "[Group] Show - 05" style release: anime */
  anime: boolean;
  kind: 'movie' | 'episode';
}

/** Reads a release name: title, year, season/episode. */
export function parseRelease(raw: string): Release {
  // A collection's running number, "01.Iron Man (2008)…" (two digits and a dot, so "1917.2019…" stays).
  let s = raw.replace(VIDEO, '').replace(SUBS, '').replace(/^\d{2,3}\.(?=\p{L})/u, '');
  const anime = /^\s*\[[^\]]+\]/.test(s) && /\s-\s\d{1,4}(v\d)?\b/.test(s);
  // Release tags: "[Group] …", and a half-open "CT] …" left by some uploaders.
  s = s.replace(/^\s*\[[^\]]+\]\s*/, '').replace(/^\s*\w{1,4}\]\s*/, '').replace(/\[[^\]]*\]|\{[^}]*\}/g, ' ');
  s = s.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
  // "1985 - Asterix Versus Caesar": a leading year is the year, not the title.
  const lead = /^((?:19|20)\d\d)\s*-\s*(.+)$/.exec(s);
  if (lead) s = `${lead[2]} ${lead[1]}`;
  let season: number | undefined, episode: number | undefined, cut = s.length;
  const se = /\bS(\d{1,2})\s?E(\d{1,3})\b/i.exec(s) ?? /\b(\d{1,2})x(\d{2,3})\b/i.exec(s);
  // Arabic and plain episode words: "الحلقة 5", "حلقة 05", "ح 5", "Ep 05", "Episode 5", "E05".
  const ep = /(?:الحلقة|حلقة|ح)\s*[-_.:]?\s*(\d{1,4})/.exec(s) ?? /\b(?:ep|episode|e)\s?[-_.]?\s?(\d{1,4})\b/i.exec(s);
  if (se) {
    season = +se[1];
    episode = +se[2];
    cut = Math.min(cut, se.index);
  } else if (ep) {
    const part = /(?:الجزء|الموسم|ج)\s*[-_.:]?\s*(\d{1,2}|الأول|الاول|الثاني|الثالث|الرابع|الخامس)/.exec(s);
    const words: Record<string, number> = { الأول: 1, الاول: 1, الثاني: 2, الثالث: 3, الرابع: 4, الخامس: 5 };
    season = part ? (words[part[1]] ?? +part[1]) : 1;
    episode = +ep[1];
    cut = Math.min(cut, ep.index, part?.index ?? Infinity);
  } else if (anime) {
    const m = /\s-\s(\d{1,4})(v\d)?\b/.exec(s)!;
    season = 1;
    episode = +m[1];
    cut = Math.min(cut, m.index);
  } else {
    const sOnly = /\b(?:S(\d{1,2})|Season\s?(\d{1,2}))\b/i.exec(s);
    if (sOnly) {
      season = +(sOnly[1] ?? sOnly[2]);
      cut = Math.min(cut, sOnly.index);
    }
  }
  // The last year-like number before the episode/quality part ("Blade Runner 2049 2017" → 2017),
  // never the first word ("2012 (2009)" is the film 2012).
  const head = s.slice(0, cut);
  const years = [...head.matchAll(/\(?\b(19[2-9]\d|20[0-4]\d)\b\)?/g)].filter((m) => (m.index ?? 0) > 0);
  const quality = head.split(' ').findIndex((w) => QUALITY.test(w.replace(/[^\w-]/g, '')));
  const qAt = quality > 0 ? head.split(' ').slice(0, quality).join(' ').length : head.length;
  const y = years.filter((m) => (m.index ?? 0) < qAt).at(-1);
  let year: number | undefined;
  if (y) {
    year = +y[1];
    cut = Math.min(cut, y.index!);
  }
  const words = s.slice(0, cut).split(' ');
  const q = words.findIndex((w) => QUALITY.test(w.replace(/[^\w-]/g, '')));
  const title = (q > 0 ? words.slice(0, q) : words)
    .join(' ')
    .replace(/[-(\s]+$/g, '')
    .trim();
  return { title: title || s.slice(0, 60), year, season, episode, anime, kind: episode !== undefined ? 'episode' : 'movie' };
}

/** Safe names for folders/files. */
export const safe = (s: string) => s.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 150) || 'Untitled';
const pad = (n: number) => String(n).padStart(2, '0');
const esc = (x: string) => x.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]!);

/** Where a release goes (relative to Media/). */
export function destination(r: Release, kind: Kind, ext: string, showName?: string, showYear?: number): string {
  if (r.kind === 'episode' || kind === 'series' || kind === 'anime' || kind === 'cartoonSeries') {
    const show = safe(showName ?? r.title);
    const sy = showYear ? ` (${showYear})` : '';
    const ep = r.episode !== undefined ? ` S${pad(r.season ?? 1)}E${pad(r.episode)}` : '';
    return path.join(FOLDERS[kind], `${show}${sy}`, `Season ${pad(r.season ?? 1)}`, `${show}${ep}${ext}`);
  }
  const t = safe(r.title) + (r.year ? ` (${r.year})` : '');
  return path.join(FOLDERS[kind], t, `${t}${ext}`);
}

/**
 * Long anime numbered absolutely (One Piece 0001–1180) that TMDB splits into arcs while keeping the
 * absolute numbers (season 2 = episodes 62–77). A show folder may carry `.seasons.json`: the first
 * absolute episode of each season, e.g. [1, 62, 78, …]. An episode filed as season 1 then goes to its
 * real season, keeping its number — which is how TMDB, and so Jellyfin, find it.
 */
export function seasonFor(showDir: string, episode: number, season: number): number {
  if (season !== 1) return season;
  try {
    const starts = JSON.parse(fs.readFileSync(path.join(showDir, '.seasons.json'), 'utf8')) as number[];
    let s = 1;
    starts.forEach((first, i) => {
      if (episode >= first) s = i + 1;
    });
    return s;
  } catch {
    return season;
  }
}

// ---- TVmaze (free, no key): what kind of series ---------------------------------------------------
interface Show {
  name: string;
  premiered?: string | null;
  type?: string;
  genres?: string[];
  language?: string | null;
}
export function seriesKind(show: Show | null, anime: boolean): Kind {
  if (anime || show?.genres?.includes('Anime') || (show?.type === 'Animation' && show.language === 'Japanese')) return 'anime';
  if (show?.type === 'Animation') return 'cartoonSeries';
  if (show?.type === 'Documentary') return 'documentaries';
  return 'series';
}
async function tvmaze(title: string): Promise<Show | null> {
  try {
    const r = await fetch(`https://api.tvmaze.com/singlesearch/shows?q=${encodeURIComponent(title)}`, { signal: AbortSignal.timeout(10_000) });
    return r.ok ? ((await r.json()) as Show) : null;
  } catch {
    return null;
  }
}

// ---- Jellyfin ------------------------------------------------------------------------------------
let jfToken: string | null = null;
const jfAuth = (token?: string) => `MediaBrowser Client="MinisManager", Device="the server", DeviceId="minismanager-media", Version="1.0"${token ? `, Token="${token}"` : ''}`;
export async function jf<T = unknown>(pathAndQuery: string, init: { method?: string; body?: unknown } = {}, retry = true): Promise<T> {
  const c = cred('jellyfin');
  if (!jfToken) {
    const r = await fetch(`${c.url}/Users/AuthenticateByName`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: jfAuth() }, body: JSON.stringify({ Username: c.username, Pw: c.password }), signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`jellyfin_login_${r.status}`);
    jfToken = ((await r.json()) as { AccessToken: string }).AccessToken;
  }
  const r = await fetch(`${c.url}${pathAndQuery}`, { method: init.method ?? 'GET', headers: { 'Content-Type': 'application/json', Authorization: jfAuth(jfToken) }, body: init.body === undefined ? undefined : JSON.stringify(init.body), signal: AbortSignal.timeout(60_000) });
  if (r.status === 401 && retry) {
    jfToken = null;
    return jf<T>(pathAndQuery, init, false);
  }
  if (!r.ok) throw new Error(`jellyfin_${r.status}_${pathAndQuery.split('?')[0]}`);
  const t = await r.text();
  return (t ? JSON.parse(t) : {}) as T;
}

/** A raw Jellyfin response (images), logged in. */
export async function jfRaw(pathAndQuery: string): Promise<Response> {
  await jf('/System/Info'); // logs in when needed
  return fetch(`${cred('jellyfin').url}${pathAndQuery}`, { headers: { Authorization: jfAuth(jfToken!) }, signal: AbortSignal.timeout(30_000) });
}

/** A Jellyfin response as text (subtitle streams are SRT, not JSON). */
export async function jfText(pathAndQuery: string): Promise<string> {
  await jf('/System/Info'); // logs in when needed
  const r = await fetch(`${cred('jellyfin').url}${pathAndQuery}`, { headers: { Authorization: jfAuth(jfToken!) }, signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`jellyfin_${r.status}`);
  return r.text();
}

// ---- the queue -----------------------------------------------------------------------------------
export interface Placed {
  hash: string;
  src: string;
  dest: string;
  kind: Kind;
  title: string;
  year?: number;
  show?: string;
  episode?: string;
  at: number;
  jfId?: string;
  sorted: boolean;
  subs: 'pending' | 'done' | 'none' | 'failed' | 'has';
  subTries: number;
  subAt?: number;
  told: boolean;
}
const PLACED = 'media_placed';
const DONE = 'media_done_torrents';
export function placed(): Placed[] {
  try {
    return JSON.parse(kvGet(PLACED) ?? '[]') as Placed[];
  } catch {
    return [];
  }
}
const savePlaced = (p: Placed[]) => kvSet(PLACED, JSON.stringify(p.slice(-1500)));

/** Hardlink (same disk, no extra space); a copy if it ever has to cross disks. */
export function linkInto(src: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) return;
  try {
    fs.linkSync(src, dest);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
    fs.copyFileSync(src, dest);
  }
}

const run = promisify(execFile);
/**
 * Indian releases put the Hindi dub first and mark it default (and forced), so Jellyfin plays Hindi.
 * When the file also has English audio, the flags are flipped in place (mkvpropedit, no rewrite).
 * Only Hindi-first files are touched, so Arabic-dubbed cartoons keep their Arabic default.
 */
export async function englishOverHindi(file: string): Promise<boolean> {
  try {
    const { stdout } = await run('mkvmerge', ['-J', file], { maxBuffer: 16 * 1024 * 1024, timeout: 60_000 });
    const tracks = (JSON.parse(stdout) as { tracks: { id: number; type: string; properties: { language?: string; default_track?: boolean } }[] }).tracks;
    const eng = tracks.find((t) => t.type === 'audio' && t.properties.language === 'eng');
    const hinDefault = tracks.some((t) => t.type === 'audio' && t.properties.language === 'hin' && t.properties.default_track);
    if (!eng || !hinDefault) return false;
    const args = tracks
      .filter((t) => (t.type === 'audio' || t.type === 'subtitles') && t.properties.language === 'hin')
      .flatMap((t) => ['--edit', `track:${t.id + 1}`, '--set', 'flag-default=0', '--set', 'flag-forced=0']);
    await run('mkvpropedit', [file, ...args, '--edit', `track:${eng.id + 1}`, '--set', 'flag-default=1'], { timeout: 60_000 });
    return true;
  } catch {
    return false; // mkvtoolnix missing or an odd file: leave it as it came
  }
}
/** The extension a video gets in the library: MPEG-TS becomes MP4 (see placeVideo). */
export const libExt = (name: string) => (/\.ts$/i.test(name) ? '.mp4' : path.extname(name).toLowerCase());
/**
 * A video into the library. MPEG-TS (TV recordings) is rewrapped as MP4 without re-encoding: browsers
 * and the Android TV app play MP4 directly, while a .ts goes through Jellyfin's HLS remux, whose
 * 6-second segments don't match the file's keyframes, and the phone's player gives up after a second.
 * The copy costs space (no hardlink), so it's only for .ts. If ffmpeg fails, the .ts is linked as is.
 * Returns where the video ended up.
 */
export async function placeVideo(src: string, dest: string): Promise<string> {
  if (!/\.ts$/i.test(src) || !dest.endsWith('.mp4')) {
    linkInto(src, dest);
    if (/\.mkv$/i.test(dest)) await englishOverHindi(dest);
    return dest;
  }
  if (fs.existsSync(dest)) return dest;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = `${dest}.part.mp4`;
  try {
    await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', src, '-map', '0:v:0', '-map', '0:a?', '-c', 'copy', '-movflags', '+faststart', part], { timeout: 30 * 60_000 });
    fs.renameSync(part, dest);
    return dest;
  } catch {
    fs.rmSync(part, { force: true });
    const ts = dest.replace(/\.mp4$/, path.extname(src));
    linkInto(src, ts);
    return ts;
  }
}

/** Files of a finished torrent → their place in the library. Returns what was placed. */
/** A qBittorrent category chosen when adding a torrent → the shelf it must go to (no guessing). */
export const CATEGORY_KIND: Record<string, Kind> = { Movies: 'movies', Series: 'series', Cartoons: 'cartoons', 'Cartoon Series': 'cartoonSeries', Anime: 'anime', Documentaries: 'documentaries', Videos: 'videos' };
/** A torrent/folder name as a show title: site tags, brackets and codes out. */
export function cleanShowName(name: string): string {
  return (
    name
      .replace(/\[[^\]]*\]|\([^)]*(www|\.com|\.net|blogspot)[^)]*\)/gi, ' ')
      .replace(/(www\.)?[\w-]+\.(com|net|org|tv)(?=$|[^a-z])(_\d+)?/gi, ' ')
      .replace(/[._]+/g, ' ')
      .replace(/\b(720p|1080p|480p|dvd|bluray|web-?dl|x26[45]|hevc|mp4|mkv|arabic|ara|dub(bed)?|مدبلج|كامل|جودة\s*\S+|جميع الحلقات)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim() || name
  ).slice(0, 80);
}
const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

export async function organizeTorrent(
  t: { hash: string; name: string; save_path?: string; download_path?: string; progress?: number; category?: string },
  skip: Set<string> = new Set(),
): Promise<Placed[]> {
  // Files not chosen for download are left out; only finished files are placed (a big torrent fills in as it goes).
  const all = (await (await qb(`torrents/files?hash=${t.hash}`)).json()) as { name: string; size: number; progress?: number; priority?: number }[];
  // Until the whole torrent is done, qBittorrent keeps it in the temporary folder.
  const base = ((t.progress ?? 1) < 1 && t.download_path ? t.download_path : (t.save_path ?? '/downloads/Torrents')).replace(/\/$/, '');
  const hostOf = (name: string) => path.join(LIB.downloads, path.relative(LIB.qbDownloads, path.join(base, name)));
  return organizeFiles(t, all, hostOf, skip);
}

/**
 * Places finished files of one download (a torrent, or an Internet Archive item) into the library.
 * `hostOf(name)` is where a file of the download is on this machine.
 */
export async function organizeFiles(
  t: { hash: string; name: string; category?: string },
  all: { name: string; size: number; progress?: number; priority?: number }[],
  hostOf: (name: string) => string,
  skip: Set<string> = new Set(),
): Promise<Placed[]> {
  const files = all.filter((f) => f.priority !== 0);
  const forced = t.category ? CATEGORY_KIND[t.category] : undefined;
  const series = forced === 'series' || forced === 'cartoonSeries' || forced === 'anime';
  // Small files count when the shelf is known (old cartoon episodes can be 30 MB).
  const videos = files.filter((f) => (VIDEO.test(f.name) || /\.vob$/i.test(f.name)) && !/\bsample\b/i.test(f.name) && f.size > (forced ? 5 : 40) * 1024 * 1024).sort((a, b) => natural(a.name, b.name));
  // Folders of a collection: one big video in a folder → the folder names the film; small clips beside it are extras.
  const bigInDir = new Map<string, number>();
  for (const f of videos) if (f.size > 150 * 1024 * 1024) bigInDir.set(path.dirname(f.name), (bigInDir.get(path.dirname(f.name)) ?? 0) + 1);
  const out: Placed[] = [];
  const multi = videos.length > 1;
  const showName = series ? cleanShowName(t.name) : '';
  for (const [i, f] of videos.entries()) {
    if ((f.progress ?? 1) < 1) continue;
    const src = hostOf(f.name);
    if (!fs.existsSync(src)) continue;
    const parts = f.name.split('/');
    // A DVD (VIDEO_TS): the whole folder is one film, linked as is — Jellyfin plays DVD folders.
    if (forced && !series && /\.vob$/i.test(f.name)) {
      const vt = parts.findIndex((p) => /^VIDEO_TS$/i.test(p));
      if (vt < 1) continue;
      // Only a whole DVD: a half-there VIDEO_TS shows up in Jellyfin with no playable stream, and
      // Jellyfin doesn't probe it again when the rest arrives.
      const dvdFiles = files.filter((x) => path.dirname(x.name) === path.dirname(f.name));
      if (dvdFiles.some((x) => (x.progress ?? 1) < 1 || !fs.existsSync(hostOf(x.name)))) continue;
      const r = parseRelease(parts[vt - 1]);
      const t2 = safe(r.title) + (r.year ? ` (${r.year})` : '');
      const dvdDest = path.join(LIB.media, FOLDERS[forced], t2, 'VIDEO_TS');
      for (const g of all.filter((x) => path.dirname(x.name) === path.dirname(f.name) && (x.progress ?? 1) >= 1)) {
        const gs = hostOf(g.name);
        if (fs.existsSync(gs)) linkInto(gs, path.join(dvdDest, path.basename(g.name)));
      }
      const marker = path.dirname(dvdDest); // Jellyfin lists a DVD by its folder
      if (!skip.has(marker) && !out.some((x) => x.dest === marker)) out.push({ hash: t.hash, src, dest: marker, kind: forced, title: r.title, year: r.year, at: Date.now(), sorted: true, subs: 'has', subTries: 0, told: false });
      continue;
    }
    if (forced && !series && bigInDir.get(path.dirname(f.name)) && f.size < 100 * 1024 * 1024) continue; // start/end clips
    if (series) {
      // A series picked for a shelf: the torrent's name is the show; episodes by number, else in file order.
      const r = parseRelease(path.basename(f.name));
      const ep = r.episode ?? (/(\d{1,4})(?!.*\d)/.exec(path.basename(f.name, path.extname(f.name)))?.[1] ? +/(\d{1,4})(?!.*\d)/.exec(path.basename(f.name, path.extname(f.name)))![1] : i + 1);
      const season = seasonFor(path.join(LIB.media, FOLDERS[forced!], safe(showName)), ep, r.season ?? 1);
      const rel = destination({ title: showName, season, episode: ep, anime: false, kind: 'episode' }, forced!, libExt(f.name), showName);
      let dest = path.join(LIB.media, rel);
      if (skip.has(dest) || skip.has(dest.replace(/\.mp4$/, '.ts'))) continue;
      dest = await placeVideo(src, dest);
      out.push({ hash: t.hash, src, dest, kind: forced!, title: showName, show: showName, episode: `S${pad(r.season ?? 1)}E${pad(ep)}`, at: Date.now(), sorted: true, subs: 'has', subTries: 0, told: false });
      continue;
    }
    // A season pack: the episode is in the file name; a single film: the torrent name is often cleaner.
    const dirName = parts.length >= 3 ? parts[parts.length - 2] : '';
    const byFolder = forced && multi && dirName && bigInDir.get(path.dirname(f.name)) === 1;
    const r = parseRelease(byFolder ? dirName : multi ? path.basename(f.name) : /\bS\d{1,2}\s?E\d/i.test(f.name) || !t.name ? path.basename(f.name) : t.name);
    if (multi && r.kind === 'movie' && !byFolder) Object.assign(r, parseRelease(path.basename(f.name)));
    let kind: Kind = forced ?? 'movies';
    let show: Show | null = null;
    if (!forced && (r.kind === 'episode' || r.season !== undefined)) {
      show = r.anime ? null : await tvmaze(r.title);
      kind = seriesKind(show, r.anime);
    }
    const ext = libExt(f.name);
    const showYear = show?.premiered ? +show.premiered.slice(0, 4) : r.year;
    const rel = destination(r, kind, ext, show?.name ?? r.title, kind === 'movies' ? undefined : showYear);
    let dest = path.join(LIB.media, rel);
    const tsDest = dest.replace(/\.mp4$/, '.ts');
    if (skip.has(dest) || skip.has(tsDest) || out.some((x) => x.dest === dest)) continue;
    dest = await placeVideo(src, dest);
    // Subtitles that came with it (an Arabic one keeps Jellyfin from searching).
    let subs: Placed['subs'] = 'pending';
    for (const s of files.filter((x) => SUBS.test(x.name) && path.dirname(x.name) === path.dirname(f.name))) {
      const lang = /\b(ara|arabic|ar)\b/i.test(s.name) ? 'ar' : /\b(eng|english|en)\b/i.test(s.name) ? 'en' : 'und';
      const sp = hostOf(s.name);
      if (fs.existsSync(sp)) linkInto(sp, dest.replace(/\.[^.]+$/, `.${lang}${path.extname(s.name)}`));
      if (lang === 'ar') subs = 'has';
    }
    out.push({ hash: t.hash, src, dest, kind, title: r.title, year: r.year, show: show?.name ?? (r.kind === 'episode' ? r.title : undefined), episode: r.episode !== undefined ? `S${pad(r.season ?? 1)}E${pad(r.episode)}` : undefined, at: Date.now(), sorted: kind !== 'movies' || !!forced, subs: forced === 'cartoons' && /مدبلج|arabic|dub/i.test(t.name) ? 'has' : subs, subTries: 0, told: false });
  }
  return out;
}

const toJf = (hostPath: string) => path.join(LIB.jfMedia, path.relative(LIB.media, hostPath));
const fromJf = (jfPath: string) => path.join(LIB.media, path.relative(LIB.jfMedia, jfPath));

interface JfItem {
  Id: string;
  Path?: string;
  Name: string;
  Genres?: string[];
  ProductionLocations?: string[];
  HasSubtitles?: boolean;
  ProviderIds?: Record<string, string>;
  RunTimeTicks?: number;
}
/** A film's kind from Jellyfin's metadata. */
export function movieKind(it: Pick<JfItem, 'Genres' | 'ProductionLocations'>): Kind {
  const g = it.Genres ?? [];
  if (g.includes('Documentary')) return 'documentaries';
  if (g.includes('Animation') || g.includes('Anime')) return g.includes('Anime') || (it.ProductionLocations ?? []).includes('Japan') ? 'anime' : 'cartoons';
  return 'movies';
}

/** Best Arabic subtitle: a release-name match first, then the most downloaded. */
export function pickSubtitle(subs: { Id: string; Name?: string; DownloadCount?: number; IsHashMatch?: boolean }[], release: string) {
  const words = new Set(release.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
  const score = (s: (typeof subs)[number]) => (s.IsHashMatch ? 1000 : 0) + (s.Name ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => words.has(w)).length * 10 + Math.log10(1 + (s.DownloadCount ?? 0));
  return [...subs].sort((a, b) => score(b) - score(a))[0] ?? null;
}

const SUB_TRIES = 15;
let busy = false;
let refreshAt = 0;
/** Every couple of minutes: new finished torrents in, films sorted, subtitles fetched, the owner told. */
export async function mediaTick(): Promise<void> {
  if (!libraryOn() || busy) return;
  busy = true;
  try {
    const done = new Set<string>(JSON.parse(kvGet(DONE) ?? '[]') as string[]);
    let list = placed();
    let added = 0;
    const have = new Set(list.map((x) => x.dest));
    for (const t of (await qbList()) as (Awaited<ReturnType<typeof qbList>>[number] & { category?: string; download_path?: string })[]) {
      if (done.has(t.hash)) continue;
      // Untagged torrents are placed when complete; ones tagged with a shelf fill in file by file.
      if (t.progress < 1 && !(t.category && CATEGORY_KIND[t.category])) continue;
      const p = await organizeTorrent(t, have);
      for (const x of p) have.add(x.dest);
      list = list.concat(p);
      added += p.length;
      // Closed only after a pass that found nothing new: qBittorrent can report the torrent done a
      // moment before its last files are, and a closed torrent is never looked at again.
      if (t.progress >= 1 && !p.length) done.add(t.hash);
    }
    // Internet Archive items downloaded over HTTPS (archiveDl.ts): placed file by file, like tagged torrents.
    for (const a of archiveDownloads()) {
      if (done.has(a.meta.hash)) continue;
      const p = await organizeFiles(a.meta, a.files, a.hostOf, have);
      for (const x of p) have.add(x.dest);
      list = list.concat(p);
      added += p.length;
      if (a.complete && !p.length) done.add(a.meta.hash);
    }
    kvSet(DONE, JSON.stringify([...done].slice(-3000)));
    if (added) {
      savePlaced(list);
      await jf('/Library/Refresh', { method: 'POST' }).catch(() => {});
      refreshAt = Date.now();
      return;
    }
    // Let Jellyfin scan and fetch metadata before looking items up.
    if (Date.now() - refreshAt < 3 * 60_000) return;
    let changed = false;
    const FIELDS = 'Path,Genres,ProductionLocations,ProviderIds';
    const match = (x: JfItem, p: Placed) => !!x.Path && (fromJf(x.Path) === p.dest || (!path.extname(p.dest) && [fromJf(x.Path), path.dirname(fromJf(x.Path))].includes(p.dest)));
    // Jellyfin's name is often not the file's ("Captain America: Civil War" vs "… - Civil War"), so a
    // name search can miss; then the whole list (paths only, a few hundred items) is looked through once.
    let all: JfItem[] | null = null;
    for (const p of list.filter((x) => (!x.told || x.subs === 'pending') && x.jfId !== 'missing')) {
      const items = await jf<{ Items: JfItem[] }>(`/Items?Recursive=true&IncludeItemTypes=Movie,Episode,Video&Fields=${FIELDS}&searchTerm=${encodeURIComponent((p.show ?? p.title).slice(0, 40))}&Limit=200`).catch(() => ({ Items: [] as JfItem[] }));
      let it = items.Items.find((x) => match(x, p));
      if (!it) {
        all ??= (await jf<{ Items: JfItem[] }>(`/Items?Recursive=true&IncludeItemTypes=Movie,Episode,Video&Fields=${FIELDS}`).catch(() => ({ Items: [] as JfItem[] }))).Items;
        it = all.find((x) => match(x, p));
      }
      if (!it) {
        // Not found by name (Jellyfin may have renamed it): one more try a while later is enough.
        if (Date.now() - p.at > 2 * 3600_000 && p.subs === 'pending') {
          p.subs = 'failed';
          p.jfId = p.jfId ?? 'missing';
          changed = true;
        }
        continue;
      }
      p.jfId = it.Id;
      // Films: the right shelf from Jellyfin's genres (cartoon, anime, documentary).
      if (!p.sorted && p.kind === 'movies') {
        p.sorted = true;
        const k = movieKind(it);
        if (k !== 'movies') {
          const from = path.dirname(p.dest);
          const to = path.join(LIB.media, FOLDERS[k], path.basename(from));
          if (!fs.existsSync(to)) fs.renameSync(from, to);
          p.dest = path.join(to, path.basename(p.dest));
          p.kind = k;
          p.jfId = undefined;
          changed = true;
          await jf('/Library/Refresh', { method: 'POST' }).catch(() => {});
          refreshAt = Date.now();
          continue;
        }
        changed = true;
      }
      // Subtitles: at once, then every 12 h for a week — Arabic ones for new films often come days
      // after the WEB release. Searching is free; only a download counts against the 20 a day.
      if (p.subs === 'pending' && p.subTries < SUB_TRIES && Date.now() >= (p.subAt ?? 0)) {
        p.subTries++;
        p.subAt = Date.now() + 12 * 3600_000;
        changed = true;
        const wasTold = p.told;
        const subs = await jf<{ Id: string; Name?: string; DownloadCount?: number; IsHashMatch?: boolean }[]>(`/Items/${p.jfId}/RemoteSearch/Subtitles/ara?isPerfectMatch=false`).catch(() => []);
        const best = pickSubtitle(subs, path.basename(p.src));
        let got = false;
        if (best) {
          await jf(`/Items/${p.jfId}/RemoteSearch/Subtitles/${encodeURIComponent(best.Id)}`, { method: 'POST' })
            .then(() => ((p.subs = 'done'), (got = true)))
            .catch(() => (p.subs = p.subTries >= SUB_TRIES ? 'failed' : 'pending'));
        }
        // OpenSubtitles had none, or its 20 a day are used up: a film's other source, checked for sync.
        const imdb = it.ProviderIds?.Imdb;
        if (!got && !p.show && imdb) {
          const name = await fetchArabicFallback(imdb, p.dest, (it.RunTimeTicks ?? 0) / 1e7).catch(() => null);
          if (name) {
            p.subs = 'done';
            got = true;
            await jf(`/Items/${p.jfId}/Refresh?MetadataRefreshMode=Default&ImageRefreshMode=None`, { method: 'POST' }).catch(() => {});
          }
        }
        if (!got && !best && p.subTries >= SUB_TRIES) p.subs = 'none';
        // No human Arabic subtitle on the first look: translate the English one meanwhile (once).
        if (!got && p.subTries === 1 && p.jfId) enqueue(p.jfId, p.show ? `${p.show} ${p.episode ?? ''}`.trim() : `${p.title}${p.year ? ` (${p.year})` : ''}`);
        // Found later for something already announced: one short line (films only, not every episode).
        if (wasTold && (p.subs as Placed['subs']) === 'done' && !p.show) await postHook({ type: 'notice', text: `🔤 لقيت ترجمة عربي لـ <b>${esc(p.title)}${p.year ? ` (${p.year})` : ''}</b>` });
      }
    }
    // One message per torrent, once all its files are in place (a season pack is one line, not ten).
    for (const hash of new Set(list.filter((x) => !x.told).map((x) => x.hash))) {
      const group = list.filter((x) => x.hash === hash);
      if (group.some((x) => !x.told && (!x.jfId || (x.subs === 'pending' && x.subTries === 0)))) continue;
      const fresh = group.filter((x) => !x.told);
      if (!fresh.length) continue;
      for (const x of fresh) x.told = true;
      changed = true;
      const p = fresh[0];
      const shelf = LIBRARIES.find((l) => l.kind === p.kind)!.name.split(' · ')[0];
      const films = fresh.filter((x) => !x.show);
      const what = p.show
        ? `${p.show}${fresh.length > 1 ? ` · ${fresh.length} حلقات` : ` ${p.episode ?? ''}`}`
        : films.length > 1
          ? `${films.length} أفلام جديدة: ${films.slice(0, 6).map((x) => x.title).join('، ')}${films.length > 6 ? '…' : ''}`
          : `${p.title}${p.year ? ` (${p.year})` : ''}`;
      const ok = fresh.filter((x) => x.subs === 'done' || x.subs === 'has').length;
      const sub = ok === fresh.length ? 'ترجمة عربي ✅' : ok ? `ترجمة عربي لـ ${ok} من ${fresh.length}` : 'ما لقيت ترجمة عربي لسا';
      await postHook({ type: 'notice', text: `🎬 <b>${esc(what.trim())}</b> صار بـ Jellyfin ← ${shelf}\n${sub}${ok < fresh.length ? ' · رح ضل دوّر عليها كل 12 ساعة لأسبوع' : ''}` });
    }
    if (changed) savePlaced(list);
  } finally {
    busy = false;
  }
}

export function startMediaLibrary(): () => void {
  if (process.env.VITEST) return () => {};
  const t = setInterval(() => void mediaTick().catch(() => {}), 2 * 60_000);
  return () => clearInterval(t);
}
