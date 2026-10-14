import { useRef, useState, type ReactNode } from 'react';
import { Link } from 'wouter';
import { api } from '../lib/api';
import { formatBytes } from '../lib/format';
import { usePoll } from '../lib/usePoll';
import { useI18n } from '../i18n';
import { Button, Card, PageHeader } from '../components/ui';

/**
 * Games: the server streams ES-DE and its emulators (arcade, PS1–PS3, Nintendo, Sega…) to the TV through
 * Moonlight. Pair a TV with the code it shows, see the games per console, what BIOS is missing, and
 * whether a PS3 game runs well before downloading it.
 */
interface System {
  id: string;
  name: string;
  count: number;
  bytes: number;
  games: Game[];
}
interface Game {
  name: string;
  rom: string;
  system?: string;
  systemName?: string;
  favorite?: boolean;
  at?: number;
}
interface Home {
  recent: Game[];
  favorites: Game[];
  playing: string | null;
}
interface Saves {
  dirs: { dir: string; bytes: number }[];
  snapshots: { id: string; short: string; time: string }[];
}
interface Data {
  running: boolean;
  playing: string | null;
  pendingPair: { at: number } | null;
  paired: number;
  library: System[];
  bios: { system: string; label: string; present: boolean }[];
  root: string;
  lanIp: string;
  hostname: string;
  firmwareDownloading: boolean;
}
interface Compat {
  id: string;
  title: string;
  status: string;
}
const COMPAT_COLOR: Record<string, string> = { Playable: 'bg-ok', Ingame: 'bg-amber-400', Intro: 'bg-orange-500', Loadable: 'bg-danger', Nothing: 'bg-danger' };

