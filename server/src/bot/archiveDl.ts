import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { kvGet, kvSet } from '../db.js';
import { postHook } from './hook.js';
import { remember } from './torrentHistory.js';
import { config } from '../config.js';

/**
 * Internet Archive downloads. Archive.org leaves the files out of its torrent for very large items,
 * so those are fetched over HTTPS instead: the item's original videos only (not the archive's own
 * converted copies and thumbnails), three at a time, resumed with Range requests after a restart, onto
 * the Toshiba under Downloads/Archive/<item>/. Every finished file goes to its shelf at once
 * (mediaLibrary's mediaTick reads `archiveFiles`), like a torrent tagged with a category.
 */

export interface ArchiveFile {
  name: string;
  size: number;
  done: boolean;
  failed?: number;
  /** left out by hand */
  skipped?: boolean;
  /** "download next": higher goes first */
  priority?: number;
}
export interface ArchiveJob {
  id: string;
  title: string;
  category: string;
  files: ArchiveFile[];
  at: number;
  status: 'downloading' | 'done' | 'paused';
  finishedAt?: number;
}
const KEY = 'archive_jobs';
const PARALLEL = 3;
export const ARCHIVE_DIR = () => path.join(config.mediaRoot, 'Downloads', 'Archive');

export function archiveJobs(): ArchiveJob[] {
  try {
    return JSON.parse(kvGet(KEY) ?? '[]') as ArchiveJob[];
  } catch {
    return [];
  }
}
const save = (j: ArchiveJob[]) => kvSet(KEY, JSON.stringify(j));
const fileUrl = (id: string, name: string) => `https://archive.org/download/${encodeURIComponent(id)}/${name.split('/').map(encodeURIComponent).join('/')}`;
export const localPath = (id: string, name: string) => path.join(ARCHIVE_DIR(), id, name);

