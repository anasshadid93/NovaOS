#!/usr/bin/env python3
"""Download Binance spot klines and write them in LEAN's crypto format.

usage: export_binance.py <data-folder> <resolution: daily|hour> <SYMBOL> [<SYMBOL> ...] [--since 2019-01-01]

LEAN expects data/crypto/binance/<resolution>/<symbol>_trade.zip containing <symbol>.csv with lines
"yyyyMMdd HH:mm,open,high,low,close,volume" (UTC). Public endpoints only; no keys.
"""
import io, json, os, sys, time, zipfile, urllib.request, datetime as dt

BINANCE = os.environ.get('MANAR_BINANCE_URL', 'https://api.binance.com')


def klines(symbol, interval, start_ms):
    out = []
    while True:
        url = f'{BINANCE}/api/v3/klines?symbol={symbol}&interval={interval}&startTime={start_ms}&limit=1000'
        with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'NovaOS-Quant/1.0'}), timeout=30) as r:
            rows = json.load(r)
        if not rows:
            break
        out.extend(rows)
        start_ms = rows[-1][0] + 1
        if len(rows) < 1000:
            break
        time.sleep(0.25)
    return out


def main():
    argv = sys.argv[1:]
    since = '2019-01-01'
    if '--since' in argv:
        i = argv.index('--since')
        since = argv[i + 1]
        del argv[i:i + 2]
    args = argv
    data, res, symbols = args[0], args[1], args[2:]
    interval = {'daily': '1d', 'hour': '1h'}[res]
    start_ms = int(dt.datetime.strptime(since, '%Y-%m-%d').replace(tzinfo=dt.timezone.utc).timestamp() * 1000)
    folder = os.path.join(data, 'crypto', 'binance', res)
    os.makedirs(folder, exist_ok=True)
    report = {}
    for sym in symbols:
        rows = klines(sym, interval, start_ms)
        # Drop the still-open last candle.
        now_ms = int(time.time() * 1000)
        rows = [r for r in rows if r[6] < now_ms]
        lines = []
        for r in rows:
            t = dt.datetime.fromtimestamp(r[0] / 1000, dt.timezone.utc)
            lines.append(f"{t.strftime('%Y%m%d %H:%M')},{r[1]},{r[2]},{r[3]},{r[4]},{r[5]}")
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
            z.writestr(f'{sym.lower()}.csv', '\n'.join(lines) + '\n')
        with open(os.path.join(folder, f'{sym.lower()}_trade.zip'), 'wb') as f:
            f.write(buf.getvalue())
        report[sym] = {'bars': len(lines), 'first': lines[0][:14] if lines else None, 'last': lines[-1][:14] if lines else None}
    print(json.dumps(report))


if __name__ == '__main__':
    main()
