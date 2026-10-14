import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Alert20Regular,
  DocumentText20Regular,
  Settings20Regular,
  Desktop20Regular,
  LockClosed20Regular,
  Apps20Regular,
  Open16Regular,
  PinOff16Regular,
  Checkmark16Regular,
  DataTrending16Regular,
  Desktop16Regular,
  Dismiss16Regular,
  Image16Regular,
  Phone20Regular,
  Power20Regular,
  Search20Regular,
  Settings16Regular,
  SignOut20Regular,
  WindowNew16Regular,
} from '@fluentui/react-icons';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { lockNow } from '../components/LockScreen';
import { useLiveStatus, useSystem } from '../lib/live';
import { useI18n } from '../i18n';
import { AppArt } from '../components/AppArt';
import { LauncherIcon, rememberItems, type LauncherItem } from '../components/LauncherIcon';
import { DESK_APPS, deskApp, loadFrames, openDeskApp, openFile, opensInWindow, openWebApp, type DeskApp } from './apps';
import { SETTINGS_PAGES, useFileSearch } from '../lib/search';
import { FileIcon } from '../components/fm/FileIcon';
import { Window } from './Window';
import { desks, useDesks } from './desks';
import { MiniPlayer } from '../components/MiniPlayer';
import { DeskSwitcher } from './DeskSwitcher';
import { NotificationPanel, Toasts, useNotes, useNotificationFeed } from './Notifications';
import { useScale } from './scale';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { useWallpaper, wallpaperCss, isDarkWallpaper } from './wallpaper';
import { winMenu } from './winMenu';
import { useIsDark } from '../lib/theme';
import { DesktopIcons, type Shortcut } from './DesktopIcons';
import { AppDrawer } from './AppDrawer';
import { toggleIn, useDeskLists } from './prefs';
import { WIDGET_SPACE, WIDGETS, WidgetColumn, toggleWidget, useWidgets, widgetTitle } from './Widgets';
import { setDesktopPref } from './mode';
import { TASKBAR_H, useWindows, wm, type Win } from './wm';

/** Something that can be opened: one of MinisManager's screens or a web app from the launcher. */
export type Entry = { kind: 'desk'; app: DeskApp; title: string } | { kind: 'web'; item: LauncherItem; title: string };

export function EntryIcon({ e, size }: { e: Entry; size: number }) {
  if (e.kind === 'desk') return <AppArt art={e.app.art} size={size} />;
  return <LauncherIcon item={e.item} size={size} />;
}

function useLauncher() {
  const [items, setItems] = useState<LauncherItem[]>([]);
  useEffect(() => {
    const load = () => {
      void api<LauncherItem[]>('/api/launcher')
        .then((l) => (rememberItems(l), setItems(l)))
        .catch(() => {});
      void loadFrames();
    };
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, []);
  return items;
}

const open = (e: Entry) => (e.kind === 'desk' ? openDeskApp(e.app, e.title) : openWebApp(e.item));

function Clock() {
  const { intl } = useI18n();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="flex flex-col items-end px-2 text-[11px] leading-tight tabular-nums text-ink" dir="ltr">
      <span>{new Intl.DateTimeFormat(intl, { hour: '2-digit', minute: '2-digit' }).format(now)}</span>
      <span className="text-muted">{new Intl.DateTimeFormat(intl, { day: 'numeric', month: 'short' }).format(now)}</span>
    </div>
  );
}

/** Small CPU / RAM meters in the tray; click opens the monitor. */
function TrayMeters({ onClick }: { onClick: () => void }) {
  const { t } = useI18n();
  const s = useSystem();
  const cpu = s?.cpu.total ?? 0;
  const ram = s ? ((s.mem.total - s.mem.available) / s.mem.total) * 100 : 0;
  const bar = (v: number, label: string) => (
    <span className="flex items-center gap-1" title={`${label} ${v.toFixed(0)}%`}>
      <span className="w-7 text-[10px] text-muted">{label}</span>
      <span className="h-1.5 w-10 overflow-hidden rounded-full bg-line">
        <span className="block h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${Math.min(100, v)}%`, background: v > 85 ? 'var(--color-danger)' : undefined }} />
      </span>
    </span>
  );
  return (
    <button type="button" onClick={onClick} className="flex flex-col gap-0.5 rounded-lg px-2 py-1 hover:bg-black/5 dark:hover:bg-white/10" aria-label={t('section.monitor')} dir="ltr">
      {bar(cpu, 'CPU')}
      {bar(ram, 'RAM')}
    </button>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <p className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-wide text-muted">{title}</p>
      <div className="space-y-0.5">{children}</div>
    </section>
  );
}
function Row({ icon, title, sub, onClick }: { icon: ReactNode; title: string; sub?: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-start hover:bg-primary-soft focus-visible:bg-primary-soft">
      <span className="inline-flex size-7 shrink-0 items-center justify-center">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-ink" dir="auto">
          {title}
        </span>
        {sub && (
          <span className="block truncate text-xs text-muted" dir="auto">
            {sub}
          </span>
        )}
      </span>
    </button>
  );
}

