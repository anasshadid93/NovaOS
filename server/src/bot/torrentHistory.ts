import { kvGet, kvSet } from '../db.js';

/** Torrents the owner downloaded (kept even after they leave qBittorrent), so lists never offer them again. */
const HISTORY = 'torrent_history';

/** "Spider-Man.Brand.New.Day.2026.1080p.WEB" → "spider man brand new day 2026"; episodes keep SxxEyy. */
export function titleKey(name: string): string {
  const words = name
    .toLowerCase()
    .replace(/[._\-()[\]{}+,:'"]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const out: string[] = [];
  for (const w of words) {
    out.push(w);
    if (/^(19|20)\d\d$/.test(w) && out.length > 1) break;
    if (/^s\d{1,2}e\d{1,3}$/.test(w) || /^s\d{1,2}$/.test(w)) break;
  }
  return out.slice(0, 8).join(' ');
}

export interface Had {
  h: string;
  k: string;
  n: string;
  at: number;
}
export function history(): Had[] {
  try {
    return JSON.parse(kvGet(HISTORY) ?? '[]') as Had[];
  } catch {
    return [];
  }
}
/** Remembers a download (so lists hide it even after it's removed from qBittorrent). */
export function remember(hash: string, name: string, now = Date.now()) {
  const h = history().filter((x) => x.h !== hash.toUpperCase());
  h.unshift({ h: hash.toUpperCase(), k: titleKey(name), n: name.slice(0, 200), at: now });
  kvSet(HISTORY, JSON.stringify(h.slice(0, 3000)));
}

/** From a magnet link: its hash (hex or base32) and display name. */
export function magnetInfo(link: string): { hash: string; name: string } | null {
  const h = /xt=urn:btih:([a-z0-9]{32,40})/i.exec(link);
  if (!h) return null;
  const dn = /[?&]dn=([^&]+)/.exec(link);
  let name = '';
  try {
    name = dn ? decodeURIComponent(dn[1].replace(/\+/g, ' ')) : '';
  } catch {
    name = dn?.[1] ?? '';
  }
  return { hash: h[1].toUpperCase(), name };
}
