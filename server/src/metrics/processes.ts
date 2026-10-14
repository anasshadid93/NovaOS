import fs from 'node:fs';
import os from 'node:os';

/**
 * htop-style process table read from /proc. Per tick we read only
 * /proc/<pid>/stat; uid, cgroup group and cmdline are cached per (pid, starttime).
 */

const CLK_TCK = 100; // getconf CLK_TCK on x86_64 Linux
const PAGE = 4096;

export interface ProcInfo {
  pid: number;
  ppid: number;
  name: string;
  user: string;
  state: string;
  /** % of one core (htop style; can exceed 100). */
  cpu: number;
  rss: number;
  threads: number;
  /** Process start, epoch ms. */
  started: number;
  /** Grouping key: `svc:<unit>`, `user:<unit>`, `ctr:<id>`, `session`, `kernel`, `other`. */
  group: string;
}

interface Cached {
  start: number;
  uid: number;
  group: string;
  kernel: boolean;
  /** Better label for generic thread names like "MainThread" or interpreters. */
  label: string | null;
}

const GENERIC = /^(MainThread|node|nodejs|python[0-9.]*|bash|sh|dash|java|ruby|perl|php|deno|bun|npm|npx|tsx)$/;

/** "node /x/server/dist/index.js" → "node index.js"; "python -m uvicorn app" → "python uvicorn". */
export function labelFromCmdline(comm: string, argv: string[]): string | null {
  if (!GENERIC.test(comm) || argv.length === 0) return null;
  const base = (p: string) => p.split('/').filter(Boolean).pop() ?? p;
  const prog = base(argv[0]);
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-m' && argv[i + 1]) return `${prog} ${argv[i + 1]}`;
    if (a.startsWith('-')) continue;
    return `${prog} ${base(a)}`.slice(0, 60);
  }
  return prog === comm ? null : prog;
}

export function parseStat(text: string) {
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  const name = text.slice(open + 1, close);
  const f = text.slice(close + 2).split(' ');
  // f[0] is field 3 (state) in proc(5) numbering.
  return {
    name,
    state: f[0],
    ppid: Number(f[1]),
    utime: Number(f[11]),
    stime: Number(f[12]),
    threads: Number(f[17]),
    starttime: Number(f[19]),
    rss: Number(f[21]) * PAGE,
  };
}

export function groupFromCgroup(text: string): string {
  const line = text.split('\n').find((l) => l.startsWith('0::')) ?? text.split('\n')[0] ?? '';
  const p = line.replace(/^\d*::?[^:]*:/, '').trim();
  if (p === '/' || p === '') return 'kernel';
  let m = /docker-([0-9a-f]{12,64})\.scope/.exec(p) ?? /\/docker\/([0-9a-f]{12,64})/.exec(p);
  if (m) return `ctr:${m[1].slice(0, 12)}`;
  m = /user@\d+\.service\/(?:.*\/)?([^/]+\.service)$/.exec(p);
  if (m) return `user:${m[1]}`;
  m = /\/system\.slice\/(?:.*\/)?([^/]+\.service)$/.exec(p);
  if (m) return `svc:${m[1]}`;
  if (/session-[^/]+\.scope/.test(p)) return 'session';
  if (p === '/init.scope') return 'svc:systemd';
  return 'other';
}

function loadUsers(): Map<number, string> {
  const map = new Map<number, string>();
  try {
    for (const line of fs.readFileSync('/etc/passwd', 'utf8').split('\n')) {
      const [name, , uid] = line.split(':');
      if (name && uid) map.set(Number(uid), name);
    }
  } catch {
    /* ignore */
  }
  return map;
}

function bootTimeMs(): number {
  const m = /^btime (\d+)/m.exec(fs.readFileSync('/proc/stat', 'utf8'));
  return m ? Number(m[1]) * 1000 : Date.now() - os.uptime() * 1000;
}

export class ProcessSampler {
  private cache = new Map<number, Cached>();
  private prevTicks = new Map<number, number>();
  private prevTs = 0;
  private users = loadUsers();
  private boot = bootTimeMs();

