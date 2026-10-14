import { useEffect, useSyncExternalStore } from 'react';
import { api } from '../lib/api';
import { fileUrl } from '../lib/fm';

/**
 * Desktop wallpaper: a built-in gradient (each with a light and a dark version) or any photo on
 * the server. Saved on the server, so every computer shows the same desktop.
 */

export type Wallpaper = { kind: 'preset'; id: string } | { kind: 'file'; path: string };

export interface Preset {
  id: string;
  name: string;
  light: string;
  dark: string;
}

const glow = (a: string, b: string, base: string) => `radial-gradient(1200px 700px at 12% 8%, ${a}, transparent 60%), radial-gradient(1000px 700px at 88% 92%, ${b}, transparent 60%), ${base}`;

export const PRESETS: Preset[] = [
  {
    id: 'minis',
    name: 'NovaOS',
    light: glow('rgb(47 111 228 / 0.18)', 'rgb(26 58 124 / 0.16)', 'linear-gradient(160deg, #eef3fb, #f7f9fd 45%, #e7eefb)'),
    dark: glow('rgb(47 111 228 / 0.25)', 'rgb(26 58 124 / 0.35)', 'linear-gradient(160deg, #0d1424, #111a2e 45%, #0b1220)'),
  },
  {
    id: 'aurora',
    name: 'Aurora',
    light: glow('rgb(45 212 191 / 0.35)', 'rgb(139 92 246 / 0.30)', 'linear-gradient(150deg, #ecfdf8, #eef2ff 55%, #f5f3ff)'),
    dark: glow('rgb(45 212 191 / 0.30)', 'rgb(139 92 246 / 0.35)', 'linear-gradient(150deg, #04131a, #0b1028 55%, #140a2a)'),
  },
  {
    id: 'sunset',
    name: 'Sunset',
    light: glow('rgb(251 146 60 / 0.40)', 'rgb(236 72 153 / 0.30)', 'linear-gradient(160deg, #fff7ed, #fff1f2 55%, #fdf2f8)'),
    dark: glow('rgb(251 146 60 / 0.30)', 'rgb(236 72 153 / 0.30)', 'linear-gradient(160deg, #1c0d06, #1f0a14 55%, #18061a)'),
  },
  {
    id: 'ocean',
    name: 'Ocean',
    light: glow('rgb(14 165 233 / 0.35)', 'rgb(37 99 235 / 0.30)', 'linear-gradient(170deg, #f0f9ff, #e0f2fe 50%, #dbeafe)'),
    dark: glow('rgb(14 165 233 / 0.30)', 'rgb(37 99 235 / 0.35)', 'linear-gradient(170deg, #021320, #04203a 50%, #071a3d)'),
  },
  {
    id: 'forest',
    name: 'Forest',
    light: glow('rgb(34 197 94 / 0.30)', 'rgb(13 148 136 / 0.30)', 'linear-gradient(160deg, #f0fdf4, #ecfdf5 55%, #f0fdfa)'),
    dark: glow('rgb(34 197 94 / 0.22)', 'rgb(13 148 136 / 0.30)', 'linear-gradient(160deg, #04140a, #061a14 55%, #041816)'),
  },
  {
    id: 'sand',
    name: 'Sand',
    light: glow('rgb(234 179 8 / 0.22)', 'rgb(180 83 9 / 0.18)', 'linear-gradient(160deg, #fefce8, #fdf6e3 55%, #faf0dc)'),
    dark: glow('rgb(234 179 8 / 0.16)', 'rgb(180 83 9 / 0.22)', 'linear-gradient(160deg, #17130a, #1c150b 55%, #1a1209)'),
  },
  {
    id: 'midnight',
    name: 'Midnight',
    light: glow('rgb(99 102 241 / 0.45)', 'rgb(168 85 247 / 0.35)', 'linear-gradient(160deg, #1e1b4b, #172554 55%, #0f172a)'),
    dark: glow('rgb(99 102 241 / 0.35)', 'rgb(168 85 247 / 0.28)', 'linear-gradient(160deg, #0b0a1f, #0a1024 55%, #05070f)'),
  },
  {
    id: 'graphite',
    name: 'Graphite',
    light: glow('rgb(100 116 139 / 0.25)', 'rgb(71 85 105 / 0.25)', 'linear-gradient(160deg, #f8fafc, #f1f5f9 55%, #e2e8f0)'),
    dark: glow('rgb(100 116 139 / 0.20)', 'rgb(71 85 105 / 0.25)', 'linear-gradient(160deg, #0b0d12, #111318 55%, #0a0b0f)'),
  },
];

export const DEFAULT_WALLPAPER: Wallpaper = { kind: 'preset', id: 'minis' };

let current: Wallpaper = (() => {
  try {
    return (JSON.parse(localStorage.getItem('manar.desktop.wallpaper') ?? 'null') as Wallpaper) ?? DEFAULT_WALLPAPER;
  } catch {
    return DEFAULT_WALLPAPER;
  }
})();
const listeners = new Set<() => void>();
const emit = (w: Wallpaper) => {
  current = w;
  localStorage.setItem('manar.desktop.wallpaper', JSON.stringify(w)); // instant on the next load
  listeners.forEach((l) => l());
};

export async function setWallpaper(w: Wallpaper) {
  emit(w);
  await api('/api/desktop/prefs', { method: 'PUT', body: { wallpaper: w } }).catch(() => {});
}

export function useWallpaper(): Wallpaper {
  useEffect(() => {
    void api<{ wallpaper?: Wallpaper }>('/api/desktop/prefs')
      .then((p) => p.wallpaper && JSON.stringify(p.wallpaper) !== JSON.stringify(current) && emit(p.wallpaper))
      .catch(() => {});
  }, []);
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}

/** CSS `background` for a wallpaper. Photos get a soft veil so icons and labels stay readable. */
export function wallpaperCss(w: Wallpaper, dark: boolean): string {
  if (w.kind === 'file') {
    const veil = dark ? 'rgb(0 0 0 / 0.25)' : 'rgb(255 255 255 / 0.08)';
    return `linear-gradient(${veil}, ${veil}), url("${fileUrl(w.path)}") center / cover no-repeat`;
  }
  const p = PRESETS.find((x) => x.id === w.id) ?? PRESETS[0];
  return dark ? p.dark : p.light;
}

/** Dark presets (and photos) need light icon labels. */
export const isDarkWallpaper = (w: Wallpaper, dark: boolean) => dark || w.kind === 'file' || w.id === 'midnight';
