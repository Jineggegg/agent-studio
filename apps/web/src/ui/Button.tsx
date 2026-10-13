import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { Spinner } from './Spinner';

export type ButtonVariant = 'primary' | 'tinted' | 'neutral' | 'plain' | 'danger' | 'plain-danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /**
   * `primary` — the one most likely action of a view. `tinted` / `neutral` —
   * everything else. `plain` — text-only, for bars and inline actions.
   * `danger` — destructive; deliberately never as loud as `primary`.
   */
  variant?: ButtonVariant;
  /** `sm` is drawn smaller but keeps a 44 px hit area. */
  size?: ButtonSize;
  /** Fill the width of the container. */
  block?: boolean;
  /** Shows a spinner and blocks presses. */
  loading?: boolean;
  /** Text shown beside the spinner while loading ("Signing in…"). Without it the label keeps its place, hidden. */
  loadingLabel?: string;
  icon?: ReactNode;
  children: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

export function Button({
  variant = 'neutral',
  size = 'md',
  block,
  loading,
  loadingLabel,
  icon,
  children,
  disabled,
  type = 'button',
  className,
  ref,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      className={className ? `ui-button ${className}` : 'ui-button'}
      data-variant={variant}
      data-size={size}
      data-block={block || undefined}
      data-loading={loading || undefined}
      aria-busy={loading || undefined}
      disabled={disabled || loading}
    >
      {loading && loadingLabel ? (
        <span className="ui-button__content">
          <Spinner size={18} />
          <span className="ui-button__label">{loadingLabel}</span>
        </span>
      ) : (
        <>
          <span className="ui-button__content" data-hide-when-loading>
            {icon}
            <span className="ui-button__label">{children}</span>
          </span>
          {loading && (
            <span className="ui-button__spinner">
              <Spinner size={18} />
            </span>
          )}
        </>
      )}
    </button>
  );
}

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'aria-label'> {
  /** What the button does. Required: it is the accessible name and the tooltip. */
  label: string;
  icon: ReactNode;
  /** `filled` draws a disc behind the icon; `plain` shows one only on hover and press. */
  variant?: 'plain' | 'filled';
  tone?: 'default' | 'secondary' | 'accent' | 'danger';
  /** Spins the icon and blocks presses (a refresh in progress). */
  busy?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

/** An icon-only button. Always 44 × 44 to the finger, whatever the icon size. */
export function IconButton({ label, icon, variant = 'plain', tone = 'default', busy, disabled, type = 'button', className, ref, ...rest }: IconButtonProps) {
  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      className={className ? `ui-icon-button ${className}` : 'ui-icon-button'}
      data-variant={variant}
      data-tone={tone}
      data-busy={busy || undefined}
      aria-label={label}
      aria-busy={busy || undefined}
      title={label}
      disabled={disabled || busy}
    >
      {icon}
    </button>
  );
}
