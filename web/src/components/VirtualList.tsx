import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Fixed-row-height virtual list that scrolls with the page (window scroll),
 * so the sticky header and browser chrome behave normally on phones.
 */
export function VirtualList<T>({
  items,
  rowHeight,
  overscan = 8,
  getKey,
  render,
}: {
  items: T[];
  rowHeight: number;
  overscan?: number;
  getKey: (item: T) => string | number;
  render: (item: T) => ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState({ start: 0, end: 30 });

  useEffect(() => {
    let raf = 0;
    const update = () => {
      raf = 0;
      const node = ref.current;
      if (!node) return;
      const top = node.getBoundingClientRect().top;
      const start = Math.max(0, Math.floor(-top / rowHeight) - overscan);
      const end = Math.min(items.length, Math.ceil((window.innerHeight - top) / rowHeight) + overscan);
      setRange((r) => (r.start === start && r.end === end ? r : { start, end }));
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    addEventListener('scroll', onScroll, { passive: true });
    addEventListener('resize', onScroll);
    return () => {
      removeEventListener('scroll', onScroll);
      removeEventListener('resize', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [items.length, rowHeight, overscan]);

  return (
    <div ref={ref} role="list" style={{ height: items.length * rowHeight, position: 'relative' }}>
      {items.slice(range.start, range.end).map((item, i) => (
        <div key={getKey(item)} role="listitem" style={{ position: 'absolute', insetInline: 0, top: (range.start + i) * rowHeight, height: rowHeight }}>
          {render(item)}
        </div>
      ))}
    </div>
  );
}
