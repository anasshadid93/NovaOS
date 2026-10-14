import { useEffect, useRef, useState } from 'react';
import { Dismiss20Regular } from '@fluentui/react-icons';
import { useI18n } from '../i18n';
import type { Shortcut } from './DesktopIcons';
import type { AppGroup } from './prefs';

const ICON = 52; // desktop icons are drawn at this size

/** The folder's desktop icon: a frosted tile with up to nine of its apps in small. */
export function FolderArt({ apps, size = ICON }: { apps: Shortcut[]; size?: number }) {
  const cell = Math.floor((size - 10) / 3);
  return (
    <span
      className="grid shrink-0 grid-cols-3 content-start gap-[2px] rounded-[14px] border border-white/50 bg-white/45 p-[4px] shadow-sm backdrop-blur-md dark:border-white/15 dark:bg-white/15"
      style={{ width: size, height: size }}
      aria-hidden
    >
      {apps.slice(0, 9).map((a) => (
        <span key={a.key} className="relative overflow-hidden" style={{ width: cell, height: cell }}>
          <span className="pointer-events-none absolute start-0 top-0 origin-top-left rtl:origin-top-right" style={{ width: ICON, height: ICON, transform: `scale(${cell / ICON})` }}>
            {a.icon}
          </span>
        </span>
      ))}
    </span>
  );
}

/**
 * An open folder, like on a phone: its name (tap to rename) and its apps. Tap an app to open it;
 * long-press or right-click one to take it out of the folder.
 */
export function FolderPanel({
  group,
  apps,
  renameNow,
  onRename,
  onAppMenu,
  onClose,
}: {
  group: AppGroup;
  apps: Shortcut[];
  renameNow: boolean;
  onRename: (name: string) => void;
  onAppMenu: (s: Shortcut, x: number, y: number) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(group.name);
  const input = useRef<HTMLInputElement>(null);
  const hold = useRef<{ timer: number; fired: boolean } | null>(null);
  useEffect(() => {
    if (renameNow) input.current?.select();
  }, [renameNow]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, [onClose]);
  const save = () => {
    const n = name.trim().slice(0, 60);
    if (n !== group.name) onRename(n);
  };

  return (
    <div
      className="fixed inset-0 z-[9990] flex items-center justify-center bg-black/30 p-4 backdrop-blur-sm"
      onPointerDown={(e) => e.target === e.currentTarget && (save(), onClose())}
      role="dialog"
      aria-modal="true"
      aria-label={group.name || t('desk.folder')}
    >
      <div className="w-[min(92vw,440px)] rounded-3xl border border-white/40 bg-surface/90 p-4 shadow-[0_24px_60px_rgb(15_23_42/0.35)] backdrop-blur-xl">
        <div className="mb-3 flex items-center gap-2">
          <input
            ref={input}
            value={name}
            placeholder={t('desk.folder')}
            onChange={(e) => setName(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
            maxLength={60}
            dir="auto"
            aria-label={t('desk.folderName')}
            className="min-w-0 flex-1 rounded-xl border border-transparent bg-transparent px-2 py-1 text-center text-lg font-semibold text-heading outline-none hover:border-line focus:border-primary"
          />
          <button type="button" onClick={() => (save(), onClose())} className="grid h-8 w-8 place-items-center rounded-full text-muted hover:bg-line/60" aria-label={t('common.close')}>
            <Dismiss20Regular />
          </button>
        </div>
        <div className="grid max-h-[60vh] grid-cols-3 gap-1 overflow-y-auto sm:grid-cols-4">
          {apps.map((s) => (
            <button
              key={s.key}
              type="button"
              onPointerDown={(e) => {
                if (e.pointerType === 'mouse') return;
                const { clientX: x, clientY: y } = e;
                hold.current = { fired: false, timer: window.setTimeout(() => hold.current && ((hold.current.fired = true), navigator.vibrate?.(12), onAppMenu(s, x, y)), 500) };
              }}
              onPointerMove={(e) => hold.current && e.pointerType !== 'mouse' && (Math.abs(e.movementX) > 4 || Math.abs(e.movementY) > 4) && clearTimeout(hold.current.timer)}
              onPointerUp={() => hold.current && clearTimeout(hold.current.timer)}
              onPointerCancel={() => hold.current && clearTimeout(hold.current.timer)}
              onClick={() => {
                const fired = hold.current?.fired;
                hold.current = null;
                if (fired) return;
                save();
                onClose();
                s.open();
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                if (hold.current) return; // touch: the long-press opens it
                onAppMenu(s, e.clientX, e.clientY);
              }}
              className="flex flex-col items-center gap-1 rounded-xl p-2 hover:bg-line/50"
            >
              {s.icon}
              <span className="line-clamp-2 break-words text-center text-xs leading-tight text-ink" dir="auto">
                {s.title}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
