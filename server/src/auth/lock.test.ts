import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticator } from 'otplib';
import type { FastifyInstance } from 'fastify';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'manar-lock-'));
process.env.MANAR_DATA_DIR = path.join(tmp, 'var');
process.env.MANAR_DATA_ROOT = path.join(tmp, 'data');
process.env.MANAR_WEB_DIST = path.join(tmp, 'no-web');
process.env.MANAR_DEV = '1';

const { buildApp } = await import('../app.js');
const { ensureSetupToken } = await import('./setup.js');
const { closeDb } = await import('../db.js');

const ORIGIN = 'http://localhost:5173';
let app: FastifyInstance;
let cookie = '';
const h = () => ({ origin: ORIGIN, cookie });

beforeAll(async () => {
  app = await buildApp({ logger: false });
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
  await app.close();
  closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('lock screen', () => {
  it('needs a PIN before locking; PINs are 4–8 digits', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/lock', payload: {}, headers: h() })).json().error).toBe('no_pin');
    expect((await app.inject({ method: 'PUT', url: '/api/lock/pin', payload: { pin: '12a4' }, headers: h() })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/lock/pin', payload: { pin: '2580' }, headers: h() })).json()).toEqual({ hasPin: true });
  });

  it('refuses everything while locked, until the right PIN', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/lock', payload: {}, headers: h() })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/launcher', headers: h() })).statusCode).toBe(423);
    expect((await app.inject({ url: '/api/fs/list?path=', headers: h() })).statusCode).toBe(423);
    expect((await app.inject({ url: '/api/auth/state', headers: h() })).json().user.locked).toBe(true);
    expect((await app.inject({ method: 'POST', url: '/api/lock/unlock', payload: { pin: '0000' }, headers: h() })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/lock/unlock', payload: { pin: '2580' }, headers: h() })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/launcher', headers: h() })).statusCode).toBe(200);
  });
});
