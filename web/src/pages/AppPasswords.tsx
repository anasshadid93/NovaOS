import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useI18n } from '../i18n';
import { Card, PageHeader } from '../components/ui';

/** Settings → App passwords: logins of the apps on the server, hidden until tapped. */
interface Item {
  app: string;
  url: string | null;
  username: string | null;
  password: string;
}
const NAMES: Record<string, string> = {
  qbittorrent: 'qBittorrent',
  jellyfin: 'Jellyfin',
  audiobookshelf: 'Audiobookshelf',
  paperless: 'Paperless',
  uptimekuma: 'Uptime Kuma',
  'adguard-home': 'AdGuard Home',
  arabp2p: 'ArabP2P',
};

export function AppPasswords() {
  const { t } = useI18n();
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    api<{ items: Item[] }>('/api/app-credentials')
      .then((r) => setItems(r.items))
      .catch((e: Error) => setError(e.message));
    // Hide everything again when leaving the page.
    return () => setItems(null);
  }, []);
  const copy = async (key: string, text: string) => {
    await navigator.clipboard?.writeText(text).catch(() => null);
    setCopied(key);
    setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
  };
  const toggle = (app: string) =>
    setShown((s) => {
      const n = new Set(s);
      if (n.has(app)) n.delete(app);
      else n.add(app);
      return n;
    });
  return (
    <>
      <PageHeader title={t('pw.title')} back="/settings" />
      <main className="safe-bottom mx-auto max-w-md space-y-3 px-3">
        <p className="px-1 text-sm text-muted">{t('pw.hint')}</p>
        {error && <Card>{error}</Card>}
        {!items && !error && <p className="p-6 text-center text-sm text-muted">…</p>}
        {items?.map((c) => (
          <Card key={c.app}>
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-semibold text-heading">{NAMES[c.app] ?? c.app}</h2>
              {c.url && (
                <a href={c.url} target="_blank" rel="noreferrer" className="text-sm text-primary">
                  {t('pw.open')}
                </a>
              )}
            </div>
            {c.username && <Field label={t('pw.user')} value={c.username} onCopy={() => void copy(`${c.app}-u`, c.username!)} copied={copied === `${c.app}-u`} copyLabel={t('pw.copy')} copiedLabel={t('pw.copied')} />}
            <Field
              label={t('pw.password')}
              value={shown.has(c.app) ? c.password : '••••••••••'}
              onCopy={() => void copy(`${c.app}-p`, c.password)}
              copied={copied === `${c.app}-p`}
              copyLabel={t('pw.copy')}
              copiedLabel={t('pw.copied')}
              extra={
                <button type="button" onClick={() => toggle(c.app)} className="min-h-9 rounded-lg px-2 text-sm text-primary">
                  {shown.has(c.app) ? t('pw.hide') : t('pw.show')}
                </button>
              }
            />
          </Card>
        ))}
      </main>
    </>
  );
}

function Field({ label, value, onCopy, copied, copyLabel, copiedLabel, extra }: { label: string; value: string; onCopy: () => void; copied: boolean; copyLabel: string; copiedLabel: string; extra?: React.ReactNode }) {
  return (
    <div className="mt-2 flex items-center gap-2 rounded-xl bg-canvas px-3 py-1.5">
      <span className="min-w-0 flex-1">
        <span className="block text-xs text-muted">{label}</span>
        <span className="block break-all font-mono text-sm text-ink" dir="ltr">
          {value}
        </span>
      </span>
      {extra}
      <button type="button" onClick={onCopy} className="min-h-9 rounded-lg px-2 text-sm text-primary">
        {copied ? copiedLabel : copyLabel}
      </button>
    </div>
  );
}
