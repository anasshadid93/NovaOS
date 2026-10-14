import { useState } from 'react';
import { Checkmark24Filled, Fingerprint24Filled } from '@fluentui/react-icons';
import { ApiError, api } from '../lib/api';
import { passkeysSupported, registerPasskey, useAuth } from '../lib/auth';
import { formatBytes } from '../lib/format';
import { InstallCard } from '../components/InstallCard';
import { useI18n, type MessageKey } from '../i18n';
import { Brand } from '../components/Brand';
import { Button, ErrorText, TextField } from '../components/ui';

const ERRORS: Record<string, MessageKey> = {
  bad_token: 'setup.badToken',
  bad_username: 'setup.badUsername',
  weak_password: 'setup.weakPassword',
  bad_code: 'setup.badCode',
  bad_hostname: 'setup.badHostname',
  bad_publicOrigin: 'setup.badOrigin',
  bad_shareBase: 'setup.badOrigin',
  bad_timezone: 'setup.badTimezone',
  bad_mediaRoot: 'setup.badMediaRoot',
  bad_config: 'setup.badConfig',
  bad_brand: 'setup.badConfig',
  bad_renderNode: 'setup.badConfig',
};

interface Env {
  machine: { hostname: string; os: string; cpus: number; memory: number; timezone: string };
  tailscale: { state: string; dns: string | null; ips: string[] } | null;
  suggestedOrigin: string;
  docker: string | null;
  renderNodes: string[];
  volumes: { id: string; name: string; size: number; used: number | null; removable: boolean; path: string }[];
  current: { brand: string; hostname: string; publicOrigin: string; timezone: string; dataRoot: string; mediaRoot: string; renderNode: string; shareBase: string };
  hasConfigFile: boolean;
}

type Step = 'token' | 'server' | 'storage' | 'account' | 'passkey' | 'done';
const STEPS: { id: Step; label: MessageKey }[] = [
  { id: 'server', label: 'setup.stepServer' },
  { id: 'storage', label: 'setup.stepStorage' },
  { id: 'account', label: 'setup.stepAccount' },
  { id: 'done', label: 'setup.stepDone' },
];

function timezones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
  try {
    return intl.supportedValuesOf?.('timeZone') ?? [];
  } catch {
    return [];
  }
}

/** Waits until the API answers again after the restart that applies the new config. */
async function waitForServer(onSlow: () => void): Promise<void> {
  const started = Date.now();
  // Give the old process a moment to go away so we don't get its answer.
  await new Promise((r) => setTimeout(r, 1500));
  for (;;) {
    try {
      const res = await fetch('/api/health', { cache: 'no-store' });
      if (res.ok) return;
    } catch {
      /* down */
    }
    if (Date.now() - started > 45_000) onSlow();
    await new Promise((r) => setTimeout(r, 1000));
  }
}

