import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticator } from 'otplib';
import type { FastifyInstance } from 'fastify';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'manar-share-'));
const root = path.join(tmp, 'data');
fs.mkdirSync(path.join(root, 'Trip', 'Day 1'), { recursive: true });
fs.mkdirSync(path.join(root, 'Private'));
fs.mkdirSync(path.join(tmp, 'secret'));
fs.writeFileSync(path.join(tmp, 'secret', 'passwd'), 'nope');
fs.writeFileSync(path.join(root, 'Private', 'diary.txt'), 'private');
fs.writeFileSync(path.join(root, 'Trip', 'notes.txt'), 'trip notes');
fs.writeFileSync(path.join(root, 'Trip', '.env'), 'SECRET=1');
fs.writeFileSync(path.join(root, 'Trip', 'Day 1', 'a.txt'), 'day one');
fs.writeFileSync(path.join(root, 'Trip', 'x<script>.txt'), 'xss name');
fs.symlinkSync(path.join(tmp, 'secret'), path.join(root, 'Trip', 'escape'));
fs.symlinkSync(path.join(root, 'Private'), path.join(root, 'Trip', 'sideways'));
fs.writeFileSync(path.join(root, 'report.pdf'), '%PDF-1.4');

process.env.MANAR_DATA_DIR = path.join(tmp, 'var');
process.env.MANAR_DATA_ROOT = root;
process.env.MANAR_APP_DATA_ROOT = path.join(root, 'apps');
process.env.MANAR_WEB_DIST = path.join(tmp, 'no-web');
process.env.MANAR_DEV = '1';

const { buildApp } = await import('../app.js');
const { buildShareServer, checkUnlock, signUnlock } = await import('./share.js');
const { ensureSetupToken } = await import('../auth/setup.js');
const { closeDb, getDb } = await import('../db.js');
const { config } = await import('../config.js');

const ORIGIN = 'http://localhost:5173';
let app: FastifyInstance;
let pub: FastifyInstance;
let cookie = '';
const h = () => ({ origin: ORIGIN, cookie });
const create = (payload: object) => app.inject({ method: 'POST', url: '/api/shares', payload, headers: h() });
const tokenOf = (url: string) => url.split('/s/')[1];

beforeAll(async () => {
  app = await buildApp({ logger: false });
  pub = await buildShareServer();
  const token = ensureSetupToken()!;
  const s = await app.inject({ method: 'POST', url: '/api/setup/start', payload: { token }, headers: { origin: ORIGIN } });
  const f = await app.inject({
    method: 'POST',
    url: '/api/setup/finish',
    payload: { token, username: 'anas', password: 'correct horse battery', code: authenticator.generate(s.json().secret) },
    headers: { origin: ORIGIN },
  });
  cookie = String(f.headers['set-cookie']).split(';')[0];
});

