import type { FastifyInstance } from 'fastify';
import { requireAuth, requireElevated } from '../auth/sessions.js';
import { audit, getDb } from '../db.js';
import { agentsAlive, agentsError, agentsInstalled, agentsTick, getRun, listRuns, pollRuns, requestRun, routeModels, scheduleRuns, stopAgents } from './agents.js';
import { closePosition, closedPositions, equity, latestSignals, merge, openPositions, performance, refreshNews, refreshTechnical, snapshotEquity, step, type Mode } from './engine.js';
import { leanRoutes, leanStatus, startLean, stopLean } from './lean.js';
import { liveRoutes, liveStatus, startLive, stopLive } from './live.js';
import { MARKETS, quotes } from './market.js';
import { closeFuturesManual, closedFutures, futuresData, futuresEquity, futuresState, futuresStep, openFutures } from './futures-engine.js';
import { DEFAULT_FPARAMS, simulatePortfolio, type FParams } from './futures.js';
import { getSettings, publicSettings, saveSettings, type QuantSettings } from './settings.js';

/**
 * Quant Desk: the AI trading platform built on top of the Trade Bot and News Trader. Signals from
 * the technical rules, the TradingAgents debate and the news mood are merged by the engine, which
 * runs the paper book continuously; live execution (LEAN) stays off until the owner authorises it.
 */
let lastStep: Awaited<ReturnType<typeof step>> | null = null;
let lastStepAt = 0;
let lastErr: string | null = null;

export function startQuant(): () => void {
  if (process.env.VITEST) return () => {};
  const s = getSettings();
  const timers: NodeJS.Timeout[] = [];
  const safe = (fn: () => Promise<unknown> | unknown) => async () => {
    try {
      await fn();
    } catch (e) {
      lastErr = `${new Date().toISOString().slice(11, 19)} ${(e as Error).message}`.slice(0, 300);
    }
  };
  const engine = safe(async () => {
    refreshNews(getSettings().assets);
    const r = await step('paper');
    if (r) {
      lastStep = r;
      lastStepAt = Date.now();
      snapshotEquity('paper', r.quotes);
    }
    if (getSettings().live.enabled) {
      const l = await step('live');
      if (l) snapshotEquity('live', l.quotes);
    }
  });
  // Technical leg hourly (first run soon after boot), engine every minute, agents poll every 30 s.
  timers.push(
    setTimeout(
      safe(() => refreshTechnical(s.assets)),
      20_000,
    ),
  );
  timers.push(
    setInterval(
      safe(() => refreshTechnical(getSettings().assets)),
      3600_000,
    ),
  );
  timers.push(setTimeout(engine, 45_000));
  timers.push(setInterval(engine, 60_000));
  // Futures paper book: marks/stops every minute, regime on each closed bar.
  const fut = safe(() => (getSettings().futures.enabled ? futuresStep() : undefined));
  timers.push(setTimeout(fut, 30_000));
  timers.push(setInterval(fut, 60_000));
  if (agentsInstalled()) {
    void agentsTick();
    timers.push(setInterval(safe(agentsTick), 15_000));
    timers.push(setInterval(safe(pollRuns), 30_000));
    timers.push(setInterval(safe(scheduleRuns), 5 * 60_000));
  }
  const stopL = startLean();
  const stopLv = startLive();
  return () => {
    timers.forEach(clearTimeout);
    stopAgents();
    stopL();
    stopLv();
    stopLean();
    stopLive();
  };
}

