import { useEffect, useRef, type ReactNode } from 'react';

/** Bottom sheet on phones; uses <dialog> for focus trapping and Esc handling. */
export function Dialog({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  // `close()` fires the "close" event later, as a task. By then the same sheet may already show the
  // next question (e.g. "also delete the data?"), so a close we caused must not cancel that one.
  const programmaticClose = useRef(false);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal?.();
    if (!open && d.open) {
      programmaticClose.current = true;
      d.close();
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={() => {
        if (programmaticClose.current) {
          programmaticClose.current = false;
          return;
        }
        onClose();
      }}
      onClick={(e) => e.target === ref.current && onClose()}
      aria-labelledby="dialog-title"
      aria-modal="true"
      className="m-0 mt-auto w-full max-w-none rounded-t-3xl bg-surface p-0 text-ink backdrop:bg-black/40 sm:m-auto sm:max-w-md sm:rounded-3xl"
    >
      {open && (
        <div className="safe-bottom space-y-4 px-5 pt-5">
          <div className="mx-auto h-1 w-10 rounded-full bg-line sm:hidden" aria-hidden />
          <h2 id="dialog-title" className="text-lg font-semibold text-heading">
            {title}
          </h2>
          {children}
        </div>
      )}
    </dialog>
  );
}
