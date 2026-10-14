import { execFile } from 'node:child_process';
import { config } from './config.js';

/**
 * Client for /usr/local/sbin/manar-helper, the only thing Manar may run as root
 * (via a single NOPASSWD sudoers rule). The helper re-validates every argument;
 * we validate here too so bad input never reaches sudo.
 */
export type HelperCommand =
  | { cmd: 'reboot' }
  | { cmd: 'poweroff' }
  | { cmd: 'systemctl'; action: 'start' | 'stop' | 'restart'; unit: string }
  | { cmd: 'kill'; signal: 'TERM' | 'KILL' | 'HUP'; pid: number }
  | { cmd: 'smartctl'; device: string }
  | { cmd: 'ports' }
  | { cmd: 'rm-appdata'; app: string }
  | { cmd: 'suspend' }
  | { cmd: 'schedule'; action: 'reboot' | 'poweroff'; minutes: number }
  | { cmd: 'cancel-schedule' }
  | { cmd: 'ufw-status' }
  | { cmd: 'drop-caches' }
  | { cmd: 'ts-serve'; port: number; on: boolean }
  | { cmd: 'mount-ext'; part: string }
  | { cmd: 'umount-ext'; part: string }
  | { cmd: 'apt-refresh' }
  | { cmd: 'apt-upgrade' };

export const UNIT_RE = /^[A-Za-z0-9@._-]{1,120}\.(service|timer|socket)$/;
export const APP_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const PART_RE = /^(sd[a-z]{1,2}\d{1,3}|nvme\d{1,2}n\d{1,2}p\d{1,3}|mmcblk\d{1,2}p\d{1,3})$/;
export const DEVICE_RE = /^\/dev\/(sd[a-z]{1,2}|nvme\d{1,2}n\d{1,2})$/;

export function helperArgs(c: HelperCommand): string[] {
  switch (c.cmd) {
    case 'reboot':
    case 'poweroff':
    case 'suspend':
    case 'cancel-schedule':
    case 'ufw-status':
    case 'drop-caches':
    case 'apt-refresh':
    case 'apt-upgrade':
      return [c.cmd];
    case 'schedule':
      if (!['reboot', 'poweroff'].includes(c.action) || !Number.isInteger(c.minutes) || c.minutes < 1 || c.minutes > 10080) throw new HelperError('bad_args');
      return ['schedule', c.action, String(c.minutes)];
    case 'systemctl':
      if (!['start', 'stop', 'restart'].includes(c.action) || !UNIT_RE.test(c.unit)) throw new HelperError('bad_args');
      return ['systemctl', c.action, c.unit];
    case 'kill':
      if (!['TERM', 'KILL', 'HUP'].includes(c.signal) || !Number.isInteger(c.pid) || c.pid <= 1) throw new HelperError('bad_args');
      return ['kill', c.signal, String(c.pid)];
    case 'smartctl':
      if (!DEVICE_RE.test(c.device)) throw new HelperError('bad_args');
      return ['smartctl', c.device];
    case 'ports':
      return ['ports'];
    case 'ts-serve':
      if (!Number.isInteger(c.port) || c.port < 20000 || c.port > 29999) throw new HelperError('bad_args');
      return ['ts-serve', String(c.port), c.on ? 'on' : 'off'];
    case 'mount-ext':
    case 'umount-ext':
      if (!PART_RE.test(c.part)) throw new HelperError('bad_args');
      return [c.cmd, c.part];
    case 'rm-appdata':
      if (!APP_ID_RE.test(c.app)) throw new HelperError('bad_args');
      return ['rm-appdata', c.app];
  }
}

export class HelperError extends Error {
  constructor(
    message: string,
    readonly stderr = '',
  ) {
    super(message);
  }
}

export function runHelper(c: HelperCommand, timeoutMs = 30_000): Promise<string> {
  const args = ['-n', config.helperPath, ...helperArgs(c)];
  return new Promise((resolve, reject) => {
    execFile('sudo', args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      // smartctl uses non-zero bit flags for drive warnings while still printing JSON.
      if (err && !(c.cmd === 'smartctl' && stdout)) reject(new HelperError('helper_failed', String(stderr).slice(0, 2000)));
      else resolve(String(stdout));
    });
  });
}