function StartMenu({ entries, onClose }: { entries: Entry[]; onClose: () => void }) {
  const { t } = useI18n();
  const { state, logout, refresh } = useAuth();
  const [q, setQ] = useState('');
  // Lock now; without a PIN yet, open the place to set one.
  const lock = async () => {
    onClose();
    if (!(await lockNow(refresh))) openDeskApp(deskApp('display')!, t('display.title'));
  };
  const input = useRef<HTMLInputElement>(null);
  // Focus the search right away with a mouse; on touch screens that would pop up the keyboard.
  useEffect(() => {
    if (matchMedia('(pointer: fine)').matches) input.current?.focus();
  }, []);
  const list = q ? entries.filter((e) => e.title.toLowerCase().includes(q.toLowerCase())) : entries;
  const found = useFileSearch(q);
  const settingsHits = q.trim().length >= 2 ? SETTINGS_PAGES.filter((p) => `${t(p.label)} ${p.words ?? ''}`.toLowerCase().includes(q.trim().toLowerCase())) : [];
  const pick = (e: Entry) => {
    open(e);
    onClose();
  };
  const settings = deskApp('settings')!;
  return (
    <>
      <div className="fixed inset-0 z-[9990]" onPointerDown={onClose} aria-hidden />
      <div
        role="menu"
        className="fixed bottom-[calc(var(--tb)+8px)] start-2 z-[9991] w-[560px] max-w-[calc(100vw-16px)] overflow-hidden rounded-2xl border border-line bg-surface/95 shadow-[0_24px_64px_rgb(15_23_42/0.30)] backdrop-blur-xl"
        style={{ '--tb': `${TASKBAR_H}px` } as React.CSSProperties}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
          if (e.key === 'Enter' && list[0]) pick(list[0]);
        }}
      >
        <div className="p-4">
          <label className="flex items-center gap-2 rounded-xl bg-canvas px-3 py-2 ring-1 ring-line focus-within:ring-2 focus-within:ring-primary">
            <Search20Regular className="text-muted" aria-hidden />
            <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('search.placeholder')} className="flex-1 bg-transparent text-base outline-none [@media(pointer:fine)]:text-sm" />
          </label>
        </div>
        {!q ? (
          <div className="grid max-h-[50vh] grid-cols-5 gap-1 overflow-auto px-3 pb-3">
            {list.map((e) => (
              <button key={e.kind === 'desk' ? e.app.id : e.item.key} type="button" onClick={() => pick(e)} className="flex flex-col items-center gap-1.5 rounded-xl p-2 hover:bg-primary-soft focus-visible:bg-primary-soft">
                <EntryIcon e={e} size={44} />
                <span className="line-clamp-2 text-center text-xs leading-tight text-ink" dir="auto">
                  {e.title}
                </span>
              </button>
            ))}
          </div>
        ) : (
          // Spotlight: apps, settings, file names and text inside files.
          <div className="max-h-[56vh] space-y-3 overflow-auto px-3 pb-3">
            {list.length > 0 && (
              <Section title={t('search.apps')}>
                {list.slice(0, 8).map((e) => (
                  <Row key={e.kind === 'desk' ? e.app.id : e.item.key} onClick={() => pick(e)} icon={<EntryIcon e={e} size={28} />} title={e.title} />
                ))}
              </Section>
            )}
            {settingsHits.length > 0 && (
              <Section title={t('search.settings')}>
                {settingsHits.map((p) => (
                  <Row
                    key={p.route}
                    onClick={() => {
                      openDeskApp(deskApp(p.route.startsWith('/settings') ? 'settings' : p.route === '/display' ? 'display' : 'wallpaper')!, t(p.label), p.route);
                      onClose();
                    }}
                    icon={<Settings20Regular className="text-muted" />}
                    title={t(p.label)}
                  />
                ))}
              </Section>
            )}
            {found.files.length > 0 && (
              <Section title={t('search.files')}>
                {found.files.map((f) => (
                  <Row
                    key={f.path}
                    onClick={() => {
                      openFile(f);
                      onClose();
                    }}
                    icon={<FileIcon entry={f} size={28} />}
                    title={f.name}
                    sub={f.path.split('/').slice(0, -1).join('/')}
                  />
                ))}
              </Section>
            )}
            {found.content.length > 0 && (
              <Section title={t('search.inside')}>
                {found.content.map((c) => (
                  <Row
                    key={c.path}
                    onClick={() => {
                      openFile({ name: c.path.split('/').pop()!, path: c.path, type: 'file', size: 0, mtime: 0, cat: 'documents' });
                      onClose();
                    }}
                    icon={<DocumentText20Regular className="text-muted" />}
                    title={c.path.split('/').pop()!}
                    sub={`${t('search.line', { n: c.line })}: ${c.text}`}
                  />
                ))}
              </Section>
            )}
            {found.busy && <p className="px-2 text-xs text-muted">{t('search.searching')}</p>}
            {!found.busy && !list.length && !settingsHits.length && !found.files.length && !found.content.length && <p className="py-6 text-center text-sm text-muted">{t('desk.noResults')}</p>}
          </div>
        )}
        <div className="flex items-center gap-2 border-t border-line bg-canvas/60 px-4 py-2.5">
          <span className="flex size-8 items-center justify-center rounded-full bg-primary text-sm font-semibold text-white">{state?.user?.name.slice(0, 1).toUpperCase()}</span>
          <span className="flex-1 truncate text-sm font-medium text-ink">{state?.user?.name}</span>
          <button type="button" title={t('desk.mobileView')} aria-label={t('desk.mobileView')} onClick={() => setDesktopPref('mobile')} className="inline-flex size-9 items-center justify-center rounded-lg text-muted hover:bg-black/5 hover:text-ink">
            <Phone20Regular aria-hidden />
          </button>
          <button type="button" title={t('lock.lock')} aria-label={t('lock.lock')} onClick={() => void lock()} className="inline-flex size-9 items-center justify-center rounded-lg text-muted hover:bg-black/5 hover:text-ink">
            <LockClosed20Regular aria-hidden />
          </button>
                    <button type="button" title={t('settings.signOut')} aria-label={t('settings.signOut')} onClick={() => void logout()} className="inline-flex size-9 items-center justify-center rounded-lg text-muted hover:bg-black/5 hover:text-ink">
            <SignOut20Regular aria-hidden />
          </button>
          <button
            type="button"
            title={t('desk.power')}
            aria-label={t('desk.power')}
            onClick={() => {
              openDeskApp(settings, t('section.settings'), '/settings/power');
              onClose();
            }}
            className="inline-flex size-9 items-center justify-center rounded-lg text-muted hover:bg-black/5 hover:text-danger"
          >
            <Power20Regular aria-hidden />
          </button>
        </div>
      </div>
    </>
  );
}

