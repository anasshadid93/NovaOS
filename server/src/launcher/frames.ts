import { config } from '../config.js';

/**
 * Can a launcher app be shown inside a MinisManager desktop window (an iframe)?
 * Decided from the app's own response headers, the same way the browser will:
 *  - MinisManager is HTTPS, so a plain-http app can't load in it;
 *  - X-Frame-Options DENY/SAMEORIGIN, or a CSP frame-ancestors without our origin, forbid it.
 * Apps that say no open in a browser tab instead.
 */

export function frameAllowed(url: string, headers: Headers, origin = config.publicOrigin): boolean {
  if (new URL(url).protocol !== new URL(origin).protocol && new URL(origin).protocol === 'https:') return false;
  const xfo = headers.get('x-frame-options')?.trim().toLowerCase();
  if (xfo === 'deny' || (xfo === 'sameorigin' && new URL(url).origin !== origin)) return false;
  for (const csp of (headers.get('content-security-policy') ?? '').split(',')) {
    const fa = csp
      .split(';')
      .map((d) => d.trim())
      .find((d) => d.toLowerCase().startsWith('frame-ancestors'));
    if (!fa) continue;
    const sources = fa.split(/\s+/).slice(1);
    const ok = sources.some((s) => s === '*' || s === origin || (s === "'self'" && new URL(url).origin === origin) || s === `${new URL(origin).protocol}`);
    if (!ok) return false;
  }
  return true;
}

const cache = new Map<string, { at: number; ok: boolean }>();
const TTL = 10 * 60_000;

export async function canFrame(url: string): Promise<boolean> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL) return hit.ok;
  let ok = false;
  try {
    let target = url;
    // Follow a few redirects by hand: each hop's headers count (e.g. "/" → "/login").
    for (let hop = 0; hop < 4; hop++) {
      const res = await fetch(target, { redirect: 'manual', signal: AbortSignal.timeout(4000) });
      if (!frameAllowed(target, res.headers)) {
        ok = false;
        break;
      }
      const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      ok = true;
      if (!loc) break;
      target = new URL(loc, target).href;
    }
  } catch {
    ok = false; // unreachable now: a tab will show the browser's own error
  }
  cache.set(url, { at: Date.now(), ok });
  return ok;
}
