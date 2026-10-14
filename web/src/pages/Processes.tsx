import { memo, useDeferredValue, useEffect, useState } from 'react';
import { Link, useSearch } from 'wouter';
import { Search20Regular } from '@fluentui/react-icons';
import { useProcesses, type GroupRow, type ProcRow, type ProcView } from '../lib/live';
import { formatBytes, formatDuration } from '../lib/format';
import { useI18n, type MessageKey } from '../i18n';
import { PageHeader } from '../components/ui';
import { VirtualList } from '../components/VirtualList';

const ROW_H = 60;
const SORTS: ProcView['sort'][] = ['cpu', 'rss', 'name', 'pid'];

const ProcItem = memo(function ProcItem({ r, now }: { r: ProcRow; now: number }) {
  const [pid, name, user, , cpu, rss, , started] = r;
  return (
    <Link href={`/processes/${pid}`} className="flex h-full items-center gap-3 border-b border-line px-4 active:bg-primary-soft">
      <div className="min-w-0 flex-1">
        <p dir="auto" className="truncate text-start text-[0.95rem] font-medium text-ink">
          {name}
        </p>
        <p className="truncate text-xs text-muted tabular-nums">
          {pid} · {user} · {formatDuration((now - started) / 1000)}
        </p>
      </div>
      <div className="w-16 text-end tabular-nums">
        <p className={`text-sm font-semibold ${cpu >= 50 ? 'text-danger' : cpu >= 10 ? 'text-warn' : 'text-ink'}`}>{cpu.toFixed(1)}%</p>
        <p className="text-xs text-muted">{formatBytes(rss, 0)}</p>
      </div>
    </Link>
  );
});

const GroupItem = memo(function GroupItem({ r, onOpen }: { r: GroupRow; onOpen: (key: string) => void }) {
  const { t, tn } = useI18n();
  const [key, label, kind, count, cpu, rss] = r;
  return (
    <button
      type="button"
      onClick={() => onOpen(key)}
      className="flex h-full w-full items-center gap-3 border-b border-line px-4 text-start active:bg-primary-soft"
    >
      <div className="min-w-0 flex-1">
        <p dir="auto" className="truncate text-start text-[0.95rem] font-medium text-ink">
          {label}
        </p>
        <p className="truncate text-xs text-muted">
          {t(`procs.group.${kind}` as MessageKey)} · {tn('procs.groupCount', count)}
        </p>
      </div>
      <div className="w-16 text-end tabular-nums">
        <p className="text-sm font-semibold text-ink">{cpu.toFixed(1)}%</p>
        <p className="text-xs text-muted">{formatBytes(rss, 0)}</p>
      </div>
    </button>
  );
});

export function Processes() {
  const { t } = useI18n();
  const params = new URLSearchParams(useSearch());
  const [q, setQ] = useState(params.get('q') ?? '');
  const [sort, setSort] = useState<ProcView['sort']>(() => (['cpu', 'rss', 'name', 'pid'].includes(params.get('sort') ?? '') ? (params.get('sort') as ProcView['sort']) : 'cpu'));
  const [mode, setMode] = useState<ProcView['mode']>('list');
  const query = useDeferredValue(q);
  const { rows, total, mode: shownMode } = useProcesses({ sort, q: query, mode });

  // Refresh "running for" once per tick without re-rendering rows that did not change.
  const [now, setNow] = useState(Date.now());
  useEffect(() => setNow(Date.now()), [rows]);

  const chip = (active: boolean) => `min-h-9 shrink-0 rounded-full px-3 text-sm ${active ? 'bg-primary text-white' : 'bg-surface text-ink shadow-card'}`;

  return (
    <>
      <PageHeader title={t('monitor.processes')} back="/monitor">
        <div className="space-y-2">
          <label className="flex min-h-11 items-center gap-2 rounded-xl bg-surface px-3 shadow-card">
            <Search20Regular className="text-muted" aria-hidden />
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t('procs.search')}
              aria-label={t('procs.search')}
              className="min-w-0 flex-1 bg-transparent text-base text-ink outline-none"
              autoCapitalize="off"
              autoCorrect="off"
            />
          </label>
          <div className="flex items-center gap-2 overflow-x-auto pb-1" role="toolbar" aria-label={t('procs.sort')}>
            {(['list', 'group'] as const).map((m) => (
              <button key={m} type="button" className={chip(mode === m)} aria-pressed={mode === m} onClick={() => setMode(m)}>
                {t(`procs.mode.${m}`)}
              </button>
            ))}
            <span className="mx-1 h-5 w-px shrink-0 bg-line" aria-hidden />
            {SORTS.filter((s) => mode === 'list' || s !== 'pid').map((s) => (
              <button key={s} type="button" className={chip(sort === s)} aria-pressed={sort === s} onClick={() => setSort(s)}>
                {t(`procs.sort.${s}`)}
              </button>
            ))}
          </div>
          <p className="px-1 text-xs text-muted" aria-live="polite">
            {t('procs.count', { shown: rows.length, total })}
          </p>
        </div>
      </PageHeader>
      <main className="safe-bottom mx-auto max-w-md px-3">
        <div className="overflow-hidden rounded-list bg-surface shadow-card">
          {rows.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted">{t('procs.empty')}</p>
          ) : shownMode === 'group' ? (
            <VirtualList
              items={rows as GroupRow[]}
              rowHeight={ROW_H}
              getKey={(r) => r[0]}
              render={(r) => (
                <GroupItem
                  r={r}
                  onOpen={(key) => {
                    setMode('list');
                    setQ(key);
                  }}
                />
              )}
            />
          ) : (
            <VirtualList items={rows as ProcRow[]} rowHeight={ROW_H} getKey={(r) => r[0]} render={(r) => <ProcItem r={r} now={now} />} />
          )}
        </div>
      </main>
    </>
  );
}
