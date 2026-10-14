import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { Apps24Regular, Search20Regular } from '@fluentui/react-icons';
import { ApiError, api } from '../lib/api';
import { usePoll } from '../lib/usePoll';
import { useI18n } from '../i18n';
import { AppIcon } from '../components/AppIcon';
import { Button, Card, ErrorText, PageHeader } from '../components/ui';
import { DockerUnavailable } from './Docker';
import { externalLink } from '../lib/external';

interface StoreApp {
  id: string;
  title: string;
  tagline: string;
  category: string;
  icon: string;
  hasWeb: boolean;
  installed: string | null;
}

interface StoreList {
  source: { commit: string };
  categories: string[];
  apps: StoreApp[];
}

export function Store() {
  const { t } = useI18n();
  const [data, setData] = useState<StoreList | null>(null);
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<string | null>(null);
  const query = useDeferredValue(q.trim().toLowerCase());
  useEffect(() => {
    api<StoreList>('/api/store/apps').then(setData);
  }, []);

  const apps = useMemo(
    () =>
      (data?.apps ?? []).filter(
        (a) => (!cat || (cat === '__installed' ? a.installed : a.category === cat)) && (!query || a.title.toLowerCase().includes(query) || a.tagline.toLowerCase().includes(query)),
      ),
    [data, cat, query],
  );

  const chip = (active: boolean) => `min-h-9 shrink-0 rounded-full px-3 text-sm ${active ? 'bg-primary text-white' : 'bg-surface text-ink shadow-card'}`;

  return (
    <>
      <PageHeader
        title={t('store.title')}
        back="/"
        actions={
          <Link href="/apps" className="inline-flex min-h-10 items-center gap-1 rounded-full px-3 text-sm text-primary-ink" aria-label={t('apps.title')}>
            <Apps24Regular aria-hidden />
            {t('apps.title')}
          </Link>
        }
      />
      <main className="safe-bottom mx-auto max-w-md space-y-3 px-3">
        <label className="flex min-h-11 items-center gap-2 rounded-xl bg-surface px-3 shadow-card">
          <Search20Regular className="text-muted" aria-hidden />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('store.search')} aria-label={t('store.search')} className="min-w-0 flex-1 bg-transparent text-base text-ink outline-none" />
        </label>
        <div className="-mx-3 flex gap-2 overflow-x-auto px-3 pb-1">
          <button type="button" className={chip(cat === null)} onClick={() => setCat(null)} aria-pressed={cat === null}>
            {t('store.all')}
          </button>
          <button type="button" className={chip(cat === '__installed')} onClick={() => setCat('__installed')} aria-pressed={cat === '__installed'}>
            {t('store.installed')}
          </button>
          {data?.categories.map((c) => (
            <button key={c} type="button" className={chip(cat === c)} onClick={() => setCat(c)} aria-pressed={cat === c}>
              {c}
            </button>
          ))}
        </div>
        <ul className="overflow-hidden rounded-list bg-surface shadow-card">
          {data && apps.length === 0 && <li className="p-6 text-center text-sm text-muted">{t('store.empty')}</li>}
          {apps.map((a) => (
            <li key={a.id} className="border-line [&+&]:border-t">
              <Link href={`/store/${a.id}`} className="flex items-center gap-3 px-4 py-3 active:bg-primary-soft">
                <AppIcon icon={a.icon} title={a.title} size={48} />
                <span className="min-w-0 flex-1">
                  <span dir="auto" className="block truncate text-start font-medium text-ink">{a.title}</span>
                  <span dir="auto" className="line-clamp-2 text-start text-xs text-muted">{a.tagline || a.category}</span>
                </span>
                {a.installed && <span className="shrink-0 rounded-full bg-primary-soft px-2 py-0.5 text-xs text-primary-ink">{t('store.installed')}</span>}
              </Link>
            </li>
          ))}
        </ul>
        {data && <p className="px-2 text-[11px] text-muted">{t('store.notice', { commit: data.source.commit.slice(0, 7) })}</p>}
      </main>
    </>
  );
}

interface AppDetail {
  id: string;
  title: string;
  tagline: string;
  category: string;
  icon: string;
  description: string;
  developer: string;
  tips: string | null;
  services: { name: string; image: string }[];
  source: { repo: string; commit?: string; path?: string };
  installed: { status: string; url: string | null } | null;
  busy: boolean;
}

export function StoreApp({ params }: { params: { id: string } }) {
  const { t } = useI18n();
  const [, navigate] = useLocation();
  const [app, setApp] = useState<AppDetail | null>(null);
  const [error, setError] = useState('');
  const docker = usePoll<{ ok: boolean; error?: string }>('/api/docker/status', 15000);
  useEffect(() => {
    api<AppDetail>(`/api/store/apps/${params.id}`).then(setApp);
  }, [params.id]);

  const install = async () => {
    setError('');
    try {
      const { task } = await api<{ task: number }>(`/api/store/apps/${params.id}/install`, { body: {} });
      navigate(`/tasks/${task}`);
    } catch (e) {
      setError(e instanceof ApiError && e.code === 'docker_unavailable' ? t('store.dockerNeeded') : t('common.error'));
    }
  };

  if (!app) return <PageHeader title="…" back="/store" />;
  return (
    <>
      <PageHeader title={app.title} back="/store" />
      <main className="safe-bottom mx-auto max-w-md space-y-4 px-3">
        <Card>
          <div className="flex items-center gap-4">
            <AppIcon icon={app.icon} title={app.title} size={64} />
            <div className="min-w-0">
              <p className="text-lg font-semibold text-heading">{app.title}</p>
              <p className="text-xs text-muted">
                {app.category}
                {app.developer && ` · ${t('store.by', { who: app.developer })}`}
              </p>
            </div>
          </div>
          <div className="mt-4">
            {app.installed ? (
              app.installed.url ? (
                <a {...externalLink(app.installed.url)} className="inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-primary font-medium text-white">
                  {t('store.open')}
                </a>
              ) : (
                <Button variant="secondary" className="w-full" onClick={() => navigate('/apps')}>
                  {t('apps.title')}
                </Button>
              )
            ) : (
              <Button className="w-full" onClick={() => void install()} disabled={app.busy || docker.data?.ok === false}>
                {app.busy ? t('store.installing') : t('store.install')}
              </Button>
            )}
            <ErrorText>{error}</ErrorText>
          </div>
        </Card>
        {docker.data && !docker.data.ok && !app.installed && <DockerUnavailable error={docker.data.error} />}
        {app.tagline && <p dir="auto" className="px-1 text-start font-medium text-ink">{app.tagline}</p>}
        <Card>
          <p dir="auto" className="whitespace-pre-line text-start text-sm leading-relaxed text-ink">{app.description}</p>
        </Card>
        {app.tips && (
          <Card title={t('store.tips')}>
            <p dir="auto" className="whitespace-pre-line text-start text-sm text-ink">{app.tips}</p>
          </Card>
        )}
        <Card title={t('store.services')}>
          <ul className="space-y-1 text-xs" dir="ltr">
            {app.services.map((s) => (
              <li key={s.name} className="flex justify-between gap-2">
                <span className="text-muted">{s.name}</span>
                <span className="truncate text-ink">{s.image}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[11px] text-muted" dir="ltr">
            {t('store.source')}: {app.source.repo}
            {app.source.commit ? `@${app.source.commit.slice(0, 7)}` : ''} {app.source.path}
          </p>
        </Card>
      </main>
    </>
  );
}
