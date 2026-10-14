import { useEffect, useState } from 'react';
import { useSearch } from 'wouter';
import { api } from '../lib/api';
import { list, parentOf, type Entry } from '../lib/fm';
import { useI18n } from '../i18n';
import { Preview } from '../components/fm/Preview';
import { useWindowCtx } from '../desktop/context';
import { wm } from '../desktop/wm';

const VIEWABLE = new Set(['images', 'videos', 'audio', 'documents']);

/** Desktop: a photo/video/PDF viewer window. Arrows step through the other files in the same folder. */
export function Viewer() {
  const { t } = useI18n();
  const path = new URLSearchParams(useSearch()).get('path') ?? '';
  const win = useWindowCtx();
  const [items, setItems] = useState<Entry[] | null>(null);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    let alive = true;
    list(parentOf(path), false)
      .then((r) => {
        if (!alive) return;
        const files = r.entries.filter((e) => e.type === 'file' && e.cat && VIEWABLE.has(e.cat));
        const i = files.findIndex((e) => e.path === path);
        setItems(files);
        setIndex(Math.max(0, i));
      })
      .catch(() => alive && setItems([]));
    return () => {
      alive = false;
    };
  }, [path]);

  useEffect(() => {
    const e = items?.[index];
    if (win && e) wm.setTitle(win.id, e.name);
  }, [items, index, win]);

  if (!items) return <p className="p-6 text-center text-sm text-muted">{t('common.loading')}</p>;
  if (!items.length) return <p className="p-6 text-center text-sm text-muted">{t('fm.err.generic')}</p>;
  return (
    <Preview
      items={items}
      index={index}
      onIndex={setIndex}
      onClose={() => win && wm.close(win.id)}
      onDelete={async (e) => {
        await api('/api/fs/delete', { body: { paths: [e.path] } });
        const rest = items.filter((x) => x.path !== e.path);
        if (!rest.length && win) return wm.close(win.id);
        setItems(rest);
        setIndex((i) => Math.min(i, rest.length - 1));
      }}
    />
  );
}
