import { Check } from 'lucide-react';
import type { ReactNode } from 'react';

export interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
  name?: string;
}

/** A labelled tick box, for choosing several things from a short list. For a single on/off setting use `Switch`. */
export function Checkbox({ checked, onChange, label, hint, disabled, name }: CheckboxProps) {
  return (
    <label className="ui-check">
      <input type="checkbox" name={name} checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span className="ui-check__box" aria-hidden="true">
        <Check size={17} strokeWidth={3} />
      </span>
      <span className="ui-check__text">
        <span className="ui-check__label">{label}</span>
        {hint && <span className="ui-check__hint">{hint}</span>}
      </span>
    </label>
  );
}
