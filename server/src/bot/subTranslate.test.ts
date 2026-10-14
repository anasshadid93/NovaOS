import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'manar-subs-'));
process.env.MANAR_DATA_DIR = path.join(tmp, 'var');
process.env.MANAR_DEV = '1';
const { enqueue, jobs, parseSrt, readNumbered, toSrt, translateBatch } = await import('./subTranslate.js');

const SRT = '﻿1\r\n00:00:25,208 --> 00:00:28,833\r\n[dramatic music]\r\n\r\n2\r\n00:00:39,208 --> 00:00:40,291\r\n<i>I\'m bored.</i>\r\n\r\n3\r\n00:00:41,708 --> 00:00:43,416\r\nLights over here,\r\nit sounds like people\r\n\r\n';

describe('subtitle translation', () => {
  it('reads SRT (BOM, CRLF, tags, two-line cues) and writes it back with the same timings', () => {
    const cues = parseSrt(SRT);
    expect(cues).toHaveLength(3);
    expect(cues[2]).toEqual({ start: '00:00:41,708', end: '00:00:43,416', text: 'Lights over here,\nit sounds like people' });
    const out = toSrt([{ ...cues[0], text: '[موسيقى درامية]' }], true);
    expect(out).toBe('1\n00:00:25,208 --> 00:00:28,833\n‏[موسيقى درامية]\n');
  });

  it('reads the numbered answer, whatever the separator', () => {
    expect(readNumbered('1. أين كنت؟\n2) قلت لك\n3 - حسناً\nnoise', 4)).toEqual(['أين كنت؟', 'قلت لك', 'حسناً', null]);
  });

  it('splits and retries a batch the model answered only in part', async () => {
    const calls: number[] = [];
    // A model that drops the last line of any batch longer than 2.
    const ask = async (p: string) => {
      const lines = p.split('\n').filter((l) => /^\d+\. /.test(l));
      calls.push(lines.length);
      return lines
        .slice(0, lines.length > 2 ? -1 : undefined)
        .map((l) => l.replace(/^(\d+)\. (.*)$/, '$1. AR:$2'))
        .join('\n');
    };
    const r = await translateBatch(['a', 'b', 'c', 'd'], [], 'Film', ask);
    expect(r).toEqual(['AR:a', 'AR:b', 'AR:c', 'AR:d']);
    expect(calls[0]).toBe(4);
  });

  it('queues a film once', () => {
    enqueue('abc', 'Dracula Eternal (2026)');
    enqueue('abc', 'Dracula Eternal (2026)');
    expect(jobs().filter((j) => j.itemId === 'abc')).toHaveLength(1);
  });
});
