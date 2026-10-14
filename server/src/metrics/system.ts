import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Cheap host metrics straight from /proc and /sys (no child processes).
 * One sample costs a handful of small file reads.
 */

export interface CpuTimes {
  busy: number;
  total: number;
}

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

const read = (p: string) => {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};
const readNum = (p: string) => {
  const s = read(p);
  const n = s === null ? NaN : Number(s.trim());
  return Number.isFinite(n) ? n : null;
};

export function readCpuTimes(statText = read('/proc/stat') ?? ''): CpuTimes[] {
  const out: CpuTimes[] = [];
  for (const line of statText.split('\n')) {
    if (!line.startsWith('cpu')) break;
    const f = line.trim().split(/\s+/).slice(1).map(Number);
    // user nice system idle iowait irq softirq steal
    const idle = f[3] + (f[4] ?? 0);
    const total = f.slice(0, 8).reduce((a, b) => a + b, 0);
    out.push({ busy: total - idle, total });
  }
  return out; // [aggregate, cpu0, cpu1, ...]
}

export function cpuPercent(prev: CpuTimes, cur: CpuTimes): number {
  const dt = cur.total - prev.total;
  return dt > 0 ? Math.min(100, Math.max(0, ((cur.busy - prev.busy) / dt) * 100)) : 0;
}

export function parseMeminfo(text: string) {
  const kv: Record<string, number> = {};
  for (const line of text.split('\n')) {
    const m = /^(\w+(?:\(\w+\))?):\s+(\d+)/.exec(line);
    if (m) kv[m[1]] = Number(m[2]) * 1024;
  }
  const total = kv.MemTotal ?? 0;
  const free = kv.MemFree ?? 0;
  const buffers = kv.Buffers ?? 0;
  const cache = (kv.Cached ?? 0) + (kv.SReclaimable ?? 0) - (kv.Shmem ?? 0);
  const available = kv.MemAvailable ?? free;
  return {
    total,
    used: Math.max(0, total - free - buffers - cache),
    free,
    available,
    cache: Math.max(0, cache),
    buffers,
    swapTotal: kv.SwapTotal ?? 0,
    swapUsed: (kv.SwapTotal ?? 0) - (kv.SwapFree ?? 0),
  };
}

/** Locate sysfs files once at startup. */
function discover() {
  let gpuDir: string | null = null;
  try {
    for (const c of fs.readdirSync('/sys/class/drm')) {
      if (!/^card\d+$/.test(c)) continue;
      const d = path.join('/sys/class/drm', c, 'device');
      if (fs.existsSync(path.join(d, 'gpu_busy_percent'))) {
        gpuDir = d;
        break;
      }
    }
  } catch {
    /* no drm */
  }
  const temps: { cpu?: string; gpu?: string; nvme?: string } = {};
  try {
    for (const h of fs.readdirSync('/sys/class/hwmon')) {
      const dir = path.join('/sys/class/hwmon', h);
      const name = read(path.join(dir, 'name'))?.trim();
      const input = path.join(dir, 'temp1_input');
      if (!fs.existsSync(input)) continue;
      if (name === 'k10temp' || name === 'coretemp') temps.cpu ??= input;
      else if (name === 'amdgpu') temps.gpu ??= input;
      else if (name === 'nvme') temps.nvme ??= input;
    }
  } catch {
    /* no hwmon */
  }
  return { gpuDir, temps };
}

const hw = discover();

function readNet() {
  let rx = 0;
  let tx = 0;
  for (const line of (read('/proc/net/dev') ?? '').split('\n').slice(2)) {
    const [iface, rest] = line.split(':');
    if (!rest) continue;
    const name = iface.trim();
    // Physical-ish interfaces only: skip loopback, docker bridges, veths and tailscale.
    if (name === 'lo' || /^(docker|br-|veth|tailscale|virbr)/.test(name)) continue;
    const f = rest.trim().split(/\s+/).map(Number);
    rx += f[0];
    tx += f[8];
  }
  return { rx, tx };
}

export class SystemSampler {
  private prevCpu: CpuTimes[] | null = null;
  private prevNet: { rx: number; tx: number; ts: number } | null = null;

  sample(): SystemSample {
    const ts = Date.now();
    const cpuNow = readCpuTimes();
    const prev = this.prevCpu ?? cpuNow;
    this.prevCpu = cpuNow;
    const cores = cpuNow.slice(1).map((c, i) => cpuPercent(prev[i + 1] ?? c, c));

    const netNow = readNet();
    let net = { rx: 0, tx: 0 };
    if (this.prevNet) {
      const dt = (ts - this.prevNet.ts) / 1000;
      if (dt > 0) net = { rx: Math.max(0, (netNow.rx - this.prevNet.rx) / dt), tx: Math.max(0, (netNow.tx - this.prevNet.tx) / dt) };
    }
    this.prevNet = { ...netNow, ts };

    const g = hw.gpuDir;
    const t = (p?: string) => (p ? (readNum(p) ?? NaN) / 1000 : NaN);
    const temp = (p?: string) => (Number.isFinite(t(p)) ? Math.round(t(p) * 10) / 10 : null);
    const load = (read('/proc/loadavg') ?? '0 0 0').split(' ').slice(0, 3).map(Number) as [number, number, number];

    return {
      ts,
      cpu: { total: cpuPercent(prev[0], cpuNow[0]), cores },
      mem: parseMeminfo(read('/proc/meminfo') ?? ''),
      gpu: {
        busy: g ? readNum(`${g}/gpu_busy_percent`) : null,
        vramUsed: g ? readNum(`${g}/mem_info_vram_used`) : null,
        vramTotal: g ? readNum(`${g}/mem_info_vram_total`) : null,
        gttUsed: g ? readNum(`${g}/mem_info_gtt_used`) : null,
        gttTotal: g ? readNum(`${g}/mem_info_gtt_total`) : null,
      },
      temps: { cpu: temp(hw.temps.cpu), gpu: temp(hw.temps.gpu), nvme: temp(hw.temps.nvme) },
      load,
      uptime: os.uptime(),
      net,
    };
  }
}

export function hostInfo() {
  const cpus = os.cpus();
  const ifaces = os.networkInterfaces();
  const addrs: { iface: string; address: string }[] = [];
  for (const [name, list] of Object.entries(ifaces)) {
    if (name === 'lo' || /^(docker|br-|veth)/.test(name)) continue;
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) addrs.push({ iface: name, address: a.address });
  }
  const osRelease = read('/etc/os-release') ?? '';
  // Short device id like the vendor app shows ("ID: A6CD"): last 4 chars of the machine id.
  const machineId = (read('/etc/machine-id') ?? '').trim();
  return {
    hostname: os.hostname(),
    deviceId: machineId ? machineId.slice(-4).toUpperCase() : null,
    os: /PRETTY_NAME="([^"]+)"/.exec(osRelease)?.[1] ?? os.type(),
    kernel: os.release(),
    cpuModel: cpus[0]?.model.trim() ?? '',
    cores: cpus.length,
    memTotal: os.totalmem(),
    addresses: addrs,
    gpu: hw.gpuDir !== null,
  };
}
