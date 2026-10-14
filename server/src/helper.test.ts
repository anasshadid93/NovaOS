import { describe, expect, it } from 'vitest';
import { helperArgs } from './helper.js';

describe('helperArgs', () => {
  it('builds allowed commands', () => {
    expect(helperArgs({ cmd: 'reboot' })).toEqual(['reboot']);
    expect(helperArgs({ cmd: 'drop-caches' })).toEqual(['drop-caches']);
    expect(helperArgs({ cmd: 'systemctl', action: 'restart', unit: 'nginx.service' })).toEqual(['systemctl', 'restart', 'nginx.service']);
    expect(helperArgs({ cmd: 'kill', signal: 'TERM', pid: 4242 })).toEqual(['kill', 'TERM', '4242']);
    expect(helperArgs({ cmd: 'smartctl', device: '/dev/nvme0n1' })).toEqual(['smartctl', '/dev/nvme0n1']);
    expect(helperArgs({ cmd: 'schedule', action: 'poweroff', minutes: 90 })).toEqual(['schedule', 'poweroff', '90']);
    expect(helperArgs({ cmd: 'rm-appdata', app: 'jellyfin' })).toEqual(['rm-appdata', 'jellyfin']);
    expect(helperArgs({ cmd: 'ts-serve', port: 20001, on: true })).toEqual(['ts-serve', '20001', 'on']);
    expect(helperArgs({ cmd: 'mount-ext', part: 'sdd1' })).toEqual(['mount-ext', 'sdd1']);
    expect(helperArgs({ cmd: 'umount-ext', part: 'nvme0n1p4' })).toEqual(['umount-ext', 'nvme0n1p4']);
  });

  it.each([
    { cmd: 'systemctl', action: 'mask', unit: 'nginx.service' },
    { cmd: 'systemctl', action: 'stop', unit: '../../etc/passwd' },
    { cmd: 'systemctl', action: 'stop', unit: 'nginx.service --now' },
    { cmd: 'kill', signal: 'TERM', pid: 1 },
    { cmd: 'kill', signal: 'TERM', pid: -1 },
    { cmd: 'kill', signal: 'STOP', pid: 100 },
    { cmd: 'smartctl', device: '/dev/sda; rm -rf /' },
    { cmd: 'smartctl', device: '/etc/shadow' },
    { cmd: 'schedule', action: 'reboot', minutes: 0 },
    { cmd: 'schedule', action: 'halt', minutes: 5 },
    { cmd: 'rm-appdata', app: '../etc' },
    { cmd: 'rm-appdata', app: 'a/b' },
    { cmd: 'ts-serve', port: 443, on: true },
    { cmd: 'mount-ext', part: 'sdd' },
    { cmd: 'mount-ext', part: '../sda1' },
    { cmd: 'umount-ext', part: 'sdd1; reboot' },
    { cmd: 'ts-serve', port: 7443, on: false },
  ])('rejects %j', (c) => {
    expect(() => helperArgs(c as never)).toThrow('bad_args');
  });
});
