import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Settings, in this order of precedence: environment variables (MANAR_*) → the config file
 * (`MANAR_CONFIG`, default `<dataDir>/manar.json`, see manar.example.json) → generic defaults that
 * work on any Linux box (hostname-based addresses, /srv/data, container prefix "manar-").
 * Nothing here is specific to one machine; machine facts belong in the config file.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const env = process.env;
const dev = env.MANAR_DEV === '1';
const dataDir = env.MANAR_DATA_DIR ?? path.join(repoRoot, 'var');
export const configFile = env.MANAR_CONFIG ?? path.join(dataDir, 'manar.json');

type Json = Record<string, unknown>;
let fileCfg: Json = {};
try {
  fileCfg = JSON.parse(fs.readFileSync(configFile, 'utf8')) as Json;
} catch {
  /* no config file: defaults */
}
const str = (envName: string, key: string, fallback: string): string => {
  const e = env[envName];
  if (e !== undefined) return e;
  const f = fileCfg[key];
  return typeof f === 'string' ? f : fallback;
};
const num = (envName: string, key: string, fallback: number): number => {
  const e = env[envName];
  if (e !== undefined && e !== '') return Number(e);
  const f = fileCfg[key];
  return typeof f === 'number' ? f : fallback;
};
const list = (key: string, fallback: string[]): string[] => {
  const f = fileCfg[key];
  return Array.isArray(f) ? f.map(String) : fallback;
};
const home = os.homedir();
const expand = (p: string) => (p.startsWith('~/') ? path.join(home, p.slice(2)) : p);

