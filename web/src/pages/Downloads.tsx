import { useMemo, useState } from 'react';
import { api } from '../lib/api';
import { formatBytes, formatDuration, formatRate, ltr } from '../lib/format';
import { usePoll } from '../lib/usePoll';
import { useI18n, type MessageKey } from '../i18n';
import { Button, Card, PageHeader } from '../components/ui';

/**
 * Downloads: the Internet Archive items NovaOS fetches itself (file by file, with pause,
 * "download next", skip and retry) and qBittorrent's torrents — with whether each reached Jellyfin.
 */
type FileState = 'done' | 'downloading' | 'queued' | 'failed' | 'skipped' | 'paused';
interface ArchiveFile {
  name: string;
  size: number;
  bytes: number;
  state: FileState;
  rate: number;
  failed: number;
  library: boolean;
}
interface ArchiveJob {
  id: string;
  title: string;
  shelf: string;
  status: 'downloading' | 'paused' | 'done';
  total: number;
  have: number;
  speed: number;
  etaSec: number | null;
  counts: Partial<Record<FileState, number>>;
  files: ArchiveFile[];
}
interface Torrent {
  hash: string;
  name: string;
  size: number;
  progress: number;
  state: string;
  speed: number;
  up: number;
  etaSec: number | null;
  shelf: string | null;
  seeds: number | null;
  inLibrary: number;
}

const DOT: Record<FileState, string> = {
  done: 'bg-ok',
  downloading: 'bg-primary animate-pulse',
  queued: 'bg-muted',
  failed: 'bg-danger',
  skipped: 'bg-line',
  paused: 'bg-amber-400',
};
const SHOW = 150; // rows shown before "n more…"

function Bar({ value, live }: { value: number; live?: boolean }) {
  return (
    <div className="h-2 overflow-hidden rounded-full bg-canvas" role="progressbar" aria-valuenow={Math.round(value * 100)} aria-valuemin={0} aria-valuemax={100}>
      <div className={`h-full rounded-full transition-[width] duration-700 ${live ? 'bg-primary' : 'bg-ok'}`} style={{ width: `${Math.min(100, Math.max(0, value * 100))}%` }} />
    </div>
  );
}

export function Downloads() {
  const { t } = useI18n();
  const [tab, setTab] = useState<'links' | 'video' | 'archive' | 'torrents'>('links');
  const { data, reload } = usePoll<{
    archive: ArchiveJob[];
    torrents: Torrent[];
  }>('/api/media/downloads', 2000);
  const links = usePoll<{ downloads: LinkJob[] }>('/api/downloads', 2000);
  const act = async (path: string, body?: unknown) => {
    await api(path, { method: 'POST', body: body ?? {} }).catch(() => {});
    void reload();
  };
  const tabs: {
    id: 'links' | 'video' | 'archive' | 'torrents';
    label: MessageKey;
    n: number;
  }[] = [
    { id: 'links', label: 'dl.links', n: links.data?.downloads.length ?? 0 },
    { id: 'video', label: 'dl.video', n: 0 },
    { id: 'archive', label: 'dl.archive', n: data?.archive.length ?? 0 },
    { id: 'torrents', label: 'dl.torrents', n: data?.torrents.length ?? 0 },
  ];
  return (
    <>
      <PageHeader title={t('dl.title')} back="/">
        <div className="-mx-3 flex gap-1 overflow-x-auto px-3 py-0.5" role="tablist">
          {tabs.map((x) => (
            <button key={x.id} type="button" role="tab" aria-selected={tab === x.id} onClick={() => setTab(x.id)} className={`min-h-9 shrink-0 rounded-full px-3 text-sm ${tab === x.id ? 'bg-primary text-white' : 'bg-surface text-ink shadow-card'}`}>
              {t(x.label)} {x.n > 0 && <span className="opacity-70">{x.n}</span>}
            </button>
          ))}
        </div>
      </PageHeader>
      <main className="safe-bottom mx-auto max-w-3xl space-y-3 px-3">
        {tab !== 'video' && (
          <AddLink
            onAdded={(kind) => {
              setTab(kind === 'torrent' ? 'torrents' : 'links');
              void reload();
              void links.reload();
            }}
          />
        )}
        {tab === 'links' && <LinkList jobs={links.data?.downloads ?? []} reload={() => void links.reload()} />}
        {tab === 'video' && <VideoDownloader />}
        {tab === 'archive' &&
          (data?.archive.length ? (
            data.archive.map((j) => <ArchiveCard key={j.id} job={j} act={act} />)
          ) : (
            <Card>
              <p className="p-4 text-center text-sm text-muted">{t('dl.empty')}</p>
            </Card>
          ))}
        {tab === 'torrents' && <TorrentList torrents={data?.torrents ?? []} act={act} />}
      </main>
    </>
  );
}

