import { describe, expect, it } from 'vitest';
import { fileNameFor } from './downloads.js';

describe('direct download file names', () => {
  it('uses Content-Disposition, then the URL path', () => {
    expect(fileNameFor('https://x.com/a/b.zip', 'attachment; filename="Game Demo.pkg"')).toBe('Game Demo.pkg');
    expect(fileNameFor('https://x.com/a/b.zip', "attachment; filename*=UTF-8''%D9%85%D9%84%D9%81.zip")).toBe('ملف.zip');
    expect(fileNameFor('https://x.com/dl/My%20File.iso?x=1', null)).toBe('My File.iso');
  });
  it('never escapes the Downloads folder', () => {
    expect(fileNameFor('https://x.com/', 'attachment; filename="../../etc/passwd"')).toBe('_.._etc_passwd');
    expect(fileNameFor('https://x.com/', null)).toMatch(/^download-\d+$/);
  });
});
