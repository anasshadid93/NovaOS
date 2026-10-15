import { useMemo, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import {
  Add24Regular,
  Alert20Filled,
  ArrowSort24Regular,
  ChevronDown20Regular,
  Key24Regular,
  Person24Filled,
  Phone24Regular,
  DocumentText24Regular,
  Search24Regular,
  Settings24Regular,
  SignOut24Regular,
} from '@fluentui/react-icons';
import { useAuth } from '../lib/auth';
import { useLiveStatus } from '../lib/live';
import { formatRate } from '../lib/format';
import { useI18n, type MessageKey } from '../i18n';
import { Dialog } from './Dialog';
import { LauncherIcon, openItem, type LauncherItem } from './LauncherIcon';
import { SETTINGS_PAGES, useFileSearch } from '../lib/search';
import { parentOf } from '../lib/fm';
import { FileIcon } from './fm/FileIcon';

const SECTIONS: { href: string; label: MessageKey }[] = [
  { href: '/monitor', label: 'section.monitor' },
  { href: '/processes', label: 'section.processes' },
  { href: '/docker', label: 'section.docker' },
  { href: '/store', label: 'section.apps' },
  { href: '/files', label: 'section.files' },
  { href: '/disks', label: 'section.disks' },
  { href: '/downloads', label: 'section.downloads' },
  { href: '/backup', label: 'section.backup' },
  { href: '/games', label: 'section.games' },
  { href: '/prices', label: 'section.prices' },
  { href: '/news', label: 'section.news' },
  { href: '/watch', label: 'section.watch' },
  { href: '/health', label: 'section.health' },
  { href: '/network', label: 'section.network' },
  { href: '/tasks', label: 'section.tasks' },
  { href: '/settings', label: 'section.settings' },
];

/** Top bar: account menu on the start side; search, arrange and add on the end side. */
export function HomeTopBar({ items, addMenu }: { items: LauncherItem[]; addMenu: (close: () => void) => ReactNode }) {
  const { t } = useI18n();
  const { state, logout } = useAuth();
  const [, navigate] = useLocation();
  const [sheet, setSheet] = useState<'account' | 'search' | 'add' | null>(null);
  const [q, setQ] = useState('');
  const close = () => setSheet(null);
  const btn = 'inline-flex size-11 items-center justify-center rounded-full text-ink active:bg-primary-soft';

  const query = q.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!query) return { sections: [], apps: [] };
    return {
      sections: SECTIONS.filter((s) => t(s.label).toLowerCase().includes(query)),
      apps: items.filter((i) => i.title.toLowerCase().includes(query)),
    };
  }, [query, items, t]);

  const found = useFileSearch(sheet === 'search' ? query : '');
  const settingsHits = query.length >= 2 ? SETTINGS_PAGES.filter((p) => `${t(p.label)} ${p.words ?? ''}`.toLowerCase().includes(query)) : [];

  const go = (href: string) => {
    close();
    navigate(href);
  };

  return (
    <>
      <header className="flex items-center gap-1 px-1 pt-1">
        <button type="button" onClick={() => setSheet('account')} className="flex min-w-0 items-center gap-2 rounded-full py-1 pe-2 active:bg-primary-soft" aria-haspopup="dialog">
          <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-white shadow-card">
            <Person24Filled className="size-5" aria-hidden />
          </span>
          <span className="truncate text-xl font-bold text-ink">{state?.user?.name ?? ''}</span>
          <ChevronDown20Regular className="shrink-0 text-ink" aria-hidden />
        </button>
        <span className="flex-1" />
        <button type="button" className={btn} onClick={() => setSheet('search')} aria-label={t('top.search')}>
          <Search24Regular aria-hidden />
        </button>
        <Link href="/launcher" className={btn} aria-label={t('top.arrange')}>
          <ArrowSort24Regular aria-hidden />
        </Link>
        <button type="button" className={btn} onClick={() => setSheet('add')} aria-label={t('top.add')}>
          <Add24Regular aria-hidden />
        </button>
      </header>

      <Dialog open={sheet === 'account'} onClose={close} title={t('top.account')}>
        <ul className="-mx-2">
          {[
            { icon: Key24Regular, label: t('settings.passkeys'), on: () => go('/settings/passkeys') },
            { icon: Phone24Regular, label: t('settings.sessions'), on: () => go('/settings/sessions') },
            { icon: Settings24Regular, label: t('settings.title'), on: () => go('/settings') },
            {
              icon: SignOut24Regular,
              label: t('settings.signOut'),
              on: () => {
                close();
                void logout();
              },
              danger: true,
            },
          ].map(({ icon: I, label, on, danger }) => (
            <li key={label}>
              <button type="button" onClick={on} className={`flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-start active:bg-primary-soft ${danger ? 'text-danger' : 'text-ink'}`}>
                <I aria-hidden />
                {label}
              </button>
            </li>
          ))}
        </ul>
      </Dialog>

      <Dialog open={sheet === 'search'} onClose={close} title={t('top.search')}>
        <label className="flex min-h-12 items-center gap-2 rounded-xl border border-line bg-surface px-3">
          <Search24Regular className="text-muted" aria-hidden />
          <input autoFocus type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('top.searchPlaceholder')} className="min-w-0 flex-1 bg-transparent text-base text-ink outline-none" />
        </label>
        {query && (
          <div className="max-h-[50dvh] space-y-1 overflow-auto">
            {matches.sections.map((s) => (
              <button key={s.href} type="button" onClick={() => go(s.href)} className="flex min-h-11 w-full items-center rounded-xl px-3 text-start text-ink active:bg-primary-soft">
                {t(s.label)}
              </button>
            ))}
            {matches.apps.map((i) => (
              <button
                key={i.key}
                type="button"
                onClick={() => {
                  close();
                  openItem(i);
                }}
                className="flex min-h-12 w-full items-center gap-3 rounded-xl px-2 text-start text-ink active:bg-primary-soft"
              >
                <span className="origin-center scale-[0.6]" style={{ margin: -12 }}>
                  <LauncherIcon item={i} />
                </span>
                {i.title}
              </button>
            ))}
            {settingsHits.map((p) => (
              <button key={p.route} type="button" onClick={() => go(p.route)} className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-start text-ink active:bg-primary-soft">
                <Settings24Regular className="size-5 text-muted" aria-hidden />
                {t(p.label)}
              </button>
            ))}
            {found.files.length > 0 && <p className="px-3 pt-2 text-xs font-semibold uppercase tracking-wide text-muted">{t('search.files')}</p>}
            {found.files.map((f) => (
              <button key={f.path} type="button" onClick={() => go(`/files?path=${encodeURIComponent(parentOf(f.path))}`)} className="flex min-h-12 w-full items-center gap-3 rounded-xl px-2 text-start active:bg-primary-soft">
                <FileIcon entry={f} size={32} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-ink" dir="auto">{f.name}</span>
                  <span className="block truncate text-xs text-muted" dir="auto">{parentOf(f.path)}</span>
                </span>
              </button>
            ))}
            {found.content.length > 0 && <p className="px-3 pt-2 text-xs font-semibold uppercase tracking-wide text-muted">{t('search.inside')}</p>}
            {found.content.map((c) => (
              <button key={c.path} type="button" onClick={() => go(`/files?path=${encodeURIComponent(parentOf(c.path))}`)} className="flex min-h-12 w-full items-center gap-3 rounded-xl px-2 text-start active:bg-primary-soft">
                <DocumentText24Regular className="size-6 shrink-0 text-muted" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-ink" dir="auto">{c.path.split('/').pop()}</span>
                  <span className="block truncate text-xs text-muted" dir="auto">{c.text}</span>
                </span>
              </button>
            ))}
            {found.busy && <p className="px-3 py-1 text-xs text-muted">{t('search.searching')}</p>}
            {!found.busy && !matches.sections.length && !matches.apps.length && !settingsHits.length && !found.files.length && !found.content.length && <p className="px-3 py-2 text-sm text-muted">{t('top.noMatches')}</p>}
            {query.length >= 2 && (
              <button type="button" onClick={() => go(`/files/search?q=${encodeURIComponent(q.trim())}`)} className="flex min-h-11 w-full items-center gap-2 rounded-xl px-3 text-start text-primary-ink active:bg-primary-soft">
                <Search24Regular className="size-5" aria-hidden />
                {t('top.searchFiles', { q: q.trim() })}
              </button>
            )}
          </div>
        )}
      </Dialog>

      <Dialog open={sheet === 'add'} onClose={close} title={t('top.add')}>
        {addMenu(close)}
        <Link href="/store" onClick={close} className="flex min-h-12 items-center justify-center rounded-xl bg-primary-soft font-medium text-primary-ink">
          {t('top.installApp')}
        </Link>
      </Dialog>
    </>
  );
}

