import type { ReactNode } from 'react';
import { useT } from '@/i18n';

export interface BadgeProps {
  tone?: 'neutral' | 'accent' | 'positive' | 'warning' | 'danger' | 'info';
  children: ReactNode;
  className?: string;
}

/** A short status word. Colour supports the word; it never replaces it. */
export function Badge({ tone = 'neutral', children, className }: BadgeProps) {
  return (
    <span className={className ? `ui-badge ${className}` : 'ui-badge'} data-tone={tone}>
      {children}
    </span>
  );
}

/** A count on a filled dot. Renders nothing for zero. `label` says what is being counted, for assistive technology. */
export function CountBadge({ count, max = 99, label }: { count: number; max?: number; label: string }) {
  if (count <= 0) return null;
  return (
    <span className="ui-badge" data-count="" role="img" aria-label={label}>
      {count > max ? `${max}+` : count}
    </span>
  );
}

export type ActivityKind =
  /** An agent is working. */
  | 'running'
  /** Waiting for the user: an approval, a question, a failed or interrupted run. */
  | 'attention'
  /** Finished while the user was elsewhere. */
  | 'unseen';

/** When several apply, show the first of these that does. */
export const ACTIVITY_PRIORITY: readonly ActivityKind[] = ['attention', 'running', 'unseen'];

/** The most important of several activity states, or null. "Needs you" outranks everything. */
export function topActivity(kinds: readonly (ActivityKind | null | undefined)[]): ActivityKind | null {
  return ACTIVITY_PRIORITY.find((kind) => kinds.includes(kind)) ?? null;
}

export interface ActivityMarkProps {
  kind: ActivityKind;
  /** Override the spoken description ("Claude is running"). */
  label?: string;
  className?: string;
}

/**
 * The small mark that says what is happening in a session or project. The
 * three kinds differ in shape as well as colour, and each is announced — put
 * it inside the row it describes so it becomes part of the row's name.
 */
export function ActivityMark({ kind, label, className }: ActivityMarkProps) {
  const t = useT();
  const text = label ?? (kind === 'running' ? t('activity.running') : kind === 'attention' ? t('activity.attention') : t('activity.unseen'));
  return <span className={className ? `ui-mark ${className}` : 'ui-mark'} data-kind={kind} role="img" aria-label={text} title={text} />;
}