const WANT = /\.(mp4|mkv|avi|m4v|wmv|mpg|mpeg|vob|ifo|bup|mov|flv|srt|ass)$/i;
/** Queues an item: its original video files (and DVD/subtitle files), biggest download first by name. */
export async function addArchiveItem(id: string, category: string, title?: string): Promise<ArchiveJob> {
  const have = archiveJobs().find((j) => j.id === id);
  if (have) return have;
  const r = await fetch(`https://archive.org/metadata/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`archive_metadata_${r.status}`);
  const meta = (await r.json()) as { metadata?: { title?: string }; files?: { name: string; size?: string; source?: string }[] };
  const files = (meta.files ?? []).filter((f) => f.source === 'original' && WANT.test(f.name)).map((f) => ({ name: f.name, size: Number(f.size ?? 0), done: false }));
  if (!files.length) throw new Error('no original videos in this item');
  const job: ArchiveJob = { id, title: title ?? meta.metadata?.title ?? id, category, files: files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })), at: Date.now(), status: 'downloading' };
  save([...archiveJobs(), job]);
  remember(`ARCHIVE:${id}`, job.title);
  return job;
}

function mark(id: string, name: string, patch: Partial<ArchiveFile>) {
  const all = archiveJobs();
  const f = all.find((j) => j.id === id)?.files.find((x) => x.name === name);
  if (f) Object.assign(f, patch);
  save(all);
}

/** One file, resumed from where it stopped. */
async function fetchFile(job: ArchiveJob, f: ArchiveFile): Promise<void> {
  const dest = localPath(job.id, f.name);
  const part = `${dest}.part`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest) && fs.statSync(dest).size === f.size) return;
  const from = fs.existsSync(part) ? fs.statSync(part).size : 0;
  const ctl = new AbortController();
  controllers.set(`${job.id}/${f.name}`, ctl);
  const r = await fetch(fileUrl(job.id, f.name), { headers: from ? { Range: `bytes=${from}-` } : {}, redirect: 'follow', signal: AbortSignal.any([ctl.signal, AbortSignal.timeout(6 * 3600_000)]) });
  if (!r.ok || !r.body) throw new Error(`http_${r.status}`);
  const append = from > 0 && r.status === 206;
  await pipeline(Readable.fromWeb(r.body as never), fs.createWriteStream(part, { flags: append ? 'a' : 'w' }));
  const got = fs.statSync(part).size;
  if (f.size && got !== f.size) throw new Error(`short_${got}_of_${f.size}`);
  fs.renameSync(part, dest);
}

const running = new Set<string>();
const controllers = new Map<string, AbortController>();
let ticking = false;
/** Keeps up to three files downloading; a job finishing sends one line. */
export async function archiveTick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    for (const job of archiveJobs().filter((j) => j.status === 'downloading')) {
      const left = job.files.filter((f) => !f.done && !f.skipped && (f.failed ?? 0) < 5).sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
      if (!left.length && !job.files.some((f) => running.has(`${job.id}/${f.name}`))) {
        const all = archiveJobs();
        const j = all.find((x) => x.id === job.id)!;
        j.status = 'done';
        j.finishedAt = Date.now();
        save(all);
        const ok = job.files.filter((f) => f.done).length;
        void postHook({ type: 'notice', text: `📦 <b>${job.title.replace(/[<>&]/g, '')}</b> خلص تنزيله: ${ok} من ${job.files.length} ملف${ok < job.files.length ? ' (الباقي ما زبط بعد 5 محاولات)' : ''}` });
        continue;
      }
      for (const f of left) {
        if (running.size >= PARALLEL) break;
        const key = `${job.id}/${f.name}`;
        if (running.has(key)) continue;
        running.add(key);
        void fetchFile(job, f)
          .then(() => mark(job.id, f.name, { done: true }))
          // A pause aborts on purpose: that is not a failure.
          .catch(() => (controllers.get(key)?.signal.aborted ? undefined : mark(job.id, f.name, { failed: (f.failed ?? 0) + 1 })))
          .finally(() => {
            running.delete(key);
            controllers.delete(key);
          });
      }
    }
  } finally {
    ticking = false;
  }
}

/** For mediaTick: finished files of every job, shaped like a torrent's files. */
export function archiveDownloads() {
  return archiveJobs().map((j) => ({
    meta: { hash: `ARCHIVE:${j.id}`, name: j.title, category: j.category },
    // Skipped files count as left out (priority 0, like an unselected torrent file).
    files: j.files.map((f) => ({ name: f.name, size: f.size, progress: f.done ? 1 : 0, ...(f.skipped ? { priority: 0 } : {}) })),
    hostOf: (name: string) => localPath(j.id, name),
    complete: j.status === 'done',
  }));
}

/** Status lines for /torrents. */
export function archiveStatus(): string[] {
  return archiveJobs()
    .filter((j) => j.status !== 'done' || Date.now() - (j.finishedAt ?? 0) < 24 * 3600_000)
    .map((j) => {
      const done = j.files.filter((f) => f.done);
      const gb = (n: number) => (n / 1e9).toFixed(0);
      return `📦 ${j.title.slice(0, 50)}\n    ${done.length}/${j.files.length} ملف · ${gb(done.reduce((s, f) => s + f.size, 0))} من ${gb(j.files.reduce((s, f) => s + f.size, 0))} GB${j.status === 'done' ? ' · ✅' : ''}`;
    });
}

export function startArchiveDownloads(): () => void {
  if (process.env.VITEST) return () => {};
  const t = setInterval(() => void archiveTick(), 20_000);
  setTimeout(() => void archiveTick(), 3000);
  return () => clearInterval(t);
}

// ---- control and a live view, for NovaOS's Downloads page ------------------------------------
/** Pause stops the files in flight (their .part stays, so a resume continues them); resume restarts. */
export function setJobPaused(id: string, paused: boolean): ArchiveJob | null {
  const all = archiveJobs();
  const j = all.find((x) => x.id === id);
  if (!j || j.status === 'done') return j ?? null;
  j.status = paused ? 'paused' : 'downloading';
  save(all);
  if (paused) {
    for (const [k, c] of controllers) if (k.startsWith(`${id}/`)) c.abort();
  } else void archiveTick();
  return j;
}

/** One file: download it next, skip it, or try it again. */
export function fileAction(id: string, name: string, action: 'first' | 'skip' | 'retry' | 'unskip'): boolean {
  const all = archiveJobs();
  const j = all.find((x) => x.id === id);
  const f = j?.files.find((x) => x.name === name);
  if (!j || !f) return false;
  if (action === 'first') f.priority = Date.now();
  if (action === 'skip') {
    f.skipped = true;
    controllers.get(`${id}/${name}`)?.abort();
  }
  if (action === 'unskip') f.skipped = false;
  if (action === 'retry') f.failed = 0;
  // A job that closed with failed files reopens for a retry.
  if ((action === 'retry' || action === 'unskip') && j.status === 'done') j.status = 'downloading';
  save(all);
  void archiveTick();
  return true;
}

const samples = new Map<string, { at: number; bytes: number }>();
export type FileState = 'done' | 'downloading' | 'queued' | 'failed' | 'skipped' | 'paused';
/** Every job with every file: state, bytes so far, speed (from the last look), and whether it reached the library. */
export function archiveSnapshot(inLibrary: (localFile: string) => boolean) {
  const now = Date.now();
  return archiveJobs().map((j) => {
    let speed = 0;
    let have = 0;
    const files = j.files.map((f) => {
      const key = `${j.id}/${f.name}`;
      const local = localPath(j.id, f.name);
      let bytes = f.done ? f.size : 0;
      if (!f.done) {
        try {
          bytes = fs.statSync(`${local}.part`).size;
        } catch {
          bytes = 0;
        }
      }
      let rate = 0;
      if (running.has(key)) {
        const prev = samples.get(key);
        if (prev && now > prev.at) rate = Math.max(0, ((bytes - prev.bytes) / (now - prev.at)) * 1000);
        samples.set(key, { at: now, bytes });
        speed += rate;
      } else samples.delete(key);
      have += bytes;
      const state: FileState = f.done ? 'done' : f.skipped ? 'skipped' : (f.failed ?? 0) >= 5 ? 'failed' : running.has(key) ? 'downloading' : j.status === 'paused' ? 'paused' : 'queued';
      return { name: f.name, size: f.size, bytes, state, rate: Math.round(rate), failed: f.failed ?? 0, library: f.done && inLibrary(local) };
    });
    const total = j.files.filter((f) => !f.skipped).reduce((s, f) => s + f.size, 0);
    const left = total - have;
    return {
      id: j.id,
      title: j.title,
      shelf: j.category,
      status: j.status,
      at: j.at,
      total,
      have,
      speed: Math.round(speed),
      etaSec: speed > 0 ? Math.round(left / speed) : null,
      counts: files.reduce<Record<string, number>>((m, f) => ((m[f.state] = (m[f.state] ?? 0) + 1), m), {}),
      files,
    };
  });
}
