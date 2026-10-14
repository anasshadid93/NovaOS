import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticator } from 'otplib';
import type { FastifyInstance } from 'fastify';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'manar-sys-'));
process.env.MANAR_DATA_DIR = path.join(tmp, 'var');
process.env.MANAR_DATA_ROOT = path.join(tmp, 'data');
process.env.MANAR_APP_DATA_ROOT = path.join(tmp, 'data', 'apps');
process.env.MANAR_WEB_DIST = path.join(tmp, 'no-web');
process.env.MANAR_DEV = '1';

const { buildApp } = await import('../app.js');
const { ensureSetupToken } = await import('../auth/setup.js');
const { closeDb } = await import('../db.js');
const { safeFileName } = await import('../files/files.js');

const ORIGIN = 'http://localhost:5173';
let app: FastifyInstance;
let cookie = '';

beforeAll(async () => {
  app = await buildApp({ logger: false });
  const token = ensureSetupToken()!;
  const start = await app.inject({ method: 'POST', url: '/api/setup/start', payload: { token }, headers: { origin: ORIGIN } });
  const secret = start.json().secret as string;
  const fin = await app.inject({
    method: 'POST',
    url: '/api/setup/finish',
    payload: { token, username: 'anas', password: 'correct horse battery', code: authenticator.generate(secret) },
    headers: { origin: ORIGIN },
  });
  cookie = String(fin.headers['set-cookie']).split(';')[0];
});

