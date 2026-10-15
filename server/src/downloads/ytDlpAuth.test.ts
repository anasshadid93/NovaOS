import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'manar-ytdlp-auth-'));
const profile = path.join(tmp, 'browser');
fs.mkdirSync(path.join(profile, 'Default'), { recursive: true });
const browserDb = new DatabaseSync(path.join(profile, 'Default', 'Cookies'));
browserDb.exec('CREATE TABLE cookies(host_key TEXT NOT NULL, name TEXT NOT NULL)');
browserDb.close();
process.env.MANAR_DATA_DIR = tmp;
process.env.MANAR_YTDLP_BROWSER_PROFILE = profile;
process.env.MANAR_YTDLP_BROWSER_URL = 'https://browser.example/';

const { deleteYtDlpCookies, saveYtDlpCookies, validateYtDlpCookies, ytDlpAuthArgs, ytDlpCookieStatus } = await import('./ytDlpAuth.js');

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('yt-dlp browser cookies', () => {
  it('rejects unrelated or malformed files', () => {
    expect(() => validateYtDlpCookies(Buffer.from('hello'))).toThrow('youtube_cookies_required');
    expect(() => validateYtDlpCookies(Buffer.from('.example.com\tTRUE\t/\tTRUE\t0\ta\tb\n'))).toThrow('youtube_cookies_required');
  });

  it('stores YouTube cookies privately and adds them to yt-dlp arguments', () => {
    const jar = Buffer.from('# Netscape HTTP Cookie File\n#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t2000000000\tSID\tsecret\n');
    expect(saveYtDlpCookies(jar).configured).toBe(true);
    const cookiePath = ytDlpAuthArgs()[1];
    expect(ytDlpAuthArgs()).toEqual(['--cookies', cookiePath]);
    expect(fs.statSync(cookiePath).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(cookiePath, 'utf8')).toContain('#HttpOnly_.youtube.com');
    expect(deleteYtDlpCookies()).toMatchObject({
      configured: false,
      updatedAt: null,
      browserAvailable: true,
    });
    expect(ytDlpCookieStatus().configured).toBe(false);
    expect(ytDlpAuthArgs()).toEqual(['--cookies-from-browser', `chromium:${profile}`]);
  });

  it('recognizes a signed-in persistent Chromium profile', () => {
    const db = new DatabaseSync(path.join(profile, 'Default', 'Cookies'));
    db.prepare('INSERT INTO cookies(host_key, name) VALUES(?, ?)').run('.google.com', 'SAPISID');
    db.close();
    expect(ytDlpCookieStatus()).toMatchObject({ configured: true, source: 'browser', browserAvailable: true, browserLoggedIn: true, browserUrl: 'https://browser.example/' });
  });
});
