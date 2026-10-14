import { useEffect, useState } from 'react';
import { ArrowDownload24Filled, Open24Regular } from '@fluentui/react-icons';
import { api } from '../lib/api';
import { formatBytes } from '../lib/format';
import { useI18n } from '../i18n';
import { Card, PageHeader } from '../components/ui';

interface Info {
  local: { size: number; mtime: number } | null;
  github: string;
  repo: string;
  origin: string;
}

/** Settings → Android app: where to get the APK and how to install it. */
export function AndroidApp() {
  const { t } = useI18n();
  const [info, setInfo] = useState<Info | null>(null);
  useEffect(() => {
    void api<Info>('/api/app/info').then(setInfo);
  }, []);
  const btn = 'inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl font-medium';
  return (
    <>
      <PageHeader title={t('settings.android')} back="/settings" />
      <main className="safe-bottom mx-auto max-w-md space-y-4 px-3">
        <Card>
          <p className="text-sm text-muted">{t('android.hint')}</p>
        </Card>
        {info && (
          <Card title={t('android.download')}>
            <div className="space-y-3 text-sm">
              {info.local && (
                <a href="/api/app/apk" download="MinisManager.apk" className={`${btn} bg-primary text-white`}>
                  <ArrowDownload24Filled aria-hidden />
                  {t('android.downloadLocal', { size: formatBytes(info.local.size) })}
                </a>
              )}
              <a href={info.github} target="_blank" rel="noreferrer" className={`${btn} ${info.local ? 'bg-canvas text-primary-ink' : 'bg-primary text-white'}`}>
                <Open24Regular aria-hidden />
                {t('android.github')}
              </a>
              <p className="text-xs text-muted">{t('android.githubHint')}</p>
            </div>
          </Card>
        )}
        <Card>
          <ol className="list-decimal space-y-2 ps-5 text-sm text-ink">
            <li>{t('android.steps', { origin: info?.origin ?? '' })}</li>
            <li>{t('android.tv')}</li>
            <li>{t('android.tailscale')}</li>
          </ol>
        </Card>
      </main>
    </>
  );
}
