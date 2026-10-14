import { describe, expect, it } from 'vitest';
import { hyperopt, lossOf, prepareMarket, simulate, type RunSettings } from './backtest.js';
import { freshState, migrate } from './engine.js';
import { cleanProtections, DEFAULT_PROTECTIONS, lockedBy, protectionsAfter } from './protections.js';
import { computeStats } from './stats.js';
import { cleanParams, closeTrade, DEFAULT_PARAMS, exitCheck, openPosition, pairlist, pnlOf, roiNow, signal, updateTrail, type Candle, type Closed } from './strategy.js';

const flat = (n: number, p = 100, t0 = 0): Candle[] => Array.from({ length: n }, (_, i) => ({ t: t0 + i * 60_000, o: p, h: p * 1.001, l: p * 0.999, c: p, v: 1000, closed: true }));
const noCost = cleanParams({ feeTaker: 0, feeMaker: 0, slippageBps: 0, funding: false });

describe('Trade Bot strategy', () => {
  it('stays out of a quiet market and follows a sharp move', () => {
    expect(signal('SUI', flat(40))).toBeNull();
    const dump = flat(40);
    [99.5, 99, 98.4, 97.9, 97.3].forEach((c, i) => (dump[35 + i] = { ...dump[35 + i], c, o: c + 0.4, h: c + 0.5, l: c - 0.1 }));
    expect(signal('SUI', dump)).toMatchObject({ side: 'SHORT' });
    const pump = flat(40);
    [100.5, 101, 101.6, 102.1, 102.7].forEach((c, i) => (pump[35 + i] = { ...pump[35 + i], c, o: c - 0.4, l: c - 0.5, h: c + 0.1 }));
    expect(signal('SUI', pump)).toMatchObject({ side: 'LONG' });
    expect(signal('SUI', pump, 50)).toBeNull(); // a higher entry bar (hyperopt's buy space)
  });

  it('sets TP, a stop ratio× closer, leverage capped per coin, margin from the free balance', () => {
    const p = openPosition({ balance: 100, marginPct: 50 }, { sym: 'SUI', side: 'SHORT', atr: 0.004 }, 2, noCost, 0)!;
    expect(p.margin).toBe(50);
    expect(p.tp).toBeCloseTo(2 * (1 - 0.0088));
    expect(p.sl).toBeCloseTo(2 * (1 + 0.0088 / 5));
    expect(p.lev).toBeLessThanOrEqual(20);
    expect(p.size).toBe(50 * p.lev);
    expect(pnlOf(p, p.tp)).toBeGreaterThan(0);
    expect(openPosition({ balance: 100, marginPct: 50, usedMargin: 80 }, { sym: 'SUI', side: 'SHORT', atr: 0.004 }, 2, noCost, 0)!.margin).toBe(20);
    expect(openPosition({ balance: 100, marginPct: 50, usedMargin: 100 }, { sym: 'SUI', side: 'SHORT', atr: 0.004 }, 2, noCost, 0)).toBeNull();
  });

  it('charges slippage and fees: a market entry fills worse, TP is a maker limit', () => {
    const p = cleanParams({ slippageBps: 10, feeTaker: 0.001, feeMaker: 0.0002 });
    const pos = openPosition({ balance: 100, marginPct: 50 }, { sym: 'BTC', side: 'LONG', atr: 0.002 }, 100, p, 0)!;
    expect(pos.entry).toBeCloseTo(100.1);
    expect(pos.fees).toBeCloseTo(pos.size * 0.001);
    const t = closeTrade(pos, { why: 'TP', at: pos.tp, maker: true }, 100, p, 60_000);
    expect(t.exit).toBe(pos.tp);
    expect(t.pnl).toBeCloseTo(pnlOf(pos, pos.tp) - pos.size * 0.001 - pos.size * 0.0002 * (pos.tp / pos.entry), 3);
  });

  it('closes on liquidation, stop, take-profit and the clock — the stop first inside one candle', () => {
    const pos = openPosition({ balance: 100, marginPct: 50 }, { sym: 'BTC', side: 'LONG', atr: 0.002 }, 100, noCost, 0)!;
    expect(exitCheck(pos, { h: 100.1, l: 100.1, c: 100.1 }, noCost, 1000)).toBeNull();
    expect(exitCheck(pos, { h: pos.tp + 0.01, l: pos.tp, c: pos.tp }, noCost, 1000)).toMatchObject({ why: 'TP', at: pos.tp, maker: true });
    expect(exitCheck(pos, { h: pos.sl, l: pos.sl - 0.01, c: pos.sl }, noCost, 1000)).toMatchObject({ why: 'SL' });
    expect(exitCheck(pos, { h: pos.tp + 1, l: pos.sl - 0.01, c: 100 }, noCost, 1000)?.why).toBe('SL');
    expect(exitCheck(pos, { h: 100, l: pos.liq - 1, c: pos.liq - 1 }, noCost, 1000)?.why).toBe('LIQ');
    expect(exitCheck(pos, { h: 100.1, l: 100.1, c: 100.1 }, noCost, 31 * 60_000)?.why).toBe('TIME');
  });

  it('takes a smaller profit later with the ROI table', () => {
    const p = cleanParams({ ...noCost, roi: true, roiTable: [[0, 1], [10, 0.5], [20, 0]] });
    expect(roiNow(p.roiTable, 5)).toBe(1);
    expect(roiNow(p.roiTable, 12)).toBe(0.5);
    const pos = openPosition({ balance: 100, marginPct: 50 }, { sym: 'BTC', side: 'LONG', atr: 0.002 }, 100, p, 0)!;
    const most = 100 * (1 + pos.tpDist * 0.6);
    expect(exitCheck(pos, { h: most, l: most, c: most }, p, 5 * 60_000)).toBeNull();
    expect(exitCheck(pos, { h: most, l: most, c: most }, p, 12 * 60_000)?.why).toBe('ROI');
  });

  it('trails the stop once the move is far enough', () => {
    const p = cleanParams({ ...noCost, trailing: true, trailOffset: 0.5, trailDist: 0.25 });
    const pos = openPosition({ balance: 100, marginPct: 50 }, { sym: 'BTC', side: 'LONG', atr: 0.002 }, 100, p, 0)!;
    const sl0 = pos.sl;
    expect(updateTrail(pos, 100 * (1 + pos.tpDist * 0.3), p)).toBe(false);
    expect(updateTrail(pos, 100 * (1 + pos.tpDist * 0.8), p)).toBe(true);
    expect(pos.sl).toBeGreaterThan(sl0);
    expect(pos.sl).toBeGreaterThan(100); // locked in a profit
    expect(exitCheck(pos, { h: pos.sl, l: pos.sl - 0.01, c: pos.sl }, p, 1000)?.why).toBe('TRAIL');
  });

  it('keeps settings in range and picks the busiest pairs', () => {
    expect(cleanParams({ zEntry: 99, ratio: 0, maxOpen: 9, pairs: ['BTC', 'NOPE'] })).toMatchObject({ zEntry: 4, ratio: 1, maxOpen: 5, pairs: ['BTC'] });
    expect(freshState({ start: 1, marginPct: 500, hours: 0, ratio: 9 })).toMatchObject({ start: 10, marginPct: 90, hours: 22, params: { ratio: 8 } });
    expect(pairlist(cleanParams({ pairs: ['BTC', 'ETH', 'SOL'], volumeTopN: 2 }), { BTC: 5, ETH: 9, SOL: 7 })).toEqual(['ETH', 'SOL']);
  });

  it('carries a v1 state file over', () => {
    const st = migrate({
      start: 54,
      marginPct: 60,
      hours: 22,
      ratio: 4,
      balance: 60,
      running: true,
      pos: { sym: 'BTC', side: 'LONG', lev: 20, entry: 100, tp: 101, sl: 99.75, liq: 95.5, margin: 30, size: 600, openedAt: 5 },
      closed: [{ sym: 'ETH', side: 'SHORT', lev: 10, entry: 1, exit: 0.99, pnl: 3, pct: 10, balPct: 5, why: 'TP', at: 9, dur: 4 }],
    });
    expect(st.version).toBe(2);
    expect(st.params.ratio).toBe(4);
    expect(st.positions[0].sym).toBe('BTC');
    expect(st.positions[0].tpDist).toBeCloseTo(0.01);
    expect(st.closed[0]).toMatchObject({ sym: 'ETH', margin: 30, openedAt: 5 });
    expect(st.stats.trades).toBe(1);
  });
});

