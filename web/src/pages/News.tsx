import { useEffect, useState } from 'react';
import { ArrowClockwise16Regular, Open16Regular } from '@fluentui/react-icons';
import { api } from '../lib/api';
import { useI18n, type MessageKey } from '../i18n';
import { useConfirm } from '../components/ConfirmProvider';
import { Button, Card, ErrorText, PageHeader, TextField } from '../components/ui';

/**
 * News Trader: the paper account, open/closed event trades, the events the model found in the
 * headlines, the playbook (how assets reacted to each event type on history) and the AI setup.
 */
interface Position {
  id: number;
  asset: string;
  symbol: string;
  type: string;
  headline: string;
  entry: number;
  margin: number;
  stop: number;
  target: number;
  peak: number;
  openedAt: number;
  deadline: number;
  why: string;
}
interface Closed extends Position {
  exit: number;
  pnl: number;
  pct: number;
  closedAt: number;
  reason: 'target' | 'stop' | 'trail' | 'time' | 'news' | 'manual';
}
interface Entry {
  type: string;
  asset: string;
  n: number;
  avg: Record<string, number>;
  best: number;
  direction: 'up' | 'down' | 'mixed';
  reliability: number;
}
interface Data {
  account: { start: number; balance: number; equity: number; running: boolean; positions: Position[]; closed: Closed[]; dayPnl: number; skipped: { at: number; headline: string; asset: string; why: string }[] };
  prices: Record<string, number>;
  events: { id: number; title: string; type: string; assets: string[]; direction: string; confidence: number; importance: number; horizon_days: number; why: string; at: number }[];
  headlines: { title: string; feed: string; lang: string; link: string; published_at: number }[];
  playbook: { builtAt: number; events: number; entries: Entry[] } | null;
  rules: { riskPct: number; maxOpen: number; stopPct: number; targetCapPct: number; trailArmPct: number; trailPct: number; dailyLossPct: number };
  llm: { ready: boolean; model: string; usage: { calls: number; inTokens: number; outTokens: number } };
  lastScan: number | null;
  lastError: string | null;
  scanning: boolean;
  tradable: string[];
}

