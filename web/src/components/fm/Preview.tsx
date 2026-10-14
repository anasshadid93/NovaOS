import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { ArrowDownload24Regular, ChevronLeft24Regular, ChevronRight24Regular, Delete24Regular, Dismiss24Regular } from '@fluentui/react-icons';
import { api } from '../../lib/api';
import { fileUrl, type Entry } from '../../lib/fm';
import { formatBytes } from '../../lib/format';
import { useI18n } from '../../i18n';
import { FileIcon } from './FileIcon';
import { VideoPlayer } from './VideoPlayer';
import { NowPlaying } from '../NowPlaying';
import { player, trackFromPath } from '../../lib/player';

const PdfViewer = lazy(() => import('./PdfViewer'));

/**
 * Full-screen viewer. `items` are the files of the current folder so the user
 * can swipe/arrow between them; videos and audio stream with seeking (HTTP Range).
 */
export function Preview({ items, index, onIndex, onClose, onDelete }: { items: Entry[]; index: number; onIndex: (i: number) => void; onClose: () => void; onDelete?: (e: Entry) => void }) {
  const { t, formatRelative } = useI18n();
  const e = items[index];
  const [text, setText] = useState<{ text: string; truncated: boolean } | null>(null);
  const touch = useRef<number | null>(null);
  const isText = e && e.cat === 'documents' && /\.(txt|md|csv|log|json)$/i.test(e.name);

  useEffect(() => {
    setText(null);
    if (isText) api<{ text: string; truncated: boolean }>(`/api/fs/text?path=${encodeURIComponent(e.path)}`).then(setText).catch(() => undefined);
  }, [e?.path, isText]); // eslint-disable-line react-hooks/exhaustive-deps

  // Audio goes to the app-wide player (keeps playing after closing), with this folder as the queue.
  useEffect(() => {
    if (e?.cat !== 'audio') return;
    const cur = player.current();
    if (cur?.path === e.path) return;
    const audio = items.filter((x) => x.cat === 'audio');
    player.play(audio.map((x) => trackFromPath(x.path)), audio.findIndex((x) => x.path === e.path));
  }, [e?.path]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') onClose();
      if (ev.key === 'ArrowRight' && index < items.length - 1) onIndex(index + 1);
      if (ev.key === 'ArrowLeft' && index > 0) onIndex(index - 1);
    };
    addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [index, items.length, onClose, onIndex]);

  if (!e) return null;
  const src = fileUrl(e.path);
  const isPdf = /\.pdf$/i.test(e.name);
  // Office and CAD files: the server turns them into a PDF (LibreOffice / libredwg) for the same viewer.
  const isOffice = /\.(doc|docx|odt|rtf|xls|xlsx|ods|ppt|pptx|odp|dxf|dwg|pages|numbers|key|wpd)$/i.test(e.name);

  let body: React.ReactNode;
  if (e.cat === 'images') body = <img src={src} alt={e.name} className="max-h-full max-w-full object-contain" />;
  else if (e.cat === 'videos') body = <VideoPlayer path={e.path} />;
  else if (e.cat === 'audio')
    body = (
      <div className="w-full max-w-md">
        <NowPlaying />
      </div>
    );
  else if (isPdf || isOffice)
    body = (
      <Suspense fallback={<p className="text-sm text-white/70">{t('common.loading')}</p>}>
        <PdfViewer key={e.path} src={isPdf ? src : `/api/fs/preview?path=${encodeURIComponent(e.path)}&v=${Math.round(e.mtime)}`} />
      </Suspense>
    );
  else if (isText)
    body = (
      <div className="h-full w-full overflow-auto rounded-xl bg-surface p-4">
        <pre dir="auto" className="whitespace-pre-wrap break-words font-mono text-xs text-ink">
          {text?.text ?? '…'}
        </pre>
        {text?.truncated && <p className="mt-2 text-xs text-muted">{t('fm.truncated')}</p>}
      </div>
    );
  else
    body = (
      <div className="flex flex-col items-center gap-4 text-center">
        <FileIcon entry={e} size={96} />
        <p className="text-sm text-white/80">{isPdf ? '' : t('fm.noPreview')}</p>
        <a href={isPdf ? src : fileUrl(e.path, true)} target={isPdf ? '_blank' : undefined} rel="noreferrer" className="rounded-xl bg-primary px-5 py-3 font-medium text-white">
          {isPdf ? t('fm.open') : t('fm.download')}
        </a>
      </div>
    );

  const btn = 'inline-flex size-11 items-center justify-center rounded-full text-white active:bg-white/15';
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={e.name}
      className="fixed inset-0 z-50 flex flex-col bg-black"
      onTouchStart={(ev) => (touch.current = ev.touches[0].clientX)}
      onTouchEnd={(ev) => {
        if (touch.current === null || e.cat === 'videos' || isText || isPdf || isOffice) return;
        const dx = ev.changedTouches[0].clientX - touch.current;
        touch.current = null;
        const rtl = document.documentElement.dir === 'rtl';
        if (Math.abs(dx) < 60) return;
        const next = (dx < 0) !== rtl ? index + 1 : index - 1;
        if (next >= 0 && next < items.length) onIndex(next);
      }}
    >
      <header className="safe-top flex items-center gap-2 px-2 pb-2 text-white">
        <button type="button" className={btn} onClick={onClose} aria-label={t('common.close')}>
          <Dismiss24Regular aria-hidden />
        </button>
        <div className="min-w-0 flex-1">
          <p dir="auto" className="truncate text-start text-sm font-medium">
            {e.name}
          </p>
          <p className="text-xs text-white/60">
            {formatBytes(e.size)} · {formatRelative(e.mtime)}
          </p>
        </div>
        <a href={fileUrl(e.path, true)} className={btn} aria-label={t('fm.download')}>
          <ArrowDownload24Regular aria-hidden />
        </a>
        {onDelete && (
          <button type="button" className={btn} onClick={() => onDelete(e)} aria-label={t('fm.delete')}>
            <Delete24Regular aria-hidden />
          </button>
        )}
      </header>
      <div className="relative flex min-h-0 flex-1 items-center justify-center p-2">
        {body}
        {index > 0 && (
          <button type="button" onClick={() => onIndex(index - 1)} className={`${btn} absolute start-1 top-1/2 -translate-y-1/2 bg-black/30`} aria-label="Previous">
            <ChevronLeft24Regular className="flip-rtl" aria-hidden />
          </button>
        )}
        {index < items.length - 1 && (
          <button type="button" onClick={() => onIndex(index + 1)} className={`${btn} absolute end-1 top-1/2 -translate-y-1/2 bg-black/30`} aria-label="Next">
            <ChevronRight24Regular className="flip-rtl" aria-hidden />
          </button>
        )}
      </div>
      <p className="safe-bottom pb-2 text-center text-xs text-white/50 tabular-nums">
        <span dir="ltr">{index + 1} / {items.length}</span>
      </p>
    </div>
  );
}
