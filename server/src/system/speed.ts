import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/sessions.js';

const execFileP = promisify(execFile);

/**
 * Network tools: tailscale ping to a device, the server's internet speed (Cloudflare's speed
 * endpoints), and a device ↔ server test (the browser downloads/uploads test data from here).
 */
const TS_IP = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/;
const CHUNK = crypto.randomBytes(1024 * 1024); // incompressible test data, reused

let internetRunning: Promise<unknown> | null = null;

async function timed(fn: () => Promise<number>): Promise<{ bytes: number; ms: number }> {
  const t = performance.now();
  const bytes = await fn();
  return { bytes, ms: performance.now() - t };
}

export async function internetSpeed() {
  const base = 'https://speed.cloudflare.com';
  // Latency: the fastest of a few tiny requests.
  let ping = Infinity;
  for (let i = 0; i < 5; i++) {
    const t = performance.now();
    await fetch(`${base}/__down?bytes=0`, { signal: AbortSignal.timeout(5000) }).then((r) => r.arrayBuffer());
    ping = Math.min(ping, performance.now() - t);
  }
  const down = await timed(async () => {
    const r = await fetch(`${base}/__down?bytes=50000000`, { signal: AbortSignal.timeout(30_000) });
    return (await r.arrayBuffer()).byteLength;
  });
  const body = Buffer.concat(Array.from({ length: 15 }, () => CHUNK));
  const up = await timed(async () => {
    await fetch(`${base}/__up`, { method: 'POST', body, signal: AbortSignal.timeout(30_000) }).then((r) => r.arrayBuffer());
    return body.byteLength;
  });
  return { ping: Math.round(ping), downMbps: +((down.bytes * 8) / down.ms / 1000).toFixed(1), upMbps: +((up.bytes * 8) / up.ms / 1000).toFixed(1), at: Date.now() };
}

export async function speedRoutes(app: FastifyInstance) {
  app.post<{ Body: { ip: string } }>('/api/tailscale/ping', { preHandler: requireAuth }, async (req, reply) => {
    const ip = req.body?.ip;
    if (typeof ip !== 'string' || !TS_IP.test(ip)) return reply.code(400).send({ error: 'bad_ip' });
    try {
      const { stdout } = await execFileP('tailscale', ['ping', '--c', '1', '--timeout', '5s', ip], { timeout: 8000 });
      // "pong from phone (100.x) via DERP(fra) in 45ms" or "… via 1.2.3.4:41641 in 3ms"
      const m = /via (\S+) in ([\d.]+)ms/.exec(stdout);
      return m ? { ms: Number(m[2]), via: m[1].startsWith('DERP') ? 'relay' : 'direct', path: m[1] } : reply.code(504).send({ error: 'no_pong' });
    } catch {
      return reply.code(504).send({ error: 'no_pong' });
    }
  });

  app.post('/api/speedtest/internet', { preHandler: requireAuth }, async (_req, reply) => {
    if (internetRunning) return reply.code(409).send({ error: 'busy' });
    internetRunning = internetSpeed();
    try {
      return await internetRunning;
    } catch {
      return reply.code(502).send({ error: 'unreachable' });
    } finally {
      internetRunning = null;
    }
  });

  // Device ↔ server: the browser times these.
  app.get<{ Querystring: { mb?: string } }>('/api/speedtest/down', { preHandler: requireAuth }, async (req, reply) => {
    const mb = Math.min(50, Math.max(1, Number(req.query.mb) || 10));
    reply.header('Content-Type', 'application/octet-stream').header('Cache-Control', 'no-store').header('Content-Length', String(mb * CHUNK.length));
    return reply.send(Buffer.concat(Array.from({ length: mb }, () => CHUNK)));
  });
  app.post('/api/speedtest/up', { preHandler: requireAuth, bodyLimit: 60 * 1024 * 1024 }, async (req) => ({ bytes: (req.body as Buffer | undefined)?.length ?? 0 }));
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 60 * 1024 * 1024 }, (_req, body, done) => done(null, body));
}
