import { useState } from 'react';
import { api } from '../lib/api';
import { usePoll } from '../lib/usePoll';
import { useI18n } from '../i18n';
import { Button, Card, PageHeader } from '../components/ui';

/** Home network: connected devices (name them), new-device alerts, AdGuard's blocking, internet speed over time. */
interface Device {
  mac: string;
  ip: string;
  firstSeen: number;
  lastSeen: number;
  vendor: string | null;
  host: string | null;
  name?: string;
  privateMac: boolean;
}
interface Speed {
  at: number;
  ping: number;
  downMbps: number;
  upMbps: number;
}
interface Data {
  devices: Device[];
  adguard: { queries: number; blocked: number; topBlocked: { name: string; n: number }[]; topClients: { name: string; n: number }[] } | null;
  speeds: Speed[];
  tailscale: { name: string; os: string; online: boolean; ip: string }[];
  lan: { ip: string; prefix: string } | null;
  scanning: boolean;
}

export function Network() {
  const { t, formatRelative } = useI18n();
  const { data, reload } = usePoll<Data>('/api/network', 30_000);
  const [busy, setBusy] = useState<'scan' | 'speed' | null>(null);
  const [edit, setEdit] = useState<string | null>(null);
  const [name, setName] = useState('');
  const act = async (what: 'scan' | 'speed') => {
    setBusy(what);
    await api(`/api/network/${what}`, { method: 'POST', body: {} }).catch(() => null);
    setBusy(null);
    void reload();
  };
  const online = (d: Device) => Date.now() - d.lastSeen < 20 * 60_000;
  const list = data?.devices ?? [];
  const last = data?.speeds.at(-1);
  const maxDown = Math.max(1, ...(data?.speeds ?? []).map((s) => s.downMbps));
  return (
    <>
      <PageHeader title={t('net.title')} back="/" />
      <main className="safe-bottom mx-auto max-w-3xl space-y-3 px-3">
        <Card title={t('net.speed')} action={<Button variant="secondary" className="min-h-9 px-3 text-sm" disabled={busy !== null} onClick={() => void act('speed')}>{busy === 'speed' ? '…' : t('net.testNow')}</Button>}>
          {last ? (
            <div className="grid grid-cols-3 gap-2 text-center">
              <Big label={t('net.down')} value={`${last.downMbps}`} unit="Mbps" />
              <Big label={t('net.up')} value={`${last.upMbps}`} unit="Mbps" />
              <Big label={t('net.ping')} value={`${last.ping}`} unit="ms" />
            </div>
          ) : (
            <p className="text-sm text-muted">{t('net.noSpeed')}</p>
          )}
          {(data?.speeds.length ?? 0) > 1 && (
            <div className="mt-3 flex h-16 items-end gap-0.5" aria-label={t('net.history')}>
              {data!.speeds.slice(-60).map((s) => (
                <div key={s.at} title={`${new Date(s.at).toLocaleString()} · ${s.downMbps} Mbps`} className="flex-1 rounded-t bg-primary/70" style={{ height: `${Math.max(4, (s.downMbps / maxDown) * 100)}%` }} />
              ))}
            </div>
          )}
          {last && <p className="mt-1 text-xs text-muted">{t('net.measured', { when: formatRelative(last.at) })}</p>}
        </Card>

        <Card
          title={t('net.devices', { n: list.filter(online).length })}
          action={<Button variant="secondary" className="min-h-9 px-3 text-sm" disabled={busy !== null || data?.scanning} onClick={() => void act('scan')}>{busy === 'scan' || data?.scanning ? '…' : t('net.scan')}</Button>}
        >
          <ul className="divide-y divide-line">
            {list.map((d) => (
              <li key={d.mac} className="flex items-center gap-3 py-2">
                <span className={`size-2.5 shrink-0 rounded-full ${online(d) ? 'bg-ok' : 'bg-line'}`} aria-hidden />
                <div className="min-w-0 flex-1">
                  {edit === d.mac ? (
                    <form
                      className="flex gap-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void api('/api/network/name', { method: 'POST', body: { mac: d.mac, name } }).then(() => {
                          setEdit(null);
                          void reload();
                        });
                      }}
                    >
                      <input autoFocus value={name} onChange={(e) => setName(e.target.value)} className="min-h-9 flex-1 rounded-lg border border-line bg-canvas px-2 text-sm" aria-label={t('net.rename')} />
                      <Button type="submit" className="min-h-9 px-3 text-sm">
                        {t('net.save')}
                      </Button>
                    </form>
                  ) : (
                    <button type="button" className="block w-full truncate text-start text-sm text-ink" onClick={() => (setEdit(d.mac), setName(d.name ?? d.host ?? ''))}>
                      {d.name ?? d.host ?? d.vendor ?? (d.privateMac ? t('net.privatePhone') : t('net.unknown'))}
                    </button>
                  )}
                  <p className="truncate text-xs text-muted" dir="ltr">
                    {d.ip} · {d.vendor ?? (d.privateMac ? 'private MAC' : d.mac)}
                  </p>
                </div>
                <span className="shrink-0 text-xs text-muted">{online(d) ? t('net.now') : formatRelative(d.lastSeen)}</span>
              </li>
            ))}
            {!list.length && <li className="py-3 text-center text-sm text-muted">{t('net.firstScan')}</li>}
          </ul>
          <p className="mt-2 text-xs text-muted">{t('net.alertHint')}</p>
        </Card>

        {data?.adguard && (
          <Card title={t('net.adguard')}>
            <div className="grid grid-cols-2 gap-2 text-center">
              <Big label={t('net.queries')} value={data.adguard.queries.toLocaleString()} />
              <Big label={t('net.blocked')} value={`${Math.round((data.adguard.blocked / Math.max(1, data.adguard.queries)) * 100)}%`} unit={data.adguard.blocked.toLocaleString()} />
            </div>
            <div className="mt-3 grid min-w-0 gap-3 sm:grid-cols-2">
              <TopList title={t('net.topBlocked')} rows={data.adguard.topBlocked} />
              <TopList title={t('net.topClients')} rows={data.adguard.topClients} />
            </div>
          </Card>
        )}

        {(data?.tailscale.length ?? 0) > 0 && (
          <Card title={t('net.away')}>
            <ul className="divide-y divide-line text-sm">
              {data!.tailscale.map((p) => (
                <li key={p.ip} className="flex items-center gap-3 py-1.5">
                  <span className={`size-2.5 rounded-full ${p.online ? 'bg-ok' : 'bg-line'}`} aria-hidden />
                  <span className="flex-1 truncate">{p.name}</span>
                  <span className="text-xs text-muted">{p.os}</span>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </main>
    </>
  );
}

function Big({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="rounded-xl bg-canvas p-2">
      <p className="text-xs text-muted">{label}</p>
      <p className="text-xl font-semibold text-heading" dir="ltr">
        {value}
      </p>
      {unit && (
        <p className="text-[11px] text-muted" dir="ltr">
          {unit}
        </p>
      )}
    </div>
  );
}

function TopList({ title, rows }: { title: string; rows: { name: string; n: number }[] }) {
  return (
    <div className="min-w-0">
      <p className="mb-1 text-xs font-medium text-muted">{title}</p>
      <ul className="space-y-0.5 text-sm">
        {rows.map((r) => (
          <li key={r.name} className="flex min-w-0 gap-2">
            <span className="min-w-0 flex-1 truncate" dir="ltr">
              {r.name}
            </span>
            <span className="text-xs text-muted">{r.n.toLocaleString()}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
