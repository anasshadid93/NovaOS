import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

/**
 * App logos, cached on disk (var/icons). Order of sources:
 *  1. dashboard-icons (Apache-2.0) by name
 *  2. the app's own upstream icon from the catalog (CasaOS-AppStore, pinned commit)
 *  3. for your own services: the icon the running service publishes (manifest,
 *     apple-touch-icon or favicon), fetched from its 127.0.0.1 port.
 */

const MAX = 1024 * 1024;
const TTL_MS = 7 * 86400_000;
const SVC_TTL_MS = 86400_000;

export function sniff(buf: Buffer): string | null {
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.subarray(0, 4).toString() === 'GIF8') return 'image/gif';
  if (buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0) return 'image/x-icon';
  const head = buf.subarray(0, 512).toString('utf8').trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(head) || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml';
  return null;
}

async function fetchImage(url: string): Promise<{ buf: Buffer; type: string } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: 'follow' });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX) return null;
    const type = sniff(buf);
    return type ? { buf, type } : null;
  } catch {
    return null;
  }
}

const dir = () => path.join(config.dataDir, 'icons');

function readCache(key: string, ttl: number): { buf: Buffer; type: string } | 'miss' | null {
  const meta = path.join(dir(), `${key}.json`);
  try {
    const m = JSON.parse(fs.readFileSync(meta, 'utf8')) as { type: string | null; at: number };
    if (Date.now() - m.at > ttl) return null;
    if (!m.type) return 'miss';
    return { buf: fs.readFileSync(path.join(dir(), `${key}.img`)), type: m.type };
  } catch {
    return null;
  }
}

function writeCache(key: string, img: { buf: Buffer; type: string } | null) {
  fs.mkdirSync(dir(), { recursive: true });
  if (img) fs.writeFileSync(path.join(dir(), `${key}.img`), img.buf);
  fs.writeFileSync(path.join(dir(), `${key}.json`), JSON.stringify({ type: img?.type ?? null, at: Date.now() }));
}

const ALLOWED_HOSTS = new Set(['cdn.jsdelivr.net', 'raw.githubusercontent.com', 'icon.casaos.io', 'github.com', 'user-images.githubusercontent.com']);

export async function appIcon(name: string, upstream: string | null): Promise<{ buf: Buffer; type: string } | null> {
  const key = `app-${name}`;
  const cached = readCache(key, TTL_MS);
  if (cached === 'miss') return null;
  if (cached) return cached;
  let img: { buf: Buffer; type: string } | null = null;
  for (const c of new Set([name, name.replace(/-/g, '')])) {
    img = await fetchImage(`https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/${c}.png`);
    if (img) break;
  }
  if (!img && upstream) {
    try {
      const u = new URL(upstream);
      if (u.protocol === 'https:' && ALLOWED_HOSTS.has(u.hostname)) img = await fetchImage(u.href);
    } catch {
      /* bad URL */
    }
  }
  writeCache(key, img);
  return img;
}

/** Picks the best icon a web app advertises: manifest (largest), apple-touch-icon, PNG icons, SVG, favicon.ico. */
export async function serviceIcon(id: string, origin: string): Promise<{ buf: Buffer; type: string } | null> {
  const key = `svc-${id}`;
  const cached = readCache(key, SVC_TTL_MS);
  if (cached === 'miss') return null;
  if (cached) return cached;
  const base = new URL(origin);
  // Only ever talk to this machine's own services.
  if (base.hostname !== '127.0.0.1' && base.hostname !== 'localhost') return null;
  const candidates: { url: string; score: number }[] = [];
  try {
    const res = await fetch(base.href, { signal: AbortSignal.timeout(5000), redirect: 'follow' });
    const pageUrl = res.url || base.href;
    const html = (await res.text()).slice(0, 200_000);
    const abs = (href: string) => new URL(href.replace(/&amp;/g, '&'), pageUrl).href;
    for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
      const rel = /rel=["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase() ?? '';
      const href = /href=["']([^"']+)["']/i.exec(tag)?.[1];
      if (!href) continue;
      const size = Number(/sizes=["'](\d+)x\d+["']/i.exec(tag)?.[1] ?? 0);
      if (rel === 'manifest') {
        try {
          const m = (await (await fetch(abs(href), { signal: AbortSignal.timeout(5000) })).json()) as { icons?: { src: string; sizes?: string; purpose?: string }[] };
          for (const i of m.icons ?? []) {
            if (i.purpose && !i.purpose.split(' ').includes('any')) continue; // skip maskable-only
            const s = Math.max(...(i.sizes ?? '0x0').split(' ').map((x) => Number(x.split('x')[0]) || 0));
            candidates.push({ url: new URL(i.src, abs(href)).href, score: 1000 + Math.min(s, 512) });
          }
        } catch {
          /* no manifest */
        }
      } else if (rel.includes('apple-touch-icon')) candidates.push({ url: abs(href), score: 900 + size });
      else if (rel.split(' ').includes('icon')) {
        candidates.push({ url: abs(href), score: (/\.svg/i.test(href) ? 800 : 500) + size });
        // Many apps only link a tiny favicon but ship bigger icons next to it.
        for (const [n, sc] of [['android-chrome-512x512.png', 870], ['android-chrome-256x256.png', 865], ['android-chrome-192x192.png', 860], ['apple-touch-icon.png', 850]] as const)
          candidates.push({ url: new URL(n, abs(href)).href, score: sc });
      }
    }
    candidates.push({ url: new URL('/apple-touch-icon.png', pageUrl).href, score: 840 });
    candidates.push({ url: new URL('/favicon.ico', pageUrl).href, score: 1 });
  } catch {
    /* service down */
  }
  candidates.sort((a, b) => b.score - a.score);
  let img: { buf: Buffer; type: string } | null = null;
  for (const c of candidates) {
    if (new URL(c.url).hostname !== base.hostname) continue;
    img = await fetchImage(c.url);
    if (img) break;
  }
  writeCache(key, img);
  return img;
}
