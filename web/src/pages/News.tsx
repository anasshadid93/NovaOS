import { useEffect, useState } from 'react';
import { ArrowClockwise16Regular, Open16Regular } from '@fluentui/react-icons';
import { api } from '../lib/api';
import { useI18n, type MessageKey } from '../i18n';
import { useConfirm } from '../components/ConfirmProvider';
import { Chart } from '../components/Chart';
import { Button, Card, ErrorText, PageHeader, TextField } from '../components/ui';

/**
 * News Trader: dashboard (equity, win rate, profit by asset/event, activity), trades, the events
 * the model found, the playbook (history), the headlines, and settings (rules, assets, AI key).
 */
type Asset = 'BTC' | 'ETH' | 'SOL' | 'GOLD' | 'SILVER' | 'OIL' | 'SPX' | 'DXY';
const ALL_ASSETS: Asset[] = ['BTC', 'ETH', 'SOL', 'GOLD', 'SILVER', 'OIL', 'SPX', 'DXY'];
interface Position {
  id: number;
  asset: Asset;
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
interface Rules {
  assets: Asset[];
  startBalance: number;
  scanEveryMin: number;
  riskPct: number;
  maxOpen: number;
  stopPct: number;
  targetCapPct: number;
  targetMinPct: number;
  trailArmPct: number;
  trailPct: number;
  dailyLossPct: number;
  minConfidence: number;
  minReliability: number;
  minAvgMove: number;
}
interface Group {
  key: string;
  n: number;
  wins: number;
  pnl: number;
}
interface Stats {
  equity: number;
  returnPct: number;
  trades: number;
  open: number;
  winRate: number | null;
  profitFactor: number | null;
  avgPct: number | null;
  best: Closed | null;
  worst: Closed | null;
  dayPnl: number;
  byAsset: Group[];
  byType: Group[];
  byReason: Group[];
  perDay: { day: string; headlines: number; events: number; trades: number }[];
  equitySeries: { at: number; equity: number }[];
  feeds24h: { feed: string; n: number }[];
  eventTypes14d: { type: string; n: number }[];
}
interface Data {
  account: { start: number; balance: number; equity: number; running: boolean; positions: Position[]; closed: Closed[]; dayPnl: number; skipped: { at: number; headline: string; asset: string; why: string }[] };
  prices: Record<string, number>;
  events: { id: number; title: string; type: string; assets: string[]; direction: string; confidence: number; importance: number; horizon_days: number; why: string; at: number }[];
  headlines: { title: string; feed: string; lang: string; link: string; published_at: number }[];
  playbook: { builtAt: number; events: number; entries: Entry[] } | null;
  rules: Rules;
  llm: { ready: boolean; model: string; usage: { calls: number; inTokens: number; outTokens: number } };
  lastScan: number | null;
  lastError: string | null;
  scanning: boolean;
  stats: Stats;
}

const usd = (v: number) => `$${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const pct = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
const dirCls = (d: string) => (d === 'up' ? 'text-ok' : d === 'down' ? 'text-danger' : 'text-muted');
const TAB_KEYS = { dashboard: 'news.dashboard', trades: 'news.trades', events: 'news.events', playbook: 'news.playbook', headlines: 'news.headlines', settings: 'news.settings' } as const;
type Tab = keyof typeof TAB_KEYS;

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'danger' }) {
  return (
    <div className="card p-3">
      <div className="text-xs text-muted">{label}</div>
      <div className={`text-lg font-semibold ${tone === 'ok' ? 'text-ok' : tone === 'danger' ? 'text-danger' : 'text-ink'}`} dir="ltr">
        {value}
      </div>
    </div>
  );
}

/** Horizontal bars for a few signed values (profit by asset / type): CSS only, direct labels. */
function Bars({ rows, label }: { rows: Group[]; label: (k: string) => string }) {
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.pnl)));
  return (
    <ul className="space-y-1.5">
      {rows.map((r) => (
        <li key={r.key} className="text-xs">
          <div className="flex justify-between text-ink">
            <span>
              {label(r.key)} <span className="text-muted">· {r.n} ({r.wins}W)</span>
            </span>
            <span className={r.pnl >= 0 ? 'text-ok' : 'text-danger'} dir="ltr">
              {usd(r.pnl)}
            </span>
          </div>
          <div className="mt-0.5 h-2 rounded-full bg-canvas">
            <div className={`h-2 rounded-full ${r.pnl >= 0 ? 'bg-ok' : 'bg-danger'}`} style={{ width: `${Math.max(2, (Math.abs(r.pnl) / max) * 100)}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function News() {
  const { t, formatRelative } = useI18n();
  const ask = useConfirm();
  const [d, setD] = useState<Data | null>(null);
  const [tab, setTab] = useState<Tab>('dashboard');
  const [key, setKey] = useState('');
  const [model, setModel] = useState('');
  const [form, setForm] = useState<Rules | null>(null);
  const [msg, setMsg] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () =>
    api<Data>('/api/news').then((x) => {
      setD(x);
      setModel((m) => m || x.llm.model);
      setForm((f) => f ?? x.rules);
    });
  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 30_000);
    return () => clearInterval(id);
  }, []);

  const run = async (fn: () => Promise<unknown>, done = '') => {
    setBusy(true);
    setMsg('');
    setOk('');
    try {
      await fn();
      await load();
      setOk(done);
    } catch (e) {
      setMsg((e as Error).message || t('common.error'));
    } finally {
      setBusy(false);
    }
  };

  if (!d || !form) return <PageHeader title={t('news.title')} back="/" />;
  const a = d.account;
  const s = d.stats;
  const chip = (on: boolean) => `rounded-full px-3 py-1 text-sm ${on ? 'bg-primary text-white' : 'bg-surface text-ink shadow-card'}`;
  const ev = (type: string) => t(`ev.${type}` as MessageKey);
  const num = (k: keyof Rules, label: string, step = 1) => (
    <label key={k} className="block">
      <span className="mb-1 block text-xs font-medium text-ink">{label}</span>
      <input type="number" step={step} dir="ltr" value={form[k] as number} onChange={(e) => setForm({ ...form, [k]: Number(e.target.value) })} className="block min-h-10 w-full rounded-xl border border-line bg-surface px-3 text-sm text-ink outline-none focus:border-primary" />
    </label>
  );

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
        <div className="flex flex-wrap gap-2">
          {(Object.keys(TAB_KEYS) as Tab[]).map((x) => (
            <button key={x} type="button" className={chip(tab === x)} onClick={() => setTab(x)}>
              {t(TAB_KEYS[x])}
            </button>
          ))}
        </div>
        {msg && <ErrorText>{msg}</ErrorText>}

        {tab === 'dashboard' && (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label={t('news.equity')} value={usd(s.equity)} tone={s.returnPct >= 0 ? 'ok' : 'danger'} />
              <Stat label={t('news.return')} value={pct(s.returnPct)} tone={s.returnPct >= 0 ? 'ok' : 'danger'} />
              <Stat label={t('news.trades')} value={`${s.trades} · ${s.open} ${t('news.open').toLowerCase()}`} />
              <Stat label={t('news.winRate')} value={s.winRate === null ? '—' : `${s.winRate}%`} />
              <Stat label={t('news.profitFactor')} value={s.profitFactor === null ? '—' : String(s.profitFactor)} />
              <Stat label={t('news.avgTrade')} value={s.avgPct === null ? '—' : pct(s.avgPct)} />
              <Stat label={t('news.today')} value={usd(s.dayPnl)} tone={s.dayPnl >= 0 ? 'ok' : 'danger'} />
              <Stat label={t('news.balance')} value={usd(a.balance)} />
            </div>
            <p className="text-xs text-muted">
              {a.running ? '● ' : `${t('news.paused')} · `}
              {d.lastScan ? t('news.lastScan', { when: formatRelative(d.lastScan) }) : ''} {d.llm.ready ? '' : `· ${t('news.keyMissing')}`} {d.lastError ? `· ${d.lastError}` : ''}
            </p>
            <Card title={t('news.equityCurve')}>
              {s.equitySeries.length >= 2 ? (
                <Chart data={[s.equitySeries.map((p) => Math.round(p.at / 1000)), s.equitySeries.map((p) => p.equity)]} series={[{ label: 'USD', color: '#2f6fe4' }]} height={180} fmt={(v) => usd(v)} />
              ) : (
                <p className="text-xs text-muted">{t('news.noTrades')}</p>
              )}
            </Card>
            <div className="grid gap-3 md:grid-cols-2">
              <Card title={t('news.byAsset')}>{s.byAsset.length ? <Bars rows={s.byAsset} label={(k) => k} /> : <p className="text-xs text-muted">{t('news.noTrades')}</p>}</Card>
              <Card title={t('news.byType')}>{s.byType.length ? <Bars rows={s.byType} label={ev} /> : <p className="text-xs text-muted">{t('news.noTrades')}</p>}</Card>
            </div>
            {(s.best || s.worst) && (
              <div className="grid gap-3 md:grid-cols-2">
                {s.best && (
                  <Card title={t('news.best')}>
                    <p className="text-sm text-ok" dir="ltr">{s.best.asset} {pct(s.best.pct)} · {usd(s.best.pnl)}</p>
                    <p className="text-xs text-muted">{s.best.headline}</p>
                  </Card>
                )}
                {s.worst && (
                  <Card title={t('news.worst')}>
                    <p className="text-sm text-danger" dir="ltr">{s.worst.asset} {pct(s.worst.pct)} · {usd(s.worst.pnl)}</p>
                    <p className="text-xs text-muted">{s.worst.headline}</p>
                  </Card>
                )}
              </div>
            )}
            <Card title={t('news.activity')}>
              {(() => {
                const max = Math.max(1, ...s.perDay.map((x) => x.headlines));
                return (
                  <div>
                    <div className="flex h-28 items-end gap-1" dir="ltr">
                      {s.perDay.map((x) => (
                        <div key={x.day} className="flex flex-1 flex-col items-center justify-end gap-0.5" title={`${x.day}: ${x.headlines} ${t('news.actHeadlines')}, ${x.events} ${t('news.actEvents')}, ${x.trades} ${t('news.actTrades')}`}>
                          <div className="w-full rounded-t bg-primary/25" style={{ height: `${(x.headlines / max) * 100}%` }} />
                          {x.events > 0 && <div className="w-full rounded-t bg-primary" style={{ height: `${Math.min(100, (x.events / max) * 100)}%`, minHeight: 2 }} />}
                          {x.trades > 0 && <div className="size-1.5 rounded-full bg-ok" />}
                        </div>
                      ))}
                    </div>
                    <div className="mt-1 flex justify-between text-[10px] text-muted" dir="ltr">
                      <span>{s.perDay[0]?.day.slice(5)}</span>
                      <span>{s.perDay[s.perDay.length - 1]?.day.slice(5)}</span>
                    </div>
                    <p className="mt-1 text-xs text-muted">
                      <span className="inline-block size-2 rounded-sm bg-primary/25 align-middle" /> {t('news.actHeadlines')} · <span className="inline-block size-2 rounded-sm bg-primary align-middle" /> {t('news.actEvents')} · <span className="inline-block size-2 rounded-full bg-ok align-middle" /> {t('news.actTrades')}
                    </p>
                  </div>
                );
              })()}
            </Card>
            <div className="grid gap-3 md:grid-cols-2">
              <Card title={t('news.feeds24')}>
                <ul className="space-y-1 text-xs">
                  {s.feeds24h.map((f) => (
                    <li key={f.feed} className="flex justify-between">
                      <span className="text-ink">{f.feed}</span>
                      <span className="text-muted">{f.n}</span>
                    </li>
                  ))}
                </ul>
              </Card>
              <Card title={t('news.events')}>
                <ul className="space-y-1 text-xs">
                  {s.eventTypes14d.map((x) => (
                    <li key={x.type} className="flex justify-between">
                      <span className="text-ink">{ev(x.type)}</span>
                      <span className="text-muted">{x.n}</span>
                    </li>
                  ))}
                  {s.eventTypes14d.length === 0 && <li className="text-muted">{t('news.none')}</li>}
                </ul>
              </Card>
            </div>
          </>
        )}

        {tab === 'trades' && (
          <>
            <Card title={t('news.open')} action={<Button variant="secondary" disabled={busy} onClick={() => void run(() => api('/api/news/run', { body: { running: !a.running } }))}>{a.running ? t('news.pause') : t('news.resume')}</Button>}>
              {a.positions.length === 0 && <p className="text-sm text-muted">{t('news.none')}</p>}
              <ul className="divide-y divide-line">
                {a.positions.map((p) => {
                  const price = d.prices[p.symbol] ?? p.entry;
                  const now = ((price - p.entry) / p.entry) * 100;
                  return (
                    <li key={p.id} className="py-2 text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-ink">
                          {p.asset} <span className="text-xs text-muted">{ev(p.type)}</span>
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
                  {a.skipped.slice(0, 20).map((x, i) => (
                    <li key={i} className="py-1.5">
                      <span className="text-ink">{x.asset}</span> <span className="text-muted">· {x.why} · {formatRelative(x.at)}</span>
                      <div className="text-muted">{x.headline}</div>
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
                    <span className="rounded-full bg-canvas px-2 py-0.5 text-ink">{ev(e.type)}</span>{' '}
                    <span className={dirCls(e.direction)}>
                      {e.assets.join(', ')} {e.direction === 'up' ? '↑' : e.direction === 'down' ? '↓' : '↕'}
                    </span>{' '}
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
                      {ALL_ASSETS.map((x) => (
                        <th key={x} className="py-1 text-end font-medium">
                          {x}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {[...new Set(d.playbook.entries.map((e) => e.type))].map((type) => (
                      <tr key={type}>
                        <td className="py-1 pe-2 text-ink">{ev(type)}</td>
                        {ALL_ASSETS.map((asset) => {
                          const e = d.playbook!.entries.find((x) => x.type === type && x.asset === asset);
                          return (
                            <td key={asset} className={`py-1 text-end ${e ? dirCls(e.direction) : 'text-muted'}`} title={e ? `n=${e.n}, ${Math.round(e.reliability * 100)}% ${t('news.reliable')}, ${e.best}d` : ''}>
                              {e ? pct(e.avg[e.best]) : '—'}
                              {e && (
                                <span className="block text-[10px] text-muted">
                                  {e.best}d · {Math.round(e.reliability * 100)}%
                                </span>
                              )}
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

        {tab === 'settings' && (
          <>
            <Card title={t('news.rulesTitle')}>
              <form
                className="space-y-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(() => api('/api/news/settings', { body: { rules: form } }), t('news.saved'));
                }}
              >
                <div>
                  <span className="mb-1 block text-xs font-medium text-ink">{t('news.assets')}</span>
                  <div className="flex flex-wrap gap-2">
                    {ALL_ASSETS.map((x) => {
                      const on = form.assets.includes(x);
                      return (
                        <button key={x} type="button" className={chip(on)} aria-pressed={on} onClick={() => setForm({ ...form, assets: on ? form.assets.filter((y) => y !== x) : [...form.assets, x] })}>
                          {x}
                        </button>
                      );
                    })}
                  </div>
                  <p className="mt-1 text-xs text-muted">{t('news.assetsHint')}</p>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  {num('riskPct', t('news.riskPct'))}
                  {num('maxOpen', t('news.maxOpen'))}
                  {num('stopPct', t('news.stopPct'), 0.5)}
                  {num('targetMinPct', t('news.targetMin'), 0.5)}
                  {num('targetCapPct', t('news.targetCap'), 0.5)}
                  {num('trailArmPct', t('news.trailArm'), 0.5)}
                  {num('trailPct', t('news.trailPct'), 0.5)}
                  {num('dailyLossPct', t('news.dailyLoss'), 0.5)}
                  {num('minConfidence', t('news.minConf'), 0.05)}
                  {num('minReliability', t('news.minRel'), 0.05)}
                  {num('minAvgMove', t('news.minMove'), 0.5)}
                  {num('scanEveryMin', t('news.scanEvery'), 5)}
                  {num('startBalance', t('news.startBalance'), 100)}
                </div>
                {ok && <p className="text-xs text-ok">{ok}</p>}
                <Button type="submit" className="w-full" disabled={busy}>
                  {t('news.save')}
                </Button>
              </form>
            </Card>
            <Card title={t('news.aiTitle')}>
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
                  }, t('news.saved'));
                }}
              >
                <TextField label={t('news.key')} type="password" autoComplete="off" dir="ltr" placeholder="sk-ant-…" value={key} onChange={(e) => setKey(e.target.value)} />
                <TextField label={t('news.model')} dir="ltr" value={model} onChange={(e) => setModel(e.target.value)} />
                <Button type="submit" className="w-full" disabled={busy || (!key && model === d.llm.model)}>
                  {t('news.save')}
                </Button>
              </form>
            </Card>
            <Card title={t('news.reset')}>
              <p className="mb-2 text-xs text-muted">{t('news.resetBody')}</p>
              <Button
                variant="danger"
                disabled={busy}
                onClick={() =>
                  void (async () => {
                    if (await ask({ title: t('news.reset'), body: <p>{t('news.resetBody')}</p>, confirmLabel: t('news.reset'), danger: true })) await run(() => api('/api/news/reset', { body: {} }));
                  })()
                }
              >
                {t('news.reset')}
              </Button>
            </Card>
          </>
        )}
      </main>
    </>
  );
}
