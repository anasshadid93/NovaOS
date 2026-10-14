import { lazy, Suspense, useEffect, useState } from 'react';
import { WifiOff24Regular } from '@fluentui/react-icons';
import { useAuth } from './lib/auth';
import { useI18n } from './i18n';
import { Login } from './pages/Login';
import { Setup } from './pages/Setup';
import { AppRoutes } from './routes';
import { MiniPlayer } from './components/MiniPlayer';
import { useDesktopMode } from './desktop/mode';
import { LockScreen } from './components/LockScreen';
import { useAutoLock } from './lib/autolock';

// The desktop shell loads only on big screens.
const Desktop = lazy(() => import('./desktop/Desktop').then((m) => ({ default: m.Desktop })));
function OfflineBanner() {
  const { t } = useI18n();
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    addEventListener('online', on);
    addEventListener('offline', off);
    return () => (removeEventListener('online', on), removeEventListener('offline', off));
  }, []);
  if (online) return null;
  return (
    <div role="status" className="flex items-center justify-center gap-2 bg-warn px-3 py-1.5 text-sm text-white">
      <WifiOff24Regular className="size-4" aria-hidden />
      {t('offline.banner')}
    </div>
  );
}

function OfflineScreen() {
  const { t } = useI18n();
  const { refresh } = useAuth();
  return (
    <main className="safe-top safe-bottom mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
      <img src="/icons/icon.svg" alt="" className="size-16 rounded-2xl" width={64} height={64} />
      <WifiOff24Regular className="size-8 text-muted" aria-hidden />
      <p className="text-lg font-semibold text-heading">{t('offline.title')}</p>
      <p className="text-sm text-muted">{t('offline.body')}</p>
      <button type="button" onClick={() => void refresh().catch(() => undefined)} className="min-h-12 rounded-xl bg-primary px-6 font-medium text-white">
        {t('common.retry')}
      </button>
    </main>
  );
}

export function App() {
  const { state } = useAuth();
  const { t } = useI18n();
  const desktop = useDesktopMode();
  useAutoLock(!!state?.user && !state.user.locked);

  if (!state) {
    return <div className="flex min-h-dvh items-center justify-center text-sm text-muted">{t('common.loading')}</div>;
  }

  return (
    <>
      <OfflineBanner />
      {state.offline ? (
        <OfflineScreen />
      ) : state.setupRequired ? (
        <Setup />
      ) : !state.user ? (
        <Login />
      ) : state.user.locked ? (
        <LockScreen />
      ) : desktop ? (
        <Suspense fallback={null}>
          <Desktop />
        </Suspense>
      ) : (
        <Suspense fallback={<div className="p-6 text-center text-sm text-muted">{t('common.loading')}</div>}>
        <AppRoutes />
        <MiniPlayer variant="pill" />
        </Suspense>
      )}
    </>
  );
}
