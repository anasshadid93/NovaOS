import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { CheckmarkCircle20Filled, Dismiss16Regular, DismissCircle20Filled, Info20Filled, Warning20Filled } from '@fluentui/react-icons';
import { api } from '../lib/api';
import { useI18n } from '../i18n';
import { TASKBAR_H, wm } from './wm';

/**
 * Desktop notifications: server alerts (disk, temperature, failed services…) and background
 * tasks that finished (installs, updates…). New ones pop up in the corner; the bell keeps the list.
 */

export interface Note {
  id: string;
  kind: 'alert' | 'task';
  tone: 'ok' | 'warn' | 'error' | 'info';
  title: string;
  detail?: string;
  at: number;
  read: boolean;
  /** Task id to open, if any. */
  task?: number;
}

const KEY = 'manar.desktop.notes';
const listeners = new Set<() => void>();
let notes: Note[] = (() => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]') as Note[];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
})();
let toasts: Note[] = [];

const emit = () => {
  localStorage.setItem(KEY, JSON.stringify(notes.slice(0, 50)));
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const notifications = {
  push(n: Omit<Note, 'at' | 'read'>) {
    if (notes.some((x) => x.id === n.id)) return;
    const note: Note = { ...n, at: Date.now(), read: false };
    notes = [note, ...notes].slice(0, 50);
    toasts = [note, ...toasts].slice(0, 3);
    emit();
    setTimeout(() => notifications.dropToast(note.id), 7000);
  },
  dropToast(id: string) {
    toasts = toasts.filter((t) => t.id !== id);
    emit();
  },
  clearToasts() {
    toasts = [];
    emit();
  },
  readAll() {
    notes = notes.map((n) => ({ ...n, read: true }));
    emit();
  },
  remove(id: string) {
    notes = notes.filter((n) => n.id !== id);
    emit();
  },
  clear() {
    notes = [];
    emit();
  },
};

export const useNotes = () => useSyncExternalStore(subscribe, () => notes);
const useToasts = () => useSyncExternalStore(subscribe, () => toasts);

interface Alert {
  key: string;
  severity: 'warning' | 'critical';
  title: string;
  detail: string;
}
interface Task {
  id: number;
  title: string;
  status: 'queued' | 'running' | 'failed' | 'succeeded';
  error: string | null;
  finishedAt: number | null;
}

/** Watches the server and turns changes into notifications. The first look only sets a baseline. */
export function useNotificationFeed() {
  const { t } = useI18n();
  const seenAlerts = useRef<Set<string> | null>(null);
  const seenTasks = useRef<Map<number, string> | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const [home, tasks] = await Promise.all([api<{ alerts: Alert[] }>('/api/home'), api<{ tasks: Task[] }>('/api/tasks')]);
        if (!alive) return;
        // Alerts: a new key is a new problem; one that went away can come back later.
        const now = new Set(home.alerts.map((a) => a.key));
        if (seenAlerts.current)
          for (const a of home.alerts)
            if (!seenAlerts.current.has(a.key)) notifications.push({ id: `alert:${a.key}:${Date.now()}`, kind: 'alert', tone: a.severity === 'critical' ? 'error' : 'warn', title: a.title, detail: a.detail });
        seenAlerts.current = now;
        // Tasks: report the moment one finishes.
        const prev = seenTasks.current;
        const next = new Map(tasks.tasks.map((x) => [x.id, x.status]));
        if (prev)
          for (const x of tasks.tasks) {
            const was = prev.get(x.id);
            if ((x.status === 'succeeded' || x.status === 'failed') && was !== x.status && (was === 'queued' || was === 'running' || was === undefined))
              notifications.push({
                id: `task:${x.id}:${x.status}`,
                kind: 'task',
                tone: x.status === 'succeeded' ? 'ok' : 'error',
                title: x.title,
                detail: x.status === 'succeeded' ? t('notes.taskDone') : (x.error ?? t('notes.taskFailed')),
                task: x.id,
              });
          }
        seenTasks.current = next;
      } catch {
        /* offline for a moment */
      }
    };
    void tick();
    const id = setInterval(() => void tick(), 10_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [t]);
}

