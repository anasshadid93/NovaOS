import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearch } from 'wouter';
import {
  Add24Regular,
  ArrowClockwise24Regular,
  Checkmark24Regular,
  ChevronDown16Regular,
  CopySelect24Regular,
  Dismiss24Regular,
  Edit24Regular,
  FolderOpen24Regular,
  HardDrive24Filled,
  Home24Regular,
  Play24Filled,
  Search24Regular,
  Storage24Regular,
  UsbStick24Filled,
} from '@fluentui/react-icons';
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
type Tab = 'all' | 'photos' | 'videos' | 'albums' | 'people' | 'smart';
/** A result list that replaces the normal timeline: a search, a person, a category, duplicates or "similar". */
type View = { kind: 'search'; q: string } | { kind: 'person'; id: number; name: string | null } | { kind: 'category'; label: string } | { kind: 'dups' } | { kind: 'similar'; path: string };
interface Person {
  id: number;
  name: string | null;
  coverFace: number;
  photos: number;
}
interface Category {
  label: string;
  n: number;
  cover: Media | null;
}
interface VisionStatus {
  installed: boolean;
  ready: boolean;
  indexing: boolean;
  progress: { phase: string; done: number; total: number } | null;
  photos: number;
  people: number;
  videos: number;
}
const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
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

