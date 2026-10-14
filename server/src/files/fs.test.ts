import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticator } from 'otplib';
import type { FastifyInstance } from 'fastify';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'manar-fs-'));
const root = path.join(tmp, 'data');
fs.mkdirSync(path.join(root, 'Photos'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'secret'));
fs.writeFileSync(path.join(tmp, 'secret', 'passwd'), 'nope');
fs.symlinkSync(path.join(tmp, 'secret'), path.join(root, 'escape'));
fs.writeFileSync(path.join(root, 'notes.txt'), 'hello world');
fs.writeFileSync(path.join(root, 'page.html'), '<script>alert(1)</script>');
fs.writeFileSync(path.join(root, 'video.mp4'), Buffer.alloc(1000, 7));

process.env.MANAR_DATA_DIR = path.join(tmp, 'var');
process.env.MANAR_DATA_ROOT = root;
process.env.MANAR_APP_DATA_ROOT = path.join(root, 'apps');
process.env.MANAR_WEB_DIST = path.join(tmp, 'no-web');
process.env.MANAR_DEV = '1';

const { buildApp } = await import('../app.js');
const { ensureSetupToken } = await import('../auth/setup.js');
const { closeDb, getDb } = await import('../db.js');

const ORIGIN = 'http://localhost:5173';
let app: FastifyInstance;
let cookie = '';
const h = (extra: Record<string, string> = {}) => ({ origin: ORIGIN, cookie, ...extra });
const get = (url: string, headers: Record<string, string> = {}) => app.inject({ url, headers: h(headers) });
const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, payload: payload as object, headers: h() });

