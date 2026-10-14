import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticator } from 'otplib';
import type { FastifyInstance } from 'fastify';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'manar-term-'));
process.env.MANAR_DATA_DIR = path.join(tmp, 'var');
process.env.MANAR_DATA_ROOT = path.join(tmp, 'data');
process.env.MANAR_WEB_DIST = path.join(tmp, 'no-web');
process.env.MANAR_SHELL = '/bin/bash';
process.env.MANAR_DEV = '1';

const { buildApp } = await import('../app.js');
const { ensureSetupToken } = await import('../auth/setup.js');
const { closeDb, getDb } = await import('../db.js');

const ORIGIN = 'http://localhost:5173';
let app: FastifyInstance;
let cookie = '';

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
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

const closeCode = (ws: { on: (e: string, cb: (code: number) => void) => void }) => new Promise<number>((r) => ws.on('close', (code: number) => r(code)));

describe('terminal', () => {
  it('needs a fresh confirmation for a ticket', async () => {
    getDb().prepare('UPDATE sessions SET elevated_until = 0').run();
    const r = await app.inject({ method: 'POST', url: '/api/terminal/ticket', payload: {}, headers: { origin: ORIGIN, cookie } });
    expect(r.json().error).toBe('confirm_required');
    getDb().prepare('UPDATE sessions SET elevated_until = ?').run(Date.now() + 60_000);
  });

  it('refuses a socket without a valid ticket', async () => {
    const ws = await app.injectWS('/api/terminal?t=nope', { headers: { origin: ORIGIN, cookie } });
    expect(await closeCode(ws)).toBe(4403);
  });

  it('runs a shell with a one-time ticket', async () => {
    const { ticket } = (await app.inject({ method: 'POST', url: '/api/terminal/ticket', payload: {}, headers: { origin: ORIGIN, cookie } })).json();
    const ws = await app.injectWS(`/api/terminal?t=${ticket}&cols=80&rows=24`, { headers: { origin: ORIGIN, cookie } });
    let out = '';
    const seen = new Promise<void>((resolve) =>
      ws.on('message', (d: Buffer) => {
        out += d.toString();
        if (out.includes('MINIS-42')) resolve();
      }),
    );
    ws.send(JSON.stringify({ type: 'in', data: 'echo MINIS-$((40+2))\n' }));
    await seen;
    ws.terminate();
    // The ticket can't be reused.
    const again = await app.injectWS(`/api/terminal?t=${ticket}`, { headers: { origin: ORIGIN, cookie } });
    expect(await closeCode(again)).toBe(4403);
  });
});
