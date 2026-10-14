import { useEffect, useState, useSyncExternalStore } from 'react';

/**
 * Desktop or phone layout. "auto" picks the desktop on a big screen with a mouse/trackpad
 * (laptops, monitors) and the phone layout everywhere else; Settings can force either.
 */
export type DesktopPref = 'auto' | 'desktop' | 'mobile';
const KEY = 'manar.desktop';
const listeners = new Set<() => void>();

export function getDesktopPref(): DesktopPref {
  const v = localStorage.getItem(KEY);
  return v === 'desktop' || v === 'mobile' ? v : 'auto';
}

export function setDesktopPref(p: DesktopPref) {
  if (p === 'auto') localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, p);
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

const QUERY = '(min-width: 1024px) and (min-height: 600px) and (pointer: fine)';

export function useDesktopPref(): DesktopPref {
  return useSyncExternalStore(subscribe, getDesktopPref);
}

export function useDesktopMode(): boolean {
  const pref = useDesktopPref();
  const [big, setBig] = useState(() => matchMedia(QUERY).matches);
  useEffect(() => {
    const m = matchMedia(QUERY);
    const on = () => setBig(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return pref === 'desktop' || (pref === 'auto' && big);
}
