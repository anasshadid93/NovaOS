import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticator } from 'otplib';
import type { FastifyInstance } from 'fastify';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'manar-craft-'));
process.env.MANAR_DATA_DIR = path.join(tmp, 'var');
process.env.MANAR_DATA_ROOT = path.join(tmp, 'data');
process.env.MANAR_WEB_DIST = path.join(tmp, 'no-web');
process.env.MANAR_CRAFT_DIR = path.join(tmp, 'craft');
process.env.MANAR_DEV = '1';

const web = path.join(tmp, 'craft', 'demo', 'web');
fs.mkdirSync(web, { recursive: true });
fs.writeFileSync(path.join(web, 'index.html'), '<p>demo</p>');
fs.writeFileSync(path.join(web, 'demo-0123456789abcdef_bg.wasm'), Buffer.from([0, 0x61, 0x73, 0x6d]));
fs.writeFileSync(path.join(tmp, 'craft', 'demo', 'app.json'), JSON.stringify({ title: 'Demo', version: '1.0' }));
fs.mkdirSync(path.join(tmp, 'craft', 'empty'));
fs.mkdirSync(path.join(tmp, 'craft', 'qto', 'web'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'craft', 'qto', 'web', 'index.html'), '<head><meta name="viewport" content="width=device-width"></head><p>qto</p>');
fs.writeFileSync(path.join(tmp, 'craft', 'qto', 'app.json'), JSON.stringify({ title: 'QTO', mobile: true, writable: true, connect: ['https://fapi.binance.com', 'wss://fstream.binance.com', "https://evil.com 'unsafe-eval'", 'http://plain.example', 42] }));
fs.writeFileSync(path.join(tmp, 'secret.txt'), 'nope');

const { buildApp } = await import('../app.js');
const { buildCraftServer } = await import('./craft.js');
const { ensureSetupToken } = await import('../auth/setup.js');
const { closeDb } = await import('../db.js');

const ORIGIN = 'http://localhost:5173';
let app: FastifyInstance;
let craft: FastifyInstance;
let cookie = '';

beforeAll(async () => {
  app = await buildApp({ logger: false });
  craft = await buildCraftServer();
  const token = ensureSetupToken()!;
  const start = await app.inject({ method: 'POST', url: '/api/setup/start', payload: { token }, headers: { origin: ORIGIN } });
  const fin = await app.inject({
    method: 'POST',
    url: '/api/setup/finish',
    payload: { token, username: 'anas', password: 'correct horse battery', code: authenticator.generate(start.json().secret) },
    headers: { origin: ORIGIN },
  });
  cookie = String(fin.headers['set-cookie']).split(';')[0];
});

