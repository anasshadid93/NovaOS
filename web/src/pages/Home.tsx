import { useRef, useState } from 'react';
import { Link } from 'wouter';
import {
  AppsList24Filled,
  ArrowUpload24Filled,
  BuildingShop24Filled,
  ClipboardTaskListLtr24Filled,
  Cube24Filled,
  Folder24Filled,
  Image24Filled,
  MusicNote224Filled,
  Mic24Filled,
  Headphones48Color,
  NoteEdit24Filled,
  Pulse24Filled,
  Settings24Filled,
  Video24Filled,
  Apps48Color,
  AppsListDetail32Color,
  BuildingStore24Color,
  ClipboardTask24Color,
  Cloud48Color,
  DataTrending48Color,
  CoinMultiple48Color,
  SearchSparkle48Color,
  DocumentFolder24Color,
  Image48Color,
  Notebook32Color,
  Settings48Color,
  Video48Color,
  ArrowDownload24Filled,
  Mic48Color,
  ArrowSquareDown32Color,
  History48Color,
  History24Filled,
  Trophy48Color,
  Games24Filled,
  MoviesAndTv24Filled,
  ArrowTrending24Filled,
  News24Filled,
  DataTrending24Filled,
  Heart48Color,
  HeartPulse24Filled,
  PhoneLaptop32Color,
  Wifi124Filled,
} from '@fluentui/react-icons';
import { api } from '../lib/api';
import { useSystem } from '../lib/live';
import { usePoll } from '../lib/usePoll';
import { uploadFiles } from '../lib/upload';
import { formatBytes, formatPct } from '../lib/format';
import { InstallCard } from '../components/InstallCard';
import { useI18n } from '../i18n';
import { useAuth } from '../lib/auth';
import { DeviceHeader, HomeTopBar } from '../components/HomeTop';
import { Dialog } from '../components/Dialog';
import { Bar } from '../components/meters';
import { LauncherTile, type LauncherItem } from '../components/LauncherIcon';
import { Button, Card, ErrorText, Tile, TileGrid, TextField } from '../components/ui';

interface HomeData {
  host: { hostname: string; deviceId: string | null; addresses: { iface: string; address: string }[]; os: string };
  storage: { device: string; mount: string; size: number; used: number; avail: number }[];
  alerts: { key: string; severity: 'warning' | 'critical'; title: string; detail: string }[];
  frequent: LauncherItem[];
  quick: LauncherItem[];
  tasks: Partial<Record<'queued' | 'running' | 'failed' | 'succeeded', number>>;
}

type UploadKind = 'file' | 'photo' | 'video';

