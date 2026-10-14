import { useEffect, useState } from 'react';
import { ArrowReset24Filled, Power24Regular, WeatherMoon24Filled } from '@fluentui/react-icons';
import { ApiError, api } from '../lib/api';
import { formatBytes, formatDuration } from '../lib/format';
import { usePoll } from '../lib/usePoll';
import { useI18n, type MessageKey } from '../i18n';
import { useConfirm } from '../components/ConfirmProvider';
import { Button, Card, ErrorText, ListGroup, ListRow, PageHeader, TextField } from '../components/ui';
import { SpeedTest } from '../components/SpeedTest';

const value = (v: React.ReactNode) => <span className="max-w-[60%] truncate text-end text-sm text-muted">{v}</span>;

export function SystemInfo() {
  const { t } = useI18n();
  const [s, setS] = useState<{ hostname: string; os: string; kernel: string; cpuModel: string; cores: number; memTotal: number; uptime: number | null } | null>(null);
  useEffect(() => {
    api<typeof s>('/api/settings/system').then(setS);
  }, []);
  return (
    <>
      <PageHeader title={t('settings.system')} back="/settings" />
      <main className="safe-bottom mx-auto max-w-md px-3">
        {s && (
          <ListGroup>
            <ListRow label={t('system.hostname')} trailing={value(s.hostname)} />
            <ListRow label={t('system.os')} trailing={value(s.os)} />
            <ListRow label={t('system.kernel')} trailing={value(s.kernel)} />
            <ListRow label={t('system.cpu')} detail={s.cpuModel} trailing={value(`${s.cores}×`)} />
            <ListRow label={t('system.memory')} trailing={value(formatBytes(s.memTotal))} />
            <ListRow label={t('monitor.uptime')} trailing={value(s.uptime ? formatDuration(s.uptime) : '—')} />
          </ListGroup>
        )}
      </main>
    </>
  );
}

export function NetworkInfo() {
  const { t } = useI18n();
  const { data } = usePoll<{ name: string; mac: string | null; addresses: string[]; state: string | null; speed: number | null; rx: number; tx: number }[]>('/api/settings/network', 5000);
  return (
    <>
      <PageHeader title={t('settings.network')} back="/settings" />
      <main className="safe-bottom mx-auto max-w-md space-y-4 px-3">
        {data?.map((i) => (
          <ListGroup key={i.name} caption={i.name}>
            <ListRow label={t('network.state')} trailing={value(i.state ?? '—')} />
            {i.speed && <ListRow label={t('network.speed')} trailing={value(`${i.speed} Mb/s`)} />}
            {i.addresses.map((a) => (
              <ListRow key={a} label="IP" trailing={<span className="text-sm text-muted" dir="ltr">{a}</span>} />
            ))}
            {i.mac && <ListRow label="MAC" trailing={<span className="text-sm text-muted" dir="ltr">{i.mac}</span>} />}
            <ListRow label={t('network.received')} trailing={value(formatBytes(i.rx))} />
            <ListRow label={t('network.sent')} trailing={value(formatBytes(i.tx))} />
          </ListGroup>
        ))}
      </main>
    </>
  );
}

interface Ts {
  state: string;
  self: { name: string; dns: string; ips: string[] };
  peers: { name: string; dns: string; os: string; online: boolean; ip: string; link: 'direct' | 'relay' | null; relay: string | null; rx: number; tx: number }[];
  serve: { port: string; target: string }[];
}

