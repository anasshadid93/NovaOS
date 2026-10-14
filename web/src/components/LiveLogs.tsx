import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownload20Regular, Pause20Regular, Play20Regular, Search20Regular, TextWrap20Regular } from '@fluentui/react-icons';
import { useI18n } from '../i18n';

const MAX_LINES = 5000;

/** Colour by level so errors stand out. */
function tone(line: string) {
  if (/\b(error|err|fatal|panic|exception|failed|critical)\b/i.test(line)) return 'text-red-400';
  if (/\b(warn|warning)\b/i.test(line)) return 'text-amber-300';
  return 'text-slate-200';
}

/** A container's log, streamed live over a WebSocket: filter, pause, wrap, download. */
export function LiveLogs({ id, name }: { id: string; name: string }) {
  const { t } = useI18n();
  const [lines, setLines] = useState<string[]>([]);
  const [status, setStatus] = useState<'connecting' | 'live' | 'ended'>('connecting');
  const [paused, setPaused] = useState(false);
  const [wrap, setWrap] = useState(true);
  const [q, setQ] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const pausedRef = useRef(false);
  pausedRef.current = paused;
  const held = useRef<string[]>([]);

  useEffect(() => {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/docker/containers/${encodeURIComponent(id)}/logs/live?tail=400`);
    let rest = '';
    ws.onopen = () => setStatus('live');
    ws.onclose = () => setStatus('ended');
    ws.onmessage = (ev) => {
      const text = rest + String(ev.data);
      const parts = text.split('\n');
      rest = parts.pop() ?? '';
      if (!parts.length) return;
      if (pausedRef.current) {
        held.current.push(...parts);
        return;
      }
      setLines((cur) => [...cur, ...parts].slice(-MAX_LINES));
    };
    return () => ws.close();
  }, [id]);

  // Resuming shows what arrived while paused.
  useEffect(() => {
    if (!paused && held.current.length) {
      const more = held.current;
      held.current = [];
      setLines((cur) => [...cur, ...more].slice(-MAX_LINES));
    }
  }, [paused]);

  const shown = useMemo(() => (q ? lines.filter((l) => l.toLowerCase().includes(q.toLowerCase())) : lines), [lines, q]);

  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [shown]);

  const download = () => {
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.log`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const btn = 'inline-flex size-9 items-center justify-center rounded-lg text-ink hover:bg-primary-soft';

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center gap-1 border-b border-line p-2">
        <label className="flex min-w-0 flex-1 items-center gap-2 rounded-lg bg-canvas px-2 py-1.5">
          <Search20Regular className="shrink-0 text-muted" aria-hidden />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('logs.filter')} className="min-w-0 flex-1 bg-transparent text-sm outline-none" dir="ltr" />
        </label>
        <button type="button" className={btn} onClick={() => setPaused((p) => !p)} title={paused ? t('logs.resume') : t('logs.pause')} aria-label={paused ? t('logs.resume') : t('logs.pause')}>
          {paused ? <Play20Regular aria-hidden /> : <Pause20Regular aria-hidden />}
        </button>
        <button type="button" className={`${btn} ${wrap ? 'bg-primary-soft' : ''}`} onClick={() => setWrap((w) => !w)} title={t('logs.wrap')} aria-label={t('logs.wrap')}>
          <TextWrap20Regular aria-hidden />
        </button>
        <button type="button" className={btn} onClick={download} title={t('logs.download')} aria-label={t('logs.download')}>
          <ArrowDownload20Regular aria-hidden />
        </button>
      </div>
      <div
        ref={box}
        dir="ltr"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className={`h-[60dvh] overflow-auto bg-[#0b1220] p-3 font-mono text-[11px] leading-snug ${wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre'}`}
      >
        {shown.map((l, i) => {
          // Docker timestamps ("2026-10-10T12:00:00.123456789Z message") shown dimmed and short.
          const m = /^(\d{4}-\d\d-\d\dT(\d\d:\d\d:\d\d))\.\d+Z\s?(.*)$/.exec(l);
          return (
            <div key={i} className={tone(l)}>
              {m ? (
                <>
                  <span className="text-slate-500">{m[2]} </span>
                  {m[3]}
                </>
              ) : (
                l
              )}
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-muted">
        <span className={`size-2 rounded-full ${status === 'live' && !paused ? 'animate-pulse bg-ok' : status === 'ended' ? 'bg-muted' : 'bg-warn'}`} />
        {paused ? t('logs.paused') : status === 'live' ? t('logs.live') : status === 'ended' ? t('logs.ended') : t('logs.connecting')}
        <span className="ms-auto tabular-nums">{q ? `${shown.length} / ${lines.length}` : lines.length}</span>
      </div>
    </div>
  );
}
