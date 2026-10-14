import { useEffect, useMemo, useState } from 'react';
import { Link, useSearch } from 'wouter';
import { ArrowUndo24Regular, Delete24Regular, FolderOpen24Regular, Search24Regular } from '@fluentui/react-icons';
import { ApiError, api } from '../lib/api';
import { parentOf, type Category, type Entry } from '../lib/fm';
import { formatBytes } from '../lib/format';
import { useI18n, type MessageKey } from '../i18n';
import { useConfirm } from '../components/ConfirmProvider';
import { Button } from '../components/ui';
import { EmptyFolderArt, FileIcon } from '../components/fm/FileIcon';
import { Preview } from '../components/fm/Preview';
import { FilesHeader } from './FileManager';

interface Indexed {
  path: string;
  size: number;
  mtime: number;
  cat: Category;
}

const toEntry = (f: Indexed): Entry => ({ name: f.path.split('/').pop()!, path: f.path, type: 'file', size: f.size, mtime: f.mtime, cat: f.cat });

/** A flat list of files with thumbnails, preview and "show in folder". */
function FlatList({ files, onChanged }: { files: Entry[]; onChanged?: () => void }) {
  const { formatRelative } = useI18n();
  const [preview, setPreview] = useState<number | null>(null);
  const ask = useConfirm();
  const { t } = useI18n();
  const remove = async (e: Entry) => {
    if (!(await ask({ title: t('fm.deleteTitle.one', { name: e.name }), body: t('fm.deleteBody'), confirmLabel: t('fm.delete'), danger: true }))) return;
    await api('/api/fs/delete', { body: { paths: [e.path] } });
    setPreview(null);
    onChanged?.();
  };
  return (
    <>
      <ul className="overflow-hidden rounded-list bg-surface shadow-card">
        {files.map((f, i) => (
          <li key={f.path} className="flex items-center border-line [&+&]:border-t">
            <button type="button" onClick={() => setPreview(i)} className="flex min-h-16 min-w-0 flex-1 items-center gap-3 ps-3 text-start active:bg-primary-soft">
              <FileIcon entry={f} />
              <span className="min-w-0 flex-1 py-2">
                <span dir="auto" className="block truncate text-start text-[0.95rem] text-ink">
                  {f.name}
                </span>
                <span dir="ltr" className="block truncate text-start text-xs text-muted">
                  /{parentOf(f.path)} · {formatBytes(f.size)} · {formatRelative(f.mtime)}
                </span>
              </span>
            </button>
            <Link
              href={`/files?path=${encodeURIComponent(parentOf(f.path))}`}
              className="me-1 inline-flex size-10 shrink-0 items-center justify-center rounded-full text-muted active:bg-primary-soft"
              aria-label={t('fm.showInFolder')}
            >
              <FolderOpen24Regular aria-hidden />
            </Link>
          </li>
        ))}
      </ul>
      {preview !== null && files[preview] && <Preview items={files} index={preview} onIndex={setPreview} onClose={() => setPreview(null)} onDelete={(e) => void remove(e)} />}
    </>
  );
}

export function FileCategoryView({ params }: { params: { cat: string } }) {
  const { t, tn } = useI18n();
  const [data, setData] = useState<{ total: number; files: Indexed[] } | null>(null);
  const [extra, setExtra] = useState<Indexed[]>([]);
  const load = () => api<{ total: number; files: Indexed[] }>(`/api/files/category/${params.cat}`).then((r) => (setData(r), setExtra([])));
  useEffect(() => {
    void load();
  }, [params.cat]); // eslint-disable-line react-hooks/exhaustive-deps
  const files = useMemo(() => [...(data?.files ?? []), ...extra].map(toEntry), [data, extra]);
  return (
    <>
      <FilesHeader title={t(`files.cat.${params.cat}` as MessageKey)} back="/files" />
      <main className="safe-bottom mx-auto max-w-md space-y-3 px-3">
        {data && <p className="px-1 text-xs text-muted">{tn('files.count', data.total)}</p>}
        {data && files.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-16">
            <EmptyFolderArt />
            <p className="text-sm text-muted">{t('fm.empty')}</p>
          </div>
        ) : (
          <FlatList files={files} onChanged={() => void load()} />
        )}
        {data && files.length < data.total && (
          <Button
            variant="secondary"
            className="w-full"
            onClick={async () => {
              const r = await api<{ files: Indexed[] }>(`/api/files/category/${params.cat}?offset=${files.length}`);
              setExtra((x) => [...x, ...r.files]);
            }}
          >
            {t('files.more')}
          </Button>
        )}
      </main>
    </>
  );
}

