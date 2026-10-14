import { useState } from 'react';
import { Link } from 'wouter';
import { api } from '../lib/api';
import { formatDuration } from '../lib/format';
import { usePoll } from '../lib/usePoll';
import { useI18n, type MessageKey } from '../i18n';
import { Button, Card, PageHeader } from '../components/ui';

/** Server health: every check the server runs, grouped, each with what to do about it (or a button that does it). */
type Level = 'ok' | 'warning' | 'critical';
interface Check {
  id: string;
  group: string;
  level: Level;
  title: string;
  detail?: string;
  fix?: { kind: 'link'; href: string } | { kind: 'action'; action: string; arg?: string };
}
const DOT: Record<Level, string> = { ok: 'bg-ok', warning: 'bg-amber-400', critical: 'bg-danger' };
const GROUPS = ['storage', 'disks', 'heat', 'memory', 'apps', 'services', 'updates', 'backup', 'security', 'system'];

export function Health() {
  const { t } = useI18n();
  const { data, reload } = usePoll<{ checks: Check[]; worst: Level; uptimeSec: number }>('/api/health/checks', 15_000);
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (c: Check) => {
    if (c.fix?.kind !== 'action') return;
    setBusy(c.id);
    await api('/api/health/fix', { method: 'POST', body: { action: c.fix.action, arg: c.fix.arg } }).catch(() => null);
    setBusy(null);
    void reload();
  };
  const bad = data?.checks.filter((c) => c.level !== 'ok').length ?? 0;
  return (
    <>
      <PageHeader title={t('section.health')} back="/" />
      <main className="safe-bottom mx-auto max-w-3xl space-y-3 px-3">
        <Card>
          <div className="flex items-center gap-3">
            <span className={`size-4 rounded-full ${DOT[data?.worst ?? 'ok']}`} aria-hidden />
            <div className="flex-1">
              <p className="text-lg font-semibold text-heading">{!data ? '…' : bad ? t('health.issues', { n: bad }) : t('health.allGood')}</p>
              {data && <p className="text-sm text-muted">{t('health.uptime', { time: formatDuration(data.uptimeSec) })}</p>}
            </div>
          </div>
        </Card>
        {GROUPS.map((g) => {
          const list = data?.checks.filter((c) => c.group === g) ?? [];
          if (!list.length) return null;
          return (
            <Card key={g} title={t(`health.group.${g}` as MessageKey)}>
              <ul className="divide-y divide-line">
                {list.map((c) => (
                  <li key={c.id} className="flex items-center gap-3 py-2">
                    <span className={`size-2.5 shrink-0 rounded-full ${DOT[c.level]}`} aria-hidden />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-ink" dir="auto">
                        {c.title}
                      </p>
                      {c.detail && (
                        <p className="truncate text-xs text-muted" dir="auto">
                          {c.detail}
                        </p>
                      )}
                    </div>
                    {c.fix?.kind === 'link' && c.level !== 'ok' && (
                      <Link href={c.fix.href} className="shrink-0 text-sm text-primary">
                        {t('health.open')}
                      </Link>
                    )}
                    {c.fix?.kind === 'action' && (
                      <Button variant="secondary" className="min-h-9 shrink-0 px-3 text-xs" disabled={busy !== null} onClick={() => void run(c)}>
                        {busy === c.id ? '…' : t(`health.fix.${c.fix.action}` as MessageKey, { size: c.fix.arg ?? '' })}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          );
        })}
      </main>
    </>
  );
}
