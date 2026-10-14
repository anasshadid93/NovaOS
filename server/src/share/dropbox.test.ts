import { describe, expect, it } from 'vitest';
import { looksExecutable, safeName } from './dropbox.js';

describe('upload links', () => {
  it('rebuilds file names so they cannot escape or hide', () => {
    expect(safeName('../../etc/passwd')).toBe('_.._etc_passwd');
    expect(safeName('C:\\Users\\x\\report.pdf')).toBe('C:_Users_x_report.pdf');
    expect(safeName('.htaccess')).toBe('htaccess');
    expect(safeName('photo\u202e.gpj.exe')).toBe('photo.gpj.exe');
    expect(safeName('  ')).toBe('file');
    expect(safeName('a'.repeat(300) + '.jpg').length).toBeLessThanOrEqual(150);
    expect(safeName('a'.repeat(300) + '.jpg').endsWith('.jpg')).toBe(true);
  });
  it('recognises programs by their first bytes', () => {
    expect(looksExecutable(Buffer.from('\x7fELF\x02\x01\x01\x00', 'latin1'))).toBe(true);
    expect(looksExecutable(Buffer.from('MZ\x90\x00\x03\x00\x00\x00', 'latin1'))).toBe(true);
    expect(looksExecutable(Buffer.from('#!/bin/sh\n'))).toBe(true);
    expect(looksExecutable(Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]))).toBe(true);
    expect(looksExecutable(Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'))).toBe(false);
    expect(looksExecutable(Buffer.from('%PDF-1.7\n'))).toBe(false);
    expect(looksExecutable(Buffer.from('hi'))).toBe(false);
  });
});
