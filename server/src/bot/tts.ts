import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config.js';

/**
 * Voice replies: Piper (offline TTS) with the Jordanian Arabic voice "kareem", → OGG/Opus for
 * Telegram. The text is prepared for speaking: no links, markdown or emoji, numbers as words.
 */

const execFileP = promisify(execFile);
const PY = path.join(config.dataDir, 'pyenv', 'bin', 'python');
const VOICE = path.join(config.dataDir, 'tts', 'ar_JO-kareem-medium.onnx');

const ONES = ['صفر', 'واحد', 'اثنين', 'ثلاثة', 'أربعة', 'خمسة', 'ستة', 'سبعة', 'ثمانية', 'تسعة', 'عشرة', 'أحد عشر', 'اثنا عشر', 'ثلاثة عشر', 'أربعة عشر', 'خمسة عشر', 'ستة عشر', 'سبعة عشر', 'ثمانية عشر', 'تسعة عشر'];
const TENS = ['', '', 'عشرين', 'ثلاثين', 'أربعين', 'خمسين', 'ستين', 'سبعين', 'ثمانين', 'تسعين'];
const HUNDREDS = ['', 'مية', 'ميتين', 'ثلاثمية', 'أربعمية', 'خمسمية', 'ستمية', 'سبعمية', 'ثمانمية', 'تسعمية'];

/** Cardinal numbers 0–999 999 999 in Arabic words (spoken style). */
export function numberToArabic(n: number): string {
  if (!Number.isFinite(n) || n < 0 || n >= 1e9) return String(n);
  n = Math.floor(n);
  if (n < 20) return ONES[n];
  if (n < 100) return n % 10 ? `${ONES[n % 10]} و${TENS[Math.floor(n / 10)]}` : TENS[n / 10];
  if (n < 1000) return n % 100 ? `${HUNDREDS[Math.floor(n / 100)]} و${numberToArabic(n % 100)}` : HUNDREDS[n / 100];
  const big = (k: number, one: string, two: string, few: string, many: string, unit: number) => {
    const q = Math.floor(k / unit);
    const r = k % unit;
    const head = q === 1 ? one : q === 2 ? two : q <= 10 ? `${numberToArabic(q)} ${few}` : `${numberToArabic(q)} ${many}`;
    return r ? `${head} و${numberToArabic(r)}` : head;
  };
  if (n < 1e6) return big(n, 'ألف', 'ألفين', 'آلاف', 'ألف', 1000);
  return big(n, 'مليون', 'مليونين', 'ملايين', 'مليون', 1e6);
}

export function speakable(text: string): string {
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/https?:\/\/\S+/g, ' رابط ')
    .replace(/[*_`#>|~]/g, ' ')
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, ' ')
    .replace(/(\d+)[.,](\d+)/g, (_, a: string, b: string) => `${numberToArabic(Number(a))} فاصلة ${numberToArabic(Number(b))}`)
    .replace(/\d+/g, (d) => numberToArabic(Number(d)))
    .replace(/%/g, ' بالمية')
    .replace(/°C|°/g, ' درجة')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1500);
}

export async function speak(text: string): Promise<Buffer> {
  if (!fs.existsSync(VOICE) || !fs.existsSync(PY)) throw new Error('tts_not_installed');
  const say = speakable(text);
  if (!say) throw new Error('nothing_to_say');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-tts-'));
  try {
    const wav = path.join(dir, 'o.wav');
    const ogg = path.join(dir, 'o.ogg');
    await new Promise<void>((resolve, reject) => {
      const p = execFile(PY, ['-m', 'piper', '-m', VOICE, '-f', wav], { timeout: 120_000 }, (e) => (e ? reject(e) : resolve()));
      p.stdin?.end(say);
    });
    await execFileP('ffmpeg', ['-v', 'error', '-nostdin', '-i', wav, '-c:a', 'libopus', '-b:a', '32k', '-ac', '1', ogg], { timeout: 60_000 });
    return fs.readFileSync(ogg);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