function QuickActions({ bare = false }: { bare?: boolean }) {
  const { t, tn } = useI18n();
  const inputs = { file: useRef<HTMLInputElement>(null), photo: useRef<HTMLInputElement>(null), video: useRef<HTMLInputElement>(null) };
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState({ title: '', text: '' });

  const onPick = async (kind: UploadKind, files: FileList | null) => {
    if (!files?.length) return;
    setError('');
    try {
      const res = await uploadFiles(kind, files, (pct) => setStatus(t('home.uploading', { pct: `${pct}%` })));
      const dirs = [...new Set(res.saved.map((p) => p.slice(0, p.lastIndexOf('/'))))];
      setStatus(tn('home.uploaded', res.saved.length, { dir: dirs.length === 1 ? dirs[0] : 'files/' }));
    } catch {
      setStatus('');
      setError(t('home.uploadFailed'));
    } finally {
      for (const r of Object.values(inputs)) if (r.current) r.current.value = '';
    }
  };

  const saveNote = async () => {
    await api('/api/notes', { body: note });
    setNoteOpen(false);
    setNote({ title: '', text: '' });
    setStatus(t('home.noteSaved'));
  };

  const content = (
    <>
      <TileGrid>
        <Tile icon={ArrowUpload24Filled} art={{ kind: 'fluent', glyph: Cloud48Color }} color="blue" label={t('home.uploadFile')} onClick={() => inputs.file.current?.click()} />
        <Tile icon={Image24Filled} art={{ kind: 'fluent', glyph: Image48Color }} color="sky" label={t('home.uploadPhoto')} onClick={() => inputs.photo.current?.click()} />
        <Tile icon={Video24Filled} art={{ kind: 'fluent', glyph: Video48Color }} color="purple" label={t('home.uploadVideo')} onClick={() => inputs.video.current?.click()} />
        <Tile icon={NoteEdit24Filled} art={{ kind: 'fluent', glyph: Notebook32Color }} color="orange" label={t('home.takeNote')} onClick={() => setNoteOpen(true)} />
      </TileGrid>
      <input ref={inputs.file} type="file" multiple hidden onChange={(e) => void onPick('file', e.target.files)} />
      <input ref={inputs.photo} type="file" accept="image/*" multiple hidden onChange={(e) => void onPick('photo', e.target.files)} />
      <input ref={inputs.video} type="file" accept="video/*" multiple hidden onChange={(e) => void onPick('video', e.target.files)} />
      {status && (
        <p className="mt-3 text-sm text-muted" role="status">
          {status}
        </p>
      )}
      <ErrorText>{error}</ErrorText>
      <Dialog open={noteOpen} onClose={() => setNoteOpen(false)} title={t('home.noteTitle')}>
        <TextField label={t('home.noteTitleField')} value={note.title} onChange={(e) => setNote({ ...note, title: e.target.value })} />
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-ink">{t('home.noteText')}</span>
          <textarea
            value={note.text}
            onChange={(e) => setNote({ ...note, text: e.target.value })}
            rows={6}
            className="block w-full rounded-xl border border-line bg-surface p-3 text-base text-ink outline-none focus:border-primary"
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <Button variant="secondary" onClick={() => setNoteOpen(false)}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void saveNote()} disabled={!note.text.trim()}>
            {t('home.noteSave')}
          </Button>
        </div>
      </Dialog>
    </>
  );
  return bare ? content : <Card title={t('home.quickActions')}>{content}</Card>;
}