const trade = (o: Partial<Closed>): Closed => ({ id: 1, sym: 'BTC', side: 'LONG', lev: 10, entry: 1, exit: 1, pnl: 0, pct: 0, balPct: 0, why: 'TP', at: 0, openedAt: 0, dur: 60_000, margin: 10, fees: 0, funding: 0, tag: 'signal', ...o });

describe('Trade Bot protections', () => {
  it('cools a pair down after a trade and stops everything after too many stop-losses', () => {
    const cfg = cleanProtections({ stoplossGuard: { tradeLimit: 3, lookbackMin: 60, stopMin: 30 } });
    const now = 10 * 3600_000;
    const sl = [1, 2, 3].map((k) => trade({ sym: 'ETH', why: 'SL', at: now - k * 60_000, pnl: -1, pct: -10 }));
    const locks = protectionsAfter(cfg, sl, sl[0], now, 50);
    expect(locks.map((l) => l.by)).toEqual(['cooldown', 'stoplossGuard']);
    expect(lockedBy(locks, 'BTC', now + 60_000)?.by).toBe('stoplossGuard');
    expect(lockedBy(locks, 'BTC', now + 31 * 60_000)).toBeNull();
  });

  it('stops on a drawdown and locks a pair that keeps losing', () => {
    const cfg = cleanProtections({ maxDrawdown: { tradeLimit: 3, maxPct: 20, lookbackMin: 60 }, lowProfitPairs: { on: true, tradeLimit: 2, requiredProfitPct: 0 } });
    const now = 3600_000;
    const tr = [trade({ at: now, pnl: -15, pct: -20 }), trade({ at: now - 1, pnl: -10, pct: -10 }), trade({ at: now - 2, pnl: 5, pct: 5 })];
    const by = protectionsAfter(cfg, tr, tr[0], now, 80).map((l) => l.by);
    expect(by).toContain('maxDrawdown');
    expect(by).toContain('lowProfitPairs');
    expect(DEFAULT_PROTECTIONS.cooldown.on).toBe(true);
  });
});

