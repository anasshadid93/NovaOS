import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { getDb } from '../db.js';
import { appUrl, installedApps } from '../store/installer.js';
import { craftApps, craftUrl } from '../craft/craft.js';

/**
 * Launcher items = your existing services + apps installed from the store.
 * Services are links only; Manar never manages them from here.
 * The list lives in var/services.json (see below).
 */
export interface ServiceLink {
  id: string;
  title: string;
  url: string;
  icon: string; // "svc:<id>" (icon fetched from the running service), dashboard-icons name, or "glyph:<name>"
  /** Local origin used to fetch the service's real icon. */
  local?: string;
  unit?: string;
}

/**
 * Services of your own that should show in the launcher: put them in var/services.json, e.g.
 * [{ "id": "code", "title": "code-server", "url": "https://host:8080/", "icon": "svc:code", "local": "http://127.0.0.1:8080", "unit": "code-server@me.service" }]
 * Nothing is listed by default; apps installed from the store always appear.
 */
export const DEFAULT_SERVICES: ServiceLink[] = [];

export function services(): ServiceLink[] {
  const file = path.join(config.dataDir, 'services.json');
  try {
    const list = JSON.parse(fs.readFileSync(file, 'utf8')) as ServiceLink[];
    if (Array.isArray(list)) return list.filter((s) => s.id && s.title && /^https?:\/\//.test(s.url));
  } catch {
    /* default list */
  }
  return DEFAULT_SERVICES;
}

export interface LauncherItem {
  key: string;
  kind: 'service' | 'app';
  title: string;
  url: string | null;
  icon: string | null;
  status?: string;
  opens: number;
  hidden: boolean;
}

/** `userId` signs the ArtCraft links so they open already logged in (see craft/craft.ts). */
export function launcherItems(userId?: number): LauncherItem[] {
  const db = getDb();
  const meta = new Map(
    (db.prepare('SELECT key, position, hidden, opens FROM launcher').all() as { key: string; position: number; hidden: number; opens: number }[]).map((r) => [r.key, r]),
  );
  const items: (LauncherItem & { position: number })[] = [];
  const add = (it: Omit<LauncherItem, 'opens' | 'hidden'>, fallbackPos: number) => {
    const m = meta.get(it.key);
    items.push({ ...it, opens: m?.opens ?? 0, hidden: !!m?.hidden, position: m?.position ?? fallbackPos });
  };
  services().forEach((s, i) => add({ key: `svc:${s.id}`, kind: 'service', title: s.title, url: s.url, icon: s.icon }, i));
  craftApps().forEach((c, i) => add({ key: `craft:${c.id}`, kind: 'service', title: c.title, url: craftUrl(c.id, userId), icon: `craft:${c.id}` }, 500 + i));
  installedApps().forEach((a, i) => add({ key: `app:${a.id}`, kind: 'app', title: a.title, url: appUrl(a), icon: `app:${a.id}`, status: a.status }, 1000 + i));
  return items.sort((a, b) => a.position - b.position).map(({ position: _p, ...rest }) => rest);
}

export function saveOrder(keys: string[]) {
  const db = getDb();
  const up = db.prepare(
    'INSERT INTO launcher(key, position) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET position = excluded.position',
  );
  db.exec('BEGIN');
  keys.slice(0, 500).forEach((k, i) => up.run(k, i));
  db.exec('COMMIT');
}

export function setHidden(key: string, hidden: boolean) {
  getDb()
    .prepare('INSERT INTO launcher(key, position, hidden) VALUES(?, 9999, ?) ON CONFLICT(key) DO UPDATE SET hidden = excluded.hidden')
    .run(key, hidden ? 1 : 0);
}

export function recordOpen(key: string) {
  getDb()
    .prepare(
      'INSERT INTO launcher(key, position, opens, last_opened_at) VALUES(?, 9999, 1, ?) ON CONFLICT(key) DO UPDATE SET opens = opens + 1, last_opened_at = excluded.last_opened_at',
    )
    .run(key, Date.now());
}
