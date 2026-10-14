import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { kvGet, kvSet } from '../db.js';
import { gamingNow } from '../games/games.js';
import { postHook } from './hook.js';
import { jf, jfText, pickSubtitle } from './mediaLibrary.js';

/**
 * Arabic subtitles by translation, when no human one exists yet: the film's English subtitle
 * (embedded in the file, or downloaded from OpenSubtitles through Jellyfin) is translated line by
 * line with a local model on the server (Ollama, the same Gemma the assistant uses — no swapping), timings
 * untouched, then uploaded to Jellyfin as an Arabic subtitle. One film at a time in the background,
 * resumable after a restart; the owner gets a Telegram line when it's ready.
 */

const OLLAMA = process.env.MANAR_OLLAMA_URL ?? 'http://127.0.0.1:11434';
const MODEL = process.env.MANAR_SUB_MODEL ?? 'gemma4:latest';
const BATCH = 25;
const JOBS = 'sub_jobs';
const dir = () => path.join(config.dataDir, 'subjobs');

export interface Cue {
  start: string;
  end: string;
  text: string;
}
/** SRT → cues (index numbers are rebuilt on output). */
export function parseSrt(srt: string): Cue[] {
  const out: Cue[] = [];
  for (const block of srt.replace(/\r/g, '').replace(/^﻿/, '').split(/\n{2,}/)) {
    const lines = block.trim().split('\n');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [start, end] = lines[i].split('-->').map((x) => x.trim().split(/\s+/)[0]);
    const text = lines.slice(i + 1).join('\n').trim();
    if (text) out.push({ start, end, text });
  }
  return out;
}
/** Cues → SRT; Arabic lines start with a right-to-left mark so punctuation sits on the right side. */
export function toSrt(cues: Cue[], rtl = false): string {
  return cues.map((c, i) => `${i + 1}\n${c.start} --> ${c.end}\n${rtl ? c.text.split('\n').map((l) => `‏${l}`).join('\n') : c.text}\n`).join('\n');
}
const plain = (t: string) => t.replace(/<[^>]+>/g, '').replace(/\{\\[^}]*\}/g, '').replace(/\n/g, ' / ').trim();

/** The model's numbered answer → one line per number (null where it's missing). */
export function readNumbered(answer: string, n: number): (string | null)[] {
  const out: (string | null)[] = Array.from({ length: n }, () => null);
  for (const line of answer.split('\n')) {
    const m = /^\s*(\d{1,3})\s*[.):\-–]\s*(.*)$/.exec(line);
    if (!m) continue;
    const k = Number(m[1]) - 1;
    if (k >= 0 && k < n && m[2].trim()) out[k] = m[2].trim();
  }
  return out;
}

async function ollama(prompt: string): Promise<string> {
  const r = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: prompt }], stream: false, think: false, keep_alive: '30m', options: { temperature: 0.2, num_ctx: 8192 } }),
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (!r.ok) throw new Error(`ollama_${r.status}`);
  return ((await r.json()) as { message: { content: string } }).message.content;
}

function promptFor(lines: string[], context: string[], title: string): string {
  return [
    `Translate these English subtitle lines from the film "${title}" into Arabic the way professional film subtitles are written: simple Modern Standard Arabic throughout (no dialect), natural and short.`,
    'Rules: keep every number, exactly one line per number, nothing else. Keep names as names. Translate sound descriptions in [brackets] too, keeping the brackets. " / " marks a line break inside one subtitle: keep it.',
    context.length ? `The lines just before, for context only (do not translate them):\n${context.join('\n')}` : '',
    '',
    lines.map((l, i) => `${i + 1}. ${l}`).join('\n'),
  ]
    .filter((x) => x !== '')
    .join('\n');
}

/** Translates a batch; a batch that comes back incomplete is split and retried, a single stubborn line stays English. */
export async function translateBatch(lines: string[], context: string[], title: string, ask: (p: string) => Promise<string> = ollama): Promise<string[]> {
  const got = readNumbered(await ask(promptFor(lines, context, title)), lines.length);
  if (got.every((x) => x !== null)) return got as string[];
  if (lines.length === 1) {
    const again = readNumbered(await ask(promptFor(lines, context, title)), 1)[0];
    return [again ?? lines[0]];
  }
  const half = Math.ceil(lines.length / 2);
  const a = await translateBatch(lines.slice(0, half), context, title, ask);
  const b = await translateBatch(lines.slice(half), [...context, ...lines.slice(0, half)].slice(-3), title, ask);
  return [...a, ...b];
}

// ---- jobs ------------------------------------------------------------------------------------------
export interface Job {
  itemId: string;
  name: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'skipped';
  done: number;
  total: number;
  at: number;
  finishedAt?: number;
  note?: string;
}
export function jobs(): Job[] {
  try {
    return JSON.parse(kvGet(JOBS) ?? '[]') as Job[];
  } catch {
    return [];
  }
}
const saveJobs = (j: Job[]) => kvSet(JOBS, JSON.stringify(j.slice(-100)));
function update(itemId: string, patch: Partial<Job>) {
  const all = jobs();
  const j = all.find((x) => x.itemId === itemId);
  if (j) Object.assign(j, patch);
  saveJobs(all);
}

