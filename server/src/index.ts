import { buildApp } from './app.js';
import { ensureSetupToken } from './auth/setup.js';
import { config } from './config.js';
import { buildCraftServer } from './craft/craft.js';
import { buildShareServer } from './share/share.js';
import { buildBotServer } from './bot/bot.js';
import { warmIndex } from './files/files.js';
import { closeDb } from './db.js';
import { finishSelfUpdate } from './system/selfupdate.js';

const app = await buildApp();
// A just-installed update that keeps crashing is rolled back here, before anything else runs.
await finishSelfUpdate('boot', app.log);

const setupToken = ensureSetupToken();
if (setupToken) app.log.warn(`No account yet. Open NovaOS and use the setup token in ${config.dataDir}/setup-token`);

await app.listen({ host: config.host, port: config.port });
await finishSelfUpdate('listening', app.log);
warmIndex();

// ArtCraft apps on their own origin (see craft/craft.ts). Optional: NovaOS runs without it.
const craft = process.env.MANAR_CRAFT === '0' ? null : await buildCraftServer();
await craft?.listen({ host: config.host, port: config.craftPort }).catch((err) => app.log.error({ err }, 'ArtCraft server did not start'));

// Share links: the only part of the server reachable from the internet (see share/share.ts).
const share = process.env.MANAR_SHARE === '0' ? null : await buildShareServer();
await share?.listen({ host: config.host, port: config.sharePort }).catch((err) => app.log.error({ err }, 'Share server did not start'));

// Bot API for automations in Docker (see bot/bot.ts). Docker's bridge may come up after us: retry.
const bot = process.env.MANAR_BOT === '0' ? null : await buildBotServer();
let botWarned = false;
const listenBot = () =>
  bot?.listen({ host: config.botHost, port: config.botPort }).catch((err) => {
    if (!botWarned) app.log.warn({ err: (err as Error).message }, `Bot API not listening on ${config.botHost} (no docker bridge?); retrying every 30s`);
    botWarned = true;
    setTimeout(listenBot, 30_000).unref();
  });
void listenBot();

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, async () => {
    await app.close();
    await craft?.close();
    await share?.close();
    await bot?.close();
    closeDb();
    process.exit(0);
  });
}
