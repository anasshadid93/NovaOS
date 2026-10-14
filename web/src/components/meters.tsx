/** Small, allocation-light gauges used across the monitor screens. */

export function levelColor(pct: number): string {
  return pct >= 90 ? 'var(--color-danger)' : pct >= 70 ? 'var(--color-warn)' : 'var(--color-primary)';
}

export function Ring({ value, label, size = 58 }: { value: number; label: string; size?: number }) {
  const stroke = 5;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(100, value));
  // Always show at least a sliver so idle cores still read as a gauge.
  const arc = Math.max(v, 1.5);
  return (
    <div className="flex flex-col items-center gap-1" role="img" aria-label={`${label} ${v.toFixed(1)}%`}>
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-line)" strokeWidth={stroke} />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={levelColor(v)}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${(arc / 100) * c} ${c}`}
            style={{ transition: 'stroke-dasharray 0.6s ease' }}
          />
        </svg>
        <span className="absolute inset-0 flex items-center justify-center text-[11px] font-semibold tabular-nums text-ink" dir="ltr">
          {v.toFixed(1)}%
        </span>
      </div>
      <span className="text-xs text-muted" dir="ltr">
        {label}
      </span>
    </div>
  );
}

export function Bar({ value, color }: { value: number; color?: string }) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-line">
      <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${v}%`, background: color ?? levelColor(v) }} />
    </div>
  );
}

/** Stacked bar, e.g. memory used / cache / free. */
export function StackBar({ parts }: { parts: { value: number; color: string; label: string }[] }) {
  const total = parts.reduce((a, p) => a + p.value, 0) || 1;
  return (
    <div className="flex h-3 w-full overflow-hidden rounded-full bg-line" role="img" aria-label={parts.map((p) => p.label).join(', ')}>
      {parts.map((p) => (
        <div key={p.label} className="h-full transition-[width] duration-500" style={{ width: `${(p.value / total) * 100}%`, background: p.color }} />
      ))}
    </div>
  );
}

export function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <p className="truncate text-xs text-muted">{label}</p>
      <p className="truncate text-base font-semibold tabular-nums text-ink">{value}</p>
      {hint && <p className="truncate text-[11px] text-muted">{hint}</p>}
    </div>
  );
}
