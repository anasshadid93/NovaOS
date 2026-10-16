import { useEffect, useState, type ReactNode } from 'react';
import { ArrowClockwise16Regular } from '@fluentui/react-icons';
import { api, ApiError } from '../lib/api';
import { useI18n, type MessageKey } from '../i18n';
import { useConfirm } from '../components/ConfirmProvider';
import { Chart } from '../components/Chart';
import { Button, Card, ErrorText, PageHeader, TextField } from '../components/ui';

/**
 * Quant Desk: the AI trading platform. Overview (equity, positions, merged scores), Signals,
 * Agents (TradingAgents debates), Backtests (LEAN), Risk & Live (limits, keys, authorisation,
 * kill switch) and the audit log. Everything the engine does is visible here; nothing live
 * happens without the explicit authorisation flow in the Risk tab.
 */
interface Quote {
  price: number;
  at: number;
  source: string;
  check?: { price: number; source: string; gapPct: number };
}
interface Part {
  score: number;
  confidence: number;
  at: number;
  weight: number;
}
interface Merged {
  asset: string;
  score: number;
  parts: Record<string, Part>;
  vetoed?: string;
}
interface Signal {
  id: number;
  at: number;
  source: string;
  asset: string;
  score: number;
  confidence: number;
  expires_at: number;
  detail: string | null;
}
interface Position {
  id: number;
  mode: 'paper' | 'live';
  asset: string;
  qty: number;
  entry: number;
  opened_at: number;
  stop: number;
  target: number | null;
  high: number;
  deadline: number | null;
  closed_at: number | null;
  exit: number | null;
  pnl: number | null;
  reason: string | null;
  score: number | null;
}
interface Perf {
  trades: number;
  winRate: number;
  profitFactor: number;
  realised: number;
  maxDrawdownPct: number;
  sharpe: number;
  byReason: Record<string, number>;
  curve: { at: number; equity: number }[];
}
interface Book {
  equity: number;
  cash: number;
  exposure: number;
  unrealised: number;
  open: Position[];
  closed: Position[];
  perf: Perf;
}
interface AgentRun {
  id: string;
  asset: string;
  day: string;
  status: 'queued' | 'running' | 'done' | 'error';
  created_at: number;
  finished_at: number | null;
  rating: string | null;
  score: number | null;
  llm: string | null;
  reports: string | null;
  error: string | null;
}
interface LeanRun {
  id: number;
  kind: 'backtest' | 'walkforward' | 'data';
  created_at: number;
  finished_at: number | null;
  status: string;
  params: Record<string, unknown> | null;
  stats: Record<string, unknown> | null;
  log: string | null;
}
interface Risk {
  startBalance: number;
  riskPct: number;
  maxPositionPct: number;
  maxExposurePct: number;
  maxOpen: number;
  stopAtr: number;
  stopMinPct: number;
  stopMaxPct: number;
  takeProfitR: number;
  trailArmR: number;
  trailAtr: number;
  dailyLossPct: number;
  maxHoldDays: number;
  cooldownMin: number;
  entryScore: number;
  exitScore: number;
  maxPriceAgeSec: number;
  maxSourceGapPct: number;
}
interface Settings {
  futures: FuturesData['settings'];
  strategy: 'regime' | 'rules';
  regime: { trailPct: number; cooldownDays: number };
  agentsVeto: boolean;
  assets: string[];
  keys: { anthropic: boolean; openai: boolean };
  ollamaUrl: string;
  routing: { quick: { provider: string; model: string }; deep: { provider: string; model: string }; fallback: string[] };
  analysts: string[];
  agentsHourUtc: number;
  agentsEnabled: boolean;
  agentsDailyCap: number;
  weights: { technical: number; agents: number; news: number };
  risk: Risk;
  paperEnabled: boolean;
  live: { enabled: boolean; broker: string; authorizedAt: number | null; maxNotionalUsd: number; killSwitch: boolean };
}
interface FPos {
  id: number;
  asset: string;
  qty: number;
  entry: number;
  opened_at: number;
  stop: number;
  high: number;
  closed_at: number | null;
  exit: number | null;
  pnl: number | null;
  reason: string | null;
  detail: string | null;
}
interface FuturesData {
  equity: number;
  cash: number;
  exposure: number;
  unrealised: number;
  realised: number;
  open: FPos[];
  closed: FPos[];
  perf: Perf;
  marks: Record<string, { mark: number; at: number; fundingRate: number; nextFunding: number; spotGapPct: number | null }>;
  regimes: Record<string, { signal: 1 | -1 | 0; atr: number; emaFast: number; emaSlow: number; emaTrend: number; close: number; at: number }>;
  lastError: string | null;
  settings: { enabled: boolean; assets: string[]; tf: '1h' | '4h'; leverage: number; marginPct: number; trailAtr: number; allowShort: boolean; cooldownBars: number; startBalance: number };
}
interface Data {
  settings: Settings;
  futures: FuturesData;
  markets: string[];
  quotes: Record<string, Quote>;
  merged: Merged[];
  signals: Signal[];
  paper: Book;
  live: Book & { status: { keysFor: string[] } };
  agents: { installed: boolean; alive: boolean; error: string | null; route: { provider: string; quick: string; deep: string } | null; runs: AgentRun[] };
  lean: { installed: boolean; running: boolean; queue: number; runs: LeanRun[]; data: Record<string, { last: string | null }> | null };
  lastStep: { at: number; opened: unknown[]; closed: unknown[]; skipped: { asset: string; why: string }[] } | null;
  lastError: string | null;
}

