import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assess } from './health.js';

const fx = (n: string) => JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__', n), 'utf8'));

describe('disk health', () => {
  it("the Toshiba's Raw_Read_Error_Rate quirk (normalized 0, raw 0, clean sectors) is not a failure", () => {
    // the owner's 6TB: SMART says FAILED because of attribute 1 alone; a full surface scan found 0 bad blocks.
    const a = assess(fx('sda.json'));
    expect(a.reasons.map((r) => r.code)).not.toContain('smart_failed');
    expect(a.status).toBe('good');
  });
  it('the same disk still fails on real trouble: read errors counted, or bad sectors', () => {
    const d = fx('sda.json');
    const withRaw = structuredClone(d);
    withRaw.ata_smart_attributes.table.find((x: { id: number }) => x.id === 1).raw.value = 12;
    expect(assess(withRaw).status).toBe('failing');
    expect(assess(withRaw).reasons.map((r) => r.code)).toContain('smart_failed');
    const pending = structuredClone(d);
    pending.ata_smart_attributes.table.find((x: { id: number }) => x.id === 197).raw.value = 8;
    expect(assess(pending).status).toBe('failing');
  });
  it('a healthy NVMe is good, with its wear level', () => {
    const a = assess(fx('nvme0n1.json'));
    expect(a.status).toBe('good');
    expect(a.wearPct).not.toBeNull();
  });
  it('a few reallocated sectors warn; more than last time means failing', () => {
    const disk = (n: number) => ({ smart_status: { passed: true }, ata_smart_attributes: { table: [{ id: 5, name: 'Reallocated_Sector_Ct', value: 100, thresh: 10, when_failed: '', raw: { value: n } }] } });
    expect(assess(disk(0)).status).toBe('good');
    expect(assess(disk(3)).status).toBe('warning');
    expect(assess(disk(5), { reallocated: 3 }).status).toBe('failing');
  });
  it('NVMe wear and media errors', () => {
    const nv = (o: object) => ({ smart_status: { passed: true }, nvme_smart_health_information_log: { critical_warning: 0, percentage_used: 10, media_errors: 0, available_spare: 100, available_spare_threshold: 10, ...o } });
    expect(assess(nv({ percentage_used: 95 })).status).toBe('warning');
    expect(assess(nv({ critical_warning: 4 })).status).toBe('failing');
    expect(assess(nv({ available_spare: 5 })).status).toBe('failing');
  });
});