/** A tailnet device: how it's connected, traffic, and a ping on demand. */
function PeerRow({ p }: { p: Ts['peers'][number] }) {
  const { t } = useI18n();
  const [ping, setPing] = useState<string | null>(null);
  const doPing = async () => {
    setPing('…');
    try {
      const r = await api<{ ms: number; via: 'direct' | 'relay'; path: string }>('/api/tailscale/ping', { body: { ip: p.ip } });
      setPing(`${r.ms} ms · ${r.via === 'direct' ? t('tailscale.direct') : `${t('tailscale.relay')} ${r.path.replace(/^DERP\((.*)\)$/, '$1')}`}`);
    } catch {
      setPing(t('tailscale.noReply'));
    }
  };
  const link = p.link === 'direct' ? t('tailscale.direct') : p.link === 'relay' ? `${t('tailscale.relay')} (${p.relay})` : null;
  return (
    <ListRow
      label={p.name}
      detail={
        <span dir="auto">
          {p.os} · <span dir="ltr">{p.ip}</span>
          {p.online && link ? ` · ${link}` : ''}
          {p.rx + p.tx > 0 ? <span dir="ltr"> · ↓{formatBytes(p.rx)} ↑{formatBytes(p.tx)}</span> : null}
          {ping ? <span className="block text-primary-ink" dir="auto">{ping}</span> : null}
        </span>
      }
      trailing={
        <span className="flex items-center gap-2">
          {p.online && (
            <button type="button" onClick={() => void doPing()} className="rounded-full bg-primary-soft px-2.5 py-1 text-xs text-primary-ink">
              {t('tailscale.ping')}
            </button>
          )}
          <span className={`text-xs ${p.online ? 'text-ok' : 'text-muted'}`}>{p.online ? t('tailscale.online') : t('tailscale.offline')}</span>
        </span>
      }
    />
  );
}

export function TailscaleInfo() {
  const { t } = useI18n();
  const { data, error } = usePoll<Ts>('/api/settings/tailscale', 15000);
  return (
    <>
      <PageHeader title={t('settings.tailscale')} back="/settings" />
      <main className="safe-bottom mx-auto max-w-md space-y-4 px-3">
        {error ? <Card>{t('tailscale.unavailable')}</Card> : null}
        {data && (
          <>
            <ListGroup caption={t('tailscale.self')}>
              <ListRow label={data.self.name} detail={<span dir="ltr">{data.self.dns}</span>} trailing={value(data.state)} />
              {data.self.ips.map((ip) => (
                <ListRow key={ip} label="IP" trailing={<span className="text-sm text-muted" dir="ltr">{ip}</span>} />
              ))}
            </ListGroup>
            {data.serve.length > 0 && (
              <ListGroup caption={t('tailscale.serve')}>
                {data.serve.map((s) => (
                  <ListRow key={s.port} label={`:${s.port}`} trailing={<span className="text-sm text-muted" dir="ltr">{s.target}</span>} />
                ))}
              </ListGroup>
            )}
            <ListGroup caption={t('tailscale.peers')}>
              {data.peers.map((p) => (
                <PeerRow key={p.dns} p={p} />
              ))}
            </ListGroup>
            <SpeedTest />
          </>
        )}
      </main>
    </>
  );
}

export function FirewallInfo() {
  const { t } = useI18n();
  const [s, setS] = useState<{ installed: boolean; active?: boolean | null; output?: string | null; error?: string } | null>(null);
  useEffect(() => {
    api<typeof s>('/api/settings/firewall').then(setS);
  }, []);
  return (
    <>
      <PageHeader title={t('settings.firewall')} back="/settings" />
      <main className="safe-bottom mx-auto max-w-md space-y-4 px-3">
        {s && !s.installed && <Card>{t('firewall.notInstalled')}</Card>}
        {s?.installed && s.error && <Card>{t('firewall.helper')}</Card>}
        {s?.installed && s.output && (
          <Card title={s.active ? t('firewall.active') : t('firewall.inactive')}>
            <pre dir="ltr" className="overflow-auto whitespace-pre-wrap rounded-lg bg-canvas p-3 font-mono text-[11px] text-ink">
              {s.output}
            </pre>
          </Card>
        )}
      </main>
    </>
  );
}

