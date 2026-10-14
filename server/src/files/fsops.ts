import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { getDb } from '../db.js';
import { categoryOf, type Category } from './files.js';

const execFileP = promisify(execFile);

/**
 * File manager over config.dataRoot (/srv/data). Every path from the client is
 * relative to that root and is resolved with realpath, so neither ".." nor
 * symlinks can reach outside it. Deleting moves items to a recycle bin.
 */

export class FsError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export const TRASH_DIR = '.trash';

function rootReal(): string {
  return fs.realpathSync(config.dataRoot);
}

/** Resolves a client path ("" = root) to an absolute path inside the root. `mustExist` follows symlinks. */
export function resolveInRoot(rel: string, mustExist = true): string {
  if (typeof rel !== 'string' || rel.includes('\0')) throw new FsError(400, 'bad_path');
  const root = rootReal();
  const abs = path.resolve(root, '.' + path.posix.normalize('/' + rel.replace(/\\/g, '/')));
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new FsError(403, 'outside_root');
  if (!mustExist) {
    const parent = fs.realpathSync(path.dirname(abs));
    if (parent !== root && !parent.startsWith(root + path.sep)) throw new FsError(403, 'outside_root');
    return abs;
  }
  let real: string;
  try {
    real = fs.realpathSync(abs);
  } catch {
    throw new FsError(404, 'not_found');
  }
  if (real !== root && !real.startsWith(root + path.sep)) throw new FsError(403, 'outside_root');
  return real;
}

export function relOf(abs: string): string {
  return path.relative(rootReal(), abs).split(path.sep).join('/');
}

export function validName(name: unknown): string {
  if (typeof name !== 'string') throw new FsError(400, 'bad_name');
  const n = name.trim();
  if (!n || n === '.' || n === '..' || n.length > 255 || /[/\\\0]/.test(n) || /[\u0000-\u001f]/.test(n)) throw new FsError(400, 'bad_name');
  return n;
}

const errno = (e: unknown) => (e as NodeJS.ErrnoException).code;
function mapErr(e: unknown): never {
  if (e instanceof FsError) throw e;
  const c = errno(e);
  if (c === 'ENOENT') throw new FsError(404, 'not_found');
  if (c === 'EEXIST' || c === 'ENOTEMPTY') throw new FsError(409, 'exists');
  if (c === 'EACCES' || c === 'EPERM') throw new FsError(403, 'permission_denied');
  if (c === 'ENOSPC') throw new FsError(507, 'disk_full');
  throw e;
}

export interface Entry {
  name: string;
  path: string;
  type: 'dir' | 'file' | 'link';
  size: number;
  mtime: number;
  cat: Category | null;
  items?: number;
}

export function list(rel: string, showHidden = false): { path: string; entries: Entry[] } {
  const dir = resolveInRoot(rel);
  let dirents: fs.Dirent[];
  try {
    if (!fs.statSync(dir).isDirectory()) throw new FsError(400, 'not_a_directory');
    dirents = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    mapErr(e);
  }
  const atRoot = dir === rootReal();
  const binHere = atRoot || isTrashHome(dir);
  const entries: Entry[] = [];
  for (const d of dirents) {
    if (!showHidden && d.name.startsWith('.')) continue;
    // The bin: at the root, and one per drive (see trashDirFor) — never listed.
    if (d.name === TRASH_DIR && binHere) continue;
    const abs = path.join(dir, d.name);
    try {
      // Links that resolve outside the root are invisible (they could not be opened anyway).
      if (d.isSymbolicLink()) {
        const real = fs.realpathSync(abs);
        const root = rootReal();
        if (real !== root && !real.startsWith(root + path.sep)) continue;
      }
      const st = fs.statSync(abs); // follows links
      const isDir = st.isDirectory();
      let items: number | undefined;
      if (isDir) {
        try {
          items = fs.readdirSync(abs).filter((n) => showHidden || !n.startsWith('.')).length;
        } catch {
          items = undefined;
        }
      }
      entries.push({
        name: d.name,
        path: relOf(abs),
        type: d.isSymbolicLink() ? 'link' : isDir ? 'dir' : 'file',
        size: isDir ? 0 : st.size,
        mtime: st.mtimeMs,
        cat: isDir ? null : categoryOf(d.name),
        items,
      });
      if (d.isSymbolicLink() && isDir) entries[entries.length - 1].type = 'dir';
    } catch {
      /* broken link or no permission: skip */
    }
  }
  entries.sort((a, b) => (a.type === 'dir') === (b.type === 'dir') ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) : a.type === 'dir' ? -1 : 1);
  return { path: relOf(dir), entries };
}

export function mkdir(parentRel: string, name: string): string {
  const parent = resolveInRoot(parentRel);
  const target = path.join(parent, validName(name));
  try {
    fs.mkdirSync(target);
  } catch (e) {
    mapErr(e);
  }
  return relOf(target);
}

