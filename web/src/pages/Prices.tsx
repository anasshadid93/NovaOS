import { useEffect, useMemo, useState } from 'react';
import { ArrowClockwise16Regular, ArrowDown16Filled, ArrowUp16Filled, Checkmark16Filled, Open16Regular, Subtract16Filled } from '@fluentui/react-icons';
import { ApiError, api } from '../lib/api';
import { useI18n, type MessageKey } from '../i18n';
import { useConfirm } from '../components/ConfirmProvider';
import { Button, Card, ErrorText, PageHeader, TextField } from '../components/ui';
import { Chart } from '../components/Chart';

/**
 * Prices: PC part prices (GPU, RAM, SSD, HDD) in the UAE and the US with the moves over
 * 1 / 3 / 7 / 30 days. Market cards per category, the tracked listings (with pictures), one listing's
 * history, and a side-by-side compare of up to four listings in USD.
 */
type Category = 'gpu' | 'ram' | 'ssd' | 'hdd';
type Market = 'uae' | 'us';
type Win = 'd1' | 'd3' | 'd7' | 'd30';
const CATS: Category[] = ['gpu', 'ram', 'ssd', 'hdd'];
const WINS: Win[] = ['d1', 'd3', 'd7', 'd30'];
/** Fixed series colors for compare (validated: CVD-safe, ≥3:1 on the light surface). */
const COLORS = ['#2f6fe4', '#d97706', '#7c3aed', '#0d9488'];
const MAX_COMPARE = 4;

interface Product {
  id: number;
  store: string;
  storeName: string;
  market: Market;
  title: string;
  category: Category;
  url: string;
  source: string;
  image: boolean;
  price: number | null;
  currency: 'AED' | 'USD';
  usd: number | null;
  inStock: boolean;
  updatedAt: number | null;
  change: Record<Win, number | null>;
  low30: number | null;
  high30: number | null;
  points: number;
}
interface Index {
  category: Category;
  market: Market | 'all';
  tracked: number;
  inStock: number;
  change: Record<Win, number | null>;
  cheapest: Product | null;
}
interface Data {
  products: Product[];
  index: Index[];
  lastRefresh: number | null;
  aedPerUsd: number;
}
interface HistPoint {
  at: number;
  price: number | null;
  usd: number | null;
  inStock: boolean;
}
interface History {
  product: Product;
  points: HistPoint[];
}

const money = (v: number | null, cur: string) => (v === null ? '—' : `${cur === 'AED' ? 'AED' : '$'} ${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`);
const usd = (v: number | null) => (v === null ? '—' : `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`);

function Move({ v, big = false }: { v: number | null; big?: boolean }) {
  const { t } = useI18n();
  if (v === null) return <span className={`text-muted ${big ? 'text-lg' : 'text-xs'}`}>—</span>;
  const dir = v > 0.5 ? 'up' : v < -0.5 ? 'down' : 'flat';
  // Prices going down is the good news for a buyer: green for down, red for up.
  const cls = dir === 'down' ? 'text-ok' : dir === 'up' ? 'text-danger' : 'text-muted';
  const Icon = dir === 'down' ? ArrowDown16Filled : dir === 'up' ? ArrowUp16Filled : Subtract16Filled;
  return (
    <span className={`inline-flex items-center gap-0.5 font-medium ${cls} ${big ? 'text-lg' : 'text-xs'}`} dir="ltr" title={t(`prices.${dir}` as MessageKey)}>
      <Icon aria-hidden className={big ? 'size-5' : 'size-3.5'} />
      {Math.abs(v).toFixed(1)}%
    </span>
  );
}

function Thumb({ p, size = 48 }: { p: Product; size?: number }) {
  const [broken, setBroken] = useState(false);
  const cls = 'shrink-0 rounded-lg bg-white object-contain p-0.5 ring-1 ring-line';
  if (!p.image || broken) return <span className={`${cls} flex items-center justify-center text-[10px] uppercase text-muted`} style={{ width: size, height: size }}>{p.category}</span>;
  return <img src={`/api/prices/${p.id}/image`} alt="" width={size} height={size} loading="lazy" className={cls} style={{ width: size, height: size }} onError={() => setBroken(true)} />;
}

