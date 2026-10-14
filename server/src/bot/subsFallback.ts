import fs from 'node:fs';
import zlib from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * Arabic subtitles for films from yifysubtitles.ch, for when OpenSubtitles has none or its 20
 * downloads a day are used up. Every candidate is checked against the film itself: its cue start
 * times must line up with the English subtitle events inside the video (a constant offset is
 * corrected). A film without an English track is only checked for length.
 */

const BASE = 'https://yifysubtitles.ch';
const UA = 'Mozilla/5.0 (X11; Linux x86_64)';
const run = promisify(execFile);

async function get(url: string, referer?: string): Promise<Buffer> {
  const r = await fetch(url, { headers: { 'User-Agent': UA, ...(referer ? { Referer: referer } : {}) }, signal: AbortSignal.timeout(40_000) });
  if (!r.ok) throw new Error(`http_${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

export interface Candidate {
  score: number;
  slug: string;
  name: string;
}
/** The Arabic rows of a film's page, most promising first (BluRay/WEB rips up, cam/telesync down). */
export function parseCandidates(html: string): Candidate[] {
  const out: Candidate[] = [];
  for (const row of html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) ?? []) {
    if (!/arabic/i.test(row)) continue;
    const slug = /href="(\/subtitles\/[^"]+)"/.exec(row)?.[1];
    if (!slug) continue;
    const name = row.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const n = name.toLowerCase();
    let score = +(/rating-cell[^>]*>\s*<span[^>]*>(-?\d+)/.exec(row)?.[1] ?? 0);
    if (/blu-?ray|brrip|bdrip|yify|yts|web-?dl|webrip/.test(n)) score += 20;
    if (/1080p|720p/.test(n)) score += 5;
    if (/\b(cam|hdcam|ts|hdts|tc|hdtc|telesync|hc|korsub)\b/.test(n)) score -= 40;
    out.push({ score, slug, name });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** The biggest .srt in a zip (stored or deflated entries, read from the central directory). */
export function srtFromZip(zip: Buffer): Buffer | null {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) return null;
  const count = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  let best: Buffer | null = null;
  for (let i = 0; i < count && zip.readUInt32LE(at) === 0x02014b50; i++) {
    const method = zip.readUInt16LE(at + 10);
    const csize = zip.readUInt32LE(at + 20);
    const nameLen = zip.readUInt16LE(at + 28);
    const extraLen = zip.readUInt16LE(at + 30);
    const commentLen = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLen).toString();
    at += 46 + nameLen + extraLen + commentLen;
    if (!/\.srt$/i.test(name)) continue;
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(start, start + csize);
    const body = method === 0 ? data : method === 8 ? zlib.inflateRawSync(data) : null;
    if (body && (!best || body.length > best.length)) best = body;
  }
  return best;
}

/** UTF-8 (with or without BOM), else Windows Arabic (cp1256) — most old Arabic subtitles. */
export function decodeSrt(b: Buffer): string {
  if (b[0] === 0xff && b[1] === 0xfe) return b.subarray(2).toString('utf16le');
  const u = new TextDecoder('utf-8', { fatal: true });
  try {
    return u.decode(b).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('windows-1256').decode(b);
  }
}

/** ASS override codes ({\fs30…}) and <font> colours out: Jellyfin would show some of them as text. */
export const cleanSrt = (t: string) =>
  `${t
    .replace(/\r/g, '')
    .replace(/\{[^}]*\}/g, '')
    .replace(/<\/?font[^>]*>/gi, '')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .trim()}\n`;

const TS = /(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/g;
export const cueStarts = (t: string) => [...t.matchAll(TS)].map((m) => +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000);

export function shiftSrt(t: string, d: number): string {
  const fmt = (s: number) => {
    const ms = Math.round(Math.max(0, s) * 1000);
    const p = (n: number, w = 2) => String(n).padStart(w, '0');
    return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
  };
  return t.replace(TS, (_m, a, b, c, e, f, g, h, i) => `${fmt(+a * 3600 + +b * 60 + +c + +e / 1000 + d)} --> ${fmt(+f * 3600 + +g * 60 + +h + +i / 1000 + d)}`);
}

/**
 * Does the subtitle fit the film? With reference events (English subtitles in the video): the
 * median offset to the nearest cue, and how many cues sit within 0.25 s of it. A wrong subtitle
 * lands about 12% there by chance; a matching one 35% or more (Arabic subtitles often merge two
 * English lines). Returns the offset to remove, or null.
 */
export function syncOffset(t: string, ref: number[], runtimeSec: number): number | null {
  const cues = cueStarts(t);
  if (cues.length < 100) return null;
  if (ref.length >= 15) {
    const early = cues.filter((c) => c < 1300);
    if (!early.length) return null;
    const diffs = ref.map((r) => early.reduce((best, c) => (Math.abs(c - r) < Math.abs(best - r) ? c : best), early[0]) - r);
    const sorted = [...diffs].sort((a, b) => a - b);
    const d = sorted[Math.floor(sorted.length / 2)];
    const ok = diffs.filter((x) => Math.abs(x - d) < 0.25).length / diffs.length;
    return ok >= 0.3 && Math.abs(d) < 30 ? d : null;
  }
  const last = cues[cues.length - 1];
  return runtimeSec && last > runtimeSec * 0.8 && last < runtimeSec + 60 ? 0 : null;
}

/** Start times of the video's English subtitle events in its first 20 minutes. */
async function referenceEvents(video: string): Promise<number[]> {
  try {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', video], { maxBuffer: 8 << 20, timeout: 60_000 });
    const streams = ((JSON.parse(stdout) as { streams?: { index: number; codec_type: string; codec_name: string; tags?: Record<string, string> }[] }).streams ?? []).filter(
      (s) => s.codec_type === 'subtitle' && ['eng', 'en', 'und', undefined].includes(s.tags?.language),
    );
    const s = streams.find((x) => !/forced/i.test(x.tags?.title ?? '')) ?? streams[0];
    if (!s) return [];
    const { stdout: pk } = await run('ffprobe', ['-v', 'error', '-select_streams', String(s.index), '-read_intervals', '%+1200', '-show_entries', 'packet=pts_time,size', '-of', 'csv=p=0', video], {
      maxBuffer: 8 << 20,
      timeout: 600_000,
    });
    return pk
      .split('\n')
      .map((l) => l.split(','))
      .filter(([t, size]) => t && t !== 'N/A' && (s.codec_name !== 'hdmv_pgs_subtitle' || +size >= 100)) // PGS "clear" packets
      .map(([t]) => +t);
  } catch {
    return [];
  }
}

/** Finds, checks and writes `<video>.ar.srt`. Returns the subtitle's name, or null if none fit. */
export async function fetchArabicFallback(imdb: string, video: string, runtimeSec: number): Promise<string | null> {
  const page = (await get(`${BASE}/movie-imdb/${encodeURIComponent(imdb)}`)).toString();
  const cands = parseCandidates(page).slice(0, 6);
  if (!cands.length) return null;
  const ref = await referenceEvents(video);
  for (const c of cands) {
    try {
      const subPage = (await get(BASE + c.slug)).toString();
      // The zip's name isn't always the page's (iron-man-three → iron-man-3): take it from the page.
      const zipPath = /href="(\/subtitle\/[^"]+\.zip)"/.exec(subPage)?.[1] ?? `${c.slug.replace('/subtitles/', '/subtitle/')}.zip`;
      const srt = srtFromZip(await get(BASE + zipPath, BASE + c.slug));
      if (!srt) continue;
      let t = cleanSrt(decodeSrt(srt));
      const d = syncOffset(t, ref, runtimeSec);
      if (d === null) continue;
      if (Math.abs(d) > 0.3) t = shiftSrt(t, -d);
      fs.writeFileSync(video.replace(/\.[^.]+$/, '.ar.srt'), t);
      return c.name;
    } catch {
      // next candidate
    }
  }
  return null;
}
