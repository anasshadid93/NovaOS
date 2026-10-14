import { useState } from 'react';
import { api } from '../lib/api';
import { formatBytes, formatDuration, ltr } from '../lib/format';
import { usePoll } from '../lib/usePoll';
import { useI18n } from '../i18n';
import { Button, Card, PageHeader } from '../components/ui';

/**
 * Backup: nightly restic snapshots of the server's settings, databases and projects on the Toshiba — status,
 * history, and browsing any night's snapshot to bring a file or folder back (into a separate folder,
 * never over the original).
 */
interface Run {
  at: number;
  finishedAt?: number;
  ok?: boolean;
  warnings?: number;
  filesNew?: number;
  filesChanged?: number;
  bytesAdded?: number;
  totalBytes?: number;
  error?: string;
}
interface State {
  running: boolean;
  phase?: 'snapshot-db' | 'backup' | 'prune';
  percent?: number;
  bytesDone?: number;
  bytesTotal?: number;
  current?: string;
  last?: Run;
  lastOk?: number;
  history: Run[];
}
interface Snap {
  id: string;
  short: string;
  time: string;
}
interface Entry {
  name: string;
  type: 'dir' | 'file' | 'symlink';
  path: string;
  size?: number;
}

export function Backup() {
  const { t, formatRelative } = useI18n();
  const { data, reload } = usePoll<{ state: State; snapshots: Snap[]; repo: string; repoBytes: number; sources: string[] }>('/api/backup', 3000);
  const [browse, setBrowse] = useState<Snap | null>(null);
  const s = data?.state;
  const stale = !s?.lastOk || Date.now() - s.lastOk > 36 * 3600_000;
  return (
    <>
      <PageHeader title={t('bk.title')} back="/" />
      <main className="safe-bottom mx-auto max-w-3xl space-y-3 px-3">
        <Card>
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <p className={`text-lg font-semibold ${s?.running ? 'text-primary' : stale ? 'text-danger' : 'text-ok'}`}>
                {s?.running ? t('bk.running') : s?.lastOk ? t('bk.lastOk', { when: formatRelative(s.lastOk) }) : t('bk.never')}
              </p>
              <p className="text-sm text-muted">{t('bk.schedule')}</p>
            </div>
            <Button
              className="min-h-10 shrink-0"
              disabled={s?.running}
              onClick={() => {
                void api('/api/backup/run', { method: 'POST', body: {} }).then(() => reload());
              }}
            >
              {t('bk.now')}
            </Button>
          </div>
          {s?.running && (
            <div className="mt-3 space-y-1">
              <div className="h-2 overflow-hidden rounded-full bg-canvas">
                <div className="h-full rounded-full bg-primary transition-[width] duration-700" style={{ width: `${Math.round((s.percent ?? 0) * 100)}%` }} />
              </div>
              <p className="text-xs text-muted">
                {t(`bk.phase.${s.phase ?? 'backup'}` as 'bk.phase.backup')} · {ltr(`${Math.round((s.percent ?? 0) * 100)}%`)}
                {s.bytesTotal ? ` · ${formatBytes(s.bytesDone)} / ${formatBytes(s.bytesTotal)}` : ''}
              </p>
              {s.current && <p className="truncate text-xs text-muted" dir="ltr">{s.current}</p>}
            </div>
          )}
          {s?.last && !s.last.ok && !s.running && <p className="mt-2 text-sm text-danger">{t('bk.failed', { error: s.last.error ?? '' })}</p>}
          <div className="mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
            <Stat label={t('bk.size')} value={formatBytes(data?.repoBytes ?? 0)} />
            <Stat label={t('bk.snapshots')} value={String(data?.snapshots.length ?? 0)} />
            <Stat label={t('bk.covered')} value={s?.last?.totalBytes ? formatBytes(s.last.totalBytes) : '—'} />
          </div>
        </Card>

        <Card title={t('bk.history')}>
          <ul className="divide-y divide-line">
            {(s?.history ?? []).slice(0, 10).map((r) => (
              <li key={r.at} className="flex items-center gap-3 py-2 text-sm">
                <span className={`size-2.5 shrink-0 rounded-full ${r.ok ? (r.warnings ? 'bg-amber-400' : 'bg-ok') : 'bg-danger'}`} aria-hidden />
                <span className="min-w-0 flex-1 truncate">
                  {formatRelative(r.at)}
                  {r.ok ? ` · ${t('bk.added', { size: formatBytes(r.bytesAdded ?? 0), n: (r.filesNew ?? 0) + (r.filesChanged ?? 0) })}` : ` · ${r.error ?? ''}`}
                </span>
                {r.finishedAt && <span className="shrink-0 text-xs text-muted">{formatDuration((r.finishedAt - r.at) / 1000)}</span>}
              </li>
            ))}
            {!s?.history.length && <li className="py-3 text-center text-sm text-muted">{t('bk.empty')}</li>}
          </ul>
        </Card>

        <Card title={t('bk.restore')}>
          <p className="mb-2 text-sm text-muted">{t('bk.restoreHint')}</p>
          <ul className="divide-y divide-line">
            {(data?.snapshots ?? []).slice(0, 20).map((sn) => (
              <li key={sn.id}>
                <button type="button" className="flex min-h-11 w-full items-center gap-3 py-2 text-start text-sm active:bg-primary-soft" onClick={() => setBrowse(sn)}>
                  <span className="flex-1">{new Date(sn.time).toLocaleString()}</span>
                  <span className="font-mono text-xs text-muted">{sn.short}</span>
                </button>
              </li>
            ))}
          </ul>
        </Card>
        {browse && <Browser snap={browse} onClose={() => setBrowse(null)} />}
        <p className="px-2 text-center text-xs text-muted" dir="ltr">
          {data?.repo}
        </p>
      </main>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-canvas p-2">
      <p className="text-xs text-muted">{label}</p>
      <p className="font-semibold text-heading">{ltr(value)}</p>
    </div>
  );
}

