import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import { api } from '../lib/api';
import { usePoll } from '../lib/usePoll';
import { useI18n, type MessageKey } from '../i18n';
import { Button, Card, PageHeader } from '../components/ui';

/**
 * "Watch": Jellyfin-style home for the library (continue watching, next up, newest per library),
 * library grids with sorting and filters, a details page with seasons/episodes, subtitles and
 * watched/favourite — and searching for something new to download (best release, or Arabic-dubbed).
 * Playback itself happens in Jellyfin.
 */
type Kind = 'movie' | 'series';
interface Found {
  tmdb?: string;
  kind: Kind;
  name: string;
  nameAr: string | null;
  year?: number;
  overview: string;
  poster: string | null;
  inLibrary: { id: string } | null;
}
interface Opt {
  hash: string;
  name: string;
  sizeGB: number;
  seeders: number;
  trusted: boolean;
  have: boolean;
}
interface ApItem {
  id: string;
  name: string;
  sizeGB: number;
  seeders: number;
  free: boolean;
  dl: string;
  category: string;
  catId: number;
  leechers: number;
  added: string;
}
interface Media {
  id: string;
  poster: string;
  still: string;
  name: string;
  sub: string | null;
  type: string;
  year: number | null;
  minutes: number | null;
  rating: number | null;
  progress: number;
  played: boolean;
  favorite: boolean;
  unplayed: number | null;
}
interface Home {
  jellyfin: string | null;
  resume: Media[];
  nextUp: Media[];
  libraries: { id: string; name: string; type: string; items: Media[] }[];
}
interface Detail extends Media {
  overview: string;
  tagline: string | null;
  genres: string[];
  officialRating: string | null;
  cast: string[];
  subtitles: string[];
  audio: string[];
  backdrop: boolean;
  seasons: { id: string; name: string; episodes: Media[] }[];
  jellyfinUrl: string;
  jellyfin: string | null;
}

const img = (id: string, type?: 'backdrop' | 'thumb') => `/api/watch/img/${id}${type ? `?type=${type}` : ''}`;
/** Library names are "أفلام · Movies": show the part in the UI's language. */
const libName = (name: string, locale: string) => {
  const [a, b] = name.split(' · ');
  return b ? (locale === 'ar' ? a : b) : name;
};

export function Watch() {
  const params = new URLSearchParams(useSearch());
  const item = params.get('item');
  const lib = params.get('lib');
  if (item) return <ItemView id={item} />;
  if (lib) return <LibraryView id={lib} name={params.get('name') ?? ''} />;
  return <WatchHome />;
}

function WatchHome() {
  const { t, locale } = useI18n();
  const [, go] = useLocation();
  const { data } = usePoll<Home>('/api/watch/home', 120_000);
  const open = (m: Media) => go(`/watch?item=${m.type === 'Episode' ? m.id : m.id}`);
  return (
    <>
      <PageHeader title={t('watch.title')} back="/" />
      <main className="safe-bottom mx-auto max-w-6xl space-y-5 px-3">
        <SearchBox />
        {!data && <p className="p-6 text-center text-sm text-muted">…</p>}
        {!!data?.resume.length && (
          <Row title={t('watch.continue')}>
            {data.resume.map((m) => (
              <StillCard key={m.id} m={m} onOpen={() => open(m)} />
            ))}
          </Row>
        )}
        {!!data?.nextUp.length && (
          <Row title={t('watch.nextUp')}>
            {data.nextUp.map((m) => (
              <StillCard key={m.id} m={m} onOpen={() => open(m)} />
            ))}
          </Row>
        )}
        {data?.libraries.map((l) => (
          <Row
            key={l.id}
            title={t('watch.latestIn', { lib: libName(l.name, locale) })}
            action={
              <Link href={`/watch?lib=${l.id}&name=${encodeURIComponent(l.name)}`} className="text-sm font-medium text-primary">
                {t('watch.seeAll')}
              </Link>
            }
          >
            {l.items.map((m) => (
              <PosterCard key={m.id} m={m} onOpen={() => open(m)} />
            ))}
          </Row>
        ))}
      </main>
    </>
  );
}

