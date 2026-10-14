import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { I18nProvider } from '../i18n';
import { ConfirmProvider, useConfirm } from './ConfirmProvider';
import { VirtualList } from './VirtualList';
import { formatBytes as fb, formatDuration as fd, formatPct as fp } from '../lib/format';

// Formatters wrap values in bidi isolates for RTL; compare the visible text.
const strip = (s: string) => s.replace(/[\u2066-\u2069]/g, '');
const formatBytes = (n: number | null) => strip(fb(n));
const formatDuration = (n: number) => strip(fd(n));
const formatPct = (n: number) => strip(fp(n));

describe('formatters', () => {
  it('formats bytes, durations and percentages', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(60 * 1024 ** 3)).toBe('60.0 GB');
    expect(formatBytes(null)).toBe('—');
    expect(formatDuration(59)).toBe('59s');
    expect(formatDuration(3 * 86400 + 4 * 3600)).toBe('3d 4h');
    expect(formatPct(12.345)).toBe('12.3%');
    expect(fb(1536)).toBe('\u20661.5 KB\u2069');
  });
});

function AskButton({ onResult }: { onResult: (v: boolean) => void }) {
  const ask = useConfirm();
  return (
    <button onClick={() => void ask({ title: 'Delete jellyfin?', typeToConfirm: 'jellyfin', confirmLabel: 'Delete', danger: true }).then(onResult)}>open</button>
  );
}

describe('ConfirmProvider', () => {
  it('requires typing the exact name before a destructive confirm', async () => {
    let result: boolean | null = null;
    render(
      <I18nProvider>
        <ConfirmProvider>
          <AskButton onResult={(v) => (result = v)} />
        </ConfirmProvider>
      </I18nProvider>,
    );
    act(() => screen.getByText('open').click());
    const confirm = screen.getByText('Delete').closest('button')!;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('jellyfin'), { target: { value: 'jelly' } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('jellyfin'), { target: { value: 'jellyfin' } });
    expect(confirm.disabled).toBe(false);
    await act(async () => confirm.click());
    expect(result).toBe(true);
  });
});

describe('VirtualList', () => {
  it('renders only the visible window of a long list', () => {
    const items = Array.from({ length: 5000 }, (_, i) => i);
    render(<VirtualList items={items} rowHeight={60} getKey={(i) => i} render={(i) => <span>row {i}</span>} />);
    const rows = screen.getAllByRole('listitem');
    expect(rows.length).toBeLessThan(60);
    expect(screen.getByText('row 0')).toBeTruthy();
    expect(screen.queryByText('row 4999')).toBeNull();
  });
});
