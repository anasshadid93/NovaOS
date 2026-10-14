import { ApiError, api } from './api';
import type { MessageKey } from '../i18n';

export type Category = 'images' | 'videos' | 'documents' | 'audio' | 'ebooks' | 'archives' | 'installers' | 'others';

export interface Entry {
  name: string;
  path: string;
  type: 'dir' | 'file' | 'link';
  size: number;
  mtime: number;
  cat: Category | null;
  items?: number;
}

export const enc = encodeURIComponent;
export const fileUrl = (p: string, download = false) => `/api/fs/file?path=${enc(p)}${download ? '&dl=1' : ''}`;
export const thumbUrl = (p: string, mtime: number) => `/api/fs/thumb?path=${enc(p)}&v=${Math.round(mtime)}`;
export const parentOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
export const baseName = (p: string) => p.split('/').pop() ?? p;

export const list = (path: string, hidden: boolean) => api<{ path: string; entries: Entry[] }>(`/api/fs/list?path=${enc(path)}${hidden ? '&hidden=1' : ''}`);

export function errorKey(e: unknown): MessageKey {
  const code = e instanceof ApiError ? e.code : '';
  return (['exists', 'permission_denied', 'bad_name', 'disk_full', 'into_itself'].includes(code) ? `fm.err.${code}` : 'fm.err.generic') as MessageKey;
}

export type SortKey = 'name' | 'date' | 'size';

export function sortEntries(list: Entry[], key: SortKey): Entry[] {
  const dirs = list.filter((e) => e.type === 'dir');
  const files = list.filter((e) => e.type !== 'dir');
  const byName = (a: Entry, b: Entry) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  const cmp = { name: byName, date: (a: Entry, b: Entry) => b.mtime - a.mtime, size: (a: Entry, b: Entry) => b.size - a.size || byName(a, b) }[key];
  // Folders have no size: keep them by name when sorting by size.
  dirs.sort(key === 'size' ? byName : cmp);
  files.sort(cmp);
  return [...dirs, ...files];
}

/** Uploads into a folder with overall progress. */
export function uploadTo(dir: string, files: File[], onProgress: (loaded: number, total: number) => void): Promise<{ saved: string[] }> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    for (const f of files) form.append('file', f, f.name);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/fs/upload?path=${enc(dir)}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded, e.total);
    xhr.onload = () => {
      if (xhr.status < 300) resolve(JSON.parse(xhr.responseText));
      else {
        let code = 'error';
        try {
          code = JSON.parse(xhr.responseText).error;
        } catch {
          /* ignore */
        }
        reject(new ApiError(xhr.status, code));
      }
    };
    xhr.onerror = () => reject(new ApiError(0, 'network'));
    xhr.send(form);
  });
}
