import { useEffect, useRef, useState } from 'react';
import { ArrowUpload20Regular, Checkmark16Filled } from '@fluentui/react-icons';
import { api } from '../lib/api';
import { thumbUrl, uploadTo } from '../lib/fm';
import { useIsDark } from '../lib/theme';
import { useI18n } from '../i18n';
import { PRESETS, setWallpaper, useWallpaper, wallpaperCss, type Wallpaper } from '../desktop/wallpaper';

interface Photo {
  path: string;
  mtime: number;
}

/** Desktop: pick the wallpaper — a built-in gradient, one of your photos, or a new upload. */
export function WallpaperPicker() {
  const { t } = useI18n();
  const dark = useIsDark();
  const current = useWallpaper();
  const [photos, setPhotos] = useState<Photo[] | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const loadPhotos = () =>
    api<{ items: Photo[] }>('/api/gallery?kind=photos&limit=60')
      .then((r) => setPhotos(r.items))
      .catch(() => setPhotos([]));
  useEffect(() => void loadPhotos(), []);

  const same = (w: Wallpaper) => JSON.stringify(w) === JSON.stringify(current);
  const tile = (on: boolean) => `relative aspect-video overflow-hidden rounded-xl ring-offset-2 ring-offset-canvas transition ${on ? 'ring-[3px] ring-primary' : 'ring-1 ring-line hover:ring-2 hover:ring-primary/50'}`;
  const check = (
    <span className="absolute end-1.5 top-1.5 inline-flex size-6 items-center justify-center rounded-full bg-primary text-white shadow">
      <Checkmark16Filled aria-hidden />
    </span>
  );

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const r = await uploadTo('files/Images', [file], () => {});
      if (r.saved[0]) await setWallpaper({ kind: 'file', path: r.saved[0] });
      void loadPhotos();
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  return (
    <main className="space-y-6 p-5">
      {/* Live preview */}
      <div className="mx-auto aspect-video max-w-xl overflow-hidden rounded-2xl shadow-[0_12px_40px_rgb(15_23_42/0.25)] ring-1 ring-line" style={{ background: wallpaperCss(current, dark) }}>
        <div className="flex h-full flex-col justify-end">
          <div className="h-6 bg-white/60 backdrop-blur dark:bg-black/40" />
        </div>
      </div>

      <section>
        <h2 className="mb-3 text-sm font-semibold text-heading">{t('wall.builtIn')}</h2>
        <div className="grid grid-cols-2 gap-3 @lg:grid-cols-4">
          {PRESETS.map((p) => {
            const w: Wallpaper = { kind: 'preset', id: p.id };
            return (
              <button key={p.id} type="button" onClick={() => void setWallpaper(w)} className="text-start">
                <span className={`${tile(same(w))} block`} style={{ background: dark ? p.dark : p.light }}>
                  {same(w) && check}
                </span>
                <span className="mt-1.5 block text-xs text-muted">{p.name}</span>
              </button>
            );
          })}
        </div>
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-heading">{t('wall.photos')}</h2>
          <button type="button" disabled={busy} onClick={() => input.current?.click()} className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60">
            <ArrowUpload20Regular aria-hidden />
            {busy ? t('common.loading') : t('wall.upload')}
          </button>
          <input ref={input} type="file" accept="image/*" hidden onChange={(e) => void upload(e.target.files?.[0])} />
        </div>
        {photos === null ? (
          <p className="text-sm text-muted">{t('common.loading')}</p>
        ) : photos.length === 0 ? (
          <p className="text-sm text-muted">{t('wall.noPhotos')}</p>
        ) : (
          <div className="grid grid-cols-3 gap-2 @lg:grid-cols-5">
            {photos.map((ph) => {
              const w: Wallpaper = { kind: 'file', path: ph.path };
              return (
                <button key={ph.path} type="button" onClick={() => void setWallpaper(w)} className={tile(same(w))} title={ph.path}>
                  <img src={thumbUrl(ph.path, ph.mtime)} alt="" loading="lazy" className="size-full object-cover" />
                  {same(w) && check}
                </button>
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}
