import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/sessions.js';
import { config } from '../config.js';

/**
 * Games on the TV: Sunshine streams ES-DE (always running on a virtual 1080p screen in the
 * manar-games-esde container) to Moonlight. Wolf was replaced on 2026-10-14 (black screens, slow starts).
 * This page pairs a TV (the 4-digit code Moonlight shows goes to Sunshine's /api/pin), lists the
 * games per console from the Toshiba, says which BIOS/firmware files are still missing, fetches the
 * PS3 firmware from Sony, checks a PS3 game against RPCS3's compatibility list, and tells the rest of
 * NovaOS when someone is playing so GPU-heavy background work waits.
 */

const execFileP = promisify(execFile);
const CONTAINER = config.games.streamerContainer;
const ESDE = config.games.esdeContainer;
export const GAMES = () => path.join(config.mediaRoot, 'Games');

export const SYSTEMS: { id: string; name: string; exts: RegExp }[] = [
  { id: 'arcade', name: 'Arcade', exts: /\.(zip|7z)$/i },
  { id: 'mame', name: 'MAME', exts: /\.(zip|7z|chd)$/i },
  { id: 'fbneo', name: 'FinalBurn Neo', exts: /\.(zip|7z)$/i },
  { id: 'psx', name: 'PlayStation', exts: /\.(cue|bin|chd|pbp|iso|m3u|img)$/i },
  { id: 'ps2', name: 'PlayStation 2', exts: /\.(iso|chd|cso|bin|gz)$/i },
  { id: 'ps3', name: 'PlayStation 3', exts: /\.(iso|pkg)$|\/PS3_GAME$/i },
  // A dumped PS4 game is a folder ("<Game>.ps4/" or "CUSA…/") with eboot.bin inside.
  { id: 'ps4', name: 'PlayStation 4', exts: /(^|\/)eboot\.bin$/i },
  { id: 'psp', name: 'PSP', exts: /\.(iso|cso|pbp|chd)$/i },
  { id: 'nes', name: 'NES', exts: /\.(nes|zip|7z)$/i },
  { id: 'snes', name: 'Super Nintendo', exts: /\.(sfc|smc|zip|7z)$/i },
  { id: 'n64', name: 'Nintendo 64', exts: /\.(n64|z64|v64|zip|7z)$/i },
  { id: 'gb', name: 'Game Boy', exts: /\.(gb|zip|7z)$/i },
  { id: 'gbc', name: 'Game Boy Color', exts: /\.(gbc|zip|7z)$/i },
  { id: 'gba', name: 'Game Boy Advance', exts: /\.(gba|zip|7z)$/i },
  { id: 'nds', name: 'Nintendo DS', exts: /\.(nds|zip|7z)$/i },
  { id: 'megadrive', name: 'Sega Mega Drive', exts: /\.(md|gen|bin|smd|zip|7z)$/i },
  { id: 'mastersystem', name: 'Sega Master System', exts: /\.(sms|zip|7z)$/i },
  { id: 'gamegear', name: 'Sega Game Gear', exts: /\.(gg|zip|7z)$/i },
  { id: 'pcengine', name: 'PC Engine / TurboGrafx', exts: /\.(pce|zip|7z|chd|cue)$/i },
  { id: 'dreamcast', name: 'Dreamcast', exts: /\.(gdi|cdi|chd)$/i },
  { id: 'gamecube', name: 'GameCube', exts: /\.(iso|gcz|rvz|ciso)$/i },
  { id: 'wii', name: 'Wii', exts: /\.(iso|wbfs|rvz)$/i },
  { id: 'xbox', name: 'Xbox', exts: /\.(iso|xiso)$/i },
];

/** BIOS files the emulators look for (any one of each group is enough). */
const BIOS: { system: string; label: string; any: RegExp }[] = [
  { system: 'psx', label: 'PS1 BIOS (scph5501.bin / scph1001.bin …)', any: /^scph-?\d{4}(?!\d).*\.bin$|^ps-?\d+.*\.bin$|psxonpsp660\.bin$/i },
  { system: 'ps2', label: 'PS2 BIOS (SCPH-xxxxx.bin)', any: /^scph-?\d{5}.*\.(bin|rom0)$|ps2.*\.bin$/i },
  { system: 'ps3', label: 'PS3 firmware (PS3UPDAT.PUP)', any: /^PS3UPDAT\.PUP$/i },
  { system: 'dreamcast', label: 'Dreamcast BIOS (dc_boot.bin)', any: /^dc_boot\.bin$/i },
  { system: 'ps4', label: 'PS4 system modules (sys_modules for shadPS4)', any: /^libSceNgs2\.sprx$/i },
];

