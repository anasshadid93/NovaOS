import fs from 'node:fs';
import { HelperError, runHelper } from '../helper.js';

export interface PortInfo {
  proto: 'tcp' | 'udp';
  address: string;
  port: number;
}

function hexAddr(hex: string): string {
  if (hex.length === 8) return [3, 2, 1, 0].map((i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16)).join('.');
  // IPv6: 4 little-endian 32-bit words
  const words: string[] = [];
  for (let w = 0; w < 4; w++) {
    const chunk = hex.slice(w * 8, w * 8 + 8);
    const le = chunk.match(/../g)!.reverse().join('');
    words.push(le.slice(0, 4), le.slice(4));
  }
  const full = words.map((x) => x.replace(/^0+(?=.)/, '')).join(':');
  return full === '0:0:0:0:0:0:0:0' ? '::' : full === '0:0:0:0:0:0:0:1' ? '::1' : full;
}

/** Listening sockets keyed by inode. */
function listeningSockets(): Map<string, PortInfo> {
  const map = new Map<string, PortInfo>();
  for (const [file, proto] of [
    ['tcp', 'tcp'],
    ['tcp6', 'tcp'],
    ['udp', 'udp'],
    ['udp6', 'udp'],
  ] as const) {
    let text: string;
    try {
      text = fs.readFileSync(`/proc/net/${file}`, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length < 10) continue;
      // TCP: only LISTEN (0A). UDP: unconnected (07).
      if ((proto === 'tcp' && f[3] !== '0A') || (proto === 'udp' && f[3] !== '07')) continue;
      const [addr, port] = f[1].split(':');
      map.set(f[9], { proto, address: hexAddr(addr), port: parseInt(port, 16) });
    }
  }
  return map;
}

/**
 * Ports a process listens on. Works directly for our own processes; for other
 * users' processes /proc/<pid>/fd is unreadable, so we ask the root helper.
 */
export async function processPorts(pid: number): Promise<{ ports: PortInfo[]; restricted: boolean }> {
  let fds: string[];
  try {
    fds = fs.readdirSync(`/proc/${pid}/fd`);
  } catch {
    try {
      return { ports: dedupe(parseSs(await runHelper({ cmd: 'ports' }), pid)), restricted: false };
    } catch (err) {
      if (err instanceof HelperError) return { ports: [], restricted: true };
      throw err;
    }
  }
  const sockets = listeningSockets();
  const ports: PortInfo[] = [];
  for (const fd of fds) {
    try {
      const m = /^socket:\[(\d+)\]$/.exec(fs.readlinkSync(`/proc/${pid}/fd/${fd}`));
      const s = m && sockets.get(m[1]);
      if (s) ports.push(s);
    } catch {
      /* fd closed meanwhile */
    }
  }
  return { ports: dedupe(ports), restricted: false };
}

function dedupe(list: PortInfo[]) {
  const seen = new Set<string>();
  return list
    .filter((p) => {
      const k = `${p.proto}/${p.address}/${p.port}`;
      return seen.has(k) ? false : (seen.add(k), true);
    })
    .sort((a, b) => a.port - b.port);
}

/** Parses `ss -Htulpn` output, keeping sockets owned by `pid`. */
export function parseSs(text: string, pid: number): PortInfo[] {
  const out: PortInfo[] = [];
  for (const line of text.split('\n')) {
    if (!line.includes(`pid=${pid},`)) continue;
    const f = line.trim().split(/\s+/);
    const local = f[4] ?? '';
    const i = local.lastIndexOf(':');
    const port = Number(local.slice(i + 1));
    if (!Number.isFinite(port)) continue;
    out.push({ proto: f[0] === 'udp' ? 'udp' : 'tcp', address: local.slice(0, i).replace(/^\[|\]$/g, '').replace(/%.*$/, ''), port });
  }
  return out;
}
