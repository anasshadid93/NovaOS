import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { fileUrl } from '../../lib/fm';
import { useI18n } from '../../i18n';
import { fmt } from '../NowPlaying';

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const q = (p: string) => encodeURIComponent(p);

/**
 * A video with: resume where you stopped, subtitles from a .srt/.vtt next to it, playback
 * speed, and formats the browser can't play (MKV/HEVC/AVI…) converted live on the server's GPU.
 * Converted streams can't seek by themselves, so seeking restarts the stream at that time
 * (`offset`) and the bar shows the real position.
 */
export function VideoPlayer({ path }: { path: string }) {
  const { t } = useI18n();
  const ref = useRef<HTMLVideoElement>(null);
  const [mode, setMode] = useState<'direct' | 'transcode'>('direct');
  const [offset, setOffset] = useState(0);
  const [duration, setDuration] = useState(0);
  const [now, setNow] = useState(0);
  const [resumed, setResumed] = useState<number | null>(null);
  const [subs, setSubs] = useState<{ path: string; label: string }[]>([]);
  const [speed, setSpeed] = useState(1);
  const start = useRef(0);

  // New file: reset, then look up where we stopped and its subtitles.
  useEffect(() => {
    setMode('direct');
    setOffset(0);
    setResumed(null);
    setSubs([]);
    start.current = 0;
    let gone = false;
    void api<{ position: number }>(`/api/media/progress?path=${q(path)}`)
      .then((r) => {
        if (gone || r.position < 10) return;
        start.current = r.position;
        setResumed(r.position);
        const v = ref.current;
        if (v && v.readyState >= 1) v.currentTime = r.position;
      })
      .catch(() => undefined);
    void api<{ subs: { path: string; label: string }[] }>(`/api/media/subtitles?path=${q(path)}`)
      .then((r) => !gone && setSubs(r.subs))
      .catch(() => undefined);
    return () => {
      gone = true;
    };
  }, [path]);

  const position = () => offset + (ref.current?.currentTime ?? 0);
  const save = () => {
    const d = duration || ref.current?.duration || 0;
    if (!Number.isFinite(d) || d <= 0) return;
    void api('/api/media/progress', {
      method: 'PUT',
      body: { path, position: position(), duration: d },
    }).catch(() => undefined);
  };
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const id = setInterval(() => !ref.current?.paused && saveRef.current(), 10_000);
    return () => {
      clearInterval(id);
      saveRef.current();
    };
  }, [path]);

  const toTranscode = async (at: number) => {
    if (!duration) {
      const p = await api<{ duration: number }>(`/api/media/probe?path=${q(path)}`).catch(() => ({ duration: 0 }));
      setDuration(p.duration);
    }
    setOffset(Math.max(0, Math.floor(at)));
    setMode('transcode');
  };

  const src = mode === 'direct' ? fileUrl(path) : `/api/media/transcode?path=${q(path)}&t=${offset}`;

  return (
    <div className="relative flex h-full max-h-full w-full flex-col items-center justify-center gap-2">
      <video
        key={`${mode}:${offset}`}
        ref={ref}
        src={src}
        controls
        autoPlay
        playsInline
        className="min-h-0 w-full flex-1 object-contain"
        onLoadedMetadata={(e) => {
          const v = e.currentTarget;
          v.playbackRate = speed;
          if (mode === 'direct') {
            if (Number.isFinite(v.duration)) setDuration(v.duration);
            if (start.current) v.currentTime = start.current;
            // Plays the audio but no picture (e.g. HEVC in Firefox): convert.
            if (v.videoWidth === 0) setTimeout(() => v.videoWidth === 0 && void toTranscode(start.current), 1500);
          }
        }}
        onTimeUpdate={() => setNow(position())}
        onPause={save}
        onError={() => mode === 'direct' && void toTranscode(start.current || ref.current?.currentTime || 0)}
      >
        {subs.map((s, i) => (
          <track
            key={s.path}
            kind="subtitles"
            src={`/api/media/subtitle?path=${q(s.path)}`}
            label={s.label}
            default={i === 0}
            onLoad={(e) => {
              // The converted stream starts at 0, the subtitles at the real time.
              const cues = e.currentTarget.track.cues;
              if (!offset || !cues) return;
              for (const c of Array.from(cues)) {
                c.startTime -= offset;
                c.endTime -= offset;
              }
            }}
          />
        ))}
      </video>

      <div className="flex w-full max-w-3xl flex-wrap items-center gap-2 px-2 text-xs text-white/80">
        {mode === 'transcode' && (
          <>
            <span className="rounded bg-white/10 px-2 py-0.5">{t('video.converting')}</span>
            <span className="flex min-w-[200px] flex-1 items-center gap-2 tabular-nums" dir="ltr">
              {fmt(now) || '0:00'}
              <input
                type="range"
                min={0}
                max={duration || 0}
                step={1}
                value={now}
                onChange={(e) => setNow(Number(e.target.value))}
                onPointerUp={(e) => setOffset(Math.floor(Number(e.currentTarget.value)))}
                onKeyUp={(e) => setOffset(Math.floor(Number(e.currentTarget.value)))}
                className="flex-1"
                aria-label={t('music.seek')}
              />
              {fmt(duration)}
            </span>
          </>
        )}
        {resumed !== null && (
          <span className="inline-flex items-center gap-2">
            {t('video.resumed', { time: fmt(resumed) })}
            <button
              type="button"
              className="rounded-full bg-white/15 px-2.5 py-1 text-white hover:bg-white/25"
              onClick={() => {
                setResumed(null);
                start.current = 0;
                if (mode === 'transcode') setOffset(0);
                else if (ref.current) ref.current.currentTime = 0;
              }}
            >
              {t('video.startOver')}
            </button>
          </span>
        )}
        <label className="ms-auto inline-flex items-center gap-1.5">
          {t('video.speed')}
          <select
            value={speed}
            onChange={(e) => {
              const s = Number(e.target.value);
              setSpeed(s);
              if (ref.current) ref.current.playbackRate = s;
            }}
            className="rounded bg-white/10 px-1.5 py-0.5 text-white"
          >
            {SPEEDS.map((s) => (
              <option key={s} value={s} className="text-black">
                {s}×
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}
