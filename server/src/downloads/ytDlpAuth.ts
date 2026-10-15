import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';

const MAX_COOKIE_BYTES = 2 * 1024 * 1024;

export function ytDlpAuthArgs(): string[] {
  try {
    const stat = fs.statSync(config.ytDlpCookies);
    if (stat.isFile() && stat.size > 0) return ['--cookies', config.ytDlpCookies];
  } catch {
    /* fall through to the persistent browser profile */
  }
  const db = path.join(config.ytDlpBrowserProfile, 'Default', 'Cookies');
  return config.ytDlpBrowserProfile && fs.existsSync(db) ? ['--cookies-from-browser', `chromium:${config.ytDlpBrowserProfile}`] : [];
}

export function ytDlpCookieStatus() {
  let fileUpdatedAt: number | null = null;
  try {
    const stat = fs.statSync(config.ytDlpCookies);
    if (stat.isFile() && stat.size > 0) fileUpdatedAt = stat.mtimeMs;
  } catch {
    /* no uploaded fallback */
  }

  const cookieDb = path.join(config.ytDlpBrowserProfile, 'Default', 'Cookies');
  let browserAvailable = false;
  let browserLoggedIn = false;
  try {
    browserAvailable = !!config.ytDlpBrowserProfile && fs.statSync(cookieDb).isFile();
    if (browserAvailable) {
      const db = new DatabaseSync(cookieDb, { readOnly: true });
      try {
        const row = db
          .prepare(
            `SELECT COUNT(*) AS n FROM cookies
          WHERE (host_key LIKE '%.youtube.com' OR host_key LIKE '%.google.com')
          AND name IN ('SID', 'SSID', 'SAPISID', '__Secure-1PSID', '__Secure-3PSID', 'LOGIN_INFO')`,
          )
          .get() as { n: number };
        browserLoggedIn = Number(row.n) > 0;
      } finally {
        db.close();
      }
    }
  } catch {
    /* browser may be writing the cookie DB; the next status poll retries */
  }

  return {
    configured: fileUpdatedAt !== null || browserLoggedIn,
    source: fileUpdatedAt !== null ? 'file' : browserLoggedIn ? 'browser' : null,
    updatedAt: fileUpdatedAt,
    browserAvailable,
    browserLoggedIn,
    browserUrl: config.ytDlpBrowserUrl || null,
  };
}

/** Validate a browser-exported Netscape cookie jar without ever returning or logging its contents. */
export function validateYtDlpCookies(data: Buffer): string {
  if (!data.length || data.length > MAX_COOKIE_BYTES) throw new Error('invalid_cookie_file');
  const text = data
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n');
  if (text.includes('\0')) throw new Error('invalid_cookie_file');
  const rows = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && (!line.startsWith('#') || line.startsWith('#HttpOnly_')));
  const validRows = rows.filter((line) => line.replace(/^#HttpOnly_/, '').split('\t').length >= 7);
  if (!validRows.length || !validRows.some((line) => /(?:^|\.)youtube\.com\t/i.test(line.replace(/^#HttpOnly_/, '')) || /(?:^|\.)google\.com\t/i.test(line.replace(/^#HttpOnly_/, '')))) {
    throw new Error('youtube_cookies_required');
  }
  return `# Netscape HTTP Cookie File\n${validRows.join('\n')}\n`;
}

export function saveYtDlpCookies(data: Buffer) {
  const text = validateYtDlpCookies(data);
  fs.mkdirSync(path.dirname(config.ytDlpCookies), {
    recursive: true,
    mode: 0o700,
  });
  const temp = `${config.ytDlpCookies}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temp, text, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, config.ytDlpCookies);
    fs.chmodSync(config.ytDlpCookies, 0o600);
  } finally {
    fs.rmSync(temp, { force: true });
  }
  return ytDlpCookieStatus();
}

export function deleteYtDlpCookies() {
  fs.rmSync(config.ytDlpCookies, { force: true });
  return ytDlpCookieStatus();
}
