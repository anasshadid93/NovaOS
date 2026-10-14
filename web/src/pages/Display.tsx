import { useEffect, useState } from 'react';
import { Checkmark16Filled } from '@fluentui/react-icons';
import { useI18n } from '../i18n';
import { SCALES, setScale, useScale } from '../desktop/scale';
import { setDesktopPref, useDesktopPref, type DesktopPref } from '../desktop/mode';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { getAutoLock, setAutoLock } from '../lib/autolock';
import { lockNow } from '../components/LockScreen';

/** Desktop: display settings — scale (like a monitor's scaling) and what this screen is. */
export function Display() {
  const { t } = useI18n();
  const scale = useScale();
  const pref = useDesktopPref();
  const [size, setSize] = useState({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio });
  useEffect(() => {
    const on = () => setSize({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio });
    addEventListener('resize', on);
    return () => removeEventListener('resize', on);
  }, []);
  const physical = `${Math.round(screen.width * size.dpr)} × ${Math.round(screen.height * size.dpr)}`;
  const row = (label: string, value: string) => (
    <div className="flex justify-between gap-4 border-line py-2 text-sm [&+&]:border-t">
      <span className="text-muted">{label}</span>
      <span className="font-medium tabular-nums text-ink" dir="ltr">
        {value}
      </span>
    </div>
  );

  return (
    <main className="space-y-5 p-5">
      <section>
        <h2 className="mb-1 text-sm font-semibold text-heading">{t('display.scale')}</h2>
        <p className="mb-3 text-xs text-muted">{t('display.scaleHint')}</p>
        <div className="grid grid-cols-3 gap-2 @md:grid-cols-6">
          {SCALES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setScale(s)}
              className={`relative rounded-xl py-3 text-sm font-medium tabular-nums transition ${s === scale ? 'bg-primary text-white shadow' : 'bg-surface text-ink ring-1 ring-line hover:ring-primary/50'}`}
            >
              {Math.round(s * 100)}%{s === 1 && <span className="block text-[10px] font-normal opacity-80">{t('display.recommended')}</span>}
              {s === scale && <Checkmark16Filled className="absolute end-1.5 top-1.5" aria-hidden />}
            </button>
          ))}
        </div>
      </section>

      <section className="card px-4 py-1">
        {row(t('display.screen'), physical)}
        {row(t('display.window'), `${size.w} × ${size.h}`)}
        {row(t('display.desktop'), `${Math.round(size.w / scale)} × ${Math.round(size.h / scale)}`)}
        {row(t('display.pixelRatio'), `${size.dpr}×`)}
      </section>

      <LockSettings />

      <section>
        <h2 className="mb-2 text-sm font-semibold text-heading">{t('settings.desktopMode')}</h2>
        <select value={pref} onChange={(e) => setDesktopPref(e.target.value as DesktopPref)} className="rounded-lg bg-primary-soft px-3 py-2 text-sm text-primary-ink">
          <option value="auto">{t('desktopMode.auto')}</option>
          <option value="desktop">{t('desktopMode.desktop')}</option>
          <option value="mobile">{t('desktopMode.mobile')}</option>
        </select>
        <p className="mt-2 text-xs text-muted">{t('display.browserZoom')}</p>
      </section>
    </main>
  );
}

/** PIN for the lock screen, and auto-lock after inactivity (per device). */
function LockSettings() {
  const { t } = useI18n();
  const { refresh } = useAuth();
  const [hasPin, setHasPin] = useState<boolean | null>(null);
  const [pin, setPin] = useState('');
  const [again, setAgain] = useState('');
  const [msg, setMsg] = useState('');
  const [idle, setIdle] = useState(getAutoLock());
  useEffect(() => {
    void api<{ hasPin: boolean }>('/api/lock').then((r) => setHasPin(r.hasPin));
  }, []);
  const save = async (value: string | null) => {
    setMsg('');
    if (value !== null && (!/^\d{4,8}$/.test(value) || value !== again)) return setMsg(t('lock.pinRules'));
    try {
      const r = await api<{ hasPin: boolean }>('/api/lock/pin', { method: 'PUT', body: { pin: value } });
      setHasPin(r.hasPin);
      setPin('');
      setAgain('');
      setMsg(value === null ? t('lock.pinRemoved') : t('lock.pinSaved'));
    } catch {
      setMsg(t('common.error'));
    }
  };
  const field = 'min-h-10 w-32 rounded-lg bg-surface px-3 text-center tracking-[0.3em] ring-1 ring-line outline-none focus:ring-2 focus:ring-primary';
  return (
    <section>
      <h2 className="mb-1 text-sm font-semibold text-heading">{t('lock.title')}</h2>
      <p className="mb-3 text-xs text-muted">{hasPin ? t('lock.hasPin') : t('lock.noPin')}</p>
      <div className="flex flex-wrap items-center gap-2">
        <input type="password" inputMode="numeric" maxLength={8} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} placeholder={t('lock.newPin')} aria-label={t('lock.newPin')} className={field} dir="ltr" />
        <input type="password" inputMode="numeric" maxLength={8} value={again} onChange={(e) => setAgain(e.target.value.replace(/\D/g, ''))} placeholder={t('lock.repeatPin')} aria-label={t('lock.repeatPin')} className={field} dir="ltr" />
        <button type="button" onClick={() => void save(pin)} className="min-h-10 rounded-lg bg-primary px-4 text-sm font-medium text-white">
          {hasPin ? t('lock.changePin') : t('lock.setPin')}
        </button>
        {hasPin && (
          <button type="button" onClick={() => void save(null)} className="min-h-10 rounded-lg px-3 text-sm text-danger hover:bg-danger/10">
            {t('lock.removePin')}
          </button>
        )}
      </div>
      {msg && <p className="mt-2 text-xs text-muted" role="status">{msg}</p>}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <label className="text-sm text-ink" htmlFor="autolock">
          {t('lock.auto')}
        </label>
        <select
          id="autolock"
          value={idle}
          onChange={(e) => {
            const v = Number(e.target.value);
            setIdle(v);
            setAutoLock(v);
          }}
          className="rounded-lg bg-primary-soft px-3 py-2 text-sm text-primary-ink"
        >
          {[0, 1, 5, 15, 30, 60].map((m) => (
            <option key={m} value={m}>
              {m ? t('lock.after', { n: m }) : t('lock.never')}
            </option>
          ))}
        </select>
        {hasPin && (
          <button type="button" onClick={() => void lockNow(refresh)} className="min-h-10 rounded-lg px-3 text-sm text-primary-ink hover:bg-primary-soft">
            {t('lock.lockNow')}
          </button>
        )}
      </div>
    </section>
  );
}
