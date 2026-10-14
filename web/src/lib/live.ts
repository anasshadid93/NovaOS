import { useEffect, useSyncExternalStore } from 'react';

/**
 * Single shared WebSocket to /api/ws. It is open only while a screen that needs
 * live data is mounted AND the page is visible; otherwise it is closed so the
 * phone (and the server) do no work.
 */

export interface SystemSample {
  ts: number;
  cpu: { total: number; cores: number[] };
  mem: { total: number; used: number; free: number; available: number; cache: number; buffers: number; swapTotal: number; swapUsed: number };
  gpu: { busy: number | null; vramUsed: number | null; vramTotal: number | null; gttUsed: number | null; gttTotal: number | null };
  temps: { cpu: number | null; gpu: number | null; nvme: number | null };
  load: [number, number, number];
  uptime: number;
  net: { rx: number; tx: number };
}

export type ProcRow = [pid: number, name: string, user: string, state: string, cpu: number, rss: number, threads: number, started: number, group: string];
export type GroupRow = [key: string, label: string, kind: string, count: number, cpu: number, rss: number];

export interface ProcView {
  sort: 'cpu' | 'rss' | 'pid' | 'name';
  q: string;
  mode: 'list' | 'group';
}

interface ProcDiff {
  full: boolean;
  mode: 'list' | 'group';
  total: number;
  order: (number | string)[];
  upsert: (ProcRow | GroupRow)[];
  remove: (number | string)[];
}

type Listener = () => void;

class LiveStore {
  system: SystemSample | null = null;
  rows: (ProcRow | GroupRow)[] = [];
  procMode: 'list' | 'group' = 'list';
  procTotal = 0;
  status: 'idle' | 'connecting' | 'open' | 'closed' = 'idle';

  private ws: WebSocket | null = null;
  private users = 0;
  private views = new Set<{ view: ProcView }>();
  private byKey = new Map<number | string, ProcRow | GroupRow>();
  private listeners = new Set<Listener>();
  private sysListeners = new Set<(s: SystemSample) => void>();
  private retry = 0;
  private retryTimer: number | null = null;

  constructor() {
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => this.reconcile());
  }

  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  private emit() {
    this.listeners.forEach((l) => l());
  }

  onSample(fn: (s: SystemSample) => void) {
    this.sysListeners.add(fn);
    return () => this.sysListeners.delete(fn);
  }

  acquire() {
    this.users++;
    this.reconcile();
    return () => {
      this.users--;
      this.reconcile();
    };
  }

  setView(handle: { view: ProcView } | null, remove?: { view: ProcView }) {
    if (remove) this.views.delete(remove);
    if (handle) this.views.add(handle);
    this.sendView();
  }

  private currentView(): ProcView | null {
    let v: ProcView | null = null;
    for (const h of this.views) v = h.view;
    return v;
  }

  private sendView() {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const v = this.currentView();
    this.ws.send(JSON.stringify({ t: 'view', procs: v ? { ...v, limit: 150 } : null }));
  }

  private reconcile() {
    const want = this.users > 0 && document.visibilityState === 'visible';
    if (want && !this.ws) this.connect();
    if (!want && this.ws) {
      this.ws.close(1000);
      this.ws = null;
      this.status = 'idle';
      this.emit();
    }
  }

  private connect() {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/api/ws`);
    this.ws = ws;
    this.status = 'connecting';
    this.emit();
    ws.onopen = () => {
      this.retry = 0;
      this.status = 'open';
      this.byKey.clear();
      this.sendView();
      this.emit();
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data as string) as { t: string; d: unknown };
      if (msg.t === 'sys') {
        this.system = msg.d as SystemSample;
        this.sysListeners.forEach((f) => f(this.system!));
        this.emit();
      } else if (msg.t === 'procs') this.applyDiff(msg.d as ProcDiff);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.status = 'closed';
      this.emit();
      if (ev.code === 4401) {
        location.reload();
        return;
      }
      const delay = Math.min(15000, 1000 * 2 ** this.retry++);
      this.retryTimer = window.setTimeout(() => this.reconcile(), delay);
    };
  }

  private applyDiff(d: ProcDiff) {
    if (d.full || d.mode !== this.procMode) this.byKey.clear();
    this.procMode = d.mode;
    for (const k of d.remove) this.byKey.delete(k);
    for (const r of d.upsert) this.byKey.set(r[0], r);
    this.rows = d.order.map((k) => this.byKey.get(k)).filter((r): r is ProcRow | GroupRow => !!r);
    this.procTotal = d.total;
    this.emit();
  }
}

export const live = new LiveStore();

/** Latest system sample; keeps the socket open while mounted. */
export function useSystem(): SystemSample | null {
  useEffect(() => live.acquire(), []);
  return useSyncExternalStore(live.subscribe, () => live.system);
}

export function useLiveStatus() {
  return useSyncExternalStore(live.subscribe, () => live.status);
}

/** Live process rows for the given view. */
export function useProcesses(view: ProcView) {
  useEffect(() => live.acquire(), []);
  useEffect(() => {
    const h = { view };
    live.setView(h);
    return () => live.setView(null, h);
  }, [view.sort, view.q, view.mode]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = useSyncExternalStore(live.subscribe, () => live.rows);
  const total = useSyncExternalStore(live.subscribe, () => live.procTotal);
  const mode = useSyncExternalStore(live.subscribe, () => live.procMode);
  return { rows, total, mode };
}
