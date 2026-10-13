import type { CSSProperties } from 'react';

export interface LogoMarkProps {
  /** Side length in CSS px. Default 32. */
  size?: number;
  /** Draw the mark on its ink plate (the app icon) rather than bare. */
  plated?: boolean;
  /** Accessible name. Omit when the product name is written next to it. */
  label?: string;
  className?: string;
}

/**
 * The Agent Studio mark: an open ring with a spark where it closes — an agent
 * working its way round a loop. Bare, it takes the text colour.
 */
export function LogoMark({ size = 32, plated, label, className }: LogoMarkProps) {
  return (
    <svg
      className={className ? `ui-logo ${className}` : 'ui-logo'}
      style={{ '--logo-size': `${size}px` } as CSSProperties}
      viewBox="0 0 512 512"
      width={size}
      height={size}
      data-plated={plated || undefined}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    >
      {plated && <rect className="ui-logo__plate" width="512" height="512" rx="118" />}
      <g transform={plated ? 'translate(256 256) scale(0.82) translate(-256 -256)' : undefined}>
        <path className="ui-logo__ring" d="M374.18 235.16A120 120 0 1 1 276.84 137.82" fill="none" strokeWidth="44" strokeLinecap="round" />
        <circle className="ui-logo__spark" cx="340.85" cy="171.15" r="31" />
      </g>
    </svg>
  );
}
