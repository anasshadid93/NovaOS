import fs from 'node:fs';
import os from 'node:os';
import dns from 'node:dns/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/sessions.js';
import { kvGet, kvSet } from '../db.js';
import { cred } from '../bot/apps.js';
import { postHook } from '../bot/hook.js';
import { internetSpeed } from '../system/speed.js';
import { tailscale } from '../system/info.js';

/**
 * The home network: who is connected (a ping sweep of the server's subnet every 15 minutes, then the ARP
 * table; names from the router's reverse DNS, AdGuard and the MAC vendor), a Telegram line when a
 * device never seen before joins, AdGuard's numbers (what it blocks), and the internet speed every
 * 6 hours so slow days show up.
 */

const execFileP = promisify(execFile);
const DEVICES = 'net_devices';
const SPEED = 'net_speed';

export interface Device {
  mac: string;
  ip: string;
  firstSeen: number;
  lastSeen: number;
  vendor: string | null;
  host: string | null;
  /** a name the owner gave it */
  name?: string;
  /** a phone/tablet using a private (randomised) Wi-Fi address */
  privateMac: boolean;
}

let oui: Map<string, string> | null = null;
function vendorOf(mac: string): string | null {
  if (!oui) {
    oui = new Map();
    try {
      for (const line of fs.readFileSync('/usr/share/ieee-data/oui.csv', 'utf8').split('\n')) {
        const m = /^MA-L,([0-9A-F]{6}),("?)(.*?)\2,/.exec(line);
        if (m) oui.set(m[1], m[3]);
      }
    } catch {
      // no vendor list
    }
  }
  return oui.get(mac.replace(/:/g, '').slice(0, 6).toUpperCase()) ?? null;
}
const isPrivate = (mac: string) => (parseInt(mac.slice(0, 2), 16) & 0x02) !== 0;

/** the server's LAN interface and subnet (/24 assumed, like home routers). */
function lan(): { iface: string; ip: string; prefix: string } | null {
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (/^(lo|docker|br-|veth|tailscale)/.test(name)) continue;
    const v4 = addrs?.find((a) => a.family === 'IPv4' && !a.internal);
    if (v4) return { iface: name, ip: v4.address, prefix: v4.address.split('.').slice(0, 3).join('.') };
  }
  return null;
}

export const devices = (): Record<string, Device> => {
  try {
    return JSON.parse(kvGet(DEVICES) ?? '{}') as Record<string, Device>;
  } catch {
    return {};
  }
};

async function adguardNames(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const a = cred('adguard-home');
    const r = await fetch(`${a.url}/control/clients`, { headers: { Authorization: `Basic ${Buffer.from(`${a.username}:${a.password}`).toString('base64')}` }, signal: AbortSignal.timeout(10_000) });
    const j = (await r.json()) as { clients?: { name: string; ids: string[] }[]; auto_clients?: { name: string; ip: string }[] };
    for (const c of j.clients ?? []) for (const id of c.ids) out.set(id.toLowerCase(), c.name);
    for (const c of j.auto_clients ?? []) if (c.name) out.set(c.ip, c.name);
  } catch {
    // AdGuard not reachable
  }
  return out;
}

let scanning = false;
/** Ping everything on the subnet, read the neighbour table, update the device list. */
export async function scan(): Promise<Record<string, Device>> {
  const l = lan();
  if (!l || scanning) return devices();
  scanning = true;
  try {
    const ips = Array.from({ length: 254 }, (_, i) => `${l.prefix}.${i + 1}`).filter((ip) => ip !== l.ip);
    for (let i = 0; i < ips.length; i += 64) await Promise.all(ips.slice(i, i + 64).map((ip) => execFileP('ping', ['-c', '1', '-W', '1', ip], { timeout: 3000 }).catch(() => null)));
    const { stdout } = await execFileP('ip', ['-j', 'neigh', 'show', 'dev', l.iface], { timeout: 5000 });
    const neigh = (JSON.parse(stdout) as { dst: string; lladdr?: string; state?: string[] }[]).filter((n) => n.lladdr && !(n.state ?? []).includes('FAILED') && n.dst.startsWith(`${l.prefix}.`));
    const known = devices();
    const first = Object.keys(known).length === 0;
    const ag = await adguardNames();
    const resolver = new dns.Resolver({ timeout: 1500, tries: 1 });
    resolver.setServers([`${l.prefix}.1`]);
    const now = Date.now();
    const fresh: Device[] = [];
    for (const n of neigh) {
      const mac = n.lladdr!.toLowerCase();
      const host = ag.get(mac) ?? ag.get(n.dst) ?? (await resolver.reverse(n.dst).then((h) => h[0]?.replace(/\.(lan|home|local)$/i, '') ?? null).catch(() => null));
      const d = known[mac];
      if (d) Object.assign(d, { ip: n.dst, lastSeen: now, host: host ?? d.host });
      else {
        known[mac] = { mac, ip: n.dst, firstSeen: now, lastSeen: now, vendor: vendorOf(mac), host, privateMac: isPrivate(mac) };
        fresh.push(known[mac]);
      }
    }
    kvSet(DEVICES, JSON.stringify(known));
    // The first scan only learns what's there; after that, a device never seen before is worth a line.
    if (!first)
      for (const d of fresh)
        void postHook({ type: 'notice', text: `📶 جهاز جديد دخل شبكة البيت: <b>${(d.host ?? d.vendor ?? (d.privateMac ? 'تلفون/تابلت (عنوان خاص)' : 'غير معروف')).replace(/[<>&]/g, '')}</b> · ${d.ip}\nإذا مش إلك، بتشوفه بـ MinisManager ← الشبكة.` });
    return known;
  } finally {
    scanning = false;
  }
}

