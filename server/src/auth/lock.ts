import type { FastifyInstance } from 'fastify';
import { audit, getDb } from '../db.js';
import { hashPassword, verifyPassword } from './crypto.js';
import { requireAuth, requireElevated, requireSession } from './sessions.js';

/**
 * Desktop lock screen. Locking marks the session; while locked every API call answers 423 until
 * the PIN is entered here (or the user signs out and in again). Setting the PIN needs a fresh
 * passkey/TOTP confirmation.
 */
const PIN_RE = /^\d{4,8}$/;
const unlockLimit = { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } };

const pinHash = (userId: number) => (getDb().prepare('SELECT pin_hash FROM users WHERE id = ?').get(userId) as { pin_hash: string | null } | undefined)?.pin_hash ?? null;
const setLocked = (sessionId: string, locked: boolean) => getDb().prepare('UPDATE sessions SET locked = ? WHERE id = ?').run(locked ? 1 : 0, sessionId);

export async function lockRoutes(app: FastifyInstance) {
  app.get('/api/lock', { preHandler: requireSession }, async (req) => ({ hasPin: !!pinHash(req.session!.userId), locked: req.session!.locked }));

  app.put<{ Body: { pin: string | null } }>('/api/lock/pin', { preHandler: requireElevated }, async (req, reply) => {
    const pin = req.body?.pin;
    if (pin !== null && (typeof pin !== 'string' || !PIN_RE.test(pin))) return reply.code(400).send({ error: 'bad_pin' });
    getDb().prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(pin === null ? null : await hashPassword(pin), req.session!.userId);
    audit(req.session!.userId, pin === null ? 'pin_removed' : 'pin_set');
    return { hasPin: pin !== null };
  });

  app.post('/api/lock', { preHandler: requireAuth }, async (req, reply) => {
    if (!pinHash(req.session!.userId)) return reply.code(409).send({ error: 'no_pin' });
    setLocked(req.session!.id, true);
    return { locked: true };
  });

  app.post<{ Body: { pin: string } }>('/api/lock/unlock', { preHandler: requireSession, ...unlockLimit }, async (req, reply) => {
    const stored = pinHash(req.session!.userId);
    const pin = req.body?.pin;
    if (!stored || typeof pin !== 'string' || !PIN_RE.test(pin) || !(await verifyPassword(pin, stored))) {
      audit(req.session!.userId, 'unlock_failed');
      return reply.code(403).send({ error: 'wrong_pin' });
    }
    setLocked(req.session!.id, false);
    return { locked: false };
  });
}