/** Queues a film/episode (by Jellyfin id). Already queued or done → nothing. */
export function enqueue(itemId: string, name: string): Job {
  const all = jobs();
  const have = all.find((x) => x.itemId === itemId && x.status !== 'failed');
  if (have) return have;
  const j: Job = { itemId, name, status: 'queued', done: 0, total: 0, at: Date.now() };
  saveJobs([...all.filter((x) => x.itemId !== itemId), j]);
  return j;
}

interface Stream {
  Index: number;
  Type: string;
  Language?: string;
  Codec?: string;
  IsExternal?: boolean;
  IsTextSubtitleStream?: boolean;
}
async function streams(itemId: string): Promise<{ msId: string; subs: Stream[] }> {
  const it = await jf<{ MediaSources: { Id: string; MediaStreams: Stream[] }[] }>(`/Items/${itemId}?Fields=MediaSources,MediaStreams`);
  const ms = it.MediaSources[0];
  return { msId: ms.Id, subs: ms.MediaStreams.filter((s) => s.Type === 'Subtitle') };
}
const isEnglish = (s: Stream) => /^(eng|en|english)$/i.test(s.Language ?? '') && (s.IsTextSubtitleStream ?? /subrip|srt|ass|ssa|webvtt|vtt|mov_text/i.test(s.Codec ?? ''));
const isArabic = (s: Stream) => /^(ara|ar|arabic)$/i.test(s.Language ?? '');

const subtitleText = (itemId: string, msId: string, index: number) => jfText(`/Videos/${itemId}/${msId}/Subtitles/${index}/0/Stream.srt`);

/** Runs one job: English source → translated → uploaded. Progress is saved so a restart resumes. */
export async function runJob(j: Job): Promise<void> {
  fs.mkdirSync(dir(), { recursive: true });
  const state = path.join(dir(), `${j.itemId}.json`);
  let s = await streams(j.itemId);
  if (s.subs.some(isArabic) && j.done === 0) return update(j.itemId, { status: 'skipped', note: 'already has Arabic', finishedAt: Date.now() });
  let src = s.subs.find((x) => isEnglish(x) && !x.IsExternal) ?? s.subs.find(isEnglish);
  if (!src) {
    // No English text subtitle: fetch one from OpenSubtitles through Jellyfin, then look again.
    const found = await jf<{ Id: string; Name?: string; DownloadCount?: number }[]>(`/Items/${j.itemId}/RemoteSearch/Subtitles/eng?isPerfectMatch=false`).catch(() => []);
    const best = pickSubtitle(found, j.name);
    if (!best) return update(j.itemId, { status: 'failed', note: 'no English subtitle to translate', finishedAt: Date.now() });
    await jf(`/Items/${j.itemId}/RemoteSearch/Subtitles/${encodeURIComponent(best.Id)}`, { method: 'POST' });
    await new Promise((r) => setTimeout(r, 5000));
    s = await streams(j.itemId);
    src = s.subs.find(isEnglish);
    if (!src) return update(j.itemId, { status: 'failed', note: 'English subtitle did not appear', finishedAt: Date.now() });
  }
  const cues = parseSrt(await subtitleText(j.itemId, s.msId, src.Index));
  if (!cues.length) return update(j.itemId, { status: 'failed', note: 'empty subtitle', finishedAt: Date.now() });
  let ar: string[] = [];
  try {
    ar = (JSON.parse(fs.readFileSync(state, 'utf8')) as { ar: string[] }).ar ?? [];
  } catch {
    /* fresh */
  }
  update(j.itemId, { status: 'running', total: cues.length, done: ar.length });
  const title = j.name.replace(/\s*\(\d{4}\)$/, '');
  for (let i = ar.length; i < cues.length; i += BATCH) {
    const batch = cues.slice(i, i + BATCH).map((c) => plain(c.text));
    const context = cues.slice(Math.max(0, i - 3), i).map((c) => plain(c.text));
    ar = ar.concat(await translateBatch(batch, context, title));
    fs.writeFileSync(state, JSON.stringify({ ar }));
    update(j.itemId, { done: ar.length });
  }
  const out = cues.map((c, k) => ({ ...c, text: (ar[k] ?? c.text).split(' / ').join('\n') }));
  await jf(`/Videos/${j.itemId}/Subtitles`, {
    method: 'POST',
    body: { Language: 'ara', Format: 'srt', IsForced: false, IsHearingImpaired: false, Data: Buffer.from(toSrt(out, true), 'utf8').toString('base64') },
  });
  fs.rmSync(state, { force: true });
  const mins = Math.max(1, Math.round((Date.now() - j.at) / 60_000));
  update(j.itemId, { status: 'done', finishedAt: Date.now() });
  await postHook({ type: 'notice', text: `🔤 <b>${j.name.replace(/[<>&]/g, '')}</b> صار فيه ترجمة عربي\n<i>مترجمة آلياً من الإنجليزي بموديل على the server · ${cues.length} سطر · ${mins} د</i>\nإذا نزلت ترجمة بشرية لاحقاً بتنضاف كمان.` });
}

