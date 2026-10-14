import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ArrowDown16Regular, ArrowUp16Regular } from '@fluentui/react-icons';
import { api } from '../lib/api';
import { useSystem } from '../lib/live';
import { thumbUrl } from '../lib/fm';
import { formatBytes, formatDuration, formatRate, formatTemp } from '../lib/format';
import { useI18n, type MessageKey } from '../i18n';
import { Ring } from '../components/meters';
import { deskApp, openDeskApp } from './apps';
import { TASKBAR_H, wm } from './wm';

/** Desktop widgets: small live cards on the side of the desktop, under the windows. */

export const WIDGETS = ['clock', 'system', 'network', 'storage', 'photos', 'apps'] as const;
export type WidgetId = (typeof WIDGETS)[number];
const DEFAULT: WidgetId[] = ['clock', 'system', 'storage', 'photos'];
const KEY = 'manar.desktop.widgets';
/** Width the widget column takes from the desktop (column + gaps), kept free of icons. */
export const WIDGET_SPACE = 300 + 24;

let enabled: WidgetId[] = (() => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as WidgetId[] | null;
    return Array.isArray(v) ? v.filter((x) => (WIDGETS as readonly string[]).includes(x)) : DEFAULT;
  } catch {
    return DEFAULT;
  }
})();
const listeners = new Set<() => void>();
const emit = (list: WidgetId[]) => {
  enabled = list;
  localStorage.setItem(KEY, JSON.stringify(list));
  listeners.forEach((l) => l());
};

export function setWidgets(list: WidgetId[]) {
  emit(list);
  void api('/api/desktop/prefs', { method: 'PUT', body: { widgets: list } }).catch(() => {});
}
export const toggleWidget = (id: WidgetId) => setWidgets(enabled.includes(id) ? enabled.filter((x) => x !== id) : WIDGETS.filter((x) => x === id || enabled.includes(x)));

export function useWidgets(): WidgetId[] {
  useEffect(() => {
    void api<{ widgets?: WidgetId[] }>('/api/desktop/prefs')
      .then((p) => Array.isArray(p.widgets) && JSON.stringify(p.widgets) !== JSON.stringify(enabled) && emit(p.widgets.filter((x) => (WIDGETS as readonly string[]).includes(x))))
      .catch(() => {});
  }, []);
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => enabled,
  );
}

export const widgetTitle: Record<WidgetId, MessageKey> = {
  clock: 'widget.clock',
  system: 'widget.system',
  network: 'widget.network',
  storage: 'widget.storage',
  photos: 'widget.photos',
  apps: 'widget.apps',
};

