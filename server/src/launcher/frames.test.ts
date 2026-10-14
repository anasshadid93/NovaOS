import { describe, expect, it } from 'vitest';
import { frameAllowed } from './frames.js';

const O = 'https://n5.example.ts.net:7443';
const h = (o: Record<string, string>) => new Headers(o);

describe('frameAllowed', () => {
  it('allows apps that say nothing', () => {
    expect(frameAllowed('https://n5.example.ts.net:20001/', h({}), O)).toBe(true);
  });
  it('refuses X-Frame-Options DENY and SAMEORIGIN from another port', () => {
    expect(frameAllowed('https://n5.example.ts.net/', h({ 'x-frame-options': 'DENY' }), O)).toBe(false);
    expect(frameAllowed('https://n5.example.ts.net:8444/', h({ 'x-frame-options': 'SAMEORIGIN' }), O)).toBe(false);
  });
  it('reads CSP frame-ancestors', () => {
    expect(frameAllowed('https://n5.example.ts.net:8444/', h({ 'content-security-policy': "default-src 'self'; frame-ancestors 'none'" }), O)).toBe(false);
    expect(frameAllowed('https://n5.example.ts.net:7444/', h({ 'content-security-policy': `frame-ancestors ${O}` }), O)).toBe(true);
    expect(frameAllowed('https://n5.example.ts.net:7444/', h({ 'content-security-policy': 'frame-ancestors *' }), O)).toBe(true);
  });
  it('refuses plain http inside the https app', () => {
    expect(frameAllowed('http://n5.example.ts.net:4173/', h({}), O)).toBe(false);
  });
});
