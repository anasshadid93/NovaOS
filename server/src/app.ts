import { downloadsRoutes } from './bot/downloadsRoutes.js';
import { backupRoutes } from './backup/routes.js';
import { gamesRoutes } from './games/games.js';
import { launchRoutes } from './games/launch.js';
import { previewRoutes } from './files/preview.js';
import { dropRoutes } from './share/dropbox.js';
import { watchRoutes } from './watch/watch.js';
import { healthRoutes } from './health/health.js';
import { networkRoutes, startNetworkLoop } from './network/network.js';
import { mobileRoutes } from './app/mobile.js';
import { credentialRoutes } from './app/credentials.js';
import { extractRoutes } from './files/extract.js';
import { startBackupLoop } from './backup/backup.js';
import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';
import { allowedOrigins, config } from './config.js';
import { authRoutes } from './auth/routes.js';
import { wizardRoutes } from './setup/wizard.js';
import { pluginRoutes } from './plugins.js';
import { selfUpdateRoutes } from './system/selfupdate.js';
import { pricesRoutes, startPricesLoop } from './prices/prices.js';
import { metricsRoutes } from './metrics/routes.js';
import { storeRoutes } from './store/routes.js';
import { systemRoutes } from './system/routes.js';
import { fileRoutes } from './files/routes.js';
import { dockerManageRoutes } from './docker/manage.js';
import { volumeRoutes } from './files/volumes.js';
import { craftRoutes } from './craft/craft.js';
import { terminalRoutes } from './terminal/terminal.js';
import { lockRoutes } from './auth/lock.js';
import { diskHealthRoutes } from './smart/health.js';
import { searchRoutes } from './files/search.js';
import { speedRoutes } from './system/speed.js';
import { updateRoutes } from './system/updates.js';
import { mediaRoutes } from './files/media.js';
import { shareRoutes } from './share/share.js';
import { botRoutes } from './bot/bot.js';
import { downloadRoutes } from './downloads/downloads.js';
import { videoDownloadRoutes } from './downloads/videoDownloads.js';
import { galleryRoutes } from './files/gallery.js';
import { voiceRoutes } from './voice/voice.js';
import { startTradeBot } from './tradebot/engine.js';
import './store/installer.js';
import { recoverTasks } from './tasks/tasks.js';
import { loadSession, pruneSessions } from './auth/sessions.js';
import { getDb } from './db.js';

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'", // pdf.js image decoders (WebAssembly)
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "font-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  // Desktop windows may show apps on this server's tailnet name (any port) — nothing else.
  `frame-src 'self' https://${config.tailscaleHost}:* ${config.craftOrigin}${config.dev ? ' http://127.0.0.1:*' : ''}`,
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  getDb();
  const app = Fastify({
    logger: opts.logger ?? { level: config.dev ? 'debug' : 'info' },
    trustProxy: '127.0.0.1',
    bodyLimit: 256 * 1024,
  });

  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });
  await app.register(multipart, { limits: { fileSize: 20 * 1024 ** 3, files: 50, fields: 10 } });

  const origins = new Set(allowedOrigins());

  app.decorateRequest('session', null);
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    // CSRF: state-changing requests and WebSocket upgrades must come from our own origin.
    const unsafe = req.method !== 'GET' && req.method !== 'HEAD';
    const isWs = req.headers.upgrade?.toLowerCase() === 'websocket';
    if (unsafe || isWs) {
      const origin = req.headers.origin;
      if (!origin || !origins.has(origin)) return reply.code(403).send({ error: 'bad_origin' });
    }
    req.session = loadSession(req);
  });

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    // Microphone only for NovaOS's own pages (voice chat), never for anything framed in it.
    reply.header('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()');
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    else reply.header('Content-Security-Policy', CSP);
    return payload;
  });

  const version = (JSON.parse(fs.readFileSync(path.join(config.repoRoot, 'package.json'), 'utf8')) as { version: string }).version;
  app.get('/api/health', async () => ({ ok: true, version }));

  await app.register(authRoutes);
  await app.register(wizardRoutes);
  await app.register(pluginRoutes);
  await app.register(selfUpdateRoutes);
  await app.register(pricesRoutes);
  await app.register(credentialRoutes);
  await app.register(extractRoutes);
  await app.register(metricsRoutes);
  await app.register(storeRoutes);
  await app.register(systemRoutes);
  await app.register(fileRoutes);
  await app.register(dockerManageRoutes);
  await app.register(volumeRoutes);
  await app.register(galleryRoutes);
  await app.register(craftRoutes);
  await app.register(terminalRoutes);
  await app.register(lockRoutes);
  await app.register(diskHealthRoutes);
  await app.register(searchRoutes);
  await app.register(speedRoutes);
  await app.register(updateRoutes);
  await app.register(mediaRoutes);
  await app.register(downloadsRoutes);
  await app.register(shareRoutes);
  await app.register(botRoutes);
  await app.register(downloadRoutes);
  await app.register(videoDownloadRoutes);
  await app.register(voiceRoutes);
  await app.register(backupRoutes);
  await app.register(gamesRoutes);
  await app.register(launchRoutes);
  await app.register(previewRoutes);
  await app.register(dropRoutes);
  await app.register(watchRoutes);
  await app.register(healthRoutes);
  await app.register(networkRoutes);
  await app.register(mobileRoutes);
  recoverTasks();
  // Trade Bot (paper trading): trades around the clock when ~/ArtCraft/tradebot is installed.
  const stopTradeBot = startTradeBot();
  app.addHook('onClose', async () => stopTradeBot());
  // Prices (PC parts tracker): quotes every tracked listing twice a day.
  const stopPrices = startPricesLoop();
  app.addHook('onClose', async () => stopPrices());
  // Nightly backups to the Toshiba (backup/backup.ts).
  const stopBackups = startBackupLoop();
  app.addHook('onClose', async () => stopBackups());
  // Home network: device scan every 15 min, internet speed every 6 h (network/network.ts).
  const stopNetwork = startNetworkLoop();
  app.addHook('onClose', async () => stopNetwork());

  // Static PWA (built by Vite). Hashed assets are immutable; HTML and the SW are always revalidated.
  if (fs.existsSync(config.webDist)) {
    await app.register(fastifyStatic, {
      root: config.webDist,
      wildcard: false,
      setHeaders(res, filePath) {
        const base = path.basename(filePath);
        if (filePath.includes(`${path.sep}assets${path.sep}`)) res.header('Cache-Control', 'public, max-age=31536000, immutable');
        else if (base === 'sw.js' || base === 'precache.json' || base.endsWith('.html') || base.endsWith('.webmanifest')) res.header('Cache-Control', 'no-cache');
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/') && !path.extname(req.url.split('?')[0])) {
        return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
      }
      return reply.code(404).send({ error: 'not_found' });
    });
  }

  const prune = setInterval(pruneSessions, 3600_000);
  prune.unref();
  app.addHook('onClose', async () => clearInterval(prune));

  return app;
}
