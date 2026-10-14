import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Add24Regular, ArrowRotateClockwise24Regular, ArrowFit24Regular, Subtract24Regular } from '@fluentui/react-icons';
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { useI18n } from '../../i18n';

GlobalWorkerOptions.workerSrc = workerUrl;

// Browsers refuse (or silently blank) very large canvases — iOS Safari tops out around 16.7 MP.
// Big drawing sheets at high zoom are rendered at a lower density instead of failing.
const MAX_PIXELS = 16_000_000;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;
const GAP = 12;

type Size = { w: number; h: number };

/**
 * PDF viewer (pdf.js, all in the browser): continuous pages, zoom (buttons, pinch, Ctrl+wheel),
 * fit to width, rotate, jump to page. Only pages near the screen are drawn, so big sets
 * of drawings stay light; pages re-draw sharp after a zoom.
 */
export default function PdfViewer({ src }: { src: string }) {
  const { t } = useI18n();
  const scroller = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [sizes, setSizes] = useState<Size[]>([]); // page sizes at zoom 1 (PDF points), after rotation
  const [zoom, setZoom] = useState(0); // 0 = not fitted yet
  const [rotation, setRotation] = useState(0);
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');
  const [pageInput, setPageInput] = useState('');
  const fitted = useRef(false);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  // Load the document and every page's size (cheap: no drawing).
  useEffect(() => {
    let alive = true;
    const task = getDocument({
      url: src,
      cMapUrl: '/pdfjs/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/pdfjs/standard_fonts/',
      wasmUrl: '/pdfjs/wasm/',
      iccUrl: '/pdfjs/iccs/',
      withCredentials: true,
    });
    setDoc(null);
    setSizes([]);
    setError('');
    fitted.current = false;
    setZoom(0);
    setPage(1);
    task.promise
      .then(async (d) => {
        const out: Size[] = [];
        for (let i = 1; i <= d.numPages; i++) {
          const vp = (await d.getPage(i)).getViewport({ scale: 1 });
          out.push({ w: vp.width, h: vp.height });
        }
        if (!alive) return;
        setDoc(d);
        setSizes(out);
      })
      .catch((e: Error) => alive && setError(e?.message || 'error'));
    return () => {
      alive = false;
      task.destroy();
    };
  }, [src]);

  const rotated = useCallback((s: Size) => (rotation % 180 ? { w: s.h, h: s.w } : s), [rotation]);

  const fitWidth = useCallback(() => {
    const el = scroller.current;
    if (!el || !sizes.length) return;
    const widest = Math.max(...sizes.map((s) => rotated(s).w));
    setZoom(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, (el.clientWidth - 2 * GAP) / widest)));
  }, [sizes, rotated]);

  useLayoutEffect(() => {
    if (sizes.length && !fitted.current) {
      fitted.current = true;
      fitWidth();
    }
  }, [sizes, fitWidth]);

  // Keep the point under the fingers/cursor still while zooming.
  const zoomAround = useCallback((next: number, cx?: number, cy?: number) => {
    const el = scroller.current;
    setZoom((z) => {
      const nz = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, next));
      if (el && z) {
        const r = el.getBoundingClientRect();
        const px = (cx ?? r.left + r.width / 2) - r.left;
        const py = (cy ?? r.top + r.height / 2) - r.top;
        const k = nz / z;
        requestAnimationFrame(() => {
          el.scrollLeft = (el.scrollLeft + px) * k - px;
          el.scrollTop = (el.scrollTop + py) * k - py;
        });
      }
      return nz;
    });
  }, []);

  // Ctrl/⌘ + wheel (and trackpad pinch, which browsers report as ctrl+wheel).
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoomAround(zoomRef.current * Math.exp(-e.deltaY / 300), e.clientX, e.clientY);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAround, doc]);

  // Pinch: scale the page stack with a CSS transform while the fingers move, then commit
  // the new zoom once (so pages are re-drawn sharp only at the end).
  const pinch = useRef<{ d0: number; cx: number; cy: number; k: number } | null>(null);
  const dist = (e: React.TouchEvent) => Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
  const onTouchStart = (e: React.TouchEvent) => {
    e.stopPropagation(); // the file viewer must not take this as a swipe to the next file
    if (e.touches.length === 2) pinch.current = { d0: dist(e), cx: (e.touches[0].clientX + e.touches[1].clientX) / 2, cy: (e.touches[0].clientY + e.touches[1].clientY) / 2, k: 1 };
  };
  const onTouchMove = (e: React.TouchEvent) => {
    const p = pinch.current;
    if (!p || e.touches.length !== 2 || !inner.current || !scroller.current) return;
    p.k = Math.max(MIN_ZOOM / zoom, Math.min(MAX_ZOOM / zoom, dist(e) / p.d0));
    const r = scroller.current.getBoundingClientRect();
    inner.current.style.transformOrigin = `${p.cx - r.left + scroller.current.scrollLeft}px ${p.cy - r.top + scroller.current.scrollTop}px`;
    inner.current.style.transform = `scale(${p.k})`;
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    e.stopPropagation();
    const p = pinch.current;
    if (!p || e.touches.length > 1) return;
    pinch.current = null;
    if (inner.current) inner.current.style.transform = '';
    if (Math.abs(p.k - 1) > 0.02) zoomAround(zoom * p.k, p.cx, p.cy);
  };

  // Current page = the one crossing the middle of the view.
  const offsets = useRef<number[]>([]);
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const mid = el.scrollTop + el.clientHeight / 2;
    let p = 1;
    for (let i = 0; i < offsets.current.length; i++) if (offsets.current[i] <= mid) p = i + 1;
    setPage(p);
  };

  const goTo = (n: number) => {
    const el = scroller.current;
    if (!el || !sizes.length) return;
    const p = Math.max(1, Math.min(sizes.length, n));
    el.scrollTo({ top: offsets.current[p - 1] - GAP });
  };

  if (error)
    return (
      <div className="flex flex-col items-center gap-3 text-center text-white">
        <p className="text-sm text-white/80">{t('fm.pdf.error')}</p>
        <a href={src} target="_blank" rel="noreferrer" className="rounded-xl bg-primary px-5 py-3 font-medium text-white">
          {t('fm.open')}
        </a>
      </div>
    );
  if (!doc) return <p className="text-sm text-white/70">{t('common.loading')}</p>;
  // (zoom is 0 for one frame: the scroller below must exist so fitWidth can measure it)

  let y = GAP;
  offsets.current = sizes.map((s) => {
    const top = y;
    y += rotated(s).h * zoom + GAP;
    return top;
  });
  const width = Math.max(...sizes.map((s) => rotated(s).w)) * zoom + 2 * GAP;

  const tb = 'inline-flex size-10 items-center justify-center rounded-full text-white active:bg-white/15 hover:bg-white/10';
  return (
    <div className="flex h-full w-full flex-col">
      <div ref={scroller} className="min-h-0 flex-1 touch-pan-x touch-pan-y overflow-auto overscroll-contain" onScroll={onScroll} onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd} onTouchCancel={onTouchEnd}>
        <div ref={inner} style={{ width, height: y, position: 'relative', margin: '0 auto' }}>
          {!!zoom && sizes.map((s, i) => {
            const r = rotated(s);
            return <PdfPage key={i} doc={doc} n={i + 1} top={offsets.current[i]} left={(width - r.w * zoom) / 2} w={r.w * zoom} h={r.h * zoom} zoom={zoom} rotation={rotation} root={scroller} />;
          })}
        </div>
      </div>
      <div className="flex items-center justify-center gap-1 pt-2 text-white" dir="ltr">
        <button type="button" className={tb} onClick={() => zoomAround(zoom / 1.25)} aria-label={t('fm.pdf.zoomOut')}>
          <Subtract24Regular aria-hidden />
        </button>
        <span className="w-14 text-center text-xs tabular-nums">{Math.round(zoom * 100)}%</span>
        <button type="button" className={tb} onClick={() => zoomAround(zoom * 1.25)} aria-label={t('fm.pdf.zoomIn')}>
          <Add24Regular aria-hidden />
        </button>
        <button type="button" className={tb} onClick={fitWidth} aria-label={t('fm.pdf.fit')}>
          <ArrowFit24Regular aria-hidden />
        </button>
        <button
          type="button"
          className={tb}
          onClick={() => {
            setRotation((r) => (r + 90) % 360);
            fitted.current = false; // re-fit for the new orientation
          }}
          aria-label={t('fm.pdf.rotate')}
        >
          <ArrowRotateClockwise24Regular aria-hidden />
        </button>
        <form
          className="ms-2 flex items-center gap-1 text-xs tabular-nums"
          onSubmit={(e) => {
            e.preventDefault();
            if (pageInput) goTo(Number(pageInput));
            setPageInput('');
          }}
        >
          <input
            inputMode="numeric"
            aria-label={t('fm.pdf.page')}
            value={pageInput}
            placeholder={String(page)}
            onChange={(e) => setPageInput(e.target.value.replace(/\D/g, ''))}
            className="w-10 rounded-md bg-white/10 px-1 py-1 text-center text-white placeholder:text-white"
          />
          <span className="text-white/70">/ {sizes.length}</span>
        </form>
      </div>
    </div>
  );
}

