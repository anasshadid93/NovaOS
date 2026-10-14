import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import YAML from 'yaml';
import { registerTask } from '../tasks/tasks.js';
import { appDir } from './installer.js';
import { config } from '../config.js';

const execFileP = promisify(execFile);

/**
 * Editing an installed app's configuration (compose.yaml + .env). Every change is
 * validated (localhost-only ports, no host network/privileged, manar.app label kept,
 * `docker compose config` passes), the previous compose.yaml is backed up, and the
 * app is re-applied with `docker compose up -d` as a background task.
 */

export class ConfigError extends Error {
  constructor(
    readonly code: string,
    readonly detail = '',
  ) {
    super(code);
  }
}

const SECRET_REF = /^\$\{(MANAR_SECRET_\d+)\}$/;
const SECRET_KEY = /(PASS(WORD)?|PASSWD|SECRET|TOKEN|API_?KEY|SALT|PRIVATE_?KEY)$/i;

function files(id: string) {
  const dir = appDir(id);
  return { dir, compose: path.join(dir, 'compose.yaml'), env: path.join(dir, '.env') };
}

export function readEnvFile(id: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const line of fs.readFileSync(files(id).env, 'utf8').split('\n')) {
      const i = line.indexOf('=');
      if (i > 0 && !line.startsWith('#')) out[line.slice(0, i)] = line.slice(i + 1);
    }
  } catch {
    /* no .env */
  }
  return out;
}

function writeEnvFile(id: string, env: Record<string, string>) {
  fs.writeFileSync(
    files(id).env,
    Object.entries(env)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n') + '\n',
    { mode: 0o600 },
  );
}

export function readCompose(id: string): string {
  const f = files(id).compose;
  if (!fs.existsSync(f)) throw new ConfigError('not_found');
  return fs.readFileSync(f, 'utf8');
}

type Svc = Record<string, unknown> & { ports?: unknown[]; labels?: unknown; environment?: unknown; network_mode?: string; privileged?: boolean };

/** Checks the safety rules and returns the normalised YAML text. */
export function validateCompose(id: string, text: string): string {
  let doc: Record<string, unknown>;
  try {
    doc = YAML.parse(text) as Record<string, unknown>;
  } catch (e) {
    throw new ConfigError('yaml', String((e as Error).message).split('\n')[0]);
  }
  const services = doc?.services as Record<string, Svc> | undefined;
  if (!services || typeof services !== 'object' || !Object.keys(services).length) throw new ConfigError('no_services');
  for (const [name, svc] of Object.entries(services)) {
    if (svc.network_mode === 'host') throw new ConfigError('host_network', name);
    if (svc.privileged === true) throw new ConfigError('privileged', name);
    for (const p of svc.ports ?? []) {
      // Long syntax must bind 127.0.0.1; short syntax must start with "127.0.0.1:".
      const ok = typeof p === 'object' && p !== null ? (p as { host_ip?: string }).host_ip === '127.0.0.1' : /^127\.0\.0\.1:\d+:\d+/.test(String(p));
      if (!ok) throw new ConfigError('port_not_localhost', `${name}: ${typeof p === 'object' ? JSON.stringify(p) : String(p)}`);
    }
    const labels: Record<string, string> = Array.isArray(svc.labels)
      ? Object.fromEntries((svc.labels as string[]).map((l) => l.split(/=(.*)/s).slice(0, 2) as [string, string]))
      : { ...((svc.labels as Record<string, string>) ?? {}) };
    labels['manar.app'] = id;
    labels['manar.service'] ??= name;
    svc.labels = labels;
  }
  doc.name = `${config.containerPrefix}${id}`;
  return YAML.stringify(doc);
}