afterAll(async () => {
  await app.close();
  closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const h = () => ({ origin: ORIGIN, cookie });

describe('uploads and notes', () => {
  it('sorts quick uploads into /srv/data/files/<type> without overwriting', async () => {
    const boundary = '----manar';
    const body = (name: string) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="f"; filename="${name}"\r\nContent-Type: image/jpeg\r\n\r\nJPEGDATA\r\n--${boundary}--\r\n`;
    for (let i = 0; i < 2; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/upload',
        payload: body('../../evil/IMG 1.jpg'),
        headers: { ...h(), 'content-type': `multipart/form-data; boundary=${boundary}` },
      });
      expect(res.statusCode).toBe(200);
    }
    const dir = path.join(tmp, 'data', 'files', 'Images');
    expect(fs.readdirSync(dir).sort()).toEqual(['IMG 1 (1).jpg', 'IMG 1.jpg']);
    expect(fs.existsSync(path.join(tmp, 'evil'))).toBe(false);
  });

  it('saves notes as markdown', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/notes', payload: { title: 'Shopping', text: 'milk' }, headers: h() });
    expect(res.statusCode).toBe(200);
    const saved = path.join(tmp, 'data', res.json().saved);
    expect(fs.readFileSync(saved, 'utf8')).toBe('# Shopping\n\nmilk\n');
    expect(res.json().saved).toMatch(/^files\/Notes\//);
  });

  it('indexes files by category', async () => {
    const res = await app.inject({ url: '/api/files/summary', headers: h() });
    const cats = Object.fromEntries((res.json().categories as { key: string; count: number }[]).map((c) => [c.key, c.count]));
    expect(cats.images).toBe(2);
    expect(cats.documents).toBe(1);
    const list = await app.inject({ url: '/api/files/category/images', headers: h() });
    expect(list.json().total).toBe(2);
  });

  it('sanitises file names', () => {
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('..')).toBe('upload');
    expect(safeFileName('a\u0000b<c>.txt')).toBe('a_b_c_.txt');
  });
});

describe('integrations', () => {
  it('reports every optional plugin as off on a fresh install', async () => {
    const r = (await app.inject({ url: '/api/settings/integrations', headers: h() })).json() as { plugins: { id: string; enabled: boolean }[] };
    expect(r.plugins.map((p) => p.id)).toEqual(expect.arrayContaining(['assistant', 'telegram', 'botApi', 'whatsapp', 'erp', 'tradebot', 'services']));
    expect(r.plugins.filter((p) => p.enabled)).toEqual([]);
  });
});

describe('launcher', () => {
  it('lists services and persists order and opens', async () => {
    // Own services come from var/services.json; nothing is listed by default.
    expect(((await app.inject({ url: '/api/launcher', headers: h() })).json() as { key: string }[]).some((i) => i.key.startsWith('svc:'))).toBe(false);
    fs.writeFileSync(path.join(process.env.MANAR_DATA_DIR!, 'services.json'), JSON.stringify([
      { id: 'nova', title: 'Nova', url: 'https://box/', icon: 'svc:nova' },
      { id: 'infinity', title: 'Infinity', url: 'https://box:8444/', icon: 'svc:infinity' },
    ]));
    const list = (await app.inject({ url: '/api/launcher', headers: h() })).json() as { key: string }[];
    expect(list.map((i) => i.key)).toContain('svc:nova');
    const reversed = list.map((i) => i.key).reverse();
    await app.inject({ method: 'PUT', url: '/api/launcher/order', payload: { keys: reversed }, headers: h() });
    await app.inject({ method: 'POST', url: '/api/launcher/open', payload: { key: 'svc:infinity' }, headers: h() });
    const after = (await app.inject({ url: '/api/launcher', headers: h() })).json() as { key: string; opens: number }[];
    expect(after.map((i) => i.key)).toEqual(reversed);
    expect(after.find((i) => i.key === 'svc:infinity')?.opens).toBe(1);
    const home = (await app.inject({ url: '/api/home', headers: h() })).json();
    expect(home.frequent[0].key).toBe('svc:infinity');
  });
});

describe('power and notifications', () => {
  it('power actions require a fresh confirmation', async () => {
    const { getDb } = await import('../db.js');
    getDb().exec('UPDATE sessions SET elevated_until = 0');
    const res = await app.inject({ method: 'POST', url: '/api/power/reboot', payload: {}, headers: h() });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('confirm_required');
  });

  it('validates the WhatsApp number', async () => {
    const bad = await app.inject({ method: 'PUT', url: '/api/notify', payload: { push: true, whatsapp: { enabled: true, to: '12345' }, diskThreshold: 90 }, headers: h() });
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({ method: 'PUT', url: '/api/notify', payload: { push: true, whatsapp: { enabled: false, to: '' }, diskThreshold: 85 }, headers: h() });
    expect(ok.statusCode).toBe(200);
    const s = (await app.inject({ url: '/api/notify', headers: h() })).json();
    expect(s.settings.diskThreshold).toBe(85);
    expect(s.vapidPublicKey).toMatch(/^[A-Za-z0-9_-]{80,}$/);
  });
});

describe('desktop prefs', () => {
  it('stores a valid wallpaper and rejects anything else', async () => {
    const put = (body: unknown) => app.inject({ method: 'PUT', url: '/api/desktop/prefs', payload: body as object, headers: h() });
    expect((await put({ wallpaper: { kind: 'preset', id: 'aurora' } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/desktop/prefs', headers: h() })).json()).toEqual({ wallpaper: { kind: 'preset', id: 'aurora' } });
    expect((await put({ wallpaper: { kind: 'file', path: 'files/Images/a.jpg', extra: 'x' } })).json().wallpaper).toEqual({ kind: 'file', path: 'files/Images/a.jpg' });
    expect((await put({ wallpaper: { kind: 'url', id: 'javascript:alert(1)' } })).statusCode).toBe(400);
    // Widgets are saved alongside, without touching the wallpaper.
    expect((await put({ widgets: ['clock', 'system', 'clock'] })).json()).toEqual({ wallpaper: { kind: 'file', path: 'files/Images/a.jpg' }, widgets: ['clock', 'system'] });
    expect((await put({ widgets: ['<script>'] })).statusCode).toBe(400);
    expect((await put({ hidden: ['svc:nova'], pinned: ['files', 'app:browser'], order: ['craft:photocraft', 'files'] })).json()).toMatchObject({ hidden: ['svc:nova'], pinned: ['files', 'app:browser'] });
    expect((await put({ pinned: ['a b'] })).statusCode).toBe(400);
    expect((await put({ order: ['files', 'f:صور العيد 2026.jpg'] })).statusCode).toBe(200);
    expect((await put({ order: ['bad\nkey'] })).statusCode).toBe(400);
  });

  it('stores app folders: one folder per app, folders of one app dropped', async () => {
    const put = (body: unknown) => app.inject({ method: 'PUT', url: '/api/desktop/prefs', payload: body as object, headers: h() });
    const r = await put({
      groups: [
        { id: 'g1', name: 'التصميم', keys: ['craft:designcraft', 'craft:photocraft', 'craft:designcraft'] },
        { id: 'g2', name: 'x', keys: ['craft:photocraft', 'files'] },
      ],
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().groups).toEqual([{ id: 'g1', name: 'التصميم', keys: ['craft:designcraft', 'craft:photocraft'] }]);
    expect((await put({ groups: [{ id: 'bad id', name: 'a', keys: ['files', 'gallery'] }] })).statusCode).toBe(400);
    expect((await put({ groups: [{ id: 'g3', name: 'a', keys: ['a b', 'files'] }] })).statusCode).toBe(400);
    expect((await put({ groups: 'x' })).statusCode).toBe(400);
  });
});