  sample(): ProcInfo[] {
    const now = Date.now();
    const dt = this.prevTs ? (now - this.prevTs) / 1000 : 0;
    this.prevTs = now;
    const out: ProcInfo[] = [];
    const ticks = new Map<number, number>();
    let entries: string[];
    try {
      entries = fs.readdirSync('/proc');
    } catch {
      return out;
    }
    for (const e of entries) {
      const c = e.charCodeAt(0);
      if (c < 48 || c > 57) continue;
      const pid = Number(e);
      let st: ReturnType<typeof parseStat>;
      try {
        st = parseStat(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
      } catch {
        continue; // exited
      }
      let meta = this.cache.get(pid);
      if (!meta || meta.start !== st.starttime) {
        meta = this.describe(pid, st.starttime, st.ppid, st.name) ?? undefined;
        if (!meta) continue;
        this.cache.set(pid, meta);
      }
      const t = st.utime + st.stime;
      ticks.set(pid, t);
      const prev = this.prevTicks.get(pid);
      const cpu = dt > 0 && prev !== undefined ? Math.max(0, ((t - prev) / CLK_TCK / dt) * 100) : 0;
      out.push({
        pid,
        ppid: st.ppid,
        name: meta.label ?? st.name,
        user: this.users.get(meta.uid) ?? String(meta.uid),
        state: st.state,
        cpu: Math.round(cpu * 10) / 10,
        rss: st.rss,
        threads: st.threads,
        started: this.boot + (st.starttime / CLK_TCK) * 1000,
        group: meta.group,
      });
    }
    this.prevTicks = ticks;
    for (const pid of this.cache.keys()) if (!ticks.has(pid)) this.cache.delete(pid);
    return out;
  }

  private describe(pid: number, start: number, ppid: number, comm: string): Cached | null {
    try {
      const uid = fs.statSync(`/proc/${pid}`).uid;
      let group = 'other';
      try {
        group = groupFromCgroup(fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8'));
      } catch {
        /* ignore */
      }
      // Kernel threads are children of kthreadd (pid 2).
      const kernel = pid === 2 || ppid === 2;
      if (kernel) group = 'kernel';
      let label: string | null = null;
      if (!kernel && GENERIC.test(comm)) {
        try {
          label = labelFromCmdline(comm, fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean));
        } catch {
          /* ignore */
        }
      }
      return { start, uid, group, kernel, label };
    } catch {
      return null;
    }
  }
}

export type SortKey = 'cpu' | 'rss' | 'pid' | 'name';

export function sortProcs(list: ProcInfo[], key: SortKey): ProcInfo[] {
  const cmp: Record<SortKey, (a: ProcInfo, b: ProcInfo) => number> = {
    cpu: (a, b) => b.cpu - a.cpu || b.rss - a.rss,
    rss: (a, b) => b.rss - a.rss || b.cpu - a.cpu,
    pid: (a, b) => a.pid - b.pid,
    name: (a, b) => a.name.localeCompare(b.name) || a.pid - b.pid,
  };
  return list.sort(cmp[key]);
}

export interface ProcGroup {
  key: string;
  label: string;
  kind: 'service' | 'user-service' | 'container' | 'session' | 'kernel' | 'other';
  count: number;
  cpu: number;
  rss: number;
  pids: number[];
}

export function groupProcs(list: ProcInfo[], containerNames: Map<string, string> = new Map()): ProcGroup[] {
  const groups = new Map<string, ProcGroup>();
  for (const p of list) {
    let g = groups.get(p.group);
    if (!g) {
      const [prefix, rest] = p.group.includes(':') ? (p.group.split(/:(.*)/s) as [string, string]) : [p.group, ''];
      const kind = ({ svc: 'service', user: 'user-service', ctr: 'container', session: 'session', kernel: 'kernel' } as const)[prefix] ?? 'other';
      const label = kind === 'container' ? (containerNames.get(rest) ?? rest) : rest.replace(/\.service$/, '') || prefix;
      g = { key: p.group, label, kind, count: 0, cpu: 0, rss: 0, pids: [] };
      groups.set(p.group, g);
    }
    g.count++;
    g.cpu += p.cpu;
    g.rss += p.rss;
    if (g.pids.length < 50) g.pids.push(p.pid);
  }
  for (const g of groups.values()) g.cpu = Math.round(g.cpu * 10) / 10;
  return [...groups.values()];
}

/** Details read only when the user opens a process. */
export function processDetails(pid: number) {
  const base = `/proc/${pid}`;
  const safe = (fn: () => string) => {
    try {
      return fn();
    } catch {
      return null;
    }
  };
  const cmdline = safe(() => fs.readFileSync(`${base}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' '));
  const status = safe(() => fs.readFileSync(`${base}/status`, 'utf8')) ?? '';
  const field = (k: string) => new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(status)?.[1]?.trim() ?? null;
  const cwd = safe(() => fs.readlinkSync(`${base}/cwd`));
  const exe = safe(() => fs.readlinkSync(`${base}/exe`));
  let threads: { tid: number; name: string; state: string }[] = [];
  try {
    threads = fs
      .readdirSync(`${base}/task`)
      .slice(0, 200)
      .map((tid) => {
        const st = parseStat(fs.readFileSync(`${base}/task/${tid}/stat`, 'utf8'));
        return { tid: Number(tid), name: st.name, state: st.state };
      });
  } catch {
    /* gone or no access */
  }
  return {
    pid,
    cmdline,
    exe,
    cwd,
    state: field('State'),
    ppid: Number(field('PPid') ?? 0),
    vmRss: field('VmRSS'),
    vmSwap: field('VmSwap'),
    threads,
    cgroup: safe(() => fs.readFileSync(`${base}/cgroup`, 'utf8').trim()),
  };
}
