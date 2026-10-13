import { Eye, EyeOff } from 'lucide-react';
import {
  type FormEvent,
  type FormHTMLAttributes,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  type TextareaHTMLAttributes,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { useT } from '@/i18n';
import { IconButton } from './Button';

/**
 * True when this Enter key press is the one that confirms an input-method
 * candidate (Chinese, Japanese, Korean …) rather than a real Enter. Such a
 * press must never submit anything.
 */
export function isImeConfirm(event: KeyboardEvent | globalThis.KeyboardEvent): boolean {
  const native = 'nativeEvent' in event ? event.nativeEvent : event;
  // Safari ends composition before the keydown arrives, but still reports key code 229.
  return native.isComposing || native.keyCode === 229;
}

interface FieldChrome {
  /** Always required; pass `hideLabel` to keep it for assistive technology only. */
  label: string;
  hideLabel?: boolean;
  /** Marks the label "(optional)". */
  optional?: boolean;
  hint?: ReactNode;
  /** Shown instead of the hint, in the danger colour, and announced. */
  error?: ReactNode;
  /** Monospaced text, for paths, tokens and code. */
  mono?: boolean;
}

export interface TextFieldProps extends FieldChrome, Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'size'> {
  value: string;
  onChange: (value: string) => void;
  /** Enter was pressed — a real one, never an input-method confirmation. */
  onEnter?: () => void;
  /** For passwords and keys: no capitalisation, correction or spell check, and a show/hide toggle for passwords. */
  secret?: boolean;
  leading?: ReactNode;
  trailing?: ReactNode;
  ref?: Ref<HTMLInputElement>;
}

function FieldFrame({
  id,
  label,
  hideLabel,
  optional,
  hint,
  error,
  disabled,
  children,
}: FieldChrome & { id: string; disabled?: boolean | undefined; children: ReactNode }) {
  const t = useT();
  return (
    <div className="ui-field" data-invalid={error ? '' : undefined} data-disabled={disabled || undefined}>
      <label className={hideLabel ? 'visually-hidden' : 'ui-field__label'} htmlFor={id}>
        {label}
        {optional && <span className="ui-field__optional"> {t('common.optional')}</span>}
      </label>
      {children}
      {error ? (
        <p className="ui-field__error" id={`${id}-error`} role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="ui-field__hint" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** A single-line text input with a label, a hint and an error line. Text is at least 16 px so iOS never zooms in. */
export function TextField({
  label,
  hideLabel,
  optional,
  hint,
  error,
  mono,
  value,
  onChange,
  onEnter,
  secret,
  leading,
  trailing,
  type = 'text',
  id: givenId,
  disabled,
  onKeyDown,
  ref,
  ...rest
}: TextFieldProps) {
  const t = useT();
  const generatedId = useId();
  const id = givenId ?? generatedId;
  const [revealed, setRevealed] = useState(false);
  const isPassword = type === 'password';
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;

  return (
    <FieldFrame id={id} label={label} hideLabel={hideLabel} optional={optional} hint={hint} error={error} disabled={disabled}>
      <div className="ui-field__control">
        {leading && <span className="ui-field__leading">{leading}</span>}
        <input
          {...rest}
          ref={ref}
          id={id}
          className="ui-field__input"
          data-mono={mono || undefined}
          type={isPassword && revealed ? 'text' : type}
          value={value}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          {...(secret || isPassword ? { autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false } : {})}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            onKeyDown?.(event);
            if (event.defaultPrevented || event.key !== 'Enter') return;
            if (isImeConfirm(event)) {
              // Stops the browser's implicit form submission as well.
              event.preventDefault();
              return;
            }
            if (onEnter) {
              event.preventDefault();
              onEnter();
            }
          }}
        />
        {trailing}
        {isPassword && (
          <IconButton
            label={revealed ? t('field.hidePassword') : t('field.showPassword')}
            icon={revealed ? <EyeOff size={20} /> : <Eye size={20} />}
            tone="secondary"
            aria-pressed={revealed}
            disabled={disabled}
            onClick={() => setRevealed((current) => !current)}
          />
        )}
      </div>
    </FieldFrame>
  );
}

export interface TextAreaProps extends FieldChrome, Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> {
  value: string;
  onChange: (value: string) => void;
  /** Grow with the text up to `maxRows`, then scroll. */
  autoGrow?: boolean;
  maxRows?: number;
  /**
   * Called for Enter without Shift (never for an input-method confirmation).
   * Leave it out for a plain multi-line field where Enter makes a new line.
   */
  onSubmit?: () => void;
  ref?: Ref<HTMLTextAreaElement>;
}

/** A multi-line text input. */
export function TextArea({
  label,
  hideLabel,
  optional,
  hint,
  error,
  mono,
  value,
  onChange,
  autoGrow,
  maxRows = 8,
  onSubmit,
  rows = 3,
  id: givenId,
  disabled,
  onKeyDown,
  ref,
  ...rest
}: TextAreaProps) {
  const generatedId = useId();
  const id = givenId ?? generatedId;
  const innerRef = useRef<HTMLTextAreaElement | null>(null);
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;

  useEffect(() => {
    const element = innerRef.current;
    if (!autoGrow || !element) return;
    element.style.height = 'auto';
    const style = window.getComputedStyle(element);
    const line = Number.parseFloat(style.lineHeight) || 22;
    const padding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom) || 24;
    element.style.height = `${Math.min(element.scrollHeight, line * maxRows + padding)}px`;
  }, [autoGrow, maxRows, value]);

  return (
    <FieldFrame id={id} label={label} hideLabel={hideLabel} optional={optional} hint={hint} error={error} disabled={disabled}>
      <div className="ui-field__control">
        <textarea
          {...rest}
          ref={(element) => {
            innerRef.current = element;
            if (typeof ref === 'function') ref(element);
            else if (ref) ref.current = element;
          }}
          id={id}
          className="ui-field__input"
          data-mono={mono || undefined}
          rows={rows}
          value={value}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            onKeyDown?.(event);
            if (event.defaultPrevented || event.key !== 'Enter' || !onSubmit) return;
            if (isImeConfirm(event) || event.shiftKey) return;
            event.preventDefault();
            onSubmit();
          }}
        />
      </div>
    </FieldFrame>
  );
}

export interface FormProps extends Omit<FormHTMLAttributes<HTMLFormElement>, 'onSubmit'> {
  onSubmit: () => void;
  ref?: Ref<HTMLFormElement>;
}

/**
 * A form whose Enter key is input-method safe: confirming a candidate with
 * Enter never submits. Also stops the browser's own page-reloading submit.
 */
export function Form({ onSubmit, children, onKeyDown, ref, ...rest }: FormProps) {
  const composing = useRef(false);
  return (
    <form
      {...rest}
      ref={ref}
      noValidate
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={() => {
        // Safari fires the confirming keydown after compositionend: keep the guard up for that one event.
        window.setTimeout(() => {
          composing.current = false;
        }, 0);
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.key === 'Enter' && (composing.current || isImeConfirm(event))) event.preventDefault();
      }}
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        if (composing.current) return;
        onSubmit();
      }}
    >
      {children}
    </form>
  );
}