function walk(dir: string, depth = 0, out: { name: string; size: number }[] = []): { name: string; size: number }[] {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      // A PS3 game kept as a folder (disc copy): …/<Game>/PS3_GAME is the game.
      if (e.name === 'PS3_GAME') out.push({ name: path.relative(GAMES(), p), size: 0 });
      else if (depth < 3) walk(p, depth + 1, out);
    } else out.push({ name: path.relative(GAMES(), p), size: fs.statSync(p).size });
  }
  return out;
}

/** Games per console: files with that console's extensions (a .cue's .bin tracks don't count twice). */
export interface RomEntry {
  system: string;
  systemName: string;
  name: string;
  rom: string;
}
let roms: RomEntry[] = [];
/** Every game with its file (or PS3/PS4 folder), from the last library scan. */
export function romIndex(): RomEntry[] {
  library();
  return roms;
}

let libraryCache: { sig: string; at: number; value: ReturnType<typeof scanLibrary> } | null = null;
/** The scan is ~1 s on the Toshiba; reused while the ROM folders haven't changed (checked at most every 20 s). */
export function library() {
  const now = Date.now();
  if (libraryCache && now - libraryCache.at < 20_000) return libraryCache.value;
  const sig = romSignature(path.join(GAMES(), 'ROMs'));
  if (libraryCache && libraryCache.sig === sig) {
    libraryCache.at = now;
    return libraryCache.value;
  }
  const value = scanLibrary();
  libraryCache = { sig, at: now, value };
  return value;
}