interface VideoAnalysisItem {
  id: string;
  position: number;
  title: string;
  duration: number | null;
}
interface VideoDraftItem extends VideoAnalysisItem {
  selected: boolean;
}
interface VideoAnalysis {
  url: string;
  title: string;
  uploader: string | null;
  playlist: boolean;
  count: number;
  truncated: boolean;
  items: VideoAnalysisItem[];
}
interface VideoJobItem extends VideoAnalysisItem {
  status: 'queued' | 'running' | 'done' | 'skipped' | 'failed';
  progress: string | null;
  file: string | null;
  size: number | null;
  error: string | null;
}
interface VideoJob {
  id: number;
  url: string;
  title: string;
  library: 'series' | 'arabic_series' | 'foreign_series' | 'videos';
  season: number;
  quality: string;
  subtitles: boolean;
  rangeStart: number | null;
  rangeEnd: number | null;
  status: 'queued' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled';
  progress: string | null;
  outputDir: string | null;
  error: string | null;
  counts: Record<string, number>;
  items: VideoJobItem[];
}

function VideoDownloader() {
  const { t } = useI18n();
  const jobs = usePoll<{ jobs: VideoJob[] }>('/api/video-downloads', 2000);
  const [url, setUrl] = useState('');
  const [analysis, setAnalysis] = useState<VideoAnalysis | null>(null);
  const [title, setTitle] = useState('');
  const [library, setLibrary] = useState<'arabic_series' | 'foreign_series' | 'videos'>('arabic_series');
  const [season, setSeason] = useState(1);
  const [draftItems, setDraftItems] = useState<VideoDraftItem[]>([]);
  const [quality, setQuality] = useState<'best' | '1080' | '720'>('1080');
  const [subtitles, setSubtitles] = useState(true);
  const [busy, setBusy] = useState<'analyze' | 'start' | null>(null);
  const [error, setError] = useState('');

  const analyze = async () => {
    setBusy('analyze');
    setError('');
    setAnalysis(null);
    try {
      const result = await api<VideoAnalysis>('/api/video-downloads/analyze', {
        method: 'POST',
        body: { url: url.trim() },
      });
      setAnalysis(result);
      setTitle(result.title);
      setDraftItems(result.items.map((item) => ({ ...item, selected: true })));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const begin = async () => {
    if (!analysis) return;
    setBusy('start');
    setError('');
    try {
      await api('/api/video-downloads', {
        method: 'POST',
        body: {
          url: analysis.url,
          title,
          library,
          season,
          quality,
          subtitles,
          items: draftItems
            .filter((item) => item.selected)
            .map((item) => ({
              id: item.id,
              position: item.position,
              title: item.title,
            })),
        },
      });
      setAnalysis(null);
      setUrl('');
      await jobs.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const selectedCount = draftItems.filter((item) => item.selected).length;
  const setAllSelected = (selected: boolean) => setDraftItems((items) => items.map((item) => ({ ...item, selected })));
  const updateDraft = (position: number, patch: Partial<Pick<VideoDraftItem, 'selected' | 'title'>>) => {
    setDraftItems((items) => items.map((item) => (item.position === position ? { ...item, ...patch } : item)));
  };

  const act = async (id: number, action: string) => {
    setError('');
    try {
      await api(`/api/video-downloads/${id}/${action}`, {
        method: 'POST',
        body: {},
      });
      await jobs.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <>
      <YouTubeAccess needsAttention={(jobs.data?.jobs ?? []).some((job) => /sign in to confirm|cookies? for the authentication/i.test(job.error ?? ''))} />
      <Card>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (url.trim()) void analyze();
          }}
        >
          <div className="flex gap-2 max-sm:flex-col">
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={t('dl.videoUrl')} dir="ltr" inputMode="url" autoCapitalize="none" className="min-h-12 min-w-0 flex-1 rounded-xl border border-line bg-canvas px-3 text-sm" />
            <Button type="submit" disabled={!url.trim() || busy !== null} className="min-h-12 shrink-0">
              {busy === 'analyze' ? t('dl.analyzing') : t('dl.analyze')}
            </Button>
          </div>
          <p className="text-xs text-muted">{t('dl.videoHint')}</p>
          {error && (
            <p className="text-sm text-danger" dir="auto">
              {error}
            </p>
          )}
        </form>
      </Card>

      {analysis && (
        <Card>
          <div className="mb-3">
            <h2 className="text-lg font-semibold text-heading" dir="auto">
              {analysis.title}
            </h2>
            <p className="text-xs text-muted">
              {analysis.uploader && <span dir="auto">{analysis.uploader} · </span>}
              {t(analysis.playlist ? 'dl.playlistFound' : 'dl.videoFound', {
                n: analysis.count,
              })}
              {analysis.truncated && ` · ${t('dl.first500')}`}
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-xs text-muted sm:col-span-2">
              <span>{t('dl.seriesName')}</span>
              <input value={title} onChange={(e) => setTitle(e.target.value)} dir="auto" className="min-h-11 w-full rounded-xl border border-line bg-canvas px-3 text-sm text-ink" />
            </label>
            <label className="space-y-1 text-xs text-muted">
              <span>{t('dl.saveAs')}</span>
              <select value={library} onChange={(e) => setLibrary(e.target.value as 'arabic_series' | 'foreign_series' | 'videos')} className="min-h-11 w-full rounded-xl border border-line bg-canvas px-3 text-sm text-ink">
                <option value="arabic_series">{t('dl.asArabicSeries')}</option>
                <option value="foreign_series">{t('dl.asForeignSeries')}</option>
                <option value="videos">{t('dl.asVideos')}</option>
              </select>
            </label>
            <label className="space-y-1 text-xs text-muted">
              <span>{t('dl.quality')}</span>
              <select value={quality} onChange={(e) => setQuality(e.target.value as 'best' | '1080' | '720')} className="min-h-11 w-full rounded-xl border border-line bg-canvas px-3 text-sm text-ink">
                <option value="1080">1080p</option>
                <option value="720">720p</option>
                <option value="best">{t('dl.best')}</option>
              </select>
            </label>
            {library !== 'videos' && (
              <label className="space-y-1 text-xs text-muted">
                <span>{t('dl.season')}</span>
                <input type="number" min={1} max={99} value={season} onChange={(e) => setSeason(Number(e.target.value))} className="min-h-11 w-full rounded-xl border border-line bg-canvas px-3 text-sm text-ink" />
              </label>
            )}
          </div>
          <label className="mt-3 flex items-center gap-2 text-sm text-ink">
            <input type="checkbox" checked={subtitles} onChange={(e) => setSubtitles(e.target.checked)} className="size-4" />
            {t('dl.subtitles')}
          </label>
          <div className="mt-3 overflow-hidden rounded-xl bg-canvas">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2">
              <p className="text-xs font-medium text-ink">
                {t('dl.selectedCount', {
                  selected: selectedCount,
                  total: draftItems.length,
                })}
              </p>
              <div className="flex gap-1">
                <button type="button" onClick={() => setAllSelected(true)} className="min-h-8 rounded-lg px-2 text-xs text-primary">
                  {t('dl.selectAll')}
                </button>
                <button type="button" onClick={() => setAllSelected(false)} className="min-h-8 rounded-lg px-2 text-xs text-muted">
                  {t('dl.selectNone')}
                </button>
              </div>
            </div>
            <ol className="max-h-96 divide-y divide-line overflow-y-auto px-3">
              {draftItems.map((item) => (
                <li key={`${item.position}-${item.id}`} className="flex min-w-0 items-center gap-2 py-2">
                  <input type="checkbox" checked={item.selected} onChange={(e) => updateDraft(item.position, { selected: e.target.checked })} aria-label={t('dl.selectVideo', { n: item.position })} className="size-5 shrink-0" />
                  <span className="w-6 shrink-0 text-center text-sm text-muted">{item.position}</span>
                  <input value={item.title} onChange={(e) => updateDraft(item.position, { title: e.target.value })} aria-label={t('dl.videoName', { n: item.position })} dir="auto" className={`min-h-10 min-w-0 flex-1 rounded-lg border bg-surface px-2 text-sm text-ink ${item.selected ? 'border-line' : 'border-transparent opacity-60'}`} />
                  {item.duration && <span className="hidden shrink-0 text-xs text-muted sm:block">{formatDuration(item.duration)}</span>}
                </li>
              ))}
            </ol>
          </div>
          <div className="mt-4 flex items-center justify-between gap-3 max-sm:flex-col max-sm:items-stretch">
            <p className="text-xs text-muted">{t('dl.toshibaJellyfin')}</p>
            <Button onClick={() => void begin()} disabled={!title.trim() || selectedCount === 0 || busy !== null} className="min-h-11 shrink-0">
              {busy === 'start' ? t('dl.addingQueue') : t('dl.downloadSelected')}
            </Button>
          </div>
        </Card>
      )}

      <VideoJobList jobs={jobs.data?.jobs ?? []} act={act} />
    </>
  );
}

function YouTubeAccess({ needsAttention }: { needsAttention: boolean }) {
  const { t } = useI18n();
  const status = usePoll<{
    configured: boolean;
    source: 'browser' | 'file' | null;
    updatedAt: number | null;
    browserAvailable: boolean;
    browserLoggedIn: boolean;
    browserUrl: string | null;
  }>('/api/video-downloads/cookies', 5_000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      const body = new FormData();
      body.append('file', file);
      const res = await fetch('/api/video-downloads/cookies', {
        method: 'POST',
        credentials: 'same-origin',
        body,
      });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? 'upload_failed');
      await status.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError('');
    try {
      await api('/api/video-downloads/cookies/delete', {
        method: 'POST',
        body: {},
      });
      await status.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const configured = status.data?.configured ?? false;
  const browserAvailable = status.data?.browserAvailable ?? false;
  const browserUrl = status.data?.browserUrl ?? '';
  return (
    <Card className={needsAttention && !configured ? 'border-danger' : ''}>
      <div className="flex items-start justify-between gap-3 max-sm:flex-col">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-heading">{t('dl.youtubeAccess')}</p>
          <p className={`mt-1 text-xs ${needsAttention && !configured ? 'text-danger' : 'text-muted'}`}>{configured ? t('dl.youtubeBrowserReady') : needsAttention ? t('dl.youtubeBrowserNeeded') : t('dl.youtubeBrowserHint')}</p>
          {browserAvailable && !configured && <p className="mt-1 text-xs text-muted">{t('dl.youtubeBrowserSteps')}</p>}
          {error && <p className="mt-1 text-xs text-danger">{t(error === 'youtube_cookies_required' || error === 'invalid_cookie_file' ? 'dl.youtubeCookiesInvalid' : 'dl.youtubeCookiesUploadFailed')}</p>}
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {browserAvailable && browserUrl && (
            <a href={browserUrl} target="_blank" rel="noreferrer" onClick={() => void api('/api/video-downloads/browser-login', { method: 'POST', body: {} }).catch((e) => setError((e as Error).message))} className="inline-flex min-h-10 items-center rounded-xl bg-primary px-3 text-sm text-white">
              {configured ? t('dl.youtubeBrowserOpen') : t('dl.youtubeBrowserLogin')}
            </a>
          )}
          <button type="button" onClick={() => void status.reload()} className="min-h-10 rounded-xl bg-canvas px-3 text-sm text-ink">
            {t('dl.youtubeBrowserCheck')}
          </button>
          {status.data?.source === 'file' && (
            <button type="button" disabled={busy} onClick={() => void remove()} className="min-h-10 rounded-xl bg-canvas px-3 text-sm text-danger">
              {t('dl.youtubeCookiesRemove')}
            </button>
          )}
        </div>
      </div>
      <details className="mt-3">
        <summary className="cursor-pointer text-xs text-muted">{t('dl.youtubeCookiesFallback')}</summary>
        <label className={`mt-2 inline-flex min-h-9 cursor-pointer items-center rounded-lg bg-canvas px-3 text-xs text-ink ${busy ? 'pointer-events-none opacity-60' : ''}`}>
          {busy ? t('common.loading') : t('dl.youtubeCookiesUpload')}
          <input
            type="file"
            accept=".txt,text/plain"
            hidden
            disabled={busy}
            onChange={(e) => {
              void upload(e.target.files?.[0]);
              e.currentTarget.value = '';
            }}
          />
        </label>
      </details>
    </Card>
  );
}

function VideoJobList({ jobs, act }: { jobs: VideoJob[]; act: (id: number, action: string) => Promise<void> }) {
  const { t } = useI18n();
  if (!jobs.length)
    return (
      <Card>
        <p className="p-4 text-center text-sm text-muted">{t('dl.noVideoJobs')}</p>
      </Card>
    );
  return (
    <div className="space-y-3">
      {jobs.map((job) => {
        const done = (job.counts.done ?? 0) + (job.counts.skipped ?? 0);
        const total = job.items.length;
        const pct = total ? done / total : 0;
        return (
          <Card key={job.id}>
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-base font-semibold text-heading" dir="auto">
                  {job.title}
                </h2>
                <p className="text-xs text-muted">
                  {job.library !== 'videos' ? `${job.library === 'foreign_series' ? t('dl.asForeignSeries') : t('dl.asArabicSeries')} · ${t('dl.season')} ${job.season}` : t('dl.asVideos')} · {done}/{total} · {t(`dl.job.${job.status}` as MessageKey)}
                </p>
              </div>
              <div className="flex shrink-0 gap-1">
                {job.status === 'running' && (
                  <button type="button" className="rounded-lg bg-canvas px-2 py-1.5 text-xs text-ink" onClick={() => void act(job.id, 'pause')}>
                    {t('dl.pause')}
                  </button>
                )}
                {job.status === 'paused' && (
                  <button type="button" className="rounded-lg bg-primary px-2 py-1.5 text-xs text-white" onClick={() => void act(job.id, 'resume')}>
                    {t('dl.resume')}
                  </button>
                )}
                {(job.status === 'failed' || job.status === 'cancelled') && (
                  <button type="button" className="rounded-lg bg-primary-soft px-2 py-1.5 text-xs text-primary-ink" onClick={() => void act(job.id, 'retry')}>
                    {t('dl.retry')}
                  </button>
                )}
                {(job.status === 'queued' || job.status === 'running' || job.status === 'paused') && (
                  <button type="button" className="rounded-lg px-2 py-1.5 text-xs text-danger" onClick={() => void act(job.id, 'cancel')}>
                    {t('dl.cancel')}
                  </button>
                )}
              </div>
            </div>
            <div className="mt-3">
              <Bar value={pct} live={job.status === 'running'} />
            </div>
            {job.progress && (
              <p className="mt-1 truncate text-xs text-muted" dir="ltr">
                {job.progress}
              </p>
            )}
            {job.error && (
              <p className="mt-1 text-xs text-danger" dir="auto">
                {job.error}
              </p>
            )}
            {job.outputDir && job.status === 'done' && (
              <p className="mt-1 truncate text-xs text-ok-ink" dir="ltr">
                ✓ {job.outputDir}
              </p>
            )}
            <details className="mt-3">
              <summary className="cursor-pointer text-xs text-primary">{t('dl.showEpisodes')}</summary>
              <ul className="mt-2 max-h-64 divide-y divide-line overflow-y-auto">
                {job.items.map((item) => (
                  <li key={item.id} className="flex gap-2 py-2 text-xs">
                    <span className={`mt-1 size-2 shrink-0 rounded-full ${item.status === 'done' || item.status === 'skipped' ? 'bg-ok' : item.status === 'failed' ? 'bg-danger' : item.status === 'running' ? 'bg-primary animate-pulse' : 'bg-muted'}`} />
                    <span className="min-w-0 flex-1 truncate text-ink" dir="auto">
                      {item.position}. {item.title}
                    </span>
                    {item.progress && (
                      <span className="max-w-32 shrink-0 truncate text-muted" dir="ltr">
                        {item.progress}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          </Card>
        );
      })}
    </div>
  );
}

function ArchiveCard({ job, act }: { job: ArchiveJob; act: (path: string, body?: unknown) => Promise<void> }) {
  const { t } = useI18n();
  const [filter, setFilter] = useState<FileState | 'all'>('all');
  const [q, setQ] = useState('');
  const files = useMemo(() => {
    const order: Record<FileState, number> = {
      downloading: 0,
      failed: 1,
      paused: 2,
      queued: 3,
      done: 4,
      skipped: 5,
    };
    return job.files.filter((f) => (filter === 'all' || f.state === filter) && (!q || f.name.toLowerCase().includes(q.toLowerCase()))).sort((a, b) => order[a.state] - order[b.state]);
  }, [job.files, filter, q]);
  const pct = job.total ? job.have / job.total : 0;
  const base = `/api/media/downloads/archive/${encodeURIComponent(job.id)}`;
  const chips: (FileState | 'all')[] = ['all', 'downloading', 'queued', 'done', 'failed', 'skipped'];
  return (
    <>
      <Card>
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-lg font-semibold text-heading">{job.title}</h2>
            <p className="text-xs text-muted">{t('dl.shelf', { shelf: job.shelf })}</p>
          </div>
          {job.status !== 'done' && (
            <Button variant={job.status === 'paused' ? 'primary' : 'secondary'} className="min-h-10 shrink-0" onClick={() => void act(`${base}/${job.status === 'paused' ? 'resume' : 'pause'}`)}>
              {t(job.status === 'paused' ? 'dl.resume' : 'dl.pause')}
            </Button>
          )}
        </div>
        <div className="mt-3">
          <Bar value={pct} live={job.status === 'downloading'} />
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink">
          <span className="font-medium">{ltr(`${(pct * 100).toFixed(1)}%`)}</span>
          <span className="text-muted">
            {t('dl.of', {
              have: formatBytes(job.have),
              total: formatBytes(job.total),
            })}
          </span>
          {job.status === 'downloading' && job.speed > 0 && <span>↓ {formatRate(job.speed)}</span>}
          {job.status === 'downloading' && job.etaSec !== null && <span className="text-muted">{t('dl.left', { time: formatDuration(job.etaSec) })}</span>}
          {job.status === 'paused' && <span className="text-amber-600">{t('dl.paused')}</span>}
          {job.status === 'done' && <span className="text-ok">{t('dl.doneAll')}</span>}
        </div>
      </Card>
      <Card>
        <div className="-mx-1 mb-2 flex gap-1 overflow-x-auto px-1 pb-1">
          {chips.map((c) => {
            const n = c === 'all' ? job.files.length : (job.counts[c] ?? 0);
            if (c !== 'all' && !n) return null;
            return (
              <button key={c} type="button" onClick={() => setFilter(c)} className={`min-h-8 shrink-0 rounded-full px-3 text-xs ${filter === c ? 'bg-primary text-white' : 'bg-canvas text-ink'}`}>
                {t(`dl.f.${c}` as MessageKey)} <span className="opacity-70">{n}</span>
              </button>
            );
          })}
        </div>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('dl.search')} className="mb-2 block min-h-10 w-full rounded-xl border border-line bg-surface px-3 text-sm text-ink outline-none focus:border-primary" />
        <ul className="divide-y divide-line">
          {files.slice(0, SHOW).map((f) => (
            <FileRow key={f.name} f={f} onAction={(action) => void act(`${base}/file`, { name: f.name, action })} />
          ))}
        </ul>
        {files.length > SHOW && <p className="pt-2 text-center text-xs text-muted">{t('dl.more', { n: files.length - SHOW })}</p>}
      </Card>
    </>
  );
}

function FileRow({ f, onAction }: { f: ArchiveFile; onAction: (a: 'first' | 'skip' | 'retry' | 'unskip') => void }) {
  const { t } = useI18n();
  const parts = f.name.split('/');
  const name = parts.at(-1)!;
  const folder = parts.length > 2 ? parts.at(-2) : '';
  return (
    <li className="flex items-center gap-3 py-2.5">
      <span className={`size-2.5 shrink-0 rounded-full ${DOT[f.state]}`} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-ink" dir="auto">
          {name}
        </p>
        <p className="truncate text-xs text-muted" dir="auto">
          {folder && <span>{folder} · </span>}
          {formatBytes(f.size)}
          {f.state === 'downloading' && f.size > 0 && (
            <span>
              {' '}
              · {ltr(`${((f.bytes / f.size) * 100).toFixed(0)}%`)} · ↓ {formatRate(f.rate)}
            </span>
          )}
          {f.state === 'failed' && <span className="text-danger"> · {t('dl.f.failed')}</span>}
          {f.library && <span className="text-ok"> · ✓ {t('dl.inLibrary')}</span>}
        </p>
        {f.state === 'downloading' && f.size > 0 && (
          <div className="mt-1">
            <Bar value={f.bytes / f.size} live />
          </div>
        )}
      </div>
      <div className="flex shrink-0 gap-1">
        {(f.state === 'queued' || f.state === 'paused') && (
          <>
            <button type="button" className="rounded-lg bg-primary-soft px-2 py-1 text-xs text-primary-ink" onClick={() => onAction('first')}>
              {t('dl.next')}
            </button>
            <button type="button" className="rounded-lg bg-canvas px-2 py-1 text-xs text-ink" onClick={() => onAction('skip')}>
              {t('dl.skip')}
            </button>
          </>
        )}
        {f.state === 'downloading' && (
          <button type="button" className="rounded-lg bg-canvas px-2 py-1 text-xs text-ink" onClick={() => onAction('skip')}>
            {t('dl.skip')}
          </button>
        )}
        {f.state === 'failed' && (
          <button type="button" className="rounded-lg bg-primary-soft px-2 py-1 text-xs text-primary-ink" onClick={() => onAction('retry')}>
            {t('dl.retry')}
          </button>
        )}
        {f.state === 'skipped' && (
          <button type="button" className="rounded-lg bg-canvas px-2 py-1 text-xs text-ink" onClick={() => onAction('unskip')}>
            {t('dl.unskip')}
          </button>
        )}
      </div>
    </li>
  );
}

function TorrentList({ torrents, act }: { torrents: Torrent[]; act: (path: string) => Promise<void> }) {
  const { t } = useI18n();
  if (!torrents.length)
    return (
      <Card>
        <p className="p-4 text-center text-sm text-muted">{t('dl.empty')}</p>
      </Card>
    );
  const sorted = [...torrents].sort((a, b) => Number(a.progress >= 1) - Number(b.progress >= 1) || b.speed - a.speed);
  return (
    <ul className="overflow-hidden rounded-list bg-surface shadow-card">
      {sorted.map((x) => {
        const paused = /^(stopped|paused)/i.test(x.state);
        const done = x.progress >= 1;
        return (
          <li key={x.hash} className="border-line px-4 py-3 [&+&]:border-t">
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-ink" dir="auto">
                  {x.name}
                </p>
                <p className="truncate text-xs text-muted">
                  {formatBytes(x.size)} · {ltr(`${(x.progress * 100).toFixed(1)}%`)}
                  {!done && x.speed > 0 && <span> · ↓ {formatRate(x.speed)}</span>}
                  {!done && x.etaSec !== null && <span> · {t('dl.left', { time: formatDuration(x.etaSec) })}</span>}
                  {x.up > 0 && <span> · ↑ {formatRate(x.up)}</span>}
                  {!done && x.seeds !== null && <span> · {t('dl.seeds', { n: x.seeds })}</span>}
                  {x.shelf && <span> · {x.shelf}</span>}
                  {x.inLibrary > 0 && <span className="text-ok"> · ✓ {t('dl.libCount', { n: x.inLibrary })}</span>}
                </p>
              </div>
              <button type="button" className={`shrink-0 rounded-lg px-3 py-1.5 text-xs ${paused ? 'bg-primary text-white' : 'bg-canvas text-ink'}`} onClick={() => void act(`/api/media/downloads/torrent/${x.hash}/${paused ? 'resume' : 'pause'}`)}>
                {t(paused ? 'dl.resume' : 'dl.pause')}
              </button>
            </div>
            {!done && (
              <div className="mt-2">
                <Bar value={x.progress} live={!paused} />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

interface LinkJob {
  id: number;
  url: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  progress: string | null;
  title: string | null;
  file: string | null;
  sizeMB: number | null;
  shareUrl: string | null;
  filesUrl: string | null;
  error: string | null;
}

const MAGNET_RE = /^magnet:\?/i;

/** Paste a link: magnet/.torrent → qBittorrent, video page → yt-dlp, any other file → straight into Downloads. */
function AddLink({ onAdded }: { onAdded: (kind: 'torrent' | 'link') => void }) {
  const { t } = useI18n();
  const [url, setUrl] = useState('');
  const [audio, setAudio] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const value = url.trim();
  const torrent = MAGNET_RE.test(value) || /\.torrent(\?|$)/i.test(value);
  const submit = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ ok: boolean; message: string }>('/api/app/share', {
        method: 'POST',
        body: { value, audio: !torrent && audio },
      });
      setMsg({
        ok: r.ok,
        text: r.ok ? t(torrent ? 'dl.addedTorrent' : 'dl.addedLink') : r.message,
      });
      if (r.ok) {
        setUrl('');
        onAdded(torrent ? 'torrent' : 'link');
      }
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (value) void submit();
        }}
      >
        <div className="flex gap-2">
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={t('dl.linkPlaceholder')} dir="ltr" inputMode="url" autoCapitalize="none" className="min-h-12 min-w-0 flex-1 rounded-xl border border-line bg-canvas px-3 text-sm" aria-label={t('dl.linkPlaceholder')} />
          <Button type="submit" disabled={!value || busy}>
            {busy ? '…' : t('dl.download')}
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
          {!torrent && (
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={audio} onChange={(e) => setAudio(e.target.checked)} className="size-4" />
              {t('dl.audioOnly')}
            </label>
          )}
          <span>{t(torrent ? 'dl.willTorrent' : 'dl.linkHint')}</span>
        </div>
        {msg && <p className={`text-sm ${msg.ok ? 'text-ok-ink' : 'text-danger'}`}>{msg.text}</p>}
      </form>
    </Card>
  );
}

function LinkList({ jobs, reload }: { jobs: LinkJob[]; reload: () => void }) {
  const { t } = useI18n();
  if (!jobs.length)
    return (
      <Card>
        <p className="p-4 text-center text-sm text-muted">{t('dl.noLinks')}</p>
      </Card>
    );
  const pct = (p: string | null) => {
    const m = p && /([\d.]+)%/.exec(p);
    return m ? Number(m[1]) / 100 : null;
  };
  return (
    <Card>
      <ul className="divide-y divide-line">
        {jobs.map((j) => (
          <li key={j.id} className="py-3">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-heading" dir="auto">
                  {j.title ?? j.file ?? j.url}
                </p>
                <p className="truncate text-xs text-muted" dir="ltr">
                  {j.url}
                </p>
              </div>
              {(j.status === 'running' || j.status === 'queued') && (
                <button
                  type="button"
                  className="min-h-9 shrink-0 rounded-lg px-2 text-sm text-danger"
                  onClick={() =>
                    void api(`/api/downloads/${j.id}/cancel`, {
                      method: 'POST',
                      body: {},
                    }).finally(reload)
                  }
                >
                  {t('dl.cancel')}
                </button>
              )}
            </div>
            {j.status === 'running' && (
              <div className="mt-2 space-y-1">
                <Bar value={pct(j.progress) ?? 0} live />
                <p className="text-xs text-muted" dir="ltr">
                  {j.progress}
                </p>
              </div>
            )}
            <p className="mt-1 text-xs">
              {j.status === 'queued' && <span className="text-muted">{t('dl.waiting')}</span>}
              {j.status === 'done' && (
                <span className="flex flex-wrap gap-x-3 text-ok-ink">
                  ✓ {j.sizeMB ? `${j.sizeMB} MB` : ''}
                  {j.filesUrl && (
                    <a href={j.filesUrl} className="text-primary">
                      {t('dl.openFolder')}
                    </a>
                  )}
                  {j.shareUrl && (
                    <a href={j.shareUrl} target="_blank" rel="noreferrer" className="text-primary">
                      {t('dl.shareLink')}
                    </a>
                  )}
                </span>
              )}
              {j.status === 'failed' && <span className="text-danger">✗ {j.error}</span>}
            </p>
          </li>
        ))}
      </ul>
    </Card>
  );
}
