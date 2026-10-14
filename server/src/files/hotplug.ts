import fs from 'node:fs';
import { audit } from '../db.js';
import { runHelper } from '../helper.js';
import { notify } from '../notify/notify.js';
import { invalidateIndex } from './files.js';
import { listVolumes } from './volumes.js';
import { config } from '../config.js';

/**
 * Drive hot-plug: watches /proc/partitions (one tiny read every 3 s).
 *  - A removable drive (USB stick / external SSD) that appears is mounted automatically
 *    under /srv/data/external/<name> and you get a notification.
 *  - A drive that disappears without "Eject" has its stale mount cleaned up.
 * Internal secondary disks are listed too but only mounted when you tap them.
 */

const INTERVAL_MS = 3000;
const SETTLE_MS = 1500; // let udev create /dev nodes and read labels

function partitions(): Set<string> {
  try {
    return new Set(
      fs
        .readFileSync('/proc/partitions', 'utf8')
        .split('\n')
        .slice(2)
        .map((l) => l.trim().split(/\s+/)[3])
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

/** Partitions currently mounted by us under /srv/data/external, keyed by device name. */
function ourMounts(): Map<string, string> {
  const out = new Map<string, string>();
  try {
    for (const line of fs.readFileSync('/proc/mounts', 'utf8').split('\n')) {
      const [src, target] = line.split(' ');
      if (src?.startsWith('/dev/') && target?.startsWith(`${config.dataRoot}/external/`)) out.set(src.slice(5), target);
    }
  } catch {
    /* ignore */
  }
  return out;
}

let busy = false;

async function autoMountRemovable(only?: Set<string>) {
  const vols = await listVolumes();
  for (const v of vols) {
    if (v.id === 'internal' || v.state !== 'unmounted' || !v.removable) continue;
    if (only && !only.has(v.id)) continue;
    try {
      await runHelper({ cmd: 'mount-ext', part: v.id }, 60_000);
      invalidateIndex();
      audit(null, 'volume_automount', { id: v.id, name: v.name });
      void notify(`Drive connected: ${v.name}`, 'It is open in Files › Storage.', '/files').catch(() => undefined);
    } catch {
      /* unsupported/locked: stays listed as "tap to open" */
    }
  }
}

async function cleanup(gone: string[]) {
  const mounts = ourMounts();
  for (const part of gone) {
    if (!mounts.has(part)) continue;
    try {
      await runHelper({ cmd: 'umount-ext', part }, 60_000);
      invalidateIndex();
      audit(null, 'volume_removed', { id: part });
    } catch {
      /* retried on the next change */
    }
  }
}

export function startHotplug(): () => void {
  let known = partitions();
  // On start: mount removable drives that are already plugged in, and drop stale mounts.
  setTimeout(() => {
    void (async () => {
      busy = true;
      try {
        await cleanup([...ourMounts().keys()].filter((p) => !known.has(p)));
        await autoMountRemovable();
      } finally {
        busy = false;
      }
    })();
  }, SETTLE_MS).unref();

  const timer = setInterval(() => {
    if (busy) return;
    const now = partitions();
    const added = [...now].filter((p) => !known.has(p));
    const removed = [...known].filter((p) => !now.has(p));
    known = now;
    if (!added.length && !removed.length) return;
    busy = true;
    setTimeout(() => {
      void (async () => {
        try {
          if (removed.length) await cleanup(removed);
          if (added.length) await autoMountRemovable(new Set(added));
        } finally {
          busy = false;
        }
      })();
    }, SETTLE_MS).unref();
  }, INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
