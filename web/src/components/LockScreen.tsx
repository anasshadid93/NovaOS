import { useEffect, useRef, useState } from 'react';
import { LockClosed24Filled, SignOut20Regular } from '@fluentui/react-icons';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useIsDark } from '../lib/theme';
import { useI18n } from '../i18n';
import { useWallpaper, wallpaperCss } from '../desktop/wallpaper';

/** Shown while the session is locked. The server refuses everything else until the PIN is right. */
export function LockScreen() {
  const { t, intl } = useI18n();
  const { state, refresh, logout } = useAuth();
  const dark = useIsDark();
  const wallpaper = useWallpaper();
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 10_000);
    input.current?.focus();
    return () => clearInterval(id);
  }, []);

  const unlock = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || pin.length < 4) return;
    setBusy(true);
    setError('');
    try {
      await api('/api/lock/unlock', { body: { pin } });
      await refresh();
    } catch (err) {
      setPin('');
      setError((err as { status?: number }).status === 429 ? t('lock.tooMany') : t('lock.wrong'));
      input.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[10000] flex flex-col items-center justify-center text-white" style={{ background: wallpaperCss(wallpaper, dark) }}>
      <div aria-hidden className="absolute inset-0 bg-black/45 backdrop-blur-2xl" />
      <div className="relative flex w-full max-w-xs flex-col items-center gap-5 px-6 text-center">
        <p className="text-6xl font-light tabular-nums tracking-tight" dir="ltr">
          {new Intl.DateTimeFormat(intl, { hour: '2-digit', minute: '2-digit' }).format(now)}
        </p>
        <p className="-mt-3 text-base text-white/85">{new Intl.DateTimeFormat(intl, { weekday: 'long', day: 'numeric', month: 'long' }).format(now)}</p>
        <span className="mt-6 inline-flex size-20 items-center justify-center rounded-full bg-white/20 text-3xl font-semibold ring-1 ring-white/30">{state?.user?.name.slice(0, 1).toUpperCase()}</span>
        <p className="-mt-2 text-lg font-medium">{state?.user?.name}</p>
        <form onSubmit={(e) => void unlock(e)} className={`flex w-full flex-col gap-3 ${error ? 'shake' : ''}`} key={error}>
          <label className="flex items-center gap-2 rounded-2xl bg-white/15 px-4 ring-1 ring-white/30 focus-within:ring-2 focus-within:ring-white/70">
            <LockClosed24Filled className="shrink-0 text-white/80" aria-hidden />
            <input
              ref={input}
              type="password"
              inputMode="numeric"
              autoComplete="off"
              maxLength={8}
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
              placeholder={t('lock.pin')}
              aria-label={t('lock.pin')}
              className="min-h-12 flex-1 bg-transparent text-center text-xl tracking-[0.4em] text-white placeholder:tracking-normal placeholder:text-white/60 outline-none"
              dir="ltr"
            />
          </label>
          <button type="submit" disabled={busy || pin.length < 4} className="min-h-12 rounded-2xl bg-white font-medium text-[#1a3a7c] disabled:opacity-60">
            {t('lock.unlock')}
          </button>
          <p className="min-h-5 text-sm text-red-200" role="alert">
            {error}
          </p>
        </form>
        <button type="button" onClick={() => void logout()} className="inline-flex items-center gap-1.5 text-sm text-white/80 hover:text-white">
          <SignOut20Regular aria-hidden />
          {t('lock.signOut')}
        </button>
      </div>
    </div>
  );
}

/** Lock now (needs a PIN set). Resolves false if there's no PIN yet. */
export async function lockNow(refresh: () => Promise<void>): Promise<boolean> {
  try {
    await api('/api/lock', { body: {} });
  } catch {
    return false;
  }
  await refresh();
  return true;
}
