export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

/**
 * Called when the server answers 403 `confirm_required`. Resolves true once the
 * user has confirmed (passkey or TOTP); the request is then retried once.
 */
let confirmHandler: (() => Promise<boolean>) | null = null;
export function setConfirmHandler(fn: (() => Promise<boolean>) | null) {
  confirmHandler = fn;
}

/** Called when the server says the session is locked (423): the app shows the lock screen. */
let lockedHandler: (() => void) | null = null;
export function setLockedHandler(fn: (() => void) | null) {
  lockedHandler = fn;
}

let unauthorizedHandler: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null) {
  unauthorizedHandler = fn;
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}, retried = false): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    credentials: 'same-origin',
    headers: init.body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (res.ok) return (res.status === 204 ? undefined : await res.json()) as T;

  let code = 'error';
  try {
    code = ((await res.json()) as { error?: string }).error ?? code;
  } catch {
    /* non-JSON error */
  }
  if (res.status === 403 && code === 'confirm_required' && !retried && confirmHandler) {
    if (await confirmHandler()) return api<T>(path, init, true);
  }
  if (res.status === 423) lockedHandler?.();
  if (res.status === 401 && !path.startsWith('/api/auth/') && !path.startsWith('/api/setup/')) unauthorizedHandler?.();
  throw new ApiError(res.status, code);
}
