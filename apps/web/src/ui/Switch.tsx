import type { ButtonHTMLAttributes, Ref } from 'react';

export interface SwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'role' | 'children'> {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Accessible name. Not needed when the switch sits in a `ListRow` (the row's title labels it). */
  label?: string;
  ref?: Ref<HTMLButtonElement>;
}

/** An on/off switch. Label it for the "on" state: "Create the folder if it is missing". */
export function Switch({ checked, onChange, label, disabled, className, ref, onClick, ...rest }: SwitchProps) {
  return (
    <button
      {...rest}
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={className ? `ui-switch ${className}` : 'ui-switch'}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) onChange(!checked);
      }}
    >
      <span className="ui-switch__track">
        <span className="ui-switch__thumb" />
      </span>
    </button>
  );
}
