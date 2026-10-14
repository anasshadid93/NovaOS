import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { spawn, type IPty } from 'node-pty';
import { config } from '../config.js';
import { audit } from '../db.js';
import { requireAuth, requireElevated } from '../auth/sessions.js';

/**
 * Desktop terminal. A real shell on the server as anas — who has sudo — so it is guarded twice:
 *  1. POST /api/terminal/ticket needs a fresh passkey/TOTP confirmation (step-up) and returns a
 *     one-time ticket valid for 30 s;
 *  2. the WebSocket (same-origin, checked in app.ts) must present that ticket and a session.
 * The shell is started by the root helper as its own systemd unit, outside manar.service's
 * sandbox and memory limit, then drops to anas (`runuser -l anas`).
 */

const TICKET_MS = 30_000;
const MAX_TERMINALS = 6;
const tickets = new Map<string, { userId: number; sessionId: string; exp: number }>();
let open = 0;

/** Command that starts the shell. Dev/tests use a plain bash. */
function shellCommand(): [string, string[]] {
  if (process.env.MANAR_SHELL) return [process.env.MANAR_SHELL, ['-l']];
  return ['sudo', ['-n', config.helperPath, 'shell']];
}

export async function terminalRoutes(app: FastifyInstance) {
  app.post('/api/terminal/ticket', { preHandler: requireElevated }, async (req, reply) => {
    if (open >= MAX_TERMINALS) return reply.code(429).send({ error: 'too_many_terminals' });
    for (const [k, v] of tickets) if (v.exp < Date.now()) tickets.delete(k);
    const ticket = crypto.randomBytes(24).toString('base64url');
    tickets.set(ticket, { userId: req.session!.userId, sessionId: req.session!.id, exp: Date.now() + TICKET_MS });
    return { ticket };
  });

  app.get<{ Querystring: { t?: string; cols?: string; rows?: string } }>('/api/terminal', { websocket: true, preHandler: requireAuth }, (socket: WebSocket, req) => {
    const t = tickets.get(req.query.t ?? '');
    tickets.delete(req.query.t ?? '');
    if (!t || t.exp < Date.now() || t.sessionId !== req.session?.id || open >= MAX_TERMINALS) {
      socket.close(4403, 'ticket');
      return;
    }
    const clamp = (v: string | undefined, d: number, max: number) => Math.min(max, Math.max(10, Number(v) || d));
    let pty: IPty;
    try {
      const [cmd, args] = shellCommand();
      pty = spawn(cmd, args, {
        name: 'xterm-256color',
        cols: clamp(req.query.cols, 100, 500),
        rows: clamp(req.query.rows, 30, 200),
        cwd: process.env.HOME ?? '/',
        env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<string, string>,
      });
    } catch (err) {
      req.log.error({ err }, 'terminal spawn failed');
      socket.close(4500, 'spawn');
      return;
    }
    open++;
    const started = Date.now();
    audit(t.userId, 'terminal_open', { pid: pty.pid });

    pty.onData((d) => {
      if (socket.readyState === socket.OPEN) socket.send(d);
      // Back-pressure: pause the shell while the browser catches up.
      if (socket.bufferedAmount > 1024 * 1024) {
        pty.pause();
        const resume = setInterval(() => {
          if (socket.readyState !== socket.OPEN || socket.bufferedAmount < 256 * 1024) {
            clearInterval(resume);
            pty.resume();
          }
        }, 50);
      }
    });
    pty.onExit(({ exitCode }) => {
      if (socket.readyState === socket.OPEN) socket.close(1000, `exit ${exitCode}`);
    });

    socket.on('message', (raw: Buffer) => {
      let msg: { type?: string; data?: unknown; cols?: unknown; rows?: unknown };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === 'in' && typeof msg.data === 'string' && msg.data.length <= 64 * 1024) pty.write(msg.data);
      else if (msg.type === 'resize' && Number.isInteger(msg.cols) && Number.isInteger(msg.rows)) pty.resize(clamp(String(msg.cols), 100, 500), clamp(String(msg.rows), 30, 200));
    });
    socket.on('close', () => {
      open--;
      try {
        pty.kill('SIGHUP');
      } catch {
        /* already gone */
      }
      audit(t.userId, 'terminal_close', { seconds: Math.round((Date.now() - started) / 1000) });
    });
  });
}
