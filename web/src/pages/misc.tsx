import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useI18n } from '../i18n';
import { Card, ListGroup, ListRow, PageHeader } from '../components/ui';

export function Placeholder({ title }: { title: string }) {
  const { t } = useI18n();
  return (
    <>
      <PageHeader title={title} back="/" />
      <main className="mx-auto max-w-md px-3">
        <Card>
          <p className="text-sm text-muted">{t('common.comingSoon')}</p>
        </Card>
      </main>
    </>
  );
}

export function About() {
  const { t } = useI18n();
  const [version, setVersion] = useState('…');
  useEffect(() => {
    api<{ version: string }>('/api/health').then((h) => setVersion(h.version));
  }, []);
  return (
    <>
      <PageHeader title={t('settings.about')} back="/settings" />
      <main className="safe-bottom mx-auto max-w-md space-y-4 px-3">
        <ListGroup>
          <ListRow label={t('app.name')} trailing={<span className="text-sm text-muted">{location.hostname.split('.')[0]}</span>} />
          <ListRow label={t('about.version')} trailing={<span className="text-sm text-muted">{version}</span>} />
        </ListGroup>
        <p className="px-2 text-xs text-muted">{t('about.licenses')}</p>
      </main>
    </>
  );
}
