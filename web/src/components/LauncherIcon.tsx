import { Bot24Filled, BuildingFactory24Filled, Code24Filled, ArrowRepeatAll24Filled, Server24Filled } from '@fluentui/react-icons';
import { useState } from 'react';
import { AppIcon } from './AppIcon';
import { IconBadge, type TileColor } from './ui';
import { gpuStrong } from '../lib/gpu';
import { openExternal } from '../lib/external';

/** Used only if a service's own icon can't be fetched. */
const GLYPHS: Record<string, { icon: typeof Bot24Filled; color: TileColor }> = {
  nova: { icon: Bot24Filled, color: 'purple' },
  'nova-builder': { icon: BuildingFactory24Filled, color: 'orange' },
  infinity: { icon: ArrowRepeatAll24Filled, color: 'teal' },
  'n5-control': { icon: Server24Filled, color: 'blue' },
  'code-server': { icon: Code24Filled, color: 'sky' },
};

/**
 * The real icon published by a running service or installed app (the server reads it
 * from the app's own local port); `fallback` renders if none can be fetched.
 */
export function LiveIcon({ src, size = 60, fallback }: { src: string; size?: number; fallback: React.ReactNode }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <>{fallback}</>;
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center overflow-hidden bg-white shadow-[0_1px_2px_rgb(0_0_0/0.06),0_4px_10px_rgb(15_23_42/0.10)] ring-1 ring-black/5"
      style={{ width: size, height: size, minWidth: size, minHeight: size, borderRadius: size * 0.24 }}
    >
      {/* Fixed pixel size and eager loading: some browsers (Samsung Internet) never painted the
          percentage-sized, lazy version inside the scaled desktop. */}
      <img src={src} alt="" width={Math.round(size * 0.74)} height={Math.round(size * 0.74)} onError={() => setFailed(true)} style={{ width: Math.round(size * 0.74), height: Math.round(size * 0.74) }} className="tile-img object-contain" />
    </span>
  );
}

function ServiceIcon({ id, title, size }: { id: string; title: string; size: number }) {
  const g = GLYPHS[id] ?? { icon: Server24Filled, color: 'slate' as TileColor };
  return <LiveIcon src={`/api/icons/svc/${encodeURIComponent(id)}`} size={size} fallback={size === 60 ? <IconBadge icon={g.icon} color={g.color} /> : <AppIcon icon={null} title={title} size={size} />} />;
}

export function InstalledAppIcon({ id, title, size = 60 }: { id: string; title: string; size?: number }) {
  return <LiveIcon src={`/api/icons/app/${encodeURIComponent(id)}`} size={size} fallback={<AppIcon icon={null} title={title} size={size} />} />;
}

/** ArtCraft apps ship finished, rounded icons: shown edge to edge. */
function CraftIcon({ id, title, size }: { id: string; title: string; size: number }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <AppIcon icon={null} title={title} size={Math.round(size * 0.93)} />;
  return (
    <img
      src={`/api/icons/craft/${encodeURIComponent(id)}`}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      // Fixed square box: never stretched by a flex parent.
      style={{ width: size, height: size, minWidth: size, minHeight: size, aspectRatio: '1 / 1' }}
      className="tile-img shrink-0 object-contain drop-shadow-[0_4px_8px_rgb(15_23_42/0.18)]"
    />
  );
}

export interface LauncherItem {
  key: string;
  kind: 'service' | 'app';
  title: string;
  url: string | null;
  icon: string | null;
  status?: string;
  opens: number;
  hidden: boolean;
}

/** `size` draws the icon at that size directly (no CSS scaling, which some tablets render squashed). */
export function LauncherIcon({ item, size = 60 }: { item: Pick<LauncherItem, 'icon' | 'title'>; size?: number }) {
  if (item.icon?.startsWith('svc:')) return <ServiceIcon id={item.icon.slice(4)} title={item.title} size={size} />;
  if (item.icon?.startsWith('craft:')) return <CraftIcon id={item.icon.slice(6)} title={item.title} size={size} />;
  if (item.icon?.startsWith('app:')) return <InstalledAppIcon id={item.icon.slice(4)} title={item.title} size={size} />;
  const g = item.icon?.startsWith('glyph:') ? GLYPHS[item.icon.slice(6)] : undefined;
  return g && size === 60 ? <IconBadge icon={g.icon} color={g.color} /> : <AppIcon icon={item.icon} title={item.title} size={Math.round(size * 0.93)} />;
}

/**
 * ArtCraft apps whose browser build needs strong graphics. On weaker devices (phones, tablets)
 * their server-run version "<App> (the server)" opens instead, when it's installed.
 */
const HEAVY = /^craft:(filmcraft|vectorcraft|effectcraft|designcraft)$/;
const known = new Map<string, LauncherItem>();
/** Launcher lists register here so a heavy app can be swapped for its server-run twin. */
export function rememberItems(items: LauncherItem[]) {
  for (const i of items) known.set(i.key, i);
}
// The full list once, so even shortcuts on Home can find a heavy app's twin.
void fetch('/api/launcher', { credentials: 'same-origin' })
  .then((r) => (r.ok ? (r.json() as Promise<LauncherItem[]>) : []))
  .then(rememberItems)
  .catch(() => {});

export function resolveItem(item: LauncherItem): LauncherItem {
  if (!HEAVY.test(item.key) || gpuStrong() !== false) return item;
  return known.get(`app:${item.key.slice(6)}-desktop`) ?? item;
}

/** Records the open (for "frequently used") and opens the app in a new tab. */
export function openItem(original: LauncherItem) {
  const item = resolveItem(original);
  if (!item.url) return;
  void fetch('/api/launcher/open', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: item.key }) });
  openExternal(item.url);
}

export function LauncherTile({ item }: { item: LauncherItem }) {
  const [popping, setPopping] = useState(false);
  const open = () => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return openItem(item);
    setPopping(true);
    // Short pop, then open (still within the tap's user-activation window).
    setTimeout(() => {
      setPopping(false);
      openItem(item);
    }, 220);
  };
  return (
    <button
      type="button"
      onClick={open}
      disabled={!item.url}
      className={`tile-3d flex flex-col items-center gap-1.5 rounded-xl p-1 disabled:opacity-50 ${popping ? 'tile-pop' : ''}`}
    >
      <span className="tile-face">
        <LauncherIcon item={item} />
      </span>
      <span className="line-clamp-2 text-center text-xs leading-tight text-ink">{item.title}</span>
    </button>
  );
}
