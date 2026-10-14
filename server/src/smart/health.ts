import type { FastifyInstance } from 'fastify';
import { getDb, kvGet, kvSet } from '../db.js';
import { requireAuth } from '../auth/sessions.js';
import { DEVICE_RE, runHelper } from '../helper.js';
import { commandExists, disks } from '../system/info.js';

/**
 * Disk health: SMART for every disk every 6 hours, turned into good / warning / failing with
 * plain reasons, plus history so a growing number of bad sectors is noticed early. Alerts flow
 * into the normal alert loop (notifications, WhatsApp).
 */

export type Health = 'good' | 'warning' | 'failing' | 'unknown';
export interface Reason {
  level: 'warning' | 'failing';
  code: string;
  /** Number shown in the message (sectors, °C, % used…). */
  n?: number;
}
export interface DiskHealth {
  name: string;
  model: string | null;
  serial: string | null;
  size: number;
  rotational: boolean;
  status: Health;
  reasons: Reason[];
  temperature: number | null;
  powerOnHours: number | null;
  /** SSD/NVMe wear, 0–100+. */
  wearPct: number | null;
  checkedAt: number;
}

type Json = Record<string, unknown>;
const get = (d: Json, p: string): unknown => p.split('.').reduce<unknown>((o, k) => (o as Json | undefined)?.[k], d);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** SMART JSON (smartctl --json -x) → status and reasons. `prev` = counters from the last check. */
export function assess(d: Json, prev?: Record<string, number>): { status: Health; reasons: Reason[]; counters: Record<string, number>; temperature: number | null; powerOnHours: number | null; wearPct: number | null } {
  const reasons: Reason[] = [];
  const counters: Record<string, number> = {};
  const passed = get(d, 'smart_status.passed');

  // ATA attributes: anything past its threshold, and the sector counters that predict failure.
  const ata = (get(d, 'ata_smart_attributes.table') as { id: number; name: string; value: number; thresh: number; when_failed: string; raw: { value: number } }[] | undefined) ?? [];
  const raw = (id: number) => ata.find((a) => a.id === id)?.raw?.value ?? null;
  // Some Toshiba firmwares report Raw_Read_Error_Rate (1) at normalized 0 with a raw count of 0 —
  // no read errors at all — which also flips the overall self-assessment to FAILED. the owner's 6TB does
  // this and passed a full surface scan; it's ignored while the raw count and the sector counters
  // (reallocated / pending / uncorrectable, checked below) stay at 0.
  const clean = [5, 197, 198].every((id) => !raw(id));
  const quirk = (a: { id: number; raw: { value: number } }) => a.id === 1 && a.raw?.value === 0 && clean;
  const failed = ata.filter((a) => a.when_failed || (a.thresh > 0 && a.value <= a.thresh));
  for (const a of failed) if (!quirk(a)) reasons.push({ level: 'failing', code: 'attribute_failed', n: a.id });
  const onlyQuirk = passed === false && failed.length > 0 && failed.every(quirk);
  if (passed === false && !onlyQuirk) reasons.push({ level: 'failing', code: 'smart_failed' });
  const sectors: [number, string][] = [
    [5, 'reallocated'],
    [197, 'pending'],
    [198, 'uncorrectable'],
    [187, 'reported_uncorrect'],
  ];
  for (const [id, code] of sectors) {
    const v = raw(id);
    if (v === null) continue;
    counters[code] = v;
    if (v > 0) reasons.push({ level: v >= 100 || (prev && prev[code] !== undefined && v > prev[code]) ? 'failing' : 'warning', code, n: v });
  }

  // NVMe health log.
  const nv = get(d, 'nvme_smart_health_information_log') as Json | undefined;
  let wearPct: number | null = null;
  if (nv) {
    const cw = num(nv.critical_warning) ?? 0;
    if (cw) reasons.push({ level: 'failing', code: 'nvme_critical', n: cw });
    wearPct = num(nv.percentage_used);
    if (wearPct !== null && wearPct >= 90) reasons.push({ level: wearPct >= 100 ? 'failing' : 'warning', code: 'worn', n: wearPct });
    const media = num(nv.media_errors) ?? 0;
    counters.media_errors = media;
    if (media > 0) reasons.push({ level: prev?.media_errors !== undefined && media > prev.media_errors ? 'failing' : 'warning', code: 'media_errors', n: media });
    const spare = num(nv.available_spare);
    const spareThresh = num(nv.available_spare_threshold);
    if (spare !== null && spareThresh !== null && spare <= spareThresh) reasons.push({ level: 'failing', code: 'spare_low', n: spare });
  }

  const temperature = num(get(d, 'temperature.current'));
  const hot = nv ? 70 : 55;
  if (temperature !== null && temperature >= hot) reasons.push({ level: 'warning', code: 'hot', n: temperature });

  const status: Health = reasons.some((r) => r.level === 'failing') ? 'failing' : reasons.length ? 'warning' : passed === true || onlyQuirk || nv ? 'good' : 'unknown';
  return { status, reasons, counters, temperature, powerOnHours: num(get(d, 'power_on_time.hours')), wearPct };
}

let latest: DiskHealth[] = [];
/** The last check's results (cached; checks run every 6 hours). */
export const latestDiskHealth = () => latest;
let running: Promise<DiskHealth[]> | null = null;

