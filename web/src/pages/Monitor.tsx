import { useEffect, useMemo, useState } from 'react';
import { Link } from 'wouter';
import type { AlignedData } from 'uplot';
import { AppsList24Filled, ArrowSortDown24Regular, Broom24Regular } from '@fluentui/react-icons';
import { api } from '../lib/api';
import { live, useLiveStatus, useSystem, type SystemSample } from '../lib/live';
import { formatBytes, formatDuration, formatPct, formatTemp } from '../lib/format';
import { useI18n, type MessageKey } from '../i18n';
import { Button, Card, IconBadge, PageHeader } from '../components/ui';
import { Bar, Ring, Stat, StackBar } from '../components/meters';
import { Chart, type ChartSeries } from '../components/Chart';

interface HistoryPoint {
  ts: number;
  cpu: number;
  mem: number;
  cache: number;
  swap: number;
  gpu: number | null;
  gpuMem: number | null;
  tempCpu: number | null;
  tempGpu: number | null;
  load1: number;
}

type Range = '1h' | '24h' | '7d';
type Metric = 'cpu' | 'mem' | 'gpu' | 'temp';
const HOUR_POINTS = 1800;

function toPoint(s: SystemSample): HistoryPoint {
  return {
    ts: s.ts,
    cpu: s.cpu.total,
    mem: s.mem.used,
    cache: s.mem.cache,
    swap: s.mem.swapUsed,
    gpu: s.gpu.busy,
    gpuMem: s.gpu.gttUsed === null ? null : (s.gpu.gttUsed ?? 0) + (s.gpu.vramUsed ?? 0),
    tempCpu: s.temps.cpu,
    tempGpu: s.temps.gpu,
    load1: s.load[0],
  };
}

function useHistory(range: Range) {
  const [points, setPoints] = useState<HistoryPoint[]>([]);
  useEffect(() => {
    let alive = true;
    setPoints([]);
    api<{ points: HistoryPoint[] }>(`/api/metrics/history?range=${range}`).then((r) => alive && setPoints(r.points));
    if (range !== '1h') return () => void (alive = false);
    // Live tail for the 1-hour view.
    const off = live.onSample((s) =>
      setPoints((prev) => {
        if (prev.length && prev[prev.length - 1].ts >= s.ts) return prev;
        const next = prev.length >= HOUR_POINTS ? prev.slice(prev.length - HOUR_POINTS + 1) : prev.slice();
        next.push(toPoint(s));
        return next;
      }),
    );
    return () => {
      alive = false;
      off();
    };
  }, [range]);
  return points;
}

function HistoryCard({ memTotal }: { memTotal: number }) {
  const { t } = useI18n();
  const [range, setRange] = useState<Range>('1h');
  const [metric, setMetric] = useState<Metric>('cpu');
  const points = useHistory(range);

  const { data, series, yMax, fmt } = useMemo(() => {
    const xs = points.map((p) => p.ts / 1000);
    const pct = (v: number) => `${v.toFixed(0)}%`;
    const gb = (v: number) => formatBytes(v, 0);
    const deg = (v: number) => `${v.toFixed(0)}°`;
    const n = (v: number | null) => v;
    switch (metric) {
      case 'mem':
        return {
          data: [xs, points.map((p) => p.mem), points.map((p) => p.cache), points.map((p) => p.swap)] as AlignedData,
          series: [
            { label: t('monitor.used'), color: '#2f6fe4', fill: true, fmt: gb },
            { label: t('monitor.cache'), color: '#0d9488', fmt: gb },
            { label: t('monitor.swap'), color: '#ea7a12', fmt: gb },
          ] as ChartSeries[],
          yMax: memTotal || undefined,
          fmt: gb,
        };
      case 'gpu':
        return {
          data: [xs, points.map((p) => n(p.gpu))] as AlignedData,
          series: [{ label: t('monitor.gpuBusy'), color: '#7c3aed', fill: true, fmt: pct }] as ChartSeries[],
          yMax: 100,
          fmt: pct,
        };
      case 'temp':
        return {
          data: [xs, points.map((p) => n(p.tempCpu)), points.map((p) => n(p.tempGpu))] as AlignedData,
          series: [
            { label: t('monitor.tempCpu'), color: '#e5484d', fmt: deg },
            { label: t('monitor.tempGpu'), color: '#7c3aed', fmt: deg },
          ] as ChartSeries[],
          yMax: undefined,
          fmt: deg,
        };
      default:
        return {
          data: [xs, points.map((p) => p.cpu)] as AlignedData,
          series: [{ label: t('monitor.cpu'), color: '#2f6fe4', fill: true, fmt: pct }] as ChartSeries[],
          yMax: 100,
          fmt: pct,
        };
    }
  }, [points, metric, memTotal, t]);

  const chip = (active: boolean) =>
    `min-h-9 rounded-full px-3 text-sm ${active ? 'bg-primary text-white' : 'bg-primary-soft text-primary-ink'}`;

  return (
    <Card title={t('monitor.history')}>
      <div className="mb-3 flex flex-wrap gap-2" role="tablist" aria-label={t('monitor.history')}>
        {(['cpu', 'mem', 'gpu', 'temp'] as Metric[]).map((m) => (
          <button key={m} type="button" role="tab" aria-selected={metric === m} className={chip(metric === m)} onClick={() => setMetric(m)}>
            {t(`monitor.series.${m}` as MessageKey)}
          </button>
        ))}
      </div>
      {points.length < 2 ? <p className="py-12 text-center text-sm text-muted">{t('monitor.noData')}</p> : <Chart data={data} series={series} yMax={yMax} fmt={fmt} />}
      <div className="mt-3 grid grid-cols-3 gap-1 rounded-xl bg-primary-soft p-1">
        {(['1h', '24h', '7d'] as Range[]).map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => setRange(r)}
            aria-pressed={range === r}
            className={`min-h-9 rounded-lg text-sm ${range === r ? 'bg-surface font-medium text-heading shadow-card' : 'text-muted'}`}
          >
            {t(`monitor.range.${r}` as MessageKey)}
          </button>
        ))}
      </div>
    </Card>
  );
}

