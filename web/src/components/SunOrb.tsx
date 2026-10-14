import { useEffect, useRef, type RefObject } from 'react';

/**
 * Voice-chat animation: a sun with planets and stars orbiting it, on a transparent background.
 *  - idle: slow, calm orbits;
 *  - you speak: the orbits turn the other way, faster the louder you are;
 *  - it thinks: the planets race and the sun breathes in and out (fades and grows);
 *  - it speaks: the sun's corona flares with its voice.
 * Plain 2D canvas, no libraries; everything is eased so changes never jump.
 */
export type SunState = 'idle' | 'listening' | 'userSpeaking' | 'thinking' | 'talking';

const PLANETS = [
  { r: 0.36, size: 0.028, speed: 1.0, color: ['#e0f2fe', '#38bdf8'], phase: 0.3 },
  { r: 0.5, size: 0.038, speed: 0.72, color: ['#fde68a', '#f59e0b'], phase: 2.1 },
  { r: 0.66, size: 0.032, speed: 0.52, color: ['#fecaca', '#ef4444'], phase: 4.0 },
  { r: 0.82, size: 0.046, speed: 0.38, color: ['#ddd6fe', '#8b5cf6'], phase: 5.2, ring: true },
];
const TILT = 0.42; // orbits are seen from slightly above: ellipses, planets pass behind the sun

