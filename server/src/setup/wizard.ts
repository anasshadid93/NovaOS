import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { config, configFile } from '../config.js';
import { checkSetupToken } from '../auth/setup.js';
import { userCount } from '../auth/users.js';
import { listVolumes } from '../files/volumes.js';
import { tailscale } from '../system/info.js';

/**
 * First-run wizard: before the owner account exists, the setup page can look at the machine
 * (hostname, tailscale name, drives, GPU) and write the config file (`<dataDir>/manar.json`).
 * Everything here needs the setup token and stops working the moment a user exists, so a
 * machine that is already set up never exposes any of it.
 */
const execFileP = promisify(execFile);

/** Keys the wizard may write. Everything else in the file is left untouched. */
const KEYS = ['brand', 'hostname', 'publicOrigin', 'rpId', 'tailscaleHost', 'timezone', 'mediaRoot', 'renderNode', 'shareBase'] as const;
type Key = (typeof KEYS)[number];
export type WizardConfig = Partial<Record<Key, string>>;

const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;

export function validateWizardConfig(input: unknown): { ok: true; value: WizardConfig } | { ok: false; error: string } {
  if (!input || typeof input !== 'object') return { ok: false, error: 'bad_config' };
  const value: WizardConfig = {};
  for (const k of KEYS) {
    const v = (input as Record<string, unknown>)[k];
    if (v === undefined || v === null || v === '') continue;
    if (typeof v !== 'string' || v.length > 300) return { ok: false, error: `bad_${k}` };
    value[k] = v.trim();
  }
  if (value.brand !== undefined && !/^[^\n\r<>]{1,40}$/.test(value.brand)) return { ok: false, error: 'bad_brand' };
  if (value.hostname !== undefined && !HOSTNAME_RE.test(value.hostname)) return { ok: false, error: 'bad_hostname' };
  for (const k of ['publicOrigin', 'shareBase'] as const) {
    const v = value[k];
    if (v === undefined) continue;
    let u: URL;
    try {
      u = new URL(v);
    } catch {
      return { ok: false, error: `bad_${k}` };
    }
    if (u.protocol !== 'https:' || u.pathname !== '/' || u.search || u.hash || u.username) return { ok: false, error: `bad_${k}` };
    value[k] = u.origin;
  }
  if (value.publicOrigin) {
    // Passkeys are bound to the host of the address people use: keep them in step.
    const host = new URL(value.publicOrigin).hostname;
    value.rpId = host;
    if (value.tailscaleHost === undefined) value.tailscaleHost = host;
  }
  if (value.timezone !== undefined) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value.timezone });
    } catch {
      return { ok: false, error: 'bad_timezone' };
    }
  }
  if (value.mediaRoot !== undefined) {
    if (!path.isAbsolute(value.mediaRoot) || value.mediaRoot.includes('\0')) return { ok: false, error: 'bad_mediaRoot' };
    value.mediaRoot = path.normalize(value.mediaRoot);
    if (!fs.existsSync(value.mediaRoot) || !fs.statSync(value.mediaRoot).isDirectory()) return { ok: false, error: 'bad_mediaRoot' };
  }
  if (value.renderNode !== undefined && !/^\/dev\/dri\/renderD\d+$/.test(value.renderNode)) return { ok: false, error: 'bad_renderNode' };
  return { ok: true, value };
}

function renderNodes(): string[] {
  try {
    return fs
      .readdirSync('/dev/dri')
      .filter((n) => /^renderD\d+$/.test(n))
      .map((n) => `/dev/dri/${n}`);
  } catch {
    return [];
  }
}