let busy = false;
export async function subTick(): Promise<void> {
  if (busy) return;
  // Translation keeps the GPU busy: it waits while a game is streaming to the TV (games/games.ts).
  if (await gamingNow()) return;
  const next = jobs().find((x) => x.status === 'running') ?? jobs().find((x) => x.status === 'queued');
  if (!next) return;
  busy = true;
  try {
    await runJob(next);
  } catch (e) {
    update(next.itemId, { status: 'failed', note: (e as Error).message.slice(0, 160), finishedAt: Date.now() });
  } finally {
    busy = false;
  }
}

export function startSubTranslator(): () => void {
  if (process.env.VITEST) return () => {};
  const t = setInterval(() => void subTick(), 30_000);
  return () => clearInterval(t);
}

/** Films/episodes in Jellyfin by name (for "/sub dracula" and the assistant's tool). */
export async function findItems(q: string) {
  const r = await jf<{ Items: { Id: string; Name: string; ProductionYear?: number; Type: string; SeriesName?: string; IndexNumber?: number; ParentIndexNumber?: number }[] }>(
    `/Items?Recursive=true&IncludeItemTypes=Movie,Episode&searchTerm=${encodeURIComponent(q.slice(0, 60))}&Limit=8`,
  );
  return r.Items.map((x) => ({
    id: x.Id,
    name: x.Type === 'Episode' ? `${x.SeriesName ?? ''} S${String(x.ParentIndexNumber ?? 1).padStart(2, '0')}E${String(x.IndexNumber ?? 0).padStart(2, '0')}` : `${x.Name}${x.ProductionYear ? ` (${x.ProductionYear})` : ''}`,
  }));
}

// ---- /sub on Telegram ---------------------------------------------------------------------------
interface Update {
  message?: { chat: { id: number }; text?: string };
  callback_query?: { id: string; data?: string; message?: { chat: { id: number }; message_id: number } };
}
const esc = (x: string) => x.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]!);
function statusText(): string {
  const all = jobs().slice(-8).reverse();
  if (!all.length) return '🔤 <b>ترجمة للعربي</b>\nما في شي. اكتب <code>/sub اسم الفلم</code> وبترجملك الترجمة الإنجليزية للعربي.';
  const icon: Record<Job['status'], string> = { queued: '⏳', running: '✍️', done: '✅', failed: '⚠️', skipped: '✔️' };
  return `🔤 <b>ترجمة للعربي</b>\n${all.map((j) => `${icon[j.status]} ${esc(j.name)}${j.status === 'running' && j.total ? ` · ${Math.round((j.done / j.total) * 100)}%` : ''}${j.note && j.status !== 'done' ? ` · <i>${esc(j.note)}</i>` : ''}`).join('\n')}`;
}
/** "/sub <name>": translate that film's English subtitle; "/sub": what's queued and done. */
export async function subUpdate(u: Update, send: (chatId: number, text: string, buttons?: { text: string; data: string }[][]) => Promise<unknown>, edit: (chatId: number, messageId: number, text: string) => Promise<unknown>, answer: (id: string, text?: string) => Promise<unknown>) {
  if (u.callback_query) {
    const q = u.callback_query;
    const id = (q.data ?? '').split(':')[1] ?? '';
    const it = await jf<{ Name: string; ProductionYear?: number; SeriesName?: string; Type?: string }>(`/Items/${id}`).catch(() => null);
    if (!it) return (await answer(q.id, 'ما لقيته'), { ok: true, did: 'missing' });
    const name = it.Type === 'Episode' && it.SeriesName ? `${it.SeriesName} · ${it.Name}` : `${it.Name}${it.ProductionYear ? ` (${it.ProductionYear})` : ''}`;
    enqueue(id, name);
    await answer(q.id, '✍️ بلشت');
    if (q.message) await edit(q.message.chat.id, q.message.message_id, `✍️ رح ترجم <b>${esc(name)}</b> للعربي (حوالي 20–30 دقيقة)، وبيوصلك مسج لما يخلص.`);
    return { ok: true, did: 'queued' };
  }
  const chat = u.message!.chat.id;
  const q = (u.message!.text ?? '').replace(/^\/sub(@\w+)?/i, '').trim();
  if (!q) return (await send(chat, statusText()), { ok: true, did: 'status' });
  const items = await findItems(q);
  if (!items.length) return (await send(chat, `🔍 ما لقيت «${esc(q)}» بـ Jellyfin.`), { ok: true, did: 'none' });
  if (items.length === 1) {
    const j = enqueue(items[0].id, items[0].name);
    await send(chat, j.status === 'done' ? `✅ <b>${esc(j.name)}</b> مترجم من قبل.` : `✍️ رح ترجم <b>${esc(items[0].name)}</b> للعربي (حوالي 20–30 دقيقة)، وبيوصلك مسج لما يخلص.`);
    return { ok: true, did: 'queued' };
  }
  await send(chat, `أي واحد؟`, items.map((x) => [{ text: x.name.slice(0, 50), data: `sub:${x.id}` }]));
  return { ok: true, did: 'choose' };
}
