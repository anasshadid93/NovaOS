import { useState } from 'react';

const PALETTE = ['#2f6fe4', '#0d9488', '#ea7a12', '#7c3aed', '#16a34a', '#e5484d', '#0ea5e9', '#475569'];

/** App logo from dashboard-icons (proxied and cached by the server), or a lettered tile. */
export function AppIcon({ icon, title, size = 56 }: { icon: string | null; title: string; size?: number }) {
  const [failed, setFailed] = useState(!icon);
  const style = { width: size, height: size };
  if (failed) {
    const color = PALETTE[[...title].reduce((a, c) => a + c.charCodeAt(0), 0) % PALETTE.length];
    return (
      <span className="inline-flex shrink-0 items-center justify-center rounded-tile font-semibold text-white" style={{ ...style, background: color, fontSize: size * 0.42 }} aria-hidden>
        {title.slice(0, 1).toUpperCase()}
      </span>
    );
  }
  // ArtCraft apps (including their server-run desktop builds) ship finished, rounded icons.
  if (icon?.startsWith('craft:'))
    return <img src={`/api/icons/craft/${encodeURIComponent(icon.slice(6))}`} alt="" loading="lazy" onError={() => setFailed(true)} style={{ ...style, minWidth: size }} className="shrink-0 object-contain" />;
  return (
    <span className="inline-flex shrink-0 items-center justify-center rounded-tile bg-surface shadow-card" style={style}>
      <img src={`/api/icons/${icon}`} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} style={{ width: size * 0.7, height: size * 0.7 }} className="object-contain" />
    </span>
  );
}
