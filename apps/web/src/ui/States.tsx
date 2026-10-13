import { CircleAlert, CircleCheck, Clock, Info, Lock, SearchX, TriangleAlert, Unplug } from 'lucide-react';
import type { ReactNode } from 'react';
import { type ErrorKind, describeError, errorKind } from '@/data/errors';
import { useT } from '@/i18n';
import { Button } from './Button';

export interface EmptyStateProps {
  icon?: ReactNode;
  /** What will appear here. */
  title: string;
  /** How it gets here. */
  description?: ReactNode;
  /** The next useful step, as a button. */
  action?: ReactNode;
  /** Less padding, for use inside a card or pane. */
  compact?: boolean;
}

/** Nothing here yet — and that is fine. Never use this for a failed read: that is `ErrorState`. */
export function EmptyState({ icon, title, description, action, compact }: EmptyStateProps) {
  return (
    <div className="ui-state" data-compact={compact || undefined}>
      {icon && <div className="ui-state__icon">{icon}</div>}
      <p className="ui-state__title">{title}</p>
      {description && <p className="ui-state__description">{description}</p>}
      {action && <div className="ui-state__actions">{action}</div>}
    </div>
  );
}

export interface ErrorStateProps {
  /** What was thrown. Decides between "gone" and "unreachable" and supplies the reason. */
  error?: unknown;
  /** Override the kind worked out from `error`. */
  kind?: ErrorKind;
  /** Override the heading. */
  title?: string;
  /** Override the explanation. */
  description?: ReactNode;
  /** Offered when retrying can help (the server was unreachable or failed). */
  onRetry?: () => void;
  retrying?: boolean;
  /** Further ways out: "Go to Home", "Start a new session". */
  actions?: ReactNode;
  compact?: boolean;
}

/**
 * A read failed. Shown in place of the content, with the reason.
 *
 * Two situations look alike and are not: the thing is **gone** (deleted, or
 * never yours — retrying is pointless, offer a way out) and the server is
 * **unreachable** (the thing is probably fine — offer Retry). This component
 * tells them apart from the error it is given.
 */
export function ErrorState({ error, kind, title, description, onRetry, retrying, actions, compact }: ErrorStateProps) {
  const t = useT();
  const resolved = kind ?? errorKind(error);
  const Icon = resolved === 'gone' ? SearchX : resolved === 'unreachable' ? Unplug : resolved === 'forbidden' ? Lock : CircleAlert;
  const heading =
    title ??
    (resolved === 'gone'
      ? t('state.gone.title')
      : resolved === 'unreachable'
        ? t('state.unreachable.title')
        : resolved === 'forbidden'
          ? t('state.forbidden.title')
          : t('state.failed.title'));
  const body =
    description ??
    (resolved === 'gone'
      ? t('state.gone.description')
      : resolved === 'unreachable'
        ? t('state.unreachable.description')
        : error !== undefined
          ? describeError(error, t)
          : t('state.failed.description'));
  const canRetry = onRetry && resolved !== 'gone' && resolved !== 'forbidden';

  return (
    <div className="ui-state" data-kind={resolved} data-tone={resolved === 'gone' ? undefined : 'warning'} data-compact={compact || undefined} role="alert">
      <div className="ui-state__icon">
        <Icon size={28} aria-hidden="true" />
      </div>
      <p className="ui-state__title">{heading}</p>
      <p className="ui-state__description">{body}</p>
      {resolved === 'unreachable' && error !== undefined && <p className="ui-state__detail">{describeError(error, t)}</p>}
      {(canRetry || actions) && (
        <div className="ui-state__actions">
          {canRetry && (
            <Button variant="tinted" onClick={onRetry} loading={retrying}>
              {t('common.retry')}
            </Button>
          )}
          {actions}
        </div>
      )}
    </div>
  );
}

export interface BannerProps {
  tone?: 'neutral' | 'info' | 'success' | 'warning' | 'danger';
  title?: string;
  children?: ReactNode;
  /** A button at the trailing edge ("Retry"). */
  action?: ReactNode;
  /** `alert` interrupts assistive technology; use it for errors. Default: `status`, or `alert` when the tone is danger. */
  role?: 'status' | 'alert';
  className?: string;
}

const BANNER_ICONS = { neutral: Info, info: Info, success: CircleCheck, warning: TriangleAlert, danger: CircleAlert } as const;

/** A message in the flow of a page or form: an error above a form, a notice above stale content. */
export function Banner({ tone = 'neutral', title, children, action, role, className }: BannerProps) {
  const Icon = BANNER_ICONS[tone];
  return (
    <div className={className ? `ui-banner ${className}` : 'ui-banner'} data-tone={tone} role={role ?? (tone === 'danger' ? 'alert' : 'status')}>
      <Icon size={20} aria-hidden="true" />
      <div className="ui-banner__text">
        {title && <p className="ui-banner__title">{title}</p>}
        {children}
      </div>
      {action && <div className="ui-banner__action">{action}</div>}
    </div>
  );
}

export interface StaleNoticeProps {
  /** When the data on screen was read, ms since the epoch. Shown as its age. */
  since?: number | undefined;
  /** Why it is not fresh; shown as a tooltip and read out. */
  reason?: string;
}

/** Marks figures that were not freshly read. Stale data is labelled, never silently shown as current. */
export function StaleNotice({ since, reason }: StaleNoticeProps) {
  const t = useT();
  const text = since ? t('state.stale.since', { when: t.relative(since) }) : t('state.stale');
  return (
    <span className="ui-stale" title={reason} role="note" aria-label={reason ? `${text}. ${reason}` : text}>
      <Clock size={13} aria-hidden="true" />
      {text}
    </span>
  );
}
