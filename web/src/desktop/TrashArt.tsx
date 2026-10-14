/** Recycle Bin desktop icon (original artwork): a white tile with a bin, papers showing when full. */
export function TrashArt({ full, size = 52 }: { full: boolean; size?: number }) {
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center overflow-hidden bg-white shadow-[0_1px_2px_rgb(0_0_0/0.06),0_4px_12px_rgb(15_23_42/0.10)] ring-1 ring-black/5 dark:bg-[#f4f6fa]"
      style={{ width: size, height: size, borderRadius: size * 0.24 }}
      aria-hidden
    >
      <svg viewBox="0 0 48 48" style={{ width: size * 0.72, height: size * 0.72 }}>
        <defs>
          <linearGradient id="bin-body" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#7aa7ff" />
            <stop offset="1" stopColor="#2f6fe4" />
          </linearGradient>
          <linearGradient id="bin-lid" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#5b8def" />
            <stop offset="1" stopColor="#1a3a7c" />
          </linearGradient>
        </defs>
        {full && (
          <g>
            <rect x="15" y="6" width="12" height="15" rx="1.5" fill="#fff" stroke="#cbd5e1" transform="rotate(-14 21 13)" />
            <rect x="22" y="5" width="12" height="15" rx="1.5" fill="#fef3c7" stroke="#e5c07b" transform="rotate(10 28 12)" />
            <path d="M19 10h6M19 13h5" stroke="#94a3b8" strokeWidth="1.2" transform="rotate(-14 21 13)" />
          </g>
        )}
        <rect x="9" y="13" width="30" height="5" rx="2.5" fill="url(#bin-lid)" transform={full ? 'rotate(-8 12 15)' : undefined} />
        <rect x="20" y="10" width="8" height="4" rx="1.5" fill="url(#bin-lid)" transform={full ? 'rotate(-8 12 15)' : undefined} />
        <path d="M12 19h24l-2.2 21.5a3 3 0 0 1-3 2.5H17.2a3 3 0 0 1-3-2.5z" fill="url(#bin-body)" />
        <path d="M19 24v13M24 24v13M29 24v13" stroke="#fff" strokeOpacity="0.75" strokeWidth="2" strokeLinecap="round" />
      </svg>
    </span>
  );
}