function loadCache() {
  try {
    latest = JSON.parse(kvGet('disk_health') ?? '[]') as DiskHealth[];
  } catch {
    latest = [];
  }
}

export async function checkDisks(): Promise<DiskHealth[]> {
  running ??= (async () => {
    if (!(await commandExists('smartctl'))) return latest;
    const out: DiskHealth[] = [];
    let prevCounters: Record<string, Record<string, number>> = {};
    try {
      prevCounters = JSON.parse(kvGet('disk_counters') ?? '{}');
    } catch {
      /* first run */
    }
    const nextCounters: Record<string, Record<string, number>> = {};
    for (const disk of await disks()) {
      if (!DEVICE_RE.test(disk.path)) continue;
      const id = disk.serial ?? disk.name;
      try {
        const data = JSON.parse(await runHelper({ cmd: 'smartctl', device: disk.path }, 90_000)) as Json;
        const a = assess(data, prevCounters[id]);
        nextCounters[id] = a.counters;
        out.push({ name: disk.name, model: disk.model, serial: disk.serial, size: disk.size, rotational: disk.rotational, status: a.status, reasons: a.reasons, temperature: a.temperature, powerOnHours: a.powerOnHours, wearPct: a.wearPct, checkedAt: Date.now() });
        getDb()
          .prepare('INSERT INTO disk_health(disk, ts, status, temperature, counters) VALUES(?, ?, ?, ?, ?)')
          .run(id, Date.now(), a.status, a.temperature, JSON.stringify(a.counters));
      } catch {
        out.push({ name: disk.name, model: disk.model, serial: disk.serial, size: disk.size, rotational: disk.rotational, status: 'unknown', reasons: [], temperature: null, powerOnHours: null, wearPct: null, checkedAt: Date.now() });
      }
    }
    // Counters only move forward: a later "increase" compares with the last real reading.
    kvSet('disk_counters', JSON.stringify({ ...prevCounters, ...nextCounters }));
    kvSet('disk_health', JSON.stringify(out));
    latest = out;
    return out;
  })().finally(() => (running = null));
  return running;
}

/** For the alert loop: one alert per unhealthy disk. */
const REASON_AR: Record<string, string> = {
  smart_failed: 'فحص SMART فاشل',
  attribute_failed: 'مؤشر صحة تحت الحد',
  reallocated: 'قطاعات معاد تخصيصها',
  pending: 'قطاعات معلّقة',
  uncorrectable: 'قطاعات تالفة',
  reported_uncorrect: 'أخطاء قراءة',
  nvme_critical: 'تحذير حرج من الـ NVMe',
  worn: 'نسبة الاهتراء',
  media_errors: 'أخطاء وسائط',
  spare_low: 'المساحة الاحتياطية قليلة',
  hot: 'حرارة',
};

/**
 * For the alert loop: one alert per unhealthy disk. The key includes the error counters, so a
 * disk that is already known to be failing only speaks up again when it gets worse.
 */
export function diskHealthAlerts() {
  return latest
    .filter((d) => d.status === 'failing' || d.status === 'warning')
    .map((d) => {
      const sig = d.reasons.map((r) => `${r.code}${r.n !== undefined && r.code !== 'hot' ? `=${r.n}` : ''}`).join(',');
      const what = d.reasons.map((r) => `${REASON_AR[r.code] ?? r.code}${r.n !== undefined ? ` ${r.n}` : ''}`).join('، ');
      return {
        key: `smart:${d.serial ?? d.name}:${d.status}:${sig}`,
        kind: 'disk_health' as const,
        severity: d.status === 'failing' ? ('critical' as const) : ('warning' as const),
        title: `${d.status === 'failing' ? 'Disk failing' : 'Disk warning'}: ${d.model ?? d.name} (${d.name})`,
        detail: d.reasons.map((r) => `${r.code.replace(/_/g, ' ')}${r.n !== undefined ? ` ${r.n}` : ''}`).join(', ') + '. Back up its data.',
        ar: `🩻 حالة القرص <b>${d.name}</b> (${d.model ?? ''}) ${d.status === 'failing' ? 'ساءت' : 'فيها تحذير جديد'}: ${what}. انقل بياناته لقرص سليم.`,
      };
    });
}

export function startDiskHealthLoop() {
  loadCache();
  const run = () => void checkDisks().catch(() => undefined);
  const first = setTimeout(run, 2 * 60_000);
  first.unref();
  const t = setInterval(run, 6 * 3600_000);
  t.unref();
  return () => {
    clearTimeout(first);
    clearInterval(t);
  };
}

export async function diskHealthRoutes(app: FastifyInstance) {
  if (!process.env.VITEST) {
    const stop = startDiskHealthLoop();
    app.addHook('onClose', async () => stop());
  } else loadCache();

  app.get('/api/disks/health', { preHandler: requireAuth }, async () => ({ disks: latest, checking: !!running }));
  app.post('/api/disks/health/check', { preHandler: requireAuth }, async () => ({ disks: await checkDisks() }));
  app.get<{ Params: { disk: string } }>('/api/disks/health/:disk/history', { preHandler: requireAuth }, async (req) =>
    getDb()
      .prepare('SELECT ts, status, temperature, counters FROM disk_health WHERE disk = ? ORDER BY ts DESC LIMIT 120')
      .all(req.params.disk)
      .map((r) => ({ ...(r as Json), counters: JSON.parse((r as { counters: string }).counters) })),
  );
}
