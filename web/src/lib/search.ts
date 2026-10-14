import { useEffect, useState } from 'react';
import { api } from './api';
import type { MessageKey } from '../i18n';
import type { Entry } from './fm';

/** Settings screens, so search can jump straight to one. */
export const SETTINGS_PAGES: { route: string; label: MessageKey; words?: string }[] = [
  { route: '/settings', label: 'settings.appearance', words: 'theme dark light language desktop mode' },
  { route: '/settings/system', label: 'settings.system', words: 'cpu ram os kernel hostname' },
  { route: '/settings/network', label: 'settings.network', words: 'ip wifi ethernet' },
  { route: '/settings/tailscale', label: 'settings.tailscale', words: 'vpn tailnet devices' },
  { route: '/settings/firewall', label: 'settings.firewall', words: 'ports ufw' },
  { route: '/settings/android', label: 'settings.android', words: 'apk phone tv install app أندرويد تطبيق' },
  { route: '/settings/integrations', label: 'settings.integrations', words: 'plugins telegram n8n whatsapp bot api تكاملات' },
  { route: '/settings/passwords', label: 'pw.title', words: 'password login credentials كلمة سر باسورد' },
  { route: '/settings/power', label: 'settings.power', words: 'reboot restart shutdown sleep' },
  { route: '/settings/notifications', label: 'settings.notifications', words: 'alerts whatsapp push' },
  { route: '/settings/passkeys', label: 'settings.passkeys', words: 'login security fingerprint face' },
  { route: '/settings/sessions', label: 'settings.sessions', words: 'devices logged in' },
  { route: '/display', label: 'display.title', words: 'scale resolution lock pin screen' },
  { route: '/wallpaper', label: 'wall.title', words: 'background' },
  { route: '/settings/shares', label: 'share.links', words: 'share link public password expiry مشاركة رابط' },
  { route: '/music', label: 'music.title', words: 'songs audio player playlist mp3 أغاني' },
  { route: '/updates', label: 'upd.title', words: 'apt upgrade security packages version' },
  { route: '/settings/about', label: 'settings.about', words: 'version licenses' },
];

export interface FileHit extends Entry {}
export interface ContentHit {
  path: string;
  line: number;
  text: string;
}

/** File names and text inside files for a search box (debounced). */
export function useFileSearch(q: string) {
  const [files, setFiles] = useState<FileHit[]>([]);
  const [content, setContent] = useState<ContentHit[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const query = q.trim();
    setFiles([]);
    setContent([]);
    if (query.length < 2) return;
    let alive = true;
    setBusy(true);
    const id = setTimeout(() => {
      const names = api<{ results: { path: string; size: number; mtime: number; cat: Entry['cat'] }[] }>(`/api/fs/search?q=${encodeURIComponent(query)}`)
        .then((r) => alive && setFiles(r.results.slice(0, 8).map((f) => ({ ...f, name: f.path.split('/').pop()!, type: 'file' as const }))))
        .catch(() => {});
      const inside =
        query.length >= 3
          ? api<{ hits: ContentHit[] }>(`/api/search/content?q=${encodeURIComponent(query)}`)
              .then((r) => alive && setContent(r.hits.slice(0, 8)))
              .catch(() => {})
          : Promise.resolve();
      void Promise.all([names, inside]).finally(() => alive && setBusy(false));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(id);
    };
  }, [q]);
  return { files, content, busy };
}