/** A horizontal shelf: swipe on phones (snaps to cards), arrows on a mouse, D-pad on a TV. */
function Row({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const by = (dir: 1 | -1) => {
    const el = ref.current;
    if (!el) return;
    const rtl = getComputedStyle(el).direction === 'rtl';
    el.scrollBy({ left: dir * (rtl ? -1 : 1) * el.clientWidth * 0.85, behavior: 'smooth' });
  };
  return (
    <section className="group relative">
      <div className="mb-2 flex items-center justify-between gap-3 px-1">
        <h2 className="text-lg font-bold text-heading">{title}</h2>
        {action}
      </div>
      <div
        ref={ref}
        className="-mx-3 flex snap-x snap-mandatory scroll-px-3 gap-3 overflow-x-auto overscroll-x-contain px-3 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {children}
      </div>
      <button type="button" aria-label="‹" onClick={() => by(-1)} className="absolute start-0 top-1/2 hidden size-10 -translate-y-1/2 items-center justify-center rounded-full bg-surface/90 text-xl text-heading shadow-card [@media(hover:hover)]:group-hover:flex">
        <span className="rtl:rotate-180">‹</span>
      </button>
      <button type="button" aria-label="›" onClick={() => by(1)} className="absolute end-0 top-1/2 hidden size-10 -translate-y-1/2 items-center justify-center rounded-full bg-surface/90 text-xl text-heading shadow-card [@media(hover:hover)]:group-hover:flex">
        <span className="rtl:rotate-180">›</span>
      </button>
    </section>
  );
}

function Badges({ m }: { m: Media }) {
  return (
    <>
      {m.played && <span className="absolute end-1.5 top-1.5 flex size-6 items-center justify-center rounded-full bg-ok text-xs text-white shadow">✓</span>}
      {!m.played && !!m.unplayed && <span className="absolute end-1.5 top-1.5 min-w-6 rounded-full bg-primary px-1.5 py-0.5 text-center text-xs font-bold text-white shadow">{m.unplayed}</span>}
      {m.favorite && <span className="absolute start-1.5 top-1.5 text-base drop-shadow">❤️</span>}
    </>
  );
}

function PosterCard({ m, onOpen }: { m: Media; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} className="w-[7.5rem] shrink-0 snap-start text-start sm:w-36 focus-visible:outline-none">
      <div className="relative aspect-[2/3] overflow-hidden rounded-xl bg-surface shadow-card transition group-focus-within:opacity-100 [button:focus-visible_&]:ring-4 [button:focus-visible_&]:ring-primary">
        <img src={img(m.poster)} alt="" loading="lazy" className="size-full object-cover" />
        <Badges m={m} />
        {m.progress > 0 && <Progress value={m.progress} />}
      </div>
      <p className="mt-1.5 line-clamp-2 text-[13px] font-medium leading-tight text-heading" dir="auto">
        {m.name}
      </p>
      <p className="text-[11px] text-muted">{m.year ?? ''}</p>
    </button>
  );
}

function StillCard({ m, onOpen }: { m: Media; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} className="w-64 shrink-0 snap-start text-start sm:w-72 focus-visible:outline-none">
      <div className="relative aspect-video overflow-hidden rounded-xl bg-surface shadow-card [button:focus-visible_&]:ring-4 [button:focus-visible_&]:ring-primary">
        <img src={img(m.still, m.type === 'Episode' ? 'thumb' : 'backdrop')} alt="" loading="lazy" className="size-full object-cover" />
        <span className="absolute inset-0 flex items-center justify-center">
          <span className="flex size-11 items-center justify-center rounded-full bg-black/45 text-lg text-white backdrop-blur-sm">▶</span>
        </span>
        <Badges m={m} />
        {m.progress > 0 && <Progress value={m.progress} />}
      </div>
      <p className="mt-1.5 truncate text-[13px] font-semibold text-heading" dir="auto">
        {m.name}
      </p>
      <p className="truncate text-[11px] text-muted" dir="auto">
        {m.sub ?? (m.year ?? '')}
      </p>
    </button>
  );
}

function Progress({ value }: { value: number }) {
  return (
    <span className="absolute inset-x-0 bottom-0 h-1.5 bg-black/40">
      <span className="block h-full bg-primary" style={{ width: `${Math.min(100, value * 100)}%` }} />
    </span>
  );
}

