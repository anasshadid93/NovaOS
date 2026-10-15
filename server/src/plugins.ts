import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { requireAuth } from './auth/sessions.js';
import { telegramReady } from './bot/telegram.js';
import { config } from './config.js';
import { kvGet } from './db.js';
import { getSettings } from './notify/notify.js';

/**
 * Optional integrations ("plugins"). Each one switches itself on when its configuration exists and
 * stays silent otherwise, so a fresh install runs with all of them off. This file is the one place
 * that knows how to detect each and what a user must provide to turn it on; Settings → Integrations
 * shows the result.
 */
export interface Plugin {
  id: string;
  /** What must exist for it to be on: a config key in manar.json, a file in var/, or a setting in the app. */
  needs: { kind: 'config'; key: string } | { kind: 'file'; name: string } | { kind: 'setting'; route: string } | { kind: 'install'; path: string } | { kind: 'api'; call: string };
  enabled: () => boolean;
  /** Extra detail for the UI (never a secret). */
  detail?: () => string;
}

const varFile = (name: string) => path.join(config.dataDir, name);
const onPath = (cmd: string) => (process.env.PATH ?? '').split(':').some((d) => d && fs.existsSync(path.join(d, cmd)));

export const PLUGINS: Plugin[] = [
  {
    id: 'assistant',
    needs: { kind: 'config', key: 'downloadHook' },
    enabled: () => !!config.downloadHook,
    detail: () => (config.downloadHook ? new URL(config.downloadHook).host : ''),
  },
  {
    id: 'telegram',
    needs: { kind: 'file', name: 'telegram-bot.json' },
    enabled: () => telegramReady(),
  },
  {
    id: 'telegramBusiness',
    needs: { kind: 'config', key: 'telegramOwner' },
    enabled: () => telegramReady() && config.telegramOwner > 0,
  },
  {
    id: 'botApi',
    needs: { kind: 'api', call: 'POST /api/bot/token' },
    enabled: () => !!kvGet('bot_token_sha256'),
    detail: () => `${config.botHost}:${config.botPort}`,
  },
  {
    id: 'whatsapp',
    needs: { kind: 'setting', route: '/settings/notifications' },
    enabled: () => getSettings().whatsapp.enabled && onPath('openclaw'),
  },
  {
    id: 'erp',
    needs: { kind: 'config', key: 'grerpsDb' },
    enabled: () => !!config.grerpsDb && fs.existsSync(config.grerpsDb),
  },
  {
    id: 'tradebot',
    needs: { kind: 'install', path: path.join(config.craftRoot, 'tradebot') },
    enabled: () => fs.existsSync(path.join(config.craftRoot, 'tradebot', 'app.json')),
  },
  {
    id: 'vision',
    needs: { kind: 'install', path: config.visionDir },
    enabled: () => fs.existsSync(path.join(config.visionDir, 'model', 'img_clip_vit_b_16.xml')) && fs.existsSync(path.join(config.visionDir, 'venv', 'bin', 'python')),
    detail: () => config.visionDir,
  },
  {
    id: 'services',
    needs: { kind: 'file', name: 'services.json' },
    enabled: () => fs.existsSync(varFile('services.json')),
  },
  {
    id: 'publicShares',
    needs: { kind: 'config', key: 'shareBase' },
    // A share base that is not just "this host" means a reverse proxy publishes the share server.
    enabled: () => !/^https:\/\/[^/]*\b(localhost|127\.0\.0\.1)\b|:7475$/.test(config.shareBase) && config.shareBase !== `https://${config.hostname}:7475`,
    detail: () => new URL(config.shareBase).host,
  },
];

export const pluginEnabled = (id: string) => PLUGINS.find((p) => p.id === id)?.enabled() ?? false;

export function pluginStatus() {
  return PLUGINS.map((p) => ({
    id: p.id,
    enabled: p.enabled(),
    needs: p.needs,
    detail: p.enabled() ? (p.detail?.() ?? '') : '',
  }));
}

export async function pluginRoutes(app: FastifyInstance) {
  app.get('/api/settings/integrations', { preHandler: requireAuth }, async () => ({ plugins: pluginStatus(), configFile: config.configFile }));
}
