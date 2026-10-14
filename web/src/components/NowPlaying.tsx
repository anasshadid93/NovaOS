import { useEffect, useState } from 'react';
import { ArrowRepeatAll20Regular, ArrowRepeat120Regular, ArrowShuffle20Regular, Delete16Regular, MusicNote224Regular, Next24Filled, Pause24Filled, Play24Filled, Previous24Filled, TextBulletListLtr16Regular } from '@fluentui/react-icons';
import { coverUrl, player, usePlayer } from '../lib/player';
import { useI18n, type MessageKey } from '../i18n';

export const fmt = (s: number | null) => (s ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '');

export function Cover({ path, size }: { path: string | undefined; size: number }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [path]);
  return (
    <span className="inline-flex shrink-0 items-center justify-center overflow-hidden rounded-lg bg-gradient-to-br from-[#5b8def] to-[#1a3a7c] text-white" style={{ width: size, height: size }}>
      {path && !failed ? <img src={coverUrl(path)} alt="" loading="lazy" onError={() => setFailed(true)} className="size-full object-cover" /> : <MusicNote224Regular style={{ width: size * 0.45, height: size * 0.45 }} aria-hidden />}
    </span>
  );
}

/** The big player at the top: cover, controls, progress, shuffle/repeat, queue. */
export function NowPlaying() {
  const { t } = useI18n();
  const p = usePlayer();
  const [queueOpen, setQueueOpen] = useState(false);
  const cur = p.queue[p.index];
  if (!cur) return null;
  const btn = 'inline-flex size-11 items-center justify-center rounded-full text-ink hover:bg-primary-soft';
  return (
    <section className="card p-4">
      <div className="flex items-center gap-4">
        <Cover path={cur.path} size={96} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-lg font-semibold text-heading" dir="auto">
            {cur.title}
          </p>
          <p className="truncate text-sm text-muted" dir="auto">
            {[cur.artist, cur.album].filter(Boolean).join(' · ')}
          </p>
          <div className="mt-2 flex items-center gap-1">
            <button type="button" className={`${btn} ${p.shuffle ? 'text-primary' : 'text-muted'}`} onClick={() => player.setShuffle(!p.shuffle)} aria-label={t('music.shuffle')} aria-pressed={p.shuffle}>
              <ArrowShuffle20Regular aria-hidden />
            </button>
            <button type="button" className={btn} onClick={() => player.prev()} aria-label={t('music.prev')}>
              <Previous24Filled aria-hidden />
            </button>
            <button type="button" className="inline-flex size-12 items-center justify-center rounded-full bg-primary text-white shadow" onClick={() => player.toggle()} aria-label={p.playing ? t('music.pause') : t('music.play')}>
              {p.playing ? <Pause24Filled aria-hidden /> : <Play24Filled aria-hidden />}
            </button>
            <button type="button" className={btn} onClick={() => player.next()} aria-label={t('music.next')}>
              <Next24Filled aria-hidden />
            </button>
            <button
              type="button"
              className={`${btn} ${p.repeat !== 'off' ? 'text-primary' : 'text-muted'}`}
              onClick={() => player.cycleRepeat()}
              aria-label={t(`music.repeat.${p.repeat}` as MessageKey)}
              title={t(`music.repeat.${p.repeat}` as MessageKey)}
            >
              {p.repeat === 'one' ? <ArrowRepeat120Regular aria-hidden /> : <ArrowRepeatAll20Regular aria-hidden />}
            </button>
          </div>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2 text-xs tabular-nums text-muted" dir="ltr">
        <span>{fmt(p.position)}</span>
        <input type="range" min={0} max={p.duration || 0} step={1} value={p.position} onChange={(e) => player.seek(Number(e.target.value))} className="flex-1 accent-[var(--color-primary)]" aria-label={t('music.seek')} />
        <span>{fmt(p.duration)}</span>
      </div>
      <button type="button" onClick={() => setQueueOpen((v) => !v)} className="mt-2 inline-flex items-center gap-1 text-sm text-primary-ink">
        <TextBulletListLtr16Regular aria-hidden />
        {t('music.queue', { n: p.queue.length })}
      </button>
      {queueOpen && (
        <ol className="mt-2 max-h-64 overflow-auto rounded-xl bg-canvas text-sm">
          {p.queue.map((q, i) => (
            <li key={`${q.path}-${i}`} className={`flex items-center gap-2 px-3 py-1.5 ${i === p.index ? 'font-semibold text-primary-ink' : 'text-ink'}`}>
              <button type="button" onClick={() => player.jump(i)} className="min-w-0 flex-1 truncate text-start" dir="auto">
                {q.title}
              </button>
              <button type="button" onClick={() => player.removeAt(i)} className="text-muted hover:text-danger" aria-label={t('common.delete')}>
                <Delete16Regular aria-hidden />
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
