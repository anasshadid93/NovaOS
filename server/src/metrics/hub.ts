import { config } from '../config.js';
import { getDb } from '../db.js';
import { groupProcs, ProcessSampler, sortProcs, type ProcGroup, type ProcInfo, type SortKey } from './processes.js';
import { SystemSampler, type SystemSample } from './system.js';

/**
 * Central sampler.
 *  - System metrics: every 2 s, always (a few small reads). The last hour stays in memory.
 *  - Minute averages go to SQLite and are kept for 7 days.
 *  - The process table is sampled only while at least one client is watching it.
 */

export interface HistoryPoint {
  ts: number;
  cpu: number;
  mem: number; // used bytes
  cache: number;
  swap: number;
  gpu: number | null;
  gpuMem: number | null; // GTT + VRAM used
  tempCpu: number | null;
  tempGpu: number | null;
  load1: number;
}

const HOUR_POINTS = 3600_000 / config.tickMs;

export interface ProcSubscriber {
  wantsProcs: boolean;
  onSystem(s: SystemSample): void;
  onProcs(list: ProcInfo[], groups: () => ProcGroup[]): void;
}

export class MetricsHub {
  private system = new SystemSampler();
  private procs = new ProcessSampler();
  private hour: HistoryPoint[] = [];
  private minuteAcc: HistoryPoint[] = [];
  private subscribers = new Set<ProcSubscriber>();
  private timer: NodeJS.Timeout | null = null;
  private lastProcSample = 0;
  latest: SystemSample | null = null;
  containerNames = new Map<string, string>();

