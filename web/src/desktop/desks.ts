import { useSyncExternalStore } from 'react';

/**
 * Virtual desktops: each window belongs to one; only the current desktop's windows show.
 * Names and the current one are kept per browser.
 */
interface DeskState {
  names: string[];
  current: number;
}
const KEY = 'manar.desktop.desks';
const listeners = new Set<() => void>();

let state: DeskState = (() => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as DeskState | null;
    if (v && Array.isArray(v.names) && v.names.length) return { names: v.names, current: Math.min(v.current ?? 0, v.names.length - 1) };
  } catch {
    /* default */
  }
  return { names: [''], current: 0 };
})();

const emit = (next: DeskState) => {
  state = next;
  localStorage.setItem(KEY, JSON.stringify(next));
  listeners.forEach((l) => l());
};

export const desks = {
  get: () => state,
  current: () => state.current,
  switchTo(i: number) {
    if (i >= 0 && i < state.names.length && i !== state.current) emit({ ...state, current: i });
  },
  step(d: number) {
    desks.switchTo(Math.max(0, Math.min(state.names.length - 1, state.current + d)));
  },
  add(): number {
    if (state.names.length >= 9) return state.current;
    emit({ names: [...state.names, ''], current: state.names.length });
    return state.current;
  },
  rename(i: number, name: string) {
    emit({ ...state, names: state.names.map((n, k) => (k === i ? name.trim().slice(0, 30) : n)) });
  },
  /** Removing a desktop moves its windows to the one before it (see wm.dropDesk). */
  remove(i: number) {
    if (state.names.length <= 1) return;
    const names = state.names.filter((_, k) => k !== i);
    emit({ names, current: Math.min(state.current > i ? state.current - 1 : state.current, names.length - 1) });
  },
};

export function useDesks(): DeskState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}
