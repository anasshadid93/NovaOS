import { useSyncExternalStore } from 'react';
import { getScale } from './scale';
import { desks } from './desks';

/**
 * Desktop window manager state: a tiny external store (no library), persisted per browser so
 * windows come back where they were after a reload.
 */

export type Snap = 'left' | 'right' | 'tl' | 'tr' | 'bl' | 'br' | null;

export interface Win {
  id: string;
  /** Desktop app id ("files", "monitor", …) or "web:<launcher key>" for a web app. */
  app: string;
  title: string;
  /** In-window route for NovaOS screens, URL for web apps (follows navigation). */
  route: string;
  /** The route it was opened with. */
  start: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  minimized: boolean;
  maximized: boolean;
  snap: Snap;
  /** Virtual desktop it lives on (0 = the first). */
  desk?: number;
}

export interface OpenOpts {
  app: string;
  title: string;
  route: string;
  w?: number;
  h?: number;
  /** Open another window even if this one is already open. */
  newWindow?: boolean;
}

const KEY = 'manar.desktop.windows';
export const TASKBAR_H = 56;
const MIN_W = 320;
const MIN_H = 240;

type Listener = () => void;
let wins: Win[] = load();
let topZ = wins.reduce((m, w) => Math.max(m, w.z), 10);
const listeners = new Set<Listener>();

function load(): Win[] {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? '[]') as Win[];
    return Array.isArray(list) ? list.filter((w) => w && typeof w.id === 'string' && typeof w.app === 'string') : [];
  } catch {
    return [];
  }
}

let saveTimer: number | undefined;
function emit(next: Win[]) {
  wins = next;
  listeners.forEach((l) => l());
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => localStorage.setItem(KEY, JSON.stringify(wins)), 300);
}

/** The desktop's size in desktop pixels (the screen divided by the display scale), minus the taskbar. */
const area = () => ({ w: window.innerWidth / getScale(), h: window.innerHeight / getScale() - TASKBAR_H });

/** Keeps a window reachable: at least its title bar stays on screen. */
function clamp(w: Win): Win {
  const a = area();
  const width = Math.min(Math.max(w.w, MIN_W), a.w);
  const height = Math.min(Math.max(w.h, MIN_H), a.h);
  const x = Math.min(Math.max(w.x, -width + 120), a.w - 120);
  const y = Math.min(Math.max(w.y, 0), a.h - 40);
  return { ...w, w: width, h: height, x, y };
}