describe('Trade Bot stats', () => {
  it('counts wins, profit factor, expectancy and drawdown like freqtrade', () => {
    const day = 86_400_000;
    const t = [trade({ at: day, pnl: 10, pct: 20 }), trade({ at: 2 * day, pnl: -5, pct: -10 }), trade({ at: 3 * day, pnl: -5, pct: -10 }), trade({ at: 4 * day, pnl: 0, pct: 0 })].reverse();
    const s = computeStats(t, 100);
    expect(s).toMatchObject({ trades: 4, wins: 1, losses: 2, draws: 1, profit: 0, profitFactor: 1, maxDrawdown: 10, maxConsecLosses: 2 });
    expect(s.maxDrawdownPct).toBeCloseTo(9.09, 1);
    expect(s.daily).toHaveLength(4);
    expect(s.perPair[0]).toMatchObject({ key: 'BTC', trades: 4 });
  });
});

describe('Trade Bot backtest', () => {
  // A market that dumps sharply every 2 hours and drifts back up.
  const t0 = Date.UTC(2026, 0, 1);
  const n = 3 * 1440;
  const c: Candle[] = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    const k = i % 120;
    const move = k >= 60 && k < 65 ? -0.004 : 0.00005;
    const o = p;
    p *= 1 + move;
    c.push({ t: t0 + i * 60_000, o, h: Math.max(o, p) * 1.0003, l: Math.min(o, p) * 0.9997, c: p, v: 5000, closed: true });
  }
  const market = prepareMarket({ BTC: c }, t0, n, { BTC: [[t0 + 8 * 3600_000, 0.0001]] });
  const rs: RunSettings = { start: 100, marginPct: 20, params: cleanParams({ pairs: ['BTC'], ratio: 3 }), protections: DEFAULT_PROTECTIONS, useProtections: true };

  it('replays the market with the live rules and reports the stats', () => {
    const r = simulate(market, rs);
    expect(r.stats.trades).toBeGreaterThan(5);
    expect(r.final).toBeCloseTo(100 + r.closed.reduce((s, t) => s + t.pnl, 0), 2);
    expect(r.equity.length).toBeGreaterThan(50);
    expect(r.marketChange.BTC).toBeDefined();
    expect(r.stats.fees).toBeGreaterThan(0);
  });

  it('finds better numbers with hyperopt and scores them with freqtrade losses', async () => {
    const seen: number[] = [];
    const res = await hyperopt(market, rs, { epochs: 30, loss: 'onlyprofit', spaces: ['buy', 'sell'], minTrades: 1, seed: 7 }, (e) => void seen.push(e.loss));
    expect(seen).toHaveLength(30);
    expect(res.best!.loss).toBe(Math.min(...seen));
    expect(res.best!.params.zEntry).toBeDefined();
    const s = simulate(market, rs).stats;
    expect(lossOf('onlyprofit', s, 1)).toBeCloseTo(-s.profitPct / 100);
    expect(lossOf('sharpe', s, 10_000)).toBeGreaterThan(1000); // too few trades
  });

  it('keeps the old defaults', () => {
    expect(DEFAULT_PARAMS).toMatchObject({ zEntry: 1.25, tpAtr: 2.2, ratio: 5, timeStopMin: 30, maxOpen: 1 });
  });
});

