import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'manar-dl-'));
process.env.MANAR_DATA_DIR = path.join(tmp, 'var');
process.env.MANAR_DATA_ROOT = path.join(tmp, 'data');
process.env.MANAR_YTDLP = '/bin/false';
fs.mkdirSync(path.join(tmp, 'data'));

const { checkUrl, ytDlpArgs, hookSecret } = await import('./downloads.js');
const { buildBotServer, rotateBotToken } = await import('../bot/bot.js');
const { closeDb } = await import('../db.js');
afterAll(() => {
  closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('downloads', () => {
  it('only accepts public http(s) URLs', async () => {
    for (const u of ['http://127.0.0.1:7470/', 'http://localhost/x', 'http://172.17.0.1:7478/status', 'http://100.64.0.5/', 'file:///etc/passwd', 'ftp://example.com/a', 'notaurl', 'http://u:p@1.1.1.1/']) {
      await expect(checkUrl(u), u).rejects.toThrow(/blocked_address|bad_url|unknown_host/);
    }
    expect((await checkUrl('https://1.1.1.1/video')).hostname).toBe('1.1.1.1');
  });
  it('builds safe yt-dlp arguments', () => {
    const v = ytDlpArgs('https://example.com/v?a=1', false, '/srv/data/files/Downloads');
    expect(v.at(-2)).toBe('--');
    expect(v.at(-1)).toBe('https://example.com/v?a=1');
    expect(v).toContain('--no-playlist');
    expect(v.join(' ')).toContain('--merge-output-format mp4');
    expect(ytDlpArgs('https://x.y/', true, '/d').join(' ')).toContain('-x --audio-format mp3');
  });
  it('the hook secret is stable', () => {
    expect(hookSecret()).toBe(hookSecret());
    expect(hookSecret()).toMatch(/^[\w-]{32}$/);
  });
  it('bot API: POST /download needs the token and rejects internal URLs', async () => {
    const bot = await buildBotServer();
    const token = rotateBotToken();
    const h = { authorization: `Bearer ${token}` };
    expect((await bot.inject({ method: 'POST', url: '/download', payload: { url: 'https://1.1.1.1/v' } })).statusCode).toBe(401);
    const bad = await bot.inject({ method: 'POST', url: '/download', payload: { url: 'http://127.0.0.1:7470/' }, headers: h });
    expect(bad.statusCode).toBe(422);
    const ok = await bot.inject({ method: 'POST', url: '/download', payload: { url: 'https://1.1.1.1/v', audio: true }, headers: h });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ audio: true, url: 'https://1.1.1.1/v' });
    expect((await bot.inject({ url: `/downloads/${ok.json().id}`, headers: h })).json().id).toBe(ok.json().id);
    await bot.close();
  });
});
