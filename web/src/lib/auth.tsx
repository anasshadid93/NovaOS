import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { startAuthentication, startRegistration, browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { api, setLockedHandler, setUnauthorizedHandler } from './api';

export interface AuthState {
  /** Set when the server could not be reached (phone offline or the server down). */
  offline?: boolean;
  setupRequired: boolean;
  user: { name: string; method: 'passkey' | 'password'; elevatedUntil: number; locked?: boolean } | null;
  passkeys?: number;
}

interface AuthValue {
  state: AuthState | null;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState | null>(null);

  const refresh = useCallback(async () => {
    setState(await api<AuthState>('/api/auth/state'));
  }, []);

  const logout = useCallback(async () => {
    await api('/api/auth/logout', { body: {} });
    await refresh();
  }, [refresh]);

  useEffect(() => {
    refresh().catch(() => setState({ setupRequired: false, user: null, offline: true }));
    setUnauthorizedHandler(() => void refresh());
    setLockedHandler(() => void refresh());
    return () => {
      setUnauthorizedHandler(null);
      setLockedHandler(null);
    };
  }, [refresh]);

  return <AuthContext.Provider value={{ state, refresh, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(AuthContext);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}

export const passkeysSupported = () => browserSupportsWebAuthn();

export async function loginWithPasskey(): Promise<void> {
  const optionsJSON = await api<Parameters<typeof startAuthentication>[0]['optionsJSON']>('/api/auth/passkey/options', { body: {} });
  const response = await startAuthentication({ optionsJSON });
  await api('/api/auth/passkey/verify', { body: { response } });
}

export async function registerPasskey(name: string): Promise<void> {
  const optionsJSON = await api<Parameters<typeof startRegistration>[0]['optionsJSON']>('/api/auth/passkeys/options', { body: {} });
  const response = await startRegistration({ optionsJSON });
  await api('/api/auth/passkeys', { body: { response, name } });
}

/** Step-up confirmation with a passkey; returns false if the user has none. */
export async function confirmWithPasskey(): Promise<boolean> {
  const { passkey } = await api<{ passkey: Parameters<typeof startAuthentication>[0]['optionsJSON'] | null }>('/api/auth/confirm/options', {
    body: {},
  });
  if (!passkey) return false;
  const response = await startAuthentication({ optionsJSON: passkey });
  await api('/api/auth/confirm', { body: { response } });
  return true;
}

export async function confirmWithCode(code: string): Promise<void> {
  await api('/api/auth/confirm', { body: { code } });
}
