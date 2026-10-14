import { useState } from 'react';
import { Fingerprint24Filled } from '@fluentui/react-icons';
import { ApiError, api } from '../lib/api';
import { loginWithPasskey, passkeysSupported, useAuth } from '../lib/auth';
import { InstallCard } from '../components/InstallCard';
import { useI18n } from '../i18n';
import { Brand } from '../components/Brand';
import { Button, ErrorText, TextField } from '../components/ui';

export function Login() {
  const { t } = useI18n();
  const { refresh } = useAuth();
  const canPasskey = passkeysSupported();
  const [mode, setMode] = useState<'passkey' | 'password'>(canPasskey ? 'passkey' : 'password');
  const [form, setForm] = useState({ username: '', password: '', code: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const fail = (err: unknown, fallback: string) =>
    setError(err instanceof ApiError && err.status === 429 ? t('login.rateLimited') : fallback);

  const passkey = async () => {
    setBusy(true);
    setError('');
    try {
      await loginWithPasskey();
      await refresh();
    } catch (err) {
      fail(err, t('login.passkeyFailed'));
    } finally {
      setBusy(false);
    }
  };

  const password = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/api/auth/password', { body: form });
      await refresh();
    } catch (err) {
      fail(err, t('login.failed'));
      setForm((f) => ({ ...f, code: '' }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="safe-top safe-bottom mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-5">
      <Brand subtitle={t('login.subtitle')} />
      <InstallCard />
      <div className="card space-y-4 p-5">
        <h1 className="text-lg font-semibold text-heading">{t('login.title')}</h1>
        {mode === 'passkey' ? (
          <>
            <Button className="w-full" onClick={passkey} disabled={busy}>
              <Fingerprint24Filled aria-hidden />
              {t('login.passkey')}
            </Button>
            <ErrorText>{error}</ErrorText>
            <Button variant="ghost" className="w-full" onClick={() => (setMode('password'), setError(''))}>
              {t('login.usePassword')}
            </Button>
          </>
        ) : (
          <form className="space-y-4" onSubmit={password}>
            <TextField
              label={t('login.username')}
              autoComplete="username webauthn"
              autoCapitalize="off"
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
              required
            />
            <TextField
              label={t('login.password')}
              type="password"
              autoComplete="current-password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              required
            />
            <TextField
              label={t('login.code')}
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value.replace(/\D/g, '').slice(0, 6) })}
              required
            />
            <ErrorText>{error}</ErrorText>
            <Button type="submit" className="w-full" disabled={busy}>
              {t('login.submit')}
            </Button>
            {canPasskey && (
              <Button variant="ghost" className="w-full" onClick={() => (setMode('passkey'), setError(''))}>
                {t('login.usePasskey')}
              </Button>
            )}
          </form>
        )}
      </div>
    </main>
  );
}
