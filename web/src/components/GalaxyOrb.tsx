import { useEffect, useRef, type RefObject } from 'react';
import type { SunState } from './SunOrb';

/**
 * Voice-chat animation: a golden spiral galaxy (bright core, dusty arms, thousands of stars).
 *  - idle: turns slowly;
 *  - you speak: it turns the other way, faster the louder you are;
 *  - it thinks: it spins fast and the core breathes (fades and swells);
 *  - it speaks: the core flares with its voice;
 *  - any sound: the whole galaxy swells and spins with the loudness, and each word sends a ring
 *    out of the core (blue for you, gold for it).
 * The galaxy itself is drawn once into an offscreen canvas and only rotated per frame (cheap on
 * phones); a second, sparser star layer turns at another speed for depth, and the core glow is live.
 * The canvas is transparent. On a light page the galaxy is painted in deeper amber tones (light
 * gold would vanish on white); in dark mode it glows like the real thing.
 */
const ARMS = 2;
const TILT = 0.82; // seen slightly from the side

function rand(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Fades the outer rim so the galaxy never ends in a hard edge. */
const rim = (d: number) => (d >= 0.97 ? 0 : d < 0.7 ? 1 : (0.97 - d) / 0.27);
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(r() + 1e-9)) * Math.cos(2 * Math.PI * r());

/** Point on an arm: radius 0..1 → angle along a logarithmic-looking spiral, with scatter. */
function armPoint(r: () => number, radius: number, arm: number, spread: number) {
  const twist = 5.6;
  const a = (arm * Math.PI * 2) / ARMS + radius * twist + gauss(r) * spread * (0.25 + radius * 0.6);
  const d = radius + gauss(r) * spread * 0.05;
  return { x: Math.cos(a) * d, y: Math.sin(a) * d };
}

/** The galaxy body, drawn once: dust clouds, then stars, all with additive light. */
function paintGalaxy(size: number, light: boolean): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const R = size / 2;
  const r = rand(20261012);
  g.translate(R, R);
  // Adding light makes glow on black; on a light page it would wash out, so layers just stack there.
  const glow: GlobalCompositeOperation = light ? 'source-over' : 'lighter';
  g.globalCompositeOperation = glow;

  // Dust: soft warm clouds along the arms, brighter towards the middle.
  for (let i = 0; i < 1800; i++) {
    const radius = Math.pow(r(), 0.8) * 0.95;
    const p = armPoint(r, radius, i % ARMS, 0.55);
    const blob = R * (0.02 + r() * 0.05) * (0.6 + radius);
    const warm = 1 - radius;
    const col = light ? `${Math.round(200 + 45 * warm)},${Math.round(95 + 70 * warm)},${Math.round(10 + 30 * warm)}` : `${Math.round(200 + 55 * warm)},${Math.round(130 + 90 * warm)},${Math.round(60 + 110 * warm * warm)}`;
    const a = (light ? 0.075 : 0.1) * (1.25 - radius) * (0.5 + r()) * rim(Math.hypot(p.x, p.y));
    const gr = g.createRadialGradient(p.x * R, p.y * R, 0, p.x * R, p.y * R, blob);
    gr.addColorStop(0, `rgba(${col},${a.toFixed(3)})`);
    gr.addColorStop(1, `rgba(${col},0)`);
    g.fillStyle = gr;
    g.beginPath();
    g.arc(p.x * R, p.y * R, blob, 0, Math.PI * 2);
    g.fill();
  }
  // Filaments: thin glowing streaks that follow the spiral, the "swirl" of the arms.
  g.lineCap = 'round';
  for (let i = 0; i < 260; i++) {
    const r0 = 0.08 + Math.pow(r(), 0.8) * 0.62;
    const len = Math.min(0.12 + r() * 0.26, 0.86 - r0);
    const arm = i % ARMS;
    const off = gauss(r) * 0.28;
    const warm = Math.max(0, 1 - r0);
    g.strokeStyle = light
      ? `rgba(${Math.round(190 + 40 * warm)},${Math.round(100 + 60 * warm)},20,${(0.06 + r() * 0.08).toFixed(3)})`
      : `rgba(255,${Math.round(190 + 50 * warm)},${Math.round(120 + 90 * warm)},${(0.035 + r() * 0.05).toFixed(3)})`;
    g.lineWidth = R * (0.003 + r() * 0.009) * (1.2 - r0 * 0.5);
    g.beginPath();
    for (let k = 0; k <= 14; k++) {
      const rad = r0 + (len * k) / 14;
      const a = (arm * Math.PI * 2) / ARMS + rad * 5.6 + off * (0.3 + rad * 0.6);
      const x = Math.cos(a) * rad * R;
      const y = Math.sin(a) * rad * R;
      if (k) g.lineTo(x, y);
      else g.moveTo(x, y);
    }
    g.stroke();
  }
  // Stars: dense in the arms and the bulge, a few scattered between.
  g.globalCompositeOperation = glow;
  for (let i = 0; i < 7000; i++) {
    const inArm = r() < 0.82;
    const radius = inArm ? Math.pow(r(), 0.9) * 0.98 : r() * 0.98;
    const p = inArm ? armPoint(r, radius, i % ARMS, 0.45) : { x: Math.cos(r() * 6.283) * radius, y: Math.sin(r() * 6.283) * radius };
    const warm = Math.max(0, 1 - radius * 1.3);
    const s = (r() < 0.04 ? 1.4 : 0.55) * (size / 700) * (0.6 + r());
    const a = (0.35 + r() * 0.65) * (inArm ? 1 : 0.5) * rim(Math.hypot(p.x, p.y));
    g.fillStyle = light ? `rgba(${Math.round(150 + 60 * warm)},${Math.round(80 + 70 * warm)},${Math.round(10 + 20 * warm)},${a.toFixed(3)})` : `rgba(255,${Math.round(225 + 25 * warm)},${Math.round(190 + 50 * warm)},${a.toFixed(3)})`;
    g.fillRect(p.x * R - s / 2, p.y * R - s / 2, s, s);
  }
  // The bulge.
  const core = g.createRadialGradient(0, 0, 0, 0, 0, R * 0.42);
  core.addColorStop(0, light ? 'rgba(253,224,71,0.9)' : 'rgba(255,248,230,0.85)');
  core.addColorStop(0.25, light ? 'rgba(245,158,11,0.45)' : 'rgba(255,214,150,0.45)');
  core.addColorStop(0.6, light ? 'rgba(217,119,6,0.12)' : 'rgba(230,150,70,0.12)');
  core.addColorStop(1, 'rgba(200,120,50,0)');
  g.fillStyle = core;
  g.beginPath();
  g.arc(0, 0, R * 0.42, 0, Math.PI * 2);
  g.fill();
  return c;
}

