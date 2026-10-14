import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

/**
 * Turns a catalog compose definition into what Manar actually runs:
 *  - every published port → 127.0.0.1:<allocated port>
 *  - /DATA/AppData/$AppID → /srv/data/apps/<id>; other /DATA/<x> → /srv/data/<x>
 *  - default passwords/secrets → generated values kept in .env
 *  - label manar.app=<id>, container names manar-<id>[-<service>]
 *  - host paths/devices that don't exist here (e.g. Raspberry Pi libs) are dropped
 */

export interface CatalogApp {
  id: string;
  title: string;
  tagline: string;
  description: string;
  category: string;
  developer: string;
  icon: string;
  main: string;
  web: { port: number; path: string; scheme: 'http' | 'https' } | null;
  compose: { services: Record<string, Service>; volumes?: unknown; networks?: unknown };
  tips: string | null;
  source: Record<string, string>;
}

type Service = Record<string, unknown> & {
  ports?: (string | number | PortObj)[];
  volumes?: (string | VolObj)[];
  environment?: Record<string, unknown> | string[];
  devices?: (string | { source: string; target: string })[];
  labels?: Record<string, string> | string[];
};
interface PortObj {
  target: number | string;
  published?: number | string;
  protocol?: string;
  host_ip?: string;
}
interface VolObj {
  type?: string;
  source?: string;
  target: string;
  read_only?: boolean;
  [k: string]: unknown;
}

export interface PrepareOptions {
  appsDataRoot: string; // /srv/data/apps
  dataRoot: string; // /srv/data
  /** ArtCraft apps folder (~/ArtCraft), for the server-run desktop builds. */
  craftRoot?: string;
  /** Host the app is published on (tailscale serve): fills `$APP_URL` once the web port is known. */
  tailscaleHost?: string;
  uid: number;
  gid: number;
  tz: string;
  allocatePort: (service: string, target: number, protocol: string) => number;
  exists?: (p: string) => boolean;
  randomSecret?: () => string;
}

export interface Prepared {
  compose: Record<string, unknown>;
  env: Record<string, string>;
  ports: { service: string; target: number; protocol: string; port: number }[];
  webPort: number | null;
  bindDirs: string[];
  warnings: string[];
}

const SECRET_KEY = /(PASS(WORD)?|PASSWD|SECRET(_?KEY)?|TOKEN|API_?KEY|SALT|PRIVATE_?KEY)$/i;