function scanLibrary() {
  const all: RomEntry[] = [];
  const out = SYSTEMS.map((s) => {
    const dir = path.join(GAMES(), 'ROMs', s.id);
    const files = walk(dir).filter((f) => s.exts.test(f.name) || s.exts.test(`/${path.basename(f.name)}`));
    const hasCue = files.some((f) => /\.cue$/i.test(f.name));
    // A multi-disc game is a "<Game>.m3u" folder (ES-DE shows it as one game): count its .m3u only.
    const games = files.filter((f) => !(hasCue && /\.bin$/i.test(f.name) && s.id === 'psx') && !(/\.m3u\//i.test(f.name) && !/\.m3u$/i.test(f.name)));
    const title = (g: string) => (/\/PS3_GAME$|(^|\/)eboot\.bin$/i.test(g) ? path.basename(path.dirname(g)).replace(/\.ps4$/i, '') : path.basename(g).replace(/\.[^.]+$/, ''));
    // What gets launched: the game folder for PS3 disc copies, the eboot.bin for PS4, else the file.
    const launchable = (g: string) => path.resolve(GAMES(), /\/PS3_GAME$/i.test(g) ? path.dirname(g) : g);
    for (const g of games) all.push({ system: s.id, systemName: s.name, name: title(g.name), rom: launchable(g.name) });
    return { id: s.id, name: s.name, count: games.length, bytes: files.reduce((a, f) => a + f.size, 0), games: games.slice(0, 300).map((g) => ({ name: title(g.name), rom: launchable(g.name) })) };
  });
  roms = all;
  return out;
}

export function biosStatus() {
  let names: string[] = [];
  try {
    names = fs.readdirSync(path.join(GAMES(), 'bios'), { recursive: true }).map((n) => path.basename(String(n)));
  } catch {
    // no bios folder yet
  }
  return BIOS.map((b) => ({ system: b.system, label: b.label, present: names.some((n) => b.any.test(n)) }));
}

/** Sunshine's local admin API (self-signed certificate, basic auth from apps-credentials.json). */
function sunshine<T>(method: string, p: string, body?: unknown): Promise<T> {
  const c = (JSON.parse(fs.readFileSync(config.credsFile, 'utf8')) as Record<string, { username: string; password: string }>).sunshine;
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = https.request(
      { host: '127.0.0.1', port: 47990, path: p, method, rejectUnauthorized: false, auth: `${c.username}:${c.password}`, timeout: 15_000, headers: data ? { 'content-type': 'application/json' } : {} },
      (res) => {
        let out = '';
        res.on('data', (d) => (out += d));
        res.on('end', () => {
          try {
            resolve(JSON.parse(out) as T);
          } catch {
            reject(new Error(`sunshine ${res.statusCode}`));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('sunshine timeout')));
    req.on('error', reject);
    req.end(data);
  });
}

/** Paired TVs/phones. */
export async function pairedClients(): Promise<number> {
  try {
    return (await sunshine<{ named_certs?: unknown[] }>('GET', '/api/clients/list')).named_certs?.length ?? 0;
  } catch {
    return 0;
  }
}

async function streamerRunning(): Promise<boolean> {
  try {
    const { stdout } = await execFileP('docker', ['inspect', '-f', '{{.State.Running}}', CONTAINER, ESDE], { timeout: 10_000 });
    return stdout.trim().split('\n').every((l) => l === 'true');
  } catch {
    return false;
  }
}

const EMULATORS: [RegExp, string][] = [
  [/pcsx2/i, 'PCSX2'],
  [/rpcs3/i, 'RPCS3'],
  [/shadps4/i, 'shadPS4'],
  [/dolphin/i, 'Dolphin'],
  [/cemu/i, 'Cemu'],
  [/xemu/i, 'xemu'],
  [/retroarch/i, 'RetroArch'],
];
/** A game is running when an emulator process is up inside the ES-DE container. */
export async function playing(): Promise<string | null> {
  try {
    const { stdout } = await execFileP('docker', ['top', ESDE, '-eo', 'pid,args'], { timeout: 10_000 });
    for (const [re, name] of EMULATORS) if (re.test(stdout)) return name;
    return null;
  } catch {
    return null;
  }
}
/** A frozen game: kill the emulator; ES-DE (left running) comes back on the TV. */
export async function stopGame(): Promise<boolean> {
  const re = 'rpcs3|AppRun\\.wrapped|pcsx2|retroarch|shadps4|Shadps4|dolphin|cemu|xemu|xenia';
  try {
    await execFileP('docker', ['exec', ESDE, 'pkill', '-9', '-f', re], { timeout: 15_000 });
  } catch {
    /* pkill exits 1 when nothing matched */
  }
  playingCache = { at: 0, value: null };
  return !(await playing());
}

let playingCache = { at: 0, value: null as string | null };
/** For background jobs: is someone playing right now? (cached 30 s) */
export async function gamingNow(): Promise<boolean> {
  if (Date.now() - playingCache.at > 30_000) playingCache = { at: Date.now(), value: await playing() };
  return !!playingCache.value;
}

/** Devices waiting for their PIN (Moonlight shows the PIN on the TV). */
export async function pendingPair(): Promise<{ id: string; name: string } | null> {
  try {
    const r = await sunshine<{ pairings?: { id: string; name: string }[] }>('GET', '/api/pin');
    const last = r.pairings?.at(-1);
    return last ? { id: last.id, name: last.name } : null;
  } catch {
    return null;
  }
}
export async function pair(pin: string): Promise<{ ok: boolean; error?: string }> {
  if (!/^\d{4}$/.test(pin)) return { ok: false, error: 'pin_format' };
  const p = await pendingPair();
  if (!p) return { ok: false, error: 'no_request' };
  const r = await sunshine<{ status?: boolean }>('POST', '/api/pin', { pin, name: p.name || 'TV', pairing_id: p.id }).catch(() => null);
  return r?.status ? { ok: true } : { ok: false, error: 'wolf_refused' };
}

/** Sony's current PS3 system software into Games/bios (free, needed by RPCS3). */
let fwJob: Promise<string> | null = null;
export function fetchPs3Firmware(): Promise<string> {
  fwJob ??= (async () => {
    const list = await (await fetch('http://fus01.ps3.update.playstation.net/update/ps3/list/us/ps3-updatelist.txt', { signal: AbortSignal.timeout(20_000) })).text();
    const url = /CDN=(http\S+PS3UPDAT\.PUP)/.exec(list)?.[1];
    if (!url) throw new Error('firmware_url_not_found');
    const dest = path.join(GAMES(), 'bios', 'PS3UPDAT.PUP');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const r = await fetch(url, { signal: AbortSignal.timeout(30 * 60_000) });
    if (!r.ok || !r.body) throw new Error(`firmware_http_${r.status}`);
    fs.writeFileSync(`${dest}.part`, Buffer.from(await r.arrayBuffer()));
    fs.renameSync(`${dest}.part`, dest);
    return dest;
  })().finally(() => (fwJob = null));
  return fwJob;
}

/** RPCS3's compatibility list for a PS3 game name: Playable / Ingame / Intro / Loadable / Nothing. */
export async function ps3Compat(q: string) {
  const r = await fetch(`https://rpcs3.net/compatibility?api=v1&g=${encodeURIComponent(q.slice(0, 80))}`, { signal: AbortSignal.timeout(20_000) });
  const j = (await r.json()) as { results?: Record<string, { title: string; status: string; date?: string }> };
  return Object.entries(j.results ?? {})
    .slice(0, 12)
    .map(([id, x]) => ({ id, title: x.title, status: x.status, date: x.date }));
}

/** the server's address on the home network (what Moonlight on the TV connects to). */
function lanIp(): string {
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (/^(lo|docker|br-|veth|tailscale)/.test(name)) continue;
    const v4 = addrs?.find((a) => a.family === 'IPv4' && !a.internal);
    if (v4) return v4.address;
  }
  return '';
}

/**
 * New games show up by themselves: ES-DE only reads the ROM folders when it starts, so when a
 * console folder changes (a game added or removed) and nobody is playing, ES-DE is restarted
 * (about 3 seconds). Checked every 2 minutes.
 */
export function romSignature(root: string): string {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const dir = path.join(root, d.name);
        const names = fs.readdirSync(dir).filter((n) => !n.startsWith('.')).sort();
        return `${d.name}:${names.length}:${names.join('|').length}:${Math.round(fs.statSync(dir).mtimeMs)}`;
      })
      .sort()
      .join(';');
  } catch {
    return '';
  }
}
/** A PS3 disc folder (with PS3_GAME inside) must be called "<name>.ps3dir" for ES-DE to start it. */
export function ps3FoldersAsGames(root = path.join(GAMES(), 'ROMs', 'ps3')): string[] {
  const renamed: string[] = [];
  try {
    for (const d of fs.readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory() || /\.ps3dir$/i.test(d.name) || d.name.startsWith('.')) continue;
      if (!fs.existsSync(path.join(root, d.name, 'PS3_GAME'))) continue;
      const to = path.join(root, `${d.name}.ps3dir`);
      if (fs.existsSync(to)) continue;
      fs.renameSync(path.join(root, d.name), to);
      renamed.push(d.name);
    }
  } catch {
    /* no ps3 folder */
  }
  return renamed;
}