const TONE = {
  ok: { icon: CheckmarkCircle20Filled, cls: 'text-ok' },
  warn: { icon: Warning20Filled, cls: 'text-warn' },
  error: { icon: DismissCircle20Filled, cls: 'text-danger' },
  info: { icon: Info20Filled, cls: 'text-primary' },
} as const;

type T = ReturnType<typeof useI18n>['t'];
/** A task opens its log; an alert opens the alert settings. */
function openNote(n: Note, t: T) {
  if (n.task) wm.open({ app: 'tasks', title: t('section.tasks'), route: `/tasks/${n.task}`, w: 720, h: 600, newWindow: true });
  else wm.open({ app: 'settings', title: t('section.settings'), route: '/settings/notifications', w: 760, h: 700 });
}

function NoteRow({ n, onOpen, onDismiss, compact }: { n: Note; onOpen: () => void; onDismiss: () => void; compact?: boolean }) {
  const { formatRelative } = useI18n();
  const T = TONE[n.tone];
  return (
    <div className={`group flex items-start gap-3 ${compact ? '' : 'rounded-xl px-3 py-2.5 hover:bg-black/5 dark:hover:bg-white/5'}`}>
      <T.icon className={`mt-0.5 shrink-0 ${T.cls}`} aria-hidden />
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-start">
        <span className={`block truncate text-sm ${n.read ? 'text-ink' : 'font-semibold text-heading'}`} dir="auto">
          {n.title}
        </span>
        {n.detail && (
          <span className="line-clamp-2 block text-xs text-muted" dir="auto">
            {n.detail}
          </span>
        )}
        <span className="block text-[11px] text-muted">{formatRelative(n.at)}</span>
      </button>
      <button type="button" onClick={onDismiss} className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted opacity-60 hover:bg-black/5 hover:opacity-100" aria-label="✕">
        <Dismiss16Regular aria-hidden />
      </button>
    </div>
  );
}

/** Pop-ups in the corner above the taskbar. */
export function Toasts() {
  const { t } = useI18n();
  const list = useToasts();
  return (
    <div className="pointer-events-none fixed end-3 z-[9996] flex w-80 flex-col gap-2" style={{ bottom: TASKBAR_H + 12 }} aria-live="polite">
      {list.map((n) => (
        <div key={n.id} className="toast-in pointer-events-auto rounded-2xl border border-line bg-surface/95 p-3 shadow-[0_12px_40px_rgb(15_23_42/0.25)] backdrop-blur-xl">
          <NoteRow
            compact
            n={n}
            onOpen={() => {
              notifications.dropToast(n.id);
              openNote(n, t);
            }}
            onDismiss={() => notifications.dropToast(n.id)}
          />
        </div>
      ))}
    </div>
  );
}

/** The bell's panel. */
export function NotificationPanel({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const list = useNotes();
  const [opened] = useState(() => Date.now());
  // The list replaces the pop-ups while it's open; closing it marks everything read.
  useEffect(() => {
    notifications.clearToasts();
    return () => notifications.readAll();
  }, [opened]);
  return (
    <>
      <div className="fixed inset-0 z-[9990]" onPointerDown={onClose} aria-hidden />
      <div
        role="dialog"
        aria-label={t('notes.title')}
        className="fixed end-2 z-[9991] flex max-h-[min(560px,calc(100%-100px))] w-96 max-w-[calc(100%-16px)] flex-col overflow-hidden rounded-2xl border border-line bg-surface/95 shadow-[0_24px_64px_rgb(15_23_42/0.30)] backdrop-blur-xl"
        style={{ bottom: TASKBAR_H + 8 }}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
      >
        <div className="flex items-center justify-between px-4 pb-2 pt-4">
          <h2 className="text-base font-semibold text-heading">{t('notes.title')}</h2>
          {list.length > 0 && (
            <button type="button" onClick={() => notifications.clear()} className="rounded-md px-2 py-1 text-xs text-primary-ink hover:bg-primary-soft">
              {t('notes.clearAll')}
            </button>
          )}
        </div>
        <div className="overflow-y-auto px-1 pb-2">
          {list.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-muted">{t('notes.empty')}</p>
          ) : (
            list.map((n) => (
              <NoteRow
                key={n.id}
                n={n}
                onOpen={() => {
                  onClose();
                  openNote(n, t);
                }}
                onDismiss={() => notifications.remove(n.id)}
              />
            ))
          )}
        </div>
      </div>
    </>
  );
}