export const wm = {
  subscribe(l: Listener) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  get: () => wins,

  open(o: OpenOpts): string {
    // Same app at the same place: bring that window forward instead of opening a copy.
    const existing = !o.newWindow && wins.find((w) => w.app === o.app && (w.start ?? w.route) === o.route);
    if (existing) {
      // It may live on another desktop: go there.
      desks.switchTo(existing.desk ?? 0);
      wm.focus(existing.id);
      return existing.id;
    }
    const a = area();
    const w = Math.min(o.w ?? 960, a.w - 40);
    const h = Math.min(o.h ?? 640, a.h - 40);
    // Cascade new windows so they don't stack exactly on top of each other.
    const n = wins.filter((x) => !x.minimized && (x.desk ?? 0) === desks.current()).length % 8;
    const win: Win = clamp({
      id: `${o.app}-${Date.now().toString(36)}`,
      app: o.app,
      title: o.title,
      route: o.route,
      start: o.route,
      x: Math.max(0, Math.min(a.w - w, Math.round((a.w - w) / 2) + n * 28 - 98)),
      y: Math.max(0, Math.min(a.h - h, Math.round((a.h - h) / 2) + n * 28 - 98)),
      w,
      h,
      z: ++topZ,
      minimized: false,
      maximized: false,
      snap: null,
      desk: desks.current(),
    });
    emit([...wins, win]);
    return win.id;
  },

  close(id: string) {
    emit(wins.filter((w) => w.id !== id));
  },

  focus(id: string) {
    const w = wins.find((x) => x.id === id);
    if (!w || (w.z === topZ && !w.minimized)) return;
    emit(wins.map((x) => (x.id === id ? { ...x, z: ++topZ, minimized: false } : x)));
  },

  update(id: string, patch: Partial<Win>) {
    emit(wins.map((x) => (x.id === id ? clamp({ ...x, ...patch }) : x)));
  },

  minimize(id: string) {
    emit(wins.map((x) => (x.id === id ? { ...x, minimized: true } : x)));
  },

  toggleMax(id: string) {
    emit(wins.map((x) => (x.id === id ? { ...x, maximized: !x.maximized && !x.snap, snap: null, z: ++topZ } : x)));
  },

  setSnap(id: string, snap: Snap) {
    emit(wins.map((x) => (x.id === id ? { ...x, snap, maximized: false, z: ++topZ } : x)));
  },

  /** Taskbar click: focus, or minimize if it's already the front window. */
  toggleFromTaskbar(id: string) {
    const w = wins.find((x) => x.id === id);
    if (!w) return;
    const front = !w.minimized && w.z === topZ;
    if (front) wm.minimize(id);
    else wm.focus(id);
  },

  minimizeAll() {
    emit(wins.map((x) => ((x.desk ?? 0) === desks.current() ? { ...x, minimized: true } : x)));
  },

  moveToDesk(id: string, desk: number) {
    emit(wins.map((x) => (x.id === id ? { ...x, desk } : x)));
  },

  /** A desktop is being removed: its windows join the one before it; later desktops shift down. */
  dropDesk(i: number) {
    emit(wins.map((x) => {
      const d = x.desk ?? 0;
      return d >= i ? { ...x, desk: Math.max(0, d - 1) } : x;
    }));
  },

  /** The window on top (for keyboard shortcuts). */
  front(): Win | undefined {
    return wins.filter((w) => !w.minimized && (w.desk ?? 0) === desks.current()).sort((a, b) => b.z - a.z)[0];
  },

  /** Cycle focus through open windows (Alt+`). */
  cycle() {
    const list = wins.filter((w) => (w.desk ?? 0) === desks.current()).sort((a, b) => a.z - b.z);
    if (list.length > 1) wm.focus(list[0].id);
  },

  setTitle(id: string, title: string) {
    const w = wins.find((x) => x.id === id);
    if (w && w.title !== title) emit(wins.map((x) => (x.id === id ? { ...x, title } : x)));
  },

  setRoute(id: string, route: string) {
    const w = wins.find((x) => x.id === id);
    if (w && w.route !== route) emit(wins.map((x) => (x.id === id ? { ...x, route } : x)));
  },
};

export function useWindows(): Win[] {
  return useSyncExternalStore(wm.subscribe, wm.get);
}

/** Pixel rectangle a window occupies, taking maximize/snap into account. */
export function rectOf(w: Win): { x: number; y: number; w: number; h: number } {
  const a = area();
  const half = { w: Math.floor(a.w / 2), h: Math.floor(a.h / 2) };
  if (w.maximized) return { x: 0, y: 0, w: a.w, h: a.h };
  switch (w.snap) {
    case 'left':
      return { x: 0, y: 0, w: half.w, h: a.h };
    case 'right':
      return { x: a.w - half.w, y: 0, w: half.w, h: a.h };
    case 'tl':
      return { x: 0, y: 0, w: half.w, h: half.h };
    case 'tr':
      return { x: a.w - half.w, y: 0, w: half.w, h: half.h };
    case 'bl':
      return { x: 0, y: a.h - half.h, w: half.w, h: half.h };
    case 'br':
      return { x: a.w - half.w, y: a.h - half.h, w: half.w, h: half.h };
    default:
      return { x: w.x, y: w.y, w: w.w, h: w.h };
  }
}

/** Where a dragged title bar would snap, from the pointer position. */
export function snapAt(px: number, py: number): Snap {
  const a = area();
  const edge = 12;
  const corner = 80;
  const left = px <= edge;
  const right = px >= a.w - edge;
  if (!left && !right) return null;
  if (py <= corner) return left ? 'tl' : 'tr';
  if (py >= a.h - corner) return left ? 'bl' : 'br';
  return left ? 'left' : 'right';
}

export { MIN_H, MIN_W };
