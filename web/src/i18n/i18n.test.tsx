import { describe, expect, it, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { en } from './en';
import { ar } from './ar';
import { I18nProvider, translate, useI18n } from '.';

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('translate', () => {
  it('interpolates variables', () => {
    expect(translate(en, 'home.greeting', { name: 'anas' })).toBe('Hello, anas');
  });

  it('leaves unknown placeholders visible', () => {
    expect(translate(en, 'home.greeting')).toBe('Hello, {name}');
  });
});

describe('Arabic dictionary', () => {
  it('translates every English key', () => {
    const missing = Object.keys(en).filter((k) => !(k in ar));
    expect(missing).toEqual([]);
  });

  it('keeps the same placeholders as English', () => {
    const bad = Object.keys(en).filter((k) => {
      if (/\.(one|two|few|many|zero)$/.test(k)) return false; // Arabic singular/dual forms drop {n}
      return placeholders(ar[k]).join() !== placeholders(en[k as keyof typeof en]).join();
    });
    expect(bad).toEqual([]);
  });

  it('has no leftover English UI sentences', () => {
    const latinOnly = Object.entries(ar).filter(([k, v]) => /^[A-Za-z ,.!?’'-]{12,}$/.test(v) && !k.startsWith('settings.tailscale') && k !== 'app.name'); // brand name stays Latin
    expect(latinOnly).toEqual([]);
  });
});

function Probe({ n }: { n: number }) {
  const { t, tn, dir, setLocale } = useI18n();
  return (
    <div>
      <p data-testid="out">
        {t('app.name')}|{dir}|{tn('files.count', n)}
      </p>
      <button onClick={() => setLocale('ar')}>ar</button>
      <button onClick={() => setLocale('en')}>en</button>
    </div>
  );
}

describe('I18nProvider', () => {
  beforeEach(() => localStorage.clear());

  it('sets lang and dir on <html> and switches to RTL Arabic', () => {
    render(
      <I18nProvider>
        <Probe n={3} />
      </I18nProvider>,
    );
    expect(screen.getByTestId('out').textContent).toBe('MinisManager|ltr|3 files');
    expect(document.documentElement.dir).toBe('ltr');
    act(() => screen.getByText('ar').click());
    expect(screen.getByTestId('out').textContent).toBe('MinisManager|rtl|3 ملفات');
    expect(document.documentElement.lang).toBe('ar');
    expect(document.documentElement.dir).toBe('rtl');
    expect(localStorage.getItem('manar.locale')).toBe('ar');
  });

  it.each([
    [1, 'ملف واحد'],
    [2, 'ملفان'],
    [5, '5 ملفات'],
    [11, '11 ملفًا'],
    [100, '100 ملف'],
  ])('Arabic plural for %i', (n, expected) => {
    localStorage.setItem('manar.locale', 'ar');
    render(
      <I18nProvider>
        <Probe n={n} />
      </I18nProvider>,
    );
    expect(screen.getByTestId('out').textContent).toBe(`MinisManager|rtl|${expected}`);
  });
});
