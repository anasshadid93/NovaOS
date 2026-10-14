import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'manar-selfupd-'));
process.env.MANAR_DATA_DIR = path.join(tmp, 'var');
const { applyTree, newerThan, snapshot, sourceRoot } = await import('./selfupdate.js');

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const write = (p: string, s: string) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, s);
};

describe('self-update', () => {
  it('orders release tags', () => {
    expect(newerThan('v1.2.0', 'v1.1.9')).toBe(true);
    expect(newerThan('1.10.0', 'v1.9.0')).toBe(true);
    expect(newerThan('v1.2.0', '1.2.0')).toBe(false);
    expect(newerThan('v1.2.0', 'v1.2.1')).toBe(false);
    expect(newerThan('v2.0.0', 'v2.0.0-rc1')).toBe(true);
    expect(newerThan('v2.0.0-rc1', 'v2.0.0')).toBe(false);
    expect(newerThan('v1.0.0', null)).toBe(true);
    expect(newerThan('v1.0.0', '0.1.0+601ae76')).toBe(true); // a dev build is never "newer" than a release
  });

  it('finds the package inside a GitHub tarball folder', () => {
    const ex = path.join(tmp, 'extracted');
    write(path.join(ex, 'anasshadid93-NovaOS-abc123', 'package.json'), '{"name":"manar"}');
    expect(sourceRoot(ex)).toBe(path.join(ex, 'anasshadid93-NovaOS-abc123'));
    expect(() => sourceRoot(path.join(tmp, 'var'))).toThrow();
  });

  it('snapshots the install and applies a new tree without touching var/ or .git/', async () => {
    const root = path.join(tmp, 'install');
    write(path.join(root, 'package.json'), '{"version":"1.0.0"}');
    write(path.join(root, 'server/dist/index.js'), 'old');
    write(path.join(root, 'web/dist/old.css'), 'old');
    write(path.join(root, 'var/manar.json'), '{"brand":"mine"}');
    write(path.join(root, '.git/HEAD'), 'ref: refs/heads/main');
    const rb = path.join(tmp, 'rollback');
    await snapshot(root, rb);
    expect(fs.readFileSync(path.join(rb, 'server/dist/index.js'), 'utf8')).toBe('old');
    expect(fs.existsSync(path.join(rb, 'var'))).toBe(false);

    const next = path.join(tmp, 'staged');
    write(path.join(next, 'package.json'), '{"version":"1.1.0"}');
    write(path.join(next, 'server/dist/index.js'), 'new');
    write(path.join(next, 'web/dist/new.css'), 'new');
    await applyTree(next, root);
    expect(fs.readFileSync(path.join(root, 'server/dist/index.js'), 'utf8')).toBe('new');
    expect(fs.existsSync(path.join(root, 'web/dist/old.css'))).toBe(false); // --delete
    expect(fs.readFileSync(path.join(root, 'var/manar.json'), 'utf8')).toBe('{"brand":"mine"}');
    expect(fs.readFileSync(path.join(root, '.git/HEAD'), 'utf8')).toBe('ref: refs/heads/main');
    // The hard-linked snapshot still holds the old files after the swap.
    expect(fs.readFileSync(path.join(rb, 'server/dist/index.js'), 'utf8')).toBe('old');

    await applyTree(rb, root);
    expect(fs.readFileSync(path.join(root, 'server/dist/index.js'), 'utf8')).toBe('old');
    expect(fs.existsSync(path.join(root, 'web/dist/new.css'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'var/manar.json'))).toBe(true);
  });
});