describe('Trade Bot brain', () => {
  const moment = (o: Partial<import('./brain.js').Moment> = {}) => ({ sym: 'SUI', side: 'SHORT' as const, z: -1.6, atr: 0.001, trend1h: -0.004, hour: 14, fundingRate: 0.0001, last: null, mode: 'momentum' as const, ...o });
  const sig = { sym: 'SUI', side: 'SHORT' as const, strength: 1.6, atr: 0.001 };
  const done = (pnl: number, margin = 10): Closed => trade({ sym: 'SUI', side: 'SHORT', pnl, pct: (pnl / margin) * 100, margin });

  it('breaks a moment into factors', async () => {
    const { factorsOf } = await import('./brain.js');
    const keys = factorsOf(moment()).map((f) => f.key);
    expect(keys).toEqual(expect.arrayContaining(['bias', 'coin:SUI', 'side:SHORT', 'coinside:SUI:SHORT', 'strength:1.5–2', 'vol:normal', 'trend:with', 'session:US', 'funding:earns']));
  });

  it('scores +1 point per dollar won, −1 per dollar lost, and judges skips the other way', async () => {
    const { freshBrain, learn } = await import('./brain.js');
    const b = freshBrain();
    learn(b, done(4), ['bias'], {}, true);
    learn(b, done(-1.5), ['bias'], {}, true);
    expect(b.tradingPoints).toBeCloseTo(2.5);
    learn(b, done(-3), ['bias'], {}, false); // skipped a loser: dodged
    learn(b, done(1), ['bias'], {}, false); // skipped a winner: missed
    expect(b.judgmentPoints).toBeCloseTo(2);
    expect(b.lessons.map((l) => l.kind)).toEqual(['missed', 'dodged', 'mistake', 'win']);
    expect(b.xp).toBe(4);
  });

  it('learns to skip what keeps losing and to trust what pays', async () => {
    const { freshBrain, factorsOf, learn, think } = await import('./brain.js');
    const b = freshBrain({ randomTry: 0 });
    const m = moment();
    const keys = factorsOf(m).map((f) => f.key);
    expect(think(b, sig, m, 0, () => 1).decision).toBe('TAKE'); // new: curious
    for (let i = 0; i < 25; i++) learn(b, done(-5), keys, {}, true);
    const th = think(b, sig, m, 0, () => 1);
    expect(th.decision).toBe('SKIP');
    expect(th.reason).toMatch(/keeps losing/);
    const good = moment({ sym: 'BTC', side: 'LONG', trend1h: 0.004, z: 2.5 });
    const gk = factorsOf(good).map((f) => f.key);
    for (let i = 0; i < 25; i++) learn(b, done(5), gk, {}, true);
    const t2 = think(b, { ...sig, sym: 'BTC', side: 'LONG' }, good, 0, () => 1);
    expect(t2.decision).toBe('TAKE');
    expect(t2.size).toBeGreaterThan(1); // more confident, bets a bit more
  });

  it('thinks and learns while replaying history', () => {
    const t0 = Date.UTC(2026, 0, 1);
    const n = 2 * 1440;
    const c: Candle[] = [];
    let p = 100;
    for (let i = 0; i < n; i++) {
      const k = i % 90;
      const move = k >= 40 && k < 45 ? -0.004 : 0.0001;
      const o = p;
      p *= 1 + move;
      c.push({ t: t0 + i * 60_000, o, h: Math.max(o, p) * 1.0003, l: Math.min(o, p) * 0.9997, c: p, v: 5000, closed: true });
    }
    const market = prepareMarket({ BTC: c }, t0, n);
    return import('./brain.js').then(({ freshBrain }) => {
      const b = freshBrain();
      const r = simulate(market, { start: 100, marginPct: 20, params: cleanParams({ pairs: ['BTC'] }), protections: DEFAULT_PROTECTIONS, useProtections: true }, { brain: b });
      expect(b.thoughts.length).toBeGreaterThan(0);
      expect(b.trades + b.shadows).toBeGreaterThan(5);
      expect(b.tradingPoints).toBeCloseTo(r.closed.reduce((s, t) => s + t.pnl, 0), 1);
    });
  });
});

