import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'manar-tpb-'));
process.env.MANAR_DATA_DIR = path.join(tmp, 'var');
process.env.MANAR_DEV = '1';
const { magnetOf, resolvePick, searchTorrents } = await import('./apps.js');
const { cleanRows, dropHad, renderView } = await import('./torrentUi.js');
const { magnetInfo, remember, titleKey, history } = await import('./torrentHistory.js');

const row = (id: string, name: string, seeders: number, category = '207', hash = id.padStart(40, 'A')) => ({ id, name, info_hash: hash, seeders: String(seeders), leechers: '3', size: String(2 * 1024 ** 3), added: '1700000000', category, status: id === '2' ? 'vip' : 'member', num_files: '1' });

describe('torrent search (apibay)', () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch');
  afterAll(() => fetchMock.mockRestore());

  it('ranks by seeders, drops adult categories and empty hits, numbers the results', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([row('1', 'Big Buck Bunny 1080p', 5), row('2', 'Big Buck Bunny 4K', 50), row('3', 'xxx', 900, '501')]), { status: 200 }));
    const r = await searchTorrents('big buck bunny', 'movies');
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://apibay.org/q.php?q=big%20buck%20bunny&cat=201');
    expect(r.results.map((x) => [x.n, x.name, x.trusted])).toEqual([
      [1, 'Big Buck Bunny 4K', true],
      [2, 'Big Buck Bunny 1080p', false],
    ]);
    expect(r.results[0].sizeGB).toBe(2);
  });

  it('turns "#2" or "tpb:<id>" from the last search into a magnet link', () => {
    expect(resolvePick('#2')!.name).toBe('Big Buck Bunny 1080p');
    expect(resolvePick('1')!.magnet).toBe(magnetOf('2'.padStart(40, 'A'), 'Big Buck Bunny 4K'));
    expect(resolvePick('tpb:1')!.name).toBe('Big Buck Bunny 1080p');
    expect(resolvePick('#9')).toBeNull();
    expect(resolvePick('magnet:?xt=urn:btih:abc')).toBeNull();
    expect(magnetOf('ABC', 'a b')).toMatch(/^magnet:\?xt=urn:btih:ABC&dn=a%20b&tr=udp/);
  });

  it('says "no results" plainly', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([{ id: '0', name: 'No results returned', info_hash: '0000000000000000000000000000000000000000', seeders: '0', leechers: '0', size: '0', added: '0', category: '0', status: 'member', num_files: '0' }]), { status: 200 }));
    expect((await searchTorrents('zzzz')).results).toEqual([]);
  });

  it('/torrent lists: no adult, no duplicates, nothing he already has (same hash or same film), pages of 5', () => {
    expect(titleKey('Spider-Man.Brand.New.Day.2026.1080p.MA.WEB-DL')).toBe('spider man brand new day 2026');
    expect(titleKey('Spider Man Brand New Day (2026) 2160p HDR')).toBe('spider man brand new day 2026');
    expect(titleKey('Marshals S02E02 1080p WEB H264-CAKES')).toBe('marshals s02e02');
    remember('A'.repeat(40), 'Spider-Man.Brand.New.Day.2026.1080p.WEB');
    expect(history()[0].k).toBe('spider man brand new day 2026');
    const rows = [row('1', 'Spider Man Brand New Day (2026) 2160p', 900), row('2', 'Dune Part Three 2026 1080p', 500), row('3', 'xxx', 999, '501'), row('4', 'Dune Part Three 2026 1080p', 400, '207', 'B'.repeat(40)), ...Array.from({ length: 7 }, (_, k) => row(String(10 + k), `Film ${k} 2025 720p`, 100 - k))];
    rows[3].info_hash = rows[1].info_hash; // the same torrent twice
    const items = cleanRows(rows);
    expect(items.some((x) => x.name === 'xxx')).toBe(false);
    expect(items.filter((x) => x.name.startsWith('Dune')).length).toBe(1);
    const { items: left, hidden } = dropHad(items, { hashes: new Set(['C'.repeat(40)]), keys: new Set(history().map((h) => h.k)) });
    expect(hidden).toBe(1);
    expect(left[0].name).toBe('Dune Part Three 2026 1080p');
    const v = { id: 'abc123', title: 'Test', items: left, page: 0, hidden, started: [left[1].hash] };
    const r = renderView(v);
    expect(r.text).toContain('أخفيت 1');
    expect(r.rows[0].map((b) => b.data)).toEqual(['tor:dl:abc123:1', 'tor:x', 'tor:dl:abc123:3', 'tor:dl:abc123:4', 'tor:dl:abc123:5']);
    expect(r.rows[1].map((b) => b.text)).toEqual(['1/2', '➡️', '🏠']);
    expect(renderView({ ...v, page: 1 }).rows[1].map((b) => b.text)).toEqual(['⬅️', '2/2', '🏠']);
    expect(magnetInfo(magnetOf('d'.repeat(40), 'My Film 2024'))).toEqual({ hash: 'D'.repeat(40), name: 'My Film 2024' });
  });
});