const usd = (v: number) => `$${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const pct = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
const dirCls = (d: string) => (d === 'up' ? 'text-ok' : d === 'down' ? 'text-danger' : 'text-muted');

export function News() {
  const { t, formatRelative } = useI18n();
  const ask = useConfirm();
  const [d, setD] = useState<Data | null>(null);
  const [key, setKey] = useState('');
  const [model, setModel] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<'trades' | 'events' | 'playbook' | 'headlines'>('trades');

  const load = () => api<Data>('/api/news').then((x) => {
    setD(x);
    if (!model) setModel(x.llm.model);
  });
  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 30_000);
    return () => clearInterval(id);
  }, []);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setMsg('');
    try {
      await fn();
      await load();
    } catch (e) {
      setMsg((e as Error).message || t('common.error'));
    } finally {
      setBusy(false);
    }
  };

  if (!d) return <PageHeader title={t('news.title')} back="/" />;
  const a = d.account;
  const gain = a.equity - a.start;
  const chip = (on: boolean) => `rounded-full px-3 py-1 text-sm ${on ? 'bg-primary text-white' : 'bg-surface text-ink shadow-card'}`;

  return (
    <>
      <PageHeader
        title={t('news.title')}
        back="/"
        actions={
          <button type="button" disabled={d.scanning || busy || !d.llm.ready} onClick={() => void run(() => api('/api/news/scan', { body: {} }))} className="inline-flex items-center gap-1 rounded-full px-3 py-1 text-sm text-primary-ink hover:bg-primary-soft disabled:opacity-50">
            <ArrowClockwise16Regular aria-hidden className={d.scanning ? 'animate-spin' : ''} />
            {d.scanning ? t('news.scanning') : t('news.scan')}
          </button>
        }
      />
      <main className="safe-bottom mx-auto max-w-3xl space-y-4 px-3">
        <p className="text-xs text-muted">{t('news.hint')}</p>

        {/* Account */}
        <Card title={t('news.paper')} action={<span className={`text-xs ${a.running ? 'text-ok' : 'text-warn'}`}>{a.running ? '●' : t('news.paused')}</span>}>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div>
              <div className="text-xs text-muted">{t('news.balance')}</div>
              <div className="text-lg font-semibold text-ink" dir="ltr">{usd(a.balance)}</div>
            </div>
            <div>
              <div className="text-xs text-muted">{t('news.equity')}</div>
              <div className={`text-lg font-semibold ${gain >= 0 ? 'text-ok' : 'text-danger'}`} dir="ltr">
                {usd(a.equity)} <span className="text-xs">({pct((gain / a.start) * 100)})</span>
              </div>
            </div>
            <div>
              <div className="text-xs text-muted">{t('news.open')}</div>
              <div className="text-lg font-semibold text-ink">{a.positions.length}</div>
            </div>
          </div>
          <p className="mt-2 text-xs text-muted">{t('news.rules', { risk: d.rules.riskPct, open: d.rules.maxOpen, stop: d.rules.stopPct, cap: d.rules.targetCapPct, trail: d.rules.trailPct, arm: d.rules.trailArmPct, daily: d.rules.dailyLossPct })}</p>
          <p className="mt-1 text-xs text-muted">
            {d.lastScan ? t('news.lastScan', { when: formatRelative(d.lastScan) }) : ''} {d.llm.ready ? '' : `· ${t('news.keyMissing')}`} {d.lastError ? `· ${d.lastError}` : ''}
          </p>
          <div className="mt-2 flex gap-2">
            <Button variant="secondary" disabled={busy} onClick={() => void run(() => api('/api/news/run', { body: { running: !a.running } }))}>
              {a.running ? t('news.pause') : t('news.resume')}
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void (async () => {
                  if (await ask({ title: t('news.reset'), body: <p>{t('news.resetBody')}</p>, confirmLabel: t('news.reset'), danger: true })) await run(() => api('/api/news/reset', { body: {} }));
                })()
              }
            >
              {t('news.reset')}
            </Button>
          </div>
        </Card>

        <div className="flex flex-wrap gap-2">
          {(['trades', 'events', 'playbook', 'headlines'] as const).map((x) => (
            <button key={x} type="button" className={chip(tab === x)} onClick={() => setTab(x)}>
              {t(x === 'trades' ? 'news.open' : x === 'events' ? 'news.events' : x === 'playbook' ? 'news.playbook' : 'news.headlines')}
            </button>
          ))}
        </div>

        {tab === 'trades' && (
          <>
            <Card title={t('news.open')}>
              {a.positions.length === 0 && <p className="text-sm text-muted">{t('news.none')}</p>}
              <ul className="divide-y divide-line">
                {a.positions.map((p) => {
                  const price = d.prices[p.symbol] ?? p.entry;
                  const now = ((price - p.entry) / p.entry) * 100;
                  return (
                    <li key={p.id} className="py-2 text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-ink">
                          {p.asset} <span className="text-xs text-muted">{t(`ev.${p.type}` as MessageKey)}</span>
                        </span>
                        <span className={`font-medium ${now >= 0 ? 'text-ok' : 'text-danger'}`} dir="ltr">
                          {pct(now)} · {usd(p.margin)}
                        </span>
                      </div>
                      <div className="text-xs text-ink">{p.headline}</div>
                      <div className="text-xs text-muted">{p.why}</div>
                      <div className="mt-1 flex items-center justify-between text-xs text-muted" dir="ltr">
                        <span>
                          {t('news.target')} {pct(((p.target - p.entry) / p.entry) * 100)} · {t('news.stop')} {pct(((p.stop - p.entry) / p.entry) * 100)} · {new Date(p.deadline).toLocaleDateString()}
                        </span>
                        <button type="button" className="text-primary-ink" onClick={() => void run(() => api(`/api/news/positions/${p.id}/close`, { body: {} }))}>
                          {t('news.closeNow')}
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </Card>
            <Card title={t('news.closed')}>
              {a.closed.length === 0 && <p className="text-sm text-muted">{t('news.none')}</p>}
              <ul className="divide-y divide-line">
                {a.closed.slice(0, 30).map((c) => (
                  <li key={c.id} className="py-2 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-ink">
                        {c.asset} <span className="text-xs text-muted">{t(`news.reason.${c.reason}` as MessageKey)} · {formatRelative(c.closedAt)}</span>
                      </span>
                      <span className={`font-medium ${c.pnl >= 0 ? 'text-ok' : 'text-danger'}`} dir="ltr">
                        {pct(c.pct)} · {usd(c.pnl)}
                      </span>
                    </div>
                    <div className="text-xs text-muted">{c.headline}</div>
                  </li>
                ))}
              </ul>
            </Card>
            {a.skipped.length > 0 && (
              <Card title={t('news.skipped')}>
                <ul className="divide-y divide-line text-xs">
                  {a.skipped.slice(0, 20).map((s, i) => (
                    <li key={i} className="py-1.5">
                      <span className="text-ink">{s.asset}</span> <span className="text-muted">· {s.why} · {formatRelative(s.at)}</span>
                      <div className="text-muted">{s.headline}</div>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </>
        )}

        {tab === 'events' && (
          <Card title={t('news.events')}>
            {d.events.length === 0 && <p className="text-sm text-muted">{t('news.none')}</p>}
            <ul className="divide-y divide-line">
              {d.events.map((e) => (
                <li key={e.id} className="py-2 text-sm">
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-ink">{e.title}</span>
                    <span className="shrink-0 text-xs text-muted">{formatRelative(e.at)}</span>
                  </div>
                  <div className="mt-0.5 text-xs">
                    <span className="rounded-full bg-canvas px-2 py-0.5 text-ink">{t(`ev.${e.type}` as MessageKey)}</span>{' '}
                    <span className={dirCls(e.direction)}>{e.assets.join(', ')} {e.direction === 'up' ? '↑' : e.direction === 'down' ? '↓' : '↕'}</span>{' '}
                    <span className="text-muted">
                      {Math.round(e.confidence * 100)}% · {e.horizon_days}d · {e.why}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        )}

        {tab === 'playbook' && (
          <Card
            title={t('news.playbook')}
            action={
              <button type="button" disabled={busy} className="text-sm text-primary-ink" onClick={() => void run(() => api('/api/news/playbook', { body: {} }))}>
                {t('news.rebuild')}
              </button>
            }
          >
            <p className="mb-2 text-xs text-muted">{t('news.playbookHint', { n: d.playbook?.events ?? 0 })}</p>
            {d.playbook && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs" dir="ltr">
                  <thead>
                    <tr className="text-muted">
                      <th className="py-1 text-start font-medium">Event</th>
                      {['BTC', 'ETH', 'SOL', 'GOLD', 'SILVER', 'OIL', 'SPX', 'DXY'].map((x) => (
                        <th key={x} className="py-1 text-end font-medium">{x}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {[...new Set(d.playbook.entries.map((e) => e.type))].map((type) => (
                      <tr key={type}>
                        <td className="py-1 pe-2 text-ink">{t(`ev.${type}` as MessageKey)}</td>
                        {['BTC', 'ETH', 'SOL', 'GOLD', 'SILVER', 'OIL', 'SPX', 'DXY'].map((asset) => {
                          const e = d.playbook!.entries.find((x) => x.type === type && x.asset === asset);
                          return (
                            <td key={asset} className={`py-1 text-end ${e ? dirCls(e.direction) : 'text-muted'}`} title={e ? `n=${e.n}, ${Math.round(e.reliability * 100)}% ${t('news.reliable')}, ${e.best}d` : ''}>
                              {e ? `${pct(e.avg[e.best])}` : '—'}
                              {e && <span className="block text-[10px] text-muted">{e.best}d · {Math.round(e.reliability * 100)}%</span>}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        )}

        {tab === 'headlines' && (
          <Card title={t('news.headlines')}>
            <ul className="divide-y divide-line">
              {d.headlines.map((h, i) => (
                <li key={i} className="py-1.5 text-sm">
                  <a href={h.link} target="_blank" rel="noreferrer" className="text-ink" dir="auto">
                    {h.title} <Open16Regular aria-hidden className="inline size-3 text-muted" />
                  </a>
                  <div className="text-xs text-muted">
                    {h.feed} · {formatRelative(h.published_at)}
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        )}

        {/* AI setup */}
        <Card title={t('news.setup')}>
          <p className="mb-2 text-xs text-muted">{t('news.setupHint')}</p>
          <p className="mb-2 text-xs">
            {d.llm.ready ? <span className="text-ok">{t('news.keySet')}</span> : <span className="text-warn">{t('news.keyMissing')}</span>}
            {d.llm.ready && <span className="text-muted"> · {t('news.usage', { calls: d.llm.usage.calls, tok: Math.round((d.llm.usage.inTokens + d.llm.usage.outTokens) / 1000) })}</span>}
          </p>
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await api('/api/news/settings', { body: { ...(key ? { anthropicKey: key } : {}), model } });
                setKey('');
              });
            }}
          >
            <TextField label={t('news.key')} type="password" autoComplete="off" dir="ltr" placeholder="sk-ant-…" value={key} onChange={(e) => setKey(e.target.value)} />
            <TextField label={t('news.model')} dir="ltr" value={model} onChange={(e) => setModel(e.target.value)} />
            <ErrorText>{msg}</ErrorText>
            <Button type="submit" className="w-full" disabled={busy || (!key && model === d.llm.model)}>
              {t('news.save')}
            </Button>
          </form>
        </Card>
      </main>
    </>
  );
}