async function dockerVersion(): Promise<string | null> {
  try {
    return (await execFileP('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 5000 })).stdout.trim() || null;
  } catch {
    return null;
  }
}

function readConfigFile(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(configFile, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** What the wizard shows: detected facts plus the values that are currently in effect. */
export async function detectEnvironment() {
  const [ts, docker, volumes] = await Promise.all([
    tailscale(),
    dockerVersion(),
    listVolumes().catch(() => []),
  ]);
  const dns = ts?.self.dns || null;
  return {
    machine: {
      hostname: os.hostname(),
      os: (() => {
        try {
          return /PRETTY_NAME="([^"]+)"/.exec(fs.readFileSync('/etc/os-release', 'utf8'))?.[1] ?? os.type();
        } catch {
          return os.type();
        }
      })(),
      cpus: os.cpus().length,
      memory: os.totalmem(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    },
    tailscale: ts ? { state: ts.state, dns, ips: ts.self.ips } : null,
    suggestedOrigin: dns ? `https://${dns}:7443` : `https://${os.hostname()}:7443`,
    docker,
    renderNodes: renderNodes(),
    volumes: volumes
      .filter((v) => v.state === 'mounted')
      .map((v) => ({ id: v.id, name: v.name, size: v.size, used: v.used, removable: v.removable, path: v.id === 'internal' ? config.dataRoot : path.join(config.dataRoot, v.path ?? '') })),
    current: {
      brand: config.brand,
      hostname: config.hostname,
      publicOrigin: config.publicOrigin,
      timezone: config.timezone,
      dataRoot: config.dataRoot,
      mediaRoot: config.mediaRoot,
      renderNode: config.renderNode,
      shareBase: config.shareBase,
    },
    configFile,
    hasConfigFile: fs.existsSync(configFile),
  };
}

/** Writes the chosen values into the config file; true when a restart is needed to apply them. */
export function writeWizardConfig(value: WizardConfig): boolean {
  const existing = readConfigFile();
  const next = { ...existing, ...value };
  fs.mkdirSync(path.dirname(configFile), { recursive: true, mode: 0o700 });
  const tmp = `${configFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, configFile);
  const live: Record<string, string> = {
    brand: config.brand,
    hostname: config.hostname,
    publicOrigin: config.publicOrigin,
    rpId: config.rpId,
    tailscaleHost: config.tailscaleHost,
    timezone: config.timezone,
    mediaRoot: config.mediaRoot,
    renderNode: config.renderNode,
    shareBase: config.shareBase,
  };
  return KEYS.some((k) => value[k] !== undefined && value[k] !== live[k]);
}

/**
 * Restart to pick up the new config. The process exits with a non-zero code so systemd restarts
 * it under Restart=on-failure as well as Restart=always. Nothing else is running yet (no user,
 * no tasks), so there is nothing to wait for.
 */
export function scheduleRestart(app: FastifyInstance, delayMs = 400): void {
  setTimeout(() => {
    void app.close().finally(() => process.exit(3));
  }, delayMs).unref();
}

export async function wizardRoutes(app: FastifyInstance) {
  const limit = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };
  const guard = (token: unknown) => {
    if (userCount() > 0) return { code: 409, error: 'already_setup' };
    if (!checkSetupToken(token)) return { code: 403, error: 'bad_token' };
    return null;
  };

  app.post<{ Body: { token?: string } }>('/api/setup/env', limit, async (req, reply) => {
    const g = guard(req.body?.token);
    if (g) return reply.code(g.code).send({ error: g.error });
    return detectEnvironment();
  });

  app.post<{ Body: { token?: string; config?: unknown } }>('/api/setup/config', limit, async (req, reply) => {
    const g = guard(req.body?.token);
    if (g) return reply.code(g.code).send({ error: g.error });
    const v = validateWizardConfig(req.body?.config);
    if (!v.ok) return reply.code(400).send({ error: v.error });
    const restart = writeWizardConfig(v.value);
    // Tests and dev runs keep the process; a real install restarts to load the new file.
    if (restart && !process.env.VITEST && !config.dev) scheduleRestart(app);
    return { ok: true, restart: restart && !process.env.VITEST && !config.dev, configFile };
  });
}