function Thumb({ m, onOpen, caption }: { m: Media; onOpen: () => void; caption?: string }) {
  return (
    <button type="button" onClick={onOpen} className="relative aspect-square overflow-hidden bg-line active:opacity-80">
      <img src={thumbUrl(m.path, m.mtime)} alt="" loading="lazy" decoding="async" className="size-full object-cover" />
      {caption && <span className="absolute start-1 bottom-1 rounded bg-black/55 px-1 text-[10px] text-white tabular-nums">{caption}</span>}
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
  const [vision, setVision] = useState<VisionStatus | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [q, setQ] = useState('');
  const [searching, setSearching] = useState(false);
  const [usedQuery, setUsedQuery] = useState<string | null>(null);
  const [videoHits, setVideoHits] = useState<(Media & { t: number })[]>([]);
  const [people, setPeople] = useState<Person[] | null>(null);
  const [cats, setCats] = useState<Category[] | null>(null);
  const [dupGroups, setDupGroups] = useState<{ items: Media[] }[] | null>(null);
  useEffect(() => {
    api<VisionStatus>('/api/vision/status')
      .then(setVision)
      .catch(() => setVision(null));
  }, []);
  // While a scan runs, refresh its progress.
  useEffect(() => {
    if (!vision?.indexing || tab !== 'smart') return;
    const id = setInterval(
      () =>
        api<VisionStatus>('/api/vision/status')
          .then(setVision)
          .catch(() => undefined),
      5000,
    );
    return () => clearInterval(id);
  }, [vision?.indexing, tab]);
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

  const loadView = useCallback(
    async (v: View) => {
      setVideoHits([]);
      setUsedQuery(null);
      setDupGroups(null);
      if (v.kind === 'search') {
        setSearching(true);
        try {
          const r = await api<{
            used: string;
            photos: Media[];
            videos: (Media & { t: number })[];
          }>(`/api/gallery/search?q=${encodeURIComponent(v.q)}`);
          setItems(r.photos);
          setTotal(r.photos.length);
          setVideoHits(r.videos);
          if (r.used.trim().toLowerCase() !== v.q.trim().toLowerCase()) setUsedQuery(r.used);
        } finally {
          setSearching(false);
        }
        return;
      }
      if (v.kind === 'dups') {
        const g = await api<{ items: Media[] }[]>('/api/gallery/duplicates');
        setDupGroups(g);
        const flat = g.flatMap((x) => x.items);
        setItems(flat);
        setTotal(flat.length);
        return;
      }
      const url =
        v.kind === 'person'
          ? `/api/gallery/people/${v.id}`
          : v.kind === 'category'
            ? `/api/gallery/categories?label=${encodeURIComponent(v.label)}`
            : `/api/gallery/similar?path=${encodeURIComponent(v.path)}`;
      try {
        const r = await api<Media[]>(url);
        setItems(r);
        setTotal(r.length);
      } catch (e) {
        if (v.kind === 'similar' && e instanceof ApiError && e.status === 404) setStatus(t('gallery.notIndexed'));
        setItems([]);
        setTotal(0);
      }
    },
    [t],
  );

  const reload = useCallback(async () => {
    if (view) return loadView(view);
    if (tab === 'people') {
      setPeople(await api<Person[]>('/api/gallery/people'));
      return;
    }
    if (tab === 'smart') {
      setCats(await api<Category[]>('/api/gallery/categories'));
      return;
    }
    if (tab === 'albums') {
      setAlbums(await api<Album[]>(`/api/gallery/albums${drive !== 'all' ? `?drive=${encodeURIComponent(drive)}` : ''}`));
      return;
    }
    const r = await query(0);
    setItems(r.items);
    setTotal(r.total);
    if (album === null && tab === 'all') setCounts(r.counts);
  }, [tab, album, drive, query, view, loadView]);

  useEffect(() => {
    setItems(null);
    void reload();
  }, [reload]);

  const openView = (v: View) => {
    setStatus('');
    setPreview(null);
    setView(v);
  };
  const closeView = () => {
    setView(null);
    setQ('');
  };
  const submitSearch = () => {
    const s = q.trim();
    if (s) openView({ kind: 'search', q: s });
  };
  const renamePerson = async (p: Person) => {
    const name = window.prompt(t('gallery.people.rename'), p.name ?? '');
    if (name === null) return;
    await api(`/api/gallery/people/${p.id}`, { body: { name } });
    if (view?.kind === 'person') setView({ ...view, name: name || null });
    setPeople((cur) => (cur ?? []).map((x) => (x.id === p.id ? { ...x, name: name || null } : x)));
  };
  const rescan = async () => {
    await api('/api/vision/index', { body: {} }).catch(() => undefined);
    api<VisionStatus>('/api/vision/status')
      .then(setVision)
      .catch(() => undefined);
  };

  // Infinite scroll
  useEffect(() => {
    const el = sentinel.current;
    if (!el || tab === 'albums' || view) return;
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
  }, [items, total, query, tab, view]);

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

  const tabs: Tab[] = vision?.installed ? ['all', 'photos', 'videos', 'albums', 'people', 'smart'] : ['all', 'photos', 'videos', 'albums'];
  const viewTitle = !view
    ? null
    : view.kind === 'search'
      ? view.q
      : view.kind === 'person'
        ? (view.name ?? t('gallery.people.unnamed'))
        : view.kind === 'category'
          ? t(`gallery.cat.${view.label}` as MessageKey)
          : view.kind === 'dups'
            ? t('gallery.dups')
            : t('gallery.similarTitle');
  const title = viewTitle ?? (album !== null ? albumName(album, t('fm.root')) : t('gallery.title'));
  const catLabel = (l: string) => t(`gallery.cat.${l}` as MessageKey);

  return (
    <>
      <PageHeader
        title={title}
        back={view ? closeView : album !== null ? '/gallery?tab=albums' : '/'}
        actions={
          view?.kind === 'person' ? (
            <button
              type="button"
              onClick={() =>
                void renamePerson({
                  id: view.id,
                  name: view.name,
                  coverFace: 0,
                  photos: 0,
                })
              }
              aria-label={t('gallery.people.rename')}
              className="inline-flex size-10 items-center justify-center rounded-full text-heading active:bg-primary-soft"
            >
              <Edit24Regular aria-hidden />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              aria-label={t('gallery.add')}
              className="inline-flex size-10 items-center justify-center rounded-full text-heading active:bg-primary-soft"
            >
              <Add24Regular aria-hidden />
            </button>
          )
        }
      >
        {album === null && !view && (
          <div className={`flex gap-1 overflow-x-auto rounded-xl bg-primary-soft p-1 [scrollbar-width:none] ${tabs.length > 4 ? '' : 'grid grid-cols-4'}`} role="tablist">
            {tabs.map((x) => (
              <button
                key={x}
                type="button"
                role="tab"
                aria-selected={tab === x}
                onClick={() => setTab(x)}
                className={`min-h-9 shrink-0 rounded-lg px-3 text-sm ${tab === x ? 'bg-surface font-medium text-heading shadow-card' : 'text-muted'}`}
              >
                {t(`gallery.tab.${x}` as MessageKey)}
              </button>
            ))}
          </div>
        )}
      </PageHeader>
      <input ref={fileInput} type="file" accept="image/*,video/*" multiple hidden onChange={(e) => void upload(e.target.files)} />

      <main className="safe-bottom mx-auto max-w-md">
        {album === null && vision?.installed && tab !== 'people' && tab !== 'albums' && (
          <form
            className="mb-2 flex items-center gap-2 px-3"
            onSubmit={(e) => {
              e.preventDefault();
              submitSearch();
            }}
          >
            <label className="flex min-h-10 flex-1 items-center gap-2 rounded-full bg-surface px-3 shadow-card">
              <Search24Regular className="size-5 shrink-0 text-muted" aria-hidden />
              <input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={t('gallery.search')}
                enterKeyHint="search"
                className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-muted"
              />
              {(q || view?.kind === 'search') && (
                <button type="button" onClick={closeView} aria-label={t('common.close')} className="text-muted">
                  <Dismiss24Regular className="size-4" aria-hidden />
                </button>
              )}
            </label>
          </form>
        )}
        {album === null && !view && tab !== 'people' && tab !== 'smart' && (
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
        {searching && <p className="mx-3 mb-2 text-sm text-muted">{t('gallery.searching')}</p>}
        {usedQuery && <p className="mx-3 mb-2 text-xs text-muted">{t('gallery.usedQuery', { q: usedQuery })}</p>}

        {!view && tab === 'people' && album === null ? (
          <div className="grid grid-cols-3 gap-3 px-3 @2xl:grid-cols-5 @5xl:grid-cols-8">
            {people?.length === 0 && <p className="col-span-3 px-4 py-16 text-center text-sm text-muted">{t('gallery.people.empty')}</p>}
            {people?.map((p) => (
              <button key={p.id} type="button" onClick={() => openView({ kind: 'person', id: p.id, name: p.name })} className="flex flex-col items-center gap-1.5 active:scale-[0.98]">
                <img src={`/api/gallery/face/${p.coverFace}`} alt="" loading="lazy" className="size-20 rounded-full bg-line object-cover shadow-card" />
                <span className={`block w-full truncate text-center text-sm ${p.name ? 'font-medium text-ink' : 'text-muted'}`}>
                  <bdi>{p.name ?? t('gallery.people.unnamed')}</bdi>
                </span>
                <span className="-mt-1 block text-xs text-muted">{t('gallery.people.photos', { n: p.photos })}</span>
              </button>
            ))}
          </div>
        ) : !view && tab === 'smart' && album === null ? (
          <div className="px-3">
            <div className="mb-3 flex items-center justify-between gap-2 rounded-2xl bg-surface px-3 py-2 text-xs text-muted shadow-card">
              <span>
                {!vision?.ready
                  ? t('vision.status.starting')
                  : vision.indexing && vision.progress
                    ? t('vision.status.indexing', {
                        phase: vision.progress.phase,
                        done: vision.progress.done,
                        total: vision.progress.total,
                      })
                    : t('vision.status.idle', {
                        photos: vision.photos,
                        people: vision.people,
                        videos: vision.videos,
                      })}
              </span>
              <button
                type="button"
                onClick={() => void rescan()}
                disabled={!vision?.ready || vision.indexing}
                aria-label={t('vision.rescan')}
                className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-primary-ink active:bg-primary-soft disabled:opacity-40"
              >
                <ArrowClockwise24Regular className={`size-5 ${vision?.indexing ? 'animate-spin' : ''}`} aria-hidden />
              </button>
            </div>
            <button
              type="button"
              onClick={() => openView({ kind: 'dups' })}
              className="mb-3 flex min-h-12 w-full items-center gap-3 rounded-2xl bg-surface px-3 text-start shadow-card active:bg-primary-soft"
            >
              <CopySelect24Regular className="shrink-0 text-primary-ink" aria-hidden />
              <span className="flex-1 text-sm font-medium text-ink">{t('gallery.dups')}</span>
            </button>
            <h2 className="mb-2 px-1 text-sm font-semibold text-heading">{t('gallery.cat.title')}</h2>
            <div className="grid grid-cols-2 gap-3 @2xl:grid-cols-4 @5xl:grid-cols-6">
              {cats?.length === 0 && <p className="col-span-2 py-10 text-center text-sm text-muted">{t('gallery.empty')}</p>}
              {cats?.map((c) => (
                <button key={c.label} type="button" onClick={() => openView({ kind: 'category', label: c.label })} className="block text-start active:scale-[0.99]">
                  <span className="block aspect-[4/3] overflow-hidden rounded-2xl bg-line shadow-card">
                    {c.cover && <img src={thumbUrl(c.cover.path, c.cover.mtime)} alt="" loading="lazy" className="size-full object-cover" />}
                  </span>
                  <span className="mt-1.5 block truncate px-1 text-sm font-medium text-ink">{catLabel(c.label)}</span>
                  <span className="block px-1 text-xs text-muted">{t('gallery.count', { n: c.n })}</span>
                </button>
              ))}
            </div>
          </div>
        ) : view?.kind === 'dups' && dupGroups ? (
          <div className="px-3">
            {dupGroups.length === 0 ? (
              <p className="py-16 text-center text-sm text-muted">{t('gallery.dups.none')}</p>
            ) : (
              <p className="pb-2 text-xs text-muted">{t('gallery.dups.groups', { n: dupGroups.length })}</p>
            )}
            {dupGroups.map((g, gi) => {
              const start = dupGroups.slice(0, gi).reduce((n, x) => n + x.items.length, 0);
              return (
                <div key={g.items[0].path} className="mb-2 flex gap-0.5 overflow-x-auto rounded-xl bg-surface p-1 shadow-card">
                  {g.items.map((m, i) => (
                    <div key={m.path} className="w-24 shrink-0">
                      <Thumb m={m} onOpen={() => setPreview(start + i)} />
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        ) : tab === 'albums' && album === null && !view ? (
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
        ) : items && items.length === 0 && videoHits.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
            <EmptyFolderArt />
            <p className="font-medium text-ink">{view ? t('gallery.noResults') : t('gallery.empty')}</p>
            {!view && <p className="text-sm text-muted">{t('gallery.emptyHint')}</p>}
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
            {videoHits.length > 0 && (
              <section className="mb-3">
                <h2 className="px-4 py-1.5 text-sm font-semibold text-heading">{t('gallery.inVideos')}</h2>
                <div className="grid grid-cols-3 gap-0.5 @2xl:grid-cols-5 @5xl:grid-cols-7">
                  {videoHits.map((m) => (
                    <Thumb
                      key={m.path}
                      m={m}
                      caption={t('gallery.videoAt', { t: fmtTime(m.t) })}
                      onOpen={() => window.open(`/api/fs/file?path=${encodeURIComponent(m.path)}#t=${Math.floor(m.t)}`, '_blank')}
                    />
                  ))}
                </div>
              </section>
            )}
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

      {preview !== null && items && items[preview] && (
        <Preview
          items={items.map(toEntry)}
          index={preview}
          onIndex={setPreview}
          onClose={() => setPreview(null)}
          onDelete={(e) => void remove(e)}
          onSimilar={vision?.installed ? (e) => openView({ kind: 'similar', path: e.path }) : undefined}
        />
      )}
    </>
  );
}
