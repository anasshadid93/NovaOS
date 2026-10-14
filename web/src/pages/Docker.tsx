import { useState } from 'react';
import { Link } from 'wouter';
import { Delete24Regular } from '@fluentui/react-icons';
import { ApiError, api } from '../lib/api';
import { usePoll } from '../lib/usePoll';
import { formatBytes } from '../lib/format';
import { useI18n } from '../i18n';
import { useConfirm } from '../components/ConfirmProvider';
import { Button, Card, ErrorText, PageHeader } from '../components/ui';
import { InstalledAppIcon } from '../components/LauncherIcon';

interface Container {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  app: string | null;
}
type Stats = Record<string, { cpu: number; mem: number; memLimit: number }>;
interface Image {
  id: string;
  fullId: string;
  tags: string[];
  size: number;
  created: number;
  usedBy: string[];
}

export function DockerUnavailable({ error }: { error?: string }) {
  const { t } = useI18n();
  return (
    <Card>
      <p className="font-medium text-heading">{t('docker.unavailable')}</p>
      <p className="mt-1 text-sm text-muted">{error === 'permission' ? t('docker.permission') : t('docker.unavailableHint')}</p>
    </Card>
  );
}

function Containers() {
  const { t } = useI18n();
  const list = usePoll<Container[]>('/api/docker/containers', 5000);
  const stats = usePoll<Stats>('/api/docker/stats', 5000);
  const containers = list.data ?? [];
  const running = containers.filter((c) => c.state === 'running').length;
  return (
    <>
      <p className="px-1 text-xs text-muted">
        {t('docker.running')}: {running} · {t('docker.stopped')}: {containers.length - running}
      </p>
      {list.data && containers.length === 0 && (
        <Card>
          <p className="text-sm text-muted">{t('docker.empty')}</p>
        </Card>
      )}
      <ul className="overflow-hidden rounded-list bg-surface shadow-card">
        {containers.map((c) => {
          const s = stats.data?.[c.id];
          return (
            <li key={c.id} className="border-line [&+&]:border-t">
              <Link href={`/docker/${c.id}`} className="flex items-center gap-3 px-4 py-3 active:bg-primary-soft">
                {c.app ? (
                  <span className="relative shrink-0">
                    <InstalledAppIcon id={c.app} title={c.name.replace(/^manar-/, '')} size={40} />
                    <span className={`absolute -bottom-0.5 -end-0.5 size-3 rounded-full ring-2 ring-surface ${c.state === 'running' ? 'bg-ok' : 'bg-muted'}`} aria-hidden />
                  </span>
                ) : (
                  <span className={`size-2.5 shrink-0 rounded-full ${c.state === 'running' ? 'bg-ok' : 'bg-muted'}`} aria-hidden />
                )}
                <span className="min-w-0 flex-1">
                  <span dir="auto" className="block truncate text-start font-medium text-ink">
                    {c.name}
                  </span>
                  <span className="block truncate text-xs text-muted">
                    {c.status} · <span dir="ltr">{c.image}</span>
                  </span>
                </span>
                {s && (
                  <span className="text-end text-xs tabular-nums">
                    <span className="block font-semibold text-ink">{s.cpu.toFixed(1)}%</span>
                    <span className="block text-muted">{formatBytes(s.mem, 0)}</span>
                  </span>
                )}
                <span className="flip-rtl text-muted" aria-hidden>
                  ›
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function Images() {
  const { t, formatRelative } = useI18n();
  const ask = useConfirm();
  const { data, reload } = usePoll<Image[]>('/api/docker/images', 30_000);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const total = (data ?? []).reduce((a, i) => a + i.size, 0);

  const guard = async (fn: () => Promise<void>) => {
    setError('');
    setMsg('');
    try {
      await fn();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'in_use') setError(t('img.inUse'));
      else if (!(e instanceof ApiError && e.code === 'confirm_required')) setError(t('common.error'));
    }
    void reload();
  };

  return (
    <>
      <div className="flex items-center justify-between gap-2 px-1">
        <p className="text-xs text-muted">{t('img.total', { n: data?.length ?? 0, size: formatBytes(total) })}</p>
        <Button
          variant="secondary"
          className="min-h-9 px-3 text-xs"
          onClick={() =>
            void guard(async () => {
              if (!(await ask({ title: t('img.pruneTitle'), body: t('img.pruneBody'), confirmLabel: t('img.prune'), danger: true }))) return;
              const r = await api<{ reclaimed: number }>('/api/docker/images/prune', { body: { all: true } });
              setMsg(t('img.reclaimed', { size: formatBytes(r.reclaimed) }));
            })
          }
        >
          {t('img.prune')}
        </Button>
      </div>
      <ul className="overflow-hidden rounded-list bg-surface shadow-card">
        {data?.map((img) => (
          <li key={img.id} className="flex items-center gap-3 border-line px-4 py-3 [&+&]:border-t">
            <span className="min-w-0 flex-1">
              <span dir="ltr" className="block truncate text-start text-sm font-medium text-ink">
                {img.tags[0] ?? img.id}
              </span>
              <span className="block truncate text-xs text-muted">
                {formatBytes(img.size)} · {formatRelative(img.created)} · {img.usedBy.length ? t('img.usedBy', { names: img.usedBy.join(', ') }) : t('img.unused')}
              </span>
            </span>
            <button
              type="button"
              disabled={img.usedBy.length > 0}
              aria-label={`${t('img.remove')} ${img.tags[0] ?? img.id}`}
              className="inline-flex size-10 shrink-0 items-center justify-center rounded-full text-danger disabled:opacity-30"
              onClick={() =>
                void guard(async () => {
                  if (!(await ask({ title: t('img.removeTitle', { name: img.tags[0] ?? img.id }), confirmLabel: t('img.remove'), danger: true }))) return;
                  await api(`/api/docker/images/${img.fullId.replace(/^sha256:/, '')}`, { method: 'DELETE' });
                })
              }
            >
              <Delete24Regular aria-hidden />
            </button>
          </li>
        ))}
      </ul>
      {msg && (
        <p className="text-center text-sm text-ok-ink" role="status">
          {msg}
        </p>
      )}
      <ErrorText>{error}</ErrorText>
    </>
  );
}

export function Docker() {
  const { t } = useI18n();
  const status = usePoll<{ ok: boolean; version?: string; error?: string }>('/api/docker/status', 15000);
  const [tab, setTab] = useState<'containers' | 'images'>('containers');
  const ok = status.data?.ok;
  return (
    <>
      <PageHeader title={t('docker.title')} back="/" actions={status.data?.version && <span className="text-xs text-muted">v{status.data.version}</span>} />
      <main className="safe-bottom mx-auto max-w-md space-y-3 px-3">
        {status.data && !ok && <DockerUnavailable error={status.data.error} />}
        {ok && (
          <>
            <div className="grid grid-cols-2 gap-1 rounded-xl bg-primary-soft p-1" role="tablist">
              {(['containers', 'images'] as const).map((x) => (
                <button
                  key={x}
                  type="button"
                  role="tab"
                  aria-selected={tab === x}
                  onClick={() => setTab(x)}
                  className={`min-h-10 rounded-lg text-sm ${tab === x ? 'bg-surface font-medium text-heading shadow-card' : 'text-muted'}`}
                >
                  {t(`docker.${x}`)}
                </button>
              ))}
            </div>
            {tab === 'containers' ? <Containers /> : <Images />}
          </>
        )}
      </main>
    </>
  );
}