afterAll(async () => {
  await craft.close();
  await app.close();
  closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('ArtCraft apps', () => {
  it('lists installed apps (with a web build) for the launcher', async () => {
    const r = await app.inject({ url: '/api/craft', headers: { cookie } });
    expect(r.json()).toEqual([expect.objectContaining({ id: 'demo', title: 'Demo', version: '1.0' }), expect.objectContaining({ id: 'qto', title: 'QTO' })]);
    const l = await app.inject({ url: '/api/launcher', headers: { cookie } });
    expect(l.json().some((i: { key: string }) => i.key === 'craft:demo')).toBe(true);
  });

  it('shows a sign-in hint to visitors without a session', async () => {
    const r = await craft.inject({ url: '/demo/' });
    expect(r.statusCode).toBe(401);
    expect(r.body).toContain('NovaOS');
  });

  it('swaps a launcher ticket for its own cookie (browsers without NovaOS cookies)', async () => {
    const l = await app.inject({ url: '/api/launcher', headers: { cookie } });
    const url = new URL(l.json().find((i: { key: string }) => i.key === 'craft:demo').url);
    expect(url.searchParams.get('t')).toBeTruthy();
    const r = await craft.inject({ url: url.pathname + url.search });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe('/demo/');
    const craftCookie = String(r.headers['set-cookie']).split(';')[0];
    expect((await craft.inject({ url: '/demo/', headers: { cookie: craftCookie } })).statusCode).toBe(200);
    // A ticket is not a cookie, a cookie is not a ticket, and tampering fails.
    expect((await craft.inject({ url: '/demo/', headers: { cookie: craftCookie.replace(/=c\./, '=t.') } })).statusCode).toBe(401);
    const forged = url.searchParams.get('t')!.replace(/^t\.1\./, 't.2.');
    expect((await craft.inject({ url: `/demo/?t=${forged}` })).statusCode).toBe(401);
  });

  it('always lays the apps out in desktop mode', async () => {
    const { desktopMode } = await import('./craft.js');
    expect(desktopMode('<head><meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no"></head>')).toBe('<head><meta name="viewport" content="width=1280"></head>');
    expect(desktopMode('<html><head><title>x</title></head>')).toContain('<head>\n  <meta name="viewport" content="width=1280">');
  });

  it('adds the WebGL fallback for devices whose GPU is too small for the WebGPU path', async () => {
    const { patchIndex } = await import('./craft.js');
    const out = patchIndex('<html><head><meta name="viewport" content="width=device-width"><script type="module">app()</script></head>');
    expect(out.indexOf('maxTextureDimension2D')).toBeLessThan(out.indexOf('type="module"'));
    expect(out).toContain('content="width=1280"');
  });

  it('rejects expired tickets', async () => {
    const { signCraft, verifyCraft } = await import('./craft.js');
    expect(verifyCraft('t', signCraft('t', 1, 1000, Date.now() - 5000))).toBeNull();
    expect(verifyCraft('t', signCraft('t', 1, 60_000))).toBe(1);
  });

  it('serves the app with its own CSP and the wasm MIME type', async () => {
    const r = await craft.inject({ url: '/demo/', headers: { cookie } });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('demo');
    expect(r.headers['content-security-policy']).toContain("'wasm-unsafe-eval'");
    expect(r.headers['cache-control']).toBe('no-cache');
    const w = await craft.inject({ url: '/demo/demo-0123456789abcdef_bg.wasm', headers: { cookie } });
    expect(w.headers['content-type']).toContain('application/wasm');
    expect(w.headers['cache-control']).toContain('immutable');
  });

  it('lets an app reach only the extra origins its app.json lists (and only valid ones)', async () => {
    const qto = (await craft.inject({ url: '/qto/', headers: { cookie } })).headers['content-security-policy'] as string;
    expect(qto).toContain("connect-src 'self' data: blob: https://fapi.binance.com wss://fstream.binance.com;");
    expect(qto).not.toContain('evil.com');
    expect(qto).not.toContain('plain.example');
    expect((await craft.inject({ url: '/demo/', headers: { cookie } })).headers['content-security-policy']).toContain("connect-src 'self' data: blob:;");
  });

  it('never serves anything outside an app web folder', async () => {
    for (const url of ['/demo/../../secret.txt', '/demo/%2e%2e/%2e%2e/secret.txt', '/demo/../app.json', '/empty/', '/..%2fsecret.txt/x']) {
      const r = await craft.inject({ url, headers: { cookie } });
      expect(r.statusCode, url).not.toBe(200);
    }
    expect((await craft.inject({ method: 'POST', url: '/demo/', headers: { cookie } })).statusCode).toBe(405);
  });

  it('a writable phone page keeps its own layout and saves JSON (with history), only when signed in', async () => {
    const page = await craft.inject({ url: '/qto/', headers: { cookie } });
    expect(page.body).toContain('width=device-width');
    expect(page.body).not.toContain('maxTextureDimension2D');
    const h = { cookie, 'content-type': 'application/json' };
    expect((await craft.inject({ url: '/qto/data/state.json', headers: { cookie } })).statusCode).toBe(404);
    expect((await craft.inject({ method: 'PUT', url: '/qto/data/state.json', payload: '{"a":1}', headers: h })).json().ok).toBe(true);
    expect((await craft.inject({ method: 'PUT', url: '/qto/data/state.json', payload: '{"a":2}', headers: h })).statusCode).toBe(200);
    expect((await craft.inject({ url: '/qto/data/state.json', headers: { cookie } })).json()).toEqual({ a: 2 });
    expect(fs.readdirSync(path.join(tmp, 'craft', 'qto', 'data', '.history'))).toHaveLength(1);
    expect((await craft.inject({ method: 'PUT', url: '/qto/data/state.json', payload: '[1]', headers: h })).statusCode).toBe(400);
    expect((await craft.inject({ method: 'PUT', url: '/qto/data/state.json', payload: '{"a":3}', headers: { 'content-type': 'application/json' } })).statusCode).toBe(401);
    expect((await craft.inject({ method: 'PUT', url: '/demo/data/state.json', payload: '{"a":1}', headers: h })).statusCode).toBe(405);
    for (const url of ['/qto/data/../app.json', '/qto/data/.history/x.json', '/qto/data/a.b.json'])
      expect((await craft.inject({ method: 'PUT', url, payload: '{}', headers: h })).statusCode, url).not.toBe(200);
  });
});
