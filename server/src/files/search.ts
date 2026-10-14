import { execFile } from 'node:child_process';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { requireAuth } from '../auth/sessions.js';

/**
 * Spotlight "inside files": text matches in the library (files/…) with grep — notes, text,
 * markdown, CSV, code. Binary files (PDF, Office, media) are skipped (-I).
 */
export interface ContentHit {
  path: string;
  line: number;
  text: string;
}

export function searchContent(q: string, root = path.join(config.dataRoot, 'files'), limit = 30): Promise<ContentHit[]> {
  return new Promise((resolve) => {
    // -I skips binary files, -F literal text, -m 1 first match per file, -Z NUL after the path.
    const args = ['-rInIZ', '-F', '-i', '-m', '1', '--exclude-dir=node_modules', '--exclude-dir=.git', '--', q, root];
    execFile('grep', args, { timeout: 4000, maxBuffer: 8 * 1024 * 1024 }, (_err, stdout) => {
      const hits: ContentHit[] = [];
      for (const rec of String(stdout ?? '').split('\n')) {
        if (hits.length >= limit) break;
        const nul = rec.indexOf('\0');
        if (nul < 0) continue;
        const rest = rec.slice(nul + 1);
        const colon = rest.indexOf(':');
        const line = Number(rest.slice(0, colon));
        if (!Number.isFinite(line)) continue;
        hits.push({ path: path.relative(config.dataRoot, rec.slice(0, nul)), line, text: rest.slice(colon + 1).trim().slice(0, 200) });
      }
      // grep exits 1 for "no matches" and may be stopped by the timeout: whatever was found is the answer.
      resolve(hits);
    });
  });
}

export async function searchRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { q?: string } }>('/api/search/content', { preHandler: requireAuth }, async (req) => {
    const q = String(req.query.q ?? '').trim();
    if (q.length < 3 || q.length > 100) return { hits: [] };
    return { hits: await searchContent(q) };
  });
}
