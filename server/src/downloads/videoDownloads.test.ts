import { describe, expect, it } from 'vitest';
import { finalStem, safeSegment, selectVideoItems } from './videoDownloads.js';

describe('video downloads', () => {
  it('keeps readable Unicode names but removes path traversal and invalid filename characters', () => {
    expect(safeSegment('  مسلسل عربي: الحلقة الأولى  ')).toBe('مسلسل عربي الحلقة الأولى');
    expect(safeSegment('../../Season/One\\Bad?')).toBe('Season One Bad');
    expect(safeSegment('...')).toBe('Video');
    expect(safeSegment('', '../Fallback/Name')).toBe('Fallback Name');
    expect(safeSegment('100% مسلسل')).toBe('100% مسلسل');
  });

  it('keeps only explicitly selected playlist entries, applies edited titles, and renumbers them', () => {
    const items = [
      { id: 'a', position: 1, title: 'Original 1', duration: 10, url: null },
      { id: 'ad', position: 2, title: 'Unrelated', duration: 20, url: null },
      { id: 'b', position: 3, title: 'Original 2', duration: 30, url: null },
    ];
    expect(selectVideoItems(items, [
      { id: 'a', position: 1, title: 'الحلقة الأولى' },
      { id: 'b', position: 3, title: 'الحلقة الثانية' },
    ])).toEqual([
      expect.objectContaining({ id: 'a', position: 1, sourcePosition: 1, title: 'الحلقة الأولى' }),
      expect.objectContaining({ id: 'b', position: 2, sourcePosition: 3, title: 'الحلقة الثانية' }),
    ]);
  });

  it('rejects stale or empty selections', () => {
    const items = [{ id: 'a', position: 1, title: 'One', duration: null, url: null }];
    expect(() => selectVideoItems(items, [])).toThrow('Select at least one video');
    expect(() => selectVideoItems(items, [{ id: 'old', position: 1, title: 'One' }])).toThrow('playlist changed');
  });

  it('builds final Jellyfin names from the edited item title', () => {
    expect(finalStem(
      { title: 'باب الحارة', library: 'series', season: 1 },
      { position: 2, title: 'الحلقة الثانية', source_id: 'abc123' },
    )).toBe('باب الحارة - S01E02 - الحلقة الثانية [abc123]');
  });
});
