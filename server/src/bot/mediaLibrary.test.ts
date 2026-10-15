import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'manar-media-'));
process.env.MANAR_DATA_DIR = path.join(tmp, 'var');
process.env.MANAR_DEV = '1';
process.env.MANAR_MEDIA_ROOT = path.join(tmp, 'disk');
const { cleanShowName, destination, libExt, linkInto, movieKind, organizeFiles, placeVideo, seasonFor, parseRelease, pickSubtitle, seriesKind } = await import('./mediaLibrary.js');

describe('media library: reading release names', () => {
  it('films: title and year, without the quality tags', () => {
    expect(parseRelease('Dracula.Eternal.2026.1080p.WEB-DL.H264-PlayfulDarkness.mkv')).toMatchObject({ title: 'Dracula Eternal', year: 2026, kind: 'movie' });
    expect(parseRelease('Spider-Man.Brand.New.Day.2026.1080p.MA.WEB-DL.DDP5.1.Atmos.H.264')).toMatchObject({ title: 'Spider-Man Brand New Day', year: 2026 });
    expect(parseRelease('Colony (2026) (1080p DS4K UHD BluRay x265 10bit)')).toMatchObject({ title: 'Colony', year: 2026 });
    expect(parseRelease('Blade Runner 2049 2017 2160p UHD BluRay')).toMatchObject({ title: 'Blade Runner 2049', year: 2017 });
    expect(parseRelease('Big Buck Bunny')).toMatchObject({ title: 'Big Buck Bunny', kind: 'movie' });
  });
  it('series, season packs and anime', () => {
    expect(parseRelease('Marshals S02E02 1080p WEB H264-CAKES')).toMatchObject({ title: 'Marshals', season: 2, episode: 2, kind: 'episode' });
    expect(parseRelease('The.Office.US.3x07.720p.mkv')).toMatchObject({ title: 'The Office US', season: 3, episode: 7 });
    expect(parseRelease('Dark Matter 2024 S02E05 HDTV H 264-NGP')).toMatchObject({ title: 'Dark Matter', year: 2024, season: 2, episode: 5 });
    expect(parseRelease('Severance.S02.COMPLETE.1080p.WEB')).toMatchObject({ title: 'Severance', season: 2, kind: 'movie' });
    expect(parseRelease('[SubsPlease] Frieren - 12 (1080p) [ABCD1234].mkv')).toMatchObject({ title: 'Frieren', season: 1, episode: 12, anime: true, kind: 'episode' });
  });
  it('places them the way Jellyfin reads them', () => {
    expect(destination(parseRelease('Dracula.Eternal.2026.1080p.WEB.mkv'), 'movies', '.mkv')).toBe('Movies/Dracula Eternal (2026)/Dracula Eternal (2026).mkv');
    expect(destination(parseRelease('Marshals S02E02 1080p WEB'), 'series', '.mkv', 'Marshals', 2026)).toBe('Foreign Series/Marshals (2026)/Season 02/Marshals S02E02.mkv');
    expect(destination(parseRelease('[Erai-raws] Frieren - 03 [1080p].mkv'), 'anime', '.mkv', 'Frieren: Beyond Journey\'s End', 2023)).toBe("Anime/Frieren Beyond Journey's End (2023)/Season 01/Frieren Beyond Journey's End S01E03.mkv");
  });
  it('sorts by kind: TVmaze for series, Jellyfin genres for films', () => {
    expect(seriesKind({ name: 'x', type: 'Scripted', genres: ['Drama'] }, false)).toBe('series');
    expect(seriesKind({ name: 'باب الحارة', type: 'Scripted', genres: ['Drama'], language: 'Arabic' }, false)).toBe('arabicSeries');
    expect(seriesKind({ name: 'x', type: 'Animation', genres: ['Anime'], language: 'Japanese' }, false)).toBe('anime');
    expect(seriesKind({ name: 'x', type: 'Animation', genres: ['Comedy'], language: 'English' }, false)).toBe('cartoonSeries');
    expect(seriesKind({ name: 'x', type: 'Documentary' }, false)).toBe('documentaries');
    expect(seriesKind(null, true)).toBe('anime');
    expect(movieKind({ Genres: ['Animation', 'Family'], ProductionLocations: ['United States of America'] })).toBe('cartoons');
    expect(movieKind({ Genres: ['Animation', 'Fantasy'], ProductionLocations: ['Japan'] })).toBe('anime');
    expect(movieKind({ Genres: ['Documentary'] })).toBe('documentaries');
    expect(movieKind({ Genres: ['Action'] })).toBe('movies');
  });
  it('picks the subtitle that matches the release, then the most downloaded', () => {
    const subs = [
      { Id: 'a', Name: 'Dracula Eternal 2026 BluRay', DownloadCount: 900 },
      { Id: 'b', Name: 'Dracula.Eternal.2026.1080p.WEB-DL.H264-PlayfulDarkness', DownloadCount: 20 },
    ];
    expect(pickSubtitle(subs, 'Dracula.Eternal.2026.1080p.WEB-DL.H264-PlayfulDarkness.mkv')!.Id).toBe('b');
    expect(pickSubtitle([], 'x')).toBeNull();
  });
  it('hardlinks: the same file twice, no extra space', () => {
    const a = path.join(tmp, 'src.mkv');
    fs.writeFileSync(a, 'video');
    const b = path.join(tmp, 'lib', 'Movies', 'X (2020)', 'X (2020).mkv');
    linkInto(a, b);
    linkInto(a, b); // again: no error
    expect(fs.statSync(a).ino).toBe(fs.statSync(b).ino);
  });

  it('Arabic episode names and site-tagged folder names', () => {
    expect(parseRelease('الكابتن ماجد الجزء الثاني الحلقة 05.mp4')).toMatchObject({ season: 2, episode: 5, kind: 'episode' });
    expect(parseRelease('ريمي ح 13.avi')).toMatchObject({ season: 1, episode: 13 });
    expect(parseRelease('1985 - Asterix.Versus.Caesar.avi')).toMatchObject({ title: 'Asterix Versus Caesar', year: 1985, kind: 'movie' });
    expect(parseRelease('AL HOSAN AL SAGHEER 1986')).toMatchObject({ title: 'AL HOSAN AL SAGHEER', year: 1986 });
    expect(parseRelease('CT] Neda AlBarary [HQ].avi')).toMatchObject({ title: 'Neda AlBarary', kind: 'movie' });
    expect(parseRelease('Grendizer Ep 07 arabic.mkv')).toMatchObject({ episode: 7, title: 'Grendizer' });
    expect(cleanShowName('[www.arabp 2p.net] المسلسل الكرتوني جزيرة الكنز [كامل][مدبلج]')).toBe('المسلسل الكرتوني جزيرة الكنز');
    expect(cleanShowName('C.MS101Konnoha.blogspot.com_201312')).not.toMatch(/blogspot/);
  });

  it('a DVD goes in only once its whole VIDEO_TS folder is there', async () => {
    const src = path.join(tmp, 'dl');
    const names = ['Pack/BARNEY/VIDEO_TS/VTS_01_0.IFO', 'Pack/BARNEY/VIDEO_TS/VTS_01_1.VOB', 'Pack/BARNEY/VIDEO_TS/VTS_01_2.VOB'];
    for (const n of names.slice(0, 2)) {
      fs.mkdirSync(path.dirname(path.join(src, n)), { recursive: true });
      fs.writeFileSync(path.join(src, n), 'x');
    }
    const big = 600 * 1024 * 1024;
    const files = (done: number) => names.map((name, i) => ({ name, size: i ? big : 1, progress: i < done ? 1 : 0 }));
    const meta = { hash: 'ARCHIVE:x', name: 'Pack', category: 'Cartoons' };
    const hostOf = (n: string) => path.join(src, n);
    expect(await organizeFiles(meta, files(2), hostOf)).toEqual([]);
    expect(fs.existsSync(path.join(tmp, 'disk', 'Media', 'Cartoons', 'BARNEY'))).toBe(false);
    fs.writeFileSync(path.join(src, names[2]), 'x');
    const p = await organizeFiles(meta, files(3), hostOf);
    expect(p.map((x) => path.basename(x.dest))).toEqual(['BARNEY']);
    expect(fs.readdirSync(path.join(tmp, 'disk', 'Media', 'Cartoons', 'BARNEY', 'VIDEO_TS'))).toHaveLength(3);
  });

  it("a collection's running number is not part of the title", () => {
    expect(parseRelease('01.Iron Man (2008) 1080p 10bit Bluray x265 HEVC [Org DD 5.1 Hindi + DD 5.1 English] MSubs ~ TombDoc.mkv')).toMatchObject({ title: 'Iron Man', year: 2008 });
    expect(parseRelease('16.Spider-Man - Homecoming (2017) 1080p.mkv')).toMatchObject({ title: 'Spider-Man - Homecoming', year: 2017 });
    expect(parseRelease('1917.2019.1080p.BluRay.x264.mkv')).toMatchObject({ title: '1917', year: 2019 });
  });

  it('long anime: absolute episode numbers go to their TMDB season (keeping the number)', () => {
    const dir = path.join(tmp, 'One Piece');
    fs.mkdirSync(dir, { recursive: true });
    expect(seasonFor(dir, 62, 1)).toBe(1); // no map: unchanged
    fs.writeFileSync(path.join(dir, '.seasons.json'), JSON.stringify([1, 62, 78, 92]));
    expect(seasonFor(dir, 61, 1)).toBe(1);
    expect(seasonFor(dir, 62, 1)).toBe(2);
    expect(seasonFor(dir, 100, 1)).toBe(4);
    expect(seasonFor(dir, 5, 3)).toBe(3); // a real season from the file name wins
    expect(destination({ title: 'One Piece', season: 2, episode: 62, anime: false, kind: 'episode' }, 'anime', '.mkv', 'One Piece')).toBe('Anime/One Piece/Season 02/One Piece S02E62.mkv');
  });

  it('MPEG-TS goes into the library as MP4 (same streams, no re-encode)', async () => {
    expect(libExt('Sally S01E01.ts')).toBe('.mp4');
    expect(libExt('Film.MKV')).toBe('.mkv');
    const { execFileSync } = await import('node:child_process');
    const ts = path.join(tmp, 'ep.ts');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=d=1:s=160x120', '-f', 'lavfi', '-i', 'sine=d=1', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', ts]);
    const out = await placeVideo(ts, path.join(tmp, 'lib', 'ep.mp4'));
    expect(out.endsWith('ep.mp4')).toBe(true);
    const streams = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', out]).toString().trim().split('\n');
    expect(streams).toEqual(['h264', 'aac']);
  });
});