function TaskButton({ active, open: isOpen, title, onClick, onMenu, children }: { active: boolean; open: boolean; title: string; onClick: () => void; onMenu?: (x: number, y: number) => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu?.(e.clientX, e.clientY);
      }}
      title={title}
      aria-label={title} className={`relative inline-flex size-11 items-center justify-center rounded-lg transition-colors ${active ? 'bg-white/70 shadow-sm dark:bg-white/15' : 'hover:bg-white/50 dark:hover:bg-white/10'}`}>
      {children}
      {isOpen && <span className={`absolute bottom-0.5 h-1 rounded-full bg-primary transition-all ${active ? 'w-4' : 'w-1.5 opacity-70'}`} />}
    </button>
  );
}

/**
 * In desktop mode the page itself never zooms (no double-tap zoom, no pinch-zoom of the whole
 * desktop): size comes from Display → Scale, and pinches go to the app under the fingers.
 */
function useNoPageZoom() {
  useEffect(() => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    if (!meta) return;
    const before = meta.content;
    meta.content = 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover';
    // iOS Safari ignores user-scalable=no; block its pinch gesture on the desktop chrome too.
    const stop = (e: Event) => e.preventDefault();
    document.addEventListener('gesturestart', stop);
    return () => {
      meta.content = before;
      document.removeEventListener('gesturestart', stop);
    };
  }, []);
}

