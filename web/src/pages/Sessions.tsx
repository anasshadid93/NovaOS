import { useCallback, useEffect, useState } from 'react';
import { Phone24Filled } from '@fluentui/react-icons';
import { api } from '../lib/api';
import { useI18n } from '../i18n';
import { Button, ListGroup, ListRow, PageHeader } from '../components/ui';

interface SessionInfo {
  id: string;
  method: 'passkey' | 'password';
  userAgent: string | null;
  lastSeenAt: number;
  current: boolean;
}

function deviceName(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const m = ua.match(/\(([^)]+)\)/)?.[1].split(';').map((s) => s.trim());
  const browser = /Firefox\//.test(ua) ? 'Firefox' : /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = m?.find((p) => /Android|iPhone|iPad|Windows|Mac OS|Linux/.test(p)) ?? '';
  return `${browser}${os ? ` · ${os}` : ''}`;
}

export function Sessions() {
  const { t, formatRelative } = useI18n();
  const [list, setList] = useState<SessionInfo[]>([]);
  const load = useCallback(() => api<SessionInfo[]>('/api/auth/sessions').then(setList), []);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <PageHeader title={t('settings.sessions')} back="/settings" />
      <main className="safe-bottom mx-auto max-w-md px-3">
        <ListGroup>
          {list.map((s) => (
            <ListRow
              key={s.id}
              icon={Phone24Filled}
              color={s.current ? 'green' : 'slate'}
              label={s.current ? `${deviceName(s.userAgent)} · ${t('sessions.current')}` : deviceName(s.userAgent)}
              detail={`${t(`sessions.method.${s.method}`)} · ${formatRelative(s.lastSeenAt)}`}
              trailing={
                !s.current && (
                  <Button
                    variant="ghost"
                    className="min-h-10 px-2 text-sm text-danger"
                    onClick={async () => {
                      await api(`/api/auth/sessions/${s.id}`, { method: 'DELETE' });
                      await load();
                    }}
                  >
                    {t('sessions.revoke')}
                  </Button>
                )
              }
            />
          ))}
        </ListGroup>
      </main>
    </>
  );
}
