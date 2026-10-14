import crypto from 'node:crypto';
import { audit, getDb } from '../db.js';
import { docker } from '../docker/client.js';
import { postHook } from './hook.js';
import { discardProposal, executeErp, isAmbiguous, prepareErp, type ErpProposal } from './erpWrite.js';
import { config } from '../config.js';

/**
 * Actions the assistant may *propose* but never perform on its own: it creates a pending action,
 * the owner gets a Telegram message with ✅/❌ buttons, and only the button press (a one-time token,
 * valid 10 minutes) carries it out. The assistant's own container can't be touched.
 */

export type ContainerAction = 'restart' | 'stop' | 'start';
const ACTIONS: ContainerAction[] = ['restart', 'stop', 'start'];
const PROTECTED = new Set([`${config.containerPrefix}n8n`]);
const TTL = 10 * 60_000;
const AR: Record<ContainerAction, string> = { restart: 'إعادة تشغيل', stop: 'إيقاف', start: 'تشغيل' };

interface Row {
  token: string;
  kind: string;
  target: string;
  action: ContainerAction;
  status: 'pending' | 'done' | 'failed' | 'cancelled' | 'expired';
  result: string | null;
  expires_at: number;
}

async function findContainer(name: string) {
  const want = name.trim().replace(/^\//, '').toLowerCase();
  const list = await docker.list();
  return (
    list.find((c) => c.Names.some((n) => n.replace(/^\//, '').toLowerCase() === want)) ??
    list.find((c) => (c.Labels['manar.app'] ?? '').toLowerCase() === want) ??
    // "n8n" → manar-n8n, "blender" → manar-blender
    list.find((c) => c.Names.some((n) => n.replace(/^\//, '').toLowerCase() === `${config.containerPrefix}${want}`))
  );
}

export async function proposeContainerAction(name: string, action: string) {
  if (!ACTIONS.includes(action as ContainerAction)) throw new Error('bad_action');
  const c = await findContainer(name);
  if (!c) throw new Error('no_such_container');
  const target = c.Names[0].replace(/^\//, '');
  if (PROTECTED.has(target)) throw new Error('protected');
  if (action === 'start' && c.State === 'running') return { ok: false, message: `${target} شغّال أصلًا.` };
  if (action === 'stop' && c.State !== 'running') return { ok: false, message: `${target} واقف أصلًا.` };
  const token = crypto.randomBytes(12).toString('base64url');
  const now = Date.now();
  getDb()
    .prepare("INSERT INTO bot_actions(token, kind, target, action, status, created_at, expires_at) VALUES(?, 'container', ?, ?, 'pending', ?, ?)")
    .run(token, target, action, now, now + TTL);
  const text = `⚠️ <b>تأكيد مطلوب</b>\n${AR[action as ContainerAction]} الـ container <b>${target}</b>؟\n(الحالة هلق: ${c.State})`;
  const sent = await postHook({ type: 'confirm', text, token });
  return { ok: true, pending: true, target, action, buttonsSent: sent, message: 'A confirmation message with buttons was sent to the owner. Nothing happens until he presses ✅.' };
}

/** A GRERPS change (bot/erpWrite.ts): resolved + summarised now, executed only on ✅. */
export async function proposeErpChange(operation: string, fields: Record<string, unknown>) {
  let p: ErpProposal;
  try {
    p = await prepareErp(operation, fields ?? {});
  } catch (e) {
    // Unclear name / missing field → tell the model what to ask the owner; nothing is sent to Telegram.
    return { ok: false, needsInput: true, message: (e as Error).message, ambiguous: isAmbiguous(e) };
  }
  const token = crypto.randomBytes(12).toString('base64url');
  const now = Date.now();
  getDb()
    .prepare("INSERT INTO bot_actions(token, kind, target, action, status, created_at, expires_at) VALUES(?, 'erp', ?, ?, 'pending', ?, ?)")
    .run(token, JSON.stringify(p), p.operation, now, now + TTL);
  const sent = await postHook({ type: 'confirm', text: `⚠️ <b>تأكيد مطلوب — GRERPS</b>\n${p.summary}`, token });
  return { ok: true, pending: true, buttonsSent: sent, message: 'A confirmation with ✅/❌ buttons was sent to the owner. Nothing is saved in GRERPS until he presses ✅. Tell him briefly to check it.' };
}

async function runErp(token: string, row: Row): Promise<{ text: string }> {
  const db = getDb();
  try {
    const text = await executeErp(JSON.parse(row.target) as ErpProposal);
    db.prepare("UPDATE bot_actions SET status = 'done', result = 'ok' WHERE token = ?").run(token);
    audit(null, 'bot.erp', { operation: row.action });
    return { text };
  } catch (e) {
    db.prepare("UPDATE bot_actions SET status = 'failed', result = ? WHERE token = ?").run((e as Error).message.slice(0, 300), token);
    return { text: `⚠️ ما انحفظت بـ GRERPS: <code>${(e as Error).message.slice(0, 200).replace(/</g, '&lt;')}</code>` };
  }
}

export async function decide(token: string, yes: boolean): Promise<{ text: string }> {
  const db = getDb();
  const row = db.prepare('SELECT * FROM bot_actions WHERE token = ?').get(token) as Row | undefined;
  if (!row) return { text: '❔ هالطلب مش موجود.' };
  if (row.status !== 'pending') return { text: `هالطلب انتهى (${row.status}).` };
  if (Date.now() > row.expires_at) {
    db.prepare("UPDATE bot_actions SET status = 'expired' WHERE token = ?").run(token);
    if (row.kind === 'erp') discardProposal(JSON.parse(row.target) as ErpProposal);
    return { text: '⌛ انتهت صلاحية الطلب (10 دقايق). اطلبه من جديد.' };
  }
  // Claim it first so a double tap can't run it twice.
  const claimed = db.prepare("UPDATE bot_actions SET status = 'running' WHERE token = ? AND status = 'pending'").run(token).changes;
  if (!claimed) return { text: 'عم ينفّذ أو انتهى.' };
  if (!yes) {
    db.prepare("UPDATE bot_actions SET status = 'cancelled' WHERE token = ?").run(token);
    if (row.kind === 'erp') discardProposal(JSON.parse(row.target) as ErpProposal);
    return { text: row.kind === 'erp' ? '❌ لغيتها، ما انحفظ شي بـ GRERPS.' : `❌ لغيت ${AR[row.action]} ${row.target}.` };
  }
  if (row.kind === 'erp') return runErp(token, row);
  try {
    const c = await findContainer(row.target);
    if (!c) throw new Error('no_such_container');
    await docker[row.action](c.Id);
    db.prepare("UPDATE bot_actions SET status = 'done', result = 'ok' WHERE token = ?").run(token);
    audit(null, 'bot.container', { target: row.target, action: row.action });
    const state = (await findContainer(row.target))?.State ?? '?';
    return { text: `✅ تم ${AR[row.action]} <b>${row.target}</b> (الحالة: ${state}).` };
  } catch (e) {
    db.prepare("UPDATE bot_actions SET status = 'failed', result = ? WHERE token = ?").run((e as Error).message.slice(0, 300), token);
    return { text: `⚠️ ما زبط ${AR[row.action]} ${row.target}: <code>${(e as Error).message.slice(0, 200)}</code>` };
  }
}