async function composeConfigCheck(id: string, text: string) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'manar-cfg-'));
  try {
    fs.writeFileSync(path.join(tmp, 'compose.yaml'), text);
    fs.copyFileSync(files(id).env, path.join(tmp, '.env'));
    await execFileP('docker', ['compose', '-f', 'compose.yaml', '--env-file', '.env', 'config', '-q'], { cwd: tmp, timeout: 30_000 });
  } catch (e) {
    throw new ConfigError('compose_invalid', String((e as { stderr?: string }).stderr ?? (e as Error).message).trim().split('\n').slice(-3).join(' '));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Validates, backs up the old file (keeps 5) and writes the new compose.yaml. */
export async function saveCompose(id: string, text: string) {
  const normalized = validateCompose(id, text);
  await composeConfigCheck(id, normalized);
  const f = files(id);
  const backup = `${f.compose}.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
  fs.copyFileSync(f.compose, backup);
  const backups = fs
    .readdirSync(f.dir)
    .filter((n) => /^compose\.yaml\..*\.bak$/.test(n))
    .sort();
  for (const old of backups.slice(0, -5)) fs.rmSync(path.join(f.dir, old), { force: true });
  fs.writeFileSync(f.compose, `# Edited in Manar ${new Date().toISOString()}\n` + normalized);
}

// ---- Environment variables -------------------------------------------------

export interface EnvVar {
  key: string;
  value: string | null; // null = hidden secret
  secret: boolean;
}

function envEntries(svc: Svc): [string, string][] {
  const e = svc.environment;
  if (Array.isArray(e))
    return (e as string[]).map((x) => {
      const i = x.indexOf('=');
      return i < 0 ? [x, ''] : [x.slice(0, i), x.slice(i + 1)];
    });
  return Object.entries((e as Record<string, unknown>) ?? {}).map(([k, v]) => [k, v === null || v === undefined ? '' : String(v)]);
}

export function getEnv(id: string, reveal: boolean): Record<string, EnvVar[]> {
  const doc = YAML.parse(readCompose(id)) as { services: Record<string, Svc> };
  const secrets = readEnvFile(id);
  const out: Record<string, EnvVar[]> = {};
  for (const [name, svc] of Object.entries(doc.services)) {
    out[name] = envEntries(svc).map(([key, raw]) => {
      const ref = SECRET_REF.exec(raw)?.[1];
      const secret = !!ref || SECRET_KEY.test(key);
      const value = ref ? (secrets[ref] ?? '') : raw.replace(/\$\$/g, '$');
      return { key, secret, value: secret && !reveal ? null : value };
    });
  }
  return out;
}

/**
 * Replaces one service's environment. Entries with value null keep their current value.
 * Secret values are stored in .env (0600), never in compose.yaml.
 */
export async function setEnv(id: string, service: string, vars: { key: string; value: string | null }[]) {
  const text = readCompose(id);
  const doc = YAML.parse(text) as { services: Record<string, Svc> };
  const svc = doc.services[service];
  if (!svc) throw new ConfigError('no_service');
  const current = new Map(envEntries(svc));
  const env = readEnvFile(id);
  let n = Object.keys(env).filter((k) => k.startsWith('MANAR_SECRET_')).length;
  const next: Record<string, string> = {};
  for (const { key, value } of vars) {
    if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(key)) throw new ConfigError('bad_key', key);
    const old = current.get(key);
    if (value === null) {
      if (old === undefined) throw new ConfigError('bad_key', key);
      next[key] = old;
      continue;
    }
    if (value.includes('\n')) throw new ConfigError('bad_value', key);
    const ref = old ? SECRET_REF.exec(old)?.[1] : undefined;
    if (ref) {
      env[ref] = value; // shared secrets (e.g. app + database) change together
      next[key] = old!;
    } else if (SECRET_KEY.test(key)) {
      const newRef = `MANAR_SECRET_${++n}`;
      env[newRef] = value;
      next[key] = `\${${newRef}}`;
    } else next[key] = value.replace(/\$/g, '$$$$');
  }
  svc.environment = next;
  writeEnvFile(id, env);
  await saveCompose(id, YAML.stringify(doc));
}

// ---- Restart policy / limits ---------------------------------------------------

export async function setServiceOptions(id: string, service: string, o: { restart?: string; memory?: number | null; cpus?: number | null }) {
  const doc = YAML.parse(readCompose(id)) as { services: Record<string, Svc> };
  const svc = doc.services[service];
  if (!svc) throw new ConfigError('no_service');
  if (o.restart !== undefined) svc.restart = o.restart;
  if (o.memory !== undefined) {
    if (o.memory) svc.mem_limit = o.memory;
    else delete svc.mem_limit;
  }
  if (o.cpus !== undefined) {
    if (o.cpus) svc.cpus = o.cpus;
    else delete svc.cpus;
  }
  await saveCompose(id, YAML.stringify(doc));
}

registerTask('app.apply', async (ctx, params) => {
  const id = String(params.id);
  ctx.progress('Applying configuration');
  await ctx.run('docker', ['compose', '-p', `${config.containerPrefix}${id}`, '-f', 'compose.yaml', '--env-file', '.env', 'up', '-d', '--remove-orphans'], { cwd: appDir(id) });
});
