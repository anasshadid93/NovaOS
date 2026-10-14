import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

/** File categories over /srv/data (apps' private data excluded). Index cached for 5 minutes. */

export const CATEGORIES = {
  images: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp', 'svg', 'tif', 'tiff', 'raw', 'dng'],
  videos: ['mp4', 'mkv', 'mov', 'avi', 'webm', 'm4v', 'wmv', 'flv', '3gp', 'ts'],
  documents: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'txt', 'md', 'rtf', 'csv', 'pages', 'numbers', 'key'],
  audio: ['mp3', 'flac', 'wav', 'm4a', 'aac', 'ogg', 'opus', 'wma', 'aiff'],
  ebooks: ['epub', 'mobi', 'azw', 'azw3', 'fb2', 'cbz', 'cbr', 'djvu'],
  archives: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'iso'],
  installers: ['deb', 'rpm', 'apk', 'exe', 'msi', 'dmg', 'appimage', 'pkg', 'snap', 'flatpak'],
} as const;
export type Category = keyof typeof CATEGORIES | 'others';

const EXT_TO_CAT = new Map<string, Category>();
for (const [cat, exts] of Object.entries(CATEGORIES)) for (const e of exts) EXT_TO_CAT.set(e, cat as Category);

export function categoryOf(name: string): Category {
  return EXT_TO_CAT.get(path.extname(name).slice(1).toLowerCase()) ?? 'others';
}

/**
 * Everything uploaded from the phone lands in /srv/data/files/<Folder>, sorted by type,
 * so nothing ends up scattered in the data root.
 */
export const LIBRARY = 'files';
export const LIBRARY_FOLDERS: Record<Category, string> = {
  images: 'Images',
  videos: 'Videos',
  audio: 'Audio',
  documents: 'Documents',
  ebooks: 'Documents',
  archives: 'Zip',
  installers: 'Other',
  others: 'Other',
};
export const NOTES_FOLDER = 'Notes';

export function libraryDir(sub: string): string {
  return path.join(config.dataRoot, LIBRARY, sub);
}

/** Creates /srv/data/files and its sub-folders if missing. */
export function ensureLibrary() {
  for (const sub of new Set([...Object.values(LIBRARY_FOLDERS), NOTES_FOLDER])) fs.mkdirSync(libraryDir(sub), { recursive: true });
}

export interface IndexedFile {
  path: string; // relative to dataRoot
  size: number;
  mtime: number;
  cat: Category;
}

const MAX_FILES = 200_000;
let index: { at: number; files: IndexedFile[]; truncated: boolean } | null = null;
let building: Promise<void> | null = null;

async function build() {
  const root = config.dataRoot;
  const skip = new Set([path.resolve(config.appDataRoot), path.resolve(root, 'workspace')]);
  const files: IndexedFile[] = [];
  const stack = [root];
  let truncated = false;
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!skip.has(full)) stack.push(full);
      } else if (e.isFile()) {
        if (files.length >= MAX_FILES) {
          truncated = true;
          continue;
        }
        try {
          const st = await fs.promises.stat(full);
          const ext = path.extname(e.name).slice(1).toLowerCase();
          files.push({ path: path.relative(root, full), size: st.size, mtime: st.mtimeMs, cat: EXT_TO_CAT.get(ext) ?? 'others' });
        } catch {
          /* vanished */
        }
      }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  index = { at: Date.now(), files, truncated };
}

/**
 * The index of every file under the data root (drives included). Only the very first build is
 * waited for; when it gets old, callers get the current one at once while a new one is built in
 * the background (walking 100k+ files on USB drives can take a while).
 */
export async function fileIndex() {
  if (!index || Date.now() - index.at > 5 * 60_000) {
    building ??= build().finally(() => (building = null));
    if (!index) await building;
  }
  return index!;
}

/** Start building the index early (server start) so the first visit doesn't wait. */
export function warmIndex() {
  void fileIndex().catch(() => {});
}

export function invalidateIndex() {
  index = null;
}

/** Safe name for uploaded files: no path parts, no control chars; keeps the extension. */
export function safeFileName(name: string): string {
  const base = path.basename(name.replace(/\\/g, '/')).replace(/[\u0000-\u001f<>:"|?*]/g, '_').trim();
  return (base && base !== '.' && base !== '..' ? base : 'upload').slice(0, 180);
}

/** Avoid overwriting: "a.jpg" → "a (1).jpg". */
export function uniquePath(dir: string, name: string): string {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = path.join(dir, name);
  for (let i = 1; fs.existsSync(candidate); i++) candidate = path.join(dir, `${stem} (${i})${ext}`);
  return candidate;
}