export interface SpeedPoint {
  at: number;
  ping: number;
  downMbps: number;
  upMbps: number;
}
export const speeds = (): SpeedPoint[] => {
  try {
    return JSON.parse(kvGet(SPEED) ?? '[]') as SpeedPoint[];
  } catch {
    return [];
  }
};
export async function measureSpeed(): Promise<SpeedPoint> {
  const r = await internetSpeed();
  kvSet(SPEED, JSON.stringify([...speeds(), r].slice(-120)));
  return r;
}

async function adguardStats() {
  try {
    const a = cred('adguard-home');
    const r = await fetch(`${a.url}/control/stats`, { headers: { Authorization: `Basic ${Buffer.from(`${a.username}:${a.password}`).toString('base64')}` }, signal: AbortSignal.timeout(10_000) });
    const j = (await r.json()) as { num_dns_queries: number; num_blocked_filtering: number; top_blocked_domains: Record<string, number>[]; top_clients: Record<string, number>[] };
    const pairs = (l: Record<string, number>[]) => l.slice(0, 8).map((o) => ({ name: Object.keys(o)[0], n: Object.values(o)[0] }));
    return { queries: j.num_dns_queries, blocked: j.num_blocked_filtering, topBlocked: pairs(j.top_blocked_domains ?? []), topClients: pairs(j.top_clients ?? []) };
  } catch {
    return null;
  }
}

export function startNetworkLoop(): () => void {
  if (process.env.VITEST) return () => {};
  const t1 = setInterval(() => void scan().catch(() => null), 15 * 60_000);
  const t2 = setInterval(() => {
    const last = speeds().at(-1)?.at ?? 0;
    if (Date.now() - last > 6 * 3600_000) void measureSpeed().catch(() => null);
  }, 10 * 60_000);
  setTimeout(() => void scan().catch(() => null), 2 * 60_000);
  return () => {
    clearInterval(t1);
    clearInterval(t2);
  };
}

export async function networkRoutes(app: FastifyInstance) {
  app.get('/api/network', { preHandler: requireAuth }, async () => {
    const [ag, ts] = await Promise.all([adguardStats(), tailscale()]);
    const list = Object.values(devices()).sort((a, b) => b.lastSeen - a.lastSeen);
    const byIp = new Map(list.map((d) => [d.ip, d.name ?? d.host ?? d.vendor]));
    const tsByIp = new Map((ts?.peers ?? []).map((p) => [p.ip, p.name]));
    if (ag) ag.topClients = ag.topClients.map((c) => ({ ...c, name: byIp.get(c.name) ?? tsByIp.get(c.name) ?? c.name }));
    return { devices: list, adguard: ag, speeds: speeds(), tailscale: ts?.peers ?? [], lan: lan(), scanning };
  });
  app.post('/api/network/scan', { preHandler: requireAuth }, async () => ({ devices: Object.values(await scan()) }));
  app.post('/api/network/speed', { preHandler: requireAuth }, async (_req, reply) => measureSpeed().catch(() => reply.code(502).send({ error: 'unreachable' })));
  app.post<{ Body: { mac?: string; name?: string } }>('/api/network/name', { preHandler: requireAuth }, async (req, reply) => {
    const all = devices();
    const d = all[String(req.body?.mac ?? '').toLowerCase()];
    if (!d) return reply.code(404).send({ error: 'not_found' });
    d.name = String(req.body?.name ?? '').trim().slice(0, 40) || undefined;
    kvSet(DEVICES, JSON.stringify(all));
    return d;
  });
}
