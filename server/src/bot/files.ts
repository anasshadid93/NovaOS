import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { fileIndex, invalidateIndex, libraryDir, safeFileName, uniquePath } from '../files/files.js';
import { mkdir, relOf, resolveInRoot, transfer, validName } from '../files/fsops.js';
import { createShareFor } from '../share/share.js';
import { postHook } from './hook.js';

/**
 * Files for the assistant: find by name, send to Telegram (small files as a document, big ones as
 * a share link), save what the owner sends to the bot (files/Telegram), and read documents as text so
 * the model can summarize or translate them.
 */

const execFileP = promisify(execFile);
const TELEGRAM_MAX = 45 * 1024 * 1024;
const PY = path.join(config.dataDir, 'pyenv', 'bin', 'python');

const hidden = (rel: string) => rel.split('/').some((p) => p.startsWith('.')) || rel.startsWith('apps/');

export async function findFiles(q: string, limit = 15) {
  const words = q
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length >= 2);
  if (!words.length) return { files: [] };
  const { files } = await fileIndex();
  const hits = files
    .filter((f) => !hidden(f.path))
    .map((f) => {
      const name = path.basename(f.path).toLowerCase();
      const full = f.path.toLowerCase();
      let score = 0;
      for (const w of words) score += name.includes(w) ? 3 : full.includes(w) ? 1 : -10;
      return { f, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.f.mtime - a.f.mtime)
    .slice(0, limit);
  return {
    files: hits.map(({ f }) => ({ path: f.path, name: path.basename(f.path), sizeMB: Math.round((f.size / 1024 ** 2) * 10) / 10, modified: new Date(f.mtime).toISOString().slice(0, 10), type: f.cat })),
  };
}

function checkPath(rel: string): { abs: string; rel: string; size: number } {
  const abs = resolveInRoot(rel);
  const r = relOf(abs);
  if (hidden(r)) throw new Error('not_allowed');
  const st = fs.statSync(abs);
  if (!st.isFile()) throw new Error('not_a_file');
  return { abs, rel: r, size: st.size };
}

export const rawFile = (rel: string) => checkPath(rel).abs;

/** Small file → the assistant's inbox sends it as a document; big file → a 7-day link. */
export async function sendFile(rel: string) {
  const f = checkPath(rel);
  const name = path.basename(f.rel);
  if (f.size <= TELEGRAM_MAX) {
    const ok = await postHook({ type: 'send_file', path: f.rel, name, sizeMB: Math.round((f.size / 1024 ** 2) * 10) / 10 });
    return { ok, sent: 'document', name };
  }
  const url = createShareFor(f.rel, 7);
  await postHook({ type: 'notice', text: `📎 <b>${name.replace(/[<>&]/g, '')}</b> كبير على Telegram (${Math.round(f.size / 1024 ** 2)} MB)، هاد رابطه (7 أيام):\n${url}` });
  return { ok: true, sent: 'link', name, url };
}

export function shareLink(rel: string, days = 7) {
  const abs = resolveInRoot(rel);
  if (hidden(relOf(abs))) throw new Error('not_allowed');
  return { url: createShareFor(relOf(abs), Math.min(Math.max(days, 1), 90)) };
}

const EXTRACT_PY = `
import sys, zipfile, re, html
p = sys.argv[1]; ext = p.lower().rsplit('.', 1)[-1]
out = ''
try:
    if ext == 'pdf':
        from pypdf import PdfReader
        r = PdfReader(p)
        out = '\\n'.join((pg.extract_text() or '') for pg in r.pages[:60])
    elif ext in ('docx', 'pptx', 'xlsx', 'odt'):
        z = zipfile.ZipFile(p)
        names = [n for n in z.namelist() if re.match(r'(word/document|ppt/slides/slide\\d+|xl/sharedStrings|content)\\.xml$', n)]
        for n in sorted(names):
            x = z.read(n).decode('utf8', 'ignore')
            x = re.sub(r'</(w:p|a:p|text:p|si)>', '\\n', x)
            out += html.unescape(re.sub(r'<[^>]+>', '', x)) + '\\n'
except Exception as e:
    out = ''
sys.stdout.write(out[:20000])
`;

/** Text of a document (PDF, Word/PowerPoint/Excel, plain text), at most 15 000 characters. */
export async function extractText(abs: string): Promise<string> {
  const ext = path.extname(abs).slice(1).toLowerCase();
  if (['txt', 'md', 'csv', 'json', 'log', 'xml', 'html', 'htm', 'srt', 'vtt'].includes(ext)) return fs.readFileSync(abs, 'utf8').slice(0, 15000);
  if (!['pdf', 'docx', 'pptx', 'xlsx', 'odt'].includes(ext) || !fs.existsSync(PY)) return '';
  try {
    const { stdout } = await execFileP(PY, ['-I', '-c', EXTRACT_PY, abs], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    return stdout.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, 15000);
  } catch {
    return '';
  }
}

/** What a file really is, from its first bytes (phones sometimes send a DWG named IMG_….jpg). */
export function sniffType(b: Buffer): { ext: string; image: boolean } | null {
  const head = b.subarray(0, 16).toString('latin1');
  if (/^AC10\d\d/.test(head)) return { ext: 'dwg', image: false };
  if (head.startsWith('%PDF')) return { ext: 'pdf', image: false };
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: 'jpg', image: true };
  if (head.startsWith('\x89PNG')) return { ext: 'png', image: true };
  if (head.startsWith('GIF8')) return { ext: 'gif', image: true };
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return { ext: 'webp', image: true };
  if (head.slice(4, 8) === 'ftyp' && /hei[cfx]|mif1|avif/.test(head.slice(8, 12))) return { ext: head.slice(8, 12) === 'avif' ? 'avif' : 'heic', image: true };
  if (/^\s*0\s*\r?\n\s*SECTION/.test(b.subarray(0, 64).toString('latin1'))) return { ext: 'dxf', image: false };
  return null;
}

