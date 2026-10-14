import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'manar-ap-'));
process.env.MANAR_DATA_DIR = path.join(tmp, 'var');
process.env.MANAR_DEV = '1';
const { account, addApTorrent, infoHash, parseList, shelfFor } = await import('./arabp2p.js');
const html = fs.readFileSync(new URL('./__fixtures__/arabp2p-list.html', import.meta.url), 'utf8');

describe('ArabP2P', () => {
  it('reads a torrent list page and the member ratio', () => {
    const items = parseList(html);
    expect(items.length).toBe(3);
    expect(items[0]).toMatchObject({ id: '114329', catId: 85, sizeGB: 19.92, seeders: 5, leechers: 0 });
    expect(items[0].name).toContain('HarveyToons');
    expect(items[0].dl).toMatch(/^download\.php\?id=114329&f=/);
    expect(items[2].free).toBe(true);
    expect(items[0].free).toBe(false);
    expect(account(html)).toEqual({ upGB: 598.6, downGB: 480.48, ratio: 1.25 });
  });
  it('puts each category on its shelf', () => {
    expect(shelfFor({ catId: 98, name: 'فتى الدلفين [مدبلج]' })).toBe('Cartoons');
    expect(shelfFor({ catId: 100, name: 'x' })).toBe('Cartoon Series');
    expect(shelfFor({ catId: 85, name: 'كرتون كلاسيك هارفيتونز [The HarveyToons Show 1950 62]' })).toBe('Cartoon Series');
    expect(shelfFor({ catId: 41, name: 'فيلم' })).toBe('Movies');
    expect(shelfFor({ catId: 19, name: 'x' })).toBe('Documentaries');
  });
  it('keeps the ratio at 1 or above', async () => {
    const it = { id: '1', name: 'Big', category: '', catId: 98, sizeGB: 200, seeders: 3, leechers: 0, added: '', dl: 'download.php?id=1', free: false };
    const r = await addApTorrent(it, { upGB: 598.6, downGB: 480.48, ratio: 1.25 });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/نسبتك/);
  });
  it('computes a torrent info-hash', () => {
    const info = 'd6:lengthi5e4:name1:a12:piece lengthi16384e6:pieces20:aaaaaaaaaaaaaaaaaaaae';
    const t = Buffer.from(`d8:announce3:x:y4:info${info}e`);
    expect(infoHash(t)).toBe(crypto.createHash('sha1').update(info).digest('hex').toUpperCase());
  });
});
