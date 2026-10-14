import { useEffect, useLayoutEffect, useRef, useState, type ComponentType } from 'react';
import { toDesk } from './scale';

export interface MenuItem {
  label: string;
  icon?: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
}

/** Right-click menu at the pointer, kept inside the screen. */
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  // x/y are screen pixels; the menu lives in the (possibly scaled) desktop.
  const [pos, setPos] = useState({ x: toDesk(x), y: toDesk(y) });
  useLayoutEffect(() => {
    const r = ref.current!.getBoundingClientRect();
    setPos({ x: toDesk(Math.min(x, innerWidth - r.width - 8)), y: toDesk(Math.min(y, innerHeight - r.height - 8)) });
  }, [x, y]);
  useEffect(() => {
    const close = (e: Event) => !ref.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    addEventListener('pointerdown', close, true);
    addEventListener('keydown', key);
    addEventListener('blur', onClose);
    ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    return () => {
      removeEventListener('pointerdown', close, true);
      removeEventListener('keydown', key);
      removeEventListener('blur', onClose);
    };
  }, [onClose]);
  return (
    <div
      ref={ref}
      role="menu"
      className="fixed z-[9999] min-w-52 rounded-xl border border-line bg-surface/95 p-1 shadow-[0_12px_40px_rgb(15_23_42/0.25)] backdrop-blur-xl"
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        e.preventDefault();
        const btns = [...ref.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        const i = btns.indexOf(document.activeElement as HTMLButtonElement);
        btns[(i + (e.key === 'ArrowDown' ? 1 : btns.length - 1)) % btns.length]?.focus();
      }}
    >
      {items.map((it, i) =>
        it.separator ? (
          <div key={i} className="my-1 h-px bg-line" />
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            disabled={it.disabled}
            onClick={() => {
              onClose();
              it.onClick?.();
            }}
            className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-start text-sm outline-none hover:bg-primary-soft focus-visible:bg-primary-soft disabled:opacity-40 ${it.danger ? 'text-danger' : 'text-ink'}`}
          >
            {it.icon ? <it.icon className="size-4 shrink-0 opacity-80" aria-hidden /> : <span className="size-4" />}
            {it.label}
          </button>
        ),
      )}
    </div>
  );
}
