import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import { Checkmark16Regular, Copy16Regular, Globe16Regular, Share16Regular } from '@fluentui/react-icons';
import { api } from '../../lib/api';
import { useI18n, type MessageKey } from '../../i18n';
import { Dialog } from '../Dialog';
import { Button } from '../ui';

const EXPIRY: { days: number | null; label: MessageKey }[] = [
  { days: 1, label: 'share.exp.1' },
  { days: 7, label: 'share.exp.7' },
  { days: 30, label: 'share.exp.30' },
  { days: 90, label: 'share.exp.90' },
  { days: null, label: 'share.exp.never' },
];

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // http or old browsers: the classic way.
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

/** "Share link" for a file or folder: expiry and optional password, then the link to copy/send. */
export function ShareDialog({ target, onClose, onManage }: { target: { path: string; name: string } | null; onClose: () => void; onManage?: () => void }) {
  const { t } = useI18n();
  const [days, setDays] = useState<number | null>(7);
  const [withPw, setWithPw] = useState(false);
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [url, setUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!target) return;
    setDays(7);
    setWithPw(false);
    setPw('');
    setErr('');
    setUrl(null);
    setCopied(false);
  }, [target]);

  const create = async () => {
    if (withPw && pw.length < 4) return setErr(t('share.pwShort'));
    setBusy(true);
    setErr('');
    try {
      const r = await api<{ url: string }>('/api/shares', { body: { path: target!.path, expiresDays: days, ...(withPw ? { password: pw } : {}) } });
      setUrl(r.url);
    } catch {
      setErr(t('share.failed'));
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    await copyText(url!);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Dialog open={!!target} onClose={onClose} title={t('share.title', { name: target?.name ?? '' })}>
      {url ? (
        <div className="space-y-3">
          <p className="text-sm text-muted">{t('share.ready')}</p>
          <input readOnly value={url} onFocus={(e) => e.currentTarget.select()} className="min-h-11 w-full rounded-xl bg-canvas px-3 font-mono text-sm text-ink ring-1 ring-line" dir="ltr" />
          <div className="flex gap-2">
            <Button className="flex-1" onClick={() => void copy()}>
              {copied ? <Checkmark16Regular aria-hidden /> : <Copy16Regular aria-hidden />}
              {copied ? t('share.copied') : t('share.copy')}
            </Button>
            {'share' in navigator && (
              <Button variant="secondary" className="flex-1" onClick={() => void navigator.share({ title: target!.name, url }).catch(() => undefined)}>
                <Share16Regular aria-hidden />
                {t('share.send')}
              </Button>
            )}
          </div>
          {onManage ? (
            <button type="button" onClick={() => (onClose(), onManage())} className="block w-full text-center text-sm text-primary-ink">
              {t('share.manage')}
            </button>
          ) : (
            <Link href="/settings/shares" onClick={onClose} className="block text-center text-sm text-primary-ink">
              {t('share.manage')}
            </Link>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <p className="flex gap-2 rounded-xl bg-warn/10 p-3 text-sm text-ink">
            <Globe16Regular className="mt-0.5 shrink-0 text-warn" aria-hidden />
            {t('share.public')}
          </p>
          <div>
            <p className="mb-2 text-sm font-medium text-ink">{t('share.expires')}</p>
            <div className="flex flex-wrap gap-2">
              {EXPIRY.map((x) => (
                <button key={String(x.days)} type="button" onClick={() => setDays(x.days)} className={`min-h-9 rounded-full px-3.5 text-sm ${days === x.days ? 'bg-primary text-white' : 'bg-primary-soft text-primary-ink'}`} aria-pressed={days === x.days}>
                  {t(x.label)}
                </button>
              ))}
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm text-ink">
            <input type="checkbox" checked={withPw} onChange={(e) => setWithPw(e.target.checked)} className="size-4 accent-[var(--color-primary)]" />
            {t('share.usePassword')}
          </label>
          {withPw && <input type="text" value={pw} onChange={(e) => setPw(e.target.value)} placeholder={t('share.password')} autoComplete="off" className="min-h-11 w-full rounded-xl bg-canvas px-3 text-ink ring-1 ring-line outline-none focus:ring-2 focus:ring-primary" />}
          {err && <p className="text-sm text-danger">{err}</p>}
          <Button className="w-full" disabled={busy} onClick={() => void create()}>
            {t('share.create')}
          </Button>
        </div>
      )}
    </Dialog>
  );
}
