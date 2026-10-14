import { describe, expect, it } from 'vitest';
import { folderNameFor, isArchive } from './extract.js';

describe('extract', () => {
  it('names the folder after the archive', () => {
    expect(folderNameFor('/a/Game (USA).zip')).toBe('Game (USA)');
    expect(folderNameFor('/a/src.tar.gz')).toBe('src');
    expect(folderNameFor('/a/Movie.part1.rar')).toBe('Movie');
    expect(folderNameFor('/a/big.7z.001')).toBe('big');
    expect(folderNameFor('/a/.zip')).toBe('extracted');
  });
  it('knows archives', () => {
    for (const n of ['a.zip', 'a.RAR', 'a.7z', 'a.tar.xz', 'a.iso', 'a.001']) expect(isArchive(n)).toBe(true);
    for (const n of ['a.mp4', 'a.pdf', 'zip']) expect(isArchive(n)).toBe(false);
  });
});
