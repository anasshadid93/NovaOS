import { useState, type ComponentType, type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import { ArrowLeft24Regular, ChevronRight20Regular } from '@fluentui/react-icons';
import { useWindowCtx } from '../desktop/context';
import { useI18n } from '../i18n';
import { AppArt, type Art } from './AppArt';

type Icon = ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;

export const TILE_COLORS = {
  blue: 'bg-tile-blue',
  teal: 'bg-tile-teal',
  green: 'bg-tile-green',
  orange: 'bg-tile-orange',
  red: 'bg-tile-red',
  purple: 'bg-tile-purple',
  slate: 'bg-tile-slate',
  sky: 'bg-tile-sky',
} as const;
export type TileColor = keyof typeof TILE_COLORS;

/** White Fluent glyph on a coloured rounded square. */
export function IconBadge({ icon: I, color, size = 'md' }: { icon: Icon; color: TileColor; size?: 'sm' | 'md' }) {
  const box = size === 'sm' ? 'size-9 rounded-[0.7rem] [&>svg]:size-5' : 'size-14 rounded-tile [&>svg]:size-7';
  return (
    <span className={`inline-flex shrink-0 items-center justify-center text-white ${TILE_COLORS[color]} ${box}`}>
      <I aria-hidden />
    </span>
  );
}

/**
 * Sticky page header. `children` (tabs, search, filters) render inside the same
 * sticky block, so they always sit right under the title whatever the safe-area height.
 */
export function PageHeader({ title, back, actions, children }: { title: string; back?: string | boolean | (() => void); actions?: ReactNode; children?: ReactNode }) {
  const { t } = useI18n();
  const [location, navigate] = useLocation();
  const win = useWindowCtx();
  // In a desktop window "back" walks that window's own history; its first screen has none.
  if (win) back = location !== win.start.split('?')[0] || win.canGoBack() ? back || true : false;
  return (
    <header className={`${win ? 'pt-2' : 'safe-top'} sticky top-0 z-20 mb-1 bg-canvas/90 backdrop-blur-md`}>
      <div className="flex items-center gap-2 px-3 pb-2">
        {back && (
          <button
            type="button"
            onClick={() => (typeof back === 'function' ? back() : win ? win.back() : typeof back === 'string' ? navigate(back) : history.back())}
            className="inline-flex size-10 items-center justify-center rounded-full text-heading hover:bg-primary-soft"
            aria-label={t('common.back')}
          >
            <ArrowLeft24Regular className="flip-rtl" aria-hidden />
          </button>
        )}
        <h1 className={`flex-1 truncate text-lg font-semibold text-heading ${back ? '' : 'ps-1'}`}>{title}</h1>
        {actions}
      </div>
      {children && <div className="mx-auto max-w-md px-3 pb-2">{children}</div>}
    </header>
  );
}

export function Card({ title, action, children, className = '' }: { title?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card p-4 ${className}`}>
      {(title || action) && (
        <div className="mb-3 flex items-center justify-between gap-2">
          {title && <h2 className="text-base font-semibold text-heading">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

/** 4-per-row launcher grid. */
export function TileGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-4 gap-x-2 gap-y-4">{children}</div>;
}

const reducedMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Launcher tile. With `art` it shows a phone-style app icon (see AppArt) that
 * squashes while pressed and pops when tapped (navigation waits for the pop).
 */
export function Tile({ href, icon, art, color, label, onClick }: { href?: string; icon: Icon; art?: Art; color: TileColor; label: string; onClick?: () => void }) {
  const [, navigate] = useLocation();
  const [popping, setPopping] = useState(false);
  const face = art ? (
    <AppArt art={art} />
  ) : (
    <span className="tile-face">
      <IconBadge icon={icon} color={color} />
    </span>
  );
  const inner = (
    <>
      {face}
      <span className="line-clamp-2 text-center text-xs leading-tight text-ink">{label}</span>
    </>
  );
  const cls = `tile-3d flex flex-col items-center gap-1.5 rounded-xl p-1 ${popping ? 'tile-pop' : ''}`;
  const activate = (e: React.MouseEvent) => {
    if (reducedMotion()) return href ? undefined : onClick?.();
    e.preventDefault();
    setPopping(true);
    // Let the pop play before leaving the screen / opening a picker.
    setTimeout(() => {
      setPopping(false);
      if (href) navigate(href);
      else onClick?.();
    }, 260);
  };
  return href ? (
    <Link href={href} className={cls} onClick={activate}>
      {inner}
    </Link>
  ) : (
    <button type="button" onClick={activate} className={cls}>
      {inner}
    </button>
  );
}

/** Settings-style grouped list: optional caption above a white rounded list. */
export function ListGroup({ caption, children }: { caption?: string; children: ReactNode }) {
  return (
    <div>
      {caption && <h2 className="mb-2 px-2 text-sm font-medium text-muted">{caption}</h2>}
      <ul className="overflow-hidden rounded-list bg-surface shadow-card">{children}</ul>
    </div>
  );
}

export function ListRow({
  icon,
  color = 'blue',
  label,
  detail,
  href,
  onClick,
  trailing,
  danger,
}: {
  icon?: Icon;
  color?: TileColor;
  label: string;
  detail?: ReactNode;
  href?: string;
  onClick?: () => void;
  trailing?: ReactNode;
  danger?: boolean;
}) {
  const body = (
    <>
      {icon && <IconBadge icon={icon} color={color} size="sm" />}
      <span className="min-w-0 flex-1">
        <span className={`block truncate text-[0.95rem] ${danger ? 'text-danger' : 'text-ink'}`}>{label}</span>
        {detail && <span className="block truncate text-xs text-muted">{detail}</span>}
      </span>
      {trailing ?? ((href || onClick) && <ChevronRight20Regular className="flip-rtl shrink-0 text-muted" aria-hidden />)}
    </>
  );
  const cls = 'flex min-h-14 w-full items-center gap-3 px-4 py-2 text-start';
  return (
    <li className="border-line [&+&]:border-t">
      {href ? (
        <Link href={href} className={`${cls} active:bg-primary-soft`}>
          {body}
        </Link>
      ) : onClick ? (
        <button type="button" onClick={onClick} className={`${cls} active:bg-primary-soft`}>
          {body}
        </button>
      ) : (
        <div className={cls}>{body}</div>
      )}
    </li>
  );
}

export function Button({
  children,
  variant = 'primary',
  className = '',
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
}) {
  const styles = {
    primary: 'bg-primary text-white active:bg-primary-strong',
    secondary: 'bg-primary-soft text-primary-ink',
    danger: 'bg-danger text-white',
    ghost: 'text-primary-ink',
  }[variant];
  return (
    <button type="button" {...rest} className={`inline-flex min-h-12 items-center justify-center gap-2 rounded-xl px-4 font-medium transition disabled:opacity-50 ${styles} ${className}`}>
      {children}
    </button>
  );
}

export function TextField({ label, hint, ...rest }: React.ComponentProps<'input'> & { label: string; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-ink">{label}</span>
      <input {...rest} className="block min-h-12 w-full rounded-xl border border-line bg-surface px-3 text-base text-ink outline-none focus:border-primary" />
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  return children ? (
    <p role="alert" className="text-sm text-danger">
      {children}
    </p>
  ) : null;
}
