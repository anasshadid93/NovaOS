import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { audit } from '../db.js';
import { requireAuth } from '../auth/sessions.js';
import { HelperError, PART_RE, runHelper } from '../helper.js';
import { invalidateIndex } from './files.js';
import { startHotplug } from './hotplug.js';

const execFileP = promisify(execFile);

/**
 * Storage volumes for the file manager: internal storage plus every other disk
 * partition (USB sticks, external SSDs, secondary NVMe). Partitions on the system
 * disk are never listed. Mounting happens through the root helper into
 * /srv/data/external/<name>, so mounted volumes are browsable like any folder.
 */

interface Node {
  name: string;
  path: string;
  type: string;
  size: number | string;
  fstype: string | null;
  label: string | null;
  model: string | null;
  tran: string | null;
  rm: boolean | string;
  hotplug: boolean | string;
  mountpoints: (string | null)[];
  children?: Node[];
}

export interface Volume {
  id: string; // "internal" or the partition name (sdd1)
  name: string;
  disk: string | null;
  transport: string | null;
  removable: boolean;
  size: number;
  used: number | null;
  fstype: string | null;
  state: 'mounted' | 'unmounted' | 'encrypted' | 'unsupported';
  path: string | null; // path relative to the data root when browsable
}

const SUPPORTED = new Set(['vfat', 'exfat', 'ext4', 'ext3', 'ext2', 'btrfs', 'xfs']);
const MIN_SIZE = 512 * 1024 ** 2; // hide EFI/boot stubs

function usage(mount: string): { size: number; used: number } | null {
  try {
    const s = fs.statfsSync(mount);
    return { size: s.blocks * s.bsize, used: (s.blocks - s.bfree) * s.bsize };
  } catch {
    return null;
  }
}

export async function listVolumes(): Promise<Volume[]> {
  const root = fs.realpathSync(config.dataRoot);
  const internal = usage(root);
  const out: Volume[] = [{ id: 'internal', name: 'internal', disk: null, transport: null, removable: false, size: internal?.size ?? 0, used: internal?.used ?? null, fstype: null, state: 'mounted', path: '' }];

  const { stdout } = await execFileP('lsblk', ['-J', '-b', '-o', 'NAME,PATH,TYPE,SIZE,FSTYPE,LABEL,MODEL,TRAN,RM,HOTPLUG,MOUNTPOINTS'], { timeout: 5000 });
  const disks = (JSON.parse(stdout) as { blockdevices: Node[] }).blockdevices.filter((d) => d.type === 'disk' && !/^(loop|zram|ram)/.test(d.name));
  const truthy = (v: boolean | string) => v === true || v === '1';
  for (const d of disks) {
    // Whole-disk encryption (LUKS header on the disk itself): one locked volume.
    const parts = d.fstype === 'crypto_LUKS' || !d.children?.length ? [d] : d.children.filter((c) => c.type === 'part');
    // The disk holding "/" is the system disk: never offered.
    if ([d, ...(d.children ?? [])].some((n) => (n.mountpoints ?? []).includes('/'))) continue;
    for (const p of parts) {
      const size = Number(p.size);
      if (size < MIN_SIZE || p.fstype === 'swap') continue;
      const mp = (p.mountpoints ?? []).find((m): m is string => !!m) ?? null;
      const state: Volume['state'] = p.fstype === 'crypto_LUKS' ? 'encrypted' : mp ? 'mounted' : p.fstype && SUPPORTED.has(p.fstype) ? 'unmounted' : 'unsupported';
      if (state === 'unsupported' && !p.fstype) continue; // unformatted space
      const u = mp ? usage(mp) : null;
      const rel = mp && (mp === root || mp.startsWith(root + '/')) ? path.relative(root, mp) : null;
      out.push({
        id: p.name,
        name: (p.label && !/^disk-[0-9a-f-]{20,}$/.test(p.label) ? p.label : null) ?? d.model?.trim() ?? p.name,
        disk: d.model?.trim() ?? null,
        transport: d.tran,
        removable: truthy(d.rm) || truthy(d.hotplug),
        size,
        used: u?.used ?? null,
        fstype: p.fstype,
        state,
        path: rel,
      });
    }
  }
  return out;
}

export async function volumeRoutes(app: FastifyInstance) {
  // Tests and dev instances must not mount real drives.
  if (process.env.MANAR_HOTPLUG !== '0' && !process.env.VITEST && !config.dev) {
    const stop = startHotplug();
    app.addHook('onClose', async () => stop());
  }

  app.get('/api/storage/volumes', { preHandler: requireAuth }, async () => listVolumes());

  app.post<{ Params: { id: string } }>('/api/storage/volumes/:id/mount', { preHandler: requireAuth }, async (req, reply) => {
    if (!PART_RE.test(req.params.id)) return reply.code(400).send({ error: 'bad_volume' });
    try {
      await runHelper({ cmd: 'mount-ext', part: req.params.id }, 60_000);
    } catch (err) {
      return reply.code(502).send({ error: 'mount_failed', detail: (err as HelperError).stderr?.replace(/^manar-helper: /, '').trim() });
    }
    invalidateIndex();
    audit(req.session!.userId, 'volume_mount', { id: req.params.id });
    return (await listVolumes()).find((v) => v.id === req.params.id) ?? { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/storage/volumes/:id/unmount', { preHandler: requireAuth }, async (req, reply) => {
    if (!PART_RE.test(req.params.id)) return reply.code(400).send({ error: 'bad_volume' });
    try {
      await runHelper({ cmd: 'umount-ext', part: req.params.id }, 60_000);
    } catch (err) {
      const detail = (err as HelperError).stderr ?? '';
      return reply.code(/busy/i.test(detail) ? 409 : 502).send({ error: /busy/i.test(detail) ? 'busy' : 'unmount_failed', detail: detail.replace(/^manar-helper: /, '').trim() });
    }
    invalidateIndex();
    audit(req.session!.userId, 'volume_unmount', { id: req.params.id });
    return { ok: true };
  });
}
