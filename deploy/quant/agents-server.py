#!/usr/bin/env python3
"""NovaOS Quant Desk: TradingAgents sidecar.

Runs the TauricResearch TradingAgents multi-agent debate (analysts → bull/bear researchers → trader →
risk team → portfolio manager) as background jobs and exposes them over a tiny JSON API on
127.0.0.1 only. NovaOS decides *what* to analyse and *when*, keeps the results, and applies its own
risk rules; this process only produces opinions.

  GET  /health                       -> {ok, version, busy, queue}
  POST /run {id, ticker, date, asset_type, analysts, llm:{provider, quick, deep, backend_url, keys}, rounds}
                                     -> {accepted}
  GET  /run/<id>                     -> {status: queued|running|done|error, result?, error?, started, finished}
  POST /cancel/<id>                  -> {ok}   (only queued jobs can be cancelled)

Keys arrive per request in the body (never written to disk here); results are kept in memory and
also written under data/runs/<id>.json so NovaOS can re-read them after a restart.
"""
import json, os, sys, threading, time, traceback, queue
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, 'data')
PORT = int(os.environ.get('QUANT_AGENTS_PORT', '7481'))
os.environ.setdefault('TRADINGAGENTS_RESULTS_DIR', os.path.join(DATA, 'logs'))
os.environ.setdefault('TRADINGAGENTS_CACHE_DIR', os.path.join(DATA, 'cache'))
os.environ.setdefault('TRADINGAGENTS_MEMORY_LOG_PATH', os.path.join(DATA, 'memory', 'trading_memory.md'))
for d in ('logs', 'cache', 'memory', 'runs'):
    os.makedirs(os.path.join(DATA, d), exist_ok=True)

import tradingagents  # noqa: E402
from tradingagents.graph.trading_graph import TradingAgentsGraph  # noqa: E402
from tradingagents.default_config import DEFAULT_CONFIG  # noqa: E402

JOBS = {}
LOCK = threading.Lock()
Q = queue.Queue()
CURRENT = {'id': None}

RATING_SCORE = {'buy': 1.0, 'overweight': 0.5, 'hold': 0.0, 'underweight': -0.5, 'sell': -1.0}
KEY_ENV = {'anthropic': 'ANTHROPIC_API_KEY', 'openai': 'OPENAI_API_KEY', 'google': 'GOOGLE_API_KEY', 'xai': 'XAI_API_KEY', 'deepseek': 'DEEPSEEK_API_KEY', 'openrouter': 'OPENROUTER_API_KEY', 'openai_compatible': 'OPENAI_COMPATIBLE_API_KEY'}


def run_job(job):
    req = job['request']
    llm = req.get('llm') or {}
    # Keys live only in this process's environment for the duration of the run.
    for prov, key in (llm.get('keys') or {}).items():
        env = KEY_ENV.get(prov)
        if env and key:
            os.environ[env] = key
    if llm.get('ollama_url'):
        os.environ['OLLAMA_BASE_URL'] = llm['ollama_url']
    cfg = dict(DEFAULT_CONFIG)
    cfg.update({
        'llm_provider': llm.get('provider', 'anthropic'),
        'quick_think_llm': llm.get('quick', 'claude-haiku-4-5'),
        'deep_think_llm': llm.get('deep', 'claude-haiku-4-5'),
        'quick_think_provider': llm.get('quick_provider'),
        'deep_think_provider': llm.get('deep_provider'),
        'backend_url': llm.get('backend_url'),
        'max_debate_rounds': int(req.get('rounds', 1)),
        'max_risk_discuss_rounds': int(req.get('rounds', 1)),
        'max_tool_rounds': int(req.get('max_tool_rounds', 8)),
        'output_language': req.get('language', 'English'),
    })
    analysts = tuple(req.get('analysts') or ('market', 'news', 'social'))
    graph = TradingAgentsGraph(selected_analysts=analysts, debug=False, config=cfg)
    state, signal = graph.propagate(req['ticker'], req['date'], asset_type=req.get('asset_type', 'crypto'))
    rating = str(signal or 'REVIEW')
    score = RATING_SCORE.get(rating.strip().lower())
    report_path = None
    try:
        report_path = str(graph.save_reports(state, req['ticker'], html=False))
    except Exception:
        pass
    pick = lambda k, n=6000: (state.get(k) or '')[:n]  # noqa: E731
    return {
        'ticker': req['ticker'],
        'date': req['date'],
        'rating': rating,
        'score': score,
        'analysts': list(analysts),
        'llm': {k: v for k, v in llm.items() if k not in ('keys',)},
        'version': tradingagents.__version__,
        'reports': {
            'market': pick('market_report'),
            'news': pick('news_report'),
            'social': pick('sentiment_report'),
            'fundamentals': pick('fundamentals_report'),
            'research': pick('investment_plan'),
            'trader': pick('trader_investment_plan'),
            'final': pick('final_trade_decision', 8000),
        },
        'report_path': report_path,
    }


