import { execFile, spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/sessions.js';
import { jf } from '../bot/mediaLibrary.js';
import { postHook } from '../bot/hook.js';
import { config } from '../config.js';
import { getDb } from '../db.js';
import { checkUrl } from './downloads.js';
import { deleteYtDlpCookies, saveYtDlpCookies, ytDlpAuthArgs, ytDlpCookieStatus } from './ytDlpAuth.js';

const execFileP = promisify(execFile);
const MAX_ITEMS = 500;
const MIN_FREE = 5 * 1024 ** 3;
const VIDEO_ROOT = () => path.join(config.mediaRoot, 'Downloads', 'Video');
const MEDIA_ROOT = () => path.join(config.mediaRoot, 'Media');

type JobStatus = 'queued' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled';
type ItemStatus = 'queued' | 'running' | 'done' | 'skipped' | 'failed';
type Library = 'series' | 'arabic_series' | 'foreign_series' | 'videos';
type Quality = 'best' | '1080' | '720';

interface DbJob {
  id: number;
  url: string;
  title: string;
  library: Library;
  season: number;
  quality: Quality;
  subtitles: number;
  range_start: number | null;
  range_end: number | null;
  status: JobStatus;
  progress: string | null;
  output_dir: string | null;
  error: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

interface DbItem {
  id: number;
  job_id: number;
  source_id: string;
  position: number;
  source_position: number | null;
  title: string;
  duration: number | null;
  status: ItemStatus;
  progress: string | null;
  path: string | null;
  size: number | null;
  error: string | null;
}

export interface VideoAnalysisItem {
  id: string;
  position: number;
  title: string;
  duration: number | null;
  url: string | null;
}

export interface VideoAnalysis {
  url: string;
  title: string;
  uploader: string | null;
  playlist: boolean;
  count: number;
  truncated: boolean;
  items: VideoAnalysisItem[];
}

export interface SelectedVideoItem extends VideoAnalysisItem {
  sourcePosition: number;
}

interface YtEntry {
  id?: string;
  title?: string;
  duration?: number;
  url?: string;
  webpage_url?: string;
}

interface YtInfo extends YtEntry {
  entries?: Array<YtEntry | null>;
  uploader?: string;
  channel?: string;
  playlist_count?: number;
}

const active = new Map<number, { child: ChildProcess; current: string | null; cancelled: boolean }>();

/** A filesystem segment supplied by the owner: Unicode stays readable, traversal/control chars do not. */
export function safeSegment(raw: string, fallback = 'Video'): string {
  const value = raw
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:\.\s*)+|\.+$/g, '')
    .trim()
    .slice(0, 120);
  return value || (fallback === 'Video' ? 'Video' : safeSegment(fallback, 'Video'));
}

function n(value: unknown, min: number, max: number): number | null {
  if (value === null || value === undefined || value === '') return null;
  const x = Math.trunc(Number(value));
  return Number.isFinite(x) && x >= min && x <= max ? x : null;
}

export async function analyzeVideo(raw: string): Promise<VideoAnalysis> {
  const url = (await checkUrl(raw)).toString();
  const { stdout } = await execFileP(config.ytDlp, ['--js-runtimes', 'node', ...ytDlpAuthArgs(), '--flat-playlist', '--dump-single-json', '--no-warnings', '--playlist-end', String(MAX_ITEMS + 1), '--', url], {
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, PATH: `/usr/bin:/bin:${process.env.PATH ?? ''}` },
  }).catch((e: { stderr?: string }) => {
    const message =
      (e.stderr ?? '')
        .split('\n')
        .find((line) => line.startsWith('ERROR:'))
        ?.replace(/^ERROR:\s*/, '') ?? 'Could not read this video link';
    throw new Error(message.slice(0, 300));
  });
  const info = JSON.parse(stdout) as YtInfo;
  const source = Array.isArray(info.entries) ? info.entries.filter((x): x is YtEntry => !!x) : [info];
  const truncated = source.length > MAX_ITEMS || (Number(info.playlist_count) || 0) > MAX_ITEMS;
  const items = source.slice(0, MAX_ITEMS).map((entry, i) => ({
    id: String(entry.id ?? `item-${i + 1}`),
    position: i + 1,
    title: String(entry.title ?? `Episode ${i + 1}`).slice(0, 300),
    duration: Number(entry.duration) > 0 ? Math.round(Number(entry.duration)) : null,
    url: entry.webpage_url ?? (/^https?:/.test(String(entry.url ?? '')) ? String(entry.url) : null),
  }));
  if (!items.length) throw new Error('No downloadable videos found');
  return {
    url,
    title: String(info.title ?? items[0].title).slice(0, 300),
    uploader: info.uploader ?? info.channel ?? null,
    playlist: Array.isArray(info.entries),
    count: Math.max(items.length, Number(info.playlist_count) || 0),
    truncated,
    items,
  };
}