const SORTS = ['added', 'name', 'year', 'rating'] as const;
const FILTERS = ['all', 'unplayed', 'favorites'] as const;

function LibraryView({ id, name }: { id: string; name: string }) {
  const { t, locale } = useI18n();
  const [, go] = useLocation();
  const [sort, setSort] = useState<(typeof SORTS)[number]>('added');
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('all');
  const [genre, setGenre] = useState('');
  const [items, setItems] = useState<Media[]>([]);
  const [total, setTotal] = useState(0);
  const [genres, setGenres] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const load = async (start: number) => {
    setBusy(true);
    try {
      const r = await api<{ items: Media[]; total: number; genres: string[] }>(`/api/watch/library/${id}?sort=${sort}&filter=${filter}&start=${start}${genre ? `&genre=${encodeURIComponent(genre)}` : ''}`);
      setItems((prev) => (start ? [...prev, ...r.items] : r.items));
      setTotal(r.total);
      if (!start) setGenres(r.genres);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void load(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, sort, filter, genre]);
  const chip = (on: boolean) => `min-h-9 shrink-0 rounded-full px-3.5 text-sm ${on ? 'bg-primary text-white' : 'bg-surface text-ink shadow-card'}`;
  return (
    <>
      <PageHeader title={libName(name, locale) || t('watch.title')} back="/watch" />
      <main className="safe-bottom mx-auto max-w-6xl space-y-3 px-3">
        <div className="-mx-3 flex gap-1.5 overflow-x-auto px-3 py-0.5 [scrollbar-width:none]">
          {SORTS.map((s) => (
            <button key={s} type="button" className={chip(sort === s)} onClick={() => setSort(s)}>
              {t(`watch.sort.${s}` as MessageKey)}
            </button>
          ))}
          <span className="mx-1 w-px shrink-0 bg-line" aria-hidden />
          {FILTERS.map((f) => (
            <button key={f} type="button" className={chip(filter === f)} onClick={() => setFilter(f)}>
              {t(`watch.filter.${f}` as MessageKey)}
            </button>
          ))}
        </div>
        {genres.length > 0 && (
          <select value={genre} onChange={(e) => setGenre(e.target.value)} className="min-h-10 rounded-xl border border-line bg-surface px-3 text-sm" aria-label={t('watch.genre')}>
            <option value="">{t('watch.allGenres')}</option>
            {genres.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        )}
        <p className="px-1 text-xs text-muted">{t('watch.count', { n: total })}</p>
        <div className="grid grid-cols-3 gap-x-3 gap-y-4 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-7">
          {items.map((m) => (
            <GridPoster key={m.id} m={m} onOpen={() => go(`/watch?item=${m.id}`)} />
          ))}
        </div>
        {items.length < total && (
          <Button variant="secondary" className="w-full" disabled={busy} onClick={() => void load(items.length)}>
            {busy ? '…' : t('watch.loadMore')}
          </Button>
        )}
      </main>
    </>
  );
}

function GridPoster({ m, onOpen }: { m: Media; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} className="min-w-0 text-start focus-visible:outline-none">
      <div className="relative aspect-[2/3] overflow-hidden rounded-xl bg-surface shadow-card [button:focus-visible_&]:ring-4 [button:focus-visible_&]:ring-primary">
        <img src={img(m.poster)} alt="" loading="lazy" className="size-full object-cover" />
        <Badges m={m} />
        {m.progress > 0 && <Progress value={m.progress} />}
      </div>
      <p className="mt-1.5 line-clamp-2 text-[12px] font-medium leading-tight text-heading" dir="auto">
        {m.name}
      </p>
      <p className="text-[11px] text-muted">{[m.year, m.rating ? `★ ${m.rating}` : null].filter(Boolean).join(' · ')}</p>
    </button>
  );
}

function ItemView({ id }: { id: string }) {
  const { t } = useI18n();
  const { data, reload } = usePoll<Detail>(`/api/watch/item/${id}`, 600_000);
  const [season, setSeason] = useState(0);
  const [busy, setBusy] = useState(false);
  const act = async (a: string) => {
    setBusy(true);
    await api(`/api/watch/item/${id}/${a}`, { method: 'POST', body: {} }).catch(() => null);
    await reload();
    setBusy(false);
  };
  useEffect(() => {
    // Open the season with the first unwatched episode.
    if (!data?.seasons.length) return;
    const i = data.seasons.findIndex((s) => s.episodes.some((e) => !e.played));
    setSeason(i < 0 ? 0 : i);
  }, [data?.id, data?.seasons]);
  const play = (itemId: string) => data?.jellyfin && window.open(`${data.jellyfin}/web/#/details?id=${itemId}`, '_blank');
  const lang = (l: string) => ({ ara: 'العربية', ar: 'العربية', eng: 'English', en: 'English', hin: 'Hindi', jpn: '日本語', tur: 'Türkçe', fre: 'Français' })[l] ?? l;
  if (!data)
    return (
      <>
        <PageHeader title={t('watch.title')} back />
        <p className="p-6 text-center text-sm text-muted">…</p>
      </>
    );
  const hasArabic = data.subtitles.some((s) => /^ar/.test(s)) || data.audio.some((s) => /^ar/.test(s));
  return (
    <>
      <PageHeader title={data.name} back />
      <main className="safe-bottom mx-auto max-w-5xl space-y-4 px-3">
        <div className="relative -mx-3 overflow-hidden sm:mx-0 sm:rounded-2xl">
          <img src={img(data.id, 'backdrop')} alt="" className="aspect-video max-h-[46dvh] w-full object-cover" />
          <div className="absolute inset-0 bg-gradient-to-t from-canvas via-canvas/40 to-transparent" />
          <div className="absolute inset-x-0 bottom-0 flex items-end gap-4 p-4">
            <img src={img(data.poster)} alt="" className="hidden w-28 shrink-0 rounded-xl shadow-card sm:block" />
            <div className="min-w-0">
              <h1 className="text-2xl font-bold text-heading drop-shadow" dir="auto">
                {data.name}
              </h1>
              <p className="mt-1 flex flex-wrap gap-x-2 text-sm text-ink">
                {[data.year, data.minutes ? t('watch.min', { n: data.minutes }) : null, data.rating ? `★ ${data.rating}` : null, data.officialRating].filter(Boolean).map((x) => (
                  <span key={String(x)}>{x}</span>
                ))}
              </p>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button onClick={() => play(data.type === 'Series' ? (data.seasons[season]?.episodes.find((e) => !e.played)?.id ?? data.id) : data.id)}>▶ {t(data.progress > 0 ? 'watch.resume' : 'watch.play')}</Button>
          <Button variant="secondary" disabled={busy} onClick={() => void act(data.played ? 'unplayed' : 'played')}>
            {data.played ? '↺ ' + t('watch.markUnwatched') : '✓ ' + t('watch.markWatched')}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => void act(data.favorite ? 'unfavorite' : 'favorite')}>
            {data.favorite ? '💔 ' + t('watch.unfavorite') : '❤️ ' + t('watch.favorite')}
          </Button>
        </div>

        {data.genres.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {data.genres.map((g) => (
              <span key={g} className="rounded-full bg-primary-soft px-3 py-1 text-xs text-primary-ink">
                {g}
              </span>
            ))}
          </div>
        )}
        {data.tagline && <p className="text-sm italic text-muted">{data.tagline}</p>}
        {data.overview && (
          <p className="text-[15px] leading-relaxed text-ink" dir="auto">
            {data.overview}
          </p>
        )}

        <div className="grid gap-2 text-sm sm:grid-cols-3">
          <Fact label={t('watch.subtitles')} value={data.subtitles.length ? data.subtitles.map(lang).join(', ') : '—'} good={hasArabic} />
          <Fact label={t('watch.audio')} value={data.audio.length ? data.audio.map(lang).join(', ') : '—'} />
          {data.cast.length > 0 && <Fact label={t('watch.cast')} value={data.cast.join(', ')} />}
        </div>

        {data.seasons.length > 0 && (
          <Card>
            <div className="-mx-1 mb-3 flex gap-1.5 overflow-x-auto px-1 [scrollbar-width:none]">
              {data.seasons.map((s, i) => (
                <button key={s.id} type="button" onClick={() => setSeason(i)} className={`min-h-9 shrink-0 rounded-full px-3.5 text-sm ${season === i ? 'bg-primary text-white' : 'bg-canvas text-ink'}`}>
                  {s.name}
                </button>
              ))}
            </div>
            <ul className="space-y-2">
              {data.seasons[season]?.episodes.map((e) => (
                <li key={e.id}>
                  <button type="button" onClick={() => play(e.id)} className="flex w-full items-center gap-3 rounded-xl p-1.5 text-start active:bg-primary-soft">
                    <span className="relative aspect-video w-32 shrink-0 overflow-hidden rounded-lg bg-canvas sm:w-40">
                      <img src={img(e.still, 'thumb')} alt="" loading="lazy" className="size-full object-cover" />
                      {e.played && <span className="absolute end-1 top-1 flex size-5 items-center justify-center rounded-full bg-ok text-[10px] text-white">✓</span>}
                      {e.progress > 0 && <Progress value={e.progress} />}
                    </span>
                    <span className="min-w-0">
                      <span className="line-clamp-2 text-sm font-medium text-heading" dir="auto">
                        {e.sub?.replace(/^S\d+:E/, '') ?? e.name}
                      </span>
                      {e.minutes && <span className="block text-xs text-muted">{t('watch.min', { n: e.minutes })}</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </main>
    </>
  );
}

function Fact({ label, value, good }: { label: string; value: string; good?: boolean }) {
  return (
    <div className="rounded-xl bg-surface p-3 shadow-card">
      <p className="text-xs text-muted">{label}</p>
      <p className={`mt-0.5 ${good ? 'font-medium text-ok-ink' : 'text-ink'}`} dir="auto">
        {good ? '✓ ' : ''}
        {value}
      </p>
    </div>
  );
}

/** Search for something new: in the library → its page; not yet → releases to download. */
function SearchBox() {
  const { t } = useI18n();
  const [, go] = useLocation();
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<Kind>('movie');
  const [found, setFound] = useState<Found[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [pick, setPick] = useState<Found | null>(null);
  const search = async () => {
    setBusy(true);
    setPick(null);
    try {
      setFound((await api<{ results: Found[] }>(`/api/watch/find?q=${encodeURIComponent(q)}&kind=${kind}`)).results);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Card>
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (q.trim()) void search();
          }}
        >
          <div className="flex gap-2">
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('watch.placeholder')} className="min-h-12 min-w-0 flex-1 rounded-xl border border-line bg-canvas px-3" aria-label={t('watch.placeholder')} />
            <Button type="submit" disabled={!q.trim() || busy}>
              {busy ? '…' : t('watch.search')}
            </Button>
          </div>
          <div className="flex items-center gap-1" role="tablist">
            {(['movie', 'series'] as Kind[]).map((k) => (
              <button key={k} type="button" role="tab" aria-selected={kind === k} onClick={() => setKind(k)} className={`min-h-9 rounded-full px-3 text-sm ${kind === k ? 'bg-primary text-white' : 'bg-canvas text-ink'}`}>
                {t(k === 'movie' ? 'watch.movie' : 'watch.series')}
              </button>
            ))}
            {found && (
              <button type="button" onClick={() => (setFound(null), setPick(null), setQ(''))} className="ms-auto min-h-9 px-2 text-sm text-primary">
                {t('watch.clear')}
              </button>
            )}
          </div>
        </form>
      </Card>
      {pick && <Options item={pick} onClose={() => setPick(null)} />}
      {found && (
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6">
          {found.map((f) => (
            <button key={`${f.tmdb}-${f.name}`} type="button" onClick={() => (f.inLibrary ? go(`/watch?item=${f.inLibrary.id}`) : setPick(f))} className="min-w-0 text-start">
              <div className="relative aspect-[2/3] overflow-hidden rounded-xl bg-surface shadow-card">
                {f.poster && <img src={`/api/watch/tmdb-img?p=${encodeURIComponent(f.poster)}`} alt="" loading="lazy" className="size-full object-cover" />}
                {f.inLibrary && <span className="absolute start-1.5 top-1.5 rounded-full bg-ok px-2 py-0.5 text-[11px] font-medium text-white">{t('watch.have')}</span>}
              </div>
              <p className="mt-1.5 line-clamp-2 text-[12px] font-medium leading-tight text-heading" dir="auto">
                {f.nameAr ?? f.name}
              </p>
              <p className="text-[11px] text-muted">{f.year ?? ''}</p>
            </button>
          ))}
          {!found.length && <p className="col-span-full p-4 text-center text-sm text-muted">{t('watch.nothing')}</p>}
        </div>
      )}
    </>
  );
}

function Options({ item, onClose }: { item: Found; onClose: () => void }) {
  const { t } = useI18n();
  const [season, setSeason] = useState(1);
  const url = `/api/watch/options?kind=${item.kind}&name=${encodeURIComponent(item.name)}${item.year ? `&year=${item.year}` : ''}${item.nameAr ? `&nameAr=${encodeURIComponent(item.nameAr)}` : ''}${item.kind === 'series' ? `&season=${season}` : ''}`;
  const { data } = usePoll<{ tpb: Opt[]; arabp2p: { items: ApItem[]; ratio: number | null } | null }>(url, 600_000);
  const [msg, setMsg] = useState<string | null>(null);
  const get = async (body: unknown) => {
    setMsg('…');
    try {
      const r = await api<{ ok: boolean; message: string }>('/api/watch/get', { method: 'POST', body });
      setMsg(r.ok ? t('watch.started') : r.message);
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  return (
    <Card title={`${item.nameAr ?? item.name}${item.year ? ` (${item.year})` : ''}`} action={<Button variant="secondary" onClick={onClose}>{t('bk.close')}</Button>}>
      {item.overview && <p className="mb-3 line-clamp-4 text-sm text-ink">{item.overview}</p>}
      {item.kind === 'series' && (
        <label className="mb-2 flex items-center gap-2 text-sm">
          {t('watch.season')}
          <input type="number" min={1} max={40} value={season} onChange={(e) => setSeason(Math.max(1, +e.target.value || 1))} className="min-h-10 w-20 rounded-lg border border-line bg-canvas px-2" />
        </label>
      )}
      {msg && <p className="mb-2 rounded-lg bg-primary-soft p-2 text-sm">{msg}</p>}
      {!data && <p className="text-sm text-muted">{t('watch.looking')}</p>}
      {data && (
        <ul className="divide-y divide-line">
          {data.tpb.map((o, i) => (
            <li key={o.hash} className="flex items-center gap-2 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm" dir="ltr">
                  {i === 0 && <span className="me-1 rounded bg-ok px-1.5 text-[11px] text-white">{t('watch.best')}</span>}
                  {o.name}
                </p>
                <p className="text-xs text-muted" dir="ltr">
                  {o.sizeGB} GB · {o.seeders} seeds{o.trusted ? ' · ✓' : ''}
                </p>
              </div>
              <Button className="min-h-10 shrink-0 px-3 text-sm" disabled={o.have} onClick={() => void get({ source: 'tpb', hash: o.hash, name: o.name, kind: item.kind })}>
                {o.have ? t('watch.haveIt') : t('watch.get')}
              </Button>
            </li>
          ))}
          {!data.tpb.length && <li className="py-2 text-sm text-muted">{t('watch.noRelease')}</li>}
        </ul>
      )}
      {data?.arabp2p && data.arabp2p.items.length > 0 && (
        <>
          <p className="mt-3 text-sm font-semibold text-heading">{t('watch.arabic', { ratio: data.arabp2p.ratio ?? '—' })}</p>
          <ul className="divide-y divide-line">
            {data.arabp2p.items.map((a) => (
              <li key={a.id} className="flex items-center gap-2 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{a.name}</p>
                  <p className="text-xs text-muted" dir="ltr">
                    {a.sizeGB} GB · {a.seeders} seeds{a.free ? ' · 🆓' : ''}
                  </p>
                </div>
                <Button variant="secondary" className="min-h-10 shrink-0 px-3 text-sm" onClick={() => void get({ source: 'arabp2p', item: a, kind: item.kind })}>
                  {t('watch.get')}
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}
