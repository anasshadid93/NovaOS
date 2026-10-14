import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export interface Mount {
  device: string;
  mount: string;
  fstype: string;
  size: number;
  used: number;
  avail: number;
}

/** Real filesystems (one entry per device), from /proc/mounts + statfs. */
export function mounts(): Mount[] {
  const seen = new Set<string>();
  const out: Mount[] = [];
  for (const line of fs.readFileSync('/proc/mounts', 'utf8').split('\n')) {
    const [device, mount, fstype] = line.split(' ');
    if (!device?.startsWith('/dev/') || /^\/dev\/loop/.test(device) || seen.has(device)) continue;
    if (mount.startsWith('/boot') || mount.startsWith('/snap')) continue;
    seen.add(device);
    try {
      const s = fs.statfsSync(mount.replace(/\\040/g, ' '));
      const size = s.blocks * s.bsize;
      const avail = s.bavail * s.bsize;
      out.push({ device, mount, fstype, size, used: size - s.bfree * s.bsize, avail });
    } catch {
      /* unreadable mount */
    }
  }
  return out;
}

export interface Disk {
  name: string;
  path: string;
  model: string | null;
  serial: string | null;
  size: number;
  rotational: boolean;
  transport: string | null;
  partitions: { name: string; size: number; fstype: string | null; mountpoints: string[] }[];
}

export async function disks(): Promise<Disk[]> {
  const { stdout } = await execFileP('lsblk', ['-J', '-b', '-o', 'NAME,PATH,TYPE,SIZE,MODEL,SERIAL,ROTA,TRAN,FSTYPE,MOUNTPOINTS'], { timeout: 5000 });
  type Node = { name: string; path: string; type: string; size: number; model: string | null; serial: string | null; rota: boolean; tran: string | null; fstype: string | null; mountpoints: (string | null)[]; children?: Node[] };
  const nodes = (JSON.parse(stdout) as { blockdevices: Node[] }).blockdevices;
  return nodes
    .filter((n) => n.type === 'disk' && !/^(loop|zram|ram)/.test(n.name))
    .map((n) => ({
      name: n.name,
      path: n.path,
      model: n.model?.trim() ?? null,
      serial: n.serial ?? null,
      size: Number(n.size),
      rotational: !!n.rota,
      transport: n.tran,
      partitions: (n.children ?? []).map((c) => ({ name: c.name, size: Number(c.size), fstype: c.fstype, mountpoints: (c.mountpoints ?? []).filter((m): m is string => !!m) })),
    }));
}

export function interfaces() {
  const stats = new Map<string, { rx: number; tx: number }>();
  for (const line of fs.readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2)) {
    const [iface, rest] = line.split(':');
    if (!rest) continue;
    const f = rest.trim().split(/\s+/).map(Number);
    stats.set(iface.trim(), { rx: f[0], tx: f[8] });
  }
  const read = (p: string) => {
    try {
      return fs.readFileSync(p, 'utf8').trim();
    } catch {
      return null;
    }
  };
  return Object.entries(os.networkInterfaces())
    .filter(([name]) => name !== 'lo' && !/^(veth|br-|docker)/.test(name))
    .map(([name, addrs]) => ({
      name,
      mac: addrs?.find((a) => a.mac !== '00:00:00:00:00:00')?.mac ?? null,
      addresses: (addrs ?? []).map((a) => `${a.address}/${a.cidr?.split('/')[1] ?? ''}`),
      state: read(`/sys/class/net/${name}/operstate`),
      speed: Number(read(`/sys/class/net/${name}/speed`)) || null,
      rx: stats.get(name)?.rx ?? 0,
      tx: stats.get(name)?.tx ?? 0,
    }));
}

export async function tailscale() {
  try {
    const { stdout } = await execFileP('tailscale', ['status', '--json'], { timeout: 5000 });
    const s = JSON.parse(stdout) as {
      BackendState: string;
      Self: { HostName: string; DNSName: string; TailscaleIPs: string[]; Online: boolean };
      Peer?: Record<string, { HostName: string; DNSName: string; OS: string; Online: boolean; LastSeen: string; TailscaleIPs: string[]; Relay?: string; CurAddr?: string; RxBytes?: number; TxBytes?: number; Active?: boolean }>;
    };
    let serve: { port: string; target: string }[] = [];
    try {
      const sv = JSON.parse((await execFileP('tailscale', ['serve', 'status', '--json'], { timeout: 5000 })).stdout) as {
        Web?: Record<string, { Handlers: Record<string, { Proxy?: string }> }>;
      };
      serve = Object.entries(sv.Web ?? {}).map(([host, w]) => ({ port: host.split(':').pop() ?? '', target: Object.values(w.Handlers)[0]?.Proxy ?? '' }));
    } catch {
      /* not an operator */
    }
    return {
      state: s.BackendState,
      self: { name: s.Self.HostName, dns: s.Self.DNSName.replace(/\.$/, ''), ips: s.Self.TailscaleIPs },
      peers: Object.values(s.Peer ?? {})
        .map((p) => ({
          name: p.HostName,
          dns: p.DNSName.replace(/\.$/, ''),
          os: p.OS,
          online: p.Online,
          lastSeen: p.LastSeen,
          ip: p.TailscaleIPs[0],
          // A current address means a direct link; otherwise traffic goes through a relay (DERP).
          link: p.CurAddr ? 'direct' : p.Relay ? 'relay' : null,
          relay: p.Relay || null,
          rx: p.RxBytes ?? 0,
          tx: p.TxBytes ?? 0,
          active: !!p.Active,
        }))
        .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name)),
      serve,
    };
  } catch {
    return null;
  }
}

/** systemd's scheduled shutdown (if any), from `shutdown --show` equivalent via busctl. */
export async function scheduledShutdown(): Promise<{ action: string; at: number } | null> {
  try {
    const { stdout } = await execFileP('busctl', ['get-property', 'org.freedesktop.login1', '/org/freedesktop/login1', 'org.freedesktop.login1.Manager', 'ScheduledShutdown'], {
      timeout: 3000,
    });
    // (st) "poweroff" 1791580000000000
    const m = /"([^"]*)"\s+(\d+)/.exec(stdout);
    if (!m || !m[1] || m[2] === '0') return null;
    return { action: m[1], at: Math.floor(Number(m[2]) / 1000) };
  } catch {
    return null;
  }
}

export async function commandExists(cmd: string): Promise<boolean> {
  for (const dir of ['/usr/sbin', '/usr/bin', '/sbin', '/bin']) if (fs.existsSync(`${dir}/${cmd}`)) return true;
  return false;
}
