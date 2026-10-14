import { useSyncExternalStore } from 'react';

/**
 * "Install app" support: Chrome/Samsung Internet fire `beforeinstallprompt` when the
 * PWA is installable. We keep the event and replay it from our own button.
 */
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function initInstallPrompt() {
  addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as InstallPromptEvent;
    emit();
  });
  addEventListener('appinstalled', () => {
    deferred = null;
    emit();
  });
}

/** Inside the MinisManager Android app (android/ in this repo): it appends "MinisManagerApp/<version>" to the user agent. */
export const inApp = () => /MinisManagerApp\//.test(navigator.userAgent);
/** The app's own settings screen (server, notifications, fingerprint lock), through its JavaScript bridge. */
export const openAppSettings = () => (window as { MinisApp?: { openSettings(): void } }).MinisApp?.openSettings();

export const isStandalone = () => inApp() || matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;

/** True when the browser offered installation and we are not already running as the app. */
export function useCanInstall(): boolean {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => !!deferred && !isStandalone(),
  );
}

export async function promptInstall(): Promise<boolean> {
  if (!deferred) return false;
  await deferred.prompt();
  const { outcome } = await deferred.userChoice;
  deferred = null;
  emit();
  return outcome === 'accepted';
}
