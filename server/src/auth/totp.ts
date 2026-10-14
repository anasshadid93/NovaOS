import { authenticator } from 'otplib';

authenticator.options = { window: 1, step: 30 };

export function newTotpSecret(): string {
  return authenticator.generateSecret(20);
}

export function totpUri(username: string, secret: string): string {
  return authenticator.keyuri(username, 'MinisManager (the server)', secret);
}

/**
 * Verifies a TOTP code and returns the matched time step, or null.
 * Callers must reject steps <= the last accepted step (replay protection).
 */
export function verifyTotp(code: string, secret: string): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const delta = authenticator.checkDelta(code, secret);
  if (delta === null) return null;
  return Math.floor(Date.now() / 30000) + delta;
}
