import { useSyncExternalStore } from 'react';

/**
 * Desktop "display scale" (like a monitor's scaling setting): the whole desktop is drawn with
 * CSS zoom. Kept per device, since every screen differs. Pointer positions arrive in screen
 * pixels, so window maths divides them by the scale (see `toDesk`).
 */
export const SCALES = [0.75, 0.9, 1, 1.1, 1.25, 1.5] as const;
const KEY = 'manar.desktop.scale';
const listeners = new Set<() => void>();

let scale = (() => {
  const v = Number(localStorage.getItem(KEY));
  return (SCALES as readonly number[]).includes(v) ? v : 1;
})();

export const getScale = () => scale;
export const toDesk = (v: number) => v / scale;

export function setScale(v: number) {
  scale = v;
  localStorage.setItem(KEY, String(v));
  listeners.forEach((l) => l());
}

export function useScale(): number {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => scale,
  );
}
