import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import YAML from 'yaml';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'manar-cfg-test-'));
process.env.MANAR_APPS_DIR = tmp;
process.env.MANAR_DATA_DIR = path.join(tmp, 'var');
const { ConfigError, getEnv, readEnvFile, saveCompose, setEnv, setServiceOptions, validateCompose } = await import('./appconfig.js');
const { closeDb } = await import('../db.js');

const dir = path.join(tmp, 'demo');
fs.mkdirSync(dir);
fs.writeFileSync(
  path.join(dir, 'compose.yaml'),
  YAML.stringify({
    name: 'manar-demo',
    services: {
      web: {
        image: 'nginx:1',
        ports: [{ target: 80, published: '20005', protocol: 'tcp', host_ip: '127.0.0.1' }],
        environment: { DB_PASSWORD: '${MANAR_SECRET_1}', MODE: 'prod', PRICE: 'a$$b' },
        labels: { 'manar.app': 'demo', 'manar.service': 'web' },
      },
      db: { image: 'postgres:16', environment: { POSTGRES_PASSWORD: '${MANAR_SECRET_1}' }, labels: { 'manar.app': 'demo', 'manar.service': 'db' } },
    },
  }),
);
fs.writeFileSync(path.join(dir, '.env'), 'MANAR_SECRET_1=s3cret\n', { mode: 0o600 });

afterAll(() => {
  closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const base = (svc: Record<string, unknown>) => YAML.stringify({ services: { web: { image: 'nginx:1', ...svc } } });

describe('validateCompose', () => {
  it.each([
    [{ ports: ['8080:80'] }, 'port_not_localhost'],
    [{ ports: [{ target: 80, published: '8080' }] }, 'port_not_localhost'],
    [{ network_mode: 'host' }, 'host_network'],
    [{ privileged: true }, 'privileged'],
  ])('rejects %j', (svc, code) => {
    expect(() => validateCompose('demo', base(svc))).toThrow(code);
  });

  it('accepts localhost ports and restores the manar.app label', () => {
    const out = YAML.parse(validateCompose('demo', base({ ports: ['127.0.0.1:20005:80'], labels: { 'manar.app': 'evil' } })));
    expect(out.services.web.labels['manar.app']).toBe('demo');
    expect(out.name).toBe('manar-demo');
  });

  it('rejects broken YAML', () => {
    expect(() => validateCompose('demo', 'services: [')).toThrow(ConfigError);
  });
});

describe('environment', () => {
  it('masks secrets unless revealed and unescapes $$', () => {
    const env = getEnv('demo', false);
    expect(env.web).toEqual([
      { key: 'DB_PASSWORD', secret: true, value: null },
      { key: 'MODE', secret: false, value: 'prod' },
      { key: 'PRICE', secret: false, value: 'a$b' },
    ]);
    expect(getEnv('demo', true).web[0].value).toBe('s3cret');
  });

  it('keeps secrets in .env, shares them between services, escapes $', async () => {
    await setEnv('demo', 'web', [
      { key: 'DB_PASSWORD', value: 'n3w' },
      { key: 'MODE', value: 'dev' },
      { key: 'PRICE', value: null },
      { key: 'API_TOKEN', value: 'tok$en' },
      { key: 'NOTE', value: 'cost $5' },
    ]);
    const doc = YAML.parse(fs.readFileSync(path.join(dir, 'compose.yaml'), 'utf8'));
    expect(doc.services.web.environment).toEqual({ DB_PASSWORD: '${MANAR_SECRET_1}', MODE: 'dev', PRICE: 'a$$b', API_TOKEN: '${MANAR_SECRET_2}', NOTE: 'cost $$5' });
    expect(readEnvFile('demo')).toEqual({ MANAR_SECRET_1: 'n3w', MANAR_SECRET_2: 'tok$en' });
    expect(getEnv('demo', true).db[0].value).toBe('n3w');
    expect(fs.statSync(path.join(dir, '.env')).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir).some((n) => n.endsWith('.bak'))).toBe(true);
  });

  it('sets restart policy and limits', async () => {
    await setServiceOptions('demo', 'web', { restart: 'no', memory: 256 * 1024 ** 2, cpus: 1.5 });
    const web = YAML.parse(fs.readFileSync(path.join(dir, 'compose.yaml'), 'utf8')).services.web;
    expect(web).toMatchObject({ restart: 'no', mem_limit: 268435456, cpus: 1.5 });
    await setServiceOptions('demo', 'web', { memory: null, cpus: null });
    const web2 = YAML.parse(fs.readFileSync(path.join(dir, 'compose.yaml'), 'utf8')).services.web;
    expect(web2.mem_limit).toBeUndefined();
    expect(web2.cpus).toBeUndefined();
  });

  it('refuses a compose that docker compose rejects', async () => {
    await expect(saveCompose('demo', YAML.stringify({ services: { web: { image: 'nginx', depends_on: ['nope'] } } }))).rejects.toThrow('compose_invalid');
  });
});
