import { type CSSProperties, type ReactNode, useEffect, useState } from 'react';

/** How long loading must last before a placeholder is worth showing. Shorter loads show nothing at all. */
export const SKELETON_DELAY_MS = 140;

/**
 * True once `active` has been true for `delay` ms without interruption. Use
 * it to hold back placeholders, so a fast load never flashes one.
 */
export function useDelayedFlag(active: boolean, delay: number = SKELETON_DELAY_MS): boolean {
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => setElapsed(true), delay);
    return () => {
      window.clearTimeout(timer);
      setElapsed(false);
    };
  }, [active, delay]);
  return active && elapsed;
}

export interface SkeletonProps {
  width?: number | string;
  height?: number | string;
  radius?: number | string;
  className?: string;
}

const toCss = (value: number | string | undefined): string | undefined => (typeof value === 'number' ? `${value}px` : value);

/** A placeholder block shaped like the content that is loading. Wrap a group of them in `DelayedSkeleton`. */
export function Skeleton({ width, height, radius, className }: SkeletonProps) {
  return (
    <span
      className={className ? `ui-skeleton ${className}` : 'ui-skeleton'}
      aria-hidden="true"
      style={{ '--skeleton-width': toCss(width), '--skeleton-height': toCss(height), '--skeleton-radius': toCss(radius) } as CSSProperties}
    />
  );
}

/** A few lines of placeholder text; the last one is shorter. */
export function SkeletonText({ lines = 3 }: { lines?: number }) {
  return (
    <span className="ui-skeleton-text" aria-hidden="true">
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton key={index} height={12} width={index === lines - 1 ? '60%' : '100%'} />
      ))}
    </span>
  );
}

/**
 * Renders its children (the placeholders) only after the delay has passed,
 * and tells assistive technology that something is loading.
 */
export function DelayedSkeleton({ children, label, delay }: { children: ReactNode; label: string; delay?: number }) {
  const visible = useDelayedFlag(true, delay);
  return (
    <div role="status" aria-label={label} aria-busy="true">
      {visible ? children : null}
    </div>
  );
}
