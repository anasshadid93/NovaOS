import { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import { ArrowClockwise16Regular, ArrowSync20Regular, ShieldError20Filled, Warning20Filled } from '@fluentui/react-icons';
import { ApiError, api } from '../lib/api';
import { useI18n } from '../i18n';
import { useConfirm } from '../components/ConfirmProvider';
import { Card, PageHeader } from '../components/ui';

interface Sys {
  updates: { name: string; from: string; to: string; security: boolean }[];
  held: { name: string; from: string; to: string }[];
  security: number;
  disruptive: string[];
  rebootRequired: boolean;
  rebootPkgs: string[];
  checkedAt: number | null;
}
interface AppUpd {
  container: string;
  app: string | null;
  image: string;
  tag: string;
  rebuilt: boolean;
  newerTag: string | null;
}

interface SelfUpd {
  current: { version: string; tag: string | null; commit: string | null };
  repo: string;
  latest: { tag: string; name: string; notes: string; publishedAt: string; url: string } | null;
  error: string | null;
  available: boolean;
  blocked: 'local_changes' | null;
  canRollback: boolean;
  last: { status: 'ok' | 'rolled_back' | 'failed'; tag: string; at: number; reason?: string } | null;
  pending: { tag: string } | null;
}

/** NovaOS itself (GitHub Releases), system packages, and newer versions of the apps (containers). */
export function Updates() {
  const { t, tn, formatRelative } = useI18n();
  const ask = useConfirm();
  const [, navigate] = useLocation();
  const [sys, setSys] = useState<Sys | null>(null);
  const [self, setSelf] = useState<SelfUpd | null>(null);
  const [apps, setApps] = useState<{ at: number; list: AppUpd[] } | null>(null);
  const [checking, setChecking] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [err, setErr] = useState('');

  const load = () => {
    void api<Sys>('/api/updates/system').then(setSys);
    void api<SelfUpd>('/api/updates/self').then(setSelf);
    void api<{ at: number; list: AppUpd[] }>('/api/updates/apps').then(setApps);
  };
  useEffect(load, []);

  const runTask = async (path: string, body: unknown = {}) => {
    setErr('');
    try {
      const { task } = await api<{ task: number }>(path, { body });
      navigate(`/tasks/${task}`);
    } catch (e) {
      if (!(e instanceof ApiError && e.code === 'confirm_required')) setErr(t('common.error'));
    }
  };
  const install = async () => {
    if (!sys) return;
    const ok = await ask({
      title: tn('upd.installTitle', sys.updates.length),
      body: (
        <div className="space-y-2">
          <p>{t('upd.installBody')}</p>
          {sys.disruptive.length > 0 && <p className="text-warn">{t('upd.disruptive', { list: sys.disruptive.join(', ') })}</p>}
        </div>
      ),
      confirmLabel: t('upd.install'),
    });
    if (ok) await runTask('/api/updates/system/install');
  };
  const selfUpdate = async () => {
    if (!self?.latest) return;
    const ok = await ask({ title: t('self.updateTitle', { tag: self.latest.tag }), body: <p>{t('self.updateBody')}</p>, confirmLabel: t('upd.update') });
    if (ok) await runTask('/api/updates/self');
  };
  const selfRollback = async () => {
    const ok = await ask({ title: t('self.rollbackTitle'), body: <p>{t('self.rollbackBody')}</p>, confirmLabel: t('self.rollback') });
    if (!ok) return;
    setErr('');
    try {
      await api('/api/updates/self/rollback', { body: {} });
      setTimeout(() => window.location.reload(), 6000);
    } catch (e) {
      if (!(e instanceof ApiError && e.code === 'confirm_required')) setErr(t('common.error'));
    }
  };
  const checkApps = async () => {
    setChecking(true);
    try {
      setApps(await api<{ at: number; list: AppUpd[] }>('/api/updates/apps/check', { body: {} }));
    } finally {
      setChecking(false);
    }
  };

  const pending = apps?.list.filter((a) => a.rebuilt || a.newerTag) ?? [];
  const shown = sys ? (showAll ? sys.updates : sys.updates.slice(0, 12)) : [];

  return (
    <>
      <PageHeader title={t('upd.title')} back="/settings" />
      <main className="safe-bottom mx-auto max-w-md space-y-4 px-3">
        {err && <p className="text-sm text-danger">{err}</p>}
        <Card
          title={t('self.title')}
          action={
            <button type="button" onClick={() => void api<SelfUpd>('/api/updates/self?refresh=1').then(setSelf)} className="inline-flex items-center gap-1 rounded-full px-3 py-1 text-sm text-primary-ink hover:bg-primary-soft">
              <ArrowClockwise16Regular aria-hidden />
              {t('upd.check')}
            </button>
          }
        >
          {!self ? (
            <p className="text-sm text-muted">{t('common.loading')}</p>
          ) : (
            <div className="space-y-3 text-sm">
              <p className="text-ink" dir="ltr">
                {t('self.version', { v: self.current.tag ?? `${self.current.version}${self.current.commit ? ` (${self.current.commit})` : ''}` })}
              </p>
              {self.pending && <p className="text-muted">{t('self.pending', { tag: self.pending.tag })}</p>}
              {self.error ? (
                <p className="text-warn">{self.error === 'no_releases' ? t('self.noReleases') : t('self.checkFailed', { err: self.error })}</p>
              ) : self.latest && self.available ? (
                <>
                  <p className="text-ink">{t('self.latest', { tag: self.latest.tag })}</p>
                  {self.latest.notes && (
                    <details className="rounded-xl bg-canvas px-3 py-2">
                      <summary className="cursor-pointer text-muted">{t('self.notes')}</summary>
                      <pre className="mt-2 whitespace-pre-wrap font-sans text-xs text-ink" dir="auto">{self.latest.notes}</pre>
                    </details>
                  )}
                  {self.blocked === 'local_changes' ? (
                    <p className="text-warn">{t('self.localChanges')}</p>
                  ) : (
                    <button type="button" onClick={() => void selfUpdate()} className="min-h-11 w-full rounded-xl bg-primary font-medium text-white">
                      {t('self.update', { tag: self.latest.tag })}
                    </button>
                  )}
                </>
              ) : (
                <p className="text-ok">{t('self.upToDate')}</p>
              )}
              {self.last?.status === 'ok' && <p className="text-xs text-muted">{t('self.lastOk', { tag: self.last.tag, when: formatRelative(self.last.at) })}</p>}
              {self.last?.status === 'rolled_back' && <p className="text-xs text-warn">{t('self.lastRolledBack', { tag: self.last.tag, when: formatRelative(self.last.at), reason: self.last.reason ?? '' })}</p>}
              {self.canRollback && (
                <button type="button" onClick={() => void selfRollback()} className="text-sm text-primary-ink">
                  {t('self.rollback')}
                </button>
              )}
            </div>
          )}
        </Card>
        <Card
          title={t('upd.system')}
          action={
            <button type="button" onClick={() => void runTask('/api/updates/system/refresh')} className="inline-flex items-center gap-1 rounded-full px-3 py-1 text-sm text-primary-ink hover:bg-primary-soft">
              <ArrowClockwise16Regular aria-hidden />
              {t('upd.check')}
            </button>
          }
        >
          {!sys ? (
            <p className="text-sm text-muted">{t('common.loading')}</p>
          ) : (
            <div className="space-y-3">
              {sys.rebootRequired && (
                <p className="flex items-start gap-2 rounded-xl bg-warn/10 p-3 text-sm text-ink">
                  <Warning20Filled className="mt-0.5 shrink-0 text-warn" aria-hidden />
                  <span>
                    {t('upd.reboot')}
                    {sys.rebootPkgs.length > 0 && <span className="block text-xs text-muted" dir="ltr">{sys.rebootPkgs.join(', ')}</span>}
                  </span>
                </p>
              )}
              {sys.updates.length === 0 ? (
                <p className="text-sm text-ok">{t('upd.upToDate')}</p>
              ) : (
                <>
                  <p className="text-sm text-ink">
                    {tn('upd.available', sys.updates.length)}
                    {sys.security > 0 && (
                      <span className="ms-2 inline-flex items-center gap-1 rounded-full bg-danger/10 px-2 py-0.5 text-xs text-danger-ink">
                        <ShieldError20Filled className="size-4" aria-hidden />
                        {tn('upd.security', sys.security)}
                      </span>
                    )}
                  </p>
                  <ul className="divide-y divide-line rounded-xl bg-canvas text-sm" dir="ltr">
                    {shown.map((u) => (
                      <li key={u.name} className="flex items-center justify-between gap-2 px-3 py-1.5">
                        <span className={`truncate ${u.security ? 'font-medium text-danger-ink' : 'text-ink'}`}>{u.name}</span>
                        <span className="shrink-0 text-xs text-muted">
                          {u.from} → {u.to}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {sys.updates.length > shown.length && (
                    <button type="button" onClick={() => setShowAll(true)} className="text-sm text-primary-ink">
                      {t('upd.showAll', { n: sys.updates.length })}
                    </button>
                  )}
                  <button type="button" onClick={() => void install()} className="min-h-11 w-full rounded-xl bg-primary font-medium text-white">
                    {t('upd.installAll')}
                  </button>
                </>
              )}
              {sys.held.length > 0 && (
                <details className="rounded-xl bg-canvas px-3 py-2 text-sm">
                  <summary className="cursor-pointer text-muted">{tn('upd.held', sys.held.length)}</summary>
                  <p className="mt-1 text-xs text-muted">{t('upd.heldWhy')}</p>
                  <ul className="mt-1 text-xs text-muted" dir="ltr">
                    {sys.held.map((u) => (
                      <li key={u.name}>
                        {u.name} {u.from} → {u.to}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {sys.checkedAt && <p className="text-xs text-muted">{t('upd.listsFrom', { when: formatRelative(sys.checkedAt) })}</p>}
            </div>
          )}
        </Card>

        <Card
          title={t('upd.apps')}
          action={
            <button type="button" disabled={checking} onClick={() => void checkApps()} className="inline-flex items-center gap-1 rounded-full px-3 py-1 text-sm text-primary-ink hover:bg-primary-soft disabled:opacity-50">
              <ArrowSync20Regular className={`size-4 ${checking ? 'animate-spin' : ''}`} aria-hidden />
              {checking ? t('upd.checking') : t('upd.check')}
            </button>
          }
        >
          {!apps?.at ? (
            <p className="text-sm text-muted">{t('upd.appsNotChecked')}</p>
          ) : pending.length === 0 ? (
            <p className="text-sm text-ok">{tn('upd.appsUpToDate', apps.list.length)}</p>
          ) : (
            <ul className="space-y-2">
              {pending.map((a) => (
                <li key={a.container} className="flex items-center gap-3 rounded-xl bg-canvas p-3">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-ink" dir="ltr">
                      {a.container.replace(/^manar-/, '')}
                    </span>
                    <span className="block truncate text-xs text-muted" dir="ltr">
                      {a.newerTag ? `${a.tag} → ${a.newerTag}` : `${a.tag} · ${t('upd.rebuilt')}`}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      void (a.newerTag && a.app
                        ? runTask('/api/updates/apps/retag', { app: a.app, from: a.image, to: a.newerTag })
                        : runTask(`/api/docker/containers/${encodeURIComponent(a.container)}/update`))
                    }
                    className="shrink-0 rounded-full bg-primary px-3 py-1.5 text-sm font-medium text-white"
                  >
                    {t('upd.update')}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {apps?.at ? <p className="mt-2 text-xs text-muted">{t('upd.checkedAt', { when: formatRelative(apps.at) })}</p> : null}
        </Card>
      </main>
    </>
  );
}
