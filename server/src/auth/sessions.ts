import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { getDb } from '../db.js';
import { randomToken, sha256 } from './crypto.js';

export type AuthMethod = 'passkey' | 'password';

export interface Session {
  id: string;
  userId: number;
  username: string;
  method: AuthMethod;
  elevatedUntil: number;
  /** Lock screen is up: everything but unlocking is refused (423). */
  locked: boolean;
}

/** How long a step-up confirmation unlocks dangerous actions. */
export const ELEVATION_MS = 5 * 60 * 1000;
const TOUCH_INTERVAL_MS = 60 * 1000;

declare module 'fastify' {
  interface FastifyRequest {
    session: Session | null;
  }
}

export function createSession(reply: FastifyReply, userId: number, method: AuthMethod, userAgent?: string): void {
  const token = randomToken();
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO sessions(id, user_id, method, user_agent, created_at, last_seen_at, expires_at, elevated_until)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    // A fresh login counts as a confirmation.
    .run(sha256(token), userId, method, userAgent?.slice(0, 200) ?? null, now, now, now + config.sessionTtlMs, now + ELEVATION_MS);
  reply.setCookie(config.sessionCookie, token, {
    path: '/',
    httpOnly: true,
    secure: !config.dev,
    sameSite: 'strict',
    maxAge: Math.floor(config.sessionTtlMs / 1000),
  });
}

export function loadSession(req: FastifyRequest): Session | null {
  const token = req.cookies[config.sessionCookie];
  if (!token) return null;
  const id = sha256(token);
  const row = getDb()
    .prepare(
      `SELECT s.id, s.user_id, s.method, s.expires_at, s.last_seen_at, s.elevated_until, s.locked, u.username
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
    )
    .get(id) as
    | { id: string; user_id: number; method: AuthMethod; expires_at: number; last_seen_at: number; elevated_until: number; locked: number; username: string }
    | undefined;
  if (!row) return null;
  const now = Date.now();
  if (row.expires_at < now) {
    getDb().prepare('DELETE FROM sessions WHERE id = ?').run(id);
    return null;
  }
  if (now - row.last_seen_at > TOUCH_INTERVAL_MS) {
    getDb().prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(now, id);
  }
  return { id: row.id, userId: row.user_id, username: row.username, method: row.method, elevatedUntil: row.elevated_until, locked: !!row.locked };
}

export function elevateSession(session: Session): number {
  const until = Date.now() + ELEVATION_MS;
  getDb().prepare('UPDATE sessions SET elevated_until = ? WHERE id = ?').run(until, session.id);
  session.elevatedUntil = until;
  return until;
}

export function destroySession(reply: FastifyReply, session: Session | null): void {
  if (session) getDb().prepare('DELETE FROM sessions WHERE id = ?').run(session.id);
  reply.clearCookie(config.sessionCookie, { path: '/' });
}

export function listSessions(userId: number) {
  return getDb()
    .prepare(
      `SELECT id, method, user_agent AS userAgent, created_at AS createdAt, last_seen_at AS lastSeenAt
       FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC`,
    )
    .all(userId, Date.now());
}

export function revokeSession(userId: number, id: string): boolean {
  return getDb().prepare('DELETE FROM sessions WHERE user_id = ? AND id = ?').run(userId, id).changes > 0;
}

export function pruneSessions(): void {
  getDb().prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}

/** preHandler: 401 unless logged in. */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  if (!req.session) return reply.code(401).send({ error: 'unauthorized' });
  if (req.session.locked) return reply.code(423).send({ error: 'locked' });
}

/** preHandler: logged in, even while the lock screen is up (lock state, unlock, sign out). */
export async function requireSession(req: FastifyRequest, reply: FastifyReply) {
  if (!req.session) return reply.code(401).send({ error: 'unauthorized' });
}

/** preHandler: 403 `confirm_required` unless the session was confirmed in the last 5 minutes. */
export async function requireElevated(req: FastifyRequest, reply: FastifyReply) {
  if (!req.session) return reply.code(401).send({ error: 'unauthorized' });
  if (req.session.locked) return reply.code(423).send({ error: 'locked' });
  if (req.session.elevatedUntil < Date.now()) return reply.code(403).send({ error: 'confirm_required' });
}
