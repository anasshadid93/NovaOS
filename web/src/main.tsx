import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { I18nProvider } from './i18n';
import { AuthProvider } from './lib/auth';
import { ConfirmProvider } from './components/ConfirmProvider';
import { initTheme } from './lib/theme';
import { initInstallPrompt } from './lib/install';
import './styles/index.css';

initTheme();
initInstallPrompt();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <AuthProvider>
        <ConfirmProvider>
          <App />
        </ConfirmProvider>
      </AuthProvider>
    </I18nProvider>
  </StrictMode>,
);

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  addEventListener('load', () => void navigator.serviceWorker.register('/sw.js'));
}

// A new release replaces the hashed bundle: an app left open (phone app, TV, PWA) would keep the old
// pages forever. When it comes back to the foreground, compare the bundle and reload if it changed.
if (import.meta.env.PROD) {
  const mine = (document.querySelector('script[type="module"][src*="/assets/index-"]') as HTMLScriptElement | null)?.src;
  let last = 0;
  const check = async () => {
    if (!mine || document.visibilityState !== 'visible' || Date.now() - last < 60_000) return;
    last = Date.now();
    try {
      const html = await (await fetch('/', { cache: 'no-store' })).text();
      const latest = html.match(/src="(\/assets\/index-[^"]+\.js)"/)?.[1];
      const typing = document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement;
      if (latest && !mine.endsWith(latest) && !typing) location.reload();
    } catch {
      /* offline */
    }
  };
  document.addEventListener('visibilitychange', () => void check());
  setInterval(() => void check(), 5 * 60_000);
}
