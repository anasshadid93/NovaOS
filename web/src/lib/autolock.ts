import { useEffect } from 'react';
import { api } from './api';
import { useAuth } from './auth';

/** Minutes of inactivity before the screen locks on this device (0 = never). */
const KEY = 'manar.lock.idle';
export const getAutoLock = () => Number(localStorage.getItem(KEY) ?? 0) || 0;
export const setAutoLock = (min: number) => (min ? localStorage.setItem(KEY, String(min)) : localStorage.removeItem(KEY));

export function useAutoLock(active: boolean) {
  const { refresh } = useAuth();
  useEffect(() => {
    if (!active) return;
    let last = Date.now();
    const bump = () => (last = Date.now());
    const events = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;
    events.forEach((e) => addEventListener(e, bump, { passive: true }));
    const id = setInterval(() => {
      const min = getAutoLock();
      if (!min || Date.now() - last < min * 60_000) return;
      last = Date.now();
      // Only locks when a PIN is set (the server answers 409 otherwise).
      void api('/api/lock', { body: {} })
        .then(() => refresh())
        .catch(() => {});
    }, 15_000);
    return () => {
      clearInterval(id);
      events.forEach((e) => removeEventListener(e, bump));
    };
  }, [active, refresh]);
}