export function prepareCompose(app: CatalogApp, o: PrepareOptions): Prepared {
  const exists = o.exists ?? fs.existsSync;
  const rand = o.randomSecret ?? (() => crypto.randomBytes(18).toString('base64url'));
  const appData = path.join(o.appsDataRoot, app.id);
  const env: Record<string, string> = {};
  const secretByValue = new Map<string, string>();
  const ports: Prepared['ports'] = [];
  const bindDirs = new Set<string>([appData]);
  const warnings: string[] = [];
  let webPort: number | null = null;

  const subst = (s: string) =>
    s
      .replace(/\$\{?AppID\}?/g, app.id)
      .replace(/\$\{?PUID\}?/g, String(o.uid))
      .replace(/\$\{?PGID\}?/g, String(o.gid))
      .replace(/\$\{?TZ\}?/g, o.tz)
      .replace(/\$\{?APP_DATA\}?/g, appData)
      .replace(/\$\{?DATA_ROOT\}?/g, o.dataRoot)
      .replace(/\$\{?CRAFT_ROOT\}?/g, o.craftRoot ?? '/nonexistent')
      // Paths embedded in env values/commands (e.g. WORKSPACE_MOUNT_PATH=/DATA/AppData/<id>/x).
      .replace(new RegExp(`/DATA/AppData/${app.id}(?=/|$|\\s)`, 'g'), appData)
      .replace(/\/DATA\/AppData\//g, `${o.appsDataRoot}/`)
      .replace(/(^|[\s=:"'])\/DATA(?=\/)/g, `$1${o.dataRoot}`);

  const mapHostPath = (src: string): string | null => {
    let p = subst(src);
    if (p.startsWith('/DATA/AppData/')) p = path.join(appData, p.slice('/DATA/AppData/'.length).replace(new RegExp(`^${app.id}/?`), ''));
    else if (p === '/DATA' || p.startsWith('/DATA/')) p = path.join(o.dataRoot, p.slice('/DATA'.length));
    if (!p.startsWith('/')) return p; // named volume
    p = path.normalize(p);
    if (p === appData || p.startsWith(appData + '/') || p === o.dataRoot || p.startsWith(o.dataRoot + '/')) {
      bindDirs.add(p);
      return p;
    }
    if (p === '/var/run/docker.sock') warnings.push('docker_socket');
    return exists(p) ? p : null;
  };

  const services: Record<string, Service> = {};
  const names = Object.keys(app.compose.services);
  for (const name of names) {
    const svc = structuredClone(app.compose.services[name]);
    delete svc['x-casaos'];
    if (svc.network_mode === 'bridge') delete svc.network_mode;
    svc.container_name = name === app.main || names.length === 1 ? `${config.containerPrefix}${app.id}` : `${config.containerPrefix}${app.id}-${name}`;

    // Ports → 127.0.0.1:<allocated>
    if (svc.ports) {
      svc.ports = svc.ports.map((p) => {
        const obj = normalizePort(p);
        const target = Number(obj.target);
        const protocol = obj.protocol ?? 'tcp';
        const port = o.allocatePort(name, target, protocol);
        ports.push({ service: name, target, protocol, port });
        if (name === app.main && app.web && target === app.web.port && protocol === 'tcp') webPort = port;
        return { target, published: String(port), protocol, host_ip: '127.0.0.1' };
      });
    }

    // Volumes
    if (svc.volumes) {
      const vols: (string | VolObj)[] = [];
      for (const v of svc.volumes) {
        if (typeof v === 'string') {
          const [src, dst, mode] = v.split(':');
          if (dst === undefined) {
            vols.push(v);
            continue;
          }
          const mapped = mapHostPath(src);
          if (mapped !== null) vols.push([mapped, dst, mode].filter(Boolean).join(':'));
        } else if (v.type === 'bind' || (v.type === undefined && v.source?.startsWith('/'))) {
          const mapped = v.source ? mapHostPath(v.source) : null;
          if (mapped !== null) vols.push({ ...v, source: mapped });
        } else vols.push(v);
      }
      svc.volumes = vols;
    }

    // Devices: keep only ones that exist on the server.
    if (svc.devices) {
      svc.devices = svc.devices.filter((d) => exists(typeof d === 'string' ? d.split(':')[0] : d.source));
      if (svc.devices.length === 0) delete svc.devices;
    }

    // No GPU reservations (NVIDIA-specific).
    const deploy = svc.deploy as { resources?: { reservations?: { devices?: unknown } } } | undefined;
    if (deploy?.resources?.reservations?.devices) delete deploy.resources.reservations.devices;

    // Environment: substitute tokens; replace default secrets with generated ones.
    if (svc.environment) {
      const entries: [string, string][] = Array.isArray(svc.environment)
        ? svc.environment.map((e) => {
            const i = e.indexOf('=');
            return i < 0 ? [e, ''] : [e.slice(0, i), e.slice(i + 1)];
          })
        : Object.entries(svc.environment).map(([k, v]) => [k, v === null || v === undefined ? '' : String(v)]);
      const outEnv: Record<string, string> = {};
      for (const [k, raw] of entries) {
        const val = subst(raw);
        if (SECRET_KEY.test(k) && val && !val.includes('${')) {
          let ref = secretByValue.get(val);
          if (!ref) {
            ref = `MANAR_SECRET_${secretByValue.size + 1}`;
            secretByValue.set(val, ref);
            env[ref] = rand();
          }
          outEnv[k] = `\${${ref}}`;
        } else outEnv[k] = escapeDollar(val);
      }
      svc.environment = outEnv;
    }

    // Other string fields (command, entrypoint, user, …): token substitution only.
    for (const key of ['command', 'entrypoint', 'user', 'working_dir', 'hostname'] as const) {
      const v = svc[key];
      if (typeof v === 'string') svc[key] = subst(v);
      else if (Array.isArray(v)) svc[key] = v.map((x) => (typeof x === 'string' ? subst(x) : x));
    }

    // Label
    const labels: Record<string, string> = Array.isArray(svc.labels)
      ? Object.fromEntries(svc.labels.map((l) => l.split(/=(.*)/s).slice(0, 2) as [string, string]))
      : { ...(svc.labels ?? {}) };
    labels['manar.app'] = app.id;
    labels['manar.service'] = name;
    svc.labels = labels;
    if (!svc.restart) svc.restart = 'unless-stopped';

    services[name] = svc;
  }

  // `$APP_URL` (e.g. Vaultwarden's DOMAIN) needs the port allocated above: a second pass over env values.
  if (webPort && o.tailscaleHost) {
    const url = `https://${o.tailscaleHost}:${webPort}`;
    for (const svc of Object.values(services)) {
      const e = (svc as { environment?: Record<string, unknown> | string[] }).environment;
      if (Array.isArray(e)) (svc as { environment: string[] }).environment = e.map((x) => x.replace(/\$\{?APP_URL\}?/g, url));
      else if (e) for (const k of Object.keys(e)) if (typeof e[k] === 'string') e[k] = (e[k] as string).replace(/\$\{?APP_URL\}?/g, url);
    }
  }
  const compose: Record<string, unknown> = { name: `${config.containerPrefix}${app.id}`, services };
  if (app.compose.volumes) compose.volumes = app.compose.volumes;
  if (app.compose.networks) compose.networks = app.compose.networks;
  return { compose, env, ports, webPort, bindDirs: [...bindDirs], warnings };
}

function normalizePort(p: string | number | PortObj): PortObj {
  if (typeof p === 'object') return p;
  const s = String(p);
  const [spec, protocol] = s.split('/');
  const parts = spec.split(':');
  return { target: parts[parts.length - 1], protocol: protocol ?? 'tcp' };
}

/** Literal `$` must be doubled so compose does not try to interpolate it. */
function escapeDollar(v: string): string {
  return v.replace(/\$(?!\{MANAR_SECRET_\d+\})/g, '$$$$');
}

export function envFile(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n') + '\n';
}