  start() {
    if (this.timer) return;
    this.system.sample(); // prime CPU deltas
    this.timer = setInterval(() => this.tick(), config.tickMs);
    this.timer.unref();
    this.prune();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  subscribe(s: ProcSubscriber) {
    this.subscribers.add(s);
    if (this.latest) s.onSystem(this.latest);
    return () => this.subscribers.delete(s);
  }

  /** Force a process sample now (e.g. right after a client subscribes). */
  primeProcs(s: ProcSubscriber) {
    const list = this.sampleProcs();
    s.onProcs(list, () => groupProcs(list, this.containerNames));
  }

  private sampleProcs(): ProcInfo[] {
    // Never sample the process table more often than once per tick.
    const now = Date.now();
    if (now - this.lastProcSample < config.tickMs / 2 && this.lastProcs) return this.lastProcs;
    this.lastProcSample = now;
    this.lastProcs = this.procs.sample();
    return this.lastProcs;
  }
  private lastProcs: ProcInfo[] | null = null;

  private tick() {
    const s = this.system.sample();
    this.latest = s;
    const point: HistoryPoint = {
      ts: s.ts,
      cpu: Math.round(s.cpu.total * 10) / 10,
      mem: s.mem.used,
      cache: s.mem.cache,
      swap: s.mem.swapUsed,
      gpu: s.gpu.busy,
      gpuMem: s.gpu.gttUsed === null && s.gpu.vramUsed === null ? null : (s.gpu.gttUsed ?? 0) + (s.gpu.vramUsed ?? 0),
      tempCpu: s.temps.cpu,
      tempGpu: s.temps.gpu,
      load1: s.load[0],
    };
    this.hour.push(point);
    if (this.hour.length > HOUR_POINTS) this.hour.splice(0, this.hour.length - HOUR_POINTS);
    this.accumulate(point);

    let procList: ProcInfo[] | null = null;
    let groups: ProcGroup[] | null = null;
    for (const sub of this.subscribers) {
      sub.onSystem(s);
      if (sub.wantsProcs) {
        procList ??= this.sampleProcs();
        const list = procList;
        sub.onProcs(list, () => (groups ??= groupProcs(list, this.containerNames)));
      }
    }
    if (!procList) this.lastProcs = null; // nobody watching: drop the table and its memory
  }

  private accumulate(p: HistoryPoint) {
    const minute = Math.floor(p.ts / 60_000);
    const first = this.minuteAcc[0];
    if (first && Math.floor(first.ts / 60_000) !== minute) {
      this.flushMinute(Math.floor(first.ts / 60_000) * 60_000);
      this.minuteAcc = [];
    }
    this.minuteAcc.push(p);
  }

  private flushMinute(ts: number) {
    const a = this.minuteAcc;
    if (a.length === 0) return;
    const avg = (f: (p: HistoryPoint) => number | null) => {
      const vals = a.map(f).filter((v): v is number => v !== null);
      return vals.length ? vals.reduce((x, y) => x + y, 0) / vals.length : null;
    };
    getDb()
      .prepare(
        `INSERT OR REPLACE INTO metrics_minute(ts, cpu, mem_used, mem_cache, swap_used, gpu, gpu_mem, temp_cpu, temp_gpu, load1)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ts,
        avg((p) => p.cpu),
        avg((p) => p.mem),
        avg((p) => p.cache),
        avg((p) => p.swap),
        avg((p) => p.gpu),
        avg((p) => p.gpuMem),
        avg((p) => p.tempCpu),
        avg((p) => p.tempGpu),
        avg((p) => p.load1),
      );
    if (Math.floor(ts / 60_000) % 60 === 0) this.prune();
  }

  private prune() {
    getDb()
      .prepare('DELETE FROM metrics_minute WHERE ts < ?')
      .run(Date.now() - config.historyRetentionDays * 86400_000);
  }

  history(range: '1h' | '24h' | '7d'): HistoryPoint[] {
    if (range === '1h') return this.hour;
    const since = Date.now() - (range === '24h' ? 86400_000 : 7 * 86400_000);
    const rows = getDb()
      .prepare(
        `SELECT ts, cpu, mem_used AS mem, mem_cache AS cache, swap_used AS swap, gpu, gpu_mem AS gpuMem,
                temp_cpu AS tempCpu, temp_gpu AS tempGpu, load1
         FROM metrics_minute WHERE ts >= ? ORDER BY ts`,
      )
      .all(since) as unknown as HistoryPoint[];
    if (range === '24h') return rows;
    // 7 days: average into 10-minute buckets (~1000 points).
    const out: HistoryPoint[] = [];
    for (let i = 0; i < rows.length; i += 10) {
      const chunk = rows.slice(i, i + 10);
      const avg = (k: keyof HistoryPoint) => {
        const v = chunk.map((r) => r[k]).filter((x): x is number => x !== null);
        return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
      };
      out.push({
        ts: chunk[0].ts,
        cpu: avg('cpu') ?? 0,
        mem: avg('mem') ?? 0,
        cache: avg('cache') ?? 0,
        swap: avg('swap') ?? 0,
        gpu: avg('gpu'),
        gpuMem: avg('gpuMem'),
        tempCpu: avg('tempCpu'),
        tempGpu: avg('tempGpu'),
        load1: avg('load1') ?? 0,
      });
    }
    return out;
  }
}

export const hub = new MetricsHub();

// ---- Process list diffing for WebSocket clients --------------------------

export type ProcRow = [pid: number, name: string, user: string, state: string, cpu: number, rss: number, threads: number, started: number, group: string];
export type GroupRow = [key: string, label: string, kind: string, count: number, cpu: number, rss: number];

export interface ProcView {
  sort: SortKey;
  q: string;
  mode: 'list' | 'group';
  limit: number;
}

/** Keeps what a client has seen and emits only changed rows. */
export class ProcDiffer {
  private seen = new Map<string | number, string>();
  private lastMode: ProcView['mode'] | null = null;

  diff(list: ProcInfo[], groups: () => ProcGroup[], view: ProcView) {
    const full = this.lastMode !== view.mode;
    if (full) this.seen.clear();
    this.lastMode = view.mode;
    const q = view.q.trim().toLowerCase();

    let rows: (ProcRow | GroupRow)[];
    let total: number;
    if (view.mode === 'group') {
      let gs = groups();
      if (q) gs = gs.filter((g) => g.label.toLowerCase().includes(q) || g.key.toLowerCase().includes(q));
      total = gs.length;
      const key = view.sort === 'rss' ? 'rss' : view.sort === 'name' ? 'label' : 'cpu';
      gs = [...gs].sort((a, b) => (key === 'label' ? a.label.localeCompare(b.label) : (b[key] as number) - (a[key] as number)));
      rows = gs.slice(0, view.limit).map((g) => [g.key, g.label, g.kind, g.count, g.cpu, g.rss]);
    } else {
      let ps = list;
      if (q) ps = ps.filter((p) => p.name.toLowerCase().includes(q) || String(p.pid) === q || p.user.toLowerCase() === q || p.group.toLowerCase().includes(q));
      total = ps.length;
      rows = sortProcs([...ps], view.sort)
        .slice(0, view.limit)
        .map((p) => [p.pid, p.name, p.user, p.state, p.cpu, p.rss, p.threads, p.started, p.group]);
    }

    const next = new Map<string | number, string>();
    const upsert: (ProcRow | GroupRow)[] = [];
    for (const r of rows) {
      const key = r[0];
      const sig = JSON.stringify(r);
      next.set(key, sig);
      if (this.seen.get(key) !== sig) upsert.push(r);
    }
    const remove = [...this.seen.keys()].filter((k) => !next.has(k));
    this.seen = next;
    return { full, mode: view.mode, total, order: rows.map((r) => r[0]), upsert, remove };
  }
}
