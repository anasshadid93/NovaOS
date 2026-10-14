import { useSyncExternalStore } from 'react';
import { api } from '../lib/api';

/**
 * Desktop lists saved on the server (same on every computer), cached in localStorage so the
 * desktop draws instantly: hidden icons, taskbar pins and icon order.
 */
export interface DeskLists {
  hidden: string[];
  pinned: string[];
  order: string[];
}
/** An app folder on the desktop: apps dropped onto each other. Its icon's key is `grp:<id>`. */
export interface AppGroup {
  id: string;
  name: string;
  keys: string[];
}
type Key = keyof DeskLists;
type Stored = DeskLists & { groups: AppGroup[] };

export const DEFAULT_PINNED = ['files', 'gallery', 'monitor', 'docker', 'store', 'app:browser'];
const KEY = 'manar.desktop.lists';
const listeners = new Set<() => void>();

let lists: Stored = (() => {
  const base: Stored = { hidden: [], pinned: DEFAULT_PINNED, order: [], groups: [] };
  try {
    return { ...base, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Stored>) };
  } catch {
    return base;
  }
})();

const emit = (next: Stored) => {
  lists = next;
  localStorage.setItem(KEY, JSON.stringify(next));
  listeners.forEach((l) => l());
};

let loaded = false;
function load() {
  if (loaded) return;
  loaded = true;
  void api<Partial<Stored>>('/api/desktop/prefs')
    .then((p) => {
      const next = { ...lists };
      for (const k of ['hidden', 'pinned', 'order'] as Key[]) if (Array.isArray(p[k])) next[k] = p[k]!;
      if (Array.isArray(p.groups)) next.groups = p.groups;
      emit(next);
    })
    .catch(() => {});
}

export function setList(k: Key, value: string[]) {
  emit({ ...lists, [k]: value });
  void api('/api/desktop/prefs', { method: 'PUT', body: { [k]: value } }).catch(() => {});
}

/** Saves the folders; a folder left with fewer than two apps disappears. */
export function setGroups(groups: AppGroup[]) {
  const value = groups.filter((g) => g.keys.length >= 2);
  emit({ ...lists, groups: value });
  void api('/api/desktop/prefs', { method: 'PUT', body: { groups: value } }).catch(() => {});
}

export const toggleIn = (k: Key, key: string) => setList(k, lists[k].includes(key) ? lists[k].filter((x) => x !== key) : [...lists[k], key]);

export function useDeskLists(): Stored {
  load();
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => lists,
  );
}

/** Sort by the saved order; unknown keys keep their natural order after the known ones. */
export function ordered<T>(items: T[], keyOf: (t: T) => string, order: string[]): T[] {
  const pos = new Map(order.map((k, i) => [k, i]));
  return items
    .map((it, i) => ({ it, i, p: pos.get(keyOf(it)) ?? order.length + i }))
    .sort((a, b) => a.p - b.p)
    .map((x) => x.it);
}

/** Copy / cut of server files between the desktop and its folders. */
export const clip: { mode: 'copy' | 'move' | null; paths: string[] } = { mode: null, paths: [] };