const usd = (v: number) => `$${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const px = (v: number) => (v >= 100 ? v.toLocaleString('en-US', { maximumFractionDigits: 2 }) : v.toPrecision(4));
const TABS = ['overview', 'trades', 'futures', 'signals', 'agents', 'backtests', 'risk', 'audit'] as const;
type Tab = (typeof TABS)[number];
const PHRASE = 'I AUTHORIZE LIVE TRADING WITH REAL FUNDS';

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'danger' }) {
  return (
    <div className="card min-w-0 p-2">
      <div className="truncate text-[11px] text-muted">{label}</div>
      <div className={`truncate text-sm font-semibold ${tone === 'ok' ? 'text-ok' : tone === 'danger' ? 'text-danger' : 'text-ink'}`} dir="ltr">
        {value}
      </div>
    </div>
  );
}
function Num({ label, value, step = 1, onChange }: { label: string; value: number; step?: number; onChange: (v: number) => void }) {
  return <TextField label={label} type="number" inputMode="decimal" step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />;
}
function Toggle({ label, on, onChange, disabled }: { label: ReactNode; on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="flex min-h-12 items-center justify-between gap-3 rounded-xl bg-surface px-3 shadow-card">
      <span className="text-sm text-ink">{label}</span>
      <input type="checkbox" checked={on} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="size-5 accent-primary" />
    </label>
  );
}

export function Quant() {
  const { t, formatRelative } = useI18n();
  const ask = useConfirm();
  const [d, setD] = useState<Data | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<Settings | null>(null);
  const [openRun, setOpenRun] = useState<AgentRun | null>(null);
  const [leanRun, setLeanRun] = useState<(LeanRun & { equity: [number, number][] }) | null>(null);
  const [bt, setBt] = useState({ start: '2021-01-01', end: new Date().toISOString().slice(0, 10), trainDays: 365, testDays: 90 });
  const [keys, setKeys] = useState({ anthropic: '', openai: '', broker: 'binance-testnet', key: '', secret: '', phrase: '', maxNotionalUsd: 100 });
  const [auditRows, setAudit] = useState<{ ts: number; action: string; detail: string | null }[]>([]);
  const [orders, setOrders] = useState<
    {
      id: number;
      at: number;
      mode: string;
      asset: string;
      side: 'buy' | 'sell';
      qty: number;
      price: number;
      notional: number;
      fee: number;
      reason: string;
      position_id: number | null;
      pnl: number | null;
      entry: number | null;
      pdetail: string | null;
    }[]
  >([]);

  const load = () =>
    api<Data>('/api/quant')
      .then((x) => {
        setD(x);
        setForm((f) => f ?? x.settings);
      })
      .catch((e) => setMsg(e instanceof ApiError ? e.code : String(e)));
  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 30_000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (tab === 'audit')
      api<typeof auditRows>('/api/quant/audit?limit=150')
        .then(setAudit)
        .catch(() => undefined);
    if (tab === 'trades')
      api<typeof orders>('/api/quant/orders?limit=300')
        .then(setOrders)
        .catch(() => undefined);
  }, [tab, d?.lastStep?.at]);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    setMsg('');
    try {
      await fn();
      if (ok) setMsg(ok);
      await load();
    } catch (e) {
      setMsg(e instanceof ApiError ? `${e.code}${(e as ApiError & { detail?: string }).detail ? `: ${(e as ApiError & { detail?: string }).detail}` : ''}` : String(e));
    } finally {
      setBusy(false);
    }
  };
  const saveSettings = (patch: Partial<Settings>) => run(() => api('/api/quant/settings', { body: patch }), t('quant.saved'));

  if (!d || !form) return <PageHeader title={t('quant.title')} back="/" />;
  const chip = (on: boolean) => `rounded-full px-3 py-1 text-sm ${on ? 'bg-primary text-white' : 'bg-surface text-ink shadow-card'}`;
  const book = d.settings.live.enabled ? d.live : d.paper;
  const mode = d.settings.live.enabled ? 'live' : 'paper';
  const ret = ((book.equity - d.settings.risk.startBalance) / d.settings.risk.startBalance) * 100;
  const why = (w: string) => t(`quant.why.${w}` as MessageKey, {}) || w;
  const srcLabel = (s: string) => t(`quant.src.${s}` as MessageKey);

  return (
    <>
      <PageHeader
        title={t('quant.title')}
        back="/"
        actions={
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(() => api('/api/quant/step', { body: {} }))}
            className="inline-flex items-center gap-1 rounded-full px-3 py-1 text-sm text-primary-ink hover:bg-primary-soft disabled:opacity-50"
          >
            <ArrowClockwise16Regular aria-hidden /> {t('quant.stepNow')}
          </button>
        }
      />
      <main className="safe-bottom mx-auto max-w-3xl space-y-4 px-3">
        <div className="-mx-3 flex gap-2 overflow-x-auto px-3 pb-1 [scrollbar-width:none]" role="tablist">
          {TABS.map((x) => (
            <button key={x} type="button" role="tab" aria-selected={tab === x} className={`shrink-0 whitespace-nowrap ${chip(tab === x)}`} onClick={() => setTab(x)}>
              {t(`quant.tab.${x}` as MessageKey)}
            </button>
          ))}
        </div>
        {msg && <ErrorText>{msg}</ErrorText>}
        {d.lastError && <p className="text-xs text-danger">{d.lastError}</p>}

        {tab === 'overview' && (
          <>
            {/* 1. One sentence: what the bot is doing right now. */}
            <Card>
              <div className="flex items-start gap-3">
                <span className={`mt-1 size-3 shrink-0 rounded-full ${book.open.length ? 'bg-ok' : 'bg-primary'} animate-pulse`} aria-hidden />
                <div className="min-w-0">
                  <p className="text-base font-semibold text-heading">{book.open.length ? t('quant.h.holding', { n: book.open.length }) : t('quant.h.watching')}</p>
                  <p className="mt-0.5 text-sm text-muted">
                    {mode === 'live' ? t('quant.modeLive', { broker: d.settings.live.broker }) : t('quant.h.paperLine')}
                    {d.lastStep && ` · ${t('quant.h.checked', { when: formatRelative(d.lastStep.at) })}`}
                  </p>
                </div>
              </div>
            </Card>

            {/* 2. Money, in three plain numbers. */}
            <Card>
              <div className="grid grid-cols-3 gap-2 text-center">
                <div>
                  <div className="text-[11px] text-muted">{t('quant.h.balance')}</div>
                  <div className="text-lg font-semibold text-heading" dir="ltr">
                    {usd(book.equity)}
                  </div>
                </div>
                <div>
                  <div className="text-[11px] text-muted">{t('quant.h.sinceStart')}</div>
                  <div className={`text-lg font-semibold ${ret >= 0 ? 'text-ok' : 'text-danger'}`} dir="ltr">
                    {ret >= 0 ? '+' : ''}
                    {usd(book.equity - d.settings.risk.startBalance)}
                  </div>
                </div>
                <div>
                  <div className="text-[11px] text-muted">{t('quant.h.inMarket')}</div>
                  <div className="text-lg font-semibold text-heading" dir="ltr">
                    {book.equity > 0 ? `${Math.round((book.exposure / book.equity) * 100)}%` : '0%'}
                  </div>
                </div>
              </div>
              {book.perf.curve.length > 2 && (
                <div className="mt-3">
                  <Chart
                    data={[book.perf.curve.map((p) => Math.round(p.at / 1000)), book.perf.curve.map((p) => p.equity)]}
                    series={[{ label: 'USD', color: '#2f6fe4' }]}
                    height={120}
                    fmt={(v) => usd(v)}
                  />
                </div>
              )}
              <details className="mt-2 text-xs">
                <summary className="cursor-pointer text-muted">{t('quant.h.expert')}</summary>
                <div className="mt-2 grid grid-cols-4 gap-2">
                  <Stat label={t('quant.trades')} value={String(book.perf.trades)} />
                  <Stat label={t('quant.winRate')} value={`${(book.perf.winRate * 100).toFixed(0)}%`} />
                  <Stat label={t('quant.profitFactor')} value={Number.isFinite(book.perf.profitFactor) ? book.perf.profitFactor.toFixed(2) : '∞'} />
                  <Stat label={t('quant.drawdown')} value={`${book.perf.maxDrawdownPct.toFixed(1)}%`} tone={book.perf.maxDrawdownPct > 10 ? 'danger' : undefined} />
                  <Stat label={t('quant.sharpe')} value={book.perf.sharpe.toFixed(2)} />
                  <Stat label={t('quant.exposure')} value={usd(book.exposure)} />
                </div>
              </details>
            </Card>

            {/* 3. Each asset in one line of words: mood, how close to a buy, and why. */}
            <Card title={t('quant.h.market')}>
              <p className="mb-2 text-xs text-muted">{d.settings.strategy === 'regime' ? t('quant.h.marketHintRegime') : t('quant.h.marketHint')}</p>
              <ul className="space-y-3">
                {d.merged.map((m) => {
                  const q = d.quotes[m.asset];
                  const R = d.settings.risk;
                  const held = book.open.some((p) => p.asset === m.asset);
                  const techSig = d.signals.find((x) => x.asset === m.asset && x.source === 'technical');
                  const td = (techSig?.detail ? JSON.parse(techSig.detail) : {}) as { bull?: boolean; sma200?: number; ema20?: number; ema50?: number };
                  const regime = d.settings.strategy === 'regime';
                  const veto = d.settings.agentsVeto && m.vetoed;
                  const level = held
                    ? 'held'
                    : veto
                      ? 'veto'
                      : regime
                        ? td.bull
                          ? 'buy'
                          : q && td.sma200 && q.price > td.sma200
                            ? 'close'
                            : 'down'
                        : m.score >= R.entryScore
                          ? 'buy'
                          : m.score >= R.entryScore * 0.6
                            ? 'close'
                            : m.score > R.exitScore
                              ? 'neutral'
                              : 'down';
                  const tone = level === 'buy' || level === 'held' ? 'bg-ok' : level === 'close' ? 'bg-warn' : level === 'neutral' ? 'bg-muted' : 'bg-danger';
                  const progress = regime
                    ? td.bull
                      ? 1
                      : q && td.sma200 && td.ema20 && td.ema50
                        ? Math.max(0, Math.min(1, 0.5 * Math.min(1, q.price / td.sma200) + 0.5 * Math.min(1, td.ema20 / td.ema50)))
                        : 0
                    : Math.max(0, Math.min(1, (m.score - R.exitScore) / (R.entryScore - R.exitScore)));
                  const tech = m.parts.technical?.score ?? 0;
                  const ag = m.parts.agents;
                  const nw = m.parts.news;
                  const reasons = [
                    regime
                      ? td.bull
                        ? t('quant.h.regimeBull')
                        : q && td.sma200 && q.price > td.sma200
                          ? t('quant.h.regimeHalf')
                          : t('quant.h.regimeBear')
                      : tech > 0.2
                        ? t('quant.h.techUp')
                        : tech < -0.2
                          ? t('quant.h.techDown')
                          : t('quant.h.techFlat'),
                    ag ? (ag.score > 0.2 ? t('quant.h.aiBuy') : ag.score < -0.2 ? t('quant.h.aiSell') : t('quant.h.aiWait')) : null,
                    nw ? (nw.score > 0.15 ? t('quant.h.newsGood') : nw.score < -0.15 ? t('quant.h.newsBad') : t('quant.h.newsQuiet')) : null,
                  ].filter(Boolean);
                  return (
                    <li key={m.asset}>
                      <div className="flex items-center gap-2">
                        <span className={`size-2.5 shrink-0 rounded-full ${tone}`} aria-hidden />
                        <span className="w-12 font-semibold text-heading">{m.asset}</span>
                        <span className="flex-1 text-sm text-ink">{t(`quant.h.l.${level}` as MessageKey)}</span>
                        <span className="text-xs text-muted" dir="ltr">
                          {q ? px(q.price) : '—'}
                        </span>
                      </div>
                      <div className="mt-1 ms-5 flex items-center gap-2">
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-canvas" dir="ltr" aria-hidden>
                          <div className={`h-1.5 rounded-full ${tone}`} style={{ width: `${Math.round(progress * 100)}%` }} />
                        </div>
                        <span className="w-24 text-end text-[11px] text-muted">
                          {regime
                            ? held || td.bull
                              ? ''
                              : q && td.sma200 && q.price <= td.sma200
                                ? t('quant.h.belowAvg', { p: Math.round((1 - q.price / td.sma200) * 100) })
                                : t('quant.h.weakShort')
                            : t('quant.h.toBuy', { p: Math.round(progress * 100) })}
                        </span>
                      </div>
                      <p className="ms-5 mt-0.5 text-xs text-muted">{reasons.join(' · ')}</p>
                    </li>
                  );
                })}
              </ul>
            </Card>

            {/* 4. Open trades as a stop → now → target bar. */}
            {book.open.length > 0 && (
              <Card title={t('quant.open')}>
                <ul className="space-y-3">
                  {book.open.map((p) => {
                    const cur = d.quotes[p.asset]?.price ?? p.entry;
                    const u = (cur - p.entry) * p.qty;
                    const lo = p.stop;
                    const hi = p.target ?? Math.max(p.high * 1.05, p.entry * 1.1);
                    const pos = Math.max(0, Math.min(1, (cur - lo) / (hi - lo)));
                    return (
                      <li key={p.id}>
                        <div className="flex items-center justify-between text-sm">
                          <span className="font-semibold text-heading">
                            {p.asset} <span className="text-xs font-normal text-muted">{t('quant.h.boughtAt', { price: px(p.entry), when: formatRelative(p.opened_at) })}</span>
                          </span>
                          <span className={`font-semibold ${u >= 0 ? 'text-ok' : 'text-danger'}`} dir="ltr">
                            {u >= 0 ? '+' : ''}
                            {usd(u)}
                          </span>
                        </div>
                        <div className="relative mt-2 h-2 rounded-full bg-gradient-to-r from-danger via-canvas to-ok" dir="ltr" aria-hidden>
                          <span className="absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-surface bg-heading" style={{ left: `${pos * 100}%` }} />
                        </div>
                        <div className="mt-1 flex justify-between text-[11px] text-muted" dir="ltr">
                          <span>
                            {t('quant.h.stopAt')} {px(lo)}
                          </span>
                          <button type="button" disabled={busy} className="text-primary-ink" onClick={() => void run(() => api(`/api/quant/positions/${p.id}/close`, { body: {} }))}>
                            {t('quant.closeNow')}
                          </button>
                          <span>{p.target ? `${t('quant.h.targetAt')} ${px(hi)}` : t('quant.h.trailing', { pct: d.settings.regime.trailPct })}</span>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </Card>
            )}

            {/* 5. Today's story, in words. */}
            <Card title={t('quant.h.story')}>
              <ul className="space-y-1.5 text-sm">
                {book.closed.slice(0, 5).map((p) => (
                  <li key={`c${p.id}`} className="flex justify-between gap-2">
                    <span className="text-ink">{t('quant.h.closedLine', { asset: p.asset, why: why(p.reason ?? ''), when: formatRelative(p.closed_at ?? 0) })}</span>
                    <span className={(p.pnl ?? 0) >= 0 ? 'text-ok' : 'text-danger'} dir="ltr">
                      {(p.pnl ?? 0) >= 0 ? '+' : ''}
                      {usd(p.pnl ?? 0)}
                    </span>
                  </li>
                ))}
                {d.agents.runs
                  .filter((r) => r.status === 'done' || r.status === 'running')
                  .slice(0, 4)
                  .map((r) => (
                    <li key={r.id} className="text-ink">
                      {r.status === 'running'
                        ? t('quant.h.aiRunning', { asset: r.asset })
                        : t('quant.h.aiSaid', { asset: r.asset, rating: t(`quant.h.rating.${(r.rating ?? 'hold').toLowerCase()}` as MessageKey), when: formatRelative(r.finished_at ?? r.created_at) })}
                    </li>
                  ))}
                {d.lastStep && (
                  <li className="text-muted">
                    {d.lastStep.skipped.some((s) => s.why === 'daily_loss')
                      ? t('quant.h.pausedLoss')
                      : d.lastStep.skipped.some((s) => s.why === 'disabled')
                        ? t('quant.h.pausedOff')
                        : t('quant.h.noTradeWhy')}
                  </li>
                )}
                {book.closed.length === 0 && book.open.length === 0 && <li className="text-muted">{t('quant.h.fresh')}</li>}
              </ul>
            </Card>
          </>
        )}

        {tab === 'trades' && (
          <>
            <Card title={t('quant.l.holdings')}>
              {d.paper.open.length + d.futures.open.length === 0 && <p className="text-xs text-muted">{t('quant.noOpen')}</p>}
              <table className="w-full text-sm">
                <thead className="text-[11px] text-muted">
                  <tr>
                    <th className="text-start font-normal">{t('quant.l.what')}</th>
                    <th className="text-end font-normal">{t('quant.l.qty')}</th>
                    <th className="text-end font-normal">{t('quant.l.paid')}</th>
                    <th className="text-end font-normal">{t('quant.l.now')}</th>
                    <th className="text-end font-normal">{t('quant.l.pnl')}</th>
                  </tr>
                </thead>
                <tbody>
                  {d.paper.open.map((p) => {
                    const cur = d.quotes[p.asset]?.price ?? p.entry;
                    const u = (cur - p.entry) * p.qty;
                    return (
                      <tr key={`s${p.id}`} className="border-t border-line">
                        <td className="py-1.5 text-ink">
                          {p.asset} <span className="text-[11px] text-muted">{t('quant.l.spot')}</span>
                        </td>
                        <td className="text-end tabular-nums text-ink" dir="ltr">
                          {p.qty}
                        </td>
                        <td className="text-end tabular-nums text-ink" dir="ltr">
                          {usd(p.qty * p.entry)}
                        </td>
                        <td className="text-end tabular-nums text-ink" dir="ltr">
                          {usd(p.qty * cur)}
                        </td>
                        <td className={`text-end tabular-nums ${u >= 0 ? 'text-ok' : 'text-danger'}`} dir="ltr">
                          {u >= 0 ? '+' : ''}
                          {usd(u)}
                        </td>
                      </tr>
                    );
                  })}
                  {d.futures.open.map((p) => {
                    const pd = JSON.parse(p.detail ?? '{}') as { side: 1 | -1; leverage: number; margin: number; fundingAcc: number; entryFee: number };
                    const cur = d.futures.marks[p.asset]?.mark ?? p.entry;
                    const u = (cur - p.entry) * p.qty * pd.side - pd.fundingAcc - pd.entryFee;
                    return (
                      <tr key={`f${p.id}`} className="border-t border-line">
                        <td className="py-1.5 text-ink">
                          {p.asset}{' '}
                          <span className="text-[11px] text-muted">
                            {pd.side === 1 ? t('quant.f.long') : t('quant.f.short')} {pd.leverage}x
                          </span>
                        </td>
                        <td className="text-end tabular-nums text-ink" dir="ltr">
                          {p.qty}
                        </td>
                        <td className="text-end tabular-nums text-ink" dir="ltr">
                          {usd(pd.margin)}
                        </td>
                        <td className="text-end tabular-nums text-ink" dir="ltr">
                          {usd(pd.margin + u)}
                        </td>
                        <td className={`text-end tabular-nums ${u >= 0 ? 'text-ok' : 'text-danger'}`} dir="ltr">
                          {u >= 0 ? '+' : ''}
                          {usd(u)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="mt-2 text-xs text-muted">{t('quant.l.cash', { spot: usd(d.paper.cash), fut: usd(d.futures.cash) })}</p>
            </Card>
            <Card title={t('quant.l.ledger')}>
              {orders.length === 0 && <p className="text-xs text-muted">{t('quant.noTrades')}</p>}
              <ul className="divide-y divide-line text-sm">
                {orders.map((o) => {
                  const isFut = o.mode === 'futures';
                  const pd = isFut && o.pdetail ? (JSON.parse(o.pdetail) as { side: 1 | -1; leverage: number; margin: number }) : null;
                  const opening = o.reason === 'entry';
                  const verb = isFut
                    ? opening
                      ? o.side === 'buy'
                        ? t('quant.l.openedLong')
                        : t('quant.l.openedShort')
                      : t('quant.l.closed')
                    : o.side === 'buy'
                      ? t('quant.l.bought')
                      : t('quant.l.sold');
                  return (
                    <li key={o.id} className="py-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-ink">
                          <span className={`me-1 inline-block size-2 rounded-full ${o.side === 'buy' ? 'bg-ok' : 'bg-danger'}`} aria-hidden />
                          {verb}{' '}
                          <b>
                            {o.qty} {o.asset}
                          </b>{' '}
                          {t('quant.l.at')} <span dir="ltr">{px(o.price)}</span>
                          {isFut && pd ? ` · ${pd.leverage}x` : ''}
                        </span>
                        <span className="shrink-0 text-xs text-muted">{formatRelative(o.at)}</span>
                      </div>
                      <div className="ms-3 flex justify-between text-xs text-muted" dir="ltr">
                        <span>{isFut && pd ? `${t('quant.l.margin')} ${usd(pd.margin)} · ${t('quant.l.size')} ${usd(o.notional)}` : `= ${usd(o.notional)}`}</span>
                        {!opening && o.pnl !== null && (
                          <span className={o.pnl >= 0 ? 'text-ok' : 'text-danger'}>
                            {t(`quant.why.${o.reason}` as MessageKey) || t(`quant.f.r.${o.reason}` as MessageKey)} · {o.pnl >= 0 ? '+' : ''}
                            {usd(o.pnl)}
                          </span>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </Card>
          </>
        )}

        {tab === 'futures' && (
          <>
            {(() => {
              const F = d.futures;
              const fret = ((F.equity - F.settings.startBalance) / F.settings.startBalance) * 100;
              return (
                <>
                  <Card>
                    <div className="flex items-start gap-3">
                      <span className={`mt-1 size-3 shrink-0 rounded-full ${F.open.length ? 'bg-ok' : 'bg-primary'} animate-pulse`} aria-hidden />
                      <div className="min-w-0">
                        <p className="text-base font-semibold text-heading">{F.open.length ? t('quant.f.holding', { n: F.open.length }) : t('quant.f.watching')}</p>
                        <p className="mt-0.5 text-sm text-muted">{t('quant.f.line', { tf: F.settings.tf, lev: F.settings.leverage })}</p>
                      </div>
                    </div>
                  </Card>
                  <Card>
                    <div className="grid grid-cols-3 gap-2 text-center">
                      <div>
                        <div className="text-[11px] text-muted">{t('quant.h.balance')}</div>
                        <div className="text-lg font-semibold text-heading" dir="ltr">
                          {usd(F.equity)}
                        </div>
                      </div>
                      <div>
                        <div className="text-[11px] text-muted">{t('quant.h.sinceStart')}</div>
                        <div className={`text-lg font-semibold ${fret >= 0 ? 'text-ok' : 'text-danger'}`} dir="ltr">
                          {fret >= 0 ? '+' : ''}
                          {usd(F.equity - F.settings.startBalance)}
                        </div>
                      </div>
                      <div>
                        <div className="text-[11px] text-muted">{t('quant.f.margin')}</div>
                        <div className="text-lg font-semibold text-heading" dir="ltr">
                          {usd(F.exposure)}
                        </div>
                      </div>
                    </div>
                    {F.perf.curve.length > 2 && (
                      <div className="mt-3">
                        <Chart
                          data={[F.perf.curve.map((p) => Math.round(p.at / 1000)), F.perf.curve.map((p) => p.equity)]}
                          series={[{ label: 'USD', color: '#d97706' }]}
                          height={120}
                          fmt={(v) => usd(v)}
                        />
                      </div>
                    )}
                    <details className="mt-2 text-xs">
                      <summary className="cursor-pointer text-muted">{t('quant.h.expert')}</summary>
                      <div className="mt-2 grid grid-cols-4 gap-2">
                        <Stat label={t('quant.trades')} value={String(F.perf.trades)} />
                        <Stat label={t('quant.winRate')} value={`${(F.perf.winRate * 100).toFixed(0)}%`} />
                        <Stat label={t('quant.profitFactor')} value={Number.isFinite(F.perf.profitFactor) ? F.perf.profitFactor.toFixed(2) : '∞'} />
                        <Stat label={t('quant.drawdown')} value={`${F.perf.maxDrawdownPct.toFixed(1)}%`} />
                      </div>
                      {F.lastError && <p className="mt-1 text-danger">{F.lastError}</p>}
                    </details>
                  </Card>
                  <Card title={t('quant.h.market')}>
                    <p className="mb-2 text-xs text-muted">{t('quant.f.marketHint', { tf: F.settings.tf })}</p>
                    <ul className="space-y-3">
                      {F.settings.assets.map((a) => {
                        const r = F.regimes[a];
                        const m = F.marks[a];
                        const pos = F.open.find((p) => p.asset === a);
                        const pd = pos ? (JSON.parse(pos.detail ?? '{}') as { side: 1 | -1 }) : null;
                        const level = pos ? (pd?.side === 1 ? 'long' : 'short') : !r ? 'wait' : r.signal === 1 ? 'bull' : r.signal === -1 ? 'bear' : 'flat';
                        const tone = level === 'long' || level === 'bull' ? 'bg-ok' : level === 'short' || level === 'bear' ? 'bg-danger' : 'bg-muted';
                        return (
                          <li key={a}>
                            <div className="flex items-center gap-2">
                              <span className={`size-2.5 shrink-0 rounded-full ${tone}`} aria-hidden />
                              <span className="w-12 font-semibold text-heading">{a}</span>
                              <span className="flex-1 text-sm text-ink">{t(`quant.f.l.${level}` as MessageKey)}</span>
                              <span className="text-xs text-muted" dir="ltr">
                                {m ? px(m.mark) : '—'}
                              </span>
                            </div>
                            {r && (
                              <p className="ms-5 mt-0.5 text-xs text-muted" dir="ltr">
                                {`EMA${F.settings.tf === '4h' ? '' : ''} ${r.emaFast > r.emaSlow ? '20 > 50' : '20 < 50'} · ${r.close > r.emaTrend ? t('quant.f.aboveTrend') : t('quant.f.belowTrend')}${m ? ` · ${t('quant.f.funding', { r: (m.fundingRate * 100).toFixed(3) })}` : ''}`}
                              </p>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </Card>
                  {F.open.length > 0 && (
                    <Card title={t('quant.open')}>
                      <ul className="space-y-3">
                        {F.open.map((p) => {
                          const pd = JSON.parse(p.detail ?? '{}') as { side: 1 | -1; leverage: number; margin: number; liq: number; fundingAcc: number; entryFee: number };
                          const cur = F.marks[p.asset]?.mark ?? p.entry;
                          const u = (cur - p.entry) * p.qty * pd.side - pd.fundingAcc - pd.entryFee;
                          const lo = pd.side === 1 ? p.stop : p.high;
                          const hi = pd.side === 1 ? p.high : p.stop;
                          const pos = hi > lo ? Math.max(0, Math.min(1, (cur - lo) / (hi - lo))) : 0.5;
                          return (
                            <li key={p.id}>
                              <div className="flex items-center justify-between text-sm">
                                <span className="font-semibold text-heading">
                                  {pd.side === 1 ? '🟢' : '🔴'} {p.asset} {pd.side === 1 ? t('quant.f.long') : t('quant.f.short')} {pd.leverage}x{' '}
                                  <span className="text-xs font-normal text-muted">{formatRelative(p.opened_at)}</span>
                                </span>
                                <span className={`font-semibold ${u >= 0 ? 'text-ok' : 'text-danger'}`} dir="ltr">
                                  {u >= 0 ? '+' : ''}
                                  {usd(u)} ({((u / pd.margin) * 100).toFixed(1)}%)
                                </span>
                              </div>
                              <div className="relative mt-2 h-2 rounded-full bg-gradient-to-r from-danger via-canvas to-ok" dir="ltr" aria-hidden>
                                <span
                                  className="absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-surface bg-heading"
                                  style={{ left: `${(pd.side === 1 ? pos : 1 - pos) * 100}%` }}
                                />
                              </div>
                              <div className="mt-1 flex justify-between text-[11px] text-muted" dir="ltr">
                                <span>
                                  {t('quant.f.stopAt')} {px(p.stop)} · {t('quant.f.liqAt')} {px(pd.liq)}
                                </span>
                                <button type="button" disabled={busy} className="text-primary-ink" onClick={() => void run(() => api(`/api/quant/futures/positions/${p.id}/close`, { body: {} }))}>
                                  {t('quant.closeNow')}
                                </button>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    </Card>
                  )}
                  <Card title={t('quant.h.story')}>
                    <ul className="space-y-1.5 text-sm">
                      {F.closed.slice(0, 12).map((p) => {
                        const pd = JSON.parse(p.detail ?? '{}') as { side: 1 | -1; margin: number };
                        return (
                          <li key={p.id} className="flex justify-between gap-2">
                            <span className="text-ink">
                              {pd.side === 1 ? t('quant.f.long') : t('quant.f.short')} {p.asset} · {t(`quant.f.r.${p.reason ?? 'flip'}` as MessageKey)} · {formatRelative(p.closed_at ?? 0)}
                            </span>
                            <span className={(p.pnl ?? 0) >= 0 ? 'text-ok' : 'text-danger'} dir="ltr">
                              {(p.pnl ?? 0) >= 0 ? '+' : ''}
                              {usd(p.pnl ?? 0)}
                            </span>
                          </li>
                        );
                      })}
                      {F.closed.length === 0 && <li className="text-muted">{t('quant.f.fresh', { tf: F.settings.tf })}</li>}
                    </ul>
                  </Card>
                  <Card title={t('quant.f.settings')}>
                    <div className="grid grid-cols-2 gap-2">
                      <label className="block">
                        <span className="mb-1 block text-sm font-medium text-ink">{t('quant.f.tf')}</span>
                        <select
                          value={form.futures.tf}
                          onChange={(e) => setForm({ ...form, futures: { ...form.futures, tf: e.target.value as '1h' | '4h' } })}
                          className="block min-h-12 w-full rounded-xl border border-line bg-surface px-3 text-base text-ink"
                        >
                          <option value="4h">4h ({t('quant.f.tested')})</option>
                          <option value="1h">1h</option>
                        </select>
                      </label>
                      <Num label={t('quant.f.leverage')} value={form.futures.leverage} onChange={(v) => setForm({ ...form, futures: { ...form.futures, leverage: v } })} />
                      <Num label={t('quant.f.marginPct')} value={form.futures.marginPct} onChange={(v) => setForm({ ...form, futures: { ...form.futures, marginPct: v } })} />
                      <Num label={t('quant.f.trailAtr')} value={form.futures.trailAtr} onChange={(v) => setForm({ ...form, futures: { ...form.futures, trailAtr: v } })} />
                    </div>
                    <div className="mt-2 space-y-2">
                      <Toggle label={t('quant.f.enabled')} on={form.futures.enabled} onChange={(v) => setForm({ ...form, futures: { ...form.futures, enabled: v } })} />
                      <Toggle label={t('quant.f.allowShort')} on={form.futures.allowShort} onChange={(v) => setForm({ ...form, futures: { ...form.futures, allowShort: v } })} />
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {d.markets
                        .filter((a) => a !== 'GOLD')
                        .map((a) => (
                          <button
                            key={a}
                            type="button"
                            className={chip(form.futures.assets.includes(a))}
                            onClick={() =>
                              setForm({ ...form, futures: { ...form.futures, assets: form.futures.assets.includes(a) ? form.futures.assets.filter((x) => x !== a) : [...form.futures.assets, a] } })
                            }
                          >
                            {a}
                          </button>
                        ))}
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button disabled={busy} onClick={() => void saveSettings({ futures: form.futures })}>
                        {t('quant.save')}
                      </Button>
                      <Button variant="secondary" disabled={busy} onClick={() => void run(() => api('/api/quant/futures/backtest', { body: { start: bt.start, end: bt.end } }), t('quant.f.testDone'))}>
                        {t('quant.f.test')}
                      </Button>
                      <Button
                        variant="danger"
                        disabled={busy}
                        onClick={async () => {
                          if (await ask({ title: t('quant.f.reset'), body: <p>{t('quant.resetPaperBody')}</p>, confirmLabel: t('quant.f.reset'), danger: true }))
                            await run(() => api('/api/quant/futures/reset', { body: {} }));
                        }}
                      >
                        {t('quant.f.reset')}
                      </Button>
                    </div>
                    <p className="mt-2 text-xs text-muted">{t('quant.f.evidence')}</p>
                  </Card>
                </>
              );
            })()}
          </>
        )}

        {tab === 'signals' && (
          <Card title={t('quant.tab.signals')}>
            <p className="mb-2 text-xs text-muted">{t('quant.signalsHint', { t: form.weights.technical, a: form.weights.agents, n: form.weights.news })}</p>
            <ul className="divide-y divide-line">
              {d.signals.map((s) => {
                const det = (s.detail ? (JSON.parse(s.detail) as Record<string, unknown>) : {}) as Record<string, unknown>;
                return (
                  <li key={s.id} className="py-2 text-sm">
                    <div className="flex items-center justify-between">
                      <span className="text-ink">
                        {s.asset} · {srcLabel(s.source)}
                      </span>
                      <span className={`tabular-nums ${s.score > 0 ? 'text-ok' : s.score < 0 ? 'text-danger' : 'text-muted'}`} dir="ltr">
                        {s.score.toFixed(2)} × {s.confidence.toFixed(2)}
                      </span>
                    </div>
                    <div className="text-xs text-muted">
                      {formatRelative(s.at)} · {t('quant.expires', { when: formatRelative(s.expires_at) })}
                      {s.source === 'technical' && ` · RSI ${String(det.rsi)} · ATR ${String(det.atrPct)}%`}
                      {s.source === 'agents' && ` · ${String(det.rating ?? '')}`}
                      {s.source === 'news' && ` · ${(det.drivers as string[] | undefined)?.join(' / ') ?? ''}`}
                    </div>
                  </li>
                );
              })}
            </ul>
          </Card>
        )}

        {tab === 'agents' && (
          <>
            <Card
              title={t('quant.tab.agents')}
              action={
                <div className="flex gap-2">
                  {form.assets.map((a) => (
                    <button
                      key={a}
                      type="button"
                      disabled={busy || !d.agents.alive}
                      className="rounded-full bg-primary-soft px-2 py-1 text-xs text-primary-ink disabled:opacity-50"
                      onClick={() => void run(() => api('/api/quant/agents/run', { body: { asset: a, force: true } }))}
                    >
                      {t('quant.debate', { asset: a })}
                    </button>
                  ))}
                </div>
              }
            >
              <p className="text-xs text-muted">
                {!d.agents.installed
                  ? t('quant.agentsOff')
                  : d.agents.alive
                    ? t('quant.agentsOn', { quick: d.agents.route?.quick ?? '—', deep: d.agents.route?.deep ?? '—' })
                    : t('quant.agentsStarting')}
                {d.agents.error && ` · ${d.agents.error}`}
              </p>
              <ul className="mt-2 divide-y divide-line">
                {d.agents.runs.map((r) => (
                  <li key={r.id} className="py-2 text-sm">
                    <button type="button" className="flex w-full items-center justify-between text-start" onClick={() => setOpenRun(openRun?.id === r.id ? null : r)}>
                      <span className="text-ink">
                        {r.asset} · {r.day} <span className="text-xs text-muted">{t(`quant.run.${r.status}` as MessageKey)}</span>
                      </span>
                      <span className={`font-medium ${(r.score ?? 0) > 0 ? 'text-ok' : (r.score ?? 0) < 0 ? 'text-danger' : 'text-muted'}`}>{r.rating ?? (r.error ? '!' : '…')}</span>
                    </button>
                    {openRun?.id === r.id && (
                      <div className="mt-2 space-y-2 text-xs">
                        {r.error && <p className="text-danger">{r.error}</p>}
                        {r.reports &&
                          Object.entries(JSON.parse(r.reports) as Record<string, string>)
                            .filter(([, v]) => v)
                            .map(([k, v]) => (
                              <details key={k} className="rounded-xl bg-canvas p-2">
                                <summary className="cursor-pointer font-medium text-ink">{t(`quant.report.${k}` as MessageKey)}</summary>
                                <pre className="mt-1 whitespace-pre-wrap font-sans text-ink" dir="ltr">
                                  {v}
                                </pre>
                              </details>
                            ))}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          </>
        )}

        {tab === 'backtests' && (
          <>
            <Card title={t('quant.lean')}>
              <p className="text-xs text-muted">
                {d.lean.installed
                  ? t('quant.leanOn', {
                      data:
                        Object.entries(d.lean.data ?? {})
                          .map(([k, v]) => `${k} → ${v.last ?? '?'}`)
                          .join(', ') || '—',
                    })
                  : t('quant.leanOff')}
              </p>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <TextField label={t('quant.from')} type="date" value={bt.start} onChange={(e) => setBt({ ...bt, start: e.target.value })} />
                <TextField label={t('quant.to')} type="date" value={bt.end} onChange={(e) => setBt({ ...bt, end: e.target.value })} />
                <Num label={t('quant.trainDays')} value={bt.trainDays} onChange={(v) => setBt({ ...bt, trainDays: v })} />
                <Num label={t('quant.testDays')} value={bt.testDays} onChange={(v) => setBt({ ...bt, testDays: v })} />
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button disabled={busy || !d.lean.installed} onClick={() => void run(() => api('/api/quant/lean/backtest', { body: { start: bt.start, end: bt.end } }), t('quant.queued'))}>
                  {t('quant.backtest')}
                </Button>
                <Button
                  variant="secondary"
                  disabled={busy || !d.lean.installed}
                  onClick={() => void run(() => api('/api/quant/lean/walkforward', { body: { start: bt.start, end: bt.end, trainDays: bt.trainDays, testDays: bt.testDays } }), t('quant.queued'))}
                >
                  {t('quant.walkforward')}
                </Button>
                <Button variant="ghost" disabled={busy || !d.lean.installed} onClick={() => void run(() => api('/api/quant/lean/data', { body: {} }), t('quant.queued'))}>
                  {t('quant.refreshData')}
                </Button>
              </div>
            </Card>
            <Card title={t('quant.runs')}>
              <ul className="divide-y divide-line">
                {d.lean.runs.map((r) => {
                  const st = (r.stats ?? {}) as Record<string, string>;
                  return (
                    <li key={r.id} className="py-2 text-sm">
                      <button
                        type="button"
                        className="flex w-full items-center justify-between text-start"
                        onClick={() => {
                          if (leanRun?.id === r.id) return setLeanRun(null);
                          api<LeanRun & { equity: [number, number][] }>(`/api/quant/lean/runs/${r.id}`)
                            .then(setLeanRun)
                            .catch(() => undefined);
                        }}
                      >
                        <span className="text-ink">
                          #{r.id} {t(`quant.kind.${r.kind}` as MessageKey)}{' '}
                          <span className="text-xs text-muted">
                            {String(r.params?.start ?? '')}→{String(r.params?.end ?? '')} · {t(`quant.run.${r.status}` as MessageKey)}
                          </span>
                        </span>
                        <span className={`tabular-nums ${String(st['Net Profit'] ?? '').startsWith('-') ? 'text-danger' : 'text-ok'}`} dir="ltr">
                          {st['Net Profit'] ?? (r.status === 'running' ? r.log?.slice(0, 40) : '')}
                        </span>
                      </button>
                      {leanRun?.id === r.id && (
                        <div className="mt-2 space-y-2 text-xs">
                          {leanRun.equity.length > 2 && (
                            <Chart
                              data={[leanRun.equity.map((p) => Math.round(p[0] / 1000)), leanRun.equity.map((p) => p[1])]}
                              series={[{ label: 'USD', color: '#7c3aed' }]}
                              height={160}
                              fmt={(v) => usd(v)}
                            />
                          )}
                          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-ink" dir="ltr">
                            {[
                              'Net Profit',
                              'Compounding Annual Return',
                              'Sharpe Ratio',
                              'Sortino Ratio',
                              'Drawdown',
                              'Win Rate',
                              'Profit-Loss Ratio',
                              'Total Fees',
                              'orders',
                              'windows',
                              'Win Windows',
                              'Avg OOS Sharpe',
                              'Worst Drawdown',
                            ]
                              .filter((k) => st[k] !== undefined)
                              .map((k) => (
                                <div key={k} className="flex justify-between gap-2">
                                  <dt className="text-muted">{k}</dt>
                                  <dd>{String(st[k])}</dd>
                                </div>
                              ))}
                          </dl>
                          {Array.isArray((leanRun.stats as Record<string, unknown>)?.perWindow) && (
                            <table className="w-full text-[11px]" dir="ltr">
                              <thead className="text-muted">
                                <tr>
                                  <th className="text-start">test</th>
                                  <th>params</th>
                                  <th>net</th>
                                  <th>sharpe</th>
                                  <th>dd</th>
                                </tr>
                              </thead>
                              <tbody>
                                {(
                                  (leanRun.stats as { perWindow: { window: { testStart: string; testEnd: string }; best: Record<string, number>; test: Record<string, string> }[] }).perWindow ?? []
                                ).map((w) => (
                                  <tr key={w.window.testStart}>
                                    <td>
                                      {w.window.testStart}→{w.window.testEnd}
                                    </td>
                                    <td className="text-center">{Object.values(w.best).join('/')}</td>
                                    <td className="text-center">{w.test['Net Profit']}</td>
                                    <td className="text-center">{w.test['Sharpe Ratio']}</td>
                                    <td className="text-center">{w.test.Drawdown}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                          {r.status === 'error' && <pre className="whitespace-pre-wrap text-danger">{r.log}</pre>}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </Card>
          </>
        )}

        {tab === 'risk' && (
          <>
            <Card title={t('quant.riskTitle')}>
              <p className="mb-2 text-xs text-muted">{t('quant.riskHint')}</p>
              <div className="grid grid-cols-2 gap-2">
                <Num label={t('quant.r.startBalance')} value={form.risk.startBalance} step={100} onChange={(v) => setForm({ ...form, risk: { ...form.risk, startBalance: v } })} />
                <Num label={t('quant.r.riskPct')} value={form.risk.riskPct} step={0.1} onChange={(v) => setForm({ ...form, risk: { ...form.risk, riskPct: v } })} />
                <Num label={t('quant.r.maxPositionPct')} value={form.risk.maxPositionPct} onChange={(v) => setForm({ ...form, risk: { ...form.risk, maxPositionPct: v } })} />
                <Num label={t('quant.r.maxExposurePct')} value={form.risk.maxExposurePct} onChange={(v) => setForm({ ...form, risk: { ...form.risk, maxExposurePct: v } })} />
                <Num label={t('quant.r.maxOpen')} value={form.risk.maxOpen} onChange={(v) => setForm({ ...form, risk: { ...form.risk, maxOpen: v } })} />
                <Num label={t('quant.r.stopAtr')} value={form.risk.stopAtr} step={0.5} onChange={(v) => setForm({ ...form, risk: { ...form.risk, stopAtr: v } })} />
                <Num label={t('quant.r.takeProfitR')} value={form.risk.takeProfitR} step={0.5} onChange={(v) => setForm({ ...form, risk: { ...form.risk, takeProfitR: v } })} />
                <Num label={t('quant.r.trailAtr')} value={form.risk.trailAtr} step={0.5} onChange={(v) => setForm({ ...form, risk: { ...form.risk, trailAtr: v } })} />
                <Num label={t('quant.r.dailyLossPct')} value={form.risk.dailyLossPct} step={0.5} onChange={(v) => setForm({ ...form, risk: { ...form.risk, dailyLossPct: v } })} />
                <Num label={t('quant.r.maxHoldDays')} value={form.risk.maxHoldDays} onChange={(v) => setForm({ ...form, risk: { ...form.risk, maxHoldDays: v } })} />
                <Num label={t('quant.r.cooldownMin')} value={form.risk.cooldownMin} step={30} onChange={(v) => setForm({ ...form, risk: { ...form.risk, cooldownMin: v } })} />
                <Num label={t('quant.r.entryScore')} value={form.risk.entryScore} step={0.05} onChange={(v) => setForm({ ...form, risk: { ...form.risk, entryScore: v } })} />
                <Num label={t('quant.r.exitScore')} value={form.risk.exitScore} step={0.05} onChange={(v) => setForm({ ...form, risk: { ...form.risk, exitScore: v } })} />
                <Num label={t('quant.r.maxSourceGapPct')} value={form.risk.maxSourceGapPct} step={0.5} onChange={(v) => setForm({ ...form, risk: { ...form.risk, maxSourceGapPct: v } })} />
              </div>
              <h3 className="mt-3 text-sm font-medium text-ink">{t('quant.strategy')}</h3>
              <div className="flex flex-wrap gap-2">
                {(['regime', 'rules'] as const).map((k) => (
                  <button key={k} type="button" className={chip(form.strategy === k)} onClick={() => setForm({ ...form, strategy: k })}>
                    {t(`quant.strategy.${k}` as MessageKey)}
                  </button>
                ))}
              </div>
              <p className="mt-1 text-xs text-muted">{t(`quant.strategy.${form.strategy}.desc` as MessageKey)}</p>
              {form.strategy === 'regime' && (
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <Num label={t('quant.regime.trailPct')} value={form.regime.trailPct} onChange={(v) => setForm({ ...form, regime: { ...form.regime, trailPct: v } })} />
                  <Num label={t('quant.regime.cooldownDays')} value={form.regime.cooldownDays} onChange={(v) => setForm({ ...form, regime: { ...form.regime, cooldownDays: v } })} />
                </div>
              )}
              <div className="mt-2">
                <Toggle label={t('quant.agentsVeto')} on={form.agentsVeto} onChange={(v) => setForm({ ...form, agentsVeto: v })} />
              </div>
              <h3 className="mt-3 text-sm font-medium text-ink">{t('quant.weights')}</h3>
              <div className="grid grid-cols-3 gap-2">
                <Num label={t('quant.src.technical')} value={form.weights.technical} step={0.1} onChange={(v) => setForm({ ...form, weights: { ...form.weights, technical: v } })} />
                <Num label={t('quant.src.agents')} value={form.weights.agents} step={0.1} onChange={(v) => setForm({ ...form, weights: { ...form.weights, agents: v } })} />
                <Num label={t('quant.src.news')} value={form.weights.news} step={0.1} onChange={(v) => setForm({ ...form, weights: { ...form.weights, news: v } })} />
              </div>
              <h3 className="mt-3 text-sm font-medium text-ink">{t('quant.assets')}</h3>
              <div className="flex flex-wrap gap-2">
                {d.markets.map((a) => (
                  <button
                    key={a}
                    type="button"
                    className={chip(form.assets.includes(a))}
                    onClick={() => setForm({ ...form, assets: form.assets.includes(a) ? form.assets.filter((x) => x !== a) : [...form.assets, a] })}
                  >
                    {a}
                  </button>
                ))}
              </div>
              <div className="mt-3 space-y-2">
                <Toggle label={t('quant.paperEnabled')} on={form.paperEnabled} onChange={(v) => setForm({ ...form, paperEnabled: v })} />
                <Toggle label={t('quant.agentsEnabled')} on={form.agentsEnabled} onChange={(v) => setForm({ ...form, agentsEnabled: v })} />
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <Num label={t('quant.agentsHour')} value={form.agentsHourUtc} onChange={(v) => setForm({ ...form, agentsHourUtc: v })} />
                <Num label={t('quant.agentsCap')} value={form.agentsDailyCap} onChange={(v) => setForm({ ...form, agentsDailyCap: v })} />
              </div>
              <div className="mt-3 flex gap-2">
                <Button
                  disabled={busy}
                  onClick={() =>
                    void saveSettings({
                      risk: form.risk,
                      weights: form.weights,
                      assets: form.assets,
                      paperEnabled: form.paperEnabled,
                      agentsEnabled: form.agentsEnabled,
                      agentsHourUtc: form.agentsHourUtc,
                      agentsDailyCap: form.agentsDailyCap,
                    })
                  }
                >
                  {t('quant.save')}
                </Button>
                <Button
                  variant="danger"
                  disabled={busy}
                  onClick={async () => {
                    if (await ask({ title: t('quant.resetPaper'), body: <p>{t('quant.resetPaperBody')}</p>, confirmLabel: t('quant.resetPaper'), danger: true }))
                      await run(() => api('/api/quant/paper/reset', { body: {} }));
                  }}
                >
                  {t('quant.resetPaper')}
                </Button>
              </div>
            </Card>

            <Card title={t('quant.models')}>
              <p className="mb-2 text-xs text-muted">{t('quant.modelsHint')}</p>
              <div className="grid grid-cols-2 gap-2">
                <TextField
                  label={t('quant.quickModel')}
                  value={form.routing.quick.model}
                  onChange={(e) => setForm({ ...form, routing: { ...form.routing, quick: { ...form.routing.quick, model: e.target.value } } })}
                />
                <label className="block">
                  <span className="mb-1 block text-sm font-medium text-ink">{t('quant.provider')}</span>
                  <select
                    value={form.routing.quick.provider}
                    onChange={(e) => setForm({ ...form, routing: { ...form.routing, quick: { ...form.routing.quick, provider: e.target.value } } })}
                    className="block min-h-12 w-full rounded-xl border border-line bg-surface px-3 text-base text-ink"
                  >
                    {['anthropic', 'openai', 'ollama'].map((p) => (
                      <option key={p}>{p}</option>
                    ))}
                  </select>
                </label>
                <TextField
                  label={t('quant.deepModel')}
                  value={form.routing.deep.model}
                  onChange={(e) => setForm({ ...form, routing: { ...form.routing, deep: { ...form.routing.deep, model: e.target.value } } })}
                />
                <label className="block">
                  <span className="mb-1 block text-sm font-medium text-ink">{t('quant.provider')}</span>
                  <select
                    value={form.routing.deep.provider}
                    onChange={(e) => setForm({ ...form, routing: { ...form.routing, deep: { ...form.routing.deep, provider: e.target.value } } })}
                    className="block min-h-12 w-full rounded-xl border border-line bg-surface px-3 text-base text-ink"
                  >
                    {['anthropic', 'openai', 'ollama'].map((p) => (
                      <option key={p}>{p}</option>
                    ))}
                  </select>
                </label>
                <TextField
                  label={`Anthropic ${t('quant.apiKey')} ${d.settings.keys.anthropic ? '✓' : ''}`}
                  type="password"
                  autoComplete="off"
                  value={keys.anthropic}
                  onChange={(e) => setKeys({ ...keys, anthropic: e.target.value })}
                />
                <TextField
                  label={`OpenAI ${t('quant.apiKey')} ${d.settings.keys.openai ? '✓' : ''}`}
                  type="password"
                  autoComplete="off"
                  value={keys.openai}
                  onChange={(e) => setKeys({ ...keys, openai: e.target.value })}
                />
                <TextField label="Ollama URL" value={form.ollamaUrl} onChange={(e) => setForm({ ...form, ollamaUrl: e.target.value })} />
              </div>
              <Button
                className="mt-2"
                disabled={busy}
                onClick={() => {
                  const k: Record<string, string> = {};
                  if (keys.anthropic) k.anthropic = keys.anthropic;
                  if (keys.openai) k.openai = keys.openai;
                  void saveSettings({ routing: form.routing, ollamaUrl: form.ollamaUrl, ...(Object.keys(k).length ? { keys: k as never } : {}) }).then(() =>
                    setKeys({ ...keys, anthropic: '', openai: '' }),
                  );
                }}
              >
                {t('quant.save')}
              </Button>
            </Card>

            <Card title={t('quant.liveTitle')}>
              <p className={`mb-2 rounded-xl px-3 py-2 text-xs ${d.settings.live.enabled ? 'bg-danger/10 text-danger' : 'bg-canvas text-muted'}`}>
                {d.settings.live.enabled ? t('quant.liveOn', { broker: d.settings.live.broker, max: usd(d.settings.live.maxNotionalUsd) }) : t('quant.liveOff')}
                {d.settings.live.killSwitch && ` · ${t('quant.killOn')}`}
              </p>
              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className="mb-1 block text-sm font-medium text-ink">{t('quant.broker')}</span>
                  <select
                    value={keys.broker}
                    onChange={(e) => setKeys({ ...keys, broker: e.target.value })}
                    className="block min-h-12 w-full rounded-xl border border-line bg-surface px-3 text-base text-ink"
                  >
                    <option value="binance-testnet">Binance testnet ({t('quant.fake')})</option>
                    <option value="binance">Binance ({t('quant.real')})</option>
                  </select>
                </label>
                <Num label={t('quant.maxNotional')} value={keys.maxNotionalUsd} step={10} onChange={(v) => setKeys({ ...keys, maxNotionalUsd: v })} />
                <TextField
                  label={`API key ${d.live.status.keysFor.includes(keys.broker) ? '✓' : ''}`}
                  type="password"
                  autoComplete="off"
                  value={keys.key}
                  onChange={(e) => setKeys({ ...keys, key: e.target.value })}
                />
                <TextField label="API secret" type="password" autoComplete="off" value={keys.secret} onChange={(e) => setKeys({ ...keys, secret: e.target.value })} />
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  disabled={busy || !keys.key || !keys.secret}
                  onClick={() =>
                    void run(() => api('/api/quant/live/keys', { body: { broker: keys.broker, key: keys.key, secret: keys.secret } }), t('quant.keysOk')).then(() =>
                      setKeys({ ...keys, key: '', secret: '' }),
                    )
                  }
                >
                  {t('quant.saveKeys')}
                </Button>
                {d.settings.live.enabled ? (
                  <Button variant="danger" disabled={busy} onClick={() => void run(() => api('/api/quant/live/stop', { body: { killSwitch: true } }))}>
                    {t('quant.kill')}
                  </Button>
                ) : (
                  <>
                    <TextField label={t('quant.phrase', { phrase: PHRASE })} value={keys.phrase} onChange={(e) => setKeys({ ...keys, phrase: e.target.value })} />
                    <Button
                      variant="danger"
                      disabled={busy || keys.phrase !== PHRASE || !d.live.status.keysFor.includes(keys.broker)}
                      onClick={async () => {
                        if (
                          await ask({
                            title: t('quant.authorize'),
                            body: <p>{t('quant.authorizeBody', { broker: keys.broker, max: usd(keys.maxNotionalUsd) })}</p>,
                            confirmLabel: t('quant.authorize'),
                            danger: true,
                          })
                        )
                          await run(() => api('/api/quant/live/authorize', { body: { broker: keys.broker, phrase: keys.phrase, maxNotionalUsd: keys.maxNotionalUsd } }));
                      }}
                    >
                      {t('quant.authorize')}
                    </Button>
                  </>
                )}
              </div>
            </Card>
          </>
        )}

        {tab === 'audit' && (
          <Card title={t('quant.tab.audit')}>
            <ul className="divide-y divide-line text-xs">
              {auditRows.map((r, i) => (
                <li key={i} className="py-1.5">
                  <span className="font-medium text-ink">{r.action.replace('quant_', '')}</span> <span className="text-muted">{formatRelative(r.ts)}</span>
                  {r.detail && (
                    <pre className="mt-0.5 whitespace-pre-wrap text-muted" dir="ltr">
                      {r.detail.slice(0, 300)}
                    </pre>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        )}
      </main>
    </>
  );
}
