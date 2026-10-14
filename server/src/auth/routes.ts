import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import QRCode from 'qrcode';
import { allowedOrigins, config } from '../config.js';
import { audit } from '../db.js';
import { hashPassword, verifyPassword } from './crypto.js';
import {
  createSession,
  destroySession,
  elevateSession,
  listSessions,
  requireAuth,
  requireElevated,
  revokeSession,
} from './sessions.js';
import { checkSetupToken, clearSetupToken } from './setup.js';
import { newTotpSecret, totpUri, verifyTotp } from './totp.js';
import {
  addCredential,
  consumeTotpStep,
  createUser,
  deleteCredential,
  findCredential,
  findUserById,
  findUserByName,
  listCredentials,
  touchCredential,
  userCount,
  type UserRow,
} from './users.js';

/** One-shot WebAuthn challenges, valid for 5 minutes. */
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const challenges = new Map<string, { purpose: string; userId?: number; expires: number }>();

function rememberChallenge(challenge: string, purpose: string, userId?: number) {
  const now = Date.now();
  for (const [k, v] of challenges) if (v.expires < now) challenges.delete(k);
  if (challenges.size > 200) challenges.clear();
  challenges.set(challenge, { purpose, userId, expires: now + CHALLENGE_TTL_MS });
}

function takeChallenge(purpose: string, userId?: number) {
  return (challenge: string) => {
    const entry = challenges.get(challenge);
    challenges.delete(challenge);
    return !!entry && entry.purpose === purpose && entry.expires > Date.now() && (userId === undefined || entry.userId === userId);
  };
}

/** Pending setup: TOTP secret generated in step 1, confirmed in step 2. */
let pendingSetupSecret: string | null = null;

const USERNAME_RE = /^[a-z][a-z0-9_.-]{1,31}$/;
const authLimit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

async function checkTotp(user: UserRow, code: unknown): Promise<boolean> {
  if (typeof code !== 'string') return false;
  const step = verifyTotp(code.trim(), user.totp_secret);
  return step !== null && consumeTotpStep(user.id, step);
}