function Browser({ snap, onClose }: { snap: Snap; onClose: () => void }) {
  const { t } = useI18n();
  const [dir, setDir] = useState('/');
  const { data } = usePoll<{ entries: Entry[] }>(`/api/backup/ls?snapshot=${snap.id}&path=${encodeURIComponent(dir)}`, 600_000);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const up = dir === '/' ? null : dir.replace(/\/[^/]+\/?$/, '') || '/';
  const restore = async (p: string) => {
    setBusy(p);
    setMsg(null);
    try {
      const r = await api<{ to: string }>('/api/backup/restore', { method: 'POST', body: { snapshot: snap.id, path: p } });
      setMsg(t('bk.restored', { to: r.to }));
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card title={new Date(snap.time).toLocaleString()} action={<Button variant="secondary" onClick={onClose}>{t('bk.close')}</Button>}>
      <p className="mb-2 truncate font-mono text-xs text-muted" dir="ltr">
        {dir}
      </p>
      {msg && <p className="mb-2 break-all rounded-lg bg-primary-soft p-2 text-sm">{msg}</p>}
      <ul className="max-h-[60dvh] divide-y divide-line overflow-auto">
        {up && (
          <li>
            <button type="button" className="min-h-10 w-full py-2 text-start text-sm text-primary" onClick={() => setDir(up)}>
              ↩ ..
            </button>
          </li>
        )}
        {(data?.entries ?? []).map((e) => (
          <li key={e.path} className="flex items-center gap-2 py-1.5 text-sm">
            {e.type === 'dir' ? (
              <button type="button" className="min-h-9 flex-1 truncate text-start" dir="ltr" onClick={() => setDir(e.path)}>
                📁 {e.name}
              </button>
            ) : (
              <span className="flex-1 truncate" dir="ltr">
                📄 {e.name} <span className="text-xs text-muted">{formatBytes(e.size ?? 0)}</span>
              </span>
            )}
            <Button variant="secondary" className="min-h-9 shrink-0 px-2 text-xs" disabled={busy !== null} onClick={() => void restore(e.path)}>
              {busy === e.path ? '…' : t('bk.bringBack')}
            </Button>
          </li>
        ))}
        {!data && <li className="py-3 text-center text-sm text-muted">…</li>}
      </ul>
    </Card>
  );
}
