import { useEffect, useState } from 'react';
import { ArrowDownload24Filled, Dismiss20Regular } from '@fluentui/react-icons';
import { isStandalone, promptInstall, useCanInstall } from '../lib/install';
import { useI18n } from '../i18n';

const DISMISS_KEY = 'manar.installHintDismissed';

/**
 * "Install app" card. If the browser offers installation we use its prompt;
 * otherwise (e.g. Samsung Internet on a tailnet-only address) we show the menu steps.
 */
export function InstallCard() {
  const { t } = useI18n();
  const can = useCanInstall();
  const [showHint, setShowHint] = useState(false);

  useEffect(() => {
    if (isStandalone() || localStorage.getItem(DISMISS_KEY)) return;
    // Give the browser a moment to fire beforeinstallprompt before falling back to instructions.
    const id = setTimeout(() => setShowHint(true), 2500);
    return () => clearTimeout(id);
  }, []);

  if (isStandalone()) return null;
  if (can)
    return (
      <button type="button" onClick={() => void promptInstall()} className="card flex w-full items-center gap-3 p-4 text-start active:scale-[0.99]">
        <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary text-white">
          <ArrowDownload24Filled aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-semibold text-heading">{t('install.title')}</span>
          <span className="block text-xs text-muted">{t('install.body')}</span>
        </span>
      </button>
    );
  if (!showHint) return null;

  const samsung = /SamsungBrowser/i.test(navigator.userAgent);
  const ios = /iPhone|iPad/i.test(navigator.userAgent);
  return (
    <div className="card flex items-start gap-3 p-4">
      <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary text-white">
        <ArrowDownload24Filled aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-semibold text-heading">{t('install.title')}</p>
        <p className="mt-1 text-xs text-muted">{t(samsung ? 'install.samsung' : ios ? 'install.ios' : 'install.chrome')}</p>
      </div>
      <button
        type="button"
        aria-label={t('common.close')}
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-muted"
        onClick={() => {
          localStorage.setItem(DISMISS_KEY, '1');
          setShowHint(false);
        }}
      >
        <Dismiss20Regular aria-hidden />
      </button>
    </div>
  );
}