const hostname = str('MANAR_HOSTNAME', 'hostname', os.hostname());
const dataRoot = str('MANAR_DATA_ROOT', 'dataRoot', '/srv/data');
const appDataRoot = str('MANAR_APP_DATA_ROOT', 'appDataRoot', path.join(dataRoot, 'apps'));
const containerPrefix = str('MANAR_CONTAINER_PREFIX', 'containerPrefix', 'manar-');
/** The big drive: media, games, backups, uploads. Same as dataRoot when there is no separate one. */
const mediaRoot = expand(str('MANAR_MEDIA_ROOT', 'mediaRoot', dataRoot));
const publicOrigin = str('MANAR_ORIGIN', 'publicOrigin', `https://${hostname}:7443`);
const timezone = str('TZ', 'timezone', Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');

export const config = {
  dev,
  repoRoot,
  configFile,
  host: '127.0.0.1',
  hostname,
  port: num('MANAR_PORT', 'port', 7470),
  /** Name shown in the UI, notifications and the Android app. */
  brand: str('MANAR_BRAND', 'brand', 'MinisManager'),
  /** Public origin users reach the app at (tailscale serve HTTPS, or a reverse proxy). */
  publicOrigin,
  rpId: str('MANAR_RP_ID', 'rpId', new URL(publicOrigin).hostname),
  rpName: str('MANAR_BRAND', 'brand', 'MinisManager'),
  dataDir,
  webDist: env.MANAR_WEB_DIST ?? path.join(repoRoot, 'web', 'dist'),
  helperPath: str('MANAR_HELPER', 'helperPath', '/usr/local/sbin/manar-helper'),
  sessionCookie: dev ? 'manar_sid' : '__Host-manar_sid',
  sessionTtlMs: 30 * 24 * 3600 * 1000,
  /** Sampling interval for live metrics and process list. */
  tickMs: 2000,
  historyRetentionDays: 7,
  timezone,
  /** Logins of the apps installed through the store (written at setup time). */
  credsFile: expand(str('MANAR_CREDS', 'credsFile', path.join(dataDir, 'apps-credentials.json'))),

  // ---- Apps ----
  dockerSocket: str('MANAR_DOCKER_SOCK', 'dockerSocket', '/var/run/docker.sock'),
  appsDir: str('MANAR_APPS_DIR', 'appsDir', '/srv/apps'),
  dataRoot,
  appDataRoot,
  mediaRoot,
  containerPrefix,
  appUid: num('MANAR_APP_UID', 'appUid', 1000),
  appGid: num('MANAR_APP_GID', 'appGid', 1000),
  /** Host ports handed to apps (bound to 127.0.0.1, published on the tailnet via tailscale serve). */
  appPortRange: [num('MANAR_APP_PORT_MIN', 'appPortMin', 20000), num('MANAR_APP_PORT_MAX', 'appPortMax', 29999)] as [number, number],
  /** Ports used by other services on this machine — never allocated to apps. */
  reservedPorts: list('reservedPorts', []).map(Number),
  tailscaleHost: str('MANAR_TS_HOST', 'tailscaleHost', hostname),
  /** GPU render node for hardware video (VAAPI): thumbnails, transcodes, game streaming. */
  renderNode: str('MANAR_RENDER_NODE', 'renderNode', '/dev/dri/renderD128'),

  // ---- Games (Sunshine + the always-on ES-DE container) ----
  games: {
    esdeContainer: str('MANAR_GAMES_ESDE', 'gamesEsdeContainer', `${containerPrefix}games-esde`),
    streamerContainer: str('MANAR_GAMES_STREAMER', 'gamesStreamerContainer', `${containerPrefix}games-sunshine`),
    /** The emulators' home (saves, configs); bind-mounted into the ES-DE container. */
    home: expand(str('MANAR_GAMES_HOME', 'gamesHome', path.join(appDataRoot, 'sunshine', 'home'))),
  },

  // ---- Previews ----
  /** A LibreOffice container (any with `soffice`) used to turn Office/CAD files into PDFs. */
  libreofficeContainer: str('MANAR_LIBREOFFICE', 'libreofficeContainer', `${containerPrefix}libreoffice-writer`),
  dwg2dxf: expand(str('MANAR_DWG2DXF', 'dwg2dxf', 'dwg2dxf')),

  // ---- ArtCraft apps (static WebAssembly builds, served on their own origin) ----
  craftRoot: expand(str('MANAR_CRAFT_DIR', 'craftRoot', path.join(dataDir, 'craft'))),
  craftPort: num('MANAR_CRAFT_PORT', 'craftPort', 7472),
  craftOrigin: str('MANAR_CRAFT_ORIGIN', 'craftOrigin', `https://${hostname}:7444`),

  // ---- Share links: a separate, public-facing server that only serves shared files ----
  sharePort: num('MANAR_SHARE_PORT', 'sharePort', 7475),
  /** Where people outside the tailnet open links (a reverse proxy in front of :7475). */
  shareBase: str('MANAR_SHARE_URL', 'shareBase', `https://${hostname}:7475`),

  // ---- Bot API: read-only status for automations (n8n) in Docker; listens on the docker bridge only ----
  botHost: str('MANAR_BOT_HOST', 'botHost', '172.17.0.1'),
  botPort: num('MANAR_BOT_PORT', 'botPort', 7478),
  /** Where events are announced (an n8n webhook, …). Empty = off. */
  downloadHook: str('MANAR_DOWNLOAD_HOOK', 'downloadHook', ''),
  /** Telegram user id of the owner (Telegram Business tracking). 0 = off. */
  telegramOwner: num('MANAR_TELEGRAM_OWNER', 'telegramOwner', 0),
  /** GRERPS database for the ERP bot commands. Empty = off. */
  grerpsDb: expand(str('MANAR_GRERPS_DB', 'grerpsDb', '')),
  ytDlp: expand(str('MANAR_YTDLP', 'ytDlp', 'yt-dlp')),

  // ---- Voice assistant persona (optional; nothing personal ships in the code) ----
  /** How the voice assistant addresses the owner. Empty = "the owner". */
  ownerName: str('MANAR_OWNER_NAME', 'ownerName', ''),
  /** One sentence of context about the owner for the voice assistant (kept in your config, never in git). */
  voicePersona: str('MANAR_VOICE_PERSONA', 'voicePersona', ''),

  // ---- Self-update (Settings → Updates): GitHub "owner/repo" whose Releases carry new versions ----
  updateRepo: str('MANAR_UPDATE_REPO', 'updateRepo', 'anasshadid93/NovaOS'),
  /** Optional: a URL returning the same JSON as GitHub's /releases/latest (mirror or test server). */
  updateFeed: str('MANAR_UPDATE_FEED', 'updateFeed', ''),

  // ---- Backups (restic, nightly) ----
  backup: {
    /** Repository and restores live on the media drive. */
    root: expand(str('MANAR_BACKUP_ROOT', 'backupRoot', path.join(mediaRoot, 'Backups'))),
    sources: list('backupSources', [dataDir, appDataRoot, path.join(dataRoot, 'files'), path.join(dataRoot, 'workspace')]).map(expand),
    excludes: list('backupExcludes', [
      'node_modules',
      '.next',
      '.cache',
      '__pycache__',
      '.venv',
      'venv',
      path.join(dataDir, 'manar.db*'), // copied consistently as backup/manar.db instead
      path.join(dataDir, 'pyenv'),
      path.join(dataDir, 'tradebot-cache'),
      path.join(dataDir, 'thumbs'),
      path.join(dataDir, 'previews'),
      path.join(dataDir, 'tts'),
      path.join(appDataRoot, 'jellyfin', 'config', 'cache'),
      path.join(appDataRoot, 'jellyfin', 'config', 'log'),
      path.join(appDataRoot, 'jellyfin', 'config', 'data', 'transcodes'),
      path.join(appDataRoot, '*', 'cache'),
      path.join(appDataRoot, 'browser'),
      '*.log',
    ]).map(expand),
  },
};

export function allowedOrigins(): string[] {
  const list = [config.publicOrigin];
  if (config.dev) list.push('http://localhost:5173', 'http://127.0.0.1:5173', `http://127.0.0.1:${config.port}`);
  return list;
}

/** "+04:00" for the configured time zone (used when a time has no zone of its own). */
export function tzOffset(date = new Date()): string {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: config.timezone, timeZoneName: 'longOffset' }).formatToParts(date).find((p) => p.type === 'timeZoneName')?.value ?? '';
    const m = /GMT([+-]\d\d:\d\d)/.exec(part);
    return m ? m[1] : '+00:00';
  } catch {
    return '+00:00';
  }
}
