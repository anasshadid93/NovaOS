import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearch } from 'wouter';
import { Add24Regular, Checkmark24Regular, ChevronDown16Regular, FolderOpen24Regular, HardDrive24Filled, Home24Regular, Play24Filled, Storage24Regular, UsbStick24Filled } from '@fluentui/react-icons';
import { ApiError, api } from '../lib/api';
import { Dialog } from '../components/Dialog';
import { thumbUrl, type Entry } from '../lib/fm';
import { uploadFiles } from '../lib/upload';
import { useI18n, type MessageKey } from '../i18n';
import { PageHeader } from '../components/ui';
import { EmptyFolderArt } from '../components/fm/FileIcon';
import { Preview } from '../components/fm/Preview';

interface Media {
  path: string;
  cat: 'images' | 'videos';
  size: number;
  mtime: number;
  taken: number;
}
interface Album {
  path: string;
  count: number;
  cover: Media;
}
interface Drive {
  id: string;
  name: string;
  removable: boolean;
  state: 'mounted' | 'unmounted';
  count: number | null;
}
const DRIVE_KEY = 'manar.galleryDrive';
type Tab = 'all' | 'photos' | 'videos' | 'albums';
const PAGE = 240;

const toEntry = (m: Media): Entry => ({
  name: m.path.split('/').pop()!,
  path: m.path,
  type: 'file',
  size: m.size,
  mtime: m.mtime,
  cat: m.cat,
});
const albumName = (p: string, root: string) => (p === '.' || p === '' ? root : p.split('/').pop()!.replace(/_/g, ' '));

function Thumb({ m, onOpen }: { m: Media; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} className="relative aspect-square overflow-hidden bg-line active:opacity-80">
      <img src={thumbUrl(m.path, m.mtime)} alt="" loading="lazy" decoding="async" className="size-full object-cover" />
      {m.cat === 'videos' && (
        <span className="absolute end-1 bottom-1 inline-flex size-6 items-center justify-center rounded-full bg-black/55 text-white">
          <Play24Filled className="size-3.5" aria-hidden />
        </span>
      )}
    </button>
  );
}

