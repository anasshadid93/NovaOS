# region imports
from AlgorithmImports import *
import csv, json, os
# endregion


class NovaOSQuantDesk(QCAlgorithm):
    """The NovaOS Quant Desk rules, replayed inside LEAN.

    Same logic as server/src/quant/engine.ts: a technical score (EMA50/200 trend, 55-day Donchian
    position, 20-day momentum, RSI damping) merged with any external signals (TradingAgents debate,
    news mood) found in signals.csv, then the risk rules: ATR stop, R-multiple target, trailing
    stop, max-hold deadline, per-position / total exposure caps, daily loss stop and cooldown.
    Long-only spot on Binance. Parameters come from the Lean project config / --parameter flags.
    """

    def initialize(self):
        p = lambda k, d: self.get_parameter(k, d)  # noqa: E731
        self.set_start_date(*[int(x) for x in p("start", "2021-01-01").split("-")])
        self.set_end_date(*[int(x) for x in p("end", "2026-01-01").split("-")])
        self.set_cash(0)  # no default USD; the account is USDT only
        self.set_cash("USDT", float(p("cash", 10000)))
        self.set_brokerage_model(BrokerageName.BINANCE, AccountType.CASH)
        self.settings.free_portfolio_value_percentage = 0.02

        self.assets = [a.strip() for a in p("assets", "BTCUSDT,ETHUSDT,SOLUSDT,PAXGUSDT").split(",") if a.strip()]
        self.risk_pct = float(p("riskPct", 1)) / 100
        self.max_pos_pct = float(p("maxPositionPct", 25)) / 100
        self.max_exp_pct = float(p("maxExposurePct", 60)) / 100
        self.max_open = int(p("maxOpen", 4))
        self.stop_atr = float(p("stopAtr", 2))
        self.stop_min = float(p("stopMinPct", 2)) / 100
        self.stop_max = float(p("stopMaxPct", 10)) / 100
        self.tp_r = float(p("takeProfitR", 2.5))
        self.trail_arm_r = float(p("trailArmR", 1))
        self.trail_atr = float(p("trailAtr", 2))
        self.daily_loss = float(p("dailyLossPct", 3)) / 100
        self.max_hold = int(p("maxHoldDays", 14))
        self.cooldown_days = float(p("cooldownMin", 240)) / 1440
        self.entry_score = float(p("entryScore", 0.35))
        self.exit_score = float(p("exitScore", -0.15))
        self.w_tech = float(p("wTechnical", 0.4))
        self.w_agents = float(p("wAgents", 0.4))
        self.w_news = float(p("wNews", 0.2))

        self.symbols = {}
        self.ind = {}
        for a in self.assets:
            sym = self.add_crypto(a, Resolution.DAILY, Market.BINANCE).symbol
            self.symbols[a] = sym
            self.ind[a] = {
                "ema50": self.ema(sym, 50, Resolution.DAILY),
                "ema200": self.ema(sym, 200, Resolution.DAILY),
                "atr": self.atr(sym, 14, MovingAverageType.SIMPLE, Resolution.DAILY),
                "rsi": self.rsi(sym, 14, MovingAverageType.SIMPLE, Resolution.DAILY),
                "hi": self.max(sym, 55, Resolution.DAILY, Field.HIGH),
                "lo": self.min(sym, 55, Resolution.DAILY, Field.LOW),
                "mom": self.momp(sym, 20, Resolution.DAILY),
            }
            self.set_warm_up(210, Resolution.DAILY)
        self.book = {}      # asset -> dict(entry, stop, target, high, atr, opened)
        self.last_loss = {}  # asset -> time
        self.day_start_equity = None
        self.day = None
        self.external = self._load_signals()
        self.signal_log = []

    def _load_signals(self):
        """signals.csv (optional): at_iso,asset,source,score,confidence,expires_iso — exported by NovaOS."""
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "signals.csv")
        out = {}
        if not os.path.isfile(path):
            return out
        with open(path) as f:
            for row in csv.DictReader(f):
                try:
                    out.setdefault(row["asset"], []).append((
                        datetime.fromisoformat(row["at"].replace("Z", "+00:00")).replace(tzinfo=None),
                        row["source"], float(row["score"]), float(row["confidence"]),
                        datetime.fromisoformat(row["expires"].replace("Z", "+00:00")).replace(tzinfo=None)))
                except Exception:
                    continue
        for a in out:
            out[a].sort(key=lambda r: r[0])
        return out

    def _external(self, asset, now):
        latest = {}
        for at, source, score, conf, exp in self.external.get(asset, []):
            if at <= now < exp:
                latest[source] = (score, conf)
        return latest

    def _technical(self, a, price):
        i = self.ind[a]
        if not all(x.is_ready for x in (i["ema50"], i["atr"], i["rsi"], i["hi"], i["lo"], i["mom"])):
            return None
        e200 = i["ema200"].current.value if i["ema200"].is_ready else i["ema50"].current.value
        trend = (0.5 if price > i["ema50"].current.value else -0.5) + (0.5 if price > e200 else -0.5)
        hi, lo = i["hi"].current.value, i["lo"].current.value
        breakout = 0 if hi == lo else ((price - lo) / (hi - lo)) * 2 - 1
        mom = max(-1, min(1, (i["mom"].current.value / 100) / 0.15))
        r = i["rsi"].current.value
        score = 0.4 * trend + 0.35 * breakout + 0.25 * mom
        if r > 78:
            score -= 0.25
        if r < 25:
            score += 0.15
        return max(-1, min(1, score)), i["atr"].current.value

    def _merged(self, a, price, now):
        t = self._technical(a, price)
        if t is None:
            return None, None, False
        tech, atr = t
        num, den = self.w_tech * 0.8 * tech, self.w_tech * 0.8
        vetoed = False
        for source, (score, conf) in self._external(a, now).items():
            w = {"agents": self.w_agents, "news": self.w_news}.get(source, 0)
            if w <= 0:
                continue
            num += w * conf * score
            den += w * conf
            if source == "agents" and score <= -0.9:
                vetoed = True
        return (num / den if den else 0), atr, vetoed

    def on_data(self, data: Slice):
        if self.is_warming_up:
            return
        now = self.time
        equity = self.portfolio.total_portfolio_value
        if self.day != now.date():
            self.day = now.date()
            self.day_start_equity = equity
        # 1. manage
        for a, pos in list(self.book.items()):
            sym = self.symbols[a]
            if not data.bars.contains_key(sym):
                continue
            price = data.bars[sym].close
            pos["high"] = max(pos["high"], data.bars[sym].high)
            risk = pos["entry"] - pos["stop0"]
            if risk > 0 and pos["high"] - pos["entry"] >= self.trail_arm_r * risk:
                pos["stop"] = max(pos["stop"], pos["high"] - self.trail_atr * pos["atr"])
            m, _, vetoed = self._merged(a, price, now)
            reason = None
            if data.bars[sym].low <= pos["stop"]:
                reason = "stop"
            elif price >= pos["target"]:
                reason = "target"
            elif (now - pos["opened"]).days >= self.max_hold:
                reason = "deadline"
            elif m is not None and m <= self.exit_score:
                reason = "score"
            elif vetoed:
                reason = "agents_sell"
            if reason:
                self.liquidate(sym, tag=reason)
                pnl = (price - pos["entry"]) * pos["qty"]
                if pnl < 0:
                    self.last_loss[a] = now
                del self.book[a]
        # 2. entries
        if self.day_start_equity and equity <= self.day_start_equity * (1 - self.daily_loss):
            return
        held = set(self.book)
        cands = []
        for a in self.assets:
            if a in held:
                continue
            sym = self.symbols[a]
            if not data.bars.contains_key(sym):
                continue
            price = data.bars[sym].close
            m, atr, vetoed = self._merged(a, price, now)
            if m is None or vetoed or m < self.entry_score:
                continue
            if a in self.last_loss and (now - self.last_loss[a]).total_seconds() < self.cooldown_days * 86400:
                continue
            cands.append((m, a, price, atr))
        cands.sort(reverse=True)
        for m, a, price, atr in cands:
            if len(self.book) >= self.max_open:
                break
            equity = self.portfolio.total_portfolio_value
            exposure = sum(self.portfolio[self.symbols[b]].holdings_value for b in self.book)
            stop_pct = min(self.stop_max, max(self.stop_min, self.stop_atr * atr / price))
            notional = min(self.risk_pct * equity / stop_pct, self.max_pos_pct * equity, self.max_exp_pct * equity - exposure, self.portfolio.cash_book["USDT"].amount * 0.98)
            if notional < 10:
                continue
            qty = round(notional / price, 5)
            ticket = self.market_order(self.symbols[a], qty, tag=f"entry {m:.2f}")
            if ticket.status in (OrderStatus.FILLED, OrderStatus.PARTIALLY_FILLED, OrderStatus.SUBMITTED, OrderStatus.NEW):
                self.book[a] = {"entry": price, "stop": price * (1 - stop_pct), "stop0": price * (1 - stop_pct), "target": price * (1 + stop_pct * self.tp_r), "high": price, "atr": atr, "opened": now, "qty": qty}
