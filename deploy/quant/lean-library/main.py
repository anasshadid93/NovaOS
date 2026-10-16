# region imports
from AlgorithmImports import *
# endregion


class StrategyLibrary(QCAlgorithm):
    """Eight classic strategies built from LEAN's own indicators, long-only spot, equal weight
    (1/N of equity per asset while its signal is on, no leverage), so each one is judged on its
    entry/exit logic alone on the same data as the NovaOS rules.

      buyhold   : buy on day one, hold
      emacross  : long while EMA20 > EMA50 (LEAN EmaCross alpha)
      golden    : long while SMA50 > SMA200 (golden/death cross)
      donchian  : turtle: long on 20-day high breakout, exit on 10-day low
      rsi       : mean reversion: buy RSI14 < 30, sell RSI14 > 55 (LEAN RSI alpha style)
      bollinger : buy close < lower band(20,2), sell close > middle band
      macd      : long while MACD(12,26,9) > signal (LEAN MACD alpha)
      momentum  : monthly rotation into the top-2 assets by 90-day return (if positive)
    """

    def initialize(self):
        p = lambda k, d: self.get_parameter(k, d)  # noqa: E731
        self.set_start_date(*[int(x) for x in p("start", "2021-01-01").split("-")])
        self.set_end_date(*[int(x) for x in p("end", "2026-01-01").split("-")])
        self.set_cash(0)
        self.set_cash("USDT", float(p("cash", 10000)))
        self.set_brokerage_model(BrokerageName.BINANCE, AccountType.CASH)
        self.settings.free_portfolio_value_percentage = 0.02
        self.strategy = p("strategy", "emacross")
        self.assets = [a.strip() for a in p("assets", "BTCUSDT,ETHUSDT,SOLUSDT,PAXGUSDT").split(",") if a.strip()]
        self.syms = {a: self.add_crypto(a, Resolution.DAILY, Market.BINANCE).symbol for a in self.assets}
        self.ind = {}
        for a, s in self.syms.items():
            self.ind[a] = {
                "ema20": self.ema(s, 20, Resolution.DAILY), "ema50": self.ema(s, 50, Resolution.DAILY),
                "sma50": self.sma(s, 50, Resolution.DAILY), "sma200": self.sma(s, 200, Resolution.DAILY),
                "hi20": self.max(s, 20, Resolution.DAILY, Field.HIGH), "lo10": self.min(s, 10, Resolution.DAILY, Field.LOW),
                "rsi": self.rsi(s, 14, MovingAverageType.WILDERS, Resolution.DAILY),
                "bb": self.bb(s, 20, 2, MovingAverageType.SIMPLE, Resolution.DAILY),
                "macd": self.macd(s, 12, 26, 9, MovingAverageType.EXPONENTIAL, Resolution.DAILY),
                "mom": self.momp(s, 90, Resolution.DAILY),
            }
        self.set_warm_up(210, Resolution.DAILY)
        self.state = {a: False for a in self.assets}
        self.last_rebalance = None
        self.weight = 1.0 / len(self.assets)

    def _signal(self, a, bar):
        i, s = self.ind[a], self.strategy
        c = bar.close
        held = self.state[a]
        if s == "buyhold":
            return True
        if s == "emacross":
            return i["ema20"].current.value > i["ema50"].current.value
        if s == "golden":
            return i["sma50"].current.value > i["sma200"].current.value
        if s == "donchian":
            # breakout needs yesterday's channel: indicators update after the bar, so compare against the value before this bar
            if not held and c >= i["hi20"].previous.value:
                return True
            if held and c <= i["lo10"].previous.value:
                return False
            return held
        if s == "rsi":
            r = i["rsi"].current.value
            if not held and r < 30:
                return True
            if held and r > 55:
                return False
            return held
        if s == "bollinger":
            if not held and c < i["bb"].lower_band.current.value:
                return True
            if held and c > i["bb"].middle_band.current.value:
                return False
            return held
        if s == "macd":
            return i["macd"].current.value > i["macd"].signal.current.value
        return held

    def on_data(self, data: Slice):
        if self.is_warming_up:
            return
        if self.strategy == "momentum":
            if self.last_rebalance and (self.time - self.last_rebalance).days < 30:
                return
            self.last_rebalance = self.time
            scored = [(self.ind[a]["mom"].current.value, a) for a in self.assets if self.ind[a]["mom"].is_ready and data.bars.contains_key(self.syms[a])]
            scored.sort(reverse=True)
            top = {a for m, a in scored[:2] if m > 0}
            for a in self.assets:
                want = a in top
                if want != self.state[a]:
                    if want:
                        self.set_holdings(self.syms[a], 0.45)
                    else:
                        self.liquidate(self.syms[a])
                    self.state[a] = want
            return
        for a, s in self.syms.items():
            if not data.bars.contains_key(s):
                continue
            ready = all(x.is_ready for x in self.ind[a].values())
            if not ready:
                continue
            want = bool(self._signal(a, data.bars[s]))
            if want and not self.state[a]:
                self.set_holdings(s, self.weight * 0.97)
                self.state[a] = True
            elif not want and self.state[a]:
                self.liquidate(s)
                self.state[a] = False
