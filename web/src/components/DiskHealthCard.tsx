import { useEffect, useState } from 'react';
import { ArrowClockwise16Regular, CheckmarkCircle20Filled, DismissCircle20Filled, QuestionCircle20Filled, Warning20Filled } from '@fluentui/react-icons';
import { api } from '../lib/api';
import { formatBytes, formatTemp } from '../lib/format';
import { useI18n, type MessageKey } from '../i18n';
import { Card } from './ui';

type Health = 'good' | 'warning' | 'failing' | 'unknown';
interface DiskHealth {
  name: string;
  model: string | null;
  size: number;
  rotational: boolean;
  status: Health;
  reasons: { level: 'warning' | 'failing'; code: string; n?: number }[];
  temperature: number | null;
  powerOnHours: number | null;
  wearPct: number | null;
  checkedAt: number;
}

const BADGE: Record<Health, { icon: typeof CheckmarkCircle20Filled; cls: string }> = {
  good: { icon: CheckmarkCircle20Filled, cls: 'text-ok' },
  warning: { icon: Warning20Filled, cls: 'text-warn' },
  failing: { icon: DismissCircle20Filled, cls: 'text-danger' },
  unknown: { icon: QuestionCircle20Filled, cls: 'text-muted' },
};

/** SMART health of every disk, checked by the server every 6 hours; "Check now" runs it at once. */
export function DiskHealthCard() {
  const { t, formatRelative } = useI18n();
  const [list, setList] = useState<DiskHealth[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api<{ disks: DiskHealth[] }>('/api/disks/health').then((r) => setList(r.disks));
  }, []);
  const check = async () => {
    setBusy(true);
    try {
      setList((await api<{ disks: DiskHealth[] }>('/api/disks/health/check', { body: {} })).disks);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card
      title={t('health.title')}
      action={
        <button type="button" onClick={() => void check()} disabled={busy} className="inline-flex items-center gap-1 rounded-full px-3 py-1 text-sm text-primary-ink hover:bg-primary-soft disabled:opacity-50">
          <ArrowClockwise16Regular className={busy ? 'animate-spin' : ''} aria-hidden />
          {busy ? t('health.checking') : t('health.checkNow')}
        </button>
      }
    >
      {list === null ? (
        <p className="text-sm text-muted">{t('common.loading')}</p>
      ) : list.length === 0 ? (
        <p className="text-sm text-muted">{t('health.notYet')}</p>
      ) : (
        <ul className="space-y-3">
          {list.map((d) => {
            const B = BADGE[d.status];
            return (
              <li key={d.name} className={`rounded-xl p-3 ${d.status === 'failing' ? 'bg-danger/10' : d.status === 'warning' ? 'bg-warn/10' : 'bg-canvas'}`}>
                <div className="flex items-center gap-2">
                  <B.icon className={`shrink-0 ${B.cls}`} aria-hidden />
                  <span className="min-w-0 flex-1 truncate font-medium text-ink" dir="ltr">
                    {d.model ?? d.name} <span className="text-xs font-normal text-muted">({d.name} · {formatBytes(d.size)})</span>
                  </span>
                  <span className={`text-sm font-semibold ${B.cls}`}>{t(`health.${d.status}` as MessageKey)}</span>
                </div>
                {d.reasons.length > 0 && (
                  <ul className="mt-2 space-y-0.5 ps-7 text-sm text-ink">
                    {d.reasons.map((r, i) => (
                      <li key={i}>• {t(`health.r.${r.code}` as MessageKey, { n: r.n ?? '' })}</li>
                    ))}
                  </ul>
                )}
                {d.status === 'failing' && <p className="mt-2 ps-7 text-sm font-medium text-danger-ink">{t('health.backupNow')}</p>}
                <p className="mt-2 ps-7 text-xs text-muted">
                  {[d.temperature !== null ? formatTemp(d.temperature) : null, d.powerOnHours !== null ? t('health.hours', { n: d.powerOnHours.toLocaleString() }) : null, d.wearPct !== null ? t('health.wear', { n: d.wearPct }) : null, t('health.checked', { when: formatRelative(d.checkedAt) })].filter(Boolean).join(' · ')}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