export function rename(rel: string, newName: string): string {
  const src = resolveInRoot(rel);
  if (src === rootReal()) throw new FsError(400, 'is_root');
  const dst = path.join(path.dirname(src), validName(newName));
  if (fs.existsSync(dst)) throw new FsError(409, 'exists');
  try {
    fs.renameSync(src, dst);
  } catch (e) {
    mapErr(e);
  }
  return relOf(dst);
}

function uniqueTarget(dir: string, name: string): string {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = path.join(dir, name);
  for (let i = 1; fs.existsSync(candidate); i++) candidate = path.join(dir, `${stem} (${i})${ext}`);
  return candidate;
}

export async function transfer(rels: string[], destRel: string, mode: 'move' | 'copy'): Promise<string[]> {
  const dest = resolveInRoot(destRel);
  if (!fs.statSync(dest).isDirectory()) throw new FsError(400, 'not_a_directory');
  const out: string[] = [];
  for (const rel of rels) {
    const src = resolveInRoot(rel);
    if (src === rootReal()) throw new FsError(400, 'is_root');
    if (dest === src || dest.startsWith(src + path.sep)) throw new FsError(400, 'into_itself');
    const target = uniqueTarget(dest, path.basename(src));
    try {
      if (mode === 'copy') await fs.promises.cp(src, target, { recursive: true, errorOnExist: true, preserveTimestamps: true });
      else {
        try {
          fs.renameSync(src, target);
        } catch (e) {
          if (errno(e) !== 'EXDEV') throw e;
          await fs.promises.cp(src, target, { recursive: true, errorOnExist: true, preserveTimestamps: true });
          await fs.promises.rm(src, { recursive: true });
        }
      }
    } catch (e) {
      mapErr(e);
    }
    out.push(relOf(target));
  }
  return out;
}

// ---- Recycle bin -----------------------------------------------------------

