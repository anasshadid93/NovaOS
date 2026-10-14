import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearch } from 'wouter';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { ApiError, api } from '../lib/api';
import { useI18n } from '../i18n';
import { useWindowCtx } from '../desktop/context';
import { wm } from '../desktop/wm';

type State = 'confirm' | 'connecting' | 'open' | 'closed' | 'denied' | 'error';

/**
 * Desktop: a terminal on the server (as the service user). Every session needs a fresh passkey/TOTP confirmation
 * (the server issues a one-time ticket only after it), see server/src/terminal/terminal.ts.
 */
/** Launchers that open the terminal with a tool started (a fixed list: links can't run anything else). */
const RUN: Record<string, string> = { rea: 'rea --help' };

export function Terminal() {
  const run = RUN[new URLSearchParams(useSearch()).get('run') ?? ''];
  const { t } = useI18n();
  const win = useWindowCtx();
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<State>('confirm');
  const [attempt, setAttempt] = useState(0);

  const connect = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    const el = host.current!;
    const term = new XTerm({
      cursorBlink: true,
      fontFamily: 'ui-monospace, "Cascadia Code", "JetBrains Mono", Menlo, Consolas, monospace',
      fontSize: 13,
      scrollback: 5000,
      allowProposedApi: false,
      theme: { background: '#0b1220', foreground: '#e2e8f0', cursor: '#7aa7ff', selectionBackground: '#2f6fe455', black: '#0b1220', blue: '#5b8def', brightBlue: '#7aa7ff' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();
    let ws: WebSocket | null = null;
    let disposed = false;

    (async () => {
      setState('confirm');
      let ticket: string;
      try {
        // Asks for the passkey / code first if the last confirmation is older than 5 minutes.
        ticket = (await api<{ ticket: string }>('/api/terminal/ticket', { body: {} })).ticket;
      } catch (e) {
        if (!disposed) setState(e instanceof ApiError && e.code === 'confirm_required' ? 'denied' : 'error');
        return;
      }
      if (disposed) return;
      setState('connecting');
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/api/terminal?t=${encodeURIComponent(ticket)}&cols=${term.cols}&rows=${term.rows}`);
      ws.onopen = () => {
        setState('open');
        term.focus();
        if (run) ws?.send(JSON.stringify({ type: 'in', data: `${run}\r` }));
      };
      ws.onmessage = (ev) => term.write(typeof ev.data === 'string' ? ev.data : new Uint8Array(ev.data as ArrayBuffer));
      ws.onclose = (ev) => {
        if (disposed) return;
        setState(ev.code === 4403 ? 'denied' : 'closed');
        term.write(`\r\n\x1b[90m— ${t('term.ended')} —\x1b[0m\r\n`);
      };
    })();

    const send = (m: unknown) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));
    const input = term.onData((data) => send({ type: 'in', data }));
    const resize = term.onResize(({ cols, rows }) => send({ type: 'resize', cols, rows }));
    const title = term.onTitleChange((s) => win && wm.setTitle(win.id, s || t('term.title')));
    // Follow the window's size.
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* hidden */
      }
    });
    ro.observe(el);

    return () => {
      disposed = true;
      ro.disconnect();
      input.dispose();
      resize.dispose();
      title.dispose();
      ws?.close();
      term.dispose();
    };
  }, [attempt, t, win, run]);

  const note = state === 'confirm' ? t('term.confirm') : state === 'connecting' ? t('term.connecting') : state === 'denied' ? t('term.denied') : state === 'error' ? t('common.error') : state === 'closed' ? t('term.ended') : '';

  return (
    <div className="flex h-full flex-col bg-[#0b1220]">
      <div ref={host} className="min-h-0 flex-1 p-2" />
      {note && (
        <div className="flex items-center justify-between gap-3 border-t border-white/10 px-3 py-2 text-xs text-slate-300">
          <span>{note}</span>
          {(state === 'closed' || state === 'denied' || state === 'error') && (
            <button type="button" onClick={connect} className="rounded-md bg-primary px-3 py-1 font-medium text-white">
              {t('term.reconnect')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
