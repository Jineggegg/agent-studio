import { type CSSProperties, type KeyboardEvent, type ReactNode, useRef } from 'react';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  /** Accessible name of the group. */
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: readonly SegmentedOption<T>[];
  disabled?: boolean;
  className?: string;
}

/**
 * A small set of mutually exclusive choices, all visible at once (two to four).
 * Arrow keys move the selection, as in a radio group.
 */
export function SegmentedControl<T extends string>({ label, value, onChange, options, disabled, className }: SegmentedControlProps<T>) {
  const container = useRef<HTMLDivElement>(null);
  const index = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );

  const move = (event: KeyboardEvent, step: number) => {
    event.preventDefault();
    const count = options.length;
    for (let offset = 1; offset <= count; offset += 1) {
      const candidate = options[(index + step * offset + count * offset) % count];
      if (candidate && !candidate.disabled) {
        onChange(candidate.value);
        const buttons = container.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
        buttons?.[options.indexOf(candidate)]?.focus();
        return;
      }
    }
  };

  return (
    <div
      ref={container}
      role="radiogroup"
      aria-label={label}
      className={className ? `ui-segmented ${className}` : 'ui-segmented'}
      style={{ '--count': options.length, '--index': index } as CSSProperties}
      onKeyDown={(event) => {
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') move(event, 1);
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') move(event, -1);
      }}
    >
      <span className="ui-segmented__thumb" aria-hidden="true" />
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            disabled={disabled || option.disabled}
            className="ui-segmented__option"
            onClick={() => {
              if (!selected) onChange(option.value);
            }}
          >
            {option.icon}
            <span>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