export function SunOrb({ state, inputVolumeRef, outputVolumeRef, className }: { state: SunState; inputVolumeRef?: RefObject<number>; outputVolumeRef?: RefObject<number>; className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const cv = canvas.current!;
    const ctx = cv.getContext('2d')!;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    // Stars: fixed positions on a slowly turning sky, each with its own twinkle.
    const stars = Array.from({ length: 70 }, (_, i) => ({ a: Math.random() * Math.PI * 2, r: 0.3 + Math.random() * 0.7, s: 0.4 + Math.random() * 1.1, tw: Math.random() * 6, sp: 0.6 + (i % 5) * 0.12 }));
    let w = 0;
    let h = 0;
    const resize = () => {
      const dpr = Math.min(devicePixelRatio || 1, 2);
      w = cv.clientWidth;
      h = cv.clientHeight;
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(cv);

    // Eased values.
    let angle = 0;
    let dir = 1;
    let speed = 0.25;
    let pulse = 0; // 0..1 how much the sun "breathes"
    let flare = 0; // corona size from its voice
    let t = 0;
    let last = performance.now();
    let raf = 0;

    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      t += dt;
      const st = stateRef.current;
      const vin = Math.max(0, Math.min(1, inputVolumeRef?.current ?? 0));
      const vout = Math.max(0, Math.min(1, outputVolumeRef?.current ?? 0));
      const ease = (cur: number, to: number, k: number) => cur + (to - cur) * Math.min(1, dt * k);

      dir = ease(dir, st === 'userSpeaking' ? -1 : 1, 2.5);
      const targetSpeed = st === 'thinking' ? 1.9 : st === 'userSpeaking' ? 0.45 + vin * 1.4 : st === 'talking' ? 0.4 : st === 'listening' ? 0.3 : 0.18;
      speed = ease(speed, reduce ? targetSpeed * 0.3 : targetSpeed, 2);
      pulse = ease(pulse, st === 'thinking' ? 1 : 0, 3);
      flare = ease(flare, st === 'talking' ? 0.35 + vout * 0.9 : st === 'userSpeaking' ? 0.15 + vin * 0.3 : 0.1, 8);
      angle += dt * speed * dir;

      const cx = w / 2;
      const cy = h / 2;
      const R = Math.min(w, h) / 2;
      ctx.clearRect(0, 0, w, h);

      // Stars.
      for (const s of stars) {
        const a = s.a + angle * 0.15 * s.sp;
        const x = cx + Math.cos(a) * s.r * R;
        const y = cy + Math.sin(a) * s.r * R * 0.9;
        const alpha = 0.25 + 0.55 * (0.5 + 0.5 * Math.sin(t * (1.5 + s.sp) + s.tw));
        ctx.fillStyle = `rgba(148,163,255,${alpha.toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(x, y, s.s, 0, Math.PI * 2);
        ctx.fill();
      }

      // Orbit lines.
      ctx.lineWidth = 1;
      for (const p of PLANETS) {
        ctx.strokeStyle = 'rgba(148,163,184,0.22)';
        ctx.beginPath();
        ctx.ellipse(cx, cy, p.r * R, p.r * R * TILT, 0, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Planets: the ones on the far side are drawn before the sun (behind it).
      const placed = PLANETS.map((p) => {
        const a = p.phase + angle * p.speed * (1 + pulse * 0.6);
        return { p, x: cx + Math.cos(a) * p.r * R, y: cy + Math.sin(a) * p.r * R * TILT, front: Math.sin(a) > 0, depth: Math.sin(a) };
      });
      const drawPlanet = ({ p, x, y, depth }: (typeof placed)[number]) => {
        const size = p.size * R * (0.85 + 0.25 * (depth + 1) * 0.5);
        const g = ctx.createRadialGradient(x - size * 0.35, y - size * 0.35, size * 0.1, x, y, size);
        g.addColorStop(0, p.color[0]);
        g.addColorStop(1, p.color[1]);
        ctx.shadowColor = p.color[1];
        ctx.shadowBlur = size * 1.6;
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, size, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
        if (p.ring) {
          ctx.strokeStyle = 'rgba(221,214,254,0.7)';
          ctx.lineWidth = Math.max(1, size * 0.18);
          ctx.beginPath();
          ctx.ellipse(x, y, size * 1.9, size * 0.55, -0.35, 0, Math.PI * 2);
          ctx.stroke();
        }
      };
      placed.filter((x) => !x.front).forEach(drawPlanet);

      // The sun: breathes while thinking (fades and grows), flares while speaking.
      const breathe = pulse * (0.5 + 0.5 * Math.sin(t * 4.2));
      const sunR = R * (0.17 + 0.05 * breathe + 0.015 * Math.sin(t * 1.3));
      const sunAlpha = 1 - 0.45 * breathe;
      const corona = sunR * (1.9 + flare * 1.6 + breathe * 0.6);
      const cg = ctx.createRadialGradient(cx, cy, sunR * 0.6, cx, cy, corona);
      cg.addColorStop(0, `rgba(253,186,116,${(0.55 * sunAlpha).toFixed(3)})`);
      cg.addColorStop(0.45, `rgba(251,146,60,${(0.22 * sunAlpha).toFixed(3)})`);
      cg.addColorStop(1, 'rgba(251,146,60,0)');
      ctx.fillStyle = cg;
      ctx.beginPath();
      ctx.arc(cx, cy, corona, 0, Math.PI * 2);
      ctx.fill();
      // Soft rays, turning slowly.
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(t * 0.15 + angle * 0.2);
      for (let i = 0; i < 12; i++) {
        const len = sunR * (1.35 + 0.35 * flare + 0.18 * Math.sin(t * 2 + i * 1.7));
        ctx.rotate((Math.PI * 2) / 12);
        const rg = ctx.createLinearGradient(sunR * 0.8, 0, len, 0);
        rg.addColorStop(0, `rgba(254,215,170,${(0.5 * sunAlpha).toFixed(3)})`);
        rg.addColorStop(1, 'rgba(254,215,170,0)');
        ctx.fillStyle = rg;
        ctx.beginPath();
        ctx.moveTo(sunR * 0.8, -sunR * 0.09);
        ctx.lineTo(len, 0);
        ctx.lineTo(sunR * 0.8, sunR * 0.09);
        ctx.fill();
      }
      ctx.restore();
      const sg = ctx.createRadialGradient(cx - sunR * 0.3, cy - sunR * 0.3, sunR * 0.1, cx, cy, sunR);
      sg.addColorStop(0, `rgba(255,251,235,${sunAlpha.toFixed(3)})`);
      sg.addColorStop(0.45, `rgba(253,224,71,${sunAlpha.toFixed(3)})`);
      sg.addColorStop(1, `rgba(249,115,22,${sunAlpha.toFixed(3)})`);
      ctx.shadowColor = 'rgba(251,146,60,0.9)';
      ctx.shadowBlur = sunR * (0.8 + flare);
      ctx.fillStyle = sg;
      ctx.beginPath();
      ctx.arc(cx, cy, sunR, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;

      placed.filter((x) => x.front).forEach(drawPlanet);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [inputVolumeRef, outputVolumeRef]);

  return <canvas ref={canvas} className={className ?? 'size-full'} aria-hidden />;
}