let lastSig: string | null = null;
let pendingRescan = false;
export async function rescanIfChanged(): Promise<'unchanged' | 'waiting' | 'restarted'> {
  const sig = romSignature(path.join(GAMES(), 'ROMs'));
  if (lastSig === null) {
    lastSig = sig;
    return 'unchanged';
  }
  if (sig !== lastSig) pendingRescan = true;
  lastSig = sig;
  if (!pendingRescan) return 'unchanged';
  if (await playing()) return 'waiting';
  ps3FoldersAsGames();
  // Let a copy finish: only rescan after the folders were quiet for one round.
  if (sig !== romSignature(path.join(GAMES(), 'ROMs'))) return 'waiting';
  await execFileP('docker', ['restart', '-t', '5', ESDE], { timeout: 60_000 }).catch(() => null);
  pendingRescan = false;
  return 'restarted';
}

export async function gamesRoutes(app: FastifyInstance) {
  if (!process.env.VITEST) {
    const t = setInterval(() => void rescanIfChanged().catch(() => null), 120_000);
    app.addHook('onClose', async () => clearInterval(t));
  }
  app.post('/api/games/rescan', { preHandler: requireAuth }, async () => {
    if (await playing()) return { ok: false, reason: 'playing' };
    ps3FoldersAsGames();
    await execFileP('docker', ['restart', '-t', '5', ESDE], { timeout: 60_000 });
    lastSig = romSignature(path.join(GAMES(), 'ROMs'));
    pendingRescan = false;
    return { ok: true };
  });
  app.get('/api/games', { preHandler: requireAuth }, async () => {
    const [running, now, pending, paired] = await Promise.all([streamerRunning(), playing(), pendingPair(), pairedClients()]);
    return { running, playing: now, pendingPair: pending ? { at: Date.now() } : null, paired, library: library(), bios: biosStatus(), root: GAMES(), lanIp: lanIp(), hostname: config.hostname, firmwareDownloading: !!fwJob };
  });
  app.post<{ Body: { pin?: string } }>('/api/games/pair', { preHandler: requireAuth }, async (req, reply) => {
    const r = await pair(String(req.body?.pin ?? '').trim());
    return r.ok ? r : reply.code(400).send(r);
  });
  app.post('/api/games/stop', { preHandler: requireAuth }, async () => ({ ok: await stopGame() }));
  app.post('/api/games/ps3-firmware', { preHandler: requireAuth }, async () => {
    void fetchPs3Firmware().catch(() => null);
    return { ok: true };
  });
  app.get<{ Querystring: { q?: string } }>('/api/games/ps3-compat', { preHandler: requireAuth }, async (req, reply) => {
    try {
      return { results: await ps3Compat(String(req.query.q ?? '')) };
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });
}
