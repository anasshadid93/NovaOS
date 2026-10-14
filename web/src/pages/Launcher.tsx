import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { ArrowMove24Regular, BuildingStore24Color, Delete24Regular, Dismiss12Filled, Eye24Regular, EyeOff24Regular, Open24Regular, Settings24Regular, Subtract12Filled } from '@fluentui/react-icons';
import { ApiError, api } from '../lib/api';
import { useI18n } from '../i18n';
import { AppArt } from '../components/AppArt';
import { Dialog } from '../components/Dialog';
import { LauncherIcon, openItem, rememberItems, type LauncherItem } from '../components/LauncherIcon';
import { Button, PageHeader } from '../components/ui';
import { useRemoveApp } from './Apps';

const LONG_PRESS_MS = 480;

/** Long-press detection that also suppresses the click and the browser's context menu. */
function useLongPress(onLong: () => void, enabled: boolean) {
  const timer = useRef<number | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  return {
    fired,
    handlers: enabled
      ? {
          onPointerDown: (e: React.PointerEvent) => {
            fired.current = false;
            start.current = { x: e.clientX, y: e.clientY };
            clear();
            timer.current = window.setTimeout(() => {
              fired.current = true;
              navigator.vibrate?.(15);
              onLong();
            }, LONG_PRESS_MS);
          },
          onPointerMove: (e: React.PointerEvent) => {
            if (start.current && Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > 10) clear();
          },
          onPointerUp: clear,
          onPointerCancel: clear,
          onPointerLeave: clear,
          onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
        }
      : {},
  };
}

function AppTile({
  item,
  editing,
  dragging,
  onMenu,
  onBadge,
  onDragStart,
}: {
  item: LauncherItem;
  editing: boolean;
  dragging: boolean;
  onMenu: () => void;
  onBadge: () => void;
  onDragStart: (e: React.PointerEvent) => void;
}) {
  const { t } = useI18n();
  const { fired, handlers } = useLongPress(onMenu, !editing);
  const [popping, setPopping] = useState(false);
  const app = item.kind === 'app';

  const click = () => {
    if (fired.current || editing) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return openItem(item);
    setPopping(true);
    setTimeout(() => {
      setPopping(false);
      openItem(item);
    }, 220);
  };

  return (
    <div data-key={item.key} className={`relative ${dragging ? 'z-10 scale-110 opacity-90' : ''} transition-transform`}>
      <button
        type="button"
        onClick={click}
        onPointerDown={editing ? onDragStart : handlers.onPointerDown}
        onPointerMove={handlers.onPointerMove}
        onPointerUp={handlers.onPointerUp}
        onPointerCancel={handlers.onPointerCancel}
        onPointerLeave={handlers.onPointerLeave}
        onContextMenu={(e) => e.preventDefault()}
        style={editing ? { touchAction: 'none' } : undefined}
        className={`tile-3d flex w-full select-none flex-col items-center gap-1.5 rounded-xl p-1 ${popping ? 'tile-pop' : ''} ${editing ? 'jiggle' : ''} ${item.hidden ? 'opacity-40' : ''}`}
      >
        <span className="tile-face pointer-events-none">
          <LauncherIcon item={item} />
        </span>
        <span className="pointer-events-none line-clamp-2 text-center text-xs leading-tight text-ink">{item.title}</span>
      </button>
      {editing && (
        <button
          type="button"
          onClick={onBadge}
          aria-label={app ? `${t('launcher.uninstall')} ${item.title}` : t(item.hidden ? 'launcher.show' : 'launcher.hide', { name: item.title })}
          className={`absolute -top-1 start-1 inline-flex size-6 items-center justify-center rounded-full text-white shadow-md ring-2 ring-surface ${app ? 'bg-danger' : 'bg-muted'}`}
        >
          {app ? <Dismiss12Filled aria-hidden /> : item.hidden ? <Eye24Regular className="size-3.5" aria-hidden /> : <Subtract12Filled aria-hidden />}
        </button>
      )}
    </div>
  );
}

