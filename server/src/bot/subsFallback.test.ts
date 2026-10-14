import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { cleanSrt, cueStarts, decodeSrt, parseCandidates, shiftSrt, srtFromZip, syncOffset } from './subsFallback.js';

/** A one-file zip, the way subtitle sites pack them (deflated). */
function zipOf(name: string, body: Buffer): Buffer {
  const data = zlib.deflateRawSync(body);
  const n = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(body.length, 22);
  local.writeUInt16LE(n.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(body.length, 24);
  central.writeUInt16LE(n.length, 28);
  central.writeUInt32LE(0, 42);
  const cdStart = local.length + n.length + data.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + n.length, 12);
  eocd.writeUInt32LE(cdStart, 16);
  return Buffer.concat([local, n, data, central, n, eocd]);
}

const srt = (starts: number[]) =>
  starts
    .map((s, i) => {
      const f = (x: number) => new Date(x * 1000).toISOString().slice(11, 23).replace('.', ',');
      return `${i + 1}\n${f(s)} --> ${f(s + 1.5)}\n{\\fs30}<font color="#FFA500">سطر ${i + 1}</font>\n`;
    })
    .join('\n');

describe('Arabic subtitles from the second source', () => {
  it('ranks BluRay rips first and cam/telesync last', () => {
    const html = `<table>
      <tr><td class="rating-cell"><span>3</span></td><td>Arabic</td><td><a href="/subtitles/x-arabic-1">Film 2016 HDTC x264</a></td></tr>
      <tr><td class="rating-cell"><span>0</span></td><td>Arabic</td><td><a href="/subtitles/x-arabic-2">Film.2016.720p.BluRay.x264</a></td></tr>
      <tr><td class="rating-cell"><span>9</span></td><td>English</td><td><a href="/subtitles/x-english-3">Film BluRay</a></td></tr></table>`;
    expect(parseCandidates(html).map((c) => c.slug)).toEqual(['/subtitles/x-arabic-2', '/subtitles/x-arabic-1']);
  });

  it('reads the .srt out of the zip and decodes old Windows-Arabic files', () => {
    const cp1256 = Buffer.from([0xe1, 0xc7]); // "لا" in Windows-1256
    expect(decodeSrt(srtFromZip(zipOf('film.srt', cp1256))!)).toBe('لا');
    expect(decodeSrt(Buffer.from('﻿لا'))).toBe('لا');
  });

  it('strips ASS codes and colours, keeps the text and timing', () => {
    const t = cleanSrt(srt([10]));
    expect(t).toContain('سطر 1');
    expect(t).not.toMatch(/[{}]|font/);
    expect(cueStarts(t)).toEqual([10]);
  });

  it('accepts a subtitle that lines up (offset corrected), rejects one that does not', () => {
    const ref = Array.from({ length: 200 }, (_, i) => 30 + i * 5.3);
    const good = srt([...ref.map((r) => r + 0.8), ...Array.from({ length: 200 }, (_, i) => 1400 + i * 4)]);
    expect(syncOffset(good, ref, 7200)).toBeCloseTo(0.8, 1);
    expect(cueStarts(shiftSrt(good, -0.8))[0]).toBeCloseTo(30, 2);
    const wrong = srt(Array.from({ length: 400 }, (_, i) => 31.7 + i * 2.9));
    expect(syncOffset(wrong, ref, 7200)).toBeNull();
  });

  it('without a reference: the subtitle must end inside the film', () => {
    const t = srt(Array.from({ length: 150 }, (_, i) => i * 40));
    expect(syncOffset(t, [], 6100)).toBe(0); // last cue 99 min, film 102 min
    expect(syncOffset(t, [], 9000)).toBeNull(); // 150-minute film: this belongs to something else
  });
});
