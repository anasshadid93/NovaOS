import { useState } from 'react';
import { ArrowDown16Regular, ArrowUp16Regular, Globe20Regular, Phone20Regular } from '@fluentui/react-icons';
import { api } from '../lib/api';
import { useI18n } from '../i18n';
import { Card } from './ui';

interface Result {
  ping: number | null;
  downMbps: number;
  upMbps: number;
}

/** Times a download and an upload between this device and the server. */
async function deviceSpeed(): Promise<Result> {
  let ping = Infinity;
  for (let i = 0; i < 4; i++) {
    const t = performance.now();
    await fetch('/api/health', { cache: 'no-store' });
    ping = Math.min(ping, performance.now() - t);
  }
  let t = performance.now();
  const blob = await (await fetch('/api/speedtest/down?mb=20', { cache: 'no-store', credentials: 'same-origin' })).arrayBuffer();
  const down = (blob.byteLength * 8) / (performance.now() - t) / 1000;
  const body = new Uint8Array(blob.slice(0, 10 * 1024 * 1024));
  t = performance.now();
  await fetch('/api/speedtest/up', { method: 'POST', body, credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream' } });
  const up = (body.byteLength * 8) / (performance.now() - t) / 1000;
  return { ping: Math.round(ping), downMbps: +down.toFixed(1), upMbps: +up.toFixed(1) };
}

export function SpeedTest() {
  const { t } = useI18n();
  const [res, setRes] = useState<{ internet?: Result; device?: Result }>({});
  const [busy, setBusy] = useState<'internet' | 'device' | null>(null);
  const [err, setErr] = useState('');
  const run = async (kind: 'internet' | 'device') => {
    setBusy(kind);
    setErr('');
    try {
      const r = kind === 'internet' ? await api<Result>('/api/speedtest/internet', { body: {} }) : await deviceSpeed();
      setRes((cur) => ({ ...cur, [kind]: r }));
    } catch {
      setErr(t('speed.failed'));
    } finally {
      setBusy(null);
    }
  };
  const row = (kind: 'internet' | 'device', icon: React.ReactNode, title: string, hint: string) => {
    const r = res[kind];
    return (
      <div className="rounded-xl bg-canvas p-3">
        <div className="flex items-center gap-2">
          {icon}
          <span className="flex-1">
            <span className="block text-sm font-medium text-ink">{title}</span>
            <span className="block text-xs text-muted">{hint}</span>
          </span>
          <button type="button" disabled={!!busy} onClick={() => void run(kind)} className="rounded-full bg-primary px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
            {busy === kind ? t('speed.running') : r ? t('speed.again') : t('speed.start')}
          </button>
        </div>
        {r && (
          <div className="mt-3 grid grid-cols-3 gap-2 text-center" dir="ltr">
            <span>
              <span className="flex items-center justify-center gap-1 text-lg font-semibold text-heading">
                <ArrowDown16Regular className="text-primary" aria-hidden />
                {r.downMbps}
              </span>
              <span className="text-[11px] text-muted">Mbps ↓</span>
            </span>
            <span>
              <span className="flex items-center justify-center gap-1 text-lg font-semibold text-heading">
                <ArrowUp16Regular className="text-ok" aria-hidden />
                {r.upMbps}
              </span>
              <span className="text-[11px] text-muted">Mbps ↑</span>
            </span>
            <span>
              <span className="block text-lg font-semibold text-heading">{r.ping ?? '–'}</span>
              <span className="text-[11px] text-muted">ms ping</span>
            </span>
          </div>
        )}
      </div>
    );
  };
  return (
    <Card title={t('speed.title')}>
      <div className="space-y-3">
        {row('internet', <Globe20Regular className="text-primary-ink" aria-hidden />, t('speed.internet'), t('speed.internetHint'))}
        {row('device', <Phone20Regular className="text-primary-ink" aria-hidden />, t('speed.device'), t('speed.deviceHint'))}
        {err && <p className="text-sm text-danger">{err}</p>}
      </div>
    </Card>
  );
}
