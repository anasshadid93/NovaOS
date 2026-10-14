#!/usr/bin/env node
// Converts a CasaOS-AppStore checkout (Apache-2.0) into Manar's catalog schema.
//
//   node scripts/build-catalog.mjs <path-to-CasaOS-AppStore> <commit-sha>
//
// Output: server/catalog/catalog.json (+ server/catalog/NOTICE).
// Only YAML/JSON is read from the source tree; nothing in it is executed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, '..', 'server', 'package.json'));
const YAML = require('yaml');

const [, , srcDir, commit] = process.argv;
if (!srcDir || !/^[0-9a-f]{40}$/.test(commit ?? '')) {
  console.error('usage: build-catalog.mjs <CasaOS-AppStore dir> <40-char commit sha>');
  process.exit(1);
}

const en = (v) => (v && typeof v === 'object' ? (v.en_US ?? v.en_GB ?? Object.values(v)[0] ?? '') : (v ?? ''));
const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const apps = [];
const skipped = [];

for (const dir of fs.readdirSync(path.join(srcDir, 'Apps')).sort()) {
  const file = path.join(srcDir, 'Apps', dir, 'docker-compose.yml');
  if (!fs.existsSync(file)) continue;
  let doc;
  try {
    doc = YAML.parse(fs.readFileSync(file, 'utf8'), { merge: true });
  } catch (err) {
    skipped.push([dir, `yaml: ${err.message.split('\n')[0]}`]);
    continue;
  }
  const meta = doc['x-casaos'] ?? {};
  const services = doc.services ?? {};
  const archs = meta.architectures ?? [];
  const id = slug(doc.name ?? dir);

  // Skip what cannot run safely here: non-amd64, NVIDIA-only, host networking, privileged containers.
  const why = [];
  if (archs.length && !archs.includes('amd64')) why.push('arch');
  if (/nvidia/i.test(dir) || JSON.stringify(services).includes('"nvidia"')) why.push('nvidia');
  if (Object.values(services).some((s) => s.network_mode === 'host')) why.push('host-network');
  if (Object.values(services).some((s) => s.privileged === true)) why.push('privileged');
  if (why.length) {
    skipped.push([dir, why.join(',')]);
    continue;
  }

  const main = meta.main && services[meta.main] ? meta.main : Object.keys(services)[0];
  const webPort = meta.port_map ? String(meta.port_map).replace(/\D/g, '') : null;
  // port_map is the published port in CasaOS; translate it back to the container port.
  let webTarget = null;
  for (const p of services[main]?.ports ?? []) {
    const obj = typeof p === 'object' ? p : null;
    const published = obj ? String(obj.published) : String(p).split(':').slice(-2, -1)[0];
    const target = obj ? String(obj.target) : String(p).split(':').pop().split('/')[0];
    if (!webTarget) webTarget = target;
    if (published === webPort) webTarget = target;
  }

  // Strip CasaOS-specific keys; keep the compose itself.
  const compose = { services: {} };
  for (const [name, svc] of Object.entries(services)) {
    const { 'x-casaos': _x, ...rest } = svc;
    compose.services[name] = rest;
  }
  if (doc.volumes) compose.volumes = doc.volumes;
  if (doc.networks) compose.networks = doc.networks;

  apps.push({
    id,
    title: en(meta.title) || dir,
    tagline: en(meta.tagline).trim(),
    description: en(meta.description).trim().slice(0, 2000),
    category: meta.category ?? 'Others',
    developer: meta.developer ?? meta.author ?? '',
    icon: slug(en(meta.title) || dir),
    // Upstream logo (fallback when dashboard-icons has none). CasaOS-hosted ones are pinned to the commit.
    iconUrl: typeof meta.icon === 'string' && /^https:\/\//.test(meta.icon) ? meta.icon.replace('IceWhaleTech/CasaOS-AppStore@main', `IceWhaleTech/CasaOS-AppStore@${commit}`) : null,
    main,
    web: webTarget ? { port: Number(webTarget), path: meta.index ?? '/', scheme: meta.scheme === 'https' ? 'https' : 'http' } : null,
    compose,
    tips: en(meta.tips?.before_install).trim() || null,
    source: { repo: 'IceWhaleTech/CasaOS-AppStore', commit, path: `Apps/${dir}` },
  });
}

const outDir = path.join(here, '..', 'server', 'catalog');
fs.mkdirSync(outDir, { recursive: true });
// Upstream sample values that look like real API keys trip GitHub's push protection; the installer
// replaces every *_KEY/SECRET/PASSWORD default with a generated value anyway.
const scrubbed = JSON.stringify({ source: { repo: 'IceWhaleTech/CasaOS-AppStore', commit, license: 'Apache-2.0' }, generated: new Date().toISOString().slice(0, 10), apps }, null, 1)
  .replace(/"sk-[A-Za-z0-9_-]{32,}"/g, '"change-me"')
  .replace(/"(ghp|gho|github_pat)_[A-Za-z0-9_]{20,}"/g, '"change-me"');
fs.writeFileSync(path.join(outDir, 'catalog.json'), scrubbed);
fs.writeFileSync(
  path.join(outDir, 'NOTICE'),
  `Manar app catalog

Most entries in catalog.json are derived from CasaOS-AppStore
  https://github.com/IceWhaleTech/CasaOS-AppStore
  commit ${commit}
Copyright IceWhale Technology and CasaOS-AppStore contributors.
Licensed under the Apache License, Version 2.0 (http://www.apache.org/licenses/LICENSE-2.0).

Changes made by Manar: compose files were converted to Manar's schema, CasaOS
metadata (x-casaos) was reduced to title/tagline/description/category/web port,
and apps that need host networking, privileged mode, NVIDIA or non-amd64 were
removed. At install time Manar rewrites ports to 127.0.0.1, data paths to
/srv/data/apps/<id>, and replaces default passwords with generated secrets.

Entries in extra.json are written by Manar and are not from CasaOS-AppStore.

App logos are fetched at runtime from homarr-labs/dashboard-icons (Apache-2.0)
  https://github.com/homarr-labs/dashboard-icons
`,
);
console.log(`apps: ${apps.length}, skipped: ${skipped.length}`);
for (const [d, w] of skipped) console.log(`  skip ${d}: ${w}`);