const setJob = (id: number, patch: Partial<DbJob>) => {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  getDb()
    .prepare(`UPDATE video_download_jobs SET ${keys.map((key) => `${key} = ?`).join(', ')} WHERE id = ?`)
    .run(...keys.map((key) => (patch as Record<string, unknown>)[key] as string | number | null), id);
};

const setItem = (jobId: number, sourceId: string, patch: Partial<DbItem>) => {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  getDb()
    .prepare(`UPDATE video_download_items SET ${keys.map((key) => `${key} = ?`).join(', ')} WHERE job_id = ? AND source_id = ?`)
    .run(...keys.map((key) => (patch as Record<string, unknown>)[key] as string | number | null), jobId, sourceId);
};

function itemRows(jobId: number): DbItem[] {
  return getDb().prepare('SELECT * FROM video_download_items WHERE job_id = ? ORDER BY position').all(jobId) as unknown as DbItem[];
}

function publicJob(job: DbJob) {
  const items = itemRows(job.id);
  return {
    id: job.id,
    url: job.url,
    title: job.title,
    library: job.library,
    season: job.season,
    quality: job.quality,
    subtitles: !!job.subtitles,
    rangeStart: job.range_start,
    rangeEnd: job.range_end,
    status: job.status,
    progress: job.progress,
    outputDir: job.output_dir,
    error: job.error,
    createdAt: job.created_at,
    startedAt: job.started_at,
    finishedAt: job.finished_at,
    counts: items.reduce<Record<string, number>>((out, item) => ({ ...out, [item.status]: (out[item.status] ?? 0) + 1 }), {}),
    items: items.map((item) => ({
      id: item.source_id,
      position: item.position,
      sourcePosition: item.source_position ?? item.position,
      title: item.title,
      duration: item.duration,
      status: item.status,
      progress: item.progress,
      file: item.path ? path.basename(item.path) : null,
      size: item.size,
      error: item.error,
    })),
  };
}

function getJob(id: number): DbJob | undefined {
  return getDb().prepare('SELECT * FROM video_download_jobs WHERE id = ?').get(id) as DbJob | undefined;
}

export function listVideoJobs(limit = 20) {
  return (getDb().prepare('SELECT * FROM video_download_jobs ORDER BY id DESC LIMIT ?').all(limit) as unknown as DbJob[]).map(publicJob);
}

function outputFor(job: DbJob) {
  const title = safeSegment(job.title, 'Series');
  if (job.library !== 'videos') {
    const season = String(job.season).padStart(2, '0');
    // `series` is the legacy value used before the Arabic/foreign shelves were split.
    const shelf = job.library === 'foreign_series' ? 'Foreign Series' : 'Arabic Series';
    const dir = path.join(MEDIA_ROOT(), shelf, title, `Season ${season}`);
    return {
      dir,
      template: path.join(dir.replace(/%/g, '%%'), '%(id)s.%(ext)s'),
    };
  }
  const dir = path.join(MEDIA_ROOT(), 'Videos', title);
  return {
    dir,
    template: path.join(dir.replace(/%/g, '%%'), '%(id)s.%(ext)s'),
  };
}

