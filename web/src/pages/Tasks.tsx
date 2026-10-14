import { useEffect, useRef, useState } from 'react';
import { Link } from 'wouter';
import { usePoll } from '../lib/usePoll';
import { formatDuration } from '../lib/format';
import { useI18n, type MessageKey } from '../i18n';
import { Card, PageHeader } from '../components/ui';

type Status = 'queued' | 'running' | 'failed' | 'succeeded';
interface Task {
  id: number;
  title: string;
  status: Status;
  progress: string | null;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  log?: string;
}

const DOT: Record<Status, string> = { queued: 'bg-muted', running: 'bg-primary animate-pulse', failed: 'bg-danger', succeeded: 'bg-ok' };

export function Tasks() {
  const { t, formatRelative } = useI18n();
  const [tab, setTab] = useState<Status | null>(null);
  const { data } = usePoll<{ counts: Partial<Record<Status, number>>; tasks: Task[] }>(`/api/tasks${tab ? `?status=${tab}` : ''}`, 3000);
  const tabs: (Status | null)[] = [null, 'queued', 'running', 'failed', 'succeeded'];

  return (
    <>
      <PageHeader title={t('tasks.title')} back="/">
        <div className="-mx-3 flex gap-1 overflow-x-auto px-3 py-0.5" role="tablist">
          {tabs.map((s) => {
            const n = s ? (data?.counts[s] ?? 0) : Object.values(data?.counts ?? {}).reduce((a, b) => a + (b ?? 0), 0);
            return (
              <button
                key={s ?? 'all'}
                type="button"
                role="tab"
                aria-selected={tab === s}
                onClick={() => setTab(s)}
                className={`min-h-9 shrink-0 rounded-full px-3 text-sm ${tab === s ? 'bg-primary text-white' : 'bg-surface text-ink shadow-card'}`}
              >
                {t(s ? (`tasks.${s}` as MessageKey) : 'tasks.all')} {n > 0 && <span className="opacity-70">{n}</span>}
              </button>
            );
          })}
        </div>
      </PageHeader>
      <main className="safe-bottom mx-auto max-w-md space-y-3 px-3">
        <ul className="overflow-hidden rounded-list bg-surface shadow-card">
          {data?.tasks.length === 0 && <li className="p-6 text-center text-sm text-muted">{t('tasks.empty')}</li>}
          {data?.tasks.map((task) => (
            <li key={task.id} className="border-line [&+&]:border-t">
              <Link href={`/tasks/${task.id}`} className="flex items-center gap-3 px-4 py-3 active:bg-primary-soft">
                <span className={`size-2.5 shrink-0 rounded-full ${DOT[task.status]}`} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[0.95rem] text-ink">{task.title}</span>
                  <span className="block truncate text-xs text-muted">
                    {t(`tasks.${task.status}` as MessageKey)} · {formatRelative(task.createdAt)}
                    {task.status === 'running' && task.progress ? ` · ${task.progress}` : ''}
                    {task.status === 'failed' && task.error ? ` · ${task.error}` : ''}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
        <p className="px-2 text-center text-xs text-muted">{t('tasks.retention')}</p>
      </main>
    </>
  );
}

export function TaskDetail({ params }: { params: { id: string } }) {
  const { t, formatRelative } = useI18n();
  const [done, setDone] = useState(false);
  const { data } = usePoll<Task>(`/api/tasks/${params.id}`, done ? 60_000 : 1500);
  const logRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (data && (data.status === 'failed' || data.status === 'succeeded')) setDone(true);
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [data]);

  return (
    <>
      <PageHeader title={data?.title ?? t('tasks.title')} back="/tasks" />
      <main className="safe-bottom mx-auto max-w-md space-y-3 px-3">
        {data && (
          <Card>
            <div className="flex items-center gap-2">
              <span className={`size-2.5 rounded-full ${DOT[data.status]}`} aria-hidden />
              <span className="font-medium text-heading">{t(`tasks.${data.status}` as MessageKey)}</span>
              {data.progress && data.status === 'running' && <span className="truncate text-sm text-muted">· {data.progress}</span>}
            </div>
            <p className="mt-1 text-xs text-muted">
              {data.startedAt && t('tasks.started', { when: formatRelative(data.startedAt) })}
              {data.startedAt && data.finishedAt && ` · ${t('tasks.duration', { d: formatDuration((data.finishedAt - data.startedAt) / 1000) })}`}
            </p>
            {data.error && <p className="mt-2 text-sm text-danger">{data.error}</p>}
          </Card>
        )}
        <Card title={t('tasks.log')}>
          <pre
            ref={logRef}
            dir="ltr"
            className="max-h-[60dvh] overflow-auto whitespace-pre-wrap break-all rounded-lg bg-canvas p-3 font-mono text-[11px] leading-snug text-ink"
          >
            {data?.log || '…'}
          </pre>
        </Card>
      </main>
    </>
  );
}
