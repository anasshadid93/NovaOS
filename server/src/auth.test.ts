import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticator } from 'otplib';
import type { FastifyInstance } from 'fastify';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manar-test-'));
process.env.MANAR_DATA_DIR = dataDir;
process.env.MANAR_WEB_DIST = path.join(dataDir, 'no-web');
process.env.MANAR_DEV = '1';

const ORIGIN = 'http://localhost:5173';
let app: FastifyInstance;
let setupToken: string;
let secret: string;
let cookie = '';

const { buildApp } = await import('./app.js');
const { ensureSetupToken } = await import('./auth/setup.js');
const { closeDb, getDb } = await import('./db.js');

function post(url: string, payload: unknown, headers: Record<string, string> = {}) {
  return app.inject({ method: 'POST', url, payload: payload as object, headers: { origin: ORIGIN, cookie, ...headers } });
}

/** A TOTP code for a step that has not been used yet (replay protection rejects reuse). */
function freshCode(offsetSteps: number) {
  return authenticator.clone({ epoch: Date.now() + offsetSteps * 30000 }).generate(secret);
}

beforeAll(async () => {
  app = await buildApp({ logger: false });
  setupToken = ensureSetupToken()!;
});

afterAll(async () => {
  await app.close();
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('setup', () => {
  it('reports setup required and writes a 0600 token file', async () => {
    const res = await app.inject({ url: '/api/auth/state' });
    expect(res.json()).toMatchObject({ setupRequired: true, user: null });
    const stat = fs.statSync(path.join(dataDir, 'setup-token'));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('rejects a wrong token', async () => {
    const res = await post('/api/setup/start', { token: 'nope' });
    expect(res.statusCode).toBe(403);
  });

  it('rejects requests without our Origin (CSRF)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/setup/start',
      payload: { token: setupToken },
      headers: { origin: 'https://evil.example' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('bad_origin');
  });

  it('wizard: detects the machine and writes the config file', async () => {
    expect((await post('/api/setup/env', { token: 'nope' })).statusCode).toBe(403);
    const env = await post('/api/setup/env', { token: setupToken });
    expect(env.statusCode).toBe(200);
    expect(env.json()).toMatchObject({ machine: { hostname: expect.any(String) }, hasConfigFile: false, renderNodes: expect.any(Array) });
    expect(env.json().suggestedOrigin).toMatch(/^https:\/\/.+:7443$/);
    expect(env.json().volumes[0]).toMatchObject({ id: 'internal' });

    const bad = await post('/api/setup/config', { token: setupToken, config: { publicOrigin: 'http://plain:7443' } });
    expect(bad.json().error).toBe('bad_publicOrigin');
    expect((await post('/api/setup/config', { token: setupToken, config: { timezone: 'Mars/Olympus' } })).json().error).toBe('bad_timezone');
    expect((await post('/api/setup/config', { token: setupToken, config: { mediaRoot: '/no/such/dir' } })).json().error).toBe('bad_mediaRoot');

    const ok = await post('/api/setup/config', {
      token: setupToken,
      config: { brand: 'Home Box', hostname: 'box', publicOrigin: 'https://box.tail.ts.net:7443/', timezone: 'Asia/Dubai', mediaRoot: dataDir },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true, restart: false }); // tests never restart the process
    const file = JSON.parse(fs.readFileSync(path.join(dataDir, 'manar.json'), 'utf8'));
    expect(file).toMatchObject({ brand: 'Home Box', hostname: 'box', publicOrigin: 'https://box.tail.ts.net:7443', rpId: 'box.tail.ts.net', tailscaleHost: 'box.tail.ts.net', timezone: 'Asia/Dubai', mediaRoot: dataDir });
    expect(fs.statSync(path.join(dataDir, 'manar.json')).mode & 0o777).toBe(0o600);
    expect((await post('/api/setup/env', { token: setupToken })).json().hasConfigFile).toBe(true);
  });

  it('creates the owner with password + TOTP and logs in', async () => {
    const start = await post('/api/setup/start', { token: setupToken });
    expect(start.statusCode).toBe(200);
    secret = start.json().secret;
    expect(start.json().qrSvg).toContain('<svg');

    const weak = await post('/api/setup/finish', { token: setupToken, username: 'anas', password: 'short', code: authenticator.generate(secret) });
    expect(weak.json().error).toBe('weak_password');

    const res = await post('/api/setup/finish', {
      token: setupToken,
      username: 'anas',
      password: 'correct horse battery',
      code: authenticator.generate(secret),
    });
    expect(res.statusCode).toBe(200);
    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    cookie = setCookie.split(';')[0];
    expect(fs.existsSync(path.join(dataDir, 'setup-token'))).toBe(false);

    const state = await app.inject({ url: '/api/auth/state', headers: { cookie } });
    expect(state.json()).toMatchObject({ setupRequired: false, user: { name: 'anas', method: 'password' } });
  });

  it('refuses a second setup', async () => {
    const res = await post('/api/setup/start', { token: setupToken });
    expect(res.statusCode).toBe(409);
    expect((await post('/api/setup/env', { token: setupToken })).statusCode).toBe(409);
    expect((await post('/api/setup/config', { token: setupToken, config: { brand: 'x' } })).statusCode).toBe(409);
  });
});

describe('password login', () => {
  it('rejects a wrong password', async () => {
    const res = await post('/api/auth/password', { username: 'anas', password: 'wrong password!!', code: freshCode(1) }, { cookie: '' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a replayed TOTP code', async () => {
    // The setup code's step was consumed; the same step must not work again.
    const res = await post(
      '/api/auth/password',
      { username: 'anas', password: 'correct horse battery', code: authenticator.generate(secret) },
      { cookie: '' },
    );
    expect(res.statusCode).toBe(401);
  });

  it('accepts password + a fresh TOTP code', async () => {
    const res = await post('/api/auth/password', { username: 'anas', password: 'correct horse battery', code: freshCode(1) }, { cookie: '' });
    expect(res.statusCode).toBe(200);
  });
});

describe('dangerous actions need confirmation', () => {
  it('returns confirm_required once the elevation window has passed', async () => {
    getDb().exec('UPDATE sessions SET elevated_until = 0');
    const res = await app.inject({ method: 'DELETE', url: '/api/auth/passkeys/x', headers: { origin: ORIGIN, cookie } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('confirm_required');
  });

  it('TOTP confirmation re-opens the window', async () => {
    getDb().exec('UPDATE users SET totp_last_step = 0');
    const res = await post('/api/auth/confirm', { code: authenticator.generate(secret) });
    expect(res.statusCode).toBe(200);
    expect(res.json().elevatedUntil).toBeGreaterThan(Date.now());
    const del = await app.inject({ method: 'DELETE', url: '/api/auth/passkeys/x', headers: { origin: ORIGIN, cookie } });
    expect(del.statusCode).toBe(404);
  });

  it('unauthenticated requests get 401', async () => {
    const res = await app.inject({ url: '/api/auth/sessions' });
    expect(res.statusCode).toBe(401);
  });

  it('logout destroys the session', async () => {
    await post('/api/auth/logout', {});
    const state = await app.inject({ url: '/api/auth/state', headers: { cookie } });
    expect(state.json().user).toBeNull();
  });
});
