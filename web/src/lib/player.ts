import { useSyncExternalStore } from 'react';
import { fileUrl } from './fm';

/**
 * The music player: one <audio> for the whole app, so playback continues across screens and
 * windows. Queue, shuffle and repeat; lock-screen / headset controls through MediaSession;
 * the queue and position survive a reload.
 */
export interface Track {
  path: string;
  title: string;
  artist: string | null;
  album: string | null;
  duration: number | null;
  mtime?: number;
}
export type Repeat = 'off' | 'all' | 'one';

interface State {
  queue: Track[];
  index: number;
  playing: boolean;
  position: number;
  duration: number;
  shuffle: boolean;
  repeat: Repeat;
}

const KEY = 'manar.player';
const listeners = new Set<() => void>();
let state: State = (() => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<State> | null;
    if (v?.queue?.length) return { queue: v.queue, index: v.index ?? 0, playing: false, position: v.position ?? 0, duration: 0, shuffle: !!v.shuffle, repeat: v.repeat ?? 'off' };
  } catch {
    /* fresh */
  }
  return { queue: [], index: 0, playing: false, position: 0, duration: 0, shuffle: false, repeat: 'off' };
})();

let saveAt = 0;
const emit = (patch: Partial<State>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
  if (Date.now() - saveAt > 2000 || !('position' in patch)) {
    saveAt = Date.now();
    const { queue, index, position, shuffle, repeat } = state;
    localStorage.setItem(KEY, JSON.stringify({ queue, index, position, shuffle, repeat }));
  }
};

export const coverUrl = (p: string) => `/api/music/cover?path=${encodeURIComponent(p)}`;

let audio: HTMLAudioElement | null = null;
function el(): HTMLAudioElement {
  if (audio) return audio;
  audio = new Audio();
  audio.preload = 'metadata';
  audio.addEventListener('timeupdate', () => emit({ position: audio!.currentTime, duration: audio!.duration || state.queue[state.index]?.duration || 0 }));
  audio.addEventListener('play', () => emit({ playing: true }));
  audio.addEventListener('pause', () => emit({ playing: false }));
  audio.addEventListener('ended', () => {
    if (state.repeat === 'one') {
      audio!.currentTime = 0;
      void audio!.play();
    } else player.next(true);
  });
  return audio;
}

function load(i: number, autoplay: boolean, at = 0) {
  const t = state.queue[i];
  if (!t) return;
  const a = el();
  a.src = fileUrl(t.path);
  a.currentTime = at;
  emit({ index: i, position: at });
  if (autoplay) void a.play().catch(() => emit({ playing: false }));
  // Lock screen, notification shade, Bluetooth headset buttons.
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist ?? '', album: t.album ?? '', artwork: [{ src: coverUrl(t.path), sizes: '400x400', type: 'image/jpeg' }] });
    navigator.mediaSession.setActionHandler('play', () => player.toggle());
    navigator.mediaSession.setActionHandler('pause', () => player.toggle());
    navigator.mediaSession.setActionHandler('previoustrack', () => player.prev());
    navigator.mediaSession.setActionHandler('nexttrack', () => player.next());
    navigator.mediaSession.setActionHandler('seekto', (d) => d.seekTime !== undefined && player.seek(d.seekTime));
  }
}

export const player = {
  /** Play `tracks` starting at `index` (replaces the queue). */
  play(tracks: Track[], index = 0) {
    if (!tracks.length) return;
    emit({ queue: tracks.slice(0, 2000) });
    load(Math.min(index, tracks.length - 1), true);
  },
  /** Add to the end of the queue (starts playing if the queue was empty). */
  enqueue(tracks: Track[]) {
    const wasEmpty = !state.queue.length;
    emit({ queue: [...state.queue, ...tracks].slice(0, 2000) });
    if (wasEmpty) load(0, true);
  },
  toggle() {
    const a = el();
    if (!a.src && state.queue.length) return load(state.index, true, state.position);
    if (a.paused) void a.play();
    else a.pause();
  },
  next(auto = false) {
    const n = state.queue.length;
    if (!n) return;
    let i = state.shuffle ? Math.floor(Math.random() * n) : state.index + 1;
    if (i >= n) {
      if (auto && state.repeat === 'off') return emit({ playing: false });
      i = 0;
    }
    load(i, true);
  },
  prev() {
    const a = el();
    // Like most players: back to the start if we're a few seconds in.
    if (a.currentTime > 4 || state.index === 0) a.currentTime = 0;
    else load(state.index - 1, true);
  },
  jump(i: number) {
    load(i, true);
  },
  seek(sec: number) {
    el().currentTime = sec;
  },
  setShuffle: (on: boolean) => emit({ shuffle: on }),
  cycleRepeat: () => emit({ repeat: state.repeat === 'off' ? 'all' : state.repeat === 'all' ? 'one' : 'off' }),
  removeAt(i: number) {
    const queue = state.queue.filter((_, k) => k !== i);
    emit({ queue, index: i < state.index ? state.index - 1 : Math.min(state.index, queue.length - 1) });
  },
  current: (): Track | undefined => state.queue[state.index],
  clear() {
    el().pause();
    el().removeAttribute('src');
    emit({ queue: [], index: 0, playing: false, position: 0 });
  },
};

export function usePlayer() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

/** Audio file names → tracks, before the library's tags are known. */
export const trackFromPath = (p: string): Track => ({ path: p, title: p.split('/').pop()!.replace(/\.[^.]+$/, ''), artist: null, album: p.split('/').slice(-2, -1)[0] ?? null, duration: null });