export function PowerSettings() {
  const { t, intl } = useI18n();
  const ask = useConfirm();
  const { data, reload } = usePoll<{ scheduled: { action: string; at: number } | null }>('/api/power', 30_000);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [sched, setSched] = useState<{ action: 'reboot' | 'poweroff'; at: string }>(() => {
    const d = new Date(Date.now() + 3600_000);
    d.setSeconds(0, 0);
    return { action: 'reboot', at: new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16) };
  });

  const run = async (fn: () => Promise<unknown>) => {
    setError('');
    setMsg('');
    try {
      await fn();
      setMsg(t('power.sent'));
      void reload();
    } catch (e) {
      if (!(e instanceof ApiError && e.code === 'confirm_required')) setError(t('common.error'));
    }
  };

  const now = async (action: 'reboot' | 'poweroff' | 'suspend') => {
    const ok = await ask({
      title: t(`power.${action}Title` as MessageKey),
      body: t(`power.${action}Body` as MessageKey),
      confirmLabel: t(`power.${action}` as MessageKey),
      danger: true,
    });
    if (ok) await run(() => api(`/api/power/${action}`, { body: {} }));
  };

  const schedule = async () => {
    const at = new Date(sched.at).getTime();
    const ok = await ask({
      title: t('power.scheduled', { action: t(`power.${sched.action}` as MessageKey), when: new Date(at).toLocaleString(intl) }),
      confirmLabel: t('power.scheduleSet'),
    });
    if (ok) await run(() => api('/api/power/schedule', { body: { action: sched.action, at } }));
  };

  const s = data?.scheduled;
  return (
    <>
      <PageHeader title={t('power.title')} back="/settings" />
      <main className="safe-bottom mx-auto max-w-md space-y-4 px-3">
        <div className="grid grid-cols-3 gap-3">
          <Button variant="secondary" className="min-h-20 flex-col text-sm" onClick={() => void now('reboot')}>
            <ArrowReset24Filled aria-hidden />
            {t('power.reboot')}
          </Button>
          <Button variant="secondary" className="min-h-20 flex-col text-sm" onClick={() => void now('suspend')}>
            <WeatherMoon24Filled aria-hidden />
            {t('power.suspend')}
          </Button>
          <Button variant="danger" className="min-h-20 flex-col text-sm" onClick={() => void now('poweroff')}>
            <Power24Regular aria-hidden />
            {t('power.poweroff')}
          </Button>
        </div>
        <Card title={t('power.schedule')}>
          {s ? (
            <div className="space-y-3">
              <p className="text-sm text-ink">{t('power.scheduled', { action: s.action, when: new Date(s.at).toLocaleString(intl) })}</p>
              <Button variant="secondary" className="w-full" onClick={() => void run(() => api('/api/power/schedule', { method: 'DELETE' }))}>
                {t('power.cancel')}
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-xs text-muted">{t('power.nothingScheduled')}</p>
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-ink">{t('power.scheduleAction')}</span>
                <select
                  value={sched.action}
                  onChange={(e) => setSched({ ...sched, action: e.target.value as 'reboot' })}
                  className="block min-h-12 w-full rounded-xl border border-line bg-surface px-3 text-base text-ink"
                >
                  <option value="reboot">{t('power.reboot')}</option>
                  <option value="poweroff">{t('power.poweroff')}</option>
                </select>
              </label>
              <TextField label={t('power.scheduleAt')} type="datetime-local" value={sched.at} onChange={(e) => setSched({ ...sched, at: e.target.value })} />
              <Button className="w-full" onClick={() => void schedule()}>
                {t('power.scheduleSet')}
              </Button>
            </div>
          )}
        </Card>
        {msg && (
          <p className="text-sm text-ok" role="status">
            {msg}
          </p>
        )}
        <ErrorText>{error}</ErrorText>
      </main>
    </>
  );
}

function urlBase64ToUint8Array(b64: string) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

interface NotifyState {
  settings: { push: boolean; whatsapp: { enabled: boolean; to: string }; diskThreshold: number };
  vapidPublicKey: string;
  alerts: { key: string; title: string; detail: string; severity: string }[];
}