beforeAll(async () => {
  app = await buildApp({ logger: false });
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
  closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('confinement', () => {
  it.each(['../secret', '../../etc', 'escape', 'escape/passwd', '/../secret/passwd'])('refuses %s', async (p) => {
    const list = await get(`/api/fs/list?path=${encodeURIComponent(p)}`);
    const file = await get(`/api/fs/file?path=${encodeURIComponent(p)}`);
    expect([403, 404]).toContain(list.statusCode);
    expect([403, 404]).toContain(file.statusCode);
    expect(file.body).not.toContain('nope');
  });

  it('rejects names with slashes', async () => {
    expect((await post('/api/fs/mkdir', { path: '', name: '../x' })).statusCode).toBe(400);
    expect((await post('/api/fs/rename', { path: 'notes.txt', name: 'a/b' })).statusCode).toBe(400);
  });
});

describe('browse and edit', () => {
  it('lists folders first and hides the bin', async () => {
    const r = (await get('/api/fs/list?path=')).json();
    expect(r.entries.find((e: { name: string }) => e.name === 'Photos')).toMatchObject({ type: 'dir', items: 0 });
    expect(r.entries.find((e: { name: string }) => e.name === 'files')).toMatchObject({ type: 'dir' });
    expect(r.entries.map((e: { name: string }) => e.name)).not.toContain('.trash');
  });

  it('creates, renames, copies and moves', async () => {
    expect((await post('/api/fs/mkdir', { path: '', name: 'Docs' })).json().path).toBe('Docs');
    expect((await post('/api/fs/rename', { path: 'notes.txt', name: 'readme.txt' })).json().path).toBe('readme.txt');
    expect((await post('/api/fs/transfer', { paths: ['readme.txt'], dest: 'Docs', mode: 'copy' })).json().paths).toEqual(['Docs/readme.txt']);
    expect((await post('/api/fs/transfer', { paths: ['readme.txt'], dest: 'Docs', mode: 'move' })).json().paths).toEqual(['Docs/readme (1).txt']);
    expect((await post('/api/fs/transfer', { paths: ['Docs'], dest: 'Docs', mode: 'move' })).json().error).toBe('into_itself');
  });

  it('moves to the bin, restores, and purges only after confirmation', async () => {
    expect((await post('/api/fs/delete', { paths: ['Docs/readme.txt'] })).json().trashed).toBe(1);
    expect(fs.existsSync(path.join(root, 'Docs', 'readme.txt'))).toBe(false);
    const bin = (await get('/api/fs/trash')).json();
    expect(bin[0]).toMatchObject({ name: 'readme.txt', origPath: 'Docs/readme.txt' });
    expect((await post('/api/fs/trash/restore', { ids: [bin[0].id] })).json().restored).toBe(1);
    expect(fs.readFileSync(path.join(root, 'Docs', 'readme.txt'), 'utf8')).toBe('hello world');

    await post('/api/fs/delete', { paths: ['Docs/readme (1).txt'] });
    getDb().exec('UPDATE sessions SET elevated_until = 0');
    expect((await post('/api/fs/trash/purge', { all: true })).json().error).toBe('confirm_required');
    getDb().exec(`UPDATE sessions SET elevated_until = ${Date.now() + 60_000}`);
    expect((await post('/api/fs/trash/purge', { all: true })).json().purged).toBe(1);
    expect((await get('/api/fs/trash')).json()).toEqual([]);
  });
});

describe('serving files', () => {
  it('supports byte ranges for media', async () => {
    const r = await get('/api/fs/file?path=video.mp4', { range: 'bytes=100-199' });
    expect(r.statusCode).toBe(206);
    expect(r.headers['content-range']).toBe('bytes 100-199/1000');
    expect(r.rawPayload.length).toBe(100);
    expect(r.headers['content-type']).toBe('video/mp4');
  });

  it('never serves HTML inline', async () => {
    const r = await get('/api/fs/file?path=page.html');
    expect(r.headers['content-type']).toBe('application/octet-stream');
    expect(String(r.headers['content-disposition'])).toMatch(/^attachment/);
    expect(String(r.headers['content-security-policy'])).toContain('sandbox');
  });

  it('previews text', async () => {
    expect((await get('/api/fs/text?path=Docs/readme.txt')).json().text).toBe('hello world');
  });

  it('makes image thumbnails with ffmpeg', async () => {
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=800x600', '-frames:v', '1', path.join(root, 'Photos', 'blue.png')]);
    const r = await get('/api/fs/thumb?path=Photos/blue.png');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('image/jpeg');
    expect(r.rawPayload.subarray(0, 2).toString('hex')).toBe('ffd8');
  });

  it('sorts uploads made at the top level into files/<type>', async () => {
    const b = '----y';
    const body = (n: string) => `--${b}\r\nContent-Disposition: form-data; name="f"; filename="${n}"\r\n\r\nX\r\n`;
    const r = await app.inject({
      method: 'POST',
      url: '/api/fs/upload?path=',
      payload: body('trip.mp4') + body('backup.zip') + body('song.mp3') + `--${b}--\r\n`,
      headers: h({ 'content-type': `multipart/form-data; boundary=${b}` }),
    });
    expect(r.json().saved).toEqual(['files/Videos/trip.mp4', 'files/Zip/backup.zip', 'files/Audio/song.mp3']);
  });

  it('uploads into the current folder', async () => {
    const b = '----x';
    const r = await app.inject({
      method: 'POST',
      url: '/api/fs/upload?path=Photos',
      payload: `--${b}\r\nContent-Disposition: form-data; name="f"; filename="a.jpg"\r\nContent-Type: image/jpeg\r\n\r\nJPG\r\n--${b}--\r\n`,
      headers: h({ 'content-type': `multipart/form-data; boundary=${b}` }),
    });
    expect(r.json().saved).toEqual(['Photos/a.jpg']);
    expect(fs.existsSync(path.join(root, 'Photos', 'a.jpg'))).toBe(true);
  });
});

describe('text files', () => {
  it('creates new files without overwriting and saves existing ones', async () => {
    const a = await post('/api/fs/write', { dir: '', name: 'todo.txt', text: 'one' });
    expect(a.statusCode).toBe(200);
    const b = await post('/api/fs/write', { dir: '', name: 'todo.txt', text: 'two' });
    expect(b.json().path).toBe('todo (1).txt');
    expect((await post('/api/fs/write', { path: 'todo.txt', text: 'edited' })).statusCode).toBe(200);
    expect((await get('/api/fs/text?path=todo.txt')).json().text).toBe('edited');
  });
  it('stays inside the data root', async () => {
    expect((await post('/api/fs/write', { path: '../../etc/hostname', text: 'x' })).statusCode).not.toBe(200);
    expect((await post('/api/fs/write', { dir: '', name: '../escape.txt', text: 'x' })).statusCode).toBe(400);
  });
});

describe('content search', () => {
  it('finds text inside library files, case-insensitively', async () => {
    const { searchContent } = await import('./search.js');
    const dir = path.join(process.env.MANAR_DATA_ROOT!, 'files', 'Notes');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'trip.md'), '# Plans\nBook the Hotel in Salalah\n');
    const hits = await searchContent('hotel in salalah', path.join(process.env.MANAR_DATA_ROOT!, 'files'));
    expect(hits).toEqual([expect.objectContaining({ path: 'files/Notes/trip.md', line: 2 })]);
  });
});

describe('media', () => {
  it('turns SRT subtitles into WebVTT', async () => {
    const { srtToVtt } = await import('./media.js');
    expect(srtToVtt('1\r\n00:00:01,500 --> 00:00:03,000\r\nHello\r\n')).toBe('WEBVTT\n\n1\n00:00:01.500 --> 00:00:03.000\nHello\n');
  });
  it('remembers where a video stopped, and starts over once finished', async () => {
    await app.inject({ method: 'PUT', url: '/api/media/progress', payload: { path: 'files/Videos/a.mkv', position: 600, duration: 3600 }, headers: h() });
    expect((await get('/api/media/progress?path=files%2FVideos%2Fa.mkv')).json().position).toBe(600);
    await app.inject({ method: 'PUT', url: '/api/media/progress', payload: { path: 'files/Videos/a.mkv', position: 3550, duration: 3600 }, headers: h() });
    expect((await get('/api/media/progress?path=files%2FVideos%2Fa.mkv')).json().position).toBe(0);
  });
  it('keeps playlists', async () => {
    const r = await post('/api/music/playlists', { name: 'Drive', items: ['files/Audio/a.mp3'] });
    expect((await get('/api/music/playlists')).json()).toEqual([expect.objectContaining({ id: r.json().id, name: 'Drive', items: ['files/Audio/a.mp3'] })]);
  });
});