export function Home() {
  const { t, tn } = useI18n();
  const { state } = useAuth();
  const { data } = usePoll<HomeData>('/api/home', 30_000);
  const live = useSystem();
  const net = live?.net;
  const root = data?.storage.find((m) => m.mount === '/') ?? data?.storage[0];
  const total = data?.storage.reduce((a, m) => a + m.size, 0) ?? 0;
  const used = data?.storage.reduce((a, m) => a + m.used, 0) ?? 0;
  const pct = total ? (used / total) * 100 : 0;
  const ip = data?.host.addresses.find((a) => !a.address.startsWith('100.'))?.address ?? data?.host.addresses[0]?.address;
  const alerts = data?.alerts ?? [];
  const running = (data?.tasks.running ?? 0) + (data?.tasks.queued ?? 0);

  return (
    <main className="safe-top safe-bottom mx-auto max-w-md space-y-4 px-3">
      <HomeTopBar items={data?.quick ?? []} addMenu={() => <QuickActions bare />} />

      <DeviceHeader
        host={data?.host}
        user={state?.user?.name ?? ''}
        ip={ip}
        net={net}
        alert={{ text: alerts.length ? (alerts.length === 1 ? alerts[0].title : tn('home.alerts', alerts.length)) : t('home.noAlerts'), tone: alerts.length ? 'bad' : 'ok' }}
      />

      <InstallCard />

      {running > 0 && (
        <Link href="/tasks" className="flex items-center gap-2 rounded-xl bg-primary-soft px-3 py-2 text-sm text-primary-ink">
          <ClipboardTaskListLtr24Filled className="size-5" aria-hidden />
          {t('home.tasksRunning')} · {running}
        </Link>
      )}

      {/* Storage */}
      <Link href="/disks" className="card block p-4 active:scale-[0.99]">
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <span className="font-semibold text-heading">{t('home.storageUsage', { pct: formatPct(pct) })}</span>
          <span className="text-xs tabular-nums text-muted">{t('home.storageUsed', { used: formatBytes(used), total: formatBytes(total) })}</span>
        </div>
        <Bar value={pct} />
        {root && data && data.storage.length > 1 && (
          <p className="mt-2 text-xs text-muted">
            {data.storage.map((m) => `${m.mount === '/' ? t('vol.internal') : m.mount.split('/').pop()?.replace(/_/g, ' ')} ${formatBytes(m.avail)}`).join(' · ')}
          </p>
        )}
      </Link>

      <QuickActions />

      <Card title={t('home.sections')}>
        <TileGrid>
          <Tile href="/monitor" icon={Pulse24Filled} art={{ kind: 'fluent', glyph: DataTrending48Color }} color="blue" label={t('section.monitor')} />
          <Tile href="/processes" icon={AppsList24Filled} art={{ kind: 'fluent', glyph: AppsListDetail32Color }} color="teal" label={t('section.processes')} />
          <Tile href="/docker" icon={Cube24Filled} art={{ kind: 'fluent', glyph: Apps48Color }} color="sky" label={t('section.docker')} />
          <Tile href="/store" icon={BuildingShop24Filled} art={{ kind: 'fluent', glyph: BuildingStore24Color }} color="orange" label={t('section.apps')} />
          <Tile href="/files" icon={Folder24Filled} art={{ kind: 'fluent', glyph: DocumentFolder24Color }} color="green" label={t('section.files')} />
          <Tile href="/gallery" icon={Image24Filled} art={{ kind: 'fluent', glyph: Image48Color }} color="sky" label={t('section.gallery')} />
          <Tile href="/music" icon={MusicNote224Filled} art={{ kind: 'fluent', glyph: Headphones48Color }} color="purple" label={t('music.title')} />
          <Tile href="/voice" icon={Mic24Filled} art={{ kind: 'fluent', glyph: Mic48Color }} color="purple" label={t('voice.title')} />
          <Tile href="/downloads" icon={ArrowDownload24Filled} art={{ kind: 'fluent', glyph: ArrowSquareDown32Color }} color="blue" label={t('section.downloads')} />
          <Tile href="/backup" icon={History24Filled} art={{ kind: 'fluent', glyph: History48Color }} color="green" label={t('section.backup')} />
          <Tile href="/games" icon={Games24Filled} art={{ kind: 'fluent', glyph: Trophy48Color }} color="purple" label={t('section.games')} />
          <Tile href="/watch" icon={MoviesAndTv24Filled} art={{ kind: 'fluent', glyph: Video48Color }} color="red" label={t('section.watch')} />
          <Tile href="/prices" icon={ArrowTrending24Filled} art={{ kind: 'fluent', glyph: CoinMultiple48Color }} color="green" label={t('section.prices')} />
          <Tile href="/news" icon={News24Filled} art={{ kind: 'fluent', glyph: SearchSparkle48Color }} color="orange" label={t('section.news')} />
          <Tile href="/quant" icon={DataTrending24Filled} art={{ kind: 'fluent', glyph: DataTrending48Color }} color="purple" label={t('section.quant')} />
          <Tile href="/health" icon={HeartPulse24Filled} art={{ kind: 'fluent', glyph: Heart48Color }} color="red" label={t('section.health')} />
          <Tile href="/network" icon={Wifi124Filled} art={{ kind: 'fluent', glyph: PhoneLaptop32Color }} color="teal" label={t('section.network')} />
          <Tile href="/tasks" icon={ClipboardTaskListLtr24Filled} art={{ kind: 'fluent', glyph: ClipboardTask24Color }} color="purple" label={t('section.tasks')} />
          <Tile href="/settings" icon={Settings24Filled} art={{ kind: 'fluent', glyph: Settings48Color }} color="slate" label={t('section.settings')} />
        </TileGrid>
      </Card>

      {data && data.frequent.length > 0 && (
        <Card
          title={t('home.frequent')}
          action={
            <Link href="/launcher" className="text-sm text-muted">
              {t('home.allApps')} <span className="flip-rtl inline-block">›</span>
            </Link>
          }
        >
          <TileGrid>
            {data.frequent.map((i) => (
              <LauncherTile key={i.key} item={i} />
            ))}
          </TileGrid>
        </Card>
      )}

      {data && data.quick.length > 0 && (
        <Card
          title={t('home.quickAccess')}
          action={
            <Link href="/launcher" className="text-sm text-muted">
              {t('home.allApps')} <span className="flip-rtl inline-block">›</span>
            </Link>
          }
        >
          <TileGrid>
            {data.quick.map((i) => (
              <LauncherTile key={i.key} item={i} />
            ))}
          </TileGrid>
        </Card>
      )}
    </main>
  );
}