function trashRoot(): string {
  const d = path.join(rootReal(), TRASH_DIR);
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

/** The highest folder inside the root that is still on the same drive as `abs`. */
function driveTop(abs: string): string {
  const root = rootReal();
  const dev = fs.statSync(abs).dev;
  let top = abs;
  for (let p = path.dirname(abs); p.startsWith(root + path.sep) || p === root; p = path.dirname(p)) {
    if (fs.statSync(p).dev !== dev) break;
    top = p;
    if (p === root) break;
  }
  return top;
}

/** A bin on the same drive as the item, so deleting a 10 GB file is a rename, not a copy. */
function trashDirFor(abs: string): string {
  const top = driveTop(fs.statSync(abs).isDirectory() ? abs : path.dirname(abs));
  if (top === rootReal()) return trashRoot();
  const d = path.join(top, TRASH_DIR);
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

/** A drive's top folder (where its own .trash lives), e.g. external/Toshiba. */
function isTrashHome(dir: string): boolean {
  try {
    return dir !== rootReal() && driveTop(dir) === dir && fs.existsSync(path.join(dir, TRASH_DIR));
  } catch {
    return false;
  }
}

/** Where a binned item is: its drive's bin first, then the main bin (older entries). */
function trashedPath(id: string, origPath: string): string {
  const candidates: string[] = [];
  try {
    let parent = path.posix.dirname(origPath);
    let abs: string | null = null;
    for (;;) {
      try {
        abs = resolveInRoot(parent === '.' ? '' : parent);
        break;
      } catch {
        if (parent === '.' || parent === '') break;
        parent = path.posix.dirname(parent);
      }
    }
    if (abs) candidates.push(path.join(driveTop(abs), TRASH_DIR, id));
  } catch {
    /* fall back to the main bin */
  }
  candidates.push(path.join(trashRoot(), id));
  return candidates.find((c) => fs.existsSync(c)) ?? candidates[candidates.length - 1];
}

function duSize(abs: string): number {
  try {
    const st = fs.lstatSync(abs);
    if (!st.isDirectory()) return st.size;
    let total = 0;
    for (const n of fs.readdirSync(abs)) total += duSize(path.join(abs, n));
    return total;
  } catch {
    return 0;
  }
}

export async function trash(rels: string[]): Promise<number> {
  const db = getDb();
  const ins = db.prepare('INSERT INTO trash(id, orig_path, name, is_dir, size, deleted_at) VALUES(?, ?, ?, ?, ?, ?)');
  let n = 0;
  for (const rel of rels) {
    const src = resolveInRoot(rel);
    if (src === rootReal() || path.basename(src) === TRASH_DIR || src.split(path.sep).includes(TRASH_DIR)) throw new FsError(400, 'not_allowed');
    const bin = trashDirFor(src);
    const id = crypto.randomBytes(8).toString('hex');
    const st = fs.statSync(src);
    const size = duSize(src);
    try {
      try {
        fs.renameSync(src, path.join(bin, id));
      } catch (e) {
        // Shouldn't happen with a bin per drive; copy without blocking the server if it does.
        if (errno(e) !== 'EXDEV') throw e;
        await fs.promises.cp(src, path.join(bin, id), { recursive: true, preserveTimestamps: true });
        await fs.promises.rm(src, { recursive: true, force: true });
      }
    } catch (e) {
      mapErr(e);
    }
    ins.run(id, relOf(src), path.basename(src), st.isDirectory() ? 1 : 0, size, Date.now());
    n++;
  }
  return n;
}

export function listTrash() {
  return getDb()
    .prepare('SELECT id, orig_path AS origPath, name, is_dir AS isDir, size, deleted_at AS deletedAt FROM trash ORDER BY deleted_at DESC')
    .all();
}

export async function restore(ids: string[]): Promise<number> {
  const db = getDb();
  let n = 0;
  for (const id of ids) {
    const row = db.prepare('SELECT orig_path, name FROM trash WHERE id = ?').get(id) as { orig_path: string; name: string } | undefined;
    if (!row) continue;
    const parentRel = path.posix.dirname(row.orig_path);
    let parent: string;
    try {
      parent = resolveInRoot(parentRel === '.' ? '' : parentRel);
    } catch {
      parent = rootReal(); // original folder is gone: restore to the root
    }
    const target = uniqueTarget(parent, row.name);
    const from = trashedPath(id, row.orig_path);
    try {
      try {
        fs.renameSync(from, target);
      } catch (e) {
        if (errno(e) !== 'EXDEV') throw e;
        await fs.promises.cp(from, target, { recursive: true, preserveTimestamps: true });
        await fs.promises.rm(from, { recursive: true, force: true });
      }
    } catch (e) {
      mapErr(e);
    }
    db.prepare('DELETE FROM trash WHERE id = ?').run(id);
    n++;
  }
  return n;
}

export async function purge(ids: string[] | 'all'): Promise<number> {
  const db = getDb();
  const rows = (ids === 'all' ? db.prepare('SELECT id FROM trash').all() : ids.map((id) => ({ id }))) as { id: string }[];
  let n = 0;
  for (const { id } of rows) {
    if (!/^[0-9a-f]{16}$/.test(id)) continue;
    const row = db.prepare('SELECT orig_path FROM trash WHERE id = ?').get(id) as { orig_path: string } | undefined;
    await fs.promises.rm(trashedPath(id, row?.orig_path ?? ''), { recursive: true, force: true });
    db.prepare('DELETE FROM trash WHERE id = ?').run(id);
    n++;
  }
  return n;
}

/** Bin entries older than 30 days are deleted for good. */
export async function pruneTrash() {
  const old = getDb().prepare('SELECT id FROM trash WHERE deleted_at < ?').all(Date.now() - 30 * 86400_000) as { id: string }[];
  if (old.length) await purge(old.map((r) => r.id));
}

// ---- Thumbnails (ffmpeg, cached, at most 2 at a time) ----------------------

let active = 0;
const waiting: (() => void)[] = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= 6) await new Promise<void>((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

export async function thumbnail(rel: string): Promise<string> {
  const src = resolveInRoot(rel);
  const st = fs.statSync(src);
  const cat = categoryOf(src);
  if (!st.isFile() || (cat !== 'images' && cat !== 'videos')) throw new FsError(415, 'no_thumbnail');
  if (cat === 'images' && st.size > 80 * 1024 ** 2) throw new FsError(413, 'too_large');
  const dir = path.join(config.dataDir, 'thumbs');
  fs.mkdirSync(dir, { recursive: true });
  const key = crypto.createHash('sha1').update(`${src}\0${st.mtimeMs}\0${st.size}`).digest('hex');
  const out = path.join(dir, `${key}.jpg`);
  if (fs.existsSync(out)) return out;
  // A file ffmpeg couldn't read: answer "no thumbnail" at once instead of trying again every visit.
  const none = path.join(dir, `${key}.none`);
  if (fs.existsSync(none)) throw new FsError(415, 'no_thumbnail');
  try {
    await slot(async () => {
      const seek = cat === 'videos' ? ['-ss', '1'] : [];
      await execFileP(
        'nice',
        ['-n', '15', 'ffmpeg', '-v', 'error', ...seek, '-i', src, '-frames:v', '1', '-vf', 'scale=320:320:force_original_aspect_ratio=increase,crop=320:320', '-q:v', '6', '-y', out],
        { timeout: 20_000 },
      ).catch(async (e) => {
        // Very short videos: retry from the first frame.
        if (cat !== 'videos') throw e;
        await execFileP('nice', ['-n', '15', 'ffmpeg', '-v', 'error', '-i', src, '-frames:v', '1', '-vf', 'scale=320:320:force_original_aspect_ratio=increase,crop=320:320', '-q:v', '6', '-y', out], {
          timeout: 20_000,
        });
      });
    });
  } catch {
    fs.writeFileSync(none, '');
    throw new FsError(415, 'no_thumbnail');
  }
  if (!fs.existsSync(out)) {
    fs.writeFileSync(none, '');
    throw new FsError(415, 'no_thumbnail');
  }
  return out;
}
