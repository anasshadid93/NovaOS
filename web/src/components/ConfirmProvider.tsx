import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Fingerprint24Filled } from '@fluentui/react-icons';
import { setConfirmHandler } from '../lib/api';
import { confirmWithCode, confirmWithPasskey, passkeysSupported } from '../lib/auth';
import { useI18n } from '../i18n';
import { Dialog } from './Dialog';
import { Button, ErrorText, TextField } from './ui';

export interface AskOptions {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  /** If set, the user must type this exact text to enable the button. */
  typeToConfirm?: string;
}

type Pending = { kind: 'ask'; opts: AskOptions; resolve: (ok: boolean) => void } | { kind: 'stepup'; resolve: (ok: boolean) => void };

const ConfirmContext = createContext<((opts: AskOptions) => Promise<boolean>) | null>(null);

/**
 * Two layers of protection for dangerous actions:
 *  1. `ask()` — an explicit "are you sure?" sheet (optionally type-to-confirm).
 *  2. Step-up — when the server says `confirm_required`, re-verify with passkey or TOTP, then retry.
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [pending, setPending] = useState<Pending | null>(null);
  const [typed, setTyped] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const stepUpInFlight = useRef<Promise<boolean> | null>(null);

  const ask = useCallback(
    (opts: AskOptions) =>
      new Promise<boolean>((resolve) => {
        setTyped('');
        setPending({ kind: 'ask', opts, resolve });
      }),
    [],
  );

  useEffect(() => {
    setConfirmHandler(() => {
      // Concurrent 403s share one prompt.
      stepUpInFlight.current ??= new Promise<boolean>((resolve) => {
        setCode('');
        setError('');
        setPending({ kind: 'stepup', resolve });
      }).finally(() => (stepUpInFlight.current = null));
      return stepUpInFlight.current;
    });
    return () => setConfirmHandler(null);
  }, []);

  const finish = (ok: boolean) => {
    pending?.resolve(ok);
    setPending(null);
    setBusy(false);
  };

  const viaPasskey = async () => {
    setBusy(true);
    setError('');
    try {
      if (await confirmWithPasskey()) return finish(true);
    } catch {
      setError(t('confirm.failed'));
    }
    setBusy(false);
  };

  const viaCode = async () => {
    setBusy(true);
    setError('');
    try {
      await confirmWithCode(code);
      return finish(true);
    } catch {
      setError(t('confirm.failed'));
    }
    setBusy(false);
  };

  return (
    <ConfirmContext.Provider value={ask}>
      {children}
      <Dialog
        open={pending !== null}
        onClose={() => finish(false)}
        title={pending?.kind === 'ask' ? pending.opts.title : t('confirm.title')}
      >
        {pending?.kind === 'ask' && (
          <>
            {pending.opts.body && <div className="text-sm text-muted">{pending.opts.body}</div>}
            {pending.opts.typeToConfirm && (
              <TextField
                label={pending.opts.typeToConfirm}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
              />
            )}
            <div className="grid grid-cols-2 gap-3">
              <Button variant="secondary" onClick={() => finish(false)}>
                {t('common.cancel')}
              </Button>
              <Button
                variant={pending.opts.danger ? 'danger' : 'primary'}
                disabled={!!pending.opts.typeToConfirm && typed !== pending.opts.typeToConfirm}
                onClick={() => finish(true)}
              >
                {pending.opts.confirmLabel ?? t('common.confirm')}
              </Button>
            </div>
          </>
        )}
        {pending?.kind === 'stepup' && (
          <>
            <p className="text-sm text-muted">{t('confirm.body')}</p>
            {passkeysSupported() && (
              <Button className="w-full" onClick={viaPasskey} disabled={busy}>
                <Fingerprint24Filled aria-hidden />
                {t('confirm.passkey')}
              </Button>
            )}
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                void viaCode();
              }}
            >
              <TextField
                label={t('confirm.code')}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="\d{6}"
              />
              <ErrorText>{error}</ErrorText>
              <div className="grid grid-cols-2 gap-3">
                <Button variant="secondary" onClick={() => finish(false)}>
                  {t('common.cancel')}
                </Button>
                <Button type="submit" disabled={busy || code.length !== 6}>
                  {t('common.confirm')}
                </Button>
              </div>
            </form>
          </>
        )}
      </Dialog>
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const v = useContext(ConfirmContext);
  if (!v) throw new Error('useConfirm outside ConfirmProvider');
  return v;
}
