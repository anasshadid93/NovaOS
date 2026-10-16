import { DEFAULT_FPARAMS, fundingHistory, futuresBars, simulatePortfolio, type FParams } from './futures.js';

/**
 * Research runner: node server/dist/quant/futures-cli.js <cacheDir> <start> <end> [k=v ...]
 * e.g. tf=15m leverage=3 trailAtr=3 allowShort=1 symbols=BTCUSDT,ETHUSDT
 */
const [cacheDir, start, end, ...kv] = process.argv.slice(2);
const opts: Record<string, string> = Object.fromEntries(kv.map((x) => x.split('=')));
const symbols = (opts.symbols ?? 'BTCUSDT,ETHUSDT,SOLUSDT').split(',');
const p: FParams = { ...DEFAULT_FPARAMS };
for (const k of ['emaFast', 'emaSlow', 'emaTrend', 'trailAtr', 'leverage', 'marginPct', 'cooldownBars'] as const) if (opts[k]) (p as unknown as Record<string, number>)[k] = Number(opts[k]);
if (opts.tf) p.tf = opts.tf as FParams['tf'];
if (opts.allowShort) p.allowShort = opts.allowShort === '1';
const since = Date.parse(start);
const until = Date.parse(end);
const data = [];
for (const s of symbols) {
  const bars = (await futuresBars(cacheDir, s, p.tf, Date.parse('2020-06-01'))).filter(
    (b) => b.t >= since - 220 * ({ '15m': 900_000, '1h': 3600_000, '4h': 14_400_000 }[p.tf] ?? 3600_000) && b.t < until,
  );
  const funding = (await fundingHistory(cacheDir, s, Date.parse('2020-06-01'))).filter((f) => f[0] >= since && f[0] < until);
  // warm-up bars before `since` feed the indicators but trades only count from `since`
  data.push({ symbol: s, bars, funding });
}
const r = simulatePortfolio(data, p);
const out = {
  params: p,
  start,
  end,
  netPct: +r.netPct.toFixed(1),
  maxDdPct: +r.maxDdPct.toFixed(1),
  trades: r.trades,
  tradesPerDay: +r.tradesPerDay.toFixed(2),
  winRate: +(r.winRate * 100).toFixed(0),
  liquidations: r.liquidations,
  fees: Math.round(r.feesPaid),
  funding: Math.round(r.fundingPaid),
  perSymbol: r.perSymbol.map((x) => `${x.symbol} ${x.netPct.toFixed(0)}%/dd${x.maxDdPct.toFixed(0)}% n${x.trades} liq${x.liquidations}`),
};
console.log(JSON.stringify(out));
