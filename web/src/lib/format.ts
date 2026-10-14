const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/**
 * Wraps a value in a left-to-right isolate (LRI…PDI) so "10.3 GB" or "52%" keeps
 * its order inside Arabic (RTL) text. Invisible in LTR.
 */
export const ltr = (s: string) => `\u2066${s}\u2069`;

export function formatBytes(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  let i = 0;
  let v = n;
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  return ltr(`${v.toFixed(i === 0 ? 0 : v >= 100 ? 0 : digits)} ${UNITS[i]}`);
}

export function formatRate(n: number | null | undefined): string {
  return ltr(`${formatBytes(n)}/s`);
}

export function formatPct(n: number | null | undefined, digits = 1): string {
  return n === null || n === undefined || !Number.isFinite(n) ? '—' : ltr(`${n.toFixed(digits)}%`);
}

/** Compact duration: 3d 4h, 5h 12m, 12m 3s. */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return ltr(`${d}d ${h}h`);
  if (h) return ltr(`${h}h ${m}m`);
  if (m) return ltr(`${m}m ${s % 60}s`);
  return ltr(`${s}s`);
}

export function formatTemp(c: number | null | undefined): string {
  return c === null || c === undefined ? '—' : ltr(`${Math.round(c)}°C`);
}