/** One page: a placeholder until it comes near the screen, then a canvas drawn at the current zoom. */
function PdfPage({ doc, n, top, left, w, h, zoom, rotation, root }: { doc: PDFDocumentProxy; n: number; top: number; left: number; w: number; h: number; zoom: number; rotation: number; root: React.RefObject<HTMLDivElement | null> }) {
  const holder = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(false);

  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setNear(e.isIntersecting), { root: root.current, rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  }, [root]);

  useEffect(() => {
    if (!near) return;
    let task: RenderTask | null = null;
    let alive = true;
    // Wait a moment so a burst of zoom steps draws once.
    const timer = setTimeout(async () => {
      const page = await doc.getPage(n);
      if (!alive || !canvas.current) return;
      const dpr = window.devicePixelRatio || 1;
      const base = page.getViewport({ scale: 1, rotation: (page.rotate + rotation) % 360 });
      let scale = zoom * dpr;
      const px = base.width * base.height * scale * scale;
      if (px > MAX_PIXELS) scale *= Math.sqrt(MAX_PIXELS / px);
      const vp = page.getViewport({ scale, rotation: (page.rotate + rotation) % 360 });
      const c = canvas.current;
      const off = document.createElement('canvas'); // draw off-screen, then swap: no white flash
      off.width = Math.floor(vp.width);
      off.height = Math.floor(vp.height);
      task = page.render({ canvas: off, viewport: vp });
      try {
        await task.promise;
      } catch {
        return; // cancelled
      }
      if (!alive) return;
      c.width = off.width;
      c.height = off.height;
      c.getContext('2d')?.drawImage(off, 0, 0);
    }, 120);
    return () => {
      alive = false;
      clearTimeout(timer);
      task?.cancel();
    };
  }, [near, doc, n, zoom, rotation]);

  return (
    <div ref={holder} className="absolute bg-white shadow-lg" style={{ top, left, width: w, height: h }}>
      <canvas ref={canvas} className="block h-full w-full" aria-label={`${n}`} />
    </div>
  );
}
