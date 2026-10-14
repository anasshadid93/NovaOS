import { useState } from 'react';
import { ChevronDown16Regular } from '@fluentui/react-icons';
import { useI18n, type MessageKey } from '../i18n';
import { EntryIcon, type Entry } from './Desktop';
import { TASKBAR_H } from './wm';

/** App drawer: every app, in named drawers that open on click. */
type Group = 'files' | 'office' | 'creative' | 'internet' | 'services' | 'system' | 'apps';

const GROUPS: { id: Group; title: MessageKey }[] = [
  { id: 'files', title: 'drawer.files' },
  { id: 'office', title: 'drawer.office' },
  { id: 'creative', title: 'drawer.creative' },
  { id: 'internet', title: 'drawer.internet' },
  { id: 'services', title: 'drawer.services' },
  { id: 'system', title: 'drawer.system' },
  { id: 'apps', title: 'drawer.apps' },
];

const SYSTEM = new Set(['monitor', 'processes', 'docker', 'disks', 'tasks', 'terminal', 'display', 'settings', 'store', 'updates']);
const OFFICE = new Set(['app:libreoffice', 'app:libreoffice-writer', 'app:libreoffice-calc', 'app:libreoffice-impress', 'app:libreoffice-draw', 'app:stirling-pdf', 'craft:pdfcraft', 'craft:designcraft', 'craft:wordcraft', 'craft:gridcraft', 'craft:deckcraft']);
const CREATIVE = new Set(['app:blender', 'app:freecad']);

export function groupOf(key: string): Group {
  if (key === 'files' || key === 'gallery' || key === 'music') return 'files';
  if (SYSTEM.has(key)) return 'system';
  if (OFFICE.has(key)) return 'office';
  if (CREATIVE.has(key) || key.startsWith('craft:') || /^app:\w+craft-desktop$/.test(key)) return 'creative';
  if (key === 'app:browser') return 'internet';
  if (key.startsWith('svc:')) return 'services';
  return 'apps';
}

const KEY = 'manar.desktop.drawer';

export function AppDrawer({ entries, keyOf, onOpen, onClose }: { entries: Entry[]; keyOf: (e: Entry) => string; onOpen: (e: Entry) => void; onClose: () => void }) {
  const { t } = useI18n();
  const [openGroups, setOpenGroups] = useState<Group[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(KEY) ?? '["files"]') as Group[];
    } catch {
      return ['files'];
    }
  });
  const toggle = (g: Group) => {
    const next = openGroups.includes(g) ? openGroups.filter((x) => x !== g) : [...openGroups, g];
    setOpenGroups(next);
    localStorage.setItem(KEY, JSON.stringify(next));
  };

  return (
    <>
      <div className="fixed inset-0 z-[9990]" onPointerDown={onClose} aria-hidden />
      <div
        role="dialog"
        aria-label={t('drawer.title')}
        className="fixed start-2 z-[9991] flex max-h-[min(640px,calc(100%-var(--tb)-24px))] w-[440px] max-w-[calc(100%-16px)] flex-col overflow-hidden rounded-2xl border border-line bg-surface/95 shadow-[0_24px_64px_rgb(15_23_42/0.30)] backdrop-blur-xl"
        style={{ bottom: TASKBAR_H + 8, '--tb': `${TASKBAR_H}px` } as React.CSSProperties}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
      >
        <h2 className="px-4 pb-2 pt-4 text-base font-semibold text-heading">{t('drawer.title')}</h2>
        <div className="space-y-1 overflow-y-auto px-2 pb-3">
          {GROUPS.map((g) => {
            const items = entries.filter((e) => groupOf(keyOf(e)) === g.id);
            if (!items.length) return null;
            const isOpen = openGroups.includes(g.id);
            return (
              <section key={g.id} className="rounded-xl bg-canvas/60">
                <button type="button" onClick={() => toggle(g.id)} aria-expanded={isOpen} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-start hover:bg-primary-soft">
                  <span className="flex-1">
                    <span className="block text-sm font-semibold text-ink">{t(g.title)}</span>
                    <span className="block text-xs text-muted">{t('drawer.count', { n: items.length })}</span>
                  </span>
                  {!isOpen && (
                    <span className="flex items-center gap-1">
                      {items.slice(0, 4).map((e) => (
                        <span key={keyOf(e)} className="inline-flex size-[26px] items-center justify-center overflow-hidden">
                          <EntryIcon e={e} size={26} />
                        </span>
                      ))}
                    </span>
                  )}
                  <ChevronDown16Regular className={`shrink-0 text-muted transition-transform ${isOpen ? 'rotate-180' : ''}`} aria-hidden />
                </button>
                {isOpen && (
                  <div className="grid grid-cols-4 gap-1 px-2 pb-2">
                    {items.map((e) => (
                      <button key={keyOf(e)} type="button" onClick={() => onOpen(e)} className="flex flex-col items-center gap-1.5 rounded-xl p-2 hover:bg-primary-soft">
                        <EntryIcon e={e} size={44} />
                        <span className="line-clamp-2 text-center text-xs leading-tight text-ink" dir="auto">
                          {e.title}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      </div>
    </>
  );
}