describe('Trade Bot trend strategy', () => {
  const H = 3600_000;
  // Hourly rows: a flat month, a steady climb, then a fall.
  const rows: number[][] = [];
  let p = 100;
  for (let i = 0; i < 24 * 120; i++) {
    const d = i < 24 * 40 ? 0 : i < 24 * 90 ? 0.0008 : -0.0012;
    const o = p;
    p *= 1 + d + Math.sin(i / 5) * 0.0004;
    rows.push([Date.UTC(2025, 0, 1) + i * H, o, Math.max(o, p) * 1.001, Math.min(o, p) * 0.999, p, 1000]);
  }
  it('enters on a breakout, rides it and leaves when the channel breaks', async () => {
    const { toBars, trendTarget, channels, simulateTrend } = await import('./trend.js');
    const bars = toBars(rows, 4);
    expect(bars.length).toBe(720);
    const t = cleanParams({ strategy: 'trend' }).trend;
    let pos = 0;
    const path: number[] = [];
    for (let i = 0; i < bars.length; i++) path.push((pos = trendTarget(bars, i, pos, t)));
    const firstLong = path.indexOf(1);
    expect(firstLong).toBeGreaterThanOrEqual(240); // not in the flat month
    expect(path.at(-1)).toBe(0); // out after the fall
    expect(channels(bars, 500, t)!.entry).toBeGreaterThan(channels(bars, 500, t)!.exit);
    const r = simulateTrend({ BTC: bars }, { start: 100, marginPct: 60, params: cleanParams({ strategy: 'trend', pairs: ['BTC'] }), protections: DEFAULT_PROTECTIONS, useProtections: false });
    expect(r.stats.trades).toBeGreaterThan(0);
    expect(r.stats.profit).toBeGreaterThan(0);
    expect(r.closed.every((x) => x.side === 'LONG')).toBe(true);
    expect(r.closed.some((x) => x.why === 'TREND')).toBe(true);
  });
  it('keeps trend settings in range', () => {
    expect(cleanParams({ strategy: 'trend', trend: { tf: 5, N: 10, M: 40, volTarget: 9, maxW: 1, shorts: false } }).trend).toMatchObject({ tf: 4, N: 10, M: 5, volTarget: 3 });
  });
});