export function NotificationSettings() {
  const { t } = useI18n();
  const [s, setS] = useState<NotifyState | null>(null);
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  useEffect(() => {
    api<NotifyState>('/api/notify').then(setS);
    if (supported)
      navigator.serviceWorker.getRegistration().then(async (r) => setSubscribed(!!(await r?.pushManager.getSubscription())));
  }, [supported]);

  const enablePush = async () => {
    setError('');
    try {
      if ((await Notification.requestPermission()) !== 'granted') return setError(t('notify.denied'));
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(s!.vapidPublicKey) });
      await api('/api/notify/subscribe', { body: sub.toJSON() });
      setSubscribed(true);
    } catch {
      setError(t('common.error'));
    }
  };

  const save = async () => {
    setError('');
    try {
      await api('/api/notify', { method: 'PUT', body: s!.settings });
      setMsg(t('notify.saved'));
    } catch {
      setError(t('common.error'));
    }
  };

  if (!s) return <PageHeader title={t('settings.notifications')} back="/settings" />;
  const set = (patch: Partial<NotifyState['settings']>) => setS({ ...s, settings: { ...s.settings, ...patch } });

  return (
    <>
      <PageHeader title={t('settings.notifications')} back="/settings" />
      <main className="safe-bottom mx-auto max-w-md space-y-4 px-3">
        {s.alerts.length > 0 && (
          <Card title={t('notify.alerts')}>
            <ul className="space-y-2">
              {s.alerts.map((a) => (
                <li key={a.key}>
                  <p className={`text-sm font-medium ${a.severity === 'critical' ? 'text-danger' : 'text-warn'}`}>{a.title}</p>
                  <p className="text-xs text-muted">{a.detail}</p>
                </li>
              ))}
            </ul>
          </Card>
        )}
        <Card title={t('notify.push')}>
          <p className="mb-3 text-xs text-muted">{t('notify.pushHint')}</p>
          {!supported ? (
            <p className="text-sm text-muted">{t('notify.unsupported')}</p>
          ) : subscribed ? (
            <p className="text-sm text-ok">{t('notify.enabled')}</p>
          ) : (
            <Button className="w-full" onClick={() => void enablePush()}>
              {t('notify.enable')}
            </Button>
          )}
        </Card>
        <Card title={t('notify.whatsapp')}>
          <p className="mb-3 text-xs text-muted">{t('notify.whatsappHint')}</p>
          <label className="mb-3 flex items-center gap-3">
            <input type="checkbox" className="size-5 accent-[var(--color-primary)]" checked={s.settings.whatsapp.enabled} onChange={(e) => set({ whatsapp: { ...s.settings.whatsapp, enabled: e.target.checked } })} />
            <span className="text-sm text-ink">{t('notify.enable')}</span>
          </label>
          <TextField label={t('notify.whatsappTo')} type="tel" dir="ltr" inputMode="tel" value={s.settings.whatsapp.to} onChange={(e) => set({ whatsapp: { ...s.settings.whatsapp, to: e.target.value } })} />
        </Card>
        <Card>
          <label className="block">
            <span className="mb-2 block text-sm text-ink">{t('notify.diskThreshold', { pct: s.settings.diskThreshold })}</span>
            <input type="range" min={50} max={99} value={s.settings.diskThreshold} onChange={(e) => set({ diskThreshold: Number(e.target.value) })} className="w-full accent-[var(--color-primary)]" />
          </label>
        </Card>
        <div className="grid grid-cols-2 gap-3">
          <Button variant="secondary" onClick={() => void api('/api/notify/test', { body: {} }).then(() => setMsg('✓'))}>
            {t('notify.test')}
          </Button>
          <Button onClick={() => void save()}>{t('notify.save')}</Button>
        </div>
        {msg && (
          <p className="text-sm text-ok" role="status">
            {msg}
          </p>
        )}
        <ErrorText>{error}</ErrorText>
      </main>
    </>
  );
}