export function Launcher() {
  const { t } = useI18n();
  const [, navigate] = useLocation();
  const [items, setItems] = useState<LauncherItem[]>([]);
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState<LauncherItem | null>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [error, setError] = useState('');
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const load = useCallback(() => api<LauncherItem[]>('/api/launcher').then((l) => (rememberItems(l), setItems(l))), []);
  useEffect(() => {
    void load();
  }, [load]);

  const saveOrder = (list: LauncherItem[]) => void api('/api/launcher/order', { method: 'PUT', body: { keys: list.map((x) => x.key) } });

  const toggleHidden = (item: LauncherItem) => {
    setItems((list) => list.map((x) => (x.key === item.key ? { ...x, hidden: !x.hidden } : x)));
    void api('/api/launcher/hide', { body: { key: item.key, hidden: !item.hidden } });
  };

  const runTask = async (path: string, init: { method?: string; body?: unknown }) => {
    try {
      const r = await api<{ task?: number }>(path, init);
      if (r.task) navigate(`/tasks/${r.task}`);
    } catch (e) {
      if (!(e instanceof ApiError && e.code === 'confirm_required')) setError(t('common.error'));
    }
  };
  const removeApp = useRemoveApp(runTask);
  const uninstall = (item: LauncherItem) => void removeApp({ id: item.key.replace(/^app:/, ''), title: item.title });

  // Drag to reorder (arrange mode): the tile under the finger takes the dragged tile's place.
  const onDragStart = (key: string) => (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragKey(key);
  };
  useEffect(() => {
    if (!dragKey) return;
    const move = (e: PointerEvent) => {
      const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-key]') as HTMLElement | null;
      const over = el?.dataset.key;
      if (!over || over === dragKey) return;
      const list = itemsRef.current.slice();
      const from = list.findIndex((x) => x.key === dragKey);
      const to = list.findIndex((x) => x.key === over);
      if (from < 0 || to < 0) return;
      const [moved] = list.splice(from, 1);
      list.splice(to, 0, moved);
      setItems(list);
    };
    const up = () => {
      setDragKey(null);
      saveOrder(itemsRef.current);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up, { once: true });
    addEventListener('pointercancel', up, { once: true });
    return () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      removeEventListener('pointercancel', up);
    };
  }, [dragKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const visible = editing ? items : items.filter((i) => !i.hidden);
  const menuApp = menu?.kind === 'app';
  const sheetBtn = 'flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-start active:bg-primary-soft';

  return (
    <>
      <PageHeader
        title={t('launcher.title')}
        back="/"
        actions={
          <button type="button" onClick={() => setEditing((v) => !v)} className="min-h-10 rounded-full px-3 text-sm font-medium text-primary-ink">
            {editing ? t('launcher.done') : t('launcher.edit')}
          </button>
        }
      />
      <main className="safe-bottom mx-auto max-w-md space-y-3 px-3">
        <p className="px-1 text-xs text-muted">{editing ? t('launcher.dragHint') : t('launcher.longPressHint')}</p>
        <div className="card p-4">
          <div className="grid grid-cols-4 gap-x-2 gap-y-4">
            {visible.map((i) => (
              <AppTile
                key={i.key}
                item={i}
                editing={editing}
                dragging={dragKey === i.key}
                onMenu={() => setMenu(i)}
                onBadge={() => (i.kind === 'app' ? uninstall(i) : toggleHidden(i))}
                onDragStart={onDragStart(i.key)}
              />
            ))}
            {!editing && (
              <Link href="/store" className="tile-3d flex flex-col items-center gap-1.5 rounded-xl p-1">
                <AppArt art={{ kind: 'fluent', glyph: BuildingStore24Color }} />
                <span className="line-clamp-2 text-center text-xs leading-tight text-ink">{t('launcher.store')}</span>
              </Link>
            )}
          </div>
        </div>
        {editing && (
          <Button className="w-full" onClick={() => setEditing(false)}>
            {t('launcher.done')}
          </Button>
        )}
        {error && <p className="text-sm text-danger">{error}</p>}
      </main>

      <Dialog open={!!menu} onClose={() => setMenu(null)} title={menu?.title ?? ''}>
        {menu && (
          <ul className="-mx-2">
            <li>
              <button
                type="button"
                className={`${sheetBtn} text-ink`}
                onClick={() => {
                  setMenu(null);
                  openItem(menu);
                }}
              >
                <Open24Regular aria-hidden />
                {t('launcher.open')}
              </button>
            </li>
            <li>
              <button
                type="button"
                className={`${sheetBtn} text-ink`}
                onClick={() => {
                  setMenu(null);
                  setEditing(true);
                }}
              >
                <ArrowMove24Regular aria-hidden />
                {t('launcher.move')}
              </button>
            </li>
            {menuApp && (
              <li>
                <button type="button" className={`${sheetBtn} text-ink`} onClick={() => navigate(`/docker/manar-${menu.key.replace(/^app:/, '')}`)}>
                  <Settings24Regular aria-hidden />
                  {t('launcher.settings')}
                </button>
              </li>
            )}
            <li>
              <button
                type="button"
                className={`${sheetBtn} text-ink`}
                onClick={() => {
                  toggleHidden(menu);
                  setMenu(null);
                }}
              >
                {menu.hidden ? <Eye24Regular aria-hidden /> : <EyeOff24Regular aria-hidden />}
                {t(menu.hidden ? 'launcher.show' : 'launcher.hide', { name: '' }).trim()}
              </button>
            </li>
            {menuApp && (
              <li>
                <button
                  type="button"
                  className={`${sheetBtn} text-danger`}
                  onClick={() => {
                    const m = menu;
                    setMenu(null);
                    uninstall(m);
                  }}
                >
                  <Delete24Regular aria-hidden />
                  {t('launcher.uninstall')}
                </button>
              </li>
            )}
          </ul>
        )}
      </Dialog>
    </>
  );
}