/** Give a file the extension of what it really is, when its name claims something else. */
function trueName(name: string, body: Buffer): string {
  const t = sniffType(body);
  if (!t) return name;
  const ext = path.extname(name).slice(1).toLowerCase();
  const same = ext === t.ext || (t.ext === 'jpg' && ext === 'jpeg') || (t.ext === 'heic' && ext === 'heif');
  return same ? name : `${name.slice(0, name.length - (ext ? ext.length + 1 : 0))}.${t.ext}`;
}

/** Something the owner sent to the bot → files/Telegram (never overwrites), plus its text if it is a document. */
export async function saveIncoming(body: Buffer, rawName: string) {
  const dir = libraryDir('Telegram');
  fs.mkdirSync(dir, { recursive: true });
  const name = trueName(safeFileName(rawName || `telegram-${Date.now()}`), body);
  const abs = uniquePath(dir, name);
  fs.writeFileSync(abs, body, { mode: 0o644 });
  invalidateIndex();
  const rel = relOf(abs);
  const text = await extractText(abs);
  return { path: rel, name: path.basename(abs), sizeMB: Math.round((body.length / 1024 ** 2) * 10) / 10, filesUrl: `${config.publicOrigin}/files?path=${encodeURIComponent(path.posix.dirname(rel))}`, text, textChars: text.length };
}

/** A smaller JPEG of an image (long side ≤ 1600 px) for the vision model: big phone photos sent
 *  "as a file" (6+ MB, 4000+ px) make the model fail to load them. */
export async function fitImage(body: Buffer): Promise<Buffer> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-fit-'));
  try {
    const src = path.join(dir, 'in');
    const out = path.join(dir, 'out.jpg');
    fs.writeFileSync(src, body);
    const scale = "scale='if(gt(iw,ih),min(1600,iw),-2)':'if(gt(iw,ih),-2,min(1600,ih))'";
    await execFileP('ffmpeg', ['-v', 'error', '-nostdin', '-i', src, '-frames:v', '1', '-vf', scale, '-q:v', '3', '-y', out], { timeout: 30_000 });
    return fs.readFileSync(out);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Move (or copy) a file from the owner's library into a folder of it, e.g. "CAD" or "Documents/Projects/MEMCO".
 *  Only inside files/; the folder is created when missing; never overwrites; can rename on the way. */
export async function fileTo(input: { path?: string; folder?: string; mode?: string; name?: string }) {
  const rel = String(input.path ?? '').replace(/^\/+/, '');
  if (!rel.startsWith('files/') || hidden(rel)) throw new Error('path must be a file in files/ (use find_files first)');
  const src = resolveInRoot(rel);
  if (!fs.statSync(src).isFile()) throw new Error('not_a_file');
  const parts = String(input.folder ?? '')
    .replace(/^\/*(files\/)?/, '')
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length) throw new Error('folder required, e.g. CAD');
  let dest = 'files';
  for (const p of parts) {
    const name = validName(p);
    const next = `${dest}/${name}`;
    if (!fs.existsSync(resolveInRoot(next, false))) mkdir(dest, name);
    dest = next;
  }
  const [moved] = await transfer([rel], dest, input.mode === 'copy' ? 'copy' : 'move');
  let final = moved;
  if (input.name && String(input.name).trim()) {
    let name = safeFileName(String(input.name).trim());
    if (!path.extname(name)) name += path.extname(moved); // keep the real type when only a new name is given
    const target = uniquePath(path.dirname(resolveInRoot(moved)), name);
    fs.renameSync(resolveInRoot(moved), target);
    final = relOf(target);
  }
  invalidateIndex();
  return { ok: true, path: final, mode: input.mode === 'copy' ? 'copy' : 'move', filesUrl: `${config.publicOrigin}/files?path=${encodeURIComponent(path.posix.dirname(final))}` };
}
