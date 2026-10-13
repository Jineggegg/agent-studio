import type { CSSProperties } from 'react';

export interface SpinnerProps {
  /** Diameter in CSS px. Default 20. */
  size?: number;
  /** Announced to assistive technology. Omit when a visible label sits next to it. */
  label?: string;
  className?: string;
}

/** An indeterminate "working" mark. Under reduced motion it breathes instead of turning. */
export function Spinner({ size = 20, label, className }: SpinnerProps) {
  return (
    <svg
      className={className ? `ui-spinner ${className}` : 'ui-spinner'}
      style={{ '--spinner-size': `${size}px` } as CSSProperties}
      viewBox="0 0 24 24"
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    >
      <circle cx="12" cy="12" r="9" strokeWidth="2.6" />
      <circle cx="12" cy="12" r="9" strokeWidth="2.6" strokeDasharray="18 60" />
    </svg>
  );
}

/** A row that says something is being read. For in-place loading inside lists and panes. */
export function LoadingRow({ label }: { label: string }) {
  return (
    <div className="ui-loading-row" role="status">
      <Spinner />
      <span>{label}</span>
    </div>
  );
}
