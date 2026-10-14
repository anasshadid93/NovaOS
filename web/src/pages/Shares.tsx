import { useEffect, useState } from 'react';
import { Copy16Regular, Delete16Regular, Folder24Filled, Document24Filled, LockClosed12Filled, ArrowUpload24Filled } from '@fluentui/react-icons';
import { Link } from 'wouter';
import { formatBytes } from '../lib/format';
import { Button } from '../components/ui';
import { api } from '../lib/api';
import { useI18n } from '../i18n';
import { useConfirm } from '../components/ConfirmProvider';
import { PageHeader } from '../components/ui';
import { copyText } from '../components/fm/ShareDialog';

interface ShareRow {
  id: number;
  url: string;
  path: string;
  name: string;
  isDir: boolean;
  hasPassword: boolean;
  expiresAt: number | null;
  expired: boolean;
  views: number;
  downloads: number;
  lastAccess: number | null;
  createdAt: number;
  exists: boolean;
}

/** Settings → Shared links: every public link, how often it was opened, copy or stop sharing. */
export function Shares() {
  const { t, tn, formatRelative } = useI18n();
  const ask = useConfirm();
  const [rows, setRows] = useState<ShareRow[] | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const load = () => void api<{ shares: ShareRow[] }>('/api/shares').then((r) => setRows(r.shares));
  useEffect(load, []);

  const remove = async (s: ShareRow) => {
    if (!(await ask({ title: t('share.stopTitle', { name: s.name }), body: t('share.stopBody'), confirmLabel: t('share.stop'), danger: true }))) return;
    await api(`/api/shares/${s.id}`, { method: 'DELETE' });
    load();
  };

  return (
    <>
      <PageHeader title={t('share.links')} back="/settings" />
      <main className="safe-bottom mx-auto max-w-md space-y-3 px-3 pb-6">
        <Drops />
        <h2 className="px-1 pt-2 text-lg font-bold text-heading">{t('share.links')}</h2>
        <p className="px-1 text-sm text-muted">{t('share.howTo')}</p>
        {rows === null ? (
          <p className="py-8 text-center text-sm text-muted">{t('common.loading')}</p>
        ) : rows.length === 0 ? (
          <p className="rounded-2xl bg-surface p-6 text-center text-sm text-muted shadow-card">{t('share.none')}</p>
        ) : (
          <ul className="space-y-2">
            {rows.map((s) => (
              <li key={s.id} className={`rounded-2xl bg-surface p-3 shadow-card ${s.expired || !s.exists ? 'opacity-60' : ''}`}>
                <div className="flex items-start gap-3">
                  <span className={`mt-0.5 ${s.isDir ? 'text-[#f5b301]' : 'text-primary'}`}>{s.isDir ? <Folder24Filled aria-hidden /> : <Document24Filled aria-hidden />}</span>
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1 truncate font-medium text-ink" dir="auto">
                      {s.name}
                      {s.hasPassword && <LockClosed12Filled className="shrink-0 text-muted" aria-label={t('share.hasPassword')} />}
                    </p>
                    <p className="truncate text-xs text-muted" dir="auto">
                      {s.path}
                    </p>
                    <p className="mt-1 text-xs text-muted">
                      {!s.exists ? t('share.missing') : s.expired ? t('share.expired') : s.expiresAt ? t('share.expiresIn', { when: formatRelative(s.expiresAt) }) : t('share.exp.never')}
                      {' · '}
                      {tn('share.views', s.views)} · {tn('share.downloads', s.downloads)}
                    </p>
                  </div>
                </div>
                <div className="mt-2 flex gap-2">
                  {!s.expired && s.exists && (
                    <button
                      type="button"
                      onClick={() => void copyText(s.url).then(() => (setCopied(s.id), setTimeout(() => setCopied(null), 2000)))}
                      className="inline-flex min-h-9 flex-1 items-center justify-center gap-1.5 rounded-xl bg-primary-soft text-sm font-medium text-primary-ink"
                    >
                      <Copy16Regular aria-hidden />
                      {copied === s.id ? t('share.copied') : t('share.copy')}
                    </button>
                  )}
                  <button type="button" onClick={() => void remove(s)} className="inline-flex min-h-9 flex-1 items-center justify-center gap-1.5 rounded-xl bg-danger/10 text-sm font-medium text-danger">
                    <Delete16Regular aria-hidden />
                    {t('share.stop')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </main>
    </>
  );
}

interface DropRow {
  id: number;
  name: string;
  url: string;
  dir: string;
  hasPassword: boolean;
  expiresAt: number | null;
  expired: boolean;
  disabled: boolean;
  allowExec: boolean;
  quotaBytes: number;
  maxFiles: number;
  files: number;
  bytes: number;
  lastUpload: number | null;
}

/** Upload links: a page anyone can send files to, each into its own folder on the Toshiba. */
function Drops() {
  const { t, formatRelative } = useI18n();
  const ask = useConfirm();
  const [rows, setRows] = useState<DropRow[] | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [days, setDays] = useState<string>('30');
  const [password, setPassword] = useState('');
  const [quota, setQuota] = useState('20');
  const [allowExec, setAllowExec] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const load = () => void api<{ drops: DropRow[] }>('/api/drops').then((r) => setRows(r.drops));
  useEffect(load, []);
  const create = async () => {
    setErr(null);
    try {
      await api('/api/drops', { method: 'POST', body: { name: name.trim(), expiresDays: days === 'never' ? null : Number(days), password: password || undefined, quotaGB: Number(quota), allowExec } });
      setName('');
      setPassword('');
      setCreating(false);
      load();
    } catch (e) {
      setErr((e as Error).message.includes('bad_password') ? t('share.pwShort') : t('share.failed'));
    }
  };
  const remove = async (d: DropRow) => {
    if (!(await ask({ title: t('drop.deleteTitle', { name: d.name }), body: t('drop.deleteBody'), confirmLabel: t('drop.delete'), danger: true }))) return;
    await api(`/api/drops/${d.id}`, { method: 'DELETE' });
    load();
  };
  const toggle = async (d: DropRow) => {
    await api(`/api/drops/${d.id}/toggle`, { method: 'POST', body: { disabled: !d.disabled } });
    load();
  };
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between px-1">
        <h2 className="text-lg font-bold text-heading">{t('drop.title')}</h2>
        <button type="button" onClick={() => setCreating((v) => !v)} className="text-sm font-medium text-primary">
          {creating ? t('common.cancel') : t('drop.new')}
        </button>
      </div>
      <p className="px-1 text-sm text-muted">{t('drop.howTo')}</p>
      {creating && (
        <form
          className="space-y-2 rounded-2xl bg-surface p-3 shadow-card"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) void create();
          }}
        >
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('drop.namePlaceholder')} dir="auto" className="min-h-12 w-full rounded-xl border border-line bg-canvas px-3" aria-label={t('drop.name')} />
          <div className="grid grid-cols-2 gap-2">
            <select value={days} onChange={(e) => setDays(e.target.value)} className="min-h-11 rounded-xl border border-line bg-canvas px-3 text-sm" aria-label={t('share.expires')}>
              {['1', '7', '30', '90'].map((d) => (
                <option key={d} value={d}>
                  {t(`share.exp.${d}` as 'share.exp.7')}
                </option>
              ))}
              <option value="never">{t('share.exp.never')}</option>
            </select>
            <select value={quota} onChange={(e) => setQuota(e.target.value)} className="min-h-11 rounded-xl border border-line bg-canvas px-3 text-sm" aria-label={t('drop.quota')}>
              {['4', '20', '50', '100'].map((g) => (
                <option key={g} value={g}>
                  {t('drop.quotaGB', { n: g })}
                </option>
              ))}
            </select>
          </div>
          <input value={password} onChange={(e) => setPassword(e.target.value)} placeholder={t('drop.passwordOptional')} type="text" autoComplete="off" dir="ltr" className="min-h-11 w-full rounded-xl border border-line bg-canvas px-3 text-sm" aria-label={t('share.password')} />
          <label className="flex items-start gap-2 text-sm text-ink">
            <input type="checkbox" checked={allowExec} onChange={(e) => setAllowExec(e.target.checked)} className="mt-1 size-4" />
            <span>
              {t('drop.allowExec')}
              <span className="block text-xs text-muted">{t('drop.allowExecHint')}</span>
            </span>
          </label>
          <p className="text-xs text-muted">{t('drop.limits')}</p>
          {err && <p className="text-sm text-danger">{err}</p>}
          <Button type="submit" className="w-full" disabled={!name.trim()}>
            {t('drop.create')}
          </Button>
        </form>
      )}
      {rows && rows.length > 0 && (
        <ul className="space-y-2">
          {rows.map((d) => (
            <li key={d.id} className={`rounded-2xl bg-surface p-3 shadow-card ${d.expired || d.disabled ? 'opacity-60' : ''}`}>
              <div className="flex items-start gap-3">
                <span className="mt-0.5 text-primary">
                  <ArrowUpload24Filled aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1 truncate font-medium text-ink" dir="auto">
                    {d.name}
                    {d.hasPassword && <LockClosed12Filled className="shrink-0 text-muted" aria-label={t('share.hasPassword')} />}
                    {d.allowExec && <span className="rounded-full bg-amber-100 px-1.5 text-[10px] text-amber-800">{t('drop.execBadge')}</span>}
                  </p>
                  <p className="text-xs text-muted">
                    {t('drop.received', { n: d.files, size: formatBytes(d.bytes) })}
                    {d.lastUpload ? ` · ${formatRelative(d.lastUpload)}` : ''}
                  </p>
                  <p className="text-xs text-muted">{d.disabled ? t('drop.paused') : d.expired ? t('share.expired') : d.expiresAt ? t('share.expiresIn', { when: formatRelative(d.expiresAt) }) : t('share.exp.never')}</p>
                </div>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2">
                {!d.expired && !d.disabled && (
                  <button
                    type="button"
                    onClick={() => void copyText(d.url).then(() => (setCopied(d.id), setTimeout(() => setCopied(null), 2000)))}
                    className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-xl bg-primary-soft text-sm font-medium text-primary-ink"
                  >
                    <Copy16Regular aria-hidden />
                    {copied === d.id ? t('share.copied') : t('share.copy')}
                  </button>
                )}
                <Link href={`/files?path=${encodeURIComponent(d.dir)}`} className="inline-flex min-h-9 items-center justify-center rounded-xl bg-canvas text-sm font-medium text-ink">
                  {t('drop.openFolder')}
                </Link>
                {!d.expired && (
                  <button type="button" onClick={() => void toggle(d)} className="inline-flex min-h-9 items-center justify-center rounded-xl bg-canvas text-sm font-medium text-ink">
                    {d.disabled ? t('drop.resume') : t('drop.pause')}
                  </button>
                )}
                <button type="button" onClick={() => void remove(d)} className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-xl bg-danger/10 text-sm font-medium text-danger">
                  <Delete16Regular aria-hidden />
                  {t('drop.delete')}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
