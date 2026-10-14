import { Component, lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { Call24Filled, CallEnd24Filled, MicOff24Filled, Mic24Filled } from '@fluentui/react-icons';
import { useI18n } from '../i18n';
import { ApiError, api } from '../lib/api';
import { PageHeader } from '../components/ui';

// The animated orb (three.js) loads only here, and only when the page opens.
const Orb = lazy(() => import('../components/Orb').then((m) => ({ default: m.Orb })));
const SunOrb = lazy(() => import('../components/SunOrb').then((m) => ({ default: m.SunOrb })));
const GalaxyOrb = lazy(() => import('../components/GalaxyOrb').then((m) => ({ default: m.GalaxyOrb })));
/** No WebGL (old phone, disabled GPU): the simple CSS orb instead. */
/** Sun or galaxy: same states, two looks. */
function SunOrbOrGalaxy({ galaxy, ...props }: { galaxy: boolean } & Parameters<typeof import('../components/SunOrb').SunOrb>[0]) {
  return galaxy ? <GalaxyOrb {...props} /> : <SunOrb {...props} />;
}
class OrbBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

type Phase = 'idle' | 'connecting' | 'live' | 'error';
type Line = { role: 'user' | 'assistant'; text: string; open: boolean };
const VOICE_KEY = 'manar.voice.voice2';
const CONTROL_KEY = 'manar.voice.control';
const LOOK_KEY = 'manar.voice.look';
const FEMALE = new Set(['juniper', 'maple', 'sol', 'vale', 'breeze']);
type Approval = { id: string; what: string; cwd?: string; reason?: string };
type VoiceState = {
  control: boolean;
  busy?: boolean;
  pending: Approval | null;
  actions: {
    what: string;
    status: 'waiting' | 'approved' | 'declined' | 'auto';
    at: number;
  }[];
};

/**
 * Live voice chat, like ChatGPT's voice mode: the browser talks to OpenAI over WebRTC; the server
 * (voice/voice.ts) only exchanges the connection details through Codex, on the ChatGPT plan.
 */
export function Voice() {
  const { t } = useI18n();
  const [info, setInfo] = useState<{
    available: boolean;
    voices: string[];
    defaultVoice?: string;
  } | null>(null);
  const [voice, setVoice] = useState(() => localStorage.getItem(VOICE_KEY) ?? '');
  const [control, setControl] = useState(() => localStorage.getItem(CONTROL_KEY) !== 'off');
  const [look, setLook] = useState<'galaxy' | 'sun' | 'orb'>(() => {
    const v = localStorage.getItem(LOOK_KEY);
    return v === 'orb' || v === 'sun' ? v : 'galaxy';
  });
  const [vstate, setVstate] = useState<VoiceState | null>(null);
  const [callId, setCallId] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState('');
  const [muted, setMuted] = useState(false);
  const [speaking, setSpeaking] = useState<'user' | 'assistant' | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [level, setLevel] = useState(0);
  // Mic and voice loudness for the orb (0..1), read every frame without re-rendering.
  const inVol = useRef(0);
  const outVol = useRef(0);
  const call = useRef<{
    pc: RTCPeerConnection;
    mic: MediaStream;
    id?: string;
    ctx: AudioContext;
    raf: number;
  } | null>(null);
  const audioEl = useRef<HTMLAudioElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void api<{ available: boolean; voices: string[]; defaultVoice?: string }>('/api/voice').then(setInfo, () => setInfo({ available: false, voices: [] }));
    return () => void hangUp();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Control mode: what Codex wants to run, and what ran.
  useEffect(() => {
    if (!callId) return;
    let stop = false;
    const poll = async () => {
      if (stop) return;
      setVstate(await api<VoiceState>(`/api/voice/state?id=${encodeURIComponent(callId)}`).catch(() => null));
      if (!stop) setTimeout(() => void poll(), 1000);
    };
    void poll();
    return () => {
      stop = true;
    };
  }, [callId]);
  const decide = (approve: boolean) => {
    if (!callId || !vstate?.pending) return;
    void api('/api/voice/decide', {
      method: 'POST',
      body: { id: callId, approval: vstate.pending.id, approve },
    }).catch(() => {});
    setVstate((v) => (v ? { ...v, pending: null } : v));
  };

  useEffect(() => {
    scroller.current?.scrollTo({
      top: scroller.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [lines]);

  // Both sides can talk at once, so each speaker's words go to that speaker's open line.
  const openLine = (ls: Line[], role: Line['role']) => ls.findLastIndex((l) => l.role === role && l.open);
  /** Adds live transcript words to the speaker's open line, or starts one. */
  const say = (role: Line['role'], text: string) =>
    setLines((ls) => {
      const i = openLine(ls, role);
      if (i >= 0) return ls.map((l, k) => (k === i ? { ...l, text: l.text + text } : l));
      return text.trim() ? [...ls.slice(-40), { role, text: text.trimStart(), open: true }] : ls;
    });
  /** End of a turn: the full transcript replaces the pieces, and the line closes. */
  const closeTurn = (role: Line['role'], full?: string) =>
    setLines((ls) => {
      const i = openLine(ls, role);
      if (i < 0) return full?.trim() ? [...ls, { role, text: full.trim(), open: false }] : ls;
      return ls.map((l, k) => (k === i ? { ...l, text: full?.trim() || l.text, open: false } : l));
    });

  async function start() {
    setError('');
    setLines([]);
    setPhase('connecting');
    let mic: MediaStream | null = null;
    try {
      mic = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      const pc = new RTCPeerConnection();
      const ctx = new AudioContext();
      call.current = { pc, mic, ctx, raf: 0 };
      pc.addTrack(mic.getAudioTracks()[0], mic);
      const meters: { an: AnalyserNode; who: 'user' | 'assistant' }[] = [];
      const meter = (stream: MediaStream, who: 'user' | 'assistant') => {
        const an = ctx.createAnalyser();
        an.fftSize = 512;
        ctx.createMediaStreamSource(stream).connect(an);
        meters.push({ an, who });
      };
      meter(mic, 'user');
      pc.ontrack = (e) => {
        const stream = e.streams[0] ?? new MediaStream([e.track]);
        if (audioEl.current) {
          audioEl.current.srcObject = stream;
          void audioEl.current.play().catch(() => {});
        }
        meter(stream, 'assistant');
      };
      const buf = new Uint8Array(256);
      const tick = () => {
        let best = 0;
        let who: 'user' | 'assistant' | null = null;
        for (const m of meters) {
          m.an.getByteTimeDomainData(buf);
          let sum = 0;
          for (const v of buf) sum += (v - 128) ** 2;
          const rms = Math.sqrt(sum / buf.length) / 128;
          (m.who === 'user' ? inVol : outVol).current = Math.min(1, rms * 5);
          if (rms > best) [best, who] = [rms, m.who];
        }
        setLevel(Math.min(1, best * 4));
        setSpeaking(best > 0.04 ? who : null);
        if (call.current) call.current.raf = requestAnimationFrame(tick);
      };
      call.current.raf = requestAnimationFrame(tick);

      const dc = pc.createDataChannel('oai-events');
      dc.onmessage = (e) => {
        try {
          const ev = JSON.parse(e.data as string) as {
            type: string;
            item?: { text?: string };
            turn?: { role?: string; transcript?: string };
          };
          if (ev.type === 'input_transcript.added' && ev.item?.text) say('user', ev.item.text);
          else if (ev.type === 'output_transcript.added' && ev.item?.text) say('assistant', ev.item.text);
          else if (ev.type === 'turn.done' && (ev.turn?.role === 'user' || ev.turn?.role === 'assistant')) closeTurn(ev.turn.role, ev.turn.transcript);
        } catch {
          /* not JSON */
        }
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') setPhase('live');
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') void hangUp(pc.connectionState === 'failed' ? t('voice.dropped') : '');
      };

      await pc.setLocalDescription(await pc.createOffer());
      // Wait for the network candidates (at most 3 s) so the offer is complete.
      await new Promise<void>((res) => {
        if (pc.iceGatheringState === 'complete') return res();
        const done = () => pc.iceGatheringState === 'complete' && res();
        pc.addEventListener('icegatheringstatechange', done);
        setTimeout(res, 3000);
      });
      // Acting on the server asks for the same passkey/code confirmation as the terminal.
      const r = await api<{ id: string; sdp: string }>(control ? '/api/voice/start-control' : '/api/voice/start', {
        method: 'POST',
        body: { sdp: pc.localDescription!.sdp, ...(voice ? { voice } : {}) },
      });
      if (!call.current || call.current.pc !== pc)
        return void api('/api/voice/stop', {
          method: 'POST',
          body: { id: r.id },
        }).catch(() => {});
      call.current.id = r.id;
      setCallId(r.id);
      await pc.setRemoteDescription({ type: 'answer', sdp: r.sdp });
    } catch (e) {
      const msg =
        e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError')
          ? t('voice.noMic')
          : e instanceof ApiError
            ? t(e.code === 'too_many_sessions' ? 'voice.busy' : e.code === 'voice_not_set_up' ? 'voice.notSetUp' : 'voice.failed')
            : t('voice.failed');
      await hangUp(msg);
    }
  }

  async function hangUp(err = '') {
    const c = call.current;
    call.current = null;
    if (c) {
      cancelAnimationFrame(c.raf);
      c.pc.close();
      c.mic.getTracks().forEach((tr) => tr.stop());
      void c.ctx.close().catch(() => {});
      if (c.id)
        void fetch('/api/voice/stop', {
          method: 'POST',
          credentials: 'same-origin',
          keepalive: true,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: c.id }),
        }).catch(() => {});
    }
    setMuted(false);
    setCallId(null);
    setVstate(null);
    setSpeaking(null);
    setLevel(0);
    setError(err);
    setPhase(err ? 'error' : 'idle');
  }

  const toggleMute = () => {
    const tr = call.current?.mic.getAudioTracks()[0];
    if (!tr) return;
    tr.enabled = !tr.enabled;
    setMuted(!tr.enabled);
  };

  const live = phase === 'live';
  const cssOrb = (
    <div className="relative grid size-full place-items-center">
      <div
        className="absolute inset-0 rounded-full blur-2xl transition-[transform,opacity] duration-100"
        style={{
          background: speaking === 'user' ? 'radial-gradient(circle, #34d399, #0ea5e9)' : 'radial-gradient(circle, #a78bfa, #3b82f6)',
          transform: `scale(${0.75 + (live ? level * 0.5 : 0)})`,
          opacity: live ? 0.55 + level * 0.45 : 0.25,
        }}
      />
      <div
        className={`relative size-40 rounded-full shadow-[0_20px_60px_rgb(59_130_246/0.35)] transition-transform duration-100 ${phase === 'connecting' ? 'animate-pulse' : ''}`}
        style={{
          background: speaking === 'user' ? 'linear-gradient(135deg,#34d399,#0ea5e9)' : 'linear-gradient(135deg,#a78bfa,#3b82f6)',
          transform: `scale(${1 + (live ? level * 0.12 : 0)})`,
        }}
      />
    </div>
  );
  const status =
    phase === 'connecting' ? t('voice.connecting') : live ? (muted ? t('voice.muted') : speaking === 'assistant' ? t('voice.speaking') : t('voice.listening')) : error || t('voice.tapToTalk');

  return (
    <div className="flex min-h-full flex-col">
      <PageHeader title={t('voice.title')} back="/" />
      <audio ref={audioEl} autoPlay className="hidden" />
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center px-5 pb-6">
        {info && !info.available ? (
          <p className="mt-10 text-center text-sm text-muted">{t('voice.notSetUp')}</p>
        ) : (
          <>
            {/* The orb: breathes with whoever is talking. */}
            <div className="relative mt-4 mb-3 aspect-square w-full max-w-80">
              <OrbBoundary fallback={cssOrb}>
                <Suspense fallback={cssOrb}>
                  {look === 'sun' || look === 'galaxy' ? (
                    <SunOrbOrGalaxy
                      galaxy={look === 'galaxy'}
                      className="size-full"
                      // Thinking: connecting, or Codex working on something (not while it waits for his yes).
                      state={
                        phase === 'connecting' || (live && vstate?.busy && !vstate.pending)
                          ? 'thinking'
                          : live
                            ? speaking === 'assistant'
                              ? 'talking'
                              : speaking === 'user'
                                ? 'userSpeaking'
                                : 'listening'
                            : 'idle'
                      }
                      inputVolumeRef={inVol}
                      outputVolumeRef={outVol}
                    />
                  ) : (
                    <Orb
                      className="size-full"
                      colors={phase === 'error' ? ['#dc2626', '#fecaca'] : ['#2563eb', '#a5f3fc']}
                      agentState={phase === 'connecting' || (live && vstate?.busy) ? 'thinking' : live ? (speaking === 'assistant' ? 'talking' : 'listening') : null}
                      volumeMode={live ? 'manual' : 'auto'}
                      inputVolumeRef={inVol}
                      outputVolumeRef={outVol}
                    />
                  )}
                </Suspense>
              </OrbBoundary>
            </div>
            <p className={`mb-4 text-center text-sm ${phase === 'error' ? 'text-danger' : 'text-muted'}`} role="status">
              {status}
            </p>

            {vstate?.pending && (
              <div className="mb-4 w-full rounded-2xl border-2 border-amber-400 bg-amber-50 p-3 text-ink dark:bg-amber-950/40" role="alert">
                <p className="mb-1 text-sm font-semibold">{t('voice.approveTitle')}</p>
                <pre dir="ltr" className="mb-2 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-black/80 p-2 font-mono text-xs text-green-200">
                  {vstate.pending.what}
                </pre>
                {vstate.pending.cwd && (
                  <p dir="ltr" className="mb-1 text-[11px] text-muted">
                    {vstate.pending.cwd}
                  </p>
                )}
                {vstate.pending.reason && (
                  <p dir="auto" className="mb-2 text-xs text-muted">
                    {vstate.pending.reason}
                  </p>
                )}
                <p className="mb-2 text-xs text-muted">{t('voice.approveHint')}</p>
                <div className="flex gap-2">
                  <button type="button" onClick={() => decide(true)} className="flex-1 rounded-xl bg-emerald-500 py-2 text-sm font-semibold text-white active:scale-95">
                    {t('voice.approve')}
                  </button>
                  <button type="button" onClick={() => decide(false)} className="flex-1 rounded-xl bg-red-500 py-2 text-sm font-semibold text-white active:scale-95">
                    {t('voice.decline')}
                  </button>
                </div>
              </div>
            )}
            {!!vstate?.actions.length && (
              <ul className="mb-3 w-full space-y-1">
                {vstate.actions
                  .filter((a) => a.status !== 'waiting')
                  .slice(-4)
                  .map((a) => (
                    <li key={a.at} className="flex items-center gap-2 text-xs text-muted">
                      <span aria-hidden>{a.status === 'approved' ? '✅' : a.status === 'auto' ? '👁' : '❌'}</span>
                      <code dir="ltr" className="truncate">
                        {a.what}
                      </code>
                    </li>
                  ))}
              </ul>
            )}

            <div ref={scroller} className="mb-5 max-h-[32vh] w-full flex-1 space-y-2 overflow-y-auto">
              {lines.map((l, i) => (
                <p key={i} dir="auto" className={`w-fit max-w-[85%] rounded-2xl px-3 py-2 text-sm ${l.role === 'user' ? 'ms-auto bg-primary text-white' : 'bg-surface text-ink ring-1 ring-line'}`}>
                  {l.text}
                </p>
              ))}
            </div>

            {phase === 'idle' || phase === 'error' ? (
              <div className="flex w-full flex-col items-center gap-3">
                <button
                  type="button"
                  onClick={() => void start()}
                  disabled={!info}
                  className="inline-flex h-16 items-center gap-2 rounded-full bg-emerald-500 px-8 text-base font-semibold text-white shadow-lg active:scale-95 disabled:opacity-50"
                >
                  <Call24Filled aria-hidden /> {t('voice.start')}
                </button>
                {!!info?.voices.length && (
                  <label className="flex items-center gap-2 text-xs text-muted">
                    {t('voice.voice')}
                    <select
                      value={voice}
                      onChange={(e) => (setVoice(e.target.value), localStorage.setItem(VOICE_KEY, e.target.value))}
                      className="rounded-lg border border-line bg-surface px-2 py-1 text-ink"
                    >
                      <option value="">{t('voice.default')}</option>
                      {info.voices.map((v) => (
                        <option key={v} value={v}>
                          {v[0].toUpperCase() + v.slice(1)} · {t(FEMALE.has(v) ? 'voice.female' : 'voice.male')}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label className="flex items-center gap-2 text-sm text-ink">
                  <input
                    type="checkbox"
                    checked={control}
                    onChange={(e) => (setControl(e.target.checked), localStorage.setItem(CONTROL_KEY, e.target.checked ? 'on' : 'off'))}
                    className="size-4 accent-primary"
                  />
                  {t('voice.control')}
                </label>
                <p className="max-w-xs text-center text-xs text-muted">{t(control ? 'voice.controlHint' : 'voice.talkHint')}</p>
                <div className="flex items-center gap-1 rounded-full bg-surface p-1 text-xs ring-1 ring-line" role="radiogroup" aria-label={t('voice.look')}>
                  {(['galaxy', 'sun', 'orb'] as const).map((k) => (
                    <button
                      key={k}
                      type="button"
                      role="radio"
                      aria-checked={look === k}
                      onClick={() => (setLook(k), localStorage.setItem(LOOK_KEY, k))}
                      className={`rounded-full px-3 py-1 ${look === k ? 'bg-primary text-white' : 'text-muted'}`}
                    >
                      {t(k === 'galaxy' ? 'voice.lookGalaxy' : k === 'sun' ? 'voice.lookSun' : 'voice.lookOrb')}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-6">
                <button
                  type="button"
                  onClick={toggleMute}
                  disabled={!live}
                  aria-pressed={muted}
                  aria-label={t(muted ? 'voice.unmute' : 'voice.mute')}
                  className={`grid size-16 place-items-center rounded-full shadow active:scale-95 disabled:opacity-40 ${muted ? 'bg-amber-500 text-white' : 'bg-surface text-ink ring-1 ring-line'}`}
                >
                  {muted ? <MicOff24Filled /> : <Mic24Filled />}
                </button>
                <button
                  type="button"
                  onClick={() => void hangUp()}
                  aria-label={t('voice.end')}
                  className="grid size-16 place-items-center rounded-full bg-red-500 text-white shadow-lg active:scale-95"
                >
                  <CallEnd24Filled />
                </button>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
