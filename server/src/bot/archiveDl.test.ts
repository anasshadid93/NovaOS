import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'manar-ia-'));
process.env.MANAR_DATA_DIR = path.join(tmp, 'var');
process.env.MANAR_MEDIA_ROOT = path.join(tmp, 'toshiba');
process.env.MANAR_DEV = '1';
const { addArchiveItem, archiveDownloads, archiveJobs, archiveTick, localPath } = await import('./archiveDl.js');

const film = Buffer.alloc(3000, 7);
describe('Internet Archive downloads', () => {
  it('takes only the original videos, downloads them (resuming a partial file) and hands them to the library', async () => {
    const calls: { url: string; range?: string }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const range = (init?.headers as Record<string, string> | undefined)?.Range;
      calls.push({ url, range });
      if (url.includes('/metadata/')) {
        return new Response(
          JSON.stringify({
            metadata: { title: 'Dubbed films' },
            files: [
              { name: 'Films/A (1990)/A.avi', size: '3000', source: 'original' },
              { name: 'Films/A (1990)/A.mp4', size: '900', source: 'derivative' },
              { name: 'Films/A (1990)/A.jpg', size: '10', source: 'original' },
            ],
          }),
        );
      }
      const from = range ? Number(/bytes=(\d+)-/.exec(range)![1]) : 0;
      return new Response(film.subarray(from), { status: from ? 206 : 200 });
    });
    const job = await addArchiveItem('item1', 'Cartoons');
    expect(job.files.map((f) => f.name)).toEqual(['Films/A (1990)/A.avi']);
    // A half-finished earlier attempt is resumed, not restarted.
    fs.mkdirSync(path.dirname(localPath('item1', 'Films/A (1990)/A.avi')), { recursive: true });
    fs.writeFileSync(`${localPath('item1', 'Films/A (1990)/A.avi')}.part`, film.subarray(0, 1000));
    await archiveTick();
    await vi.waitFor(() => expect(archiveJobs()[0].files[0].done).toBe(true));
    expect(calls.find((c) => c.url.includes('A.avi'))!.range).toBe('bytes=1000-');
    expect(fs.readFileSync(localPath('item1', 'Films/A (1990)/A.avi')).equals(film)).toBe(true);
    const d = archiveDownloads()[0];
    expect(d.meta).toEqual({ hash: 'ARCHIVE:item1', name: 'Dubbed films', category: 'Cartoons' });
    expect(d.files[0].progress).toBe(1);
    await archiveTick(); // all done → the job closes
    expect(archiveJobs()[0].status).toBe('done');
  });
});
