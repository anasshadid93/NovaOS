import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { en, type MessageKey } from './en';
import { ar } from './ar';
export type { MessageKey };

/**
 * Minimal i18n: typed keys, `{var}` interpolation, CLDR plurals, per-locale direction.
 * Components use logical CSS (ms/me/ps/pe/start/end) and `flip-rtl`, so RTL needs no layout changes.
 * `intl` is the locale used for numbers/dates: Arabic UI keeps Western digits (easier to read
 * for PIDs, ports and sizes) via the `-u-nu-latn` extension.
 */
type Dict = Record<MessageKey, string> & Record<string, string>;

export const LOCALES = {
  en: { label: 'English', dir: 'ltr', intl: 'en', dict: en as Dict },
  ar: { label: 'العربية', dir: 'rtl', intl: 'ar-u-nu-latn', dict: ar as Dict },
} as const satisfies Record<string, { label: string; dir: 'ltr' | 'rtl'; intl: string; dict: Dict }>;

export type Locale = keyof typeof LOCALES;
const STORAGE_KEY = 'manar.locale';

export function translate(dict: Dict, key: MessageKey | string, vars?: Record<string, string | number>): string {
  const msg = dict[key] ?? (en as Dict)[key] ?? key;
  return vars ? msg.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`)) : msg;
}

interface I18nValue {
  locale: Locale;
  /** BCP-47 tag for Intl/toLocaleString. */
  intl: string;
  dir: 'ltr' | 'rtl';
  setLocale: (l: Locale) => void;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
  /** Plural-aware: looks up `<key>.<rule>` (zero/one/two/few/many/other), falling back to `.other`. */
  tn: (key: string, n: number, vars?: Record<string, string | number>) => string;
  formatNumber: (n: number, opts?: Intl.NumberFormatOptions) => string;
  formatRelative: (ms: number) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

function initialLocale(): Locale {
  const saved = localStorage.getItem(STORAGE_KEY);
  return saved && saved in LOCALES ? (saved as Locale) : 'en';
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);
  const { dir, dict, intl } = LOCALES[locale];

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = dir;
  }, [locale, dir]);

  const setLocale = useCallback((l: Locale) => {
    localStorage.setItem(STORAGE_KEY, l);
    setLocaleState(l);
  }, []);

  const value = useMemo<I18nValue>(() => {
    const nf = new Map<string, Intl.NumberFormat>();
    const rtf = new Intl.RelativeTimeFormat(intl, { numeric: 'auto' });
    const pr = new Intl.PluralRules(intl);
    return {
      locale,
      intl,
      dir,
      setLocale,
      t: (key, vars) => translate(dict, key, vars),
      tn: (key, n, vars) => {
        const exact = `${key}.${pr.select(n)}` as MessageKey;
        const k = exact in dict ? exact : (`${key}.other` as MessageKey);
        return translate(dict, k, { n: new Intl.NumberFormat(intl).format(n), ...vars });
      },
      formatNumber: (n, opts) => {
        const k = JSON.stringify(opts ?? {});
        let f = nf.get(k);
        if (!f) nf.set(k, (f = new Intl.NumberFormat(intl, opts)));
        return f.format(n);
      },
      formatRelative: (ms) => {
        const diff = (ms - Date.now()) / 1000;
        const abs = Math.abs(diff);
        if (abs < 60) return rtf.format(Math.round(diff), 'second');
        if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
        if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
        return rtf.format(Math.round(diff / 86400), 'day');
      },
    };
  }, [locale, dir, dict, intl, setLocale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const v = useContext(I18nContext);
  if (!v) throw new Error('useI18n outside I18nProvider');
  return v;
}