/** Sparse bright stars for the second layer. */
function paintStars(size: number, light: boolean): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const R = size / 2;
  const r = rand(77);
  g.translate(R, R);
  for (let i = 0; i < 260; i++) {
    const radius = Math.sqrt(r()) * 0.9;
    const p = armPoint(r, radius, i % ARMS, 1.4);
    const s = (size / 700) * (1 + r() * 1.6);
    const gr = g.createRadialGradient(p.x * R, p.y * R, 0, p.x * R, p.y * R, s * 2.5);
    gr.addColorStop(0, light ? 'rgba(217,119,6,0.9)' : 'rgba(255,250,240,0.95)');
    gr.addColorStop(1, light ? 'rgba(245,158,11,0)' : 'rgba(255,230,190,0)');
    g.fillStyle = gr;
    g.beginPath();
    g.arc(p.x * R, p.y * R, s * 2.5, 0, Math.PI * 2);
    g.fill();
  }
  return c;
}

export function GalaxyOrb({ state, inputVolumeRef, outputVolumeRef, className }: { state: SunState; inputVolumeRef?: RefObject<number>; outputVolumeRef?: RefObject<number>; className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const cv = canvas.current!;
    const ctx = cv.getContext('2d')!;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let w = 0;
    let h = 0;
    let body: HTMLCanvasElement | null = null;
    let light = !document.documentElement.classList.contains('dark');
    let stars: HTMLCanvasElement | null = null;
    const resize = () => {
      // Soft glow needs no retina sharpness: fewer pixels keeps phones cool (and the call smooth).
      const dpr = Math.min(devicePixelRatio || 1, 1.25);
      w = cv.clientWidth;
      h = cv.clientHeight;
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const px = Math.round(Math.min(w, h) * dpr);
      const nowLight = !document.documentElement.classList.contains('dark');
      if (!body || Math.abs(body.width - px) > 40 || nowLight !== light) {
        light = nowLight;
        body = paintGalaxy(px, light);
        stars = paintStars(px, light);
      }
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(cv);

    let angle = 0;
    let angle2 = 0;
    let dir = 1;
    let speed = 0.12;
    let pulse = 0;
    let flare = 0;
    // Live reaction to sound: `level` follows the loudness closely, `slow` lags behind it, and a
    // jump of `level` over `slow` (the start of a word) sends a ring out from the core.
    let level = 0;
    let slow = 0;
    let lastRing = 0;
    const rings: { r: number; a: number; user: boolean }[] = [];
    let t = 0;
    let last = performance.now();
    let raf = 0;

    const frame = (now: number) => {
      // 30 frames a second is plenty for a slow swirl.
      if (now - last < 31) {
        raf = requestAnimationFrame(frame);
        return;
      }
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      t += dt;
      const st = stateRef.current;
      const vin = Math.max(0, Math.min(1, inputVolumeRef?.current ?? 0));
      const vout = Math.max(0, Math.min(1, outputVolumeRef?.current ?? 0));
      const ease = (cur: number, to: number, k: number) => cur + (to - cur) * Math.min(1, dt * k);
      dir = ease(dir, st === 'userSpeaking' ? -1 : 1, 2);
      const target = st === 'thinking' ? 1.6 : st === 'userSpeaking' ? 0.25 + vin * 1.0 : st === 'talking' ? 0.22 : st === 'listening' ? 0.16 : 0.1;
      speed = ease(speed, reduce ? target * 0.3 : target, 1.8);
      pulse = ease(pulse, st === 'thinking' ? 1 : 0, 2.5);
      flare = ease(flare, st === 'talking' ? 0.3 + vout * 1.0 : st === 'userSpeaking' ? 0.1 + vin * 0.4 : 0.05, 7);
      const loud = Math.max(vin, vout);
      const userLoud = vin >= vout;
      level = ease(level, loud, 14);
      slow = ease(slow, loud, 2.5);
      // Loud moments give the spin a push (in the current direction).
      angle += dt * (speed + level * 0.9) * dir;
      angle2 += dt * (speed + level * 0.6) * dir * 0.72;

      const cx = w / 2;
      const cy = h / 2;
      const R = Math.min(w, h) / 2;
      ctx.clearRect(0, 0, w, h);

      const breathe = pulse * (0.5 + 0.5 * Math.sin(t * 3.6));
      const scale = 1 + breathe * 0.05 + flare * 0.02 + level * 0.13;
      const draw = (img: HTMLCanvasElement | null, a: number, alpha: number, op: GlobalCompositeOperation) => {
        if (!img) return;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.scale(scale, scale * TILT);
        ctx.rotate(a);
        ctx.globalAlpha = alpha;
        ctx.globalCompositeOperation = op;
        const s = R * 0.98;
        ctx.drawImage(img, -s, -s, s * 2, s * 2);
        ctx.restore();
      };
      draw(body, angle, 1, 'source-over');
      draw(stars, angle2, Math.min(1, 0.55 + 0.25 * Math.sin(t * 0.9) + level * 0.5), light ? 'source-over' : 'lighter');

      // Rings: blue when you speak, gold when it speaks; they grow out and fade.
      if (level - slow > 0.1 && t - lastRing > 0.22 && level > 0.12) {
        rings.push({ r: R * 0.18, a: Math.min(0.75, 0.3 + level), user: userLoud });
        lastRing = t;
        if (rings.length > 8) rings.shift();
      }
      for (let i = rings.length - 1; i >= 0; i--) {
        const g = rings[i];
        g.r += dt * R * 0.85;
        g.a -= dt * 0.75;
        if (g.a <= 0 || g.r > R * 1.05) {
          rings.splice(i, 1);
          continue;
        }
        ctx.save();
        ctx.globalCompositeOperation = light ? 'source-over' : 'lighter';
        ctx.strokeStyle = g.user ? `rgba(56,189,248,${g.a.toFixed(3)})` : light ? `rgba(217,119,6,${g.a.toFixed(3)})` : `rgba(255,214,150,${g.a.toFixed(3)})`;
        ctx.lineWidth = Math.max(1, R * 0.012 * (1 - g.r / (R * 1.1)) + 1);
        ctx.shadowColor = g.user ? 'rgba(56,189,248,0.8)' : 'rgba(245,158,11,0.8)';
        ctx.shadowBlur = R * 0.04;
        ctx.beginPath();
        ctx.ellipse(cx, cy, g.r, g.r * TILT, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      // The core: breathes while thinking, flares while it speaks.
      const coreR = R * (0.16 + breathe * 0.1 + flare * 0.1 + level * 0.14);
      const coreA = Math.min(1, 0.7 + flare * 0.4 + level * 0.6) * (1 - breathe * 0.45);
      ctx.save();
      ctx.globalCompositeOperation = light ? 'source-over' : 'lighter';
      const cg = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR * 2.4);
      cg.addColorStop(0, light ? `rgba(255,251,235,${coreA.toFixed(3)})` : `rgba(255,252,240,${coreA.toFixed(3)})`);
      cg.addColorStop(0.18, light ? `rgba(253,224,71,${(coreA * 0.8).toFixed(3)})` : `rgba(255,236,190,${(coreA * 0.75).toFixed(3)})`);
      cg.addColorStop(0.5, light ? `rgba(245,158,11,${(coreA * 0.3).toFixed(3)})` : `rgba(255,190,110,${(coreA * 0.28).toFixed(3)})`);
      cg.addColorStop(1, 'rgba(255,170,90,0)');
      ctx.fillStyle = cg;
      ctx.beginPath();
      ctx.ellipse(cx, cy, coreR * 2.4, coreR * 2.4 * TILT, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
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
