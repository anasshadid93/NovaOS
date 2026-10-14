import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import crypto from 'node:crypto';
import { safeEqual } from './crypto.js';
import { userCount } from './users.js';

/**
 * First-run setup token. Written to var/setup-token (0600) while no user exists,
 * so only someone with shell access on the server can create the owner account.
 */
let token: string | null = null;

/** No 0/O, 1/I/L: easy to read off a terminal and type on a phone. */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

function newToken(): string {
  const groups: string[] = [];
  for (let g = 0; g < 4; g++) {
    let s = '';
    for (let i = 0; i < 4; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
    groups.push(s);
  }
  return groups.join('-'); // ~79 bits
}

/** Case-, space- and dash-insensitive comparison. */
function normalize(t: string): string {
  return t.toUpperCase().replace(/[\s-]/g, '');
}

function tokenFile() {
  return path.join(config.dataDir, 'setup-token');
}

export function ensureSetupToken(): string | null {
  if (userCount() > 0) {
    clearSetupToken();
    return null;
  }
  if (!token) {
    fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    const existing = fs.existsSync(tokenFile()) ? fs.readFileSync(tokenFile(), 'utf8').trim() : '';
    // Tokens from older versions used an ambiguous alphabet: replace them.
    token = /^[2-9A-HJKMNP-Z]{4}(-[2-9A-HJKMNP-Z]{4}){3}$/.test(existing) ? existing : newToken();
    fs.writeFileSync(tokenFile(), token + '\n', { mode: 0o600 });
  }
  return token;
}

export function checkSetupToken(candidate: unknown): boolean {
  return typeof candidate === 'string' && token !== null && safeEqual(normalize(candidate), normalize(token));
}

export function clearSetupToken(): void {
  token = null;
  fs.rmSync(tokenFile(), { force: true });
}
