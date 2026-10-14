import { useCallback, useEffect, useState } from 'react';
import { Add24Regular, Delete24Regular, Key24Filled } from '@fluentui/react-icons';
import { api } from '../lib/api';
import { passkeysSupported, registerPasskey, useAuth } from '../lib/auth';
import { useI18n } from '../i18n';
import { useConfirm } from '../components/ConfirmProvider';
import { Button, ErrorText, ListGroup, ListRow, PageHeader } from '../components/ui';

interface Passkey {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
}

export function Passkeys() {
  const { t, formatRelative } = useI18n();
  const ask = useConfirm();
  const { refresh } = useAuth();
  const [list, setList] = useState<Passkey[] | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => api<Passkey[]>('/api/auth/passkeys').then(setList), []);
  useEffect(() => {
    void load();
  }, [load]);

  const add = async () => {
    setError('');
    const name = prompt(t('passkeys.namePrompt'))?.trim();
    if (name === undefined) return;
    try {
      await registerPasskey(name || 'Passkey');
      await Promise.all([load(), refresh()]);
    } catch {
      setError(t('common.error'));
    }
  };

  const remove = async (p: Passkey) => {
    const ok = await ask({ title: t('passkeys.deleteTitle'), body: t('passkeys.deleteBody', { name: p.name }), confirmLabel: t('common.delete'), danger: true });
    if (!ok) return;
    try {
      await api(`/api/auth/passkeys/${encodeURIComponent(p.id)}`, { method: 'DELETE' });
      await Promise.all([load(), refresh()]);
    } catch {
      setError(t('common.error'));
    }
  };

  return (
    <>
      <PageHeader title={t('settings.passkeys')} back="/settings" />
      <main className="safe-bottom mx-auto max-w-md space-y-4 px-3">
        {list && (
          <ListGroup>
            {list.length === 0 && <ListRow label={t('passkeys.empty')} />}
            {list.map((p) => (
              <ListRow
                key={p.id}
                icon={Key24Filled}
                label={p.name}
                detail={p.lastUsedAt ? t('passkeys.lastUsed', { when: formatRelative(p.lastUsedAt) }) : t('passkeys.never')}
                trailing={
                  <button
                    type="button"
                    onClick={() => void remove(p)}
                    className="inline-flex size-10 items-center justify-center rounded-full text-danger"
                    aria-label={`${t('common.delete')} ${p.name}`}
                  >
                    <Delete24Regular aria-hidden />
                  </button>
                }
              />
            ))}
          </ListGroup>
        )}
        <ErrorText>{error}</ErrorText>
        {passkeysSupported() ? (
          <Button className="w-full" onClick={() => void add()}>
            <Add24Regular aria-hidden />
            {t('passkeys.add')}
          </Button>
        ) : (
          <p className="text-sm text-muted">{t('passkeys.unsupported')}</p>
        )}
      </main>
    </>
  );
}
