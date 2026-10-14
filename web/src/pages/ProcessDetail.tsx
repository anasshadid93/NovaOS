import { useCallback, useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import { ArrowClockwise24Regular, Dismiss24Regular, Warning24Regular } from '@fluentui/react-icons';
import { ApiError, api } from '../lib/api';
import { useProcesses, type ProcRow } from '../lib/live';
import { formatBytes, formatDuration } from '../lib/format';
import { useI18n, type MessageKey } from '../i18n';
import { useConfirm } from '../components/ConfirmProvider';
import { Button, Card, ErrorText, ListGroup, ListRow, PageHeader } from '../components/ui';

interface Details {
  pid: number;
  cmdline: string | null;
  exe: string | null;
  cwd: string | null;
  state: string | null;
  ppid: number;
  threads: { tid: number; name: string; state: string }[];
  cgroup: string | null;
}

interface Ports {
  ports: { proto: string; address: string; port: number }[];
  restricted: boolean;
}

export function ProcessDetail({ params }: { params: { pid: string } }) {
  const pid = Number(params.pid);
  const { t } = useI18n();
  const ask = useConfirm();
  const [, navigate] = useLocation();
  const [details, setDetails] = useState<Details | null>(null);
  const [gone, setGone] = useState(false);
  const [ports, setPorts] = useState<Ports | null>(null);
  const [loadingPorts, setLoadingPorts] = useState(false);
  const [showThreads, setShowThreads] = useState(false);
  const [error, setError] = useState('');

  // Live numbers for just this PID (search by exact PID).
  const { rows } = useProcesses({ sort: 'cpu', q: String(pid), mode: 'list' });
  const row = (rows as ProcRow[]).find((r) => r[0] === pid);

  useEffect(() => {
    api<Details>(`/api/processes/${pid}`)
      .then(setDetails)
      .catch((e) => e instanceof ApiError && e.status === 404 && setGone(true));
  }, [pid]);

  const loadPorts = useCallback(async () => {
    setLoadingPorts(true);
    try {
      setPorts(await api<Ports>(`/api/processes/${pid}/ports`));
    } finally {
      setLoadingPorts(false);
    }
  }, [pid]);

  const name = row?.[1] ?? details?.cmdline?.split(' ')[0]?.split('/').pop() ?? String(pid);
  const group = row?.[8] ?? '';
  const [gKind, gUnit] = group.includes(':') ? group.split(/:(.*)/s) : [group, ''];
  const restartable = (gKind === 'svc' || gKind === 'user') && gUnit && gUnit !== 'manar.service';

  const act = async (kind: 'TERM' | 'KILL' | 'restart') => {
    setError('');
    const ok =
      kind === 'restart'
        ? await ask({ title: t('proc.restartTitle', { unit: gUnit }), body: t('proc.restartBody'), confirmLabel: t('proc.restart'), danger: true })
        : await ask({
            title: t(kind === 'TERM' ? 'proc.terminateTitle' : 'proc.killTitle', { name }),
            body: t(kind === 'TERM' ? 'proc.terminateBody' : 'proc.killBody', { pid }),
            confirmLabel: t(kind === 'TERM' ? 'proc.terminate' : 'proc.kill'),
            danger: true,
          });
    if (!ok) return;
    try {
      if (kind === 'restart') await api(`/api/processes/${pid}/restart`, { body: {} });
      else await api(`/api/processes/${pid}/signal`, { body: { signal: kind } });
      navigate('/processes');
    } catch (e) {
      if (!(e instanceof ApiError && e.code === 'confirm_required')) setError(t('proc.failed'));
    }
  };


  return (
    <>
      <PageHeader title={name} back="/processes" />
      <main className="safe-bottom mx-auto max-w-md space-y-4 px-3">
        {gone && !row ? (
          <Card>
            <p className="text-sm text-muted">{t('proc.gone')}</p>
          </Card>
        ) : (
          <>
            <ListGroup>
              <ListRow label={t('proc.pid')} trailing={<span className="tabular-nums text-muted">{pid}</span>} />
              <ListRow label={t('proc.user')} trailing={<span className="text-muted">{row?.[2] ?? '—'}</span>} />
              <ListRow
                label={t('proc.state')}
                trailing={<span className="text-muted">{row ? t(`procs.state.${row[3]}` as MessageKey) : (details?.state ?? '—')}</span>}
              />
              <ListRow label={t('proc.cpu')} trailing={<span className="tabular-nums text-muted">{row ? `${row[4].toFixed(1)}%` : '—'}</span>} />
              <ListRow label={t('proc.memory')} trailing={<span className="tabular-nums text-muted">{row ? formatBytes(row[5]) : '—'}</span>} />
              <ListRow label={t('proc.running')} trailing={<span className="tabular-nums text-muted">{row ? formatDuration((Date.now() - row[7]) / 1000) : '—'}</span>} />
              {group && <ListRow label={t('proc.group')} trailing={<span className="max-w-[55%] truncate text-muted">{gUnit || group}</span>} />}
            </ListGroup>

            {details?.cmdline && (
              <Card title={t('proc.command')}>
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-canvas p-3 font-mono text-xs text-ink" dir="ltr">
                  {details.cmdline}
                </pre>
                {details.exe && (
                  <p className="mt-2 break-all text-xs text-muted" dir="ltr">
                    {t('proc.exe')}: {details.exe}
                  </p>
                )}
                {details.cwd && (
                  <p className="mt-1 break-all text-xs text-muted" dir="ltr">
                    {t('proc.cwd')}: {details.cwd}
                  </p>
                )}
              </Card>
            )}

            <Card title={t('proc.ports')}>
              {!ports ? (
                <Button variant="secondary" className="w-full" onClick={() => void loadPorts()} disabled={loadingPorts}>
                  {t('proc.loadPorts')}
                </Button>
              ) : ports.restricted ? (
                <p className="text-sm text-muted">{t('proc.portsRestricted')}</p>
              ) : ports.ports.length === 0 ? (
                <p className="text-sm text-muted">{t('proc.noPorts')}</p>
              ) : (
                <ul className="flex flex-wrap gap-2" dir="ltr">
                  {ports.ports.map((p) => (
                    <li key={`${p.proto}${p.address}${p.port}`} className="rounded-lg bg-primary-soft px-2 py-1 font-mono text-xs text-primary-ink">
                      {p.proto} {p.address}:{p.port}
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            {details && details.threads.length > 0 && (
              <Card
                title={`${t('proc.threads')} · ${row?.[6] ?? details.threads.length}`}
                action={
                  <button type="button" className="text-sm text-primary-ink" onClick={() => setShowThreads((v) => !v)} aria-expanded={showThreads}>
                    {showThreads ? '−' : '+'}
                  </button>
                }
              >
                {showThreads && (
                  <ul className="max-h-64 space-y-1 overflow-auto text-xs">
                    {details.threads.map((th) => (
                      <li key={th.tid} className="flex justify-between gap-2 tabular-nums">
                        <span className="truncate text-ink">{th.name}</span>
                        <span className="text-muted">
                          {th.tid} · {th.state}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            )}

            <ErrorText>{error}</ErrorText>
            <div className="grid grid-cols-2 gap-3">
              <Button variant="secondary" onClick={() => void act('TERM')}>
                <Dismiss24Regular aria-hidden />
                {t('proc.terminate')}
              </Button>
              <Button variant="danger" onClick={() => void act('KILL')}>
                <Warning24Regular aria-hidden />
                {t('proc.kill')}
              </Button>
              {restartable && (
                <Button variant="secondary" className="col-span-2" onClick={() => void act('restart')}>
                  <ArrowClockwise24Regular aria-hidden />
                  {t('proc.restart')}
                </Button>
              )}
            </div>
          </>
        )}
      </main>
    </>
  );
}
