import { PlugDisconnected24Filled } from '@fluentui/react-icons';
import { useI18n, type MessageKey } from '../i18n';
import { usePoll } from '../lib/usePoll';
import { Card, ListGroup, PageHeader } from '../components/ui';

type Needs = { kind: 'config'; key: string } | { kind: 'file'; name: string } | { kind: 'setting'; route: string } | { kind: 'install'; path: string } | { kind: 'api'; call: string };
interface Data {
  plugins: { id: string; enabled: boolean; needs: Needs; detail: string }[];
  configFile: string;
}

/** Settings → Integrations: which optional connections are on, and what turns the others on. */
export function Integrations() {
  const { t } = useI18n();
  const { data } = usePoll<Data>('/api/settings/integrations', 30_000);

  const how = (n: Needs) => {
    const file = data?.configFile.split('/').slice(-2).join('/') ?? 'manar.json';
    if (n.kind === 'config') return t('int.needsConfig', { key: n.key, file });
    if (n.kind === 'file') return t('int.needsFile', { name: n.name });
    if (n.kind === 'install') return t('int.needsInstall', { path: n.path });
    if (n.kind === 'api') return t('int.needsApi', { call: n.call });
    return t('int.needsSetting');
  };

  return (
    <>
      <PageHeader title={t('settings.integrations')} back="/settings" />
      <main className="safe-bottom mx-auto max-w-md px-3">
      <p className="mb-4 px-2 text-sm text-muted">{t('int.hint')}</p>
      <ListGroup>
        {(data?.plugins ?? []).map((p) => {
          const name = `int.${p.id}` as MessageKey;
          const desc = `int.${p.id}.desc` as MessageKey;
          const row = (
            <div className="flex items-start gap-3">
              <span className="min-w-0 flex-1">
                <span className="block font-medium text-ink">{t(name)}</span>
                <span className="block text-xs text-muted">{t(desc)}</span>
                <span className="mt-1 block text-xs text-muted" dir="ltr">
                  {p.enabled ? p.detail : how(p.needs)}
                </span>
              </span>
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${p.enabled ? 'bg-primary/10 text-primary' : 'bg-line text-muted'}`}>
                {p.enabled ? t('int.on') : t('int.off')}
              </span>
            </div>
          );
          return (
            <li key={p.id} className="border-b border-line last:border-0">
              {p.needs.kind === 'setting' && !p.enabled ? (
                <a href={p.needs.route} className="block px-4 py-3">
                  {row}
                </a>
              ) : (
                <div className="px-4 py-3">{row}</div>
              )}
            </li>
          );
        })}
      </ListGroup>
      {data && data.plugins.every((p) => !p.enabled) && (
        <Card className="mt-4">
          <p className="flex items-center gap-2 text-sm text-muted">
            <PlugDisconnected24Filled aria-hidden /> {t('int.off')}
          </p>
        </Card>
      )}
      </main>
    </>
  );
}