def worker():
    while True:
        job_id = Q.get()
        with LOCK:
            job = JOBS.get(job_id)
            if not job or job['status'] != 'queued':
                continue
            job['status'] = 'running'
            job['started'] = time.time()
            CURRENT['id'] = job_id
        try:
            result = run_job(job)
            with LOCK:
                job.update(status='done', result=result, finished=time.time())
        except Exception as e:  # keep the service alive, report the failure
            with LOCK:
                job.update(status='error', error=f'{type(e).__name__}: {str(e)[:600]}', trace=traceback.format_exc()[-2000:], finished=time.time())
        finally:
            CURRENT['id'] = None
            try:
                with open(os.path.join(DATA, 'runs', f"{job_id}.json"), 'w') as f:
                    json.dump({k: v for k, v in job.items() if k != 'request'} | {'request': {k: v for k, v in job['request'].items() if k != 'llm'}}, f)
            except Exception:
                pass


threading.Thread(target=worker, daemon=True).start()


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        if self.path == '/health':
            with LOCK:
                return self._send(200, {'ok': True, 'version': tradingagents.__version__, 'busy': CURRENT['id'], 'queue': sum(1 for j in JOBS.values() if j['status'] == 'queued')})
        if self.path.startswith('/run/'):
            jid = self.path[5:]
            with LOCK:
                job = JOBS.get(jid)
            if not job:
                p = os.path.join(DATA, 'runs', f'{jid}.json')
                if os.path.isfile(p):
                    return self._send(200, json.load(open(p)))
                return self._send(404, {'error': 'not_found'})
            return self._send(200, {k: v for k, v in job.items() if k != 'request'})
        self._send(404, {'error': 'not_found'})

    def do_POST(self):
        n = int(self.headers.get('Content-Length') or 0)
        try:
            body = json.loads(self.rfile.read(n) or b'{}')
        except Exception:
            return self._send(400, {'error': 'bad_json'})
        if self.path == '/run':
            jid = str(body.get('id') or '')
            if not jid or not body.get('ticker') or not body.get('date'):
                return self._send(400, {'error': 'id, ticker and date are required'})
            with LOCK:
                if jid in JOBS:
                    return self._send(409, {'error': 'exists'})
                JOBS[jid] = {'id': jid, 'status': 'queued', 'request': body, 'created': time.time()}
                # keep memory bounded
                for old in [k for k, j in JOBS.items() if j['status'] in ('done', 'error')][:-50]:
                    del JOBS[old]
            Q.put(jid)
            return self._send(202, {'accepted': True, 'id': jid})
        if self.path.startswith('/cancel/'):
            jid = self.path[8:]
            with LOCK:
                job = JOBS.get(jid)
                if job and job['status'] == 'queued':
                    job['status'] = 'error'
                    job['error'] = 'cancelled'
                    return self._send(200, {'ok': True})
            return self._send(409, {'error': 'not_queued'})
        self._send(404, {'error': 'not_found'})


if __name__ == '__main__':
    srv = ThreadingHTTPServer(('127.0.0.1', PORT), H)
    print(f'quant agents sidecar on 127.0.0.1:{PORT} (tradingagents {tradingagents.__version__})', flush=True)
    srv.serve_forever()