describe('Trade Bot portfolio strategies', () => {
  const H = 3600_000;
  const t0 = Date.UTC(2025, 0, 1);
  const series = (drift: number, n = 24 * 200, wobble = 0.0004) => {
    const rows: number[][] = [];
    let p = 100;
    for (let i = 0; i < n; i++) {
      const o = p;
      p *= 1 + drift * (i > n / 3 ? 1 : 0) + Math.sin(i / 7) * wobble;
      rows.push([t0 + i * H, o, Math.max(o, p) * 1.001, Math.min(o, p) * 0.999, p, 1000]);
    }
    return rows;
  };
  it('splits the balance between sleeves', async () => {
    const { sleeveWeights } = await import('./strategy.js');
    expect(sleeveWeights(cleanParams({ strategy: 'trend' }))).toEqual({ donchian: 1 });
    expect(sleeveWeights(cleanParams({ strategy: 'mix' }))).toEqual({ donchian: 0.4, ema: 0.2, xsmom: 0.2, carry: 0.2 });
    expect(sleeveWeights(cleanParams({ strategy: 'scalp' }))).toEqual({});
  });
  it('decides EMA, momentum, carry and the coin ranking', async () => {
    const { coinTarget, emaSeries, rankTargets, fundingAPR } = await import('./portfolio.js');
    const { toBars } = await import('./trend.js');
    const p = cleanParams({ strategy: 'mix' });
    const up = toBars(series(0.0006), 4);
    const i = up.length - 1;
    expect(coinTarget('ema', up, i, 0, p, { ema: emaSeries(up.map((b) => b.c), p.ema.n) })).toBe(1);
    const daily = toBars(series(-0.0006), 24);
    expect(coinTarget('tsmom', daily, daily.length - 1, 0, p)).toBe(0);
    const rich: [number, number][] = Array.from({ length: 30 }, (_, k) => [up[i].t - (29 - k) * 8 * H, 0.0003]); // oldest first, like Binance
    expect(fundingAPR(rich, up[i].t + 4 * H, 7)).toBeCloseTo(32.85, 1);
    expect(coinTarget('carry', up, i, 0, p, { funding: rich })).toBe(-1);
    const coins = { A: toBars(series(0.0008), 24), B: toBars(series(0.0002), 24), C: toBars(series(-0.0002), 24), D: toBars(series(-0.0008), 24) };
    const at = Object.fromEntries(Object.entries(coins).map(([s, b]) => [s, b.length - 1]));
    expect(rankTargets(coins, at, cleanParams({ xsmom: { L: 14, K: 1, longOnly: false, everyDays: 7 } }))).toEqual({ A: 1, B: 0, C: 0, D: -1 });
  });
  it('keeps carry trades free of price risk and backtests a mix', async () => {
    const { openSleeve, simulatePortfolio } = await import('./portfolio.js');
    const p = cleanParams({ strategy: 'mix' });
    const c = openSleeve('carry', { alloc: 100, id: 1 }, 'BTC', 'SHORT', 100, 0.8, null, p, 0)!;
    expect(c.hedged).toBe(true);
    expect(pnlOf(c, 150)).toBe(0);
    const md = { rows: { BTC: series(0.0004), ETH: series(0.0002), SOL: series(-0.0003), XRP: series(0.0001) }, funding: {} as Record<string, [number, number][]> };
    for (const s of Object.keys(md.rows)) md.funding[s] = md.rows[s as 'BTC'].filter((_, k) => k % 8 === 0).map((r) => [r[0], 0.0002] as [number, number]);
    const r = simulatePortfolio(md, { start: 100, marginPct: 60, params: cleanParams({ strategy: 'mix', pairs: ['BTC', 'ETH', 'SOL', 'XRP'], xsmom: { L: 14, K: 1, longOnly: false, everyDays: 7 } }), protections: DEFAULT_PROTECTIONS, useProtections: false }, { from: t0 + 60 * 24 * H });
    expect(Object.keys(r.perSleeve).sort()).toEqual(['carry', 'donchian', 'ema', 'xsmom']);
    expect(r.closed.some((x) => x.tag === 'carry' && x.funding > 0)).toBe(true);
    expect(r.final).toBeCloseTo(100 + Object.values(r.perSleeve).reduce((a, b) => a + b, 0), 1);
    expect(r.monteCarlo?.runs).toBe(1000);
  });
  it('walks forward: tunes on one window, trades the next', async () => {
    const { walkForward } = await import('./portfolio.js');
    const md = { rows: { BTC: series(0.0004, 24 * 400), ETH: series(0.0003, 24 * 400) }, funding: { BTC: [], ETH: [] } as Record<string, [number, number][]> };
    const r = await walkForward(md, { start: 100, marginPct: 60, params: cleanParams({ strategy: 'trend', pairs: ['BTC', 'ETH'] }), protections: DEFAULT_PROTECTIONS, useProtections: false }, { from: t0, to: t0 + 400 * 24 * H, trainDays: 120, testDays: 60, epochs: 6, loss: 'onlyprofit', minTrades: 1, seed: 1 });
    expect(r.windows.length).toBe(4);
    expect(r.windows[1].testFrom).toBe(r.windows[0].testTo);
    expect(r.windows.every((w) => w.testFrom - w.trainFrom === 120 * 24 * H)).toBe(true);
  });
});