/** Histories of the compared listings on one time axis (USD), one series per listing. */
function mergeSeries(hs: History[]): [number[], ...(number | null)[][]] {
  const times = [...new Set(hs.flatMap((h) => h.points.map((p) => Math.round(p.at / 60_000) * 60)))].sort((a, b) => a - b);
  const cols = hs.map((h) => {
    const m = new Map(h.points.map((p) => [Math.round(p.at / 60_000) * 60, p.usd]));
    let last: number | null = null;
    return times.map((t) => {
      if (m.has(t)) last = m.get(t) ?? last;
      return last;
    });
  });
  return [times, ...cols];
}

export function Prices() {
  const { t, formatRelative } = useI18n();
  const ask = useConfirm();
  const [data, setData] = useState<Data | null>(null);
  const [market, setMarket] = useState<Market | 'all'>('all');
  const [cat, setCat] = useState<Category | 'all'>('all');
  const [win, setWin] = useState<Win>('d7');
  const [sort, setSort] = useState<'change' | 'price' | 'name'>('change');
  const [sel, setSel] = useState<History | null>(null);
  const [picked, setPicked] = useState<number[]>([]);
  const [compare, setCompare] = useState<History[] | null>(null);
  const [url, setUrl] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [task, setTask] = useState<number | null>(null);
  const [showAll, setShowAll] = useState(false);

  const load = () => api<Data>('/api/prices').then(setData);
  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 60_000);
    return () => clearInterval(id);
  }, []);

  const refresh = async () => {
    const r = await api<{ task: number | null }>('/api/prices/refresh', { body: {} });
    setTask(r.task);
    setTimeout(() => void load(), 15_000);
  };
  useEffect(() => {
    if (!task) return;
    const id = setInterval(async () => {
      const tk = await api<{ status: string }>(`/api/tasks/${task}`).catch(() => null);
      if (!tk || tk.status === 'succeeded' || tk.status === 'failed') {
        setTask(null);
        void load();
      }
    }, 5000);
    return () => clearInterval(id);
  }, [task]);

  const add = async () => {
    setErr('');
    setBusy(true);
    try {
      await api('/api/prices/products', { body: { url } });
      setUrl('');
      await load();
    } catch (e) {
      const code = e instanceof ApiError ? e.code : '';
      setErr(code === 'unsupported_url' ? t('prices.unsupported') : code === 'fetch_failed' ? t('prices.fetchFailed') : t('common.error'));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (p: Product) => {
    if (!(await ask({ title: t('prices.remove'), body: <p>{p.title}</p>, confirmLabel: t('prices.remove'), danger: true }))) return;
    await api(`/api/prices/products/${p.id}`, { method: 'DELETE' });
    setSel(null);
    setPicked((xs) => xs.filter((x) => x !== p.id));
    await load();
  };
  const open = (p: Product) => api<History>(`/api/prices/${p.id}/history?days=90`).then(setSel);
  const togglePick = (id: number) => setPicked((xs) => (xs.includes(id) ? xs.filter((x) => x !== id) : xs.length >= MAX_COMPARE ? xs : [...xs, id]));
  const runCompare = async () => {
    const hs = await Promise.all(picked.map((id) => api<History>(`/api/prices/${id}/history?days=90`)));
    setCompare(hs);
    setSel(null);
  };

  useEffect(() => setShowAll(false), [market, cat]);
  const list = useMemo(() => {
    const xs = (data?.products ?? []).filter((p) => (market === 'all' || p.market === market) && (cat === 'all' || p.category === cat));
    const by = {
      change: (a: Product, b: Product) => (a.change[win] ?? 0) - (b.change[win] ?? 0),
      price: (a: Product, b: Product) => (a.usd ?? 1e12) - (b.usd ?? 1e12),
      name: (a: Product, b: Product) => a.title.localeCompare(b.title),
    }[sort];
    return [...xs].sort(by);
  }, [data, market, cat, win, sort]);

  const chip = (on: boolean) => `rounded-full px-3 py-1 text-sm ${on ? 'bg-primary text-white' : 'bg-surface text-ink shadow-card'}`;
  const localFromUsd = (v: number | null, p: Product) => (v === null ? null : p.currency === 'AED' ? v * (data?.aedPerUsd ?? 3.6725) : v);

  return (
    <>
      <PageHeader
        title={t('prices.title')}
        back="/"
        actions={
          <button type="button" onClick={() => void refresh()} disabled={!!task} className="inline-flex items-center gap-1 rounded-full px-3 py-1 text-sm text-primary-ink hover:bg-primary-soft disabled:opacity-50">
            <ArrowClockwise16Regular aria-hidden className={task ? 'animate-spin' : ''} />
            {task ? t('prices.refreshing') : t('prices.refresh')}
          </button>
        }
      />
      <main className="safe-bottom mx-auto max-w-3xl space-y-4 px-3">
        <p className="text-xs text-muted">
          {t('prices.hint')} {data?.lastRefresh ? t('prices.updated', { when: formatRelative(data.lastRefresh) }) : t('prices.never')}
        </p>

        {/* Filters: one row */}
        <div className="flex flex-wrap items-center gap-2">
          {(['all', 'uae', 'us'] as const).map((m) => (
            <button key={m} type="button" className={chip(market === m)} onClick={() => setMarket(m)}>
              {t(`prices.${m}` as MessageKey)}
            </button>
          ))}
          <span className="mx-1 w-px self-stretch bg-line" aria-hidden />
          {WINS.map((w) => (
            <button key={w} type="button" className={chip(win === w)} onClick={() => setWin(w)}>
              {t(`prices.${w}` as MessageKey)}
            </button>
          ))}
        </div>

        {/* Market cards: the median move of each category's listings */}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {CATS.map((c) => {
            const ix = data?.index.find((i) => i.category === c && i.market === market);
            const on = cat === c;
            return (
              <button key={c} type="button" onClick={() => setCat(on ? 'all' : c)} className={`card p-3 text-start ${on ? 'ring-2 ring-primary' : ''}`}>
                <div className="text-sm font-medium text-heading">{t(`prices.cat.${c}` as MessageKey)}</div>
                <div className="mt-1">
                  <Move v={ix?.change[win] ?? null} big />
                </div>
                <div className="mt-1 text-xs text-muted">{ix ? t('prices.tracked', { n: ix.tracked, s: ix.inStock }) : '…'}</div>
                {ix?.cheapest && (
                  <div className="mt-2 flex items-center gap-2 text-xs text-ink" title={ix.cheapest.title}>
                    <Thumb p={ix.cheapest} size={28} />
                    <span className="min-w-0">
                      <span className="block text-muted">{t('prices.cheapest')}</span>
                      <span dir="ltr">{money(ix.cheapest.price, ix.cheapest.currency)}</span>
                    </span>
                  </div>
                )}
              </button>
            );
          })}
        </div>

        {data && data.products.length === 0 && <p className="text-sm text-muted">{t('prices.noData')}</p>}

        {/* Compare */}
        {compare && compare.length > 0 && (
          <Card title={t('prices.compare')} action={<button type="button" className="text-sm text-muted" onClick={() => setCompare(null)}>✕</button>}>
            {(() => {
              const cheapest = compare.filter((h) => h.product.usd !== null && h.product.inStock).sort((a, b) => (a.product.usd as number) - (b.product.usd as number))[0]?.product.id;
              return (
                <>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-start text-muted">
                          <th className="py-1 pe-2 text-start font-medium" />
                          {compare.map((h, i) => (
                            <th key={h.product.id} className="py-1 pe-2 text-start font-medium">
                              <span className="inline-block size-2.5 rounded-full align-middle" style={{ background: COLORS[i] }} aria-hidden />{' '}
                              <Thumb p={h.product} size={40} />
                              <span className="mt-1 line-clamp-2 max-w-[9rem] text-ink" title={h.product.title}>
                                {h.product.title}
                              </span>
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-line">
                        <tr>
                          <td className="py-1 pe-2 text-muted">{t('prices.store')}</td>
                          {compare.map((h) => (
                            <td key={h.product.id} className="py-1 pe-2">{h.product.storeName}</td>
                          ))}
                        </tr>
                        <tr>
                          <td className="py-1 pe-2 text-muted">{t('prices.price')}</td>
                          {compare.map((h) => (
                            <td key={h.product.id} className="py-1 pe-2 font-medium text-ink" dir="ltr">
                              {money(h.product.price, h.product.currency)}
                            </td>
                          ))}
                        </tr>
                        <tr>
                          <td className="py-1 pe-2 text-muted">{t('prices.usd')}</td>
                          {compare.map((h) => (
                            <td key={h.product.id} className={`py-1 pe-2 ${h.product.id === cheapest ? 'font-semibold text-ok' : 'text-ink'}`} dir="ltr">
                              {usd(h.product.usd)} {h.product.id === cheapest && <span className="text-[10px]">· {t('prices.cheaper')}</span>}
                            </td>
                          ))}
                        </tr>
                        {WINS.map((w) => (
                          <tr key={w}>
                            <td className="py-1 pe-2 text-muted">{t(`prices.${w}` as MessageKey)}</td>
                            {compare.map((h) => (
                              <td key={h.product.id} className="py-1 pe-2">
                                <Move v={h.product.change[w]} />
                              </td>
                            ))}
                          </tr>
                        ))}
                        <tr>
                          <td className="py-1 pe-2 text-muted">{t('prices.low30')}</td>
                          {compare.map((h) => (
                            <td key={h.product.id} className="py-1 pe-2" dir="ltr">{money(localFromUsd(h.product.low30, h.product), h.product.currency)}</td>
                          ))}
                        </tr>
                        <tr>
                          <td className="py-1 pe-2 text-muted">{t('prices.high30')}</td>
                          {compare.map((h) => (
                            <td key={h.product.id} className="py-1 pe-2" dir="ltr">{money(localFromUsd(h.product.high30, h.product), h.product.currency)}</td>
                          ))}
                        </tr>
                        <tr>
                          <td className="py-1 pe-2 text-muted">{t('prices.inStock')}</td>
                          {compare.map((h) => (
                            <td key={h.product.id} className="py-1 pe-2">{h.product.inStock ? <Checkmark16Filled className="text-ok" aria-label={t('prices.inStock')} /> : <span className="text-muted">{t('prices.outOfStock')}</span>}</td>
                          ))}
                        </tr>
                      </tbody>
                    </table>
                  </div>
                  {compare.some((h) => h.points.filter((p) => p.usd !== null).length >= 2) && (
                    <div className="mt-3">
                      <Chart data={mergeSeries(compare)} series={compare.map((h, i) => ({ label: h.product.title.slice(0, 24), color: COLORS[i] }))} height={200} fmt={(v) => usd(v)} />
                      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                        {compare.map((h, i) => (
                          <li key={h.product.id} className="inline-flex items-center gap-1">
                            <span className="inline-block size-2.5 rounded-full" style={{ background: COLORS[i] }} aria-hidden />
                            {h.product.title.slice(0, 40)}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              );
            })()}
          </Card>
        )}

        {/* Listings */}
        {list.length > 0 && (
          <Card
            title={cat === 'all' ? t('prices.seed') : t(`prices.cat.${cat}` as MessageKey)}
            action={
              <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} className="rounded-lg border border-line bg-surface px-2 py-1 text-xs text-ink" aria-label={t('prices.sort')}>
                <option value="change">{t('prices.sortChange')}</option>
                <option value="price">{t('prices.sortPrice')}</option>
                <option value="name">{t('prices.sortName')}</option>
              </select>
            }
          >
            <p className="mb-1 text-xs text-muted">{t('prices.compareHint')}</p>
            <ul className="divide-y divide-line">
              {(showAll ? list : list.slice(0, 15)).map((p) => {
                const on = picked.includes(p.id);
                return (
                  <li key={p.id} className="flex items-center gap-2 py-2">
                    <button
                      type="button"
                      onClick={() => togglePick(p.id)}
                      aria-pressed={on}
                      aria-label={on ? t('prices.picked') : t('prices.pick')}
                      className={`flex size-6 shrink-0 items-center justify-center rounded-md border ${on ? 'border-primary bg-primary text-white' : 'border-line bg-surface text-transparent'}`}
                    >
                      <Checkmark16Filled aria-hidden />
                    </button>
                    <button type="button" onClick={() => void open(p)} className="flex min-w-0 flex-1 items-center gap-3 text-start">
                      <Thumb p={p} />
                      <span className="min-w-0 flex-1">
                        <span className="line-clamp-2 text-sm text-ink">{p.title}</span>
                        <span className="block text-xs text-muted">
                          {p.storeName} · {t(`prices.cat.${p.category}` as MessageKey)}
                          {!p.inStock && <span className="ms-2 rounded-full bg-line px-1.5 text-[10px]">{t('prices.outOfStock')}</span>}
                        </span>
                      </span>
                      <span className="shrink-0 text-end">
                        <span className="block text-sm font-medium text-ink" dir="ltr">
                          {money(p.price, p.currency)}
                        </span>
                        <Move v={p.change[win]} />
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {!showAll && list.length > 15 && (
              <button type="button" onClick={() => setShowAll(true)} className="mt-2 text-sm text-primary-ink">
                {t('upd.showAll', { n: list.length })}
              </button>
            )}
          </Card>
        )}

        {/* One listing */}
        {sel && (
          <Card title={t('prices.history')} action={<button type="button" className="text-sm text-muted" onClick={() => setSel(null)}>✕</button>}>
            <div className="flex items-start gap-3">
              <Thumb p={sel.product} size={72} />
              <div className="min-w-0">
                <p className="text-sm text-ink">{sel.product.title}</p>
                <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted" dir="ltr">
                  <span className="text-base font-semibold text-ink">{money(sel.product.price, sel.product.currency)}</span>
                  {WINS.map((w) => (
                    <span key={w} className="inline-flex items-center gap-1">
                      {t(`prices.${w}` as MessageKey)} <Move v={sel.product.change[w]} />
                    </span>
                  ))}
                  <span>
                    {t('prices.low30')} {money(localFromUsd(sel.product.low30, sel.product), sel.product.currency)}
                  </span>
                  <span>
                    {t('prices.high30')} {money(localFromUsd(sel.product.high30, sel.product), sel.product.currency)}
                  </span>
                </p>
              </div>
            </div>
            <div className="mt-3">
              {sel.points.filter((p) => p.price !== null).length >= 2 ? (
                <Chart data={[sel.points.map((p) => Math.round(p.at / 1000)), sel.points.map((p) => p.price)]} series={[{ label: sel.product.currency, color: COLORS[0] }]} height={180} fmt={(v) => money(v, sel.product.currency)} />
              ) : (
                <p className="text-xs text-muted">{t('prices.noData')}</p>
              )}
            </div>
            <div className="mt-3 flex gap-2">
              <a href={sel.product.url} target="_blank" rel="noreferrer" className="inline-flex min-h-10 flex-1 items-center justify-center gap-1 rounded-xl bg-canvas text-sm text-primary-ink">
                <Open16Regular aria-hidden /> {t('prices.open')}
              </a>
              <Button variant="secondary" onClick={() => togglePick(sel.product.id)}>
                {picked.includes(sel.product.id) ? t('prices.picked') : t('prices.pick')}
              </Button>
              <Button variant="ghost" onClick={() => void remove(sel.product)}>
                {t('prices.remove')}
              </Button>
            </div>
          </Card>
        )}

        {/* Add */}
        <Card title={t('prices.add')}>
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              void add();
            }}
          >
            <TextField label={t('prices.addHint')} placeholder={t('prices.addPlaceholder')} dir="ltr" inputMode="url" value={url} onChange={(e) => setUrl(e.target.value)} required />
            <ErrorText>{err}</ErrorText>
            <Button type="submit" className="w-full" disabled={busy || !url}>
              {t('prices.add')}
            </Button>
          </form>
        </Card>
      </main>

      {/* Compare bar: appears once something is ticked */}
      {picked.length > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-30 safe-bottom pointer-events-none">
          <div className="pointer-events-auto mx-auto mb-3 flex max-w-md items-center gap-2 rounded-2xl bg-surface p-2 shadow-card">
            <span className="ps-2 text-sm text-muted">{picked.length}/{MAX_COMPARE}</span>
            <Button className="flex-1" disabled={picked.length < 2} onClick={() => void runCompare()}>
              {t('prices.compareN', { n: picked.length })}
            </Button>
            <Button variant="ghost" onClick={() => { setPicked([]); setCompare(null); }}>
              {t('prices.clear')}
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