export function finalStem(job: Pick<DbJob, 'title' | 'library' | 'season'>, item: Pick<DbItem, 'position' | 'title' | 'source_id'>): string {
  const itemTitle = safeSegment(item.title, `Episode ${item.position}`);
  if (job.library !== 'videos') {
    return `${safeSegment(job.title, 'Series')} - S${String(job.season).padStart(2, '0')}E${String(item.position).padStart(2, '0')} - ${itemTitle} [${safeSegment(item.source_id, 'source')}]`;
  }
  return `${String(item.position).padStart(3, '0')} - ${itemTitle} [${safeSegment(item.source_id, 'source')}]`;
}

function renameCompleted(job: DbJob, sourceId: string, currentPath: string): string {
  const item = getDb().prepare('SELECT * FROM video_download_items WHERE job_id = ? AND source_id = ?').get(job.id, sourceId) as DbItem | undefined;
  if (!item || !fs.existsSync(currentPath)) return currentPath;
  const dir = path.dirname(currentPath);
  const currentStem = path.basename(currentPath, path.extname(currentPath));
  const targetStem = finalStem(job, item);
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith(`${currentStem}.`)) continue;
    const from = path.join(dir, name);
    const to = path.join(dir, `${targetStem}${name.slice(currentStem.length)}`);
    if (from !== to && !fs.existsSync(to)) fs.renameSync(from, to);
  }
  return path.join(dir, `${targetStem}${path.extname(currentPath)}`);
}

function formatFor(quality: Quality): string {
  if (quality === '720') return 'bv*[height<=720]+ba/b[height<=720]/b';
  if (quality === 'best') return 'bv*+ba/b';
  return 'bv*[height<=1080]+ba/b[height<=1080]/b';
}

function parseLines(stream: NodeJS.ReadableStream, onLine: (line: string) => void) {
  let buffer = '';
  stream.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    lines.forEach(onLine);
  });
  stream.on('end', () => buffer && onLine(buffer));
}

function cleanupTemp(id: number) {
  const dir = path.join(VIDEO_ROOT(), '.incomplete', `job-${id}`);
  if (dir.startsWith(`${VIDEO_ROOT()}${path.sep}`)) fs.rmSync(dir, { recursive: true, force: true });
}

