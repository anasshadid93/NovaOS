import { useEffect, useMemo, useState } from 'react';
import { Add20Regular, ArrowShuffle20Regular, Delete16Regular, MoreHorizontal20Regular, Play24Filled, Search20Regular, TextBulletListLtr16Regular } from '@fluentui/react-icons';
import { api } from '../lib/api';
import { player, type Track } from '../lib/player';
import { Cover, NowPlaying, fmt } from '../components/NowPlaying';
import { useI18n, type MessageKey } from '../i18n';
import { Dialog } from '../components/Dialog';
import { PageHeader } from '../components/ui';

interface Playlist {
  id: number;
  name: string;
  items: string[];
}
type Tab = 'songs' | 'albums' | 'artists' | 'playlists';
type View = { kind: 'album' | 'artist'; name: string } | { kind: 'playlist'; id: number } | null;

export function Music() {
  const { t, tn } = useI18n();
  const [tracks, setTracks] = useState<Track[] | null>(null);
  const [lists, setLists] = useState<Playlist[]>([]);
  const [tab, setTab] = useState<Tab>('songs');
  const [view, setView] = useState<View>(null);
  const [q, setQ] = useState('');
  const [menu, setMenu] = useState<Track | null>(null);
  const [newList, setNewList] = useState<string | null>(null);

  const loadLists = () => void api<Playlist[]>('/api/music/playlists').then(setLists);
  useEffect(() => {
    const load = () => api<{ tracks: Track[]; filling: boolean }>('/api/music/library').then((r) => setTracks(r.tracks.sort((a, b) => a.title.localeCompare(b.title))));
    void load();
    loadLists();
    // Tags are read in the background the first time: refresh once they're in.
    const id = setTimeout(() => void load(), 6000);
    return () => clearTimeout(id);
  }, []);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (tracks ?? []).filter((x) => !s || `${x.title} ${x.artist ?? ''} ${x.album ?? ''}`.toLowerCase().includes(s));
  }, [tracks, q]);
  const groups = (key: 'album' | 'artist') => {
    const m = new Map<string, Track[]>();
    for (const x of filtered) {
      const k = x[key] ?? t('music.unknown');
      m.set(k, [...(m.get(k) ?? []), x]);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  };
  const byPath = useMemo(() => new Map((tracks ?? []).map((x) => [x.path, x])), [tracks]);

  const viewTracks: Track[] =
    view?.kind === 'album' || view?.kind === 'artist'
      ? filtered.filter((x) => (x[view.kind] ?? t('music.unknown')) === view.name)
      : view?.kind === 'playlist'
        ? (lists
            .find((l) => l.id === view.id)
            ?.items.map((p) => byPath.get(p))
            .filter((x): x is Track => !!x) ?? [])
        : filtered;

  const addTo = async (list: Playlist, track: Track) => {
    await api(`/api/music/playlists/${list.id}`, {
      method: 'PUT',
      body: { items: [...list.items, track.path] },
    });
    loadLists();
    setMenu(null);
  };
  const createList = async (name: string, first?: Track) => {
    if (!name.trim()) return;
    await api('/api/music/playlists', {
      body: { name, items: first ? [first.path] : [] },
    });
    setNewList(null);
    setMenu(null);
    loadLists();
  };

  const songRows = (list: Track[]) => (
    <ul className="divide-y divide-line overflow-hidden rounded-list bg-surface shadow-card">
      {list.map((x, i) => (
        <li key={x.path} className="flex items-center gap-3 px-3 py-2">
          <button type="button" onClick={() => player.play(list, i)} className="flex min-w-0 flex-1 items-center gap-3 text-start">
            <Cover path={x.path} size={40} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-ink" dir="auto">
                {x.title}
              </span>
              <span className="block truncate text-xs text-muted" dir="auto">
                {[x.artist, x.album].filter(Boolean).join(' · ')}
              </span>
            </span>
            <span className="text-xs tabular-nums text-muted">{fmt(x.duration)}</span>
          </button>
          <button type="button" onClick={() => setMenu(x)} className="inline-flex size-8 items-center justify-center rounded-full text-muted hover:bg-primary-soft" aria-label={t('fm.more')}>
            <MoreHorizontal20Regular aria-hidden />
          </button>
        </li>
      ))}
    </ul>
  );

  const tabs: Tab[] = ['songs', 'albums', 'artists', 'playlists'];
  const viewTitle = view ? (view.kind === 'playlist' ? (lists.find((l) => l.id === view.id)?.name ?? '') : view.name) : t('music.title');

  return (
    <>
      <PageHeader title={viewTitle} back={view ? true : '/'}>
        {!view && (
          <div className="space-y-2">
            <label className="flex items-center gap-2 rounded-xl bg-surface px-3 py-2 ring-1 ring-line">
              <Search20Regular className="text-muted" aria-hidden />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('music.search')} className="min-w-0 flex-1 bg-transparent text-sm outline-none" />
            </label>
            <div className="grid grid-cols-4 gap-1 rounded-xl bg-primary-soft p-1" role="tablist">
              {tabs.map((x) => (
                <button key={x} type="button" role="tab" aria-selected={tab === x} onClick={() => setTab(x)} className={`min-h-9 rounded-lg text-sm ${tab === x ? 'bg-surface font-medium text-heading shadow-card' : 'text-muted'}`}>
                  {t(`music.tab.${x}` as MessageKey)}
                </button>
              ))}
            </div>
          </div>
        )}
      </PageHeader>
      <main className="safe-bottom mx-auto max-w-md space-y-4 px-3 pb-28">
        <NowPlaying />
        {tracks === null ? (
          <p className="py-10 text-center text-sm text-muted">{t('common.loading')}</p>
        ) : tracks.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted">{t('music.empty')}</p>
        ) : view ? (
          <>
            <div className="flex gap-2">
              <button type="button" onClick={() => player.play(viewTracks, 0)} className="inline-flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-sm font-medium text-white">
                <Play24Filled className="size-4" aria-hidden />
                {t('music.playAll')}
              </button>
              <button
                type="button"
                onClick={() => {
                  player.setShuffle(true);
                  player.play(viewTracks, Math.floor(Math.random() * viewTracks.length));
                }}
                className="inline-flex items-center gap-1.5 rounded-full bg-primary-soft px-4 py-2 text-sm font-medium text-primary-ink"
              >
                <ArrowShuffle20Regular className="size-4" aria-hidden />
                {t('music.shuffle')}
              </button>
            </div>
            {songRows(viewTracks)}
          </>
        ) : tab === 'songs' ? (
          <>
            <p className="px-1 text-xs text-muted">{tn('music.songs', filtered.length)}</p>
            {songRows(filtered)}
          </>
        ) : tab === 'albums' ? (
          <div className="grid grid-cols-2 gap-3 @2xl:grid-cols-4">
            {groups('album').map(([name, list]) => (
              <button key={name} type="button" onClick={() => setView({ kind: 'album', name })} className="text-start">
                <span className="block aspect-square overflow-hidden rounded-2xl shadow-card">
                  <Cover path={list[0].path} size={400} />
                </span>
                <span className="mt-1.5 block truncate text-sm font-medium text-ink" dir="auto">
                  {name}
                </span>
                <span className="block truncate text-xs text-muted" dir="auto">
                  {list[0].artist ?? tn('music.songs', list.length)}
                </span>
              </button>
            ))}
          </div>
        ) : tab === 'artists' ? (
          <ul className="divide-y divide-line overflow-hidden rounded-list bg-surface shadow-card">
            {groups('artist').map(([name, list]) => (
              <li key={name}>
                <button type="button" onClick={() => setView({ kind: 'artist', name })} className="flex w-full items-center gap-3 px-3 py-2.5 text-start">
                  <Cover path={list[0].path} size={40} />
                  <span className="min-w-0 flex-1 truncate text-sm text-ink" dir="auto">
                    {name}
                  </span>
                  <span className="text-xs text-muted">{tn('music.songs', list.length)}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="space-y-2">
            <button type="button" onClick={() => setNewList('')} className="inline-flex items-center gap-1.5 rounded-full bg-primary-soft px-4 py-2 text-sm font-medium text-primary-ink">
              <Add20Regular aria-hidden />
              {t('music.newPlaylist')}
            </button>
            <ul className="divide-y divide-line overflow-hidden rounded-list bg-surface shadow-card">
              {lists.map((l) => (
                <li key={l.id} className="flex items-center gap-3 px-3 py-2.5">
                  <button type="button" onClick={() => setView({ kind: 'playlist', id: l.id })} className="flex min-w-0 flex-1 items-center gap-3 text-start">
                    <Cover path={l.items[0]} size={40} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-ink" dir="auto">
                        {l.name}
                      </span>
                      <span className="text-xs text-muted">{tn('music.songs', l.items.length)}</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void api(`/api/music/playlists/${l.id}`, {
                        method: 'DELETE',
                      }).then(loadLists)
                    }
                    className="text-muted hover:text-danger"
                    aria-label={t('common.delete')}
                  >
                    <Delete16Regular aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </main>

      <Dialog open={!!menu} onClose={() => setMenu(null)} title={menu?.title ?? ''}>
        {menu && (
          <div className="space-y-2">
            <button type="button" onClick={() => (player.enqueue([menu]), setMenu(null))} className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-start text-ink hover:bg-primary-soft">
              <TextBulletListLtr16Regular aria-hidden />
              {t('music.addToQueue')}
            </button>
            <p className="px-3 pt-1 text-xs font-semibold uppercase text-muted">{t('music.addToPlaylist')}</p>
            {lists.map((l) => (
              <button key={l.id} type="button" onClick={() => void addTo(l, menu)} className="flex min-h-10 w-full items-center rounded-xl px-3 text-start text-sm text-ink hover:bg-primary-soft" dir="auto">
                {l.name}
              </button>
            ))}
            <button type="button" onClick={() => setNewList('')} className="flex min-h-10 w-full items-center gap-2 rounded-xl px-3 text-start text-sm text-primary-ink hover:bg-primary-soft">
              <Add20Regular aria-hidden />
              {t('music.newPlaylist')}
            </button>
          </div>
        )}
      </Dialog>
      <Dialog open={newList !== null} onClose={() => setNewList(null)} title={t('music.newPlaylist')}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void createList(newList ?? '', menu ?? undefined);
          }}
          className="space-y-3"
        >
          <input
            autoFocus
            value={newList ?? ''}
            onChange={(e) => setNewList(e.target.value)}
            placeholder={t('music.playlistName')}
            className="min-h-11 w-full rounded-xl bg-canvas px-3 ring-1 ring-line outline-none focus:ring-2 focus:ring-primary"
            dir="auto"
          />
          <button type="submit" className="min-h-11 w-full rounded-xl bg-primary font-medium text-white">
            {t('fm.create')}
          </button>
        </form>
      </Dialog>
    </>
  );
}