export async function authRoutes(app: FastifyInstance) {
  const origins = allowedOrigins();

  app.get('/api/auth/state', async (req) => {
    const s = req.session;
    return {
      setupRequired: userCount() === 0,
      user: s ? { name: s.username, method: s.method, elevatedUntil: s.elevatedUntil, locked: s.locked } : null,
      passkeys: s ? listCredentials(s.userId).length : undefined,
    };
  });

  // ---- First-run setup -------------------------------------------------
  app.post<{ Body: { token: string } }>('/api/setup/start', authLimit, async (req, reply) => {
    if (userCount() > 0) return reply.code(409).send({ error: 'already_setup' });
    if (!checkSetupToken(req.body?.token)) return reply.code(403).send({ error: 'bad_token' });
    pendingSetupSecret = newTotpSecret();
    const uri = totpUri('owner', pendingSetupSecret);
    const qrSvg = await QRCode.toString(uri, { type: 'svg', margin: 1 });
    return { secret: pendingSetupSecret, uri, qrSvg };
  });

  app.post<{ Body: { token: string; username: string; password: string; code: string } }>(
    '/api/setup/finish',
    authLimit,
    async (req, reply) => {
      const { token, username, password, code } = req.body ?? ({} as never);
      if (userCount() > 0) return reply.code(409).send({ error: 'already_setup' });
      if (!checkSetupToken(token) || !pendingSetupSecret) return reply.code(403).send({ error: 'bad_token' });
      if (typeof username !== 'string' || !USERNAME_RE.test(username)) return reply.code(400).send({ error: 'bad_username' });
      if (typeof password !== 'string' || password.length < 12 || password.length > 256)
        return reply.code(400).send({ error: 'weak_password' });
      const step = typeof code === 'string' ? verifyTotp(code.trim(), pendingSetupSecret) : null;
      if (step === null) return reply.code(400).send({ error: 'bad_code' });
      const userId = createUser(username, await hashPassword(password), pendingSetupSecret, step);
      pendingSetupSecret = null;
      clearSetupToken();
      audit(userId, 'setup');
      createSession(reply, userId, 'password', req.headers['user-agent']);
      return { ok: true };
    },
  );

  // ---- Password + TOTP (fallback) ---------------------------------------
  app.post<{ Body: { username: string; password: string; code: string } }>('/api/auth/password', authLimit, async (req, reply) => {
    const { username, password, code } = req.body ?? ({} as never);
    const user = typeof username === 'string' ? findUserByName(username) : undefined;
    // Always run the hash to keep timing uniform for unknown users.
    const pwOk = await verifyPassword(String(password ?? ''), user?.pw_hash ?? DUMMY_HASH);
    if (!user || !pwOk || !(await checkTotp(user, code))) {
      audit(user?.id ?? null, 'login_failed', { method: 'password', ip: req.ip });
      return reply.code(401).send({ error: 'invalid_credentials' });
    }
    audit(user.id, 'login', { method: 'password', ip: req.ip });
    createSession(reply, user.id, 'password', req.headers['user-agent']);
    return { ok: true };
  });

  // ---- Passkey login ----------------------------------------------------
  app.post('/api/auth/passkey/options', authLimit, async () => {
    const options = await generateAuthenticationOptions({ rpID: config.rpId, userVerification: 'required' });
    rememberChallenge(options.challenge, 'login');
    return options;
  });

  app.post<{ Body: { response: AuthenticationResponseJSON } }>('/api/auth/passkey/verify', authLimit, async (req, reply) => {
    const response = req.body?.response;
    const cred = response?.id ? findCredential(response.id) : undefined;
    if (!cred) return reply.code(401).send({ error: 'unknown_passkey' });
    try {
      const result = await verifyAuthenticationResponse({
        response,
        expectedChallenge: takeChallenge('login'),
        expectedOrigin: origins,
        expectedRPID: config.rpId,
        credential: credentialFor(cred),
        requireUserVerification: true,
      });
      if (!result.verified) throw new Error('not verified');
      touchCredential(cred.id, result.authenticationInfo.newCounter);
    } catch (err) {
      audit(cred.user_id, 'login_failed', { method: 'passkey', ip: req.ip, err: String(err) });
      return reply.code(401).send({ error: 'passkey_failed' });
    }
    audit(cred.user_id, 'login', { method: 'passkey', ip: req.ip });
    createSession(reply, cred.user_id, 'passkey', req.headers['user-agent']);
    return { ok: true };
  });

  // ---- Step-up confirmation for dangerous actions ------------------------
  app.post('/api/auth/confirm/options', { preHandler: requireAuth, ...authLimit }, async (req) => {
    const userId = req.session!.userId;
    const creds = listCredentials(userId);
    if (creds.length === 0) return { passkey: null };
    const options = await generateAuthenticationOptions({
      rpID: config.rpId,
      userVerification: 'required',
      allowCredentials: creds.map((c) => ({ id: c.id, transports: parseTransports(c.transports) })),
    });
    rememberChallenge(options.challenge, 'confirm', userId);
    return { passkey: options };
  });

  app.post<{ Body: { response?: AuthenticationResponseJSON; code?: string } }>(
    '/api/auth/confirm',
    { preHandler: requireAuth, ...authLimit },
    async (req, reply) => {
      const session = req.session!;
      const { response, code } = req.body ?? {};
      if (response) {
        const cred = findCredential(response.id);
        if (!cred || cred.user_id !== session.userId) return reply.code(401).send({ error: 'unknown_passkey' });
        try {
          const result = await verifyAuthenticationResponse({
            response,
            expectedChallenge: takeChallenge('confirm', session.userId),
            expectedOrigin: origins,
            expectedRPID: config.rpId,
            credential: credentialFor(cred),
            requireUserVerification: true,
          });
          if (!result.verified) throw new Error('not verified');
          touchCredential(cred.id, result.authenticationInfo.newCounter);
        } catch {
          return reply.code(401).send({ error: 'passkey_failed' });
        }
      } else {
        const user = findUserById(session.userId);
        if (!user || !(await checkTotp(user, code))) return reply.code(401).send({ error: 'bad_code' });
      }
      const until = elevateSession(session);
      audit(session.userId, 'confirm', { method: response ? 'passkey' : 'totp' });
      return { elevatedUntil: until };
    },
  );

  // ---- Passkey management -----------------------------------------------
  app.post('/api/auth/passkeys/options', { preHandler: requireElevated }, async (req) => {
    const s = req.session!;
    const existing = listCredentials(s.userId);
    const options = await generateRegistrationOptions({
      rpName: config.rpName,
      rpID: config.rpId,
      userName: s.username,
      userID: new TextEncoder().encode(`manar-user-${s.userId}`),
      attestationType: 'none',
      excludeCredentials: existing.map((c) => ({ id: c.id, transports: parseTransports(c.transports) })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    rememberChallenge(options.challenge, 'register', s.userId);
    return options;
  });

  app.post<{ Body: { response: RegistrationResponseJSON; name?: string } }>(
    '/api/auth/passkeys',
    { preHandler: requireElevated },
    async (req, reply) => {
      const s = req.session!;
      try {
        const result = await verifyRegistrationResponse({
          response: req.body?.response,
          expectedChallenge: takeChallenge('register', s.userId),
          expectedOrigin: origins,
          expectedRPID: config.rpId,
          requireUserVerification: true,
        });
        if (!result.verified) throw new Error('not verified');
        const { credential } = result.registrationInfo;
        const name = String(req.body?.name ?? '').trim().slice(0, 60) || 'Passkey';
        addCredential({
          id: credential.id,
          userId: s.userId,
          publicKey: credential.publicKey,
          counter: credential.counter,
          transports: credential.transports,
          name,
        });
        audit(s.userId, 'passkey_added', { name });
        return { ok: true };
      } catch (err) {
        req.log.warn({ err }, 'passkey registration failed');
        return reply.code(400).send({ error: 'registration_failed' });
      }
    },
  );

  app.get('/api/auth/passkeys', { preHandler: requireAuth }, async (req) =>
    listCredentials(req.session!.userId).map((c) => ({
      id: c.id,
      name: c.name,
      createdAt: c.created_at,
      lastUsedAt: c.last_used_at,
    })),
  );

  app.delete<{ Params: { id: string } }>('/api/auth/passkeys/:id', { preHandler: requireElevated }, async (req, reply) => {
    if (!deleteCredential(req.session!.userId, req.params.id)) return reply.code(404).send({ error: 'not_found' });
    audit(req.session!.userId, 'passkey_removed', { id: req.params.id });
    return { ok: true };
  });

  // ---- Sessions ---------------------------------------------------------
  app.get('/api/auth/sessions', { preHandler: requireAuth }, async (req) =>
    listSessions(req.session!.userId).map((s) => ({ ...(s as object), current: (s as { id: string }).id === req.session!.id })),
  );

  app.delete<{ Params: { id: string } }>('/api/auth/sessions/:id', { preHandler: requireElevated }, async (req, reply) => {
    if (!revokeSession(req.session!.userId, req.params.id)) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req: FastifyRequest, reply) => {
    destroySession(reply, req.session);
    return { ok: true };
  });

}

function parseTransports(raw: string | null) {
  return raw ? (JSON.parse(raw) as never[]) : undefined;
}

function credentialFor(c: { id: string; public_key: Uint8Array; counter: number; transports: string | null }) {
  return { id: c.id, publicKey: new Uint8Array(c.public_key), counter: c.counter, transports: parseTransports(c.transports) };
}

// scrypt hash of a random throwaway string; only used to equalise timing.
const DUMMY_HASH = 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
