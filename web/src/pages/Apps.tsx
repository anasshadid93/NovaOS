import { useState } from 'react';
import { useLocation } from 'wouter';
import { ApiError, api } from '../lib/api';
import { usePoll } from '../lib/usePoll';
import { useI18n, type MessageKey } from '../i18n';
import { useConfirm } from '../components/ConfirmProvider';
import { InstalledAppIcon } from '../components/LauncherIcon';
import { Button, Card, ErrorText, PageHeader } from '../components/ui';
import { externalLink } from '../lib/external';

export interface InstalledApp {
  id: string;
  title: string;
  icon: string | null;
  status: string;
  state: string | null;
  url: string | null;
  canRollback: boolean;
  busy: boolean;
}

/**
 * Removing an app: step 1 asks whether to keep its data (default yes);
 * deleting data needs a second confirmation with the app id typed in.
 */
export function useRemoveApp(run: (path: string, init: { method?: string; body?: unknown }) => Promise<unknown>) {
  const { t } = useI18n();
  const ask = useConfirm();
  return async (a: { id: string; title: string }) => {
    const keep = await new Promise<boolean | null>((resolve) => {
      void ask({
        title: t('apps.removeTitle', { name: a.title }),
        body: <KeepDataChoice id={a.id} onChange={(v) => (keepChoice = v)} />,
        confirmLabel: t('apps.remove'),
        danger: true,
      }).then((ok) => resolve(ok ? keepChoice : null));
    });
    if (keep === null) return;
    if (keep) return run(`/api/apps/${a.id}`, { method: 'DELETE', body: { deleteData: false } });
    const sure = await ask({
      title: t('apps.deleteDataTitle', { name: a.title }),
      body: t('apps.deleteDataBody', { id: a.id }),
      typeToConfirm: a.id,
      confirmLabel: t('common.delete'),
      danger: true,
    });
    if (sure) await run(`/api/apps/${a.id}`, { method: 'DELETE', body: { deleteData: true, confirmName: a.id } });
  };
}

export function Apps() {
  const { t } = useI18n();
  const ask = useConfirm();
  const [, navigate] = useLocation();
  const { data } = usePoll<InstalledApp[]>('/api/apps', 5000);
  const [error, setError] = useState('');

  const run = async (path: string, init: { method?: string; body?: unknown }) => {
    setError('');
    try {
      const { task } = await api<{ task: number }>(path, init);
      navigate(`/tasks/${task}`);
    } catch (e) {
      if (!(e instanceof ApiError && e.code === 'confirm_required')) setError(t('common.error'));
    }
  };

  const update = async (a: InstalledApp) => {
    if (await ask({ title: t('apps.updateTitle', { name: a.title }), body: t('apps.updateBody') })) await run(`/api/apps/${a.id}/update`, { body: {} });
  };
  const rollback = async (a: InstalledApp) => {
    if (await ask({ title: t('apps.rollbackTitle', { name: a.title }), body: t('apps.rollbackBody') })) await run(`/api/apps/${a.id}/rollback`, { body: {} });
  };
  const remove = useRemoveApp(run);

  return (
    <>
      <PageHeader title={t('apps.title')} back="/store" />
      <main className="safe-bottom mx-auto max-w-md space-y-3 px-3">
        {data?.length === 0 && (
          <Card>
            <p className="text-sm text-muted">{t('apps.empty')}</p>
          </Card>
        )}
        {data?.map((a) => (
          <Card key={a.id}>
            <div className="flex items-center gap-3">
              <InstalledAppIcon id={a.id} title={a.title} size={48} />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-ink">{a.title}</p>
                <p className="text-xs text-muted">
                  {a.busy ? t('apps.busy') : t(`apps.status.${a.status}` as MessageKey)}
                  {a.state && ` · ${a.state}`}
                </p>
              </div>
              {a.url && (
                <a {...externalLink(a.url)} className="rounded-full bg-primary px-4 py-2 text-sm font-medium text-white">
                  {t('store.open')}
                </a>
              )}
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2">
              <Button variant="secondary" className="min-h-10 text-sm" disabled={a.busy} onClick={() => void update(a)}>
                {t('apps.update')}
              </Button>
              <Button variant="secondary" className="min-h-10 text-sm" disabled={a.busy || !a.canRollback} onClick={() => void rollback(a)}>
                {t('apps.rollback')}
              </Button>
              <Button variant="secondary" className="min-h-10 text-sm text-danger" disabled={a.busy} onClick={() => void remove(a)}>
                {t('apps.remove')}
              </Button>
            </div>
          </Card>
        ))}
        <ErrorText>{error}</ErrorText>
      </main>
    </>
  );
}

let keepChoice = true;

function KeepDataChoice({ id, onChange }: { id: string; onChange: (keep: boolean) => void }) {
  const { t } = useI18n();
  const [keep, setKeep] = useState(true);
  keepChoice = keep;
  return (
    <label className="flex items-start gap-3 rounded-xl bg-canvas p-3">
      <input
        type="checkbox"
        className="mt-1 size-5 accent-[var(--color-primary)]"
        checked={keep}
        onChange={(e) => {
          setKeep(e.target.checked);
          onChange(e.target.checked);
        }}
      />
      <span>
        <span className="block text-sm font-medium text-ink">{t('apps.keepData')}</span>
        <span className="block text-xs text-muted">{t('apps.keepDataHint', { id })}</span>
      </span>
    </label>
  );
}
