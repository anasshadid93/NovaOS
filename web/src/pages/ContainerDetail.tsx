import { useCallback, useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import {
  Add24Regular,
  ArrowClockwise24Regular,
  ArrowDownload24Regular,
  Delete24Regular,
  Eye24Regular,
  Open24Regular,
  Play24Regular,
  Stop24Regular,
} from '@fluentui/react-icons';
import { ApiError, api } from '../lib/api';
import { usePoll } from '../lib/usePoll';
import { formatBytes, formatDuration } from '../lib/format';
import { useI18n, type MessageKey } from '../i18n';
import { useConfirm } from '../components/ConfirmProvider';
import { Button, Card, ErrorText, ListGroup, ListRow, PageHeader } from '../components/ui';
import { useRemoveApp, type InstalledApp } from './Apps';
import { externalLink } from '../lib/external';
import { LiveLogs } from '../components/LiveLogs';

interface Info {
  id: string;
  name: string;
  image: string;
  created: number;
  state: { status: string; running: boolean; startedAt: number; exitCode: number; health: string | null; restarts: number };
  command: string;
  restartPolicy: string;
  memory: number;
  cpus: number;
  networks: { name: string; ip: string }[];
  ports: { target: string; hostIp: string; hostPort: string }[];
  mounts: { type: string; source: string; destination: string; rw: boolean }[];
  env: { key: string; value: string | null }[];
  labels: Record<string, string>;
  app: { id: string; service: string; managed: boolean } | null;
}

type Tab = 'overview' | 'settings' | 'env' | 'storage' | 'logs';
const MEM_STEPS = [0, 256, 512, 1024, 2048, 4096, 8192, 16384];
const CPU_STEPS = [0, 0.5, 1, 2, 4, 8];

function useErrorText() {
  const { t } = useI18n();
  return (e: unknown) => {
    const code = e instanceof ApiError ? e.code : '';
    const key = `ctr.err.${code}`;
    return ['port_not_localhost', 'host_network', 'privileged', 'yaml', 'compose_invalid', 'busy'].includes(code) ? t(key as MessageKey) : t('common.error');
  };
}

function SettingsTab({ info, onSaved }: { info: Info; onSaved: (task?: number) => void }) {
  const { t, tn } = useI18n();
  const errText = useErrorText();
  const [restart, setRestart] = useState(info.restartPolicy);
  const [mem, setMem] = useState(Math.round(info.memory / 1024 ** 2));
  const [cpus, setCpus] = useState(info.cpus);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const memOptions = MEM_STEPS.includes(mem) ? MEM_STEPS : [...MEM_STEPS, mem].sort((a, b) => a - b);
  const cpuOptions = CPU_STEPS.includes(cpus) ? CPU_STEPS : [...CPU_STEPS, cpus].sort((a, b) => a - b);
  const select = 'block min-h-12 w-full rounded-xl border border-line bg-surface px-3 text-base text-ink';

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api<{ task?: number }>(`/api/docker/containers/${info.id}/settings`, {
        body: { restart, memory: mem ? mem * 1024 ** 2 : null, cpus: cpus || null },
      });
      onSaved(r.task);
    } catch (e) {
      if (!(e instanceof ApiError && e.code === 'confirm_required')) setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <div className="space-y-4">
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-ink">{t('ctr.restartPolicy')}</span>
          <select value={restart} onChange={(e) => setRestart(e.target.value)} className={select}>
            {['unless-stopped', 'always', 'on-failure', 'no'].map((r) => (
              <option key={r} value={r}>
                {t(`ctr.restart.${r}` as MessageKey)}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-ink">{t('ctr.memLimit')}</span>
          <select value={mem} onChange={(e) => setMem(Number(e.target.value))} className={select}>
            {memOptions.map((m) => (
              <option key={m} value={m}>
                {m ? formatBytes(m * 1024 ** 2, 0).replace(/[⁦-⁩]/g, '') : t('ctr.noLimit')}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-ink">{t('ctr.cpuLimit')}</span>
          <select value={cpus} onChange={(e) => setCpus(Number(e.target.value))} className={select}>
            {cpuOptions.map((c) => (
              <option key={c} value={c}>
                {c ? tn('ctr.cores', c) : t('ctr.noLimit')}
              </option>
            ))}
          </select>
        </label>
        <ErrorText>{error}</ErrorText>
        <Button className="w-full" disabled={busy} onClick={() => void save()}>
          {t('ctr.save')}
        </Button>
      </div>
    </Card>
  );
}

type EnvRow = { key: string; value: string | null; secret?: boolean };

function EnvTab({ info, onSaved }: { info: Info; onSaved: (task?: number) => void }) {
  const { t } = useI18n();
  const errText = useErrorText();
  const managed = info.app?.managed;
  const [rows, setRows] = useState<EnvRow[] | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(
    async (reveal: boolean) => {
      if (!managed) return setRows(info.env);
      try {
        const all = await api<Record<string, EnvRow[]>>(`/api/apps/${info.app!.id}/env${reveal ? '/reveal' : ''}`);
        setRows(all[info.app!.service] ?? []);
      } catch (e) {
        if (!(e instanceof ApiError && e.code === 'confirm_required')) setError(t('common.error'));
      }
    },
    [managed, info, t],
  );
  useEffect(() => {
    void load(false);
  }, [load]);

  const save = async () => {
    setError('');
    try {
      const r = await api<{ task: number }>(`/api/apps/${info.app!.id}/env`, {
        method: 'PUT',
        body: { service: info.app!.service, vars: rows!.filter((r) => r.key.trim()).map((r) => ({ key: r.key.trim(), value: r.value })) },
      });
      onSaved(r.task);
    } catch (e) {
      if (!(e instanceof ApiError && e.code === 'confirm_required')) setError(errText(e));
    }
  };

  if (!rows) return <Card>{t('common.loading')}</Card>;
  const input = 'min-h-10 w-full rounded-lg border border-line bg-surface px-2 font-mono text-xs text-ink outline-none focus:border-primary';
  return (
    <Card>
      <p className="mb-3 text-xs text-muted">{managed ? t('ctr.envSecretHint') : t('ctr.envReadonly')}</p>
      <ul className="space-y-2" dir="ltr">
        {rows.map((r, i) => (
          <li key={i} className="rounded-xl bg-canvas p-2">
            <div className="flex items-center gap-2">
              <input
                aria-label={t('ctr.key')}
                className={`${input} font-semibold`}
                value={r.key}
                readOnly={!managed}
                onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))}
              />
              {managed && (
                <button
                  type="button"
                  onClick={() => setRows(rows.filter((_, j) => j !== i))}
                  className="inline-flex size-9 shrink-0 items-center justify-center rounded-full text-danger"
                  aria-label={`${t('common.delete')} ${r.key}`}
                >
                  <Delete24Regular className="size-5" aria-hidden />
                </button>
              )}
            </div>
            <input
              aria-label={t('ctr.value')}
              className={`${input} mt-1`}
              value={r.value ?? ''}
              placeholder={r.value === null ? t('ctr.hidden') : ''}
              readOnly={!managed}
              onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
            />
          </li>
        ))}
      </ul>
      {managed && (
        <div className="mt-4 grid grid-cols-2 gap-2">
          <Button variant="secondary" className="min-h-10 text-sm" onClick={() => setRows([...rows, { key: '', value: '' }])}>
            <Add24Regular aria-hidden />
            {t('ctr.addVar')}
          </Button>
          <Button variant="secondary" className="min-h-10 text-sm" onClick={() => void load(true)}>
            <Eye24Regular aria-hidden />
            {t('ctr.reveal')}
          </Button>
          <Button className="col-span-2" onClick={() => void save()}>
            {t('ctr.saveEnv')}
          </Button>
        </div>
      )}
      <ErrorText>{error}</ErrorText>
    </Card>
  );
}

function ComposeEditor({ appId, onSaved }: { appId: string; onSaved: (task?: number) => void }) {
  const { t } = useI18n();
  const errText = useErrorText();
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState('');
  const open = async () => {
    try {
      setText((await api<{ text: string }>(`/api/apps/${appId}/compose`)).text);
    } catch (e) {
      if (!(e instanceof ApiError && e.code === 'confirm_required')) setError(t('common.error'));
    }
  };
  const save = async () => {
    setError('');
    try {
      const r = await api<{ task: number }>(`/api/apps/${appId}/compose`, { method: 'PUT', body: { text } });
      onSaved(r.task);
    } catch (e) {
      if (!(e instanceof ApiError && e.code === 'confirm_required')) setError(errText(e));
    }
  };
  return (
    <Card title={t('ctr.compose')}>
      <p className="mb-3 text-xs text-muted">{t('ctr.composeHint')}</p>
      {text === null ? (
        <Button variant="secondary" className="w-full" onClick={() => void open()}>
          {t('ctr.editCompose')}
        </Button>
      ) : (
        <>
          <textarea
            dir="ltr"
            spellCheck={false}
            autoCapitalize="off"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={18}
            className="block w-full rounded-xl border border-line bg-canvas p-3 font-mono text-[11px] leading-snug text-ink outline-none focus:border-primary"
          />
          <Button className="mt-3 w-full" onClick={() => void save()}>
            {t('ctr.saveCompose')}
          </Button>
        </>
      )}
      <ErrorText>{error}</ErrorText>
    </Card>
  );
}

export function ContainerDetail({ params }: { params: { id: string } }) {
  const { t, formatRelative } = useI18n();
  const ask = useConfirm();
  const [, navigate] = useLocation();
  const [tab, setTab] = useState<Tab>('overview');
  const { data: info, reload } = usePoll<Info>(`/api/docker/containers/${params.id}/info`, 5000);
  const { data: stats } = usePoll<Record<string, { cpu: number; mem: number; memLimit: number }>>(
    tab === 'overview' && info?.state.running ? '/api/docker/stats' : null,
    5000,
  );
  const { data: apps } = usePoll<InstalledApp[]>('/api/apps', 30_000);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  const runTask = async (path: string, init: { method?: string; body?: unknown }) => {
    try {
      const r = await api<{ task?: number }>(path, init);
      if (r.task) navigate(`/tasks/${r.task}`);
      else navigate('/docker');
    } catch (e) {
      if (!(e instanceof ApiError && e.code === 'confirm_required')) setError(t('common.error'));
    }
  };
  const removeApp = useRemoveApp(runTask);

  const act = async (action: 'start' | 'stop' | 'restart' | 'update') => {
    setError('');
    if (action !== 'start') {
      const titles = { stop: 'docker.stopTitle', restart: 'docker.restartTitle', update: 'docker.updateTitle' } as const;
      if (
        !(await ask({
          title: t(titles[action], { name: info!.name }),
          body: action === 'update' ? t('docker.updateBody') : undefined,
          danger: action === 'stop',
        }))
      )
        return;
    }
    try {
      const r = await api<{ task?: number }>(`/api/docker/containers/${info!.id}/${action}`, { body: {} });
      if (r.task) navigate(`/tasks/${r.task}`);
      else void reload();
    } catch (e) {
      if (!(e instanceof ApiError && e.code === 'confirm_required')) setError(t('common.error'));
    }
  };

  const removeContainer = async () => {
    let volumes = false;
    const ok = await ask({
      title: t('ctr.removeTitle', { name: info!.name }),
      body: (
        <div className="space-y-3">
          <p>{t('ctr.removeBody')}</p>
          <label className="flex items-center gap-3 rounded-xl bg-canvas p-3">
            <input type="checkbox" className="size-5" onChange={(e) => (volumes = e.target.checked)} />
            <span className="text-sm text-ink">{t('ctr.removeVolumes')}</span>
          </label>
        </div>
      ),
      typeToConfirm: info!.name,
      confirmLabel: t('ctr.removeContainer'),
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/api/docker/containers/${info!.id}`, { method: 'DELETE', body: { volumes } });
      navigate('/docker');
    } catch (e) {
      if (!(e instanceof ApiError && e.code === 'confirm_required')) setError(t('common.error'));
    }
  };

  const onSaved = (task?: number) => {
    if (task) navigate(`/tasks/${task}`);
    else {
      setMsg(t('ctr.saved'));
      void reload();
    }
  };

  if (!info) return <PageHeader title="…" back="/docker" />;
  const s = stats?.[info.id];
  const app = info.app && apps?.find((a) => a.id === info.app!.id);
  const tabs: Tab[] = ['overview', 'settings', 'env', 'storage', 'logs'];
  const value = (v: React.ReactNode) => <span className="max-w-[60%] truncate text-end text-sm text-muted">{v}</span>;

  return (
    <>
      <PageHeader title={info.name} back="/docker">
        <div className="-mx-3 flex gap-1 overflow-x-auto px-3 py-0.5" role="tablist">
          {tabs.map((x) => (
            <button
              key={x}
              type="button"
              role="tab"
              aria-selected={tab === x}
              onClick={() => setTab(x)}
              className={`min-h-9 shrink-0 rounded-full px-3 text-sm ${tab === x ? 'bg-primary text-white' : 'bg-surface text-ink shadow-card'}`}
            >
              {t(`ctr.tab.${x}` as MessageKey)}
            </button>
          ))}
        </div>
      </PageHeader>
      <main className="safe-bottom mx-auto max-w-md space-y-4 px-3">
        {msg && (
          <p className="rounded-xl bg-ok/10 p-3 text-sm text-ok-ink" role="status">
            {msg}
          </p>
        )}
        <ErrorText>{error}</ErrorText>

        {tab === 'overview' && (
          <>
            <ListGroup>
              <ListRow
                label={t('ctr.status')}
                trailing={
                  <span className={`flex items-center gap-2 text-sm ${info.state.running ? 'text-ok-ink' : 'text-muted'}`}>
                    <span className={`size-2.5 rounded-full ${info.state.running ? 'bg-ok' : 'bg-muted'}`} aria-hidden />
                    {info.state.status}
                  </span>
                }
              />
              {info.state.health && <ListRow label={t('ctr.health')} trailing={value(info.state.health)} />}
              {info.state.running && <ListRow label={t('ctr.uptime')} trailing={value(formatDuration((Date.now() - info.state.startedAt) / 1000))} />}
              {s && <ListRow label={t('ctr.cpu')} trailing={value(`${s.cpu.toFixed(1)}%`)} />}
              {s && <ListRow label={t('ctr.memory')} trailing={value(formatBytes(s.mem))} />}
              <ListRow label={t('ctr.restarts')} trailing={value(String(info.state.restarts))} />
              <ListRow
                label={t('ctr.image')}
                trailing={
                  <span dir="ltr" className="max-w-[60%] truncate text-sm text-muted">
                    {info.image}
                  </span>
                }
              />
              <ListRow label={t('ctr.created')} trailing={value(formatRelative(info.created))} />
              <ListRow label={t('ctr.restartPolicy')} trailing={value(t(`ctr.restart.${info.restartPolicy}` as MessageKey))} />
            </ListGroup>

            <div className="grid grid-cols-2 gap-2">
              {info.state.running ? (
                <>
                  <Button variant="secondary" onClick={() => void act('restart')}>
                    <ArrowClockwise24Regular aria-hidden />
                    {t('docker.restart')}
                  </Button>
                  <Button variant="secondary" onClick={() => void act('stop')}>
                    <Stop24Regular aria-hidden />
                    {t('docker.stop')}
                  </Button>
                </>
              ) : (
                <Button variant="secondary" className="col-span-2" onClick={() => void act('start')}>
                  <Play24Regular aria-hidden />
                  {t('docker.start')}
                </Button>
              )}
              <Button variant="secondary" onClick={() => void act('update')}>
                <ArrowDownload24Regular aria-hidden />
                {t('docker.update')}
              </Button>
              {app?.url ? (
                <a
                  {...externalLink(app.url)}
                  className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-primary font-medium text-white"
                >
                  <Open24Regular aria-hidden />
                  {t('ctr.openApp')}
                </a>
              ) : (
                <span />
              )}
            </div>

            <Card title={t('ctr.danger')}>
              {info.app?.managed ? (
                <Button variant="danger" className="w-full" onClick={() => void removeApp({ id: info.app!.id, title: app?.title ?? info.app!.id })}>
                  <Delete24Regular aria-hidden />
                  {t('ctr.removeApp')}
                </Button>
              ) : (
                <Button variant="danger" className="w-full" onClick={() => void removeContainer()}>
                  <Delete24Regular aria-hidden />
                  {t('ctr.removeContainer')}
                </Button>
              )}
            </Card>
          </>
        )}

        {tab === 'settings' && (
          <>
            <SettingsTab info={info} onSaved={onSaved} />
            {info.app?.managed && <ComposeEditor appId={info.app.id} onSaved={onSaved} />}
            {info.command && (
              <Card title={t('ctr.command')}>
                <pre dir="ltr" className="whitespace-pre-wrap break-all font-mono text-xs text-ink">
                  {info.command}
                </pre>
              </Card>
            )}
          </>
        )}

        {tab === 'env' && <EnvTab info={info} onSaved={onSaved} />}

        {tab === 'storage' && (
          <>
            <Card title={t('ctr.ports')}>
              {info.ports.length === 0 ? (
                <p className="text-sm text-muted">—</p>
              ) : (
                <ul className="space-y-1 font-mono text-xs text-ink" dir="ltr">
                  {info.ports.map((p) => (
                    <li key={`${p.target}${p.hostPort}`}>
                      {p.hostPort ? `${p.hostIp || '0.0.0.0'}:${p.hostPort} → ` : ''}
                      {p.target}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card title={t('ctr.mounts')}>
              <ul className="space-y-2 text-xs" dir="ltr">
                {info.mounts.map((m) => (
                  <li key={m.destination} className="rounded-lg bg-canvas p-2">
                    <p className="break-all font-mono text-ink">{m.source}</p>
                    <p className="break-all font-mono text-muted">
                      → {m.destination} · {m.type}
                      {!m.rw && ` · ${t('ctr.readOnly')}`}
                    </p>
                  </li>
                ))}
              </ul>
            </Card>
            <Card title={t('ctr.networks')}>
              <ul className="space-y-1 font-mono text-xs text-ink" dir="ltr">
                {info.networks.map((n) => (
                  <li key={n.name}>
                    {n.name} · {n.ip || '—'}
                  </li>
                ))}
              </ul>
            </Card>
            <details className="card p-4">
              <summary className="cursor-pointer text-sm font-semibold text-heading">{t('ctr.labels')}</summary>
              <ul className="mt-2 space-y-1 font-mono text-[11px]" dir="ltr">
                {Object.entries(info.labels).map(([k, v]) => (
                  <li key={k} className="break-all">
                    <span className="text-muted">{k}</span> = <span className="text-ink">{v}</span>
                  </li>
                ))}
              </ul>
            </details>
          </>
        )}

        {tab === 'logs' && <LiveLogs id={params.id} name={info?.name ?? params.id} />}
      </main>
    </>
  );
}
