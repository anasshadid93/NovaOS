import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, setConfirmHandler } from './api';

function respond(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  setConfirmHandler(null);
});

describe('api', () => {
  it('retries once after a successful step-up confirmation', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(respond(403, { error: 'confirm_required' })).mockResolvedValueOnce(respond(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const confirm = vi.fn().mockResolvedValue(true);
    setConfirmHandler(confirm);

    await expect(api('/api/x', { method: 'DELETE' })).resolves.toEqual({ ok: true });
    expect(confirm).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry when the user cancels', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(403, { error: 'confirm_required' })));
    setConfirmHandler(async () => false);
    await expect(api('/api/x', { method: 'DELETE' })).rejects.toMatchObject({ status: 403, code: 'confirm_required' });
  });

  it('surfaces server error codes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(401, { error: 'invalid_credentials' })));
    const err = (await api('/api/auth/password', { body: {} }).catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('invalid_credentials');
  });
});
