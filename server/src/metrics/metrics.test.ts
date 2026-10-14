import { describe, expect, it } from 'vitest';
import { ProcDiffer } from './hub.js';
import { parseSs } from './ports.js';
import { groupFromCgroup, groupProcs, labelFromCmdline, parseStat, ProcessSampler, type ProcInfo } from './processes.js';
import { cpuPercent, parseMeminfo, readCpuTimes, SystemSampler } from './system.js';

describe('parseStat', () => {
  it('handles names with spaces and parentheses', () => {
    const s = parseStat('1234 (Web Content (x)) S 1 1234 1234 0 -1 4194560 100 0 0 0 250 50 0 0 20 0 7 0 5000 1000000 2560 18446744073709551615');
    expect(s.name).toBe('Web Content (x)');
    expect(s.state).toBe('S');
    expect(s.ppid).toBe(1);
    expect(s.utime).toBe(250);
    expect(s.stime).toBe(50);
    expect(s.threads).toBe(7);
    expect(s.starttime).toBe(5000);
    expect(s.rss).toBe(2560 * 4096);
  });
});

describe('groupFromCgroup', () => {
  it.each([
    ['0::/system.slice/ollama.service', 'svc:ollama.service'],
    ['0::/user.slice/user-1000.slice/user@1000.service/app.slice/openclaw-gateway.service', 'user:openclaw-gateway.service'],
    ['0::/system.slice/docker-0123456789abcdef0123456789abcdef.scope', 'ctr:0123456789ab'],
    ['0::/user.slice/user-1000.slice/session-3.scope', 'session'],
    ['0::/', 'kernel'],
    ['0::/init.scope', 'svc:systemd'],
  ])('%s → %s', (input, expected) => {
    expect(groupFromCgroup(input)).toBe(expected);
  });
});

describe('labelFromCmdline', () => {
  it('names generic processes from their command line', () => {
    expect(labelFromCmdline('MainThread', ['node', '/x/server/dist/index.js'])).toBe('node index.js');
    expect(labelFromCmdline('python3', ['/usr/bin/python3', '-u', '-m', 'uvicorn', 'app:main'])).toBe('python3 uvicorn');
    expect(labelFromCmdline('ollama', ['/usr/bin/ollama', 'serve'])).toBeNull();
  });
});

describe('system parsing', () => {
  it('computes CPU % from /proc/stat deltas', () => {
    const a = readCpuTimes('cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 100 0 100 800 0 0 0 0 0 0\nintr 1');
    const b = readCpuTimes('cpu  150 0 150 900 0 0 0 0 0 0\ncpu0 150 0 150 900 0 0 0 0 0 0\nintr 1');
    expect(a).toHaveLength(2);
    expect(cpuPercent(a[0], b[0])).toBeCloseTo(50);
  });

  it('derives used memory like free(1)', () => {
    const m = parseMeminfo(
      ['MemTotal: 1000 kB', 'MemFree: 200 kB', 'MemAvailable: 600 kB', 'Buffers: 50 kB', 'Cached: 300 kB', 'SReclaimable: 50 kB', 'Shmem: 20 kB', 'SwapTotal: 100 kB', 'SwapFree: 40 kB'].join('\n'),
    );
    expect(m.cache).toBe(330 * 1024);
    expect(m.used).toBe((1000 - 200 - 50 - 330) * 1024);
    expect(m.swapUsed).toBe(60 * 1024);
    expect(m.available).toBe(600 * 1024);
  });

  it('samples the real host', () => {
    const s = new SystemSampler();
    s.sample();
    const x = s.sample();
    expect(x.cpu.cores.length).toBeGreaterThan(0);
    expect(x.mem.total).toBeGreaterThan(0);
  });
});

describe('ProcessSampler', () => {
  it('reads the real process table quickly', () => {
    const p = new ProcessSampler();
    p.sample();
    const t0 = performance.now();
    const list = p.sample();
    const ms = performance.now() - t0;
    expect(list.find((x) => x.pid === process.pid)?.user).toBeTruthy();
    // Budget: well under the 2 s tick so Manar stays ~1% CPU.
    expect(ms).toBeLessThan(150);
  });
});

const proc = (pid: number, cpu: number, rss = 1, group = 'svc:a.service', name = `p${pid}`): ProcInfo => ({
  pid,
  ppid: 1,
  name,
  user: 'anas',
  state: 'S',
  cpu,
  rss,
  threads: 1,
  started: 0,
  group,
});

describe('ProcDiffer', () => {
  it('sends everything first, then only changes', () => {
    const d = new ProcDiffer();
    const view = { sort: 'cpu' as const, q: '', mode: 'list' as const, limit: 2 };
    const list = [proc(1, 5), proc(2, 10), proc(3, 1)];
    const first = d.diff(list, () => groupProcs(list), view);
    expect(first.full).toBe(true);
    expect(first.order).toEqual([2, 1]);
    expect(first.upsert).toHaveLength(2);
    expect(first.total).toBe(3);

    const same = d.diff(list, () => groupProcs(list), view);
    expect(same.upsert).toHaveLength(0);
    expect(same.remove).toHaveLength(0);

    const list2 = [proc(1, 5), proc(2, 0), proc(3, 20)];
    const next = d.diff(list2, () => groupProcs(list2), view);
    expect(next.order).toEqual([3, 1]);
    expect(next.upsert.map((r) => r[0])).toEqual([3]);
    expect(next.remove).toEqual([2]);
  });

  it('filters by search and groups by unit', () => {
    const d = new ProcDiffer();
    const list = [proc(1, 5, 10, 'svc:ollama.service', 'ollama'), proc(2, 3, 20, 'svc:ollama.service', 'ollama'), proc(3, 1, 5, 'kernel', 'kworker')];
    const g = d.diff(list, () => groupProcs(list), { sort: 'cpu', q: '', mode: 'group', limit: 150 });
    expect(g.upsert[0]).toEqual(['svc:ollama.service', 'ollama', 'service', 2, 8, 30]);
    const s = new ProcDiffer().diff(list, () => groupProcs(list), { sort: 'cpu', q: 'kwork', mode: 'list', limit: 150 });
    expect(s.order).toEqual([3]);
  });
});

describe('parseSs', () => {
  it('extracts listening ports for a pid', () => {
    const text = [
      'tcp   LISTEN 0 4096 127.0.0.1:11434 0.0.0.0:* users:(("ollama",pid=900,fd=3))',
      'tcp   LISTEN 0 4096 [::]:22 [::]:* users:(("sshd",pid=1,fd=4),("sshd",pid=900,fd=4))',
      'udp   UNCONN 0 0 127.0.0.53%lo:53 0.0.0.0:* users:(("systemd-resolve",pid=500,fd=14))',
    ].join('\n');
    expect(parseSs(text, 900)).toEqual([
      { proto: 'tcp', address: '127.0.0.1', port: 11434 },
      { proto: 'tcp', address: '::', port: 22 },
    ]);
  });
});
