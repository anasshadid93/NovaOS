# Quant Desk (AI trading platform)

Quant Desk upgrades the Trade Bot and the News Trader into one platform: every source of opinion
publishes a **signal**, a deterministic **engine** merges them and applies **risk rules no AI can
override**, and an **executor** fills orders, on paper by default. Two external frameworks plug in:

- **[TradingAgents](https://github.com/TauricResearch/TradingAgents)** (TauricResearch): the
  multi-agent debate (technical / news / sentiment analysts → bull vs bear researchers → trader →
  risk team → portfolio manager). Runs as the `novaos-agents.service` sidecar.
- **[QuantConnect LEAN](https://github.com/QuantConnect/Lean)**: backtesting and walk-forward
  validation of the exact same rules on real Binance history, in Docker via the `lean` CLI.

```
Trade Bot (technical rules) ─┐
TradingAgents debate ────────┼─► quant_signals ─► engine.ts (merge → risk gate) ─► paper book (SQLite)
News Trader mood ────────────┘                           │                      └► live executor (off by default)
                                                        └─► LEAN replays the same rules on history (backtest / walk-forward)
```

## Signals

| source | where it comes from | validity |
| --- | --- | --- |
| `technical` | `market.ts`: EMA50/200 trend, 55-day Donchian position, 20-day momentum, RSI damping, from Binance daily bars | 26 h, refreshed hourly |
| `agents` | one TradingAgents run per asset per day (rating Buy…Sell → −1…1) | 36 h |
| `news` | the News Trader's decayed market mood (`marketView`) | 3 h, refreshed every minute |

Merged score = Σ weight × confidence × score / Σ weight × confidence. Without the technical leg an
asset never trades; a decisive agents **Sell** (score ≤ −0.9) vetoes new longs and closes a position.

## Risk rules (engine.ts, independent of any model)

- Price safety: a trade needs a quote younger than `maxPriceAgeSec`, from Binance **and** cross-checked
  against Kraken within `maxSourceGapPct`. Stale, unverified or disputed prices block the order.
- Size: `riskPct` of equity divided by the stop distance (`stopAtr × ATR`, clamped to
  `stopMinPct…stopMaxPct`), then capped by `maxPositionPct`, `maxExposurePct`, cash, and (live) `maxNotionalUsd`.
- Exits: stop, take-profit at `takeProfitR × risk`, trailing stop after `trailArmR × risk`
  (follows the high by `trailAtr × ATR`), `maxHoldDays` deadline, merged score below `exitScore`.
- Guards: `maxOpen`, one position per asset, `dailyLossPct` stop (realised + unrealised),
  `cooldownMin` after a loss, idempotent orders (the same decision can never fill twice, even across
  restarts), one engine step at a time.
- Every open, close, failed order, settings change and live action is written to the `audit` table.

## Model routing

`var/quant.json` keeps the keys (0600, never returned to the browser). Each tier (quick: analysts
and debate; deep: managers) names a provider + model. A provider without a key falls back to the
next one in `routing.fallback`; Ollama needs no key. `agentsDailyCap` bounds the daily spend.

Measured on this machine: a full debate (market + news + social analysts) takes ~6 min on Claude
Haiku and ~40 min on a local 9B model through Ollama.

## LEAN

`<data root>/apps/lean/` holds the `lean` CLI venv, `workspace/` (lean.json, `data/`, the `novaos`
project) and `scripts/export_binance.py`, which writes Binance klines in LEAN's crypto format
(`data/crypto/binance/daily/<symbol>_trade.zip`). `workspace/novaos/main.py` re-implements the
engine's rules in Python and reads an optional `signals.csv` with the stored agent/news signals.

- **Backtest**: one run over a date range with the current risk settings.
- **Walk-forward**: for each window, an 18-point grid (entry score × stop ATR × take-profit R) on the
  train period picks the best Sharpe, which is then run on the following test period; the report
  shows per-window out-of-sample results and the compounded total.

## Live trading

Off by default. To switch it on: store exchange keys (verified read-only against the account),
then in an **elevated** session call authorise with the exact phrase and a per-order cap. A settings
write can only switch live *off*; the kill switch blocks all new orders. Binance spot and the
Binance testnet are implemented; the engine's risk rules still apply on top.

## Install

```bash
# TradingAgents sidecar
mkdir -p /srv/data/apps/tradingagents && cd /srv/data/apps/tradingagents
git clone https://github.com/TauricResearch/TradingAgents.git src
python3 -m venv venv && venv/bin/pip install ./src
cp <repo>/deploy/quant/agents-server.py server.py
# LEAN
mkdir -p /srv/data/apps/lean/{scripts,workspace} && cd /srv/data/apps/lean
python3 -m venv venv && venv/bin/pip install lean && docker pull quantconnect/lean:latest
cp <repo>/deploy/quant/export_binance.py scripts/
# lean init needs a QuantConnect login; the workspace can instead be scaffolded from the Lean repo's
# Data folder + Launcher/config.json (see the Python snippet in the commit that added docs/quant.md).
cp -r <repo>/deploy/quant/lean-novaos workspace/novaos
sudo deploy/install.sh    # installs novaos-agents.service when the folder is complete
```

## API

`GET /api/quant` (everything), `POST /api/quant/settings`, `POST /api/quant/step`,
`POST /api/quant/agents/run {asset}`, `GET /api/quant/agents/runs/:id`,
`POST /api/quant/positions/:id/close`, `POST /api/quant/paper/reset`, `GET /api/quant/audit`,
`POST /api/quant/lean/backtest|walkforward|data`, `GET /api/quant/lean/runs/:id`,
`POST /api/quant/live/keys`, `DELETE /api/quant/live/keys/:broker`, `POST /api/quant/live/authorize`,
`POST /api/quant/live/stop`.