export function Desktop() {
  useNoPageZoom();
  const { refresh: refreshAuth } = useAuth();
  const { t } = useI18n();
  const wins = useWindows();
  const launcher = useLauncher();
  const live = useLiveStatus();
  const wallpaper = useWallpaper();
  const dark = useIsDark();
  const widgets = useWidgets();
  const scale = useScale();
  const widgetMenu = (x: number, y: number) =>
    setMenu({ x, y, items: WIDGETS.map((id) => ({ label: t(widgetTitle[id]), icon: widgets.includes(id) ? Checkmark16Regular : undefined, onClick: () => toggleWidget(id) })) });
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [start, setStart] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const notes = useNotes();
  const unread = notes.filter((n) => !n.read).length;
  useNotificationFeed();


  const entries = useMemo<Entry[]>(
    () => [
      ...DESK_APPS.filter((a) => !a.hidden).map((a) => ({ kind: 'desk' as const, app: a, title: t(a.title) })),
      ...launcher.filter((i) => !i.hidden && i.url).map((i) => ({ kind: 'web' as const, item: i, title: i.title })),
    ],
    [launcher, t],
  );

  // Virtual desktops: every window stays mounted (streams keep running), only the current desktop's show.
  const deskState = useDesks();
  const here = (w: Win) => (w.desk ?? 0) === deskState.current;
  const [switcher, setSwitcher] = useState(false);
  const front = wins.filter((w) => !w.minimized && here(w)).sort((a, b) => b.z - a.z)[0];
  // Stacking order as small numbers, so windows always stay under the taskbar and menus.
  const layers = [...wins].sort((a, b) => a.z - b.z).map((w) => w.id);
  const iconFor = useCallback(
    (w: Win, size: number) => {
      const d = deskApp(w.app);
      if (d) return <AppArt art={d.art} size={size} />;
      const item = launcher.find((i) => `web:${i.key}` === w.app);
      return item ? <EntryIcon e={{ kind: 'web', item, title: item.title }} size={size} /> : <span className="size-4 rounded bg-primary" />;
    },
    [launcher],
  );

  // Keyboard: Ctrl+Space start menu, Alt+` next window, Alt+arrows snap, Alt+F4-ish close with Alt+W.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        desks.step(e.key === 'ArrowRight' ? 1 : -1);
        return;
      }
      if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        void lockNow(refreshAuth).then((ok) => ok || openDeskApp(deskApp('display')!, t('display.title')));
        return;
      }
      if (e.ctrlKey && e.code === 'Space') {
        e.preventDefault();
        setStart((v) => !v);
      }
      const f = wm.front();
      if (!e.altKey || !f) return;
      const k = e.key;
      if (k === '`') wm.cycle();
      else if (k === 'ArrowLeft') wm.setSnap(f.id, 'left');
      else if (k === 'ArrowRight') wm.setSnap(f.id, 'right');
      else if (k === 'ArrowUp') wm.toggleMax(f.id);
      else if (k === 'ArrowDown') wm.minimize(f.id);
      else if (k.toLowerCase() === 'w') wm.close(f.id);
      else return;
      e.preventDefault();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  const lists = useDeskLists();
  const keyOf = (e: Entry) => (e.kind === 'desk' ? e.app.id : e.item.key);
  const appOf = (e: Entry) => (e.kind === 'desk' ? e.app.id : `web:${e.item.key}`);
  // Taskbar pins (any app, chosen with right-click → Pin to taskbar); pinned apps' windows sit on their pin.
  const pins = lists.pinned.map((k) => entries.find((e) => keyOf(e) === k)).filter((e): e is Entry => !!e);
  const taskWins = wins.filter((w) => here(w) && !pins.some((p) => appOf(p) === w.app));

  const kindLabel = (key: string) => t(key.startsWith('svc:') ? 'props.kindService' : key.startsWith('craft:') ? 'props.kindCraft' : key.startsWith('app:') ? 'props.kindStore' : 'props.kindBuiltIn');
  const shortcuts: Shortcut[] = entries.map((e) => {
    const key = keyOf(e);
    const rows: [string, string][] = [
      [t('props.name'), e.title],
      [t('props.type'), kindLabel(key)],
    ];
    if (e.kind === 'web') {
      rows.push([t('props.address'), (e.item.url ?? '').split('?')[0]], [t('props.opensIn'), t(opensInWindow(key) ? 'props.inWindow' : 'props.inTab')], [t('props.opened'), String(e.item.opens)]);
      if (e.item.status) rows.push([t('props.status'), e.item.status]);
    } else rows.push([t('props.opensIn'), t('props.inWindow')]);
    return {
      key,
      title: e.title,
      icon: <EntryIcon e={e} size={52} />,
      open: () => open(e),
      openNew: e.kind === 'desk' ? () => wm.open({ app: e.app.id, title: e.title, route: e.app.route, w: e.app.w, h: e.app.h, newWindow: true }) : undefined,
      props: rows,
    };
  });

  return (
    <div className="desktop fixed inset-0 select-none overflow-hidden" style={{ zoom: scale }} onContextMenu={(e) => e.preventDefault()}>
      {/* Wallpaper: a built-in gradient or one of your photos (chosen in "Change wallpaper"). */}
      <div aria-hidden className="pointer-events-none absolute inset-0 transition-[background] duration-500" style={{ background: wallpaperCss(wallpaper, dark) }} />

      {/* Desktop icons: app shortcuts, then the files in the Desktop folder. */}
      <DesktopIcons
        shortcuts={shortcuts}
        onSettings={() => openDeskApp(deskApp('settings')!, t('section.settings'))}
        onWallpaper={() => openDeskApp(deskApp('wallpaper')!, t('wall.title'))}
        onDark={isDarkWallpaper(wallpaper, dark)}
        onWidgets={widgetMenu}
        onDisplay={() => openDeskApp(deskApp('display')!, t('display.title'))}
        endInset={widgets.length ? WIDGET_SPACE : 0}
      />

      {/* Widgets: under the windows, on the far side from the icons. */}
      <WidgetColumn onMenu={widgetMenu} />

      {/* Windows */}
      <div className="pointer-events-none absolute inset-x-0 top-0" style={{ bottom: TASKBAR_H }}>
        {wins.map((w) => (
          <Window key={w.id} away={!here(w)} win={w} icon={iconFor(w, 18)} active={front?.id === w.id} layer={10 + layers.indexOf(w.id)} />
        ))}
      </div>

      {start && <StartMenu entries={entries} onClose={() => setStart(false)} />}
      {switcher && <DeskSwitcher wins={wins} onClose={() => setSwitcher(false)} />}
      {notesOpen && <NotificationPanel onClose={() => setNotesOpen(false)} />}
      <Toasts />
      {drawer && <AppDrawer entries={entries} keyOf={keyOf} onOpen={(e) => (open(e), setDrawer(false))} onClose={() => setDrawer(false)} />}

      {/* Taskbar */}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}

      <nav
        onContextMenu={(e) => {
          if (e.target !== e.currentTarget) return;
          e.preventDefault();
          setMenu({
            x: e.clientX,
            y: e.clientY,
            items: [
              { label: t('desk.showDesktop'), icon: Desktop16Regular, onClick: () => wm.minimizeAll() },
              { label: t('section.monitor'), icon: DataTrending16Regular, onClick: () => openDeskApp(deskApp('monitor')!, t('section.monitor')) },
              { label: t('wall.title'), icon: Image16Regular, onClick: () => openDeskApp(deskApp('wallpaper')!, t('wall.title')) },
              { label: t('desk.settings'), icon: Settings16Regular, onClick: () => openDeskApp(deskApp('settings')!, t('section.settings')) },
            ],
          });
        }}
        className="absolute inset-x-0 bottom-0 z-[9995] flex items-center gap-1 border-t border-white/60 bg-white/65 px-2 backdrop-blur-xl dark:border-white/10 dark:bg-[#0f1729]/75" style={{ height: TASKBAR_H }} aria-label={t('desk.taskbar')}>
        <TaskButton active={start} open={false} title={t('desk.start')} onClick={() => setStart((v) => !v)}>
          <img src="/icons/icon.svg" alt="" className="size-7 rounded-lg" draggable={false} />
        </TaskButton>
        <span className="mx-1 h-6 w-px bg-line" aria-hidden />
        <TaskButton active={switcher} open={false} title={t('vdesk.title')} onClick={() => setSwitcher((v) => !v)}>
          <span className="relative inline-flex">
            <Desktop20Regular className="text-ink" aria-hidden />
            {deskState.names.length > 1 && <span className="absolute -bottom-1 -end-1.5 rounded bg-primary px-1 text-[9px] font-bold leading-3 text-white">{deskState.current + 1}</span>}
          </span>
        </TaskButton>
        <TaskButton active={drawer} open={false} title={t('drawer.title')} onClick={() => setDrawer((v) => !v)}>
          <Apps20Regular className="text-ink" aria-hidden />
        </TaskButton>
        {pins.map((e) => {
          const ws = wins.filter((w) => here(w) && w.app === appOf(e));
          const isFront = ws.some((w) => w.id === front?.id);
          return (
            <TaskButton
              key={keyOf(e)}
              active={isFront}
              open={ws.length > 0}
              title={e.title}
              onClick={() => (ws.length ? wm.toggleFromTaskbar((ws.find((w) => w.id === front?.id) ?? ws[ws.length - 1]).id) : open(e))}
              onMenu={(x, y) =>
                setMenu({
                  x,
                  y,
                  items: [
                    { label: t('fm.open'), icon: Open16Regular, onClick: () => open(e) },
                    ...(e.kind === 'desk' ? [{ label: t('desk.newWindow'), icon: WindowNew16Regular, onClick: () => wm.open({ app: e.app.id, title: e.title, route: e.app.route, w: e.app.w, h: e.app.h, newWindow: true }) }] : []),
                    { label: t('desk.unpin'), icon: PinOff16Regular, onClick: () => toggleIn('pinned', keyOf(e)) },
                    ...(ws.length ? [{ separator: true, label: '' }, { label: t('desk.closeAll'), icon: Dismiss16Regular, danger: true, onClick: () => ws.forEach((w) => wm.close(w.id)) }] : []),
                  ],
                })
              }
            >
              <EntryIcon e={e} size={30} />
            </TaskButton>
          );
        })}
        {taskWins.length > 0 && <span className="mx-1 h-6 w-px bg-line" aria-hidden />}
        {taskWins.map((w) => (
          <TaskButton key={w.id} active={front?.id === w.id} open title={w.title} onClick={() => wm.toggleFromTaskbar(w.id)} onMenu={(x, y) => setMenu({ x, y, items: winMenu(w, t) })}>
            {iconFor(w, 30)}
          </TaskButton>
        ))}
        <div className="flex-1" />
        <MiniPlayer variant="tray" onOpen={() => openDeskApp(deskApp('music')!, t('music.title'))} />
        <TrayMeters onClick={() => openDeskApp(deskApp('monitor')!, t('section.monitor'))} />
        <button
          type="button"
          onClick={() => setNotesOpen((v) => !v)}
          className={`relative inline-flex size-9 items-center justify-center rounded-lg text-ink hover:bg-black/5 dark:hover:bg-white/10 ${notesOpen ? 'bg-white/70 dark:bg-white/15' : ''}`}
          title={t('notes.title')}
          aria-label={unread ? t('notes.unread', { n: unread }) : t('notes.title')}
        >
          <Alert20Regular aria-hidden />
          {unread > 0 && <span className="absolute -end-0.5 -top-0.5 min-w-4 rounded-full bg-danger px-1 text-center text-[10px] font-semibold leading-4 text-white">{unread > 9 ? '9+' : unread}</span>}
        </button>
        <span className="flex items-center gap-1.5 px-1 text-xs text-muted" title={live === 'open' ? t('top.connected') : t('desk.connecting')}>
          <span className={`size-2 rounded-full ${live === 'open' ? 'bg-ok' : 'bg-warn'}`} />
        </span>
        <Clock />
        {/* Show desktop */}
        <button type="button" onClick={() => wm.minimizeAll()} className="h-full w-2 border-s border-line hover:bg-primary/20" title={t('desk.showDesktop')} aria-label={t('desk.showDesktop')} />
      </nav>
    </div>
  );
}