export async function quantRoutes(app: FastifyInstance) {
  await app.register(leanRoutes);
  await app.register(liveRoutes);

  app.get('/api/quant', { preHandler: requireAuth }, async () => {
    const s = getSettings();
    const q = lastStep?.quotes ?? (await quotes(s.assets).catch(() => ({})));
    const paper = equity('paper', s.risk.startBalance, q);
    return {
      settings: publicSettings(s),
      markets: Object.keys(MARKETS),
      quotes: q,
      merged: merge(s.assets, s),
      signals: latestSignals(s.assets),
      paper: { ...paper, open: openPositions('paper'), closed: closedPositions('paper', 100), perf: performance('paper', s.risk.startBalance) },
      live: { ...equity('live', s.risk.startBalance, q), open: openPositions('live'), closed: closedPositions('live', 100), perf: performance('live', s.risk.startBalance), status: liveStatus() },
      agents: { installed: agentsInstalled(), alive: agentsAlive(), error: agentsError(), route: routeModels(s), runs: listRuns(30) },
      futures: { ...futuresEquity(), open: openFutures(), closed: closedFutures(100), perf: performance('futures', s.futures.startBalance), ...futuresState(), settings: s.futures },
      lean: leanStatus(),
      lastStep: lastStep ? { at: lastStepAt, opened: lastStep.opened, closed: lastStep.closed, skipped: lastStep.skipped } : null,
      lastError: lastErr,
    };
  });

  app.post<{ Body: Partial<QuantSettings> }>('/api/quant/settings', { preHandler: requireElevated }, async (req) => {
    const b = req.body ?? {};
    // Live authorisation has its own route; a settings write can only ever switch live OFF.
    const patch: Partial<QuantSettings> = { ...b };
    if (patch.live)
      patch.live = {
        ...getSettings().live,
        enabled: patch.live.enabled === false ? false : getSettings().live.enabled,
        killSwitch: typeof patch.live.killSwitch === 'boolean' ? patch.live.killSwitch : getSettings().live.killSwitch,
      };
    const keysChanged = !!(b.keys && (typeof b.keys.anthropic === 'string' || typeof b.keys.openai === 'string'));
    const saved = saveSettings(patch);
    audit(req.session!.userId, 'quant_settings', {
      keysChanged,
      risk: saved.risk,
      assets: saved.assets,
      routing: saved.routing,
      weights: saved.weights,
      paperEnabled: saved.paperEnabled,
      live: saved.live,
    });
    return publicSettings(saved);
  });

  app.post('/api/quant/step', { preHandler: requireAuth }, async (_req, reply) => {
    const s = getSettings();
    await refreshTechnical(s.assets);
    refreshNews(s.assets);
    const r = await step('paper');
    if (!r) return reply.code(409).send({ error: 'busy' });
    lastStep = r;
    lastStepAt = Date.now();
    snapshotEquity('paper', r.quotes);
    return { opened: r.opened, closed: r.closed, skipped: r.skipped, merged: r.merged };
  });

  app.post<{ Body: { asset?: string; force?: boolean } }>('/api/quant/agents/run', { preHandler: requireAuth }, async (req, reply) => {
    const asset = String(req.body?.asset ?? '');
    if (!MARKETS[asset]) return reply.code(400).send({ error: 'unknown_asset' });
    const r = await requestRun(asset, { force: !!req.body?.force });
    audit(req.session!.userId, 'quant_agents_run', { asset, ...r });
    return r;
  });
  app.get<{ Params: { id: string } }>('/api/quant/agents/runs/:id', { preHandler: requireAuth }, async (req, reply) => {
    const r = getRun(req.params.id);
    return r ?? reply.code(404).send({ error: 'not_found' });
  });

  app.post<{ Params: { id: string }; Body: { mode?: Mode } }>('/api/quant/positions/:id/close', { preHandler: requireElevated }, async (req, reply) => {
    const id = Number(req.params.id);
    const p = (getDb().prepare('SELECT * FROM quant_positions WHERE id = ? AND closed_at IS NULL').get(id) ?? null) as import('./engine.js').Position | null;
    if (!p) return reply.code(404).send({ error: 'not_found' });
    const q = await quotes([p.asset]);
    const px = q[p.asset]?.price;
    if (!px) return reply.code(503).send({ error: 'no_price' });
    const pnl = await closePosition(p.mode, p, px, 'manual', `${p.id}:manual:${req.session!.userId}:${Date.now()}`);
    audit(req.session!.userId, 'quant_manual_close', { id, mode: p.mode, asset: p.asset, pnl });
    return { pnl };
  });

  app.post('/api/quant/paper/reset', { preHandler: requireElevated }, async (req) => {
    const db = getDb();
    db.exec('BEGIN');
    db.prepare("DELETE FROM quant_positions WHERE mode = 'paper'").run();
    db.prepare("DELETE FROM quant_orders WHERE mode = 'paper'").run();
    db.prepare("DELETE FROM quant_equity WHERE mode = 'paper'").run();
    db.exec('COMMIT');
    audit(req.session!.userId, 'quant_paper_reset');
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/quant/futures/positions/:id/close', { preHandler: requireElevated }, async (req, reply) => {
    try {
      const pnl = await closeFuturesManual(Number(req.params.id), req.session!.userId);
      return pnl === null ? reply.code(404).send({ error: 'not_found' }) : { pnl };
    } catch (e) {
      return reply.code(503).send({ error: (e as Error).message });
    }
  });
  app.post('/api/quant/futures/reset', { preHandler: requireElevated }, async (req) => {
    const db = getDb();
    db.exec('BEGIN');
    db.prepare("DELETE FROM quant_positions WHERE mode = 'futures'").run();
    db.prepare("DELETE FROM quant_orders WHERE mode = 'futures'").run();
    db.prepare("DELETE FROM quant_equity WHERE mode = 'futures'").run();
    db.exec('COMMIT');
    audit(req.session!.userId, 'quant_futures_reset');
    return { ok: true };
  });
  /** In-process futures simulation (seconds, not Docker): same code as the live paper book. */
  app.post<{ Body: { start?: string; end?: string; params?: Partial<FParams>; assets?: string[] } }>('/api/quant/futures/backtest', { preHandler: requireAuth }, async (req, reply) => {
    const b = req.body ?? {};
    const start = Date.parse(String(b.start ?? '2021-01-01'));
    const end = Date.parse(String(b.end ?? new Date().toISOString().slice(0, 10)));
    if (!start || !end || start >= end) return reply.code(400).send({ error: 'bad_range' });
    const f = getSettings().futures;
    const p: FParams = {
      ...DEFAULT_FPARAMS,
      tf: f.tf,
      emaFast: f.emaFast,
      emaSlow: f.emaSlow,
      emaTrend: f.emaTrend,
      trailAtr: f.trailAtr,
      leverage: f.leverage,
      marginPct: f.marginPct,
      allowShort: f.allowShort,
      cooldownBars: f.cooldownBars,
      ...(b.params ?? {}),
    };
    const id = Number(
      getDb()
        .prepare("INSERT INTO quant_lean_runs(kind, created_at, status, params) VALUES('futures', ?, 'running', ?)")
        .run(Date.now(), JSON.stringify({ start: b.start, end: b.end, ...p })).lastInsertRowid,
    );
    try {
      const data = await futuresData(
        (b.assets ?? f.assets).filter((a) => MARKETS[a]),
        p.tf as '1h' | '4h',
        start,
        end,
      );
      const r = simulatePortfolio(data, p, f.startBalance);
      const stats = {
        'Net Profit': `${r.netPct.toFixed(2)}%`,
        Drawdown: `${r.maxDdPct.toFixed(1)}%`,
        'Win Rate': `${(r.winRate * 100).toFixed(0)}%`,
        orders: r.trades,
        liquidations: r.liquidations,
        tradesPerDay: +r.tradesPerDay.toFixed(2),
        fees: Math.round(r.feesPaid),
        funding: Math.round(r.fundingPaid),
        perSymbol: r.perSymbol,
      };
      getDb()
        .prepare("UPDATE quant_lean_runs SET status = 'done', finished_at = ?, stats = ?, equity = ?, log = 'in-process simulation' WHERE id = ?")
        .run(Date.now(), JSON.stringify(stats), JSON.stringify(r.curve), id);
      audit(req.session!.userId, 'quant_futures_backtest', { id, start: b.start, end: b.end, tf: p.tf, leverage: p.leverage });
      return { id, ...stats };
    } catch (e) {
      getDb()
        .prepare("UPDATE quant_lean_runs SET status = 'error', finished_at = ?, log = ? WHERE id = ?")
        .run(Date.now(), String((e as Error).message).slice(0, 2000), id);
      return reply.code(500).send({ error: (e as Error).message });
    }
  });

  /** Plain ledger: every filled order of both books, newest first, with the realised P&L on closes. */
  app.get<{ Querystring: { limit?: string } }>('/api/quant/orders', { preHandler: requireAuth }, async (req) => {
    const limit = Math.min(1000, Math.max(1, Number(req.query.limit ?? 300)));
    return getDb()
      .prepare(
        `SELECT o.id, o.at, o.mode, o.asset, o.side, o.qty, o.price, o.notional, o.fee, o.reason, o.position_id,
                p.pnl AS pnl, p.entry AS entry, p.detail AS pdetail
         FROM quant_orders o LEFT JOIN quant_positions p ON p.id = o.position_id
         WHERE o.status = 'filled' ORDER BY o.at DESC LIMIT ?`,
      )
      .all(limit);
  });

  app.get<{ Querystring: { limit?: string } }>('/api/quant/audit', { preHandler: requireAuth }, async (req) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 100)));
    return getDb().prepare("SELECT ts, user_id, action, detail FROM audit WHERE action LIKE 'quant_%' ORDER BY ts DESC LIMIT ?").all(limit);
  });
}