export function Setup() {
  const { t } = useI18n();
  const { refresh } = useAuth();
  const [step, setStep] = useState<Step>('token');
  const [token, setToken] = useState('');
  const [env, setEnv] = useState<Env | null>(null);
  const [server, setServer] = useState({ brand: '', hostname: '', publicOrigin: '', timezone: '' });
  const [mediaRoot, setMediaRoot] = useState('');
  const [restarting, setRestarting] = useState<'' | 'wait' | 'slow'>('');
  const [totp, setTotp] = useState<{ secret: string; qrSvg: string } | null>(null);
  const [form, setForm] = useState({ username: '', password: '', code: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const zones = timezones();

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (err) {
      const key = err instanceof ApiError ? ERRORS[err.code] : undefined;
      setError(key ? t(key) : t('common.error'));
    } finally {
      setBusy(false);
    }
  };

  const loadEnv = async () => {
    const e = await api<Env>('/api/setup/env', { body: { token } });
    setEnv(e);
    setServer({
      brand: e.current.brand,
      hostname: e.hasConfigFile ? e.current.hostname : e.machine.hostname,
      publicOrigin: e.hasConfigFile ? e.current.publicOrigin : e.suggestedOrigin,
      timezone: e.hasConfigFile ? e.current.timezone : e.machine.timezone,
    });
    setMediaRoot(e.current.mediaRoot);
    return e;
  };

  const startAccount = async () => {
    setTotp(await api('/api/setup/start', { body: { token } }));
    setStep('account');
  };

  /** Saves server + storage choices; restarts the service when something changed. */
  const saveConfig = async () => {
    const res = await api<{ ok: true; restart: boolean }>('/api/setup/config', {
      body: { token, config: { ...server, mediaRoot, renderNode: env?.renderNodes[0] } },
    });
    if (res.restart) {
      setRestarting('wait');
      await waitForServer(() => setRestarting('slow'));
      setRestarting('');
    }
    await startAccount();
  };

  const stepIndex = STEPS.findIndex((s) => s.id === (step === 'passkey' ? 'account' : step));

  return (
    <main className="safe-top safe-bottom mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-5">
      <Brand />
      {step === 'token' && <InstallCard />}
      <div className="card space-y-4 p-5">
        <h1 className="text-lg font-semibold text-heading">{t('setup.title')}</h1>
        {step !== 'token' && (
          <ol className="flex gap-2 text-xs" aria-label={t('setup.title')}>
            {STEPS.map((s, i) => (
              <li key={s.id} className={`flex-1 border-t-2 pt-1 ${i <= stepIndex ? 'border-primary text-ink' : 'border-line text-muted'}`}>
                {t(s.label)}
              </li>
            ))}
          </ol>
        )}

        {step === 'token' && (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await loadEnv();
                setStep('server');
              });
            }}
          >
            <TextField label={t('setup.token')} hint={t('setup.tokenHint')} value={token} onChange={(e) => setToken(e.target.value)} autoCapitalize="off" autoComplete="off" required />
            <ErrorText>{error}</ErrorText>
            <Button type="submit" className="w-full" disabled={busy}>
              {t('common.continue')}
            </Button>
          </form>
        )}

        {step === 'server' && env && (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              setStep('storage');
            }}
          >
            <div>
              <h2 className="font-medium text-ink">{t('setup.serverTitle')}</h2>
              <p className="text-sm text-muted">{t('setup.serverHint')}</p>
            </div>
            <ul className="space-y-1 text-sm">
              <li className="text-muted">
                {env.machine.os} · {env.machine.cpus} CPU · {formatBytes(env.machine.memory, 0)}
              </li>
              <Fact ok={!!env.tailscale?.dns} text={env.tailscale?.dns ? t('setup.tailscaleOk') : t('setup.tailscaleMissing')} />
              <Fact ok={!!env.docker} text={env.docker ? t('setup.dockerOk', { version: env.docker }) : t('setup.dockerMissing')} />
              <Fact ok={env.renderNodes.length > 0} text={env.renderNodes.length ? `${t('setup.gpu')}: ${env.renderNodes[0]}` : t('setup.gpuNone')} />
            </ul>
            <TextField label={t('setup.brand')} value={server.brand} maxLength={40} onChange={(e) => setServer({ ...server, brand: e.target.value })} required />
            <TextField label={t('setup.hostname')} value={server.hostname} autoCapitalize="off" onChange={(e) => setServer({ ...server, hostname: e.target.value })} required />
            <TextField
              label={t('setup.address')}
              hint={t('setup.addressHint')}
              type="url"
              inputMode="url"
              autoCapitalize="off"
              dir="ltr"
              value={server.publicOrigin}
              onChange={(e) => setServer({ ...server, publicOrigin: e.target.value })}
              required
            />
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-ink">{t('setup.timezone')}</span>
              {zones.length ? (
                <select
                  className="block min-h-12 w-full rounded-xl border border-line bg-surface px-3 text-base text-ink outline-none focus:border-primary"
                  value={server.timezone}
                  onChange={(e) => setServer({ ...server, timezone: e.target.value })}
                >
                  {!zones.includes(server.timezone) && <option value={server.timezone}>{server.timezone}</option>}
                  {zones.map((z) => (
                    <option key={z} value={z}>
                      {z}
                    </option>
                  ))}
                </select>
              ) : (
                <input className="block min-h-12 w-full rounded-xl border border-line bg-surface px-3 text-base text-ink outline-none focus:border-primary" value={server.timezone} onChange={(e) => setServer({ ...server, timezone: e.target.value })} />
              )}
            </label>
            <ErrorText>{error}</ErrorText>
            <Button type="submit" className="w-full">
              {t('common.continue')}
            </Button>
          </form>
        )}

        {step === 'storage' && env && (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void run(saveConfig);
            }}
          >
            <div>
              <h2 className="font-medium text-ink">{t('setup.storageTitle')}</h2>
              <p className="text-sm text-muted">{t('setup.storageHint')}</p>
            </div>
            {restarting ? (
              <p className="text-sm text-muted" role="status">
                {restarting === 'slow' ? t('setup.restartSlow') : t('setup.restarting')}
              </p>
            ) : (
              <>
                <ul className="space-y-2">
                  {env.volumes.map((v) => (
                    <li key={v.id}>
                      <label className={`flex cursor-pointer items-center gap-3 rounded-xl border p-3 ${mediaRoot === v.path ? 'border-primary' : 'border-line'}`}>
                        <input type="radio" name="media" value={v.path} checked={mediaRoot === v.path} onChange={() => setMediaRoot(v.path)} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium text-ink">{v.id === 'internal' ? t('setup.internal') : v.name}</span>
                          <span className="block text-xs text-muted" dir="ltr">
                            {v.used !== null ? t('setup.free', { free: formatBytes(v.size - v.used, 1), size: formatBytes(v.size, 1) }) : formatBytes(v.size, 1)} · {v.path}
                          </span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
                {env.volumes.length <= 1 && <p className="text-sm text-muted">{t('setup.noDrives')}</p>}
                <ErrorText>{error}</ErrorText>
                <div className="flex gap-2">
                  <Button type="button" variant="ghost" className="flex-1" disabled={busy} onClick={() => setStep('server')}>
                    {t('common.back')}
                  </Button>
                  <Button type="button" variant="secondary" disabled={busy} onClick={() => void run(async () => void (await loadEnv()))}>
                    ↻
                  </Button>
                  <Button type="submit" className="flex-1" disabled={busy}>
                    {t('common.continue')}
                  </Button>
                </div>
              </>
            )}
          </form>
        )}

        {step === 'account' && totp && (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await api('/api/setup/finish', { body: { token, ...form } });
                setStep(passkeysSupported() ? 'passkey' : 'done');
              });
            }}
          >
            <TextField label={t('login.username')} autoComplete="username" autoCapitalize="off" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value.toLowerCase() })} required />
            <TextField
              label={t('login.password')}
              hint={t('setup.passwordHint')}
              type="password"
              autoComplete="new-password"
              minLength={12}
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              required
            />
            <p className="text-sm text-muted">{t('setup.scan')}</p>
            <img src={`data:image/svg+xml;utf8,${encodeURIComponent(totp.qrSvg)}`} alt="" className="mx-auto size-48 rounded-xl bg-white p-2" />
            <p className="text-xs text-muted">
              {t('setup.secret')} <code className="break-all font-mono text-ink">{totp.secret}</code>
            </p>
            <TextField label={t('login.code')} inputMode="numeric" autoComplete="one-time-code" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.replace(/\D/g, '').slice(0, 6) })} required />
            <ErrorText>{error}</ErrorText>
            <Button type="submit" className="w-full" disabled={busy}>
              {t('setup.create')}
            </Button>
          </form>
        )}

        {step === 'passkey' && (
          <div className="space-y-4">
            <p className="text-sm text-muted">{t('setup.addPasskeyPrompt')}</p>
            <ErrorText>{error}</ErrorText>
            <Button
              className="w-full"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await registerPasskey(navigator.userAgent.includes('Android') ? 'Android phone' : 'This device');
                  setStep('done');
                })
              }
            >
              <Fingerprint24Filled aria-hidden />
              {t('setup.addPasskey')}
            </Button>
            <Button variant="ghost" className="w-full" onClick={() => setStep('done')}>
              {t('setup.skip')}
            </Button>
          </div>
        )}

        {step === 'done' && (
          <div className="space-y-4">
            <h2 className="flex items-center gap-2 font-medium text-ink">
              <Checkmark24Filled aria-hidden className="text-primary" />
              {t('setup.doneTitle')}
            </h2>
            <p className="text-sm text-muted">{t('setup.doneText')}</p>
            <Button
              className="w-full"
              onClick={() => {
                window.history.replaceState(null, '', '/store');
                void refresh();
              }}
            >
              {t('setup.openStore')}
            </Button>
          </div>
        )}
      </div>
    </main>
  );
}

function Fact({ ok, text }: { ok: boolean; text: string }) {
  return (
    <li className={`flex items-start gap-2 ${ok ? 'text-ink' : 'text-warn'}`}>
      <span aria-hidden>{ok ? '✓' : '!'}</span>
      <span>{text}</span>
    </li>
  );
}