export function FileSearch() {
  const { t } = useI18n();
  const params = new URLSearchParams(useSearch());
  const under = params.get('path') ?? '';
  const [q, setQ] = useState(params.get('q') ?? '');
  const [results, setResults] = useState<Indexed[] | null>(null);
  useEffect(() => {
    if (q.trim().length < 2) return setResults(null);
    const id = setTimeout(() => {
      api<{ results: Indexed[] }>(`/api/fs/search?q=${encodeURIComponent(q.trim())}&path=${encodeURIComponent(under)}`).then((r) => setResults(r.results));
    }, 250);
    return () => clearTimeout(id);
  }, [q, under]);
  return (
    <>
      <FilesHeader title={t('fm.search')} back={`/files?path=${encodeURIComponent(under)}`} />
      <main className="safe-bottom mx-auto max-w-md space-y-3 px-3">
        <label className="flex min-h-11 items-center gap-2 rounded-xl bg-surface px-3 shadow-card">
          <Search24Regular className="text-muted" aria-hidden />
          <input
            autoFocus
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={under ? `${t('fm.search')} · /${under}` : t('fm.search')}
            aria-label={t('fm.search')}
            className="min-w-0 flex-1 bg-transparent text-base text-ink outline-none"
          />
        </label>
        {results === null ? (
          <p className="py-8 text-center text-sm text-muted">{t('fm.searchHint')}</p>
        ) : results.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted">{t('fm.noResults')}</p>
        ) : (
          <FlatList files={results.map(toEntry)} />
        )}
      </main>
    </>
  );
}

interface BinItem {
  id: string;
  origPath: string;
  name: string;
  isDir: number;
  size: number;
  deletedAt: number;
}

export function RecycleBin() {
  const { t, formatRelative } = useI18n();
  const ask = useConfirm();
  const [items, setItems] = useState<BinItem[] | null>(null);
  const [msg, setMsg] = useState('');
  const load = () => api<BinItem[]>('/api/fs/trash').then(setItems);
  useEffect(() => {
    void load();
  }, []);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setMsg(t('fm.done'));
    } catch (e) {
      if (!(e instanceof ApiError && e.code === 'confirm_required')) setMsg(t('fm.err.generic'));
    }
    void load();
  };

  return (
    <>
      <FilesHeader
        title={t('fm.bin')}
        back="/files"
        extra={
          items && items.length > 0 ? (
            <button
              type="button"
              className="min-h-10 rounded-full px-3 text-sm font-medium text-danger"
              onClick={async () => {
                if (await ask({ title: t('fm.emptyBinTitle'), body: t('fm.emptyBinBody'), confirmLabel: t('fm.emptyBin'), danger: true }))
                  await act(() => api('/api/fs/trash/purge', { body: { all: true } }));
              }}
            >
              {t('fm.emptyBin')}
            </button>
          ) : null
        }
      />
      <main className="safe-bottom mx-auto max-w-md space-y-3 px-3">
        <p className="px-1 text-xs text-muted">{t('fm.binHint')}</p>
        {items?.length === 0 && (
          <div className="flex flex-col items-center gap-3 py-16">
            <EmptyFolderArt />
            <p className="text-sm text-muted">{t('fm.binEmpty')}</p>
          </div>
        )}
        {!!items?.length && (
          <ul className="overflow-hidden rounded-list bg-surface shadow-card">
            {items.map((it) => (
              <li key={it.id} className="flex items-center gap-3 border-line px-3 py-2 [&+&]:border-t">
                <FileIcon entry={{ type: it.isDir ? 'dir' : 'file', cat: null, path: '', mtime: 0 }} size={40} />
                <span className="min-w-0 flex-1">
                  <span dir="auto" className="block truncate text-start text-sm text-ink">
                    {it.name}
                  </span>
                  <span className="block truncate text-xs text-muted">
                    {formatBytes(it.size)} · {formatRelative(it.deletedAt)} · <span dir="ltr">{t('fm.deletedFrom', { path: `/${parentOf(it.origPath)}` })}</span>
                  </span>
                </span>
                <button type="button" onClick={() => void act(() => api('/api/fs/trash/restore', { body: { ids: [it.id] } }))} className="inline-flex size-10 items-center justify-center rounded-full text-primary-ink active:bg-primary-soft" aria-label={`${t('fm.restore')} ${it.name}`}>
                  <ArrowUndo24Regular aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    if (await ask({ title: t('fm.purgeTitle.one', { name: it.name }), confirmLabel: t('fm.deleteForever'), danger: true }))
                      await act(() => api('/api/fs/trash/purge', { body: { ids: [it.id] } }));
                  }}
                  className="inline-flex size-10 items-center justify-center rounded-full text-danger active:bg-danger/10"
                  aria-label={`${t('fm.deleteForever')} ${it.name}`}
                >
                  <Delete24Regular aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
        {msg && (
          <p className="text-center text-sm text-muted" role="status">
            {msg}
          </p>
        )}
      </main>
    </>
  );
}
