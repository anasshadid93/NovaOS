import { describe, expect, it } from 'vitest';
import { hubRepo, parseApt, tagShape } from './updates.js';

describe('updates', () => {
  it('parses apt list --upgradable, marking security updates', () => {
    const out = `Listing... Done
openssl/noble-updates,noble-security 3.0.13-0ubuntu3.6 amd64 [upgradable from: 3.0.13-0ubuntu3.5]
tailscale/unknown 1.90.1 amd64 [upgradable from: 1.88.0]`;
    expect(parseApt(out)).toEqual([
      { name: 'openssl', to: '3.0.13-0ubuntu3.6', from: '3.0.13-0ubuntu3.5', security: true },
      { name: 'tailscale', to: '1.90.1', from: '1.88.0', security: false },
    ]);
  });
  it('maps images to Docker Hub repositories', () => {
    expect(hubRepo('lscr.io/linuxserver/blender:5.2.2-ls242')).toEqual({ repo: 'linuxserver/blender', tag: '5.2.2-ls242' });
    expect(hubRepo('stirlingtools/stirling-pdf:3.1.0')).toEqual({ repo: 'stirlingtools/stirling-pdf', tag: '3.1.0' });
    expect(hubRepo('nginx')).toEqual({ repo: 'library/nginx', tag: 'latest' });
    expect(hubRepo('ghcr.io/openclaw/openclaw:2026.9.6')).toBeNull();
  });
  it('compares only tags of the same kind', () => {
    expect(tagShape('3.1.0').test('3.2.0')).toBe(true);
    expect(tagShape('3.1.0').test('3.2.0-fat')).toBe(false);
    expect(tagShape('627c19be-ls57').test('d2f5e718-ls58')).toBe(true);
    expect(tagShape('5.2.2-ls242').test('5.3.0-ls250')).toBe(true);
    expect(tagShape('5.2.2-ls242').test('arm64v8-5.3.0-ls250')).toBe(false);
  });
});
