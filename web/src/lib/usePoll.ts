import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';

/** Fetches `url` now and every `ms` while the page is visible. */
export function usePoll<T>(url: string | null, ms: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const urlRef = useRef(url);
  urlRef.current = url;

  const load = useCallback(async () => {
    if (!urlRef.current) return;
    try {
      setData(await api<T>(urlRef.current));
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, []);

  useEffect(() => {
    if (!url) return;
    let timer: number | null = null;
    const tick = () => {
      void load();
      timer = window.setTimeout(tick, ms);
    };
    const onVis = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (document.visibilityState === 'visible') tick();
    };
    tick();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [url, ms, load]);

  return { data, error, reload: load };
}
