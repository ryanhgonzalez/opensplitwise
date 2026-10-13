/** Small pieces shared by the Share and Receive pages. */

export function CloseIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/**
 * One segment per part of the code. On the sending side the lit segment is
 * the part on screen; on the receiving side, the parts that have arrived.
 */
export function PartsBar({ parts, label }: { parts: boolean[]; label?: string }) {
  if (parts.length === 0) return <div className="parts-bar parts-bar-empty" aria-hidden />;
  return (
    <div
      className={`parts-bar ${parts.length > 24 ? 'parts-bar-dense' : ''}`}
      style={{ gridTemplateColumns: `repeat(${parts.length}, minmax(0, 1fr))` }}
      role={label ? 'progressbar' : undefined}
      aria-label={label}
      aria-valuemin={label ? 0 : undefined}
      aria-valuemax={label ? parts.length : undefined}
      aria-valuenow={label ? parts.filter(Boolean).length : undefined}
      aria-hidden={label ? undefined : true}
    >
      {parts.map((on, i) => (
        <span key={i} className={on ? 'on' : ''} />
      ))}
    </div>
  );
}
