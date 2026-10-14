import { useSyncExternalStore } from 'react';

export type ThemePref = 'system' | 'light' | 'dark';
const KEY = 'manar.theme';
const listeners = new Set<() => void>();
const darkQuery = matchMedia('(prefers-color-scheme: dark)');

function read(): ThemePref {
  const v = localStorage.getItem(KEY);
  return v === 'light' || v === 'dark' ? v : 'system';
}

let pref = read();

function apply() {
  const dark = pref === 'dark' || (pref === 'system' && darkQuery.matches);
  document.documentElement.classList.toggle('dark', dark);
}

/** Call once at startup; keeps <html class="dark"> in sync with the saved preference and the OS. */
export function initTheme() {
  apply();
  darkQuery.addEventListener('change', apply);
}

export function setThemePref(p: ThemePref) {
  localStorage.setItem(KEY, p);
  pref = p;
  apply();
  listeners.forEach((l) => l());
}

export function useThemePref(): ThemePref {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => pref,
  );
}

/** Whether the dark theme is showing right now (saved preference or the OS setting). */
export function useIsDark(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      darkQuery.addEventListener('change', l);
      return () => {
        listeners.delete(l);
        darkQuery.removeEventListener('change', l);
      };
    },
    () => pref === 'dark' || (pref === 'system' && darkQuery.matches),
  );
}