afterAll(async () => {
  await app.close();
  await pub.close();
  closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('share links', () => {
  it('needs a session to create and validates input', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/shares', payload: { path: 'Trip' }, headers: { origin: ORIGIN } })).statusCode).toBe(401);
    expect((await create({ path: '' })).statusCode).toBe(400);
    expect((await create({ path: '../secret' })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await create({ path: 'Trip', expiresDays: 5 })).statusCode).toBe(400);
    expect((await create({ path: 'Trip', password: 'ab' })).statusCode).toBe(400);
  });

  it('serves a shared folder and nothing outside it', async () => {
    const r = await create({ path: 'Trip', expiresDays: 7 });
    expect(r.statusCode).toBe(200);
    const t = tokenOf(r.json().url);
    const page = await pub.inject(`/s/${t}`);
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-security-policy']).toContain("default-src 'none'");
    expect(page.headers['x-robots-tag']).toContain('noindex');
    expect(page.body).toContain('notes.txt');
    expect(page.body).toContain('Day 1');
    expect(page.body).not.toContain('.env');
    expect(page.body).not.toContain('<script>');
    expect(page.body).toContain('x&lt;script&gt;.txt');
    expect((await pub.inject(`/s/${t}?p=Day%201`)).body).toContain('a.txt');
    expect((await pub.inject(`/s/${t}/f?p=notes.txt`)).body).toBe('trip notes');
    for (const p of ['../Private/diary.txt', '.env', 'escape/passwd', 'sideways/diary.txt', '/etc/passwd', 'Day 1/../../Private/diary.txt', '%2e%2e/Private/diary.txt']) {
      const res = await pub.inject(`/s/${t}/f?p=${encodeURIComponent(p)}`);
      expect(res.statusCode, p).toBe(404);
      expect(res.body).not.toMatch(/nope|private|SECRET/);
    }
  });

  it('a shared file serves only that file', async () => {
    const t = tokenOf((await create({ path: 'report.pdf' })).json().url);
    expect((await pub.inject(`/s/${t}`)).body).toContain('report.pdf');
    expect((await pub.inject(`/s/${t}/f`)).body).toBe('%PDF-1.4');
    expect((await pub.inject(`/s/${t}/f?p=Trip/notes.txt`)).statusCode).toBe(404);
    const dl = await pub.inject(`/s/${t}/f?dl=1`);
    expect(dl.headers['content-disposition']).toContain('attachment');
  });

  it('password: form until unlocked, wrong password refused', async () => {
    const t = tokenOf((await create({ path: 'Trip', password: 'open sesame' })).json().url);
    const locked = await pub.inject(`/s/${t}/f?p=notes.txt`);
    // The password form is a normal page (Samsung Internet shows 401 pages blank).
    expect(locked.statusCode).toBe(200);
    expect(locked.body).toContain('type="password"');
    expect(locked.body).not.toContain('trip notes');
    const form = { 'content-type': 'application/x-www-form-urlencoded' };
    const bad = await pub.inject({ method: 'POST', url: `/s/${t}/unlock`, payload: 'password=nope', headers: form });
    expect(bad.statusCode).toBe(200);
    expect(bad.body).toContain('type="password"');
    expect(bad.body).not.toContain('trip notes');
    const ok = await pub.inject({ method: 'POST', url: `/s/${t}/unlock`, payload: 'password=open+sesame', headers: form });
    expect(ok.statusCode).toBe(303);
    const c = String(ok.headers['set-cookie']).split(';')[0];
    expect((await pub.inject({ url: `/s/${t}/f?p=notes.txt`, headers: { cookie: c } })).body).toBe('trip notes');
    // The cookie of one share does not open another.
    const t2 = tokenOf((await create({ path: 'Trip', password: 'open sesame' })).json().url);
    const other = await pub.inject({ url: `/s/${t2}/f?p=notes.txt`, headers: { cookie: c.replace(/^sh\d+/, `sh${Number(/^sh(\d+)/.exec(c)![1]) + 1}`) } });
    expect(other.body).toContain('type="password"');
    expect(other.body).not.toContain('trip notes');
  });

  it('unlock cookies are bound to the share and expire', () => {
    const s = { id: 3, token: 'a'.repeat(22) };
    const v = signUnlock(s, 1_000_000_000_000);
    expect(checkUnlock(s, v, 1_000_000_000_001)).toBe(true);
    expect(checkUnlock({ ...s, id: 4 }, v, 1_000_000_000_001)).toBe(false);
    expect(checkUnlock(s, v, 1_000_000_000_000 + 13 * 3600_000)).toBe(false);
    expect(checkUnlock(s, 'garbage', 0)).toBe(false);
  });

  it('expired, deleted and unknown links are 404', async () => {
    const r = (await create({ path: 'Trip' })).json();
    const t = tokenOf(r.url);
    getDb().prepare('UPDATE shares SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, r.id);
    expect((await pub.inject(`/s/${t}`)).statusCode).toBe(404);
    const r2 = (await create({ path: 'Trip', expiresDays: null })).json();
    expect((await pub.inject(`/s/${tokenOf(r2.url)}`)).statusCode).toBe(200);
    await app.inject({ method: 'DELETE', url: `/api/shares/${r2.id}`, headers: h() });
    expect((await pub.inject(`/s/${tokenOf(r2.url)}`)).statusCode).toBe(404);
    expect((await pub.inject('/s/AAAAAAAAAAAAAAAAAAAAAA')).statusCode).toBe(404);
    expect((await pub.inject('/api/shares')).statusCode).toBe(404);
    expect((await pub.inject({ method: 'DELETE', url: `/s/${t}` })).statusCode).toBe(405);
  });

  it('zips a folder without hidden files or symlinks', async () => {
    const t = tokenOf((await create({ path: 'Trip' })).json().url);
    const z = await pub.inject(`/s/${t}/zip`);
    expect(z.statusCode).toBe(200);
    expect(z.headers['content-type']).toBe('application/zip');
    const body = z.rawPayload.toString('latin1');
    expect(body.startsWith('PK')).toBe(true);
    expect(body).toContain('Trip/notes.txt');
    expect(body).toContain('Trip/Day 1/a.txt');
    expect(body).not.toContain('.env');
    expect(body).not.toContain('passwd');
    expect(body).not.toContain('diary');
  });

  it('lists links with counts', async () => {
    const list = (await app.inject({ url: '/api/shares', headers: h() })).json();
    expect(list.shares.length).toBeGreaterThan(2);
    expect(list.shares.some((s: { views: number }) => s.views > 0)).toBe(true);
    expect(list.shares[0].url).toMatch(new RegExp(`^${config.shareBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/s/[\\w-]{22}$`));
  });
});
