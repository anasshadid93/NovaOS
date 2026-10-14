import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import type { CatalogApp } from './compose.js';

let cache: { apps: CatalogApp[]; byId: Map<string, CatalogApp>; source: Record<string, string> } | null = null;

export function catalog() {
  if (cache) return cache;
  const dir = path.join(config.repoRoot, 'server', 'catalog');
  const base = JSON.parse(fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8')) as { source: Record<string, string>; apps: CatalogApp[] };
  const extra = JSON.parse(fs.readFileSync(path.join(dir, 'extra.json'), 'utf8')) as { hide: string[]; apps: CatalogApp[] };
  const hide = new Set(extra.hide);
  const byId = new Map<string, CatalogApp>();
  for (const a of [...base.apps, ...extra.apps]) if (!hide.has(a.id)) byId.set(a.id, a);
  const apps = [...byId.values()].sort((a, b) => a.title.localeCompare(b.title));
  cache = { apps, byId, source: base.source };
  return cache;
}

export function summary(a: CatalogApp) {
  return { id: a.id, title: a.title, tagline: a.tagline, category: a.category, icon: a.icon, hasWeb: !!a.web };
}
