import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { exifTaken } from './gallery.js';

const fx = (n: string) => fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__', n));

describe('exifTaken', () => {
  it('reads DateTimeOriginal from the Exif IFD', () => {
    expect(exifTaken(fx('exif.jpg'))).toBe(Date.UTC(2023, 4, 14, 10, 20, 30));
  });
  it('falls back to IFD0 DateTime', () => {
    expect(exifTaken(fx('exif-dt.jpg'))).toBe(Date.UTC(2022, 11, 31, 23, 59, 58));
  });
  it('returns null without EXIF or for non-JPEG data', () => {
    expect(exifTaken(fx('noexif.jpg'))).toBeNull();
    expect(exifTaken(Buffer.from('not a jpeg'))).toBeNull();
    expect(exifTaken(Buffer.alloc(0))).toBeNull();
  });
  it('never throws on truncated input', () => {
    const buf = fx('exif.jpg');
    for (let n = 0; n < buf.length; n += 7) expect(() => exifTaken(buf.subarray(0, n))).not.toThrow();
  });
});
