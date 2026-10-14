import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/sessions.js';
import { audit } from '../db.js';
import { postHook } from '../bot/hook.js';
import { enqueue, registerTask, type TaskContext } from '../tasks/tasks.js';
import { invalidateIndex } from './files.js';
import { relOf, resolveInRoot } from './fsops.js';

/**
 * Files → Extract: unpacks an archive into a new folder next to it (zip, rar, 7z, tar.*, iso…)
 * as a background task with progress, so a 10 GB zip doesn't hold up the page.
 */

const TAR = /\.(tar|tgz|tbz2?|txz|tzst|tar\.(gz|bz2|xz|zst))$/i;
const ARCHIVE = /\.(zip|rar|7z|tar|tgz|tbz2?|txz|tzst|gz|bz2|xz|zst|iso|cab|lzh|arj|001|wim|dmg)$/i;

export const isArchive = (name: string) => ARCHIVE.test(name);

/** "Game (USA).zip" → "Game (USA)", "x.tar.gz" → "x", "a.part1.rar" → "a". */
export function folderNameFor(file: string): string {
  let base = path.basename(file);
  base = base.replace(/\.tar\.(gz|bz2|xz|zst)$/i, '').replace(/\.(part0*1\.rar|7z\.001|zip\.001|001)$/i, '');
  if (base === path.basename(file)) base = base.replace(/\.[^.]+$/, '');
  return base.trim() || 'extracted';
}

function uniqueDir(parent: string, name: string): string {
  let p = path.join(parent, name);
  for (let i = 2; fs.existsSync(p); i++) p = path.join(parent, `${name} (${i})`);
  return p;
}

function extractWith(ctx: TaskContext, cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let last = '';
    let err = '';
    const onData = (c: Buffer) => {
      const text = c.toString();
      // 7z -bsp1 prints "  42% 13 - name"; keep the newest percentage as the task's progress.
      const m = text.match(/(\d{1,3})%/g);
      if (m) {
        const pct = m[m.length - 1];
        if (pct !== last) ctx.progress((last = pct));
      }
      for (const line of text.split(/[\r\n]+/)) if (/error|wrong password|can not open|cannot open|unexpected/i.test(line)) err += `${line.trim()}\n`;
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim().split('\n').slice(-3).join(' ') || `${cmd} exited with ${code}`))));
  });
}

registerTask('fs.extract', async (ctx, params) => {
  const file = String(params.file);
  const dest = String(params.dest);
  fs.mkdirSync(dest, { recursive: true });
  ctx.log(`Extracting ${path.basename(file)} → ${dest}`);
  const name = path.basename(file);
  try {
    if (TAR.test(file)) await extractWith(ctx, 'tar', ['-xf', file, '-C', dest, '--no-same-owner', '--no-same-permissions']);
    // -p- : never prompt for a password (a protected archive fails instead of hanging).
    else await extractWith(ctx, '7z', ['x', '-y', '-bsp1', '-bb0', '-p-', `-o${dest}`, file]);
  } catch (e) {
    // Leave nothing half-made behind when it failed before writing anything.
    if (fs.existsSync(dest) && fs.readdirSync(dest).length === 0) fs.rmdirSync(dest);
    void postHook({ type: 'notice', text: `❌ فك الضغط فشل: ${name}\n${(e as Error).message.slice(0, 200)}` });
    throw e;
  }
  invalidateIndex();
  ctx.log('Done');
  // Phone (NovaOS app / ntfy) and Telegram: it's ready.
  void postHook({ type: 'notice', text: `✅ خلص فك الضغط: ${name}\n📁 ${path.basename(dest)}` });
});

export async function extractRoutes(app: FastifyInstance) {
  app.post<{ Body: { path?: string } }>('/api/fs/extract', { preHandler: requireAuth }, async (req, reply) => {
    let file: string;
    try {
      file = resolveInRoot(String(req.body?.path ?? ''));
    } catch {
      return reply.code(404).send({ error: 'not_found' });
    }
    if (!fs.statSync(file).isFile() || !isArchive(file)) return reply.code(400).send({ error: 'not_archive' });
    const dest = uniqueDir(path.dirname(file), folderNameFor(file));
    // The new folder must stay inside the files root like everything else.
    resolveInRoot(relOf(dest), false);
    audit(req.session!.userId, 'fs_extract', { path: relOf(file) });
    const task = enqueue('fs.extract', `Extract ${path.basename(file)}`, { file, dest });
    return { task, folder: relOf(dest) };
  });
}
