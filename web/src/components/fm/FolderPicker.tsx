import { useEffect, useState } from 'react';
import { ArrowUp24Regular, Folder24Filled } from '@fluentui/react-icons';
import { list, parentOf, type Entry } from '../../lib/fm';
import { useI18n } from '../../i18n';
import { Dialog } from '../Dialog';
import { Button } from '../ui';

/** Lets the user browse folders and pick a destination for move/copy. */
export function FolderPicker({ open, start, title, confirmLabel, onPick, onClose }: { open: boolean; start: string; title: string; confirmLabel: string; onPick: (dir: string) => void; onClose: () => void }) {
  const { t } = useI18n();
  const [dir, setDir] = useState(start);
  const [dirs, setDirs] = useState<Entry[]>([]);

  useEffect(() => {
    if (open) setDir(start);
  }, [open, start]);

  useEffect(() => {
    if (!open) return;
    list(dir, false)
      .then((r) => setDirs(r.entries.filter((e) => e.type === 'dir')))
      .catch(() => setDirs([]));
  }, [dir, open]);

  return (
    <Dialog open={open} onClose={onClose} title={title}>
      <div className="flex items-center gap-2 rounded-xl bg-canvas px-3 py-2">
        <button type="button" disabled={!dir} onClick={() => setDir(parentOf(dir))} className="inline-flex size-9 items-center justify-center rounded-full text-heading disabled:opacity-30" aria-label={t('common.back')}>
          <ArrowUp24Regular aria-hidden />
        </button>
        <span dir="ltr" className="min-w-0 flex-1 truncate text-start text-sm text-ink">
          /{dir}
        </span>
      </div>
      <ul className="max-h-[45dvh] overflow-auto rounded-xl border border-line">
        {dirs.length === 0 && <li className="p-4 text-center text-sm text-muted">{t('fm.empty')}</li>}
        {dirs.map((d) => (
          <li key={d.path} className="border-line [&+&]:border-t">
            <button type="button" onClick={() => setDir(d.path)} className="flex min-h-12 w-full items-center gap-3 px-3 text-start active:bg-primary-soft">
              <Folder24Filled style={{ color: '#f5b400' }} aria-hidden />
              <span dir="auto" className="truncate text-start text-sm text-ink">
                {d.name}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div className="grid grid-cols-2 gap-3">
        <Button variant="secondary" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button onClick={() => onPick(dir)}>{confirmLabel}</Button>
      </div>
    </Dialog>
  );
}
