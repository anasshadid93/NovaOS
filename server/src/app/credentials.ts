import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { requireElevated } from '../auth/sessions.js';
import { config } from '../config.js';

/** Settings → App passwords: the logins written when the apps were set up (var/apps-credentials.json). */
interface Cred {
  url?: string;
  username?: string;
  password?: string;
}

export function credentialList(raw: Record<string, Cred>) {
  return Object.entries(raw)
    .filter(([, c]) => c && typeof c === 'object' && c.password)
    .map(([app, c]) => ({ app, url: c.url ?? null, username: c.username ?? null, password: c.password! }))
    .sort((a, b) => a.app.localeCompare(b.app));
}

export async function credentialRoutes(app: FastifyInstance) {
  // Elevated: the person confirms (PIN / passkey) within the last 5 minutes before seeing passwords.
  app.get('/api/app-credentials', { preHandler: requireElevated }, async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    try {
      return { items: credentialList(JSON.parse(fs.readFileSync(path.join(config.dataDir, 'apps-credentials.json'), 'utf8'))) };
    } catch {
      return { items: [] };
    }
  });
}