export function Games() {
  const { t } = useI18n();
  const { data, reload } = usePoll<Data>('/api/games', 3000);
  const [pin, setPin] = useState('');
  const [pairMsg, setPairMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [compat, setCompat] = useState<Compat[] | null>(null);
  const home = usePoll<Home>('/api/games/home', 5000);
  const saves = usePoll<Saves>('/api/games/saves', 120_000);
  const [find, setFind] = useState('');
  const [found, setFound] = useState<Game[] | null>(null);
  const [snap, setSnap] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const flash = (text: string) => {
    setMsg(text);
    setTimeout(() => setMsg(null), 4000);
  };
  const play = async (g: Game) => {
    try {
      await api('/api/games/launch', { method: 'POST', body: { rom: g.rom } });
      flash(t('games.launched', { name: g.name }));
      void home.reload();
      void reload();
    } catch (e) {
      const code = (e as Error).message;
      flash(code.includes('already_playing') ? t('games.busy') : t('games.launchFailed'));
    }
  };
  const fav = async (g: Game) => {
    await api('/api/games/favorite', { method: 'POST', body: { rom: g.rom, favorite: !g.favorite } }).catch(() => null);
    void home.reload();
    if (found) setFound(found.map((x) => (x.rom === g.rom ? { ...x, favorite: !g.favorite } : x)));
  };
  const search = async () => {
    const r = await api<{ results: Game[] }>(`/api/games/search?q=${encodeURIComponent(find)}`);
    setFound(r.results);
  };
  const restoreSaves = async () => {
    if (!snap || !confirm(t('games.restoreConfirm'))) return;
    try {
      await api('/api/games/saves/restore', { method: 'POST', body: { snapshot: snap } });
      flash(t('games.restoreStarted'));
    } catch (e) {
      flash((e as Error).message.includes('already_playing') ? t('games.busy') : t('games.launchFailed'));
    }
  };
  const submitPin = async () => {
    try {
      await api('/api/games/pair', { method: 'POST', body: { pin } });
      setPairMsg({ ok: true, text: t('games.paired') });
      setPin('');
      void reload();
    } catch (e) {
      const code = (e as Error).message;
      setPairMsg({ ok: false, text: code.includes('no_request') ? t('games.noRequest', { host: data?.hostname ?? '' }) : t('games.pairFailed') });
    }
  };
  const total = data?.library.reduce((a, s) => a + s.count, 0) ?? 0;
  return (
    <>
      <PageHeader title={t('games.title')} back="/" />
      <main className="safe-bottom mx-auto max-w-3xl space-y-3 px-3">
        <Card>
          <div className="flex items-center gap-3">
            <span className={`size-3 shrink-0 rounded-full ${data?.playing ? 'animate-pulse bg-primary' : data?.running ? 'bg-ok' : 'bg-danger'}`} aria-hidden />
            <p className="flex-1 font-semibold text-heading">
              {data?.playing ? t('games.playingNow', { app: data.playing }) : data?.running ? t('games.ready') : t('games.down')}
            </p>
            <span className="text-sm text-muted">{t('games.pairedCount', { n: data?.paired ?? 0 })}</span>
          </div>
          {data?.playing && <p className="mt-1 text-xs text-muted">{t('games.pausedWork')}</p>}
          {data?.playing && (
            <Button variant="danger" className="mt-3 w-full" onClick={() => void api('/api/games/stop', { method: 'POST', body: {} }).finally(() => void reload())}>
              {t('games.stop')}
            </Button>
          )}
          <p className="mt-2 text-xs text-muted">{t('games.exitHint')}</p>
          {!data?.playing && (
            <Button
              variant="secondary"
              className="mt-3 w-full"
              onClick={() => void api('/api/games/rescan', { method: 'POST', body: {} }).finally(() => void reload())}
            >
              {t('games.rescan')}
            </Button>
          )}
          <p className="mt-1 text-xs text-muted">{t('games.rescanHint')}</p>
        </Card>

        {msg && <p className="rounded-xl bg-primary-soft px-3 py-2 text-sm text-primary-ink">{msg}</p>}
        {!!home.data?.recent.length && (
          <Row title={t('games.continue')}>
            {home.data.recent.map((g) => (
              <GameTile key={g.rom} g={g} onPlay={() => void play(g)} onFav={() => void fav(g)} />
            ))}
          </Row>
        )}
        {!!home.data?.favorites.length && (
          <Row title={t('games.favorites')}>
            {home.data.favorites.map((g) => (
              <GameTile key={g.rom} g={g} onPlay={() => void play(g)} onFav={() => void fav(g)} />
            ))}
          </Row>
        )}
        <Card title={t('games.find')}>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (find.trim().length >= 2) void search();
            }}
          >
            <input value={find} onChange={(e) => setFind(e.target.value)} placeholder={t('games.findPlaceholder')} dir="auto" className="min-h-12 min-w-0 flex-1 rounded-xl border border-line bg-canvas px-3" aria-label={t('games.find')} />
            <Button type="submit" disabled={find.trim().length < 2}>
              {t('games.search')}
            </Button>
          </form>
          {found && (
            <ul className="mt-2 divide-y divide-line">
              {found.map((g) => (
                <GameLine key={g.rom} g={g} showSystem onPlay={() => void play(g)} onFav={() => void fav(g)} />
              ))}
              {!found.length && <li className="py-2 text-sm text-muted">{t('games.noneFound')}</li>}
            </ul>
          )}
          <p className="mt-2 text-xs text-muted">{t('games.findHint')}</p>
        </Card>

        <Card title={t('games.pairTitle')}>
          <ol className="list-decimal space-y-1 ps-5 text-sm text-ink">
            <li>{t('games.step1')}</li>
            <li>{t('games.step2', { ip: data?.lanIp ?? '', host: data?.hostname ?? '' })}</li>
            <li>{t('games.step3')}</li>
          </ol>
          <div className="mt-3 flex gap-2">
            <input
              inputMode="numeric"
              maxLength={4}
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
              placeholder="0000"
              dir="ltr"
              className="min-h-12 w-28 rounded-xl border border-line bg-canvas px-3 text-center font-mono text-xl tracking-widest"
              aria-label={t('games.pin')}
            />
            <Button disabled={pin.length !== 4} onClick={() => void submitPin()}>
              {t('games.connect')}
            </Button>
          </div>
          {data?.pendingPair && !pairMsg && <p className="mt-2 text-sm text-primary">{t('games.waiting')}</p>}
          {pairMsg && <p className={`mt-2 text-sm ${pairMsg.ok ? 'text-ok' : 'text-danger'}`}>{pairMsg.text}</p>}
        </Card>

        <Card
          title={t('games.library', { n: total })}
          action={
            <Link href={`/files?path=${encodeURIComponent(`${data?.root ?? ''}/ROMs`)}`} className="text-sm text-primary">
              {t('games.addGames')}
            </Link>
          }
        >
          <ul className="divide-y divide-line">
            {(data?.library ?? []).map((s) => (
              <li key={s.id}>
                <button type="button" className="flex min-h-11 w-full items-center gap-3 py-2 text-start" disabled={!s.count} onClick={() => setOpen(open === s.id ? null : s.id)}>
                  <span className="flex-1 text-sm">{s.name}</span>
                  <span className={`text-sm ${s.count ? 'font-semibold text-heading' : 'text-muted'}`}>{s.count}</span>
                  {s.count > 0 && <span className="w-16 text-end text-xs text-muted">{formatBytes(s.bytes)}</span>}
                </button>
                {open === s.id && (
                  <ul className="mb-2 max-h-64 overflow-auto rounded-lg bg-canvas p-2 text-sm" dir="ltr">
                    {s.games.map((g) => (
                      <GameLine key={g.rom} g={{ ...g, favorite: home.data?.favorites.some((f) => f.rom === g.rom) }} onPlay={() => void play(g)} onFav={() => void fav({ ...g, favorite: home.data?.favorites.some((f) => f.rom === g.rom) })} />
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </Card>

        <Card title={t('games.saves')}>
          <p className="text-sm text-ink">{t('games.savesSize', { size: formatBytes(saves.data?.dirs.reduce((a, d) => a + d.bytes, 0) ?? 0) })}</p>
          <p className="mt-1 text-xs text-muted">{t('games.savesHint')}</p>
          <div className="mt-3 flex gap-2">
            <select value={snap} onChange={(e) => setSnap(e.target.value)} className="min-h-11 min-w-0 flex-1 rounded-xl border border-line bg-canvas px-3 text-sm" aria-label={t('games.restoreFrom')}>
              <option value="">{t('games.restoreFrom')}</option>
              {(saves.data?.snapshots ?? []).map((x) => (
                <option key={x.id} value={x.id}>
                  {new Date(x.time).toLocaleString()}
                </option>
              ))}
            </select>
            <Button variant="secondary" disabled={!snap || !!data?.playing} onClick={() => void restoreSaves()}>
              {t('games.restore')}
            </Button>
          </div>
        </Card>

        <Card title={t('games.bios')}>
          <ul className="space-y-1.5 text-sm">
            {(data?.bios ?? []).map((b) => (
              <li key={b.system} className="flex items-center gap-2">
                <span aria-hidden>{b.present ? '✅' : '⬜'}</span>
                <span className="flex-1" dir="ltr">
                  {b.label}
                </span>
                {b.system === 'ps3' && !b.present && (
                  <Button variant="secondary" className="min-h-9 px-3 text-xs" disabled={data?.firmwareDownloading} onClick={() => void api('/api/games/ps3-firmware', { method: 'POST', body: {} }).then(reload)}>
                    {data?.firmwareDownloading ? t('games.downloading') : t('games.getFirmware')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted">{t('games.biosHint')}</p>
        </Card>

        <Card title={t('games.ps3Check')}>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              setCompat(null);
              void api<{ results: Compat[] }>(`/api/games/ps3-compat?q=${encodeURIComponent(q)}`).then((r) => setCompat(r.results));
            }}
          >
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="God of War III" dir="ltr" className="min-h-12 flex-1 rounded-xl border border-line bg-canvas px-3" aria-label={t('games.ps3Check')} />
            <Button type="submit" disabled={!q.trim()}>
              {t('games.check')}
            </Button>
          </form>
          {compat && (
            <ul className="mt-2 divide-y divide-line text-sm">
              {compat.map((c) => (
                <li key={c.id} className="flex items-center gap-2 py-1.5">
                  <span className={`size-2.5 shrink-0 rounded-full ${COMPAT_COLOR[c.status] ?? 'bg-muted'}`} aria-hidden />
                  <span className="flex-1 truncate" dir="ltr">
                    {c.title} <span className="text-xs text-muted">{c.id}</span>
                  </span>
                  <span className="text-xs">{t(`games.compat.${c.status}` as 'games.compat.Playable')}</span>
                </li>
              ))}
              {!compat.length && <li className="py-2 text-muted">{t('games.noCompat')}</li>}
            </ul>
          )}
          <p className="mt-2 text-xs text-muted">{t('games.compatHint')}</p>
        </Card>
      </main>
    </>
  );
}

const coverUrl = (rom: string) => `/api/games/cover?rom=${encodeURIComponent(rom)}`;

function Row({ title, children }: { title: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <section>
      <h2 className="mb-2 px-1 text-lg font-bold text-heading">{title}</h2>
      <div ref={ref} className="-mx-3 flex snap-x snap-mandatory scroll-px-3 gap-3 overflow-x-auto px-3 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {children}
      </div>
    </section>
  );
}

function Cover({ g, className }: { g: Game; className: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className={`flex items-center justify-center overflow-hidden rounded-xl bg-primary-soft text-primary-ink ${className}`}>
      {!failed ? <img src={coverUrl(g.rom)} alt="" loading="lazy" onError={() => setFailed(true)} className="size-full object-cover" /> : <span className="text-2xl">🎮</span>}
    </span>
  );
}

function GameTile({ g, onPlay, onFav }: { g: Game; onPlay: () => void; onFav: () => void }) {
  const { t } = useI18n();
  return (
    <div className="w-32 shrink-0 snap-start">
      <button type="button" onClick={onPlay} className="relative block w-full text-start" aria-label={t('games.play')}>
        <Cover g={g} className="aspect-[3/4] w-full shadow-card" />
        <span className="absolute inset-0 flex items-center justify-center">
          <span className="flex size-11 items-center justify-center rounded-full bg-black/50 text-lg text-white">▶</span>
        </span>
      </button>
      <div className="mt-1.5 flex items-start gap-1">
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 text-[13px] font-medium leading-tight text-heading" dir="auto">
            {g.name}
          </span>
          <span className="block text-[11px] text-muted">{g.systemName}</span>
        </span>
        <button type="button" onClick={onFav} className="shrink-0 px-1 text-base" aria-label={t('games.favorite')}>
          {g.favorite ? '❤️' : '🤍'}
        </button>
      </div>
    </div>
  );
}

function GameLine({ g, showSystem, onPlay, onFav }: { g: Game; showSystem?: boolean; onPlay: () => void; onFav: () => void }) {
  const { t } = useI18n();
  return (
    <li className="flex items-center gap-2 py-1.5">
      <Cover g={g} className="size-11 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-heading" dir="auto">
          {g.name}
        </span>
        {showSystem && <span className="block text-xs text-muted">{g.systemName}</span>}
      </span>
      <button type="button" onClick={onFav} className="min-h-9 px-1.5 text-base" aria-label={t('games.favorite')}>
        {g.favorite ? '❤️' : '🤍'}
      </button>
      <Button className="min-h-9 px-3 text-sm" onClick={onPlay}>
        ▶ {t('games.play')}
      </Button>
    </li>
  );
}
