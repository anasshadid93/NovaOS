import net from 'node:net';

/** Loopback, private, link-local, CGNAT/tailnet, multicast, reserved, docker… → true. */
export function isPrivateIp(ip: string): boolean {
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
    return v === '::' || v === '::1' || /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v) || v.startsWith('64:ff9b:') || v.startsWith('2001:db8');
  }
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
}
