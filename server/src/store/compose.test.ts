import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { catalog } from './catalog.js';
import { envFile, prepareCompose, type CatalogApp } from './compose.js';

const opts = (exists: (p: string) => boolean = () => false) => {
  let next = 20000;
  return {
    appsDataRoot: '/srv/data/apps',
    dataRoot: '/srv/data',
    uid: 1000,
    gid: 1000,
    tz: 'Asia/Dubai',
    allocatePort: () => next++,
    exists,
    randomSecret: () => 'GENERATED',
  };
};

const sample: CatalogApp = {
  id: 'demo',
  title: 'Demo',
  tagline: '',
  description: '',
  category: 'Media',
  developer: '',
  icon: 'demo',
  main: 'web',
  web: { port: 8096, path: '/', scheme: 'http' },
  compose: {
    services: {
      web: {
        image: 'demo/web:1.0',
        network_mode: 'bridge',
        ports: [{ target: 8096, published: '8097', protocol: 'tcp' }, '7359:7359/udp'],
        volumes: [
          { type: 'bind', source: '/DATA/AppData/$AppID/config', target: '/config' },
          { type: 'bind', source: '/DATA/Media', target: '/media' },
          { type: 'bind', source: '/opt/vc/lib', target: '/opt/vc/lib' },
          'cache:/cache',
        ],
        devices: ['/dev/dri:/dev/dri', '/dev/vchiq:/dev/vchiq'],
        environment: { PUID: '$PUID', TZ: '$TZ', DB_PASSWORD: 'casaos', LITERAL: 'a$b' },
      },
      db: {
        image: 'postgres:16',
        environment: ['POSTGRES_PASSWORD=casaos', 'POSTGRES_USER=demo'],
        deploy: { resources: { reservations: { devices: [{ driver: 'nvidia' }] } } },
      },
    },
    volumes: { cache: {} },
  },
  tips: null,
  source: { repo: 'test' },
};

describe('prepareCompose', () => {
  const p = prepareCompose(sample, opts((x) => x === '/dev/dri'));
  const web = (p.compose.services as Record<string, Record<string, unknown>>).web;
  const db = (p.compose.services as Record<string, Record<string, unknown>>).db;

  it('binds every port to 127.0.0.1 with allocated host ports', () => {
    expect(web.ports).toEqual([
      { target: 8096, published: '20000', protocol: 'tcp', host_ip: '127.0.0.1' },
      { target: 7359, published: '20001', protocol: 'udp', host_ip: '127.0.0.1' },
    ]);
    expect(p.webPort).toBe(20000);
  });

  it('maps data paths and drops host paths that do not exist', () => {
    expect(web.volumes).toEqual([
      { type: 'bind', source: '/srv/data/apps/demo/config', target: '/config' },
      { type: 'bind', source: '/srv/data/Media', target: '/media' },
      'cache:/cache',
    ]);
    expect(web.devices).toEqual(['/dev/dri:/dev/dri']);
    expect(p.bindDirs).toContain('/srv/data/apps/demo/config');
  });

  it('replaces default secrets consistently across services', () => {
    expect((web.environment as Record<string, string>).DB_PASSWORD).toBe('${MANAR_SECRET_1}');
    expect((db.environment as Record<string, string>).POSTGRES_PASSWORD).toBe('${MANAR_SECRET_1}');
    expect(p.env).toEqual({ MANAR_SECRET_1: 'GENERATED' });
    expect(envFile(p.env)).toBe('MANAR_SECRET_1=GENERATED\n');
  });

  it('also treats *_SECRET_KEY settings as secrets', () => {
    const q = prepareCompose(
      { id: 'sk', title: 'sk', main: 'app', compose: { services: { app: { image: 'x', environment: { PAPERLESS_SECRET_KEY: 'change-me', SECRETKEY: 'x' } } } } } as never,
      { appsDataRoot: '/srv/data/apps', dataRoot: '/srv/data', uid: 1000, gid: 1000, tz: 'UTC', allocatePort: () => 20000, randomSecret: () => 'RND', exists: () => false },
    );
    expect((q.compose.services as Record<string, { environment: Record<string, string> }>).app.environment).toEqual({ PAPERLESS_SECRET_KEY: '${MANAR_SECRET_1}', SECRETKEY: '${MANAR_SECRET_2}' });
  });

  it('substitutes CasaOS tokens and escapes literal $', () => {
    expect(web.environment).toMatchObject({ PUID: '1000', TZ: 'Asia/Dubai', LITERAL: 'a$$b' });
  });

  it('labels containers, names them and removes bridge mode and GPU reservations', () => {
    expect(web.labels).toEqual({ 'manar.app': 'demo', 'manar.service': 'web' });
    expect(web.container_name).toBe('manar-demo');
    expect(db.container_name).toBe('manar-demo-db');
    expect(web.network_mode).toBeUndefined();
    expect(JSON.stringify(db)).not.toContain('nvidia');
    expect(p.compose.name).toBe('manar-demo');
  });
});

describe('catalog', () => {
  it('every catalog app converts to valid compose with only localhost ports', () => {
    const { apps } = catalog();
    expect(apps.length).toBeGreaterThan(100);
    expect(apps.find((a) => a.id === 'ollama')).toBeUndefined();
    expect(apps.find((a) => a.id === 'filebrowser')).toBeDefined();
    for (const app of apps) {
      const p = prepareCompose(app, opts());
      const text = YAML.stringify(p.compose);
      expect(YAML.parse(text)).toBeTruthy();
      for (const svc of Object.values(p.compose.services as Record<string, { ports?: { host_ip: string }[]; labels: Record<string, string> }>)) {
        for (const port of svc.ports ?? []) expect(port.host_ip).toBe('127.0.0.1');
        expect(svc.labels['manar.app']).toBe(app.id);
      }
      // Host-side paths must never point at CasaOS's /DATA (container-side targets may).
      for (const svc of Object.values(p.compose.services as Record<string, { volumes?: (string | { source?: string })[] }>)) {
        for (const v of svc.volumes ?? []) expect(typeof v === 'string' ? v.split(':')[0] : (v.source ?? '')).not.toMatch(/^\/DATA/);
      }
    }
  });
});
