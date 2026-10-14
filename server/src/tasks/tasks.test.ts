import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manar-tasks-'));
process.env.MANAR_DATA_DIR = dir;
const { enqueue, getTask, registerTask, taskCounts } = await import('./tasks.js');
const { closeDb } = await import('../db.js');

afterAll(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function waitDone(id: number) {
  for (let i = 0; i < 100; i++) {
    const t = getTask(id) as { status: string };
    if (t.status === 'succeeded' || t.status === 'failed') return t as { status: string; log: string; error: string | null };
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timeout');
}

describe('task runner', () => {
  registerTask('test.ok', async (ctx) => {
    ctx.progress('step 1');
    await ctx.run('echo', ['hello from child']);
  });
  registerTask('test.fail', async (ctx) => {
    await ctx.run('sh', ['-c', 'echo boom >&2; exit 3']);
  });

  it('runs tasks in order and records output', async () => {
    const a = enqueue('test.ok', 'ok');
    const b = enqueue('test.fail', 'fail');
    const ta = await waitDone(a);
    const tb = await waitDone(b);
    expect(ta.status).toBe('succeeded');
    expect(ta.log).toContain('hello from child');
    expect(ta.log).toContain('step 1');
    expect(tb.status).toBe('failed');
    expect(tb.log).toContain('boom');
    expect(tb.error).toContain('exited with 3');
    expect(taskCounts()).toMatchObject({ succeeded: 1, failed: 1 });
  });
});
