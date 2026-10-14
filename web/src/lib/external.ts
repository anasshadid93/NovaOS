/**
 * Opening apps (Tailscale addresses) in the phone's real browser, not inside MinisManager.
 *
 * In the installed app (standalone PWA) Android opens other sites in a "Custom Tab" sheet that
 * belongs to MinisManager. An Android intent URL aimed at the browser that installed the PWA
 * hands the link to that browser as a normal tab instead. Everywhere else (a browser tab,
 * iPhone, desktop) a plain new tab is already "outside".
 */

const standalone = () => matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches;
const android = () => /Android/i.test(navigator.userAgent);

function browserPackage(): string {
  const ua = navigator.userAgent;
  if (/SamsungBrowser/i.test(ua)) return 'com.sec.android.app.sbrowser';
  if (/EdgA/i.test(ua)) return 'com.microsoft.emmx';
  if (/Firefox/i.test(ua)) return 'org.mozilla.firefox';
  return 'com.android.chrome';
}

export function androidIntentUrl(url: string, pkg: string): string {
  const u = new URL(url);
  // A "#fragment" would end the intent early; the fallback keeps the full address.
  const fallback = encodeURIComponent(u.href);
  return `intent://${u.host}${u.pathname}${u.search}#Intent;scheme=${u.protocol.replace(':', '')};action=android.intent.action.VIEW;category=android.intent.category.BROWSABLE;package=${pkg};S.browser_fallback_url=${fallback};end`;
}

export function openExternal(url: string) {
  if (standalone() && android()) {
    location.href = androidIntentUrl(url, browserPackage());
    return;
  }
  window.open(url, '_blank', 'noopener');
}

/** For <a> links: keeps the real href (long-press → copy link) but opens it outside. */
export function externalLink(url: string) {
  return {
    href: url,
    target: '_blank',
    rel: 'noreferrer',
    onClick: (e: React.MouseEvent) => {
      e.preventDefault();
      openExternal(url);
    },
  };
}
