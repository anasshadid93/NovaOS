import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { requireAuth, requireElevated } from '../auth/sessions.js';
import { kvGet, kvSet } from '../db.js';
import { restore as resticRestore, snapshots } from '../backup/backup.js';
import { enqueue, registerTask } from '../tasks/tasks.js';
import { GAMES, playing, romIndex, type RomEntry } from './games.js';
import { config } from '../config.js';

/**
 * Play from the phone: "continue playing", favourites, search, and a ▶ that starts the game on the
 * TV screen (the always-running ES-DE container) with the same emulator ES-DE would use. Also the
 * saved-games card: sizes, and restoring every emulator's saves from a nightly backup.
 */
const execFileP = promisify(execFile);
const ESDE = config.games.esdeContainer;
const HOME = config.games.home;
const ROMS_IN_CONTAINER = '/ROMs';

/** Per system: the emulator ES-DE is set to (es_systems.xml + the alternatives chosen in gamelists). */
const CORES: Record<string, string> = {
  nes: 'mesen',
  snes: 'snes9x',
  n64: 'mupen64plus_next',
  gb: 'gambatte',
  gbc: 'gambatte',
  gba: 'mgba',
  megadrive: 'genesis_plus_gx',
  mastersystem: 'genesis_plus_gx',
  gamegear: 'genesis_plus_gx',
  pcengine: 'mednafen_pce',
  fbneo: 'fbneo',
  mame: 'mame',
  arcade: 'mame',
  psx: 'swanstation',
  psp: 'ppsspp',
  nds: 'melondsds',
  dreamcast: 'flycast',
};
export function launchCommand(system: string, romInContainer: string): string | null {
  const q = `'${romInContainer.replace(/'/g, `'\\''`)}'`;
  if (CORES[system]) return `/usr/games/retroarch -f -L /home/retro/.config/retroarch/cores/${CORES[system]}_libretro.so ${q}`;
  if (system === 'ps2') return `/home/retro/Applications/pcsx2-emu.AppImage -batch -fullscreen ${q}`;
  if (system === 'ps3') return `/home/retro/Applications/rpcs3-emu.AppImage --no-gui ${q}`;
  if (system === 'ps4') return `/home/retro/Applications/Shadps4-sdl.AppImage ${q}`;
  if (system === 'xbox') return `/home/retro/Applications/xemu-emu.AppImage -dvd_path ${q}`;
  if (system === 'gamecube' || system === 'wii') return `/home/retro/Applications/dolphin-emu.AppImage -b -e ${q}`;
  return null;
}

export function toContainerPath(rom: string): string | null {
  const root = path.join(GAMES(), 'ROMs');
  const real = path.resolve(rom);
  if (real !== root && !real.startsWith(root + path.sep)) return null;
  return path.posix.join(ROMS_IN_CONTAINER, path.relative(root, real).split(path.sep).join('/'));
}

/** Starts the emulator on the games screen, with the session ES-DE's own launches get. */
export async function launch(rom: string): Promise<{ ok: boolean; error?: string }> {
  const entry = romIndex().find((r) => r.rom === rom);
  if (!entry) return { ok: false, error: 'unknown_game' };
  const inside = toContainerPath(rom);
  const cmd = inside && launchCommand(entry.system, inside);
  if (!cmd) return { ok: false, error: 'no_emulator' };
  if (await playing()) return { ok: false, error: 'already_playing' };
  const env = ['HOME=/home/retro', 'DISPLAY=:0', 'WAYLAND_DISPLAY=wayland-1', 'XDG_RUNTIME_DIR=/run/user/games', 'XDG_SESSION_TYPE=wayland', 'XDG_CURRENT_DESKTOP=sway', 'APPIMAGE_EXTRACT_AND_RUN=1'];
  // The newest /tmp/dbus-* socket is the running sway session's bus (Qt emulators need it to map their window).
  const script = `export DBUS_SESSION_BUS_ADDRESS="unix:path=$(ls -t /tmp/dbus-* 2>/dev/null | head -1)"; cd /tmp; exec ${cmd} >/tmp/mm-launch.log 2>&1`;
  await execFileP('docker', ['exec', '-d', '-u', '1000', ...env.flatMap((e) => ['-e', e]), ESDE, 'sh', '-c', script], { timeout: 20_000 });
  recordPlay(rom);
  return { ok: true };
}

// ---- Played / favourites (MinisManager's own, merged with what ES-DE wrote in its gamelists) ----

interface Played {
  at: number;
  count: number;
}
const played = (): Record<string, Played> => JSON.parse(kvGet('games_played') ?? '{}') as Record<string, Played>;
function recordPlay(rom: string) {
  const all = played();
  all[rom] = { at: Date.now(), count: (all[rom]?.count ?? 0) + 1 };
  kvSet('games_played', JSON.stringify(all));
}
const favs = (): string[] => JSON.parse(kvGet('games_favs') ?? '[]') as string[];

/** ES-DE's gamelists: <lastplayed>20261014T153312</lastplayed>, <favorite>true</favorite> per game path. */
export function esdeMeta(dir = path.join(HOME, 'ES-DE', 'gamelists')): Map<string, { at?: number; favorite: boolean }> {
  const out = new Map<string, { at?: number; favorite: boolean }>();
  let systems: string[] = [];
  try {
    systems = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const sys of systems) {
    let xml = '';
    try {
      xml = fs.readFileSync(path.join(dir, sys, 'gamelist.xml'), 'utf8');
    } catch {
      continue;
    }
    for (const m of xml.matchAll(/<game>([\s\S]*?)<\/game>/g)) {
      const p = /<path>\.\/([^<]+)<\/path>/.exec(m[1])?.[1];
      if (!p) continue;
      const lp = /<lastplayed>(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})<\/lastplayed>/.exec(m[1]);
      const at = lp ? new Date(+lp[1], +lp[2] - 1, +lp[3], +lp[4], +lp[5], +lp[6]).getTime() : undefined;
      out.set(path.join(GAMES(), 'ROMs', sys, p.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&apos;/g, "'").replace(/&quot;/g, '"')), { at, favorite: /<favorite>true<\/favorite>/.test(m[1]) });
    }
  }
  return out;
}

export function recentAndFavorites(): { recent: (RomEntry & { at: number })[]; favorites: RomEntry[] } {
  const index = romIndex();
  const byRom = new Map(index.map((r) => [r.rom, r]));
  const meta = esdeMeta();
  const mine = played();
  const myFavs = new Set(favs());
  const at = new Map<string, number>();
  for (const [rom, m] of meta) if (m.at && byRom.has(rom)) at.set(rom, m.at);
  for (const [rom, p] of Object.entries(mine)) if (byRom.has(rom)) at.set(rom, Math.max(p.at, at.get(rom) ?? 0));
  const recent = [...at.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([rom, t]) => ({ ...byRom.get(rom)!, at: t }));
  const favorites = index.filter((r) => myFavs.has(r.rom) || meta.get(r.rom)?.favorite);
  return { recent, favorites };
}

/** Box art: Games/media/<system>/covers/<name>.png, else the game's own icon (PS3/PS4 folders). */
export function coverFile(entry: RomEntry): string | null {
  const c = path.join(GAMES(), 'media', entry.system, 'covers', `${entry.name}.png`);
  if (fs.existsSync(c)) return c;
  if (entry.system === 'ps3') {
    const icon = path.join(entry.rom, 'ICON0.PNG');
    if (fs.existsSync(icon)) return icon;
  }
  if (entry.system === 'ps4') {
    const icon = path.join(path.dirname(entry.rom), 'sce_sys', 'icon0.png');
    if (fs.existsSync(icon)) return icon;
  }
  return null;
}

// ---- Saved games -------------------------------------------------------------

/** Where the emulators keep saves and save states (inside the games home, in the nightly backup). */
export const SAVE_DIRS = ['.config/retroarch/saves', '.config/retroarch/states', '.config/PCSX2/memcards', '.config/PCSX2/sstates', '.config/rpcs3/dev_hdd0/home', '.local/share/shadPS4/savedata'];

function dirBytes(abs: string): number {
  try {
    const st = fs.lstatSync(abs);
    if (!st.isDirectory()) return st.size;
    let n = 0;
    for (const e of fs.readdirSync(abs)) n += dirBytes(path.join(abs, e));
    return n;
  } catch {
    return 0;
  }
}

let snapCache: { at: number; list: { id: string; short: string; time: string }[] } | null = null;
export async function saveSnapshots() {
  if (snapCache && Date.now() - snapCache.at < 60_000) return snapCache.list;
  // Only backups taken after the games home existed can hold its saves.
  let since = 0;
  try {
    since = fs.statSync(HOME).ctimeMs;
  } catch {
    /* no games home yet */
  }
  const list = (await snapshots())
    .filter((s) => Date.parse(s.time) > since && s.paths.some((p) => p === config.appDataRoot || HOME.startsWith(p + '/')))
    .map((s) => ({ id: s.id, short: s.short_id, time: s.time }));
  snapCache = { at: Date.now(), list };
  return list;
}

registerTask('games.restoreSaves', async (ctx, params) => {
  const snap = String(params.snapshot);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const rel of SAVE_DIRS) {
    const abs = path.join(HOME, rel);
    ctx.log(`Restoring ${rel}`);
    let from: string;
    try {
      from = await resticRestore(snap, abs);
    } catch (e) {
      ctx.log(`  not in this backup (${(e as Error).message.split('\n')[0].slice(0, 120)})`);
      continue;
    }
    if (!fs.existsSync(from)) {
      ctx.log('  not in this backup');
      continue;
    }
    // Today's saves are kept next to the folder, in case the restore was a mistake.
    if (fs.existsSync(abs)) fs.renameSync(abs, `${abs}.before-restore-${stamp}`);
    fs.cpSync(from, abs, { recursive: true, preserveTimestamps: true });
    await execFileP('chown', ['-R', '1000:1000', abs]).catch(() => null);
    ctx.log(`  done (${Math.round(dirBytes(abs) / 1024)} KB)`);
  }
  ctx.log('Saves restored. The old ones are in *.before-restore-* folders next to them.');
});

export async function launchRoutes(app: FastifyInstance) {
  app.get('/api/games/home', { preHandler: requireAuth }, async () => {
    const { recent, favorites } = recentAndFavorites();
    const myFavs = new Set(favs());
    const view = (r: RomEntry & { at?: number }) => ({ ...r, favorite: myFavs.has(r.rom) || favorites.some((f) => f.rom === r.rom) });
    return { recent: recent.map(view), favorites: favorites.map(view), playing: await playing() };
  });

  app.get<{ Querystring: { q?: string } }>('/api/games/search', { preHandler: requireAuth }, async (req) => {
    const q = String(req.query.q ?? '')
      .trim()
      .toLowerCase();
    if (q.length < 2) return { results: [] };
    const words = q.split(/\s+/);
    const myFavs = new Set(favs());
    const results = romIndex()
      .filter((r) => words.every((w) => r.name.toLowerCase().includes(w)))
      .slice(0, 40)
      .map((r) => ({ ...r, favorite: myFavs.has(r.rom) }));
    return { results };
  });

  app.get<{ Querystring: { rom?: string } }>('/api/games/cover', { preHandler: requireAuth }, async (req, reply) => {
    const entry = romIndex().find((r) => r.rom === String(req.query.rom ?? ''));
    const file = entry && coverFile(entry);
    if (!file) return reply.code(204).header('Cache-Control', 'private, max-age=3600').send();
    return reply.header('Content-Type', 'image/png').header('Cache-Control', 'private, max-age=86400').send(fs.createReadStream(file));
  });

  app.post<{ Body: { rom?: string } }>('/api/games/launch', { preHandler: requireAuth }, async (req, reply) => {
    const r = await launch(String(req.body?.rom ?? ''));
    return r.ok ? r : reply.code(r.error === 'already_playing' ? 409 : 400).send(r);
  });

  app.post<{ Body: { rom?: string; favorite?: boolean } }>('/api/games/favorite', { preHandler: requireAuth }, async (req, reply) => {
    const rom = String(req.body?.rom ?? '');
    if (!romIndex().some((r) => r.rom === rom)) return reply.code(404).send({ error: 'unknown_game' });
    const set = new Set(favs());
    if (req.body?.favorite) set.add(rom);
    else set.delete(rom);
    kvSet('games_favs', JSON.stringify([...set]));
    return { ok: true, favorite: set.has(rom) };
  });

  app.get('/api/games/saves', { preHandler: requireAuth }, async () => ({
    dirs: SAVE_DIRS.map((rel) => ({ dir: rel, bytes: dirBytes(path.join(HOME, rel)) })),
    snapshots: (await saveSnapshots()).slice(0, 14),
  }));

  app.post<{ Body: { snapshot?: string } }>('/api/games/saves/restore', { preHandler: requireElevated }, async (req, reply) => {
    const snap = String(req.body?.snapshot ?? '');
    if (!/^[a-f0-9]{8,64}$/.test(snap)) return reply.code(400).send({ error: 'bad_snapshot' });
    if (await playing()) return reply.code(409).send({ error: 'already_playing' });
    return { task: enqueue('games.restoreSaves', `Restore saved games (${snap.slice(0, 8)})`, { snapshot: snap }) };
  });
}