/** Device header like a NAS app: name + short id, user + LAN IP, live traffic, the device photo, alert + link status. */
export function DeviceHeader({
  host,
  user,
  ip,
  net,
  alert,
}: {
  host: { hostname: string; deviceId: string | null } | undefined;
  user: string;
  ip: string | undefined;
  net: { rx: number; tx: number } | undefined;
  alert: { text: string; tone: 'ok' | 'bad' };
}) {
  const { t } = useI18n();
  const status = useLiveStatus();
  const connected = status === 'open';
  return (
    <section className="px-1">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 pt-2">
          <p className="flex items-baseline gap-2">
            <span className="truncate text-2xl font-extrabold tracking-tight text-ink">{host?.hostname ?? '…'}</span>
            {host?.deviceId && <span className="shrink-0 text-xs font-bold text-ink">ID: {host.deviceId}</span>}
          </p>
          <p className="mt-2 truncate text-base font-bold text-ink" dir="ltr">
            <span className="me-2">{user}</span>
            {ip}
          </p>
          <p className="mt-2 text-xs tabular-nums text-muted" dir="ltr">
            {formatRate(net?.rx)} ↓ &nbsp; {formatRate(net?.tx)} ↑
          </p>
        </div>
        <Link href="/monitor" aria-label={t('section.monitor')} className="w-[136px] shrink-0">
          <img src="/device/n5.png" alt="" width={136} height={114} className="h-auto w-[136px] select-none drop-shadow-[0_10px_14px_rgb(15_23_42/0.25)]" draggable={false} />
        </Link>
      </div>
      {/* One row like a NAS app: alert on the start side, link status under the device photo (aligned to its edge). */}
      <div className="mt-2 flex items-center gap-2">
        <Link href="/settings/notifications" className="flex min-w-0 flex-1 items-center gap-2 text-sm text-ink">
          <Alert20Filled className={`shrink-0 ${alert.tone === 'bad' ? 'text-danger' : 'text-primary'}`} aria-hidden />
          <span className="truncate">{alert.text}</span>
        </Link>
        <span className="flex w-[136px] shrink-0 items-center gap-1.5 whitespace-nowrap text-sm text-ink" role="status">
          <span className={`size-2.5 rounded-full ${connected ? 'bg-ok' : 'bg-danger'}`} aria-hidden />
          {connected ? t('top.connected') : t('top.disconnected')}
        </span>
      </div>
    </section>
  );
}
