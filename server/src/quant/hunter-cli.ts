import fs from 'node:fs';
import path from 'node:path';
import { CRYPTO_HP, STOCK_HP, loadBars, simulateHunter, type HParams } from './hunter.js';

/**
 * node server/dist/quant/hunter-cli.js <kind: crypto|stocks> <dir> <start> <end> [k=v ...]
 * crypto dir holds <SYMBOL>.json daily bars (see fetch below); stocks dir from export_stocks.py.
 */
const [kind, dir, start, end, ...kv] = process.argv.slice(2);
const opts: Record<string, string> = Object.fromEntries(kv.map((x) => x.split('=')));
const p: HParams = { ...(kind === 'stocks' ? STOCK_HP : CRYPTO_HP) };
for (const k of Object.keys(p) as (keyof HParams)[]) if (opts[k] !== undefined) (p as unknown as Record<string, number>)[k] = Number(opts[k]);

if (kind === 'crypto' && opts.fetch) {
  // One-off: pull daily klines since 2020 for the symbols listed in opts.fetch (comma separated).
  const BIN = 'https://api.binance.com';
  fs.mkdirSync(dir, { recursive: true });
  for (const s of opts.fetch.split(',')) {
    const out: { t: number; o: number; h: number; l: number; c: number; v: number }[] = [];
    let since = Date.parse('2020-01-01');
    for (;;) {
      const r = await fetch(`${BIN}/api/v3/klines?symbol=${s}&interval=1d&startTime=${since}&limit=1000`);
      if (!r.ok) break;
      const rows = (await r.json()) as (string | number)[][];
      if (!rows.length) break;
      for (const k of rows) if (Number(k[6]) < Date.now()) out.push({ t: Number(k[0]), o: Number(k[1]), h: Number(k[2]), l: Number(k[3]), c: Number(k[4]), v: Number(k[5]) });
      since = Number(rows[rows.length - 1][0]) + 86400_000;
      if (rows.length < 1000) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    fs.writeFileSync(path.join(dir, `${s}.json`), JSON.stringify(out));
    console.error(s, out.length);
  }
}
const symbols = (
  opts.symbols
    ? opts.symbols.split(',')
    : fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace('.json', ''))
).filter((s) => !opts.exclude?.split(',').includes(s));
const data = symbols.map((s) => ({ symbol: s, bars: loadBars(dir, s) })).filter((d) => d.bars.length >= 250);
const r = simulateHunter(data, p, Date.parse(start), Date.parse(end));
console.log(
  JSON.stringify({
    kind,
    universe: data.length,
    start,
    end,
    params: p,
    netPct: +r.netPct.toFixed(1),
    maxDdPct: +r.maxDdPct.toFixed(1),
    trades: r.trades,
    winRate: +(r.winRate * 100).toFixed(0),
    profitFactor: +r.profitFactor.toFixed(2),
    avgHoldDays: +r.avgHoldDays.toFixed(0),
    byReason: r.byReason,
    top: r.bySymbol.slice(0, 5).map(([s, v]) => `${s} ${v.toFixed(0)}`),
    bottom: r.bySymbol.slice(-3).map(([s, v]) => `${s} ${v.toFixed(0)}`),
  }),
);
