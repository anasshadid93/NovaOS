import { useState } from 'react';
import {
  Archive24Filled,
  Book24Filled,
  Box24Filled,
  Document24Filled,
  DocumentText24Filled,
  Folder24Filled,
  Image24Filled,
  MusicNote224Filled,
  Play24Filled,
  Video24Filled,
} from '@fluentui/react-icons';
import { thumbUrl, type Category, type Entry } from '../../lib/fm';

const CAT: Record<Category, { icon: typeof Folder24Filled; bg: string }> = {
  images: { icon: Image24Filled, bg: '#f97316' },
  videos: { icon: Video24Filled, bg: '#ef4444' },
  documents: { icon: Document24Filled, bg: '#8b5cf6' },
  audio: { icon: MusicNote224Filled, bg: '#ec4899' },
  ebooks: { icon: Book24Filled, bg: '#0ea5e9' },
  archives: { icon: Archive24Filled, bg: '#64748b' },
  installers: { icon: Box24Filled, bg: '#a855f7' },
  others: { icon: DocumentText24Filled, bg: '#94a3b8' },
};

export const catStyle = (c: Category) => CAT[c];

/** Folder, thumbnail (images/videos) or a coloured type icon. */
export function FileIcon({ entry, size = 44 }: { entry: Pick<Entry, 'type' | 'cat' | 'path' | 'mtime'>; size?: number }) {
  const [thumbFailed, setThumbFailed] = useState(false);
  const box = { width: size, height: size };
  if (entry.type === 'dir')
    return (
      <span className="inline-flex shrink-0 items-center justify-center" style={box} aria-hidden>
        <Folder24Filled style={{ width: size * 0.95, height: size * 0.95, color: '#f5b400' }} />
      </span>
    );
  const cat = entry.cat ?? 'others';
  if ((cat === 'images' || cat === 'videos') && !thumbFailed)
    return (
      <span className="relative inline-flex shrink-0 overflow-hidden rounded-lg bg-line" style={box} aria-hidden>
        <img src={thumbUrl(entry.path, entry.mtime)} alt="" loading="lazy" decoding="async" className="size-full object-cover" onError={() => setThumbFailed(true)} />
        {cat === 'videos' && (
          <span className="absolute inset-0 flex items-center justify-center">
            <span className="inline-flex size-6 items-center justify-center rounded-full bg-black/50 text-white">
              <Play24Filled className="size-3.5" />
            </span>
          </span>
        )}
      </span>
    );
  const { icon: I, bg } = CAT[cat];
  return (
    <span className="inline-flex shrink-0 items-center justify-center rounded-lg text-white" style={{ ...box, background: bg }} aria-hidden>
      <I style={{ width: size * 0.5, height: size * 0.5 }} />
    </span>
  );
}

/** Original empty-state illustration (folder with documents). */
export function EmptyFolderArt() {
  return (
    <svg width="168" height="120" viewBox="0 0 168 120" aria-hidden className="text-line">
      <rect x="38" y="14" width="44" height="56" rx="6" transform="rotate(-12 60 42)" fill="var(--color-surface)" stroke="currentColor" strokeWidth="2" />
      <rect x="86" y="10" width="44" height="56" rx="6" transform="rotate(10 108 38)" fill="var(--color-surface)" stroke="currentColor" strokeWidth="2" />
      <path d="M96 30h22M96 38h22M96 46h14" stroke="currentColor" strokeWidth="3" strokeLinecap="round" transform="rotate(10 108 38)" />
      <circle cx="58" cy="36" r="7" fill="currentColor" transform="rotate(-12 60 42)" />
      <path d="M30 52a8 8 0 0 1 8-8h26l8 8h58a8 8 0 0 1 8 8v44a8 8 0 0 1-8 8H38a8 8 0 0 1-8-8z" fill="var(--color-surface)" stroke="currentColor" strokeWidth="2" />
      <circle cx="72" cy="80" r="3" fill="var(--color-muted)" />
      <circle cx="96" cy="80" r="3" fill="var(--color-muted)" />
      <path d="M76 94q8-6 16 0" stroke="var(--color-muted)" strokeWidth="2.5" fill="none" strokeLinecap="round" />
    </svg>
  );
}
