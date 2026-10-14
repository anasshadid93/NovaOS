import { Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { ArrowClockwise16Regular, Dismiss16Regular, Open16Regular, Square16Regular, SquareMultiple16Regular, Subtract16Regular } from '@fluentui/react-icons';
import { useI18n } from '../i18n';
import { AppRoutes } from '../routes';
import { openExternal } from '../lib/external';
import { WindowContext, type WindowCtx } from './context';
import { toDesk } from './scale';
import { ContextMenu } from './ContextMenu';
import { winMenu } from './winMenu';
import { MIN_H, MIN_W, rectOf, snapAt, wm, type Snap, type Win } from './wm';

type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
const EDGES: { e: Edge; cls: string; cursor: string }[] = [
  { e: 'n', cls: 'inset-x-2 -top-1 h-2', cursor: 'ns-resize' },
  { e: 's', cls: 'inset-x-2 -bottom-1 h-2', cursor: 'ns-resize' },
  { e: 'w', cls: 'inset-y-2 -left-1 w-2', cursor: 'ew-resize' },
  { e: 'e', cls: 'inset-y-2 -right-1 w-2', cursor: 'ew-resize' },
  { e: 'nw', cls: '-left-1 -top-1 size-3', cursor: 'nwse-resize' },
  { e: 'se', cls: '-right-1 -bottom-1 size-3', cursor: 'nwse-resize' },
  { e: 'ne', cls: '-right-1 -top-1 size-3', cursor: 'nesw-resize' },
  { e: 'sw', cls: '-left-1 -bottom-1 size-3', cursor: 'nesw-resize' },
];

/** Closing shrinks and fades the window first (skipped when the user prefers less motion). */
function closeAnimated(el: HTMLElement | null, id: string) {
  if (!el || matchMedia('(prefers-reduced-motion: reduce)').matches) return wm.close(id);
  el.classList.add('wm-closing');
  setTimeout(() => wm.close(id), 140);
}

/** While a window is dragged, iframes must not swallow the pointer. */
const setDragging = (on: boolean) => document.documentElement.classList.toggle('wm-dragging', on);

/** A NovaOS screen with its own navigation (in-memory router), so windows don't fight over the URL. */
function ScreenBody({ win }: { win: Win }) {
  const { t } = useI18n();
  const loc = useMemo(() => memoryLocation({ path: win.route, record: true }), []); // eslint-disable-line react-hooks/exhaustive-deps
  const ctx = useMemo<WindowCtx>(
    () => ({
      id: win.id,
      start: win.start ?? win.route,
      canGoBack: () => loc.history.length > 1,
      back: () => {
        if (loc.history.length > 1) {
          loc.history.pop();
          loc.navigate(loc.history[loc.history.length - 1], { replace: true });
        } else loc.navigate(win.start ?? '/', { replace: true });
      },
    }),
    [], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const path = loc.hook()[0];
  const search = loc.hook.searchHook!();
  useEffect(() => wm.setRoute(win.id, search ? `${path}?${search}` : path), [win.id, path, search]);
  return (
    <WindowContext.Provider value={ctx}>
      <Router hook={loc.hook}>
        <Suspense fallback={<div className="p-6 text-center text-sm text-muted">{t('common.loading')}</div>}>
          <AppRoutes />
        </Suspense>
      </Router>
    </WindowContext.Provider>
  );
}

/** Another site (an app on the tailnet) inside the window. Some refuse to be framed: "open in a tab" is always there. */
/**
 * Apps that run on the server and stream their screen (Selkies: Browser, LibreOffice, FreeCAD, Blender) take
 * one device at a time — a new one kicks the old ("a new primary client connected"). So a device that
 * isn't being looked at lets go after a while, and takes the app back when it's looked at again.
 */
const STREAMED = /^web:app:(browser|libreoffice(-\w+)?|freecad|blender|\w+craft-desktop)$/;
const LET_GO_MS = 15_000;

function WebBody({ win, reloadKey }: { win: Win; reloadKey: number }) {
  const { t } = useI18n();
  const streamed = STREAMED.test(win.app);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (!streamed) return;
    let timer: number | undefined;
    const onVisibility = () => {
      clearTimeout(timer);
      if (document.hidden) timer = window.setTimeout(() => setPaused(true), LET_GO_MS);
      else setPaused(false); // reconnects (and takes control back from another device)
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [streamed]);
  if (paused) return <div className="flex size-full items-center justify-center bg-[#0b1220] text-sm text-slate-300">{t('desk.streamPaused')}</div>;
  return <iframe key={reloadKey} src={win.route} title={win.title} className="size-full border-0 bg-white" allow="fullscreen; clipboard-read; clipboard-write" />;
}

export function Window({ win, icon, active, layer, away }: { win: Win; icon: ReactNode; active: boolean; layer: number; away?: boolean }) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<Snap | 'max'>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [lifted, setLifted] = useState(false);
  const r = rectOf(win);
  const web = win.app.startsWith('web:');
  const floating = !win.maximized && !win.snap;

  // Drag by the title bar. Dragging a maximized/snapped window first restores it under the pointer.
  const onTitleDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
    wm.focus(win.id);
    const startX = toDesk(e.clientX);
    const startY = toDesk(e.clientY);
    let base = { x: r.x, y: r.y };
    let restored = floating;
    let moved = false;
    let snap: Snap = null;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    // Touch: press and hold the title bar to pick the window up, then slide it. A quick swipe does nothing.
    const touch = e.pointerType !== 'mouse';
    let armed = !touch;
    const hold = touch
      ? window.setTimeout(() => {
          armed = true;
          setLifted(true);
          navigator.vibrate?.(15);
        }, 350)
      : 0;
    const move = (ev: PointerEvent) => {
      const cx = toDesk(ev.clientX);
      const cy = toDesk(ev.clientY);
      const dx = cx - startX;
      const dy = cy - startY;
      if (!armed) {
        if (Math.hypot(dx, dy) > 8) {
          clearTimeout(hold);
          finish();
        }
        return;
      }
      if (!moved && Math.hypot(dx, dy) < 4) return;
      if (!moved) setDragging(true);
      moved = true;
      if (!restored) {
        // Keep the grab point at the same relative spot of the restored (smaller) window.
        const rel = (startX - r.x) / r.w;
        base = { x: startX - rel * win.w, y: Math.max(0, startY - 16) };
        wm.update(win.id, { maximized: false, snap: null });
        restored = true;
      }
      wm.update(win.id, { x: base.x + dx, y: base.y + dy });
      snap = snapAt(cx, cy);
      if (cy <= 2) snap = null;
      setPreview(cy <= 2 ? 'max' : snap);
    };
    const finish = () => {
      clearTimeout(hold);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', finish);
      setDragging(false);
      setPreview(null);
      setLifted(false);
    };
    const up = (ev: PointerEvent) => {
      finish();
      if (!moved) return;
      if (toDesk(ev.clientY) <= 2) wm.toggleMax(win.id);
      else if (snap) wm.setSnap(win.id, snap);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', finish);
  };

  const onResizeDown = (edge: Edge) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    wm.focus(win.id);
    const start = { px: toDesk(e.clientX), py: toDesk(e.clientY), ...r };
    if (!floating) wm.update(win.id, { ...r, maximized: false, snap: null });
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    setDragging(true);
    const move = (ev: PointerEvent) => {
      const dx = toDesk(ev.clientX) - start.px;
      const dy = toDesk(ev.clientY) - start.py;
      const p: Partial<Win> = {};
      if (edge.includes('e')) p.w = Math.max(MIN_W, start.w + dx);
      if (edge.includes('s')) p.h = Math.max(MIN_H, start.h + dy);
      if (edge.includes('w')) {
        const w = Math.max(MIN_W, start.w - dx);
        p.w = w;
        p.x = start.x + start.w - w;
      }
      if (edge.includes('n')) {
        const h = Math.max(MIN_H, start.h - dy);
        p.h = h;
        p.y = Math.max(0, start.y + start.h - h);
      }
      wm.update(win.id, p);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      setDragging(false);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  const pv = preview ? rectOf({ ...win, snap: preview === 'max' ? null : preview, maximized: preview === 'max' }) : null;
  const btn = 'inline-flex h-8 w-10 items-center justify-center rounded-md text-ink/70 hover:bg-black/5 hover:text-ink dark:hover:bg-white/10';

  return (
    <>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={winMenu(win, t)} onClose={() => setMenu(null)} />}
      {pv && <div className="pointer-events-none fixed z-[9998] rounded-xl border-2 border-primary/50 bg-primary/10 transition-all" style={{ left: pv.x + 6, top: pv.y + 6, width: pv.w - 12, height: pv.h - 12 }} />}
      <div
        ref={ref}
        role="dialog"
        aria-label={win.title}
        onPointerDownCapture={() => wm.focus(win.id)}
        className={`wm-window wm-open absolute flex flex-col overflow-visible ${away ? 'invisible' : ''} ${win.minimized ? 'pointer-events-none translate-y-6 scale-90 opacity-0' : 'pointer-events-auto opacity-100'} transition-[opacity,scale,translate] duration-200 ease-out`}
        style={{ left: r.x, top: r.y, width: r.w, height: r.h, zIndex: layer }}
      >
        <div
          className={`flex size-full flex-col overflow-hidden bg-canvas transition-[scale] ${lifted ? 'scale-[1.02] ring-2 ring-primary/60' : ''} ${win.maximized ? '' : 'rounded-xl'} ${active ? 'shadow-[0_20px_60px_rgb(15_23_42/0.30),0_0_0_1px_rgb(15_23_42/0.10)]' : 'shadow-[0_10px_30px_rgb(15_23_42/0.18),0_0_0_1px_rgb(15_23_42/0.08)]'}`}
        >
          <div
            onPointerDown={onTitleDown}
            onDoubleClick={(e) => !(e.target as HTMLElement).closest('button') && wm.toggleMax(win.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY });
            }}
            className={`flex h-10 shrink-0 touch-none select-none items-center gap-2 ps-3 pe-1 ${active ? 'bg-surface' : 'bg-surface/70'} border-b border-line`}
          >
            <span className="pointer-events-none flex size-5 items-center justify-center overflow-hidden">{icon}</span>
            <span className={`flex-1 truncate text-sm ${active ? 'font-medium text-heading' : 'text-muted'}`} dir="auto">
              {win.title}
            </span>
            {web && (
              <>
                <button type="button" className={btn} onClick={() => setReloadKey((k) => k + 1)} aria-label={t('desk.reload')} title={t('desk.reload')}>
                  <ArrowClockwise16Regular aria-hidden />
                </button>
                <button type="button" className={btn} onClick={() => openExternal(win.route)} aria-label={t('desk.openTab')} title={t('desk.openTab')}>
                  <Open16Regular aria-hidden />
                </button>
              </>
            )}
            <button type="button" className={btn} onClick={() => wm.minimize(win.id)} aria-label={t('desk.minimize')} title={t('desk.minimize')}>
              <Subtract16Regular aria-hidden />
            </button>
            <button type="button" className={btn} onClick={() => wm.toggleMax(win.id)} aria-label={t('desk.maximize')} title={t('desk.maximize')}>
              {win.maximized || win.snap ? <SquareMultiple16Regular aria-hidden /> : <Square16Regular aria-hidden />}
            </button>
            <button type="button" className={`${btn} hover:!bg-danger hover:!text-white`} onClick={() => closeAnimated(ref.current, win.id)} aria-label={t('common.close')} title={t('common.close')}>
              <Dismiss16Regular aria-hidden />
            </button>
          </div>
          <div className="wm-body relative min-h-0 flex-1 overflow-auto">
            {web ? <WebBody win={win} reloadKey={reloadKey} /> : <ScreenBody win={win} />}
          </div>
        </div>
        {!win.maximized &&
          EDGES.map(({ e, cls, cursor }) => <div key={e} onPointerDown={onResizeDown(e)} className={`absolute z-10 touch-none ${cls}`} style={{ cursor }} aria-hidden />)}
      </div>
    </>
  );
}
