import { getDb } from '../db.js';

export interface UserRow {
  id: number;
  username: string;
  pw_hash: string;
  totp_secret: string;
  totp_last_step: number;
}

export interface CredentialRow {
  id: string;
  user_id: number;
  public_key: Uint8Array;
  counter: number;
  transports: string | null;
  name: string;
  created_at: number;
  last_used_at: number | null;
}

export function userCount(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
}

export function findUserByName(username: string): UserRow | undefined {
  return getDb().prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
}

export function findUserById(id: number): UserRow | undefined {
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
}

export function createUser(username: string, pwHash: string, totpSecret: string, totpStep: number): number {
  const res = getDb()
    .prepare('INSERT INTO users(username, pw_hash, totp_secret, totp_last_step, created_at) VALUES(?, ?, ?, ?, ?)')
    .run(username, pwHash, totpSecret, totpStep, Date.now());
  return Number(res.lastInsertRowid);
}

/** Atomically records a TOTP step; false if it was already used (replay). */
export function consumeTotpStep(userId: number, step: number): boolean {
  return (
    getDb().prepare('UPDATE users SET totp_last_step = ? WHERE id = ? AND totp_last_step < ?').run(step, userId, step).changes > 0
  );
}

export function listCredentials(userId: number): CredentialRow[] {
  return getDb().prepare('SELECT * FROM credentials WHERE user_id = ? ORDER BY created_at').all(userId) as unknown as CredentialRow[];
}

export function findCredential(id: string): CredentialRow | undefined {
  return getDb().prepare('SELECT * FROM credentials WHERE id = ?').get(id) as CredentialRow | undefined;
}

export function addCredential(c: { id: string; userId: number; publicKey: Uint8Array; counter: number; transports?: string[]; name: string }) {
  getDb()
    .prepare('INSERT INTO credentials(id, user_id, public_key, counter, transports, name, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)')
    .run(c.id, c.userId, c.publicKey, c.counter, c.transports ? JSON.stringify(c.transports) : null, c.name, Date.now());
}

export function touchCredential(id: string, counter: number) {
  getDb().prepare('UPDATE credentials SET counter = ?, last_used_at = ? WHERE id = ?').run(counter, Date.now(), id);
}

export function deleteCredential(userId: number, id: string): boolean {
  return getDb().prepare('DELETE FROM credentials WHERE user_id = ? AND id = ?').run(userId, id).changes > 0;
}
