import { useEffect, useState } from 'react';
import { HardDrive24Filled } from '@fluentui/react-icons';
import { ApiError, api } from '../lib/api';
import { formatBytes, formatTemp } from '../lib/format';
import { useI18n } from '../i18n';
import { Bar } from '../components/meters';
import { Button, Card, IconBadge, PageHeader } from '../components/ui';
import { DiskHealthCard } from '../components/DiskHealthCard';

interface Mount {
  device: string;
  mount: string;
  fstype: string;
  size: number;
  used: number;
  avail: number;
}
interface Disk {
  name: string;
  path: string;
  model: string | null;
  size: number;
  rotational: boolean;
  transport: string | null;
  partitions: { name: string; size: number; fstype: string | null; mountpoints: string[] }[];
}
interface Smart {
  passed: boolean | null;
  temperature: number | null;
  powerOnHours: number | null;
  powerCycles: number | null;
  attributes: { id: number; name: string; value: number; thresh: number; raw: string; failed: string | null }[];
}

function SmartBlock({ disk }: { disk: Disk }) {
  const { t, formatNumber } = useI18n();
  const [smart, setSmart] = useState<Smart | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const load = async () => {
    setBusy(true);
    setErr('');
    try {
      setSmart(await api<Smart>(`/api/disks/${disk.name}/smart`));
    } catch (e) {
      setErr(e instanceof ApiError && e.code === 'smartctl_missing' ? t('disks.smartMissing') : t('disks.helperMissing'));
    } finally {
      setBusy(false);
    }
  };
  if (!smart)
    return (
      <div className="mt-3">
        {err ? (
          <p className="text-xs text-muted">{err}</p>
        ) : (
          <Button variant="secondary" className="min-h-10 w-full text-sm" disabled={busy} onClick={() => void load()}>
            {t('disks.loadSmart')}
          </Button>
        )}
      </div>
    );
  return (
    <div className="mt-3 space-y-2 text-sm">
      <p className={`font-medium ${smart.passed === false ? 'text-danger' : smart.passed ? 'text-ok' : 'text-muted'}`}>
        {t('disks.smart')}: {smart.passed === null ? t('disks.unknown') : smart.passed ? t('disks.healthy') : t('disks.failing')}
      </p>
      <div className="grid grid-cols-3 gap-2 text-xs">
        <span>
          <span className="block text-muted">{t('disks.temp')}</span>
          {formatTemp(smart.temperature)}
        </span>
        <span>
          <span className="block text-muted">{t('disks.hours')}</span>
          {smart.powerOnHours === null ? '—' : formatNumber(smart.powerOnHours)}
        </span>
        <span>
          <span className="block text-muted">{t('disks.cycles')}</span>
          {smart.powerCycles === null ? '—' : formatNumber(smart.powerCycles)}
        </span>
      </div>
      {smart.attributes.length > 0 && (
        <details>
          <summary className="cursor-pointer text-xs text-primary-ink">{t('disks.attributes')}</summary>
          <table className="mt-2 w-full text-[11px] tabular-nums" dir="ltr">
            <tbody>
              {smart.attributes.map((a) => (
                <tr key={a.id} className={a.failed ? 'text-danger' : 'text-ink'}>
                  <td className="pe-2 text-muted">{a.id}</td>
                  <td className="pe-2">{a.name}</td>
                  <td className="pe-2">{a.value}</td>
                  <td className="text-end">{a.raw}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}

export function Disks() {
  const { t } = useI18n();
  const [data, setData] = useState<{ mounts: Mount[]; disks: Disk[] } | null>(null);
  useEffect(() => {
    api<{ mounts: Mount[]; disks: Disk[] }>('/api/storage').then(setData);
  }, []);

  return (
    <>
      <PageHeader title={t('disks.title')} back="/" />
      <main className="safe-bottom mx-auto max-w-md space-y-4 px-3">
        <DiskHealthCard />
        {data?.mounts.map((m) => {
          const pct = m.size ? (m.used / m.size) * 100 : 0;
          return (
            <Card key={m.device}>
              <div className="mb-2 flex items-baseline justify-between gap-2">
                <span className="font-semibold text-heading" dir="ltr">
                  {m.mount}
                </span>
                <span className="text-xs tabular-nums text-muted">
                  {formatBytes(m.used)} / {formatBytes(m.size)}
                </span>
              </div>
              <Bar value={pct} />
              <p className="mt-1 text-xs text-muted" dir="ltr">
                {m.device} · {m.fstype}
              </p>
            </Card>
          );
        })}
        {data?.disks.map((d) => (
          <Card key={d.name}>
            <div className="flex items-center gap-3">
              <IconBadge icon={HardDrive24Filled} color={d.transport === 'usb' ? 'orange' : 'slate'} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-ink">{d.model ?? d.name}</p>
                <p className="text-xs text-muted" dir="ltr">
                  {d.path} · {formatBytes(d.size)} · {d.transport === 'usb' ? 'USB' : `${d.transport ?? ''} ${d.rotational ? 'HDD' : 'SSD'}`}
                </p>
              </div>
            </div>
            {d.partitions.length > 0 && (
              <ul className="mt-3 space-y-1 text-xs">
                {d.partitions.map((p) => (
                  <li key={p.name} className="flex justify-between gap-2">
                    <span className="text-ink" dir="ltr">
                      {p.name} {p.fstype && <span className="text-muted">({p.fstype})</span>}
                    </span>
                    <span className="truncate text-muted">
                      {formatBytes(p.size)} · {p.mountpoints.length ? t('disks.mounted', { at: p.mountpoints.join(', ') }) : t('disks.notMounted')}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <SmartBlock disk={d} />
          </Card>
        ))}
      </main>
    </>
  );
}
