import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { checkUrl } from '../downloads/downloads.js';
import { ytDlpAuthArgs } from '../downloads/ytDlpAuth.js';
import { transcribe } from './bot.js';

/**
 * "Summarize this video": the spoken text of a video (YouTube and most sites) for the model —
 * its subtitles (Arabic or English, original first), or, for videos up to 10 minutes without
 * subtitles, its audio transcribed locally. Nothing is kept.
 */

const execFileP = promisify(execFile);
const MAX_CHARS = 20000;

/** WebVTT → plain text; auto-captions repeat each line as it scrolls, so consecutive repeats go. */
export function vttToText(vtt: string): string {
  const out: string[] = [];
  for (const raw of vtt.split(/\r?\n/)) {
    const line = raw
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .trim();
    if (!line || line === 'WEBVTT' || /^(Kind|Language|NOTE|STYLE|Region):?/.test(line) || /-->/.test(line) || /^\d+$/.test(line)) continue;
    if (out[out.length - 1] !== line) out.push(line);
  }
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

export async function videoText(raw: string) {
  const url = (await checkUrl(raw)).toString();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-vt-'));
  try {
    const { stdout } = await execFileP(config.ytDlp, ['--js-runtimes', 'node', ...ytDlpAuthArgs(), '--no-playlist', '--no-simulate', '--skip-download', '--write-subs', '--write-auto-subs', '--sub-langs', 'ar,ar-orig,en,en-orig', '--sub-format', 'vtt', '--print', '%(title)s\t%(channel,uploader)s\t%(duration)s', '-o', path.join(dir, 's.%(ext)s'), '--', url], { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 }).catch((e: { stdout?: string; stderr?: string }) => {
      // Some subtitle variants may fail (429) while others were written: keep going if we got the info line.
      if (e.stdout) return { stdout: e.stdout };
      throw new Error((e.stderr ?? '').split('\n').find((l) => l.startsWith('ERROR')) ?? 'yt-dlp failed');
    });
    const [title = '', channel = '', dur = ''] = stdout.trim().split('\n')[0].split('\t');
    const duration = Number(dur) || null;
    const vtts = fs.readdirSync(dir).filter((f) => f.endsWith('.vtt'));
    const pick = vtts.find((f) => /\.ar(-orig)?\.vtt$/.test(f)) ?? vtts.find((f) => /\.en(-orig)?\.vtt$/.test(f)) ?? vtts[0];
    let text = '';
    let source: 'subtitles' | 'speech' | 'none' = 'none';
    let language: string | null = null;
    if (pick) {
      text = vttToText(fs.readFileSync(path.join(dir, pick), 'utf8'));
      source = 'subtitles';
      language = /\.([\w-]+)\.vtt$/.exec(pick)?.[1] ?? null;
    } else if (duration && duration <= 600) {
      await execFileP(config.ytDlp, ['--js-runtimes', 'node', ...ytDlpAuthArgs(), '--no-playlist', '-f', 'bestaudio/best', '-o', path.join(dir, 'a.%(ext)s'), '--', url], {
        timeout: 300_000,
      });
      const audio = fs.readdirSync(dir).find((f) => f.startsWith('a.'));
      if (audio) {
        text = await transcribe(fs.readFileSync(path.join(dir, audio)));
        source = 'speech';
      }
    }
    return {
      title,
      channel,
      durationMin: duration ? Math.round(duration / 6) / 10 : null,
      source,
      language,
      text: text.slice(0, MAX_CHARS),
      truncated: text.length > MAX_CHARS,
      note: source === 'none' ? 'No subtitles, and too long to transcribe (over 10 minutes).' : undefined,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
