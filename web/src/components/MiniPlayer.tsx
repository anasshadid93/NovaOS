import { useLocation } from 'wouter';
import { Dismiss16Regular, Next20Filled, Pause20Filled, Play20Filled } from '@fluentui/react-icons';
import { player, usePlayer } from '../lib/player';
import { useI18n } from '../i18n';
import { Cover } from './NowPlaying';

/**
 * What's playing, everywhere. `pill` floats above the phone screens (leaving room for the
 * Files button at the end); `tray` sits in the desktop taskbar. Tapping the title opens Music.
 */
export function MiniPlayer({ variant, onOpen }: { variant: 'pill' | 'tray'; onOpen?: () => void }) {
  const { t } = useI18n();
  const p = usePlayer();
  const [loc, navigate] = useLocation();
  const cur = p.queue[p.index];
  if (!cur || (variant === 'pill' && loc.startsWith('/music'))) return null;
  const pct = p.duration ? (p.position / p.duration) * 100 : 0;
  const open = onOpen ?? (() => navigate('/music'));
  const btn = 'inline-flex size-9 shrink-0 items-center justify-center rounded-full text-ink hover:bg-black/5 dark:hover:bg-white/10';

  const inner = (
    <>
      <button type="button" onClick={open} className="flex min-w-0 flex-1 items-center gap-2 text-start" title={t('music.title')}>
        <Cover path={cur.path} size={variant === 'pill' ? 40 : 30} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-ink" dir="auto">
            {cur.title}
          </span>
          {cur.artist && (
            <span className="block truncate text-xs text-muted" dir="auto">
              {cur.artist}
            </span>
          )}
        </span>
      </button>
      <button type="button" className={btn} onClick={() => player.toggle()} aria-label={p.playing ? t('music.pause') : t('music.play')}>
        {p.playing ? <Pause20Filled aria-hidden /> : <Play20Filled aria-hidden />}
      </button>
      <button type="button" className={btn} onClick={() => player.next()} aria-label={t('music.next')}>
        <Next20Filled aria-hidden />
      </button>
      {!p.playing && (
        <button type="button" className={`${btn} text-muted`} onClick={() => player.clear()} aria-label={t('music.close')} title={t('music.close')}>
          <Dismiss16Regular aria-hidden />
        </button>
      )}
      <span className="absolute inset-x-3 bottom-0 h-0.5 overflow-hidden rounded-full bg-line" aria-hidden>
        <span className="block h-full bg-primary" style={{ width: `${pct}%` }} />
      </span>
    </>
  );

  if (variant === 'tray') return <div className="relative flex h-11 w-60 items-center gap-1 rounded-xl bg-white/60 px-2 dark:bg-white/10">{inner}</div>;
  return (
    <>
      {/* Room at the end of the page so the pill never hides the last row. */}
      <div className="h-20" aria-hidden />
      <div
        className="fixed start-3 end-20 z-40 mx-auto flex max-w-md items-center gap-1 rounded-2xl bg-surface/95 p-1.5 pe-2 shadow-[0_8px_28px_rgb(15_23_42/0.22)] ring-1 ring-line backdrop-blur"
        style={{ bottom: 'calc(env(safe-area-inset-bottom) + 12px)' }}
      >
        {inner}
      </div>
    </>
  );
}