export function Monitor() {
  const { t, formatNumber } = useI18n();
  const s = useSystem();
  const status = useLiveStatus();
  const [info, setInfo] = useState<{ cpuModel: string; cores: number; hostname: string } | null>(null);
  useEffect(() => {
    api<{ cpuModel: string; cores: number; hostname: string }>('/api/system/info').then(setInfo);
  }, []);

  const m = s?.mem;
  const [releasing, setReleasing] = useState(false);
  const [released, setReleased] = useState('');
  const releaseMemory = async () => {
    setReleasing(true);
    setReleased('');
    try {
      const r = await api<{ freed: number }>('/api/system/release-memory', { body: {} });
      setReleased(t('monitor.released', { size: formatBytes(r.freed) }));
    } catch {
      setReleased(t('common.error'));
    } finally {
      setReleasing(false);
    }
  };
  const gpuShared = s?.gpu.gttTotal ? ((s.gpu.gttUsed ?? 0) / s.gpu.gttTotal) * 100 : null;

  return (
    <>
      <PageHeader
        title={t('monitor.title')}
        back="/"
        actions={
          status !== 'open' && (
            <span className="text-xs text-muted" role="status">
              {status === 'closed' ? t('monitor.reconnecting') : t('monitor.connecting')}
            </span>
          )
        }
      />
      <main className="safe-bottom mx-auto max-w-md space-y-4 px-3">
        <Card>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs text-muted">{info?.hostname}</p>
              <p dir="ltr" className="truncate text-start text-sm font-medium text-heading">{info?.cpuModel ?? '…'}</p>
            </div>
            <span className="shrink-0 text-2xl font-bold tabular-nums text-heading">{formatPct(s?.cpu.total)}</span>
          </div>
          <div className="mt-3">
            <Bar value={s?.cpu.total ?? 0} />
          </div>
          <div className="mt-3 grid grid-cols-3 gap-3">
            <Stat
              label={t('monitor.load')}
              value={s ? formatNumber(s.load[0], { maximumFractionDigits: 2 }) : '—'}
              hint={s ? `${formatNumber(s.load[1], { maximumFractionDigits: 2 })} · ${formatNumber(s.load[2], { maximumFractionDigits: 2 })}` : undefined}
            />
            <Stat label={t('monitor.uptime')} value={s ? formatDuration(s.uptime) : '—'} />
            <Stat label={t('monitor.temps')} value={formatTemp(s?.temps.cpu)} />
          </div>
        </Card>

        <Link href="/processes" className="card flex items-center gap-3 p-3 active:scale-[0.99]">
          <IconBadge icon={AppsList24Filled} color="teal" size="sm" />
          <span className="flex-1 font-medium text-ink">{t('monitor.processes')}</span>
          <span className="text-muted" aria-hidden>
            ›
          </span>
        </Link>

        <Card title={`${t('monitor.cores')} · ${s?.cpu.cores.length ?? info?.cores ?? ''}`}>
          <div className="grid grid-cols-5 gap-y-4 @3xl:grid-cols-8">
            {(s?.cpu.cores ?? Array.from({ length: info?.cores ?? 0 }, () => 0)).map((v, i) => (
              <Ring key={i} value={v} label={`CPU ${i}`} size={58} />
            ))}
          </div>
        </Card>

        <Card title={t('monitor.memory')} action={<span className="text-sm tabular-nums text-muted">{m ? formatPct((m.used / m.total) * 100, 0) : ''}</span>}>
          {m && (
            <>
              <StackBar
                parts={[
                  { value: m.used, color: 'var(--color-primary)', label: t('monitor.used') },
                  { value: m.cache + m.buffers, color: '#9fdccf', label: t('monitor.cache') },
                  { value: m.free, color: 'var(--color-line)', label: t('monitor.free') },
                ]}
              />
              <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                <li className="flex items-center gap-1.5">
                  <span className="size-2.5 rounded-full bg-primary" aria-hidden />
                  {t('monitor.usedByApps')}
                </li>
                <li className="flex items-center gap-1.5">
                  <span className="size-2.5 rounded-full" style={{ background: '#9fdccf' }} aria-hidden />
                  {t('monitor.cacheReusable')}
                </li>
                <li className="flex items-center gap-1.5">
                  <span className="size-2.5 rounded-full bg-line" aria-hidden />
                  {t('monitor.free')}
                </li>
              </ul>
              <div className="mt-3 grid grid-cols-3 gap-3">
                <Stat label={t('monitor.used')} value={formatBytes(m.used)} />
                <Stat label={t('monitor.free')} value={formatBytes(m.free)} />
                <Stat label={t('monitor.available')} value={formatBytes(m.available)} />
                <Stat label={t('monitor.cache')} value={formatBytes(m.cache)} />
                <Stat label={t('monitor.buffers')} value={formatBytes(m.buffers)} />
                <Stat label={t('monitor.swap')} value={`${formatBytes(m.swapUsed)}`} hint={`/ ${formatBytes(m.swapTotal)}`} />
              </div>
              <div className="mt-4 grid grid-cols-2 gap-2">
                <Button variant="secondary" className="min-h-11 text-sm" disabled={releasing} onClick={() => void releaseMemory()}>
                  <Broom24Regular aria-hidden />
                  {releasing ? t('monitor.releasing') : t('monitor.release')}
                </Button>
                <Link href="/processes?sort=rss" className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-primary-soft px-3 text-sm font-medium text-primary-ink">
                  <ArrowSortDown24Regular aria-hidden />
                  {t('monitor.topMemory')}
                </Link>
              </div>
              {released && (
                <p className="mt-2 text-xs text-ok-ink" role="status">
                  {released}
                </p>
              )}
              <p className="mt-2 text-[11px] text-muted">{t('monitor.cacheHint')}</p>
            </>
          )}
        </Card>

        <Card title={t('monitor.gpu')} action={<span className="text-sm tabular-nums text-muted">Radeon 890M</span>}>
          <div className="space-y-3">
            <div>
              <div className="mb-1 flex justify-between text-sm">
                <span className="text-muted">{t('monitor.gpuBusy')}</span>
                <span className="tabular-nums text-ink">{formatPct(s?.gpu.busy, 0)}</span>
              </div>
              <Bar value={s?.gpu.busy ?? 0} />
            </div>
            <div>
              <div className="mb-1 flex justify-between text-sm">
                <span className="text-muted">{t('monitor.gpuShared')}</span>
                <span className="tabular-nums text-ink">
                  {formatBytes(s?.gpu.gttUsed)} / {formatBytes(s?.gpu.gttTotal)}
                </span>
              </div>
              <Bar value={gpuShared ?? 0} />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Stat label={t('monitor.gpuVram')} value={formatBytes(s?.gpu.vramUsed)} hint={`/ ${formatBytes(s?.gpu.vramTotal)}`} />
              <Stat label={t('monitor.tempGpu')} value={formatTemp(s?.temps.gpu)} />
              <Stat label={t('monitor.tempDisk')} value={formatTemp(s?.temps.nvme)} />
            </div>
          </div>
        </Card>

        <HistoryCard memTotal={m?.total ?? 0} />
      </main>
    </>
  );
}
