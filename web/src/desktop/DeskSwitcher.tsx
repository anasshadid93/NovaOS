import { useState } from 'react';
import { Add20Regular, Dismiss12Regular, Rename16Regular } from '@fluentui/react-icons';
import { useI18n } from '../i18n';
import { desks, useDesks } from './desks';
import { TASKBAR_H, wm, type Win } from './wm';

/** Taskbar popover: the virtual desktops, their windows, switch / add / rename / remove. */
export function DeskSwitcher({ wins, onClose }: { wins: Win[]; onClose: () => void }) {
  const { t } = useI18n();
  const { names, current } = useDesks();
  const [editing, setEditing] = useState<number | null>(null);
  const label = (i: number) => names[i] || t('vdesk.name', { n: i + 1 });

  return (
    <>
      <div className="fixed inset-0 z-[9990]" onPointerDown={onClose} aria-hidden />
      <div
        role="dialog"
        aria-label={t('vdesk.title')}
        className="fixed start-2 z-[9991] w-[min(640px,calc(100%-16px))] rounded-2xl border border-line bg-surface/95 p-4 shadow-[0_24px_64px_rgb(15_23_42/0.30)] backdrop-blur-xl"
        style={{ bottom: TASKBAR_H + 8 }}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold text-heading">{t('vdesk.title')}</h2>
          <span className="text-xs text-muted" dir="ltr">
            Ctrl+Alt+← →
          </span>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {names.map((_, i) => {
            const mine = wins.filter((w) => (w.desk ?? 0) === i);
            return (
              <div key={i} className={`group relative rounded-xl p-2 ring-1 transition ${i === current ? 'bg-primary-soft ring-2 ring-primary' : 'bg-canvas ring-line hover:ring-primary/50'}`}>
                <button
                  type="button"
                  onClick={() => {
                    desks.switchTo(i);
                    onClose();
                  }}
                  className="block w-full text-start"
                >
                  {/* A tiny picture of the desktop: one bar per window. */}
                  <span className="mb-2 flex aspect-video flex-col justify-end gap-1 overflow-hidden rounded-lg bg-gradient-to-br from-[#eef3fb] to-[#dfe8f8] p-1.5 dark:from-[#111a2e] dark:to-[#0b1220]">
                    {mine.slice(0, 4).map((w) => (
                      <span key={w.id} className={`block h-2.5 truncate rounded-sm bg-white/90 px-1 text-[7px] leading-[10px] text-ink shadow-sm dark:bg-white/20 ${w.minimized ? 'opacity-50' : ''}`}>
                        {w.title}
                      </span>
                    ))}
                  </span>
                </button>
                {editing === i ? (
                  <input
                    autoFocus
                    defaultValue={names[i]}
                    placeholder={t('vdesk.name', { n: i + 1 })}
                    onBlur={(e) => (desks.rename(i, e.currentTarget.value), setEditing(null))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur();
                      if (e.key === 'Escape') setEditing(null);
                    }}
                    className="w-full rounded bg-surface px-1.5 py-0.5 text-sm ring-1 ring-primary outline-none"
                    dir="auto"
                  />
                ) : (
                  <span className="flex items-center gap-1">
                    <span className="flex-1 truncate text-sm font-medium text-ink" dir="auto">
                      {label(i)}
                    </span>
                    <span className="text-[11px] text-muted">{mine.length}</span>
                    <button type="button" onClick={() => setEditing(i)} className="inline-flex size-6 items-center justify-center rounded text-muted opacity-0 hover:bg-black/5 group-hover:opacity-100 focus:opacity-100" aria-label={t('vdesk.rename')}>
                      <Rename16Regular aria-hidden />
                    </button>
                  </span>
                )}
                {names.length > 1 && (
                  <button
                    type="button"
                    onClick={() => {
                      wm.dropDesk(i);
                      desks.remove(i);
                    }}
                    className="absolute -end-1.5 -top-1.5 hidden size-5 items-center justify-center rounded-full bg-danger text-white shadow group-hover:inline-flex"
                    aria-label={t('vdesk.remove', { name: label(i) })}
                    title={t('vdesk.remove', { name: label(i) })}
                  >
                    <Dismiss12Regular aria-hidden />
                  </button>
                )}
              </div>
            );
          })}
          {names.length < 9 && (
            <button type="button" onClick={() => desks.add()} className="flex aspect-video flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-line text-sm text-muted hover:border-primary hover:text-primary-ink">
              <Add20Regular aria-hidden />
              {t('vdesk.add')}
            </button>
          )}
        </div>
      </div>
    </>
  );
}