function runJob(job: DbJob) {
  const free = fs.statfsSync(config.mediaRoot).bavail * fs.statfsSync(config.mediaRoot).bsize;
  if (free < MIN_FREE) {
    setJob(job.id, {
      status: 'failed',
      error: 'Less than 5 GB free on the media drive',
      finished_at: Date.now(),
    });
    setImmediate(pump);
    return;
  }
  const { dir, template } = outputFor(job);
  const temp = path.join(VIDEO_ROOT(), '.incomplete', `job-${job.id}`);
  const archiveDir = path.join(VIDEO_ROOT(), '.archive');
  const archive = path.join(archiveDir, `${crypto.createHash('sha256').update(job.url).digest('hex')}.txt`);
  const items = itemRows(job.id);
  const playlistItems = items.map((item) => item.source_position ?? item.position).join(',');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(temp, { recursive: true });
  fs.mkdirSync(archiveDir, { recursive: true });
  const args = ['--js-runtimes', 'node', ...ytDlpAuthArgs(), '--yes-playlist', '--newline', '--progress', '--no-colors', '--continue', '--no-overwrites', '--no-mtime', '--download-archive', archive, '--paths', `temp:${temp}`, '-P', `home:${dir}`, '-o', template, '--playlist-items', playlistItems, '--autonumber-start', '1', '--merge-output-format', 'mkv', '-f', formatFor(job.quality), '--progress-template', 'download:PROG\t%(info.id)s\t%(progress._percent_str)s of %(progress._total_bytes_str)s%(progress._total_bytes_estimate_str)s at %(progress._speed_str)s ETA %(progress._eta_str)s', '--print', 'before_dl:ITEM\t%(id)s\t%(playlist_index,autonumber)s\t%(title)s', '--print', 'after_move:DONEITEM\t%(id)s\t%(filepath)s', ...(job.subtitles ? ['--write-subs', '--write-auto-subs', '--sub-langs', 'ar.*,ar,en.*,en', '--sub-format', 'srt/vtt/best', '--convert-subs', 'srt'] : []), '--', job.url];
  const child = spawn(config.ytDlp, args, {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PATH: `/usr/bin:/bin:${process.env.PATH ?? ''}` },
  });
  const state = { child, current: null as string | null, cancelled: false };
  active.set(job.id, state);
  setJob(job.id, {
    status: 'running',
    progress: 'Starting…',
    output_dir: dir,
    error: null,
    started_at: Date.now(),
    finished_at: null,
  });
  let error = '';
  let lastSave = 0;
  const onLine = (line: string) => {
    const [kind, sourceId, value] = line.split('\t');
    if (kind === 'ITEM' && sourceId) {
      state.current = sourceId;
      setItem(job.id, sourceId, {
        status: 'running',
        progress: 'Starting…',
        error: null,
      });
    } else if (kind === 'DONEITEM' && sourceId && value) {
      const exists = fs.existsSync(value);
      const finalPath = exists ? renameCompleted(job, sourceId, value) : value;
      const finalExists = fs.existsSync(finalPath);
      setItem(job.id, sourceId, {
        status: finalExists ? 'done' : 'failed',
        progress: null,
        path: finalExists ? finalPath : null,
        size: finalExists ? fs.statSync(finalPath).size : null,
        error: finalExists ? null : 'Output file missing',
      });
      state.current = null;
    } else if (kind === 'PROG' && sourceId && Date.now() - lastSave > 1000) {
      lastSave = Date.now();
      const progress = line.split('\t').slice(2).join(' ').replace(/NA/g, '').replace(/\s+/g, ' ').trim();
      setJob(job.id, { progress });
      setItem(job.id, sourceId, { status: 'running', progress });
    } else if (/^ERROR:/.test(line)) error = line.replace(/^ERROR:\s*/, '').slice(0, 500);
  };
  parseLines(child.stdout!, onLine);
  parseLines(child.stderr!, onLine);
  const timeout = setTimeout(() => {
    error = 'Download exceeded 24 hours';
    try {
      process.kill(-child.pid!, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }, 24 * 3600_000);
  child.once('error', (e) => {
    error = e.message;
  });
  child.once('close', (code) => {
    clearTimeout(timeout);
    active.delete(job.id);
    const now = Date.now();
    if (state.cancelled) {
      setJob(job.id, {
        status: 'cancelled',
        progress: null,
        error: null,
        finished_at: now,
      });
      if (state.current)
        setItem(job.id, state.current, {
          status: 'failed',
          progress: null,
          error: 'Cancelled',
        });
      cleanupTemp(job.id);
    } else if (code === 0) {
      getDb().prepare("UPDATE video_download_items SET status = 'skipped', progress = NULL WHERE job_id = ? AND status IN ('queued', 'running')").run(job.id);
      setJob(job.id, {
        status: 'done',
        progress: null,
        error: null,
        finished_at: now,
      });
      cleanupTemp(job.id);
      void jf('/Library/Refresh', { method: 'POST' }).catch(() => {});
      void postHook({
        type: 'notice',
        text: `🎬 <b>${job.title}</b> خلص تنزيله وصار بـ Jellyfin`,
      }).catch(() => {});
    } else {
      if (state.current)
        setItem(job.id, state.current, {
          status: 'failed',
          progress: null,
          error: error || `yt-dlp exited with ${code}`,
        });
      setJob(job.id, {
        status: 'failed',
        progress: null,
        error: error || `yt-dlp exited with ${code}`,
        finished_at: now,
      });
    }
    setImmediate(pump);
  });
}

function pump() {
  if (active.size) return;
  const job = getDb().prepare("SELECT * FROM video_download_jobs WHERE status = 'queued' ORDER BY id LIMIT 1").get() as DbJob | undefined;
  if (job) runJob(job);
}

function recover() {
  getDb().prepare("UPDATE video_download_jobs SET status = 'queued', progress = NULL WHERE status = 'running'").run();
  getDb().prepare("UPDATE video_download_items SET status = 'queued', progress = NULL WHERE status = 'running'").run();
  setImmediate(pump);
}

async function createJob(body: Record<string, unknown>) {
  const analysis = await analyzeVideo(String(body.url ?? ''));
  const library: Library = body.library === 'videos' || body.library === 'foreign_series' ? body.library : 'arabic_series';
  const season = n(body.season, 1, 99) ?? 1;
  const quality: Quality = body.quality === 'best' || body.quality === '720' ? body.quality : '1080';
  const start = n(body.start, 1, MAX_ITEMS);
  const requestedEnd = n(body.end, 1, MAX_ITEMS);
  if (body.start !== null && body.start !== undefined && body.start !== '' && !start) throw new Error(`The first episode must be between 1 and ${MAX_ITEMS}`);
  if (body.end !== null && body.end !== undefined && body.end !== '' && !requestedEnd) throw new Error(`The last episode must be between 1 and ${MAX_ITEMS}`);
  const end = requestedEnd ?? (analysis.truncated ? analysis.items.length : null);
  if (start && end && start > end) throw new Error('The first episode must be before the last episode');
  const title = safeSegment(String(body.title ?? analysis.title), analysis.title);
  const selected = selectVideoItems(analysis.items, body.items, start, end);
  const db = getDb();
  const added = db.prepare("INSERT INTO video_download_jobs(url, title, library, season, quality, subtitles, range_start, range_end, status, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)").run(analysis.url, title, library, season, quality, body.subtitles === false ? 0 : 1, start, end, Date.now());
  const id = Number(added.lastInsertRowid);
  const insert = db.prepare("INSERT INTO video_download_items(job_id, source_id, position, source_position, title, duration, status) VALUES(?, ?, ?, ?, ?, ?, 'queued')");
  db.exec('BEGIN');
  try {
    for (const item of selected) insert.run(id, item.id, item.position, item.sourcePosition, item.title, item.duration);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    db.prepare('DELETE FROM video_download_jobs WHERE id = ?').run(id);
    throw e;
  }
  setImmediate(pump);
  return publicJob(getJob(id)!);
}

export function selectVideoItems(items: VideoAnalysisItem[], requested: unknown, start: number | null = null, end: number | null = null): SelectedVideoItem[] {
  if (requested === undefined) {
    return items.filter((item) => (!start || item.position >= start) && (!end || item.position <= end)).map((item) => ({ ...item, sourcePosition: item.position }));
  }
  if (!Array.isArray(requested) || requested.length < 1 || requested.length > MAX_ITEMS) throw new Error('Select at least one video');
  const seen = new Set<number>();
  const chosen = requested.map((raw) => {
    if (!raw || typeof raw !== 'object') throw new Error('Invalid video selection');
    const entry = raw as Record<string, unknown>;
    const sourcePosition = n(entry.position, 1, MAX_ITEMS);
    if (!sourcePosition || seen.has(sourcePosition)) throw new Error('Invalid or duplicate video selection');
    const source = items.find((item) => item.position === sourcePosition);
    if (!source || String(entry.id ?? '') !== source.id) throw new Error('The playlist changed; analyze it again');
    seen.add(sourcePosition);
    return {
      ...source,
      title: safeSegment(String(entry.title ?? source.title), source.title),
      sourcePosition,
    };
  });
  return chosen.sort((a, b) => a.sourcePosition - b.sourcePosition).map((item, index) => ({ ...item, position: index + 1 }));
}

function signal(id: number, signal: NodeJS.Signals) {
  const running = active.get(id);
  if (!running?.child.pid) return false;
  try {
    process.kill(-running.child.pid, signal);
    return true;
  } catch {
    return false;
  }
}

export async function videoDownloadRoutes(app: FastifyInstance) {
  if (!process.env.VITEST) recover();
  app.get('/api/video-downloads/cookies', { preHandler: requireAuth }, async () => ytDlpCookieStatus());
  app.post('/api/video-downloads/browser-login', { preHandler: requireAuth, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (_req, reply) => {
    if (!config.ytDlpBrowserContainer || !config.ytDlpBrowserUrl || !config.ytDlpBrowserProfile) return reply.code(503).send({ error: 'browser_unavailable' });
    try {
      await execFileP('docker', ['exec', '-u', 'abc', '-e', 'DISPLAY=:1', config.ytDlpBrowserContainer, '/usr/lib/chromium/chromium', '--no-sandbox', '--password-store=basic', '--user-data-dir=/config/.config/chromium', '--new-tab', 'https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2F'], { timeout: 10_000, maxBuffer: 256 * 1024 });
      return { ...ytDlpCookieStatus(), url: config.ytDlpBrowserUrl };
    } catch {
      return reply.code(503).send({ error: 'browser_unavailable' });
    }
  });
  app.post(
    '/api/video-downloads/cookies',
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      try {
        const file = await req.file({
          limits: { files: 1, fileSize: 2 * 1024 * 1024 },
        });
        if (!file) return reply.code(400).send({ error: 'cookie_file_required' });
        return saveYtDlpCookies(await file.toBuffer());
      } catch (e) {
        return reply.code(422).send({ error: (e as Error).message || 'invalid_cookie_file' });
      }
    },
  );
  app.post('/api/video-downloads/cookies/delete', { preHandler: requireAuth }, async () => deleteYtDlpCookies());
  app.post<{ Body: { url?: string } }>(
    '/api/video-downloads/analyze',
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      try {
        return await analyzeVideo(String(req.body?.url ?? ''));
      } catch (e) {
        return reply.code(422).send({ error: (e as Error).message });
      }
    },
  );
  app.get('/api/video-downloads', { preHandler: requireAuth }, async () => ({
    jobs: listVideoJobs(20),
  }));
  app.post<{ Body: Record<string, unknown> }>(
    '/api/video-downloads',
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      try {
        return await createJob(req.body ?? {});
      } catch (e) {
        return reply.code(422).send({ error: (e as Error).message });
      }
    },
  );
  app.post<{ Params: { id: string; action: string } }>('/api/video-downloads/:id/:action', { preHandler: requireAuth }, async (req, reply) => {
    const id = Number(req.params.id);
    const job = getJob(id);
    if (!job) return reply.code(404).send({ error: 'not_found' });
    if (req.params.action === 'pause' && job.status === 'running' && signal(id, 'SIGSTOP')) setJob(id, { status: 'paused', progress: job.progress });
    else if (req.params.action === 'resume' && job.status === 'paused' && signal(id, 'SIGCONT')) setJob(id, { status: 'running' });
    else if (req.params.action === 'retry' && (job.status === 'failed' || job.status === 'cancelled')) {
      setJob(id, {
        status: 'queued',
        error: null,
        progress: null,
        finished_at: null,
      });
      getDb().prepare("UPDATE video_download_items SET status = 'queued', progress = NULL, error = NULL WHERE job_id = ? AND status = 'failed'").run(id);
      setImmediate(pump);
    } else if (req.params.action === 'cancel' && (job.status === 'queued' || job.status === 'paused' || job.status === 'running')) {
      const running = active.get(id);
      if (running) {
        running.cancelled = true;
        signal(id, 'SIGCONT');
        signal(id, 'SIGTERM');
      } else {
        setJob(id, {
          status: 'cancelled',
          progress: null,
          finished_at: Date.now(),
        });
        cleanupTemp(id);
      }
    } else return reply.code(409).send({ error: 'invalid_state' });
    return { ok: true };
  });
  app.addHook('onClose', async () => {
    for (const [id, running] of active) {
      running.cancelled = false;
      signal(id, 'SIGCONT');
      signal(id, 'SIGTERM');
    }
  });
}