export function Gallery() {
  const { t, intl } = useI18n();
  const params = new URLSearchParams(useSearch());
  const album = params.get('album');
  const [tab, setTab] = useState<Tab>(album !== null ? 'all' : ((params.get('tab') as Tab) ?? 'all'));
  const [items, setItems] = useState<Media[] | null>(null);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState({ all: 0, photos: 0, videos: 0 });
  const [albums, setAlbums] = useState<Album[] | null>(null);
  const [preview, setPreview] = useState<number | null>(null);
  const [status, setStatus] = useState('');
  const [drive, setDriveState] = useState(() => localStorage.getItem(DRIVE_KEY) ?? 'all');
  const [drives, setDrives] = useState<Drive[] | null>(null);
  const [picker, setPicker] = useState(false);
  const [mounting, setMounting] = useState<string | null>(null);
  const setDrive = (id: string) => {
    localStorage.setItem(DRIVE_KEY, id);
    setDriveState(id);
  };
  const loadDrives = useCallback(
    () =>
      api<Drive[]>('/api/gallery/drives')
        .then(setDrives)
        .catch(() => setDrives([])),
    [],
  );
  useEffect(() => {
    void loadDrives();
  }, [loadDrives]);
  // A remembered drive that was unplugged falls back to "all drives".
  useEffect(() => {
    if (drives && drive !== 'all' && !drives.some((d) => d.id === drive && d.state === 'mounted')) setDrive('all');
  }, [drives, drive]);
  const sentinel = useRef<HTMLDivElement>(null);
  const loading = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const query = useCallback(
    (offset: number) => {
      const q = new URLSearchParams({
        offset: String(offset),
        limit: String(PAGE),
      });
      if (tab === 'photos' || tab === 'videos') q.set('kind', tab);
      if (album !== null) q.set('album', album);
      if (drive !== 'all') q.set('drive', drive);
      return api<{ total: number; counts: typeof counts; items: Media[] }>(`/api/gallery?${q}`);
    },
    [tab, album, drive],
  );

  const reload = useCallback(async () => {
    if (tab === 'albums') {
      setAlbums(await api<Album[]>(`/api/gallery/albums${drive !== 'all' ? `?drive=${encodeURIComponent(drive)}` : ''}`));
      return;
    }
    const r = await query(0);
    setItems(r.items);
    setTotal(r.total);
    if (album === null && tab === 'all') setCounts(r.counts);
  }, [tab, album, drive, query]);

  useEffect(() => {
    setItems(null);
    void reload();
  }, [reload]);

  // Infinite scroll
  useEffect(() => {
    const el = sentinel.current;
    if (!el || tab === 'albums') return;
    const io = new IntersectionObserver(async ([e]) => {
      if (!e.isIntersecting || loading.current || !items || items.length >= total) return;
      loading.current = true;
      try {
        const r = await query(items.length);
        setItems((cur) => [...(cur ?? []), ...r.items]);
      } finally {
        loading.current = false;
      }
    });
    io.observe(el);
    return () => io.disconnect();
  }, [items, total, query, tab]);

  // Group by month of the date taken
  const groups = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(intl, {
      month: 'long',
      year: 'numeric',
    });
    const out: { label: string; start: number; items: Media[] }[] = [];
    (items ?? []).forEach((m, i) => {
      const label = fmt.format(m.taken);
      const last = out[out.length - 1];
      if (last?.label === label) last.items.push(m);
      else out.push({ label, start: i, items: [m] });
    });
    return out;
  }, [items, intl]);

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    try {
      const r = await uploadFiles('file', files, (pct) => setStatus(t('home.uploading', { pct: `${pct}%` })));
      setStatus(t('gallery.added', { n: r.saved.length }));
      void reload();
    } catch {
      setStatus(t('home.uploadFailed'));
    } finally {
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const remove = async (e: Entry) => {
    await api('/api/fs/delete', { body: { paths: [e.path] } });
    setItems((cur) => (cur ?? []).filter((m) => m.path !== e.path));
    setTotal((n) => n - 1);
    setPreview(null);
  };

  const pick = async (d: Drive | null) => {
    if (!d) {
      setDrive('all');
      return setPicker(false);
    }
    if (d.state === 'mounted') {
      setDrive(d.id);
      return setPicker(false);
    }
    setMounting(d.id);
    try {
      await api(`/api/storage/volumes/${d.id}/mount`, { body: {} });
      setDrive(d.id);
      setPicker(false);
      void loadDrives();
    } catch (e) {
      setStatus(t('vol.failed', { detail: e instanceof ApiError ? e.code : '' }));
      setPicker(false);
    } finally {
      setMounting(null);
    }
  };
  const driveLabel = (d: Drive) => (d.id === 'internal' ? t('vol.internal') : d.name);
  const current = drives?.find((d) => d.id === drive);

  const tabs: Tab[] = ['all', 'photos', 'videos', 'albums'];
  const title = album !== null ? albumName(album, t('fm.root')) : t('gallery.title');

  return (
    <>
      <PageHeader
        title={title}
        back={album !== null ? '/gallery?tab=albums' : '/'}
        actions={
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            aria-label={t('gallery.add')}
            className="inline-flex size-10 items-center justify-center rounded-full text-heading active:bg-primary-soft"
          >
            <Add24Regular aria-hidden />
          </button>
        }
      >
        {album === null && (
          <div className="grid grid-cols-4 gap-1 rounded-xl bg-primary-soft p-1" role="tablist">
            {tabs.map((x) => (
              <button
                key={x}
                type="button"
                role="tab"
                aria-selected={tab === x}
                onClick={() => setTab(x)}
                className={`min-h-9 rounded-lg text-sm ${tab === x ? 'bg-surface font-medium text-heading shadow-card' : 'text-muted'}`}
              >
                {t(`gallery.tab.${x}` as MessageKey)}
              </button>
            ))}
          </div>
        )}
      </PageHeader>
      <input ref={fileInput} type="file" accept="image/*,video/*" multiple hidden onChange={(e) => void upload(e.target.files)} />

      <main className="safe-bottom mx-auto max-w-md">
        {album === null && (
          <div className="mb-2 px-3">
            <button
              type="button"
              onClick={() => {
                setPicker(true);
                void loadDrives();
              }}
              className="inline-flex min-h-9 max-w-full items-center gap-1.5 rounded-full bg-surface px-3 text-sm text-ink shadow-card"
            >
              <Storage24Regular className="size-4 shrink-0 text-primary-ink" aria-hidden />
              <span className="truncate">{current ? driveLabel(current) : t('gallery.allDrives')}</span>
              <ChevronDown16Regular className="shrink-0 text-muted" aria-hidden />
            </button>
          </div>
        )}
        {status && (
          <p className="mx-3 mb-2 text-sm text-muted" role="status">
            {status}
          </p>
        )}

        {tab === 'albums' && album === null ? (
          <div className="grid grid-cols-2 gap-3 px-3 @2xl:grid-cols-4 @5xl:grid-cols-6">
            {albums?.length === 0 && <p className="col-span-2 py-16 text-center text-sm text-muted">{t('gallery.empty')}</p>}
            {albums?.map((a) => (
              <Link key={a.path} href={`/gallery?album=${encodeURIComponent(a.path)}`} className="block active:scale-[0.99]">
                <span className="block aspect-square overflow-hidden rounded-2xl bg-line shadow-card">
                  <img src={thumbUrl(a.cover.path, a.cover.mtime)} alt="" loading="lazy" className="size-full object-cover" />
                </span>
                <span className="mt-1.5 block truncate px-1 text-start text-sm font-medium text-ink">
                  <bdi>{albumName(a.path, t('fm.root'))}</bdi>
                </span>
                <span className="block px-1 text-xs text-muted">{t('gallery.count', { n: a.count })}</span>
              </Link>
            ))}
          </div>
        ) : items && items.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
            <EmptyFolderArt />
            <p className="font-medium text-ink">{t('gallery.empty')}</p>
            <p className="text-sm text-muted">{t('gallery.emptyHint')}</p>
          </div>
        ) : (
          <>
            {album === null && tab === 'all' && items && (
              <p className="px-4 pb-2 text-xs text-muted">
                {t('gallery.summary', {
                  photos: counts.photos,
                  videos: counts.videos,
                })}
              </p>
            )}
            {groups.map((g) => (
              <section key={g.label + g.start} className="mb-3">
                <h2
                  className={`sticky ${album === null ? 'top-[calc(max(env(safe-area-inset-top),0.75rem)+6.5rem)]' : 'top-[calc(max(env(safe-area-inset-top),0.75rem)+3.25rem)]'} z-[5] bg-canvas/90 px-4 py-1.5 text-sm font-semibold text-heading backdrop-blur-sm`}
                >
                  {g.label}
                </h2>
                <div className="grid grid-cols-3 gap-0.5 @2xl:grid-cols-5 @5xl:grid-cols-7">
                  {g.items.map((m, i) => (
                    <Thumb key={m.path} m={m} onOpen={() => setPreview(g.start + i)} />
                  ))}
                </div>
              </section>
            ))}
            <div ref={sentinel} className="h-10" />
            {album !== null && (
              <p className="pb-4 text-center">
                <Link href={`/files?path=${encodeURIComponent(album)}`} className="inline-flex items-center gap-1 text-sm text-primary-ink">
                  <FolderOpen24Regular className="size-5" aria-hidden />
                  {t('fm.showInFolder')}
                </Link>
              </p>
            )}
          </>
        )}
      </main>

      <Dialog open={picker} onClose={() => setPicker(false)} title={t('gallery.pickDrive')}>
        <ul className="-mx-2">
          {[null, ...(drives ?? [])].map((d) => {
            const I = !d ? Storage24Regular : d.id === 'internal' ? Home24Regular : d.removable ? UsbStick24Filled : HardDrive24Filled;
            const selected = d ? drive === d.id : drive === 'all';
            const sub = !d ? null : d.state === 'unmounted' ? t('gallery.tapToMount') : t('gallery.count', { n: d.count ?? 0 });
            return (
              <li key={d?.id ?? 'all'}>
                <button
                  type="button"
                  disabled={mounting !== null}
                  onClick={() => void pick(d)}
                  className="flex min-h-12 w-full items-center gap-3 rounded-xl px-3 py-1.5 text-start active:bg-primary-soft disabled:opacity-60"
                >
                  <I className="shrink-0 text-primary-ink" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-ink">
                      <bdi>{d ? driveLabel(d) : t('gallery.allDrives')}</bdi>
                    </span>
                    {sub && <span className="block text-xs text-muted">{mounting === d?.id ? t('gallery.mounting') : sub}</span>}
                  </span>
                  {selected && <Checkmark24Regular className="shrink-0 text-primary-ink" aria-hidden />}
                </button>
              </li>
            );
          })}
        </ul>
      </Dialog>

      {preview !== null && items && items[preview] && <Preview items={items.map(toEntry)} index={preview} onIndex={setPreview} onClose={() => setPreview(null)} onDelete={(e) => void remove(e)} />}
    </>
  );
}
