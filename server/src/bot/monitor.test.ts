import { describe, expect, it } from 'vitest';
import { monitorMessage } from './monitor.js';

describe('Uptime Kuma alerts', () => {
  it('down, up and test messages', () => {
    expect(monitorMessage({ heartbeat: { status: 0, msg: 'timeout <x>' }, monitor: { name: 'Jellyfin' } })).toEqual({ severity: 'critical', kind: 'uptime:Jellyfin', text: '🔴 <b>Jellyfin</b> واقف\ntimeout &lt;x&gt;' });
    expect(monitorMessage({ heartbeat: { status: 1 }, monitor: { name: 'Jellyfin' } }).severity).toBe('ok');
    expect(monitorMessage({ event_type: 'EmailTest', message: 'x' })).toMatchObject({ severity: 'info', kind: 'scrutiny:test' });
    expect(monitorMessage({ event_type: 'SmartFail', device_name: '/dev/sda', failure_type: 'SmartFailure', message: 'a<b' })).toMatchObject({ severity: 'critical', kind: 'scrutiny:/dev/sda' });
    expect(monitorMessage({ msg: 'Testing' })).toMatchObject({ severity: 'info', kind: 'uptime:test' });
  });
});
