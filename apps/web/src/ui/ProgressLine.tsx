import { type CSSProperties, useEffect, useState } from 'react';
import { create } from 'zustand';

const useProgressStore = create<{ count: number }>(() => ({ count: 0 }));

/**
 * The thin line at the very top of the app, for work the user asked for (a
 * refresh, a save). A first load does not use it — that is what skeletons are for.
 *
 *   const done = progress.start();
 *   try { await refresh(); } finally { done(); }
 */
export const progress = {
  start(): () => void {
    useProgressStore.setState(({ count }) => ({ count: count + 1 }));
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      useProgressStore.setState(({ count }) => ({ count: Math.max(0, count - 1) }));
    };
  },
  /** Shows the line for as long as the promise is pending. */
  async track<T>(work: Promise<T>): Promise<T> {
    const done = progress.start();
    try {
      return await work;
    } finally {
      done();
    }
  },
};

/** Show the global line while `active` is true. */
export function useProgress(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    return progress.start();
  }, [active]);
}

export interface ProgressLineProps {
  /** Without it the line follows the global `progress` store. */
  active?: boolean;
  /** 0–1 for a determinate line; omit for indeterminate. */
  value?: number;
  /** Lay it out in the flow (inside a card) instead of pinning it to the top of the app. */
  inline?: boolean;
  label?: string;
}

export function ProgressLine({ active, value, inline, label }: ProgressLineProps) {
  const globalActive = useProgressStore((state) => state.count > 0);
  const isActive = active ?? globalActive;
  const [finishing, setFinishing] = useState(false);
  const [wasActive, setWasActive] = useState(isActive);

  // When work ends, run the line to the end before fading it out.
  if (wasActive !== isActive) {
    setWasActive(isActive);
    setFinishing(!isActive);
  }
  useEffect(() => {
    if (!finishing) return;
    const timer = window.setTimeout(() => setFinishing(false), 320);
    return () => window.clearTimeout(timer);
  }, [finishing]);

  const determinate = value !== undefined;
  return (
    <div
      className="ui-progress"
      data-active={isActive || undefined}
      data-finishing={finishing || undefined}
      data-value={determinate || undefined}
      data-inline={inline || undefined}
      role="progressbar"
      aria-label={label}
      aria-hidden={isActive ? undefined : true}
      aria-valuemin={determinate ? 0 : undefined}
      aria-valuemax={determinate ? 100 : undefined}
      aria-valuenow={determinate ? Math.round(Math.min(1, Math.max(0, value)) * 100) : undefined}
      style={determinate ? ({ '--progress': Math.min(1, Math.max(0, value)) } as CSSProperties) : undefined}
    >
      <div className="ui-progress__bar" />
    </div>
  );
}
