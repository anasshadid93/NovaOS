import type { ComponentType } from 'react';

type Glyph = ComponentType<{ className?: string; style?: React.CSSProperties; 'aria-hidden'?: boolean }>;

/**
 * Phone-style app icon (original artwork, not copied from any vendor):
 *  - "gradient": full-bleed squircle with a vertical gradient, soft top gloss and a white glyph
 *  - "white":    white squircle with a colourful 3D Fluent Emoji (MIT)
 *  - "fluent":   white squircle with a Fluent 2 multicolour ("Color") system icon (MIT)
 */
export type Art =
  | { kind: 'gradient'; from: string; to: string; glyph: Glyph; glyphColor?: string; img?: never }
  | { kind: 'gradient'; from: string; to: string; img: string; glyph?: never; glyphColor?: never }
  | { kind: 'white'; img: string }
  /** Fluent 2 "Color" system icon (MIT) on a white squircle, like Fluent product icons. */
  | { kind: 'fluent'; glyph: Glyph };

export function AppArt({ art, size = 60 }: { art: Art; size?: number }) {
  const radius = size * 0.24; // squircle-ish corner like phone launchers
  const box: React.CSSProperties = { width: size, height: size, borderRadius: radius };
  if (art.kind === 'fluent') {
    const F = art.glyph;
    return (
      <span
        className="tile-face relative inline-flex shrink-0 items-center justify-center overflow-hidden bg-white shadow-[0_1px_2px_rgb(0_0_0/0.06),0_4px_12px_rgb(15_23_42/0.10)] ring-1 ring-black/5 dark:bg-[#f4f6fa]"
        style={box}
      >
        <F aria-hidden className="tile-img" style={{ width: size * 0.64, height: size * 0.64, filter: 'drop-shadow(0 2px 3px rgb(15 23 42 / 0.15))' }} />
      </span>
    );
  }
  if (art.kind === 'white')
    return (
      <span
        className="tile-face relative inline-flex shrink-0 items-center justify-center overflow-hidden bg-white shadow-[0_1px_2px_rgb(0_0_0/0.06),0_4px_10px_rgb(15_23_42/0.10)] ring-1 ring-black/5 dark:bg-[#f4f6fa]"
        style={box}
      >
        <img src={`/icons3d/${art.img}.png`} alt="" draggable={false} className="tile-img select-none" style={{ width: size * 0.72, height: size * 0.72 }} />
      </span>
    );
  const G = art.glyph;
  return (
    <span
      className="tile-face relative inline-flex shrink-0 items-center justify-center overflow-hidden shadow-[0_2px_4px_rgb(0_0_0/0.10),0_6px_14px_rgb(15_23_42/0.18)]"
      style={{ ...box, background: `linear-gradient(180deg, ${art.from} 0%, ${art.to} 100%)` }}
    >
      {/* glossy highlight on the top half */}
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-1/2" style={{ background: 'linear-gradient(180deg, rgb(255 255 255 / 0.28), rgb(255 255 255 / 0))' }} />
      {G ? (
        <G aria-hidden className="tile-img relative" style={{ width: size * 0.56, height: size * 0.56, color: art.glyphColor ?? '#fff', filter: 'drop-shadow(0 2px 2px rgb(0 0 0 / 0.25))' }} />
      ) : (
        <img src={`/icons3d/${art.img}.png`} alt="" draggable={false} className="tile-img relative select-none" style={{ width: size * 0.74, height: size * 0.74 }} />
      )}
    </span>
  );
}