function Card({ title, onOpen, children }: { title?: string; onOpen?: () => void; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-white/50 bg-white/60 p-3.5 shadow-[0_8px_30px_rgb(15_23_42/0.12)] backdrop-blur-xl dark:border-white/10 dark:bg-[#0f1729]/60">
      {title && (
        <button type="button" onClick={onOpen} disabled={!onOpen} className="mb-2 block text-start text-xs font-semibold uppercase tracking-wide text-muted enabled:hover:text-primary-ink">
          {title}
        </button>
      )}
      {children}
    </section>
  );
}

function ClockWidget() {
  const { t, intl } = useI18n();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  const h = now.getHours();
  const greeting: MessageKey = h < 5 ? 'widget.night' : h < 12 ? 'widget.morning' : h < 18 ? 'widget.afternoon' : 'widget.evening';
  return (
    <Card>
      <p className="text-sm text-muted">{t(greeting)}</p>
      <p className="mt-0.5 text-4xl font-semibold tabular-nums tracking-tight text-heading" dir="ltr">
        {new Intl.DateTimeFormat(intl, { hour: '2-digit', minute: '2-digit' }).format(now)}
        <span className="ms-1 text-lg text-muted">{String(now.getSeconds()).padStart(2, '0')}</span>
      </p>
      <p className="text-sm text-ink">{new Intl.DateTimeFormat(intl, { weekday: 'long', day: 'numeric', month: 'long' }).format(now)}</p>
    </Card>
  );
}

function SystemWidget() {
  const { t } = useI18n();
  const s = useSystem();
  const ram = s ? ((s.mem.total - s.mem.available) / s.mem.total) * 100 : 0;
  return (
    <Card title={t('widget.system')} onOpen={() => openDeskApp(deskApp('monitor')!, t('section.monitor'))}>
      <div className="flex justify-between">
        <Ring value={s?.cpu.total ?? 0} label="CPU" size={60} />
        <Ring value={ram} label="RAM" size={60} />
        <Ring value={s?.gpu.busy ?? 0} label="GPU" size={60} />
      </div>
      <div className="mt-2 flex justify-between text-xs text-muted">
        <span>
          {t('widget.temp')} <b className="font-medium text-ink">{formatTemp(s?.temps.cpu)}</b>
        </span>
        <span>
          {t('widget.uptime')} <b className="font-medium text-ink">{s ? formatDuration(s.uptime) : '–'}</b>
        </span>
      </div>
    </Card>
  );
}

/** Download/upload with a tiny live chart of the last minute. */
function NetworkWidget() {
  const { t } = useI18n();
  const s = useSystem();
  const hist = useRef<{ rx: number; tx: number }[]>([]);
  const last = useRef<number>(0);
  if (s && s.ts !== last.current) {
    last.current = s.ts;
    hist.current = [...hist.current.slice(-29), { rx: s.net.rx, tx: s.net.tx }];
  }
  const pts = hist.current;
  const max = Math.max(1, ...pts.flatMap((p) => [p.rx, p.tx]));
  const line = (k: 'rx' | 'tx') => pts.map((p, i) => `${(i / 29) * 260},${46 - (p[k] / max) * 42}`).join(' ');
  return (
    <Card title={t('widget.network')}>
      <div className="flex gap-4 text-sm" dir="ltr">
        <span className="flex items-center gap-1 text-primary-ink">
          <ArrowDown16Regular aria-hidden /> {formatRate(s?.net.rx)}
        </span>
        <span className="flex items-center gap-1 text-[#16a34a]">
          <ArrowUp16Regular aria-hidden /> {formatRate(s?.net.tx)}
        </span>
      </div>
      <svg viewBox="0 0 260 48" className="mt-2 h-12 w-full" preserveAspectRatio="none" aria-hidden>
        <polyline points={line('rx')} fill="none" stroke="var(--color-primary)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
        <polyline points={line('tx')} fill="none" stroke="#16a34a" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      </svg>
    </Card>
  );
}

interface Mount {
  device: string;
  mount: string;
  size: number;
  used: number;
  avail: number;
}

function StorageWidget() {
  const { t } = useI18n();
  const [mounts, setMounts] = useState<Mount[] | null>(null);
  useEffect(() => {
    const load = () => void api<{ storage: Mount[] }>('/api/home').then((h) => setMounts(h.storage)).catch(() => {});
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, []);
  return (
    <Card title={t('widget.storage')} onOpen={() => openDeskApp(deskApp('disks')!, t('section.disks'))}>
      <ul className="space-y-2.5">
        {(mounts ?? []).map((m) => {
          const pct = m.size ? (m.used / m.size) * 100 : 0;
          const name = m.mount === '/' ? t('vol.internal') : (m.mount.split('/').pop() ?? m.mount).replace(/_/g, ' ');
          return (
            <li key={m.device}>
              <div className="mb-1 flex justify-between gap-2 text-xs">
                <span className="truncate text-ink" dir="auto">
                  {name}
                </span>
                <span className="shrink-0 text-muted" dir="ltr">
                  {formatBytes(m.avail)} {t('widget.free')}
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-line">
                <div className="h-full rounded-full" style={{ width: `${pct}%`, background: pct > 90 ? 'var(--color-danger)' : pct > 75 ? 'var(--color-warn)' : 'var(--color-primary)' }} />
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function PhotosWidget() {
  const { t } = useI18n();
  const [items, setItems] = useState<{ path: string; mtime: number }[]>([]);
  useEffect(() => {
    const load = () => void api<{ items: { path: string; mtime: number }[] }>('/api/gallery?kind=photos&limit=6').then((r) => setItems(r.items)).catch(() => {});
    load();
    const id = setInterval(load, 5 * 60_000);
    return () => clearInterval(id);
  }, []);
  if (!items.length) return null;
  return (
    <Card title={t('widget.photos')} onOpen={() => openDeskApp(deskApp('gallery')!, t('section.gallery'))}>
      <div className="grid grid-cols-3 gap-1.5">
        {items.map((p) => (
          <button
            key={p.path}
            type="button"
            onClick={() => wm.open({ app: 'viewer', title: p.path.split('/').pop()!, route: `/view?path=${encodeURIComponent(p.path)}`, w: 1000, h: 720 })}
            className="aspect-square overflow-hidden rounded-lg bg-line hover:opacity-90"
          >
            <img src={thumbUrl(p.path, p.mtime)} alt="" loading="lazy" className="size-full object-cover" />
          </button>
        ))}
      </div>
    </Card>
  );
}

interface Ctr {
  id: string;
  name: string;
  state: string;
  app: string | null;
}

function AppsWidget() {
  const { t } = useI18n();
  const [list, setList] = useState<Ctr[] | null>(null);
  useEffect(() => {
    const load = () => void api<Ctr[]>('/api/docker/containers').then(setList).catch(() => setList([]));
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, []);
  const running = list?.filter((c) => c.state === 'running').length ?? 0;
  return (
    <Card title={t('widget.apps')} onOpen={() => openDeskApp(deskApp('docker')!, t('section.docker'))}>
      <p className="mb-2 text-sm text-ink">{t('widget.running', { n: running, total: list?.length ?? 0 })}</p>
      <ul className="space-y-1">
        {(list ?? []).slice(0, 6).map((c) => (
          <li key={c.id}>
            <button type="button" onClick={() => wm.open({ app: 'docker', title: c.name, route: `/docker/${c.id}`, w: 860, h: 700, newWindow: true })} className="flex w-full items-center gap-2 rounded-md px-1 py-0.5 text-start text-xs hover:bg-black/5 dark:hover:bg-white/10">
              <span className={`size-2 shrink-0 rounded-full ${c.state === 'running' ? 'bg-ok' : 'bg-muted'}`} />
              <span className="truncate text-ink" dir="ltr">
                {c.name.replace(/^manar-/, '')}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

const RENDER: Record<WidgetId, () => ReactNode> = {
  clock: () => <ClockWidget />,
  system: () => <SystemWidget />,
  network: () => <NetworkWidget />,
  storage: () => <StorageWidget />,
  photos: () => <PhotosWidget />,
  apps: () => <AppsWidget />,
};

/** The widget column on the desktop's far side (right in English, left in Arabic). */
export function WidgetColumn({ onMenu }: { onMenu: (x: number, y: number) => void }) {
  const list = useWidgets();
  if (!list.length) return null;
  return (
    <aside
      className="absolute end-3 top-3 flex w-[300px] flex-col gap-3 overflow-y-auto pb-3"
      style={{ maxHeight: `calc(100% - ${TASKBAR_H + 12}px)` }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onMenu(e.clientX, e.clientY);
      }}
    >
      {list.map((id) => (
        <div key={id}>{RENDER[id]()}</div>
      ))}
    </aside>
  );
}
