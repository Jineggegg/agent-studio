import { Check, ChevronsUpDown, Ellipsis } from 'lucide-react';
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useLayoutClass } from '@/platform/layout';
import { IconButton } from './Button';
import { Sheet } from './Sheet';
import { OverlayPortal, useOverlayLayer } from './overlay';

export interface MenuItem {
  id: string;
  label: string;
  /** A second, smaller line. */
  hint?: string;
  icon?: ReactNode;
  tone?: 'default' | 'danger';
  disabled?: boolean;
  /** Shows a tick; makes the item a radio item. */
  checked?: boolean;
  onSelect: () => void;
}

export type MenuEntry = MenuItem | { separator: true; id: string };

export interface MenuProps {
  open: boolean;
  onClose: () => void;
  /** The control the menu belongs to: it is positioned against it and focus returns to it. */
  anchor: RefObject<HTMLElement | null>;
  items: readonly MenuEntry[];
  /** Accessible name; also the sheet's title on a phone. */
  label: string;
  /** Which edge of the anchor the menu lines up with. Default `start`. */
  align?: 'start' | 'end';
}

const isSeparator = (entry: MenuEntry): entry is { separator: true; id: string } => 'separator' in entry;

function MenuItems({ items, onClose, sheet }: { items: readonly MenuEntry[]; onClose: () => void; sheet?: boolean }) {
  return (
    <>
      {items.map((entry) =>
        isSeparator(entry) ? (
          <div key={entry.id} className="ui-menu__separator" role="separator" />
        ) : (
          <button
            key={entry.id}
            type="button"
            role={entry.checked === undefined ? 'menuitem' : 'menuitemradio'}
            aria-checked={entry.checked === undefined ? undefined : entry.checked}
            className="ui-menu__item"
            data-tone={entry.tone ?? 'default'}
            data-autofocus={entry.checked ? '' : undefined}
            disabled={entry.disabled}
            tabIndex={sheet ? 0 : -1}
            onClick={() => {
              onClose();
              entry.onSelect();
            }}
          >
            {entry.icon}
            <span className="ui-menu__item-label">
              {entry.label}
              {entry.hint && <span className="ui-menu__item-hint">{entry.hint}</span>}
            </span>
            {entry.checked && <Check className="ui-menu__item-check" size={20} aria-hidden="true" />}
          </button>
        ),
      )}
    </>
  );
}

function Popover({ onClose, anchor, items, label, align = 'start' }: Omit<MenuProps, 'open'>) {
  const menu = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden' });
  const opener = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : anchor.current;
  }, [anchor]);

  useOverlayLayer(true, onClose);

  useLayoutEffect(() => {
    const element = menu.current;
    const target = anchor.current;
    const frame = element?.offsetParent ?? document.documentElement;
    if (!element || !target) return;
    const bounds = frame.getBoundingClientRect();
    const rect = target.getBoundingClientRect();
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    const margin = 8;
    const gap = 6;

    const below = bounds.bottom - rect.bottom - gap - margin;
    const above = rect.top - bounds.top - gap - margin;
    const placeBelow = below >= height || below >= above;
    const top = placeBelow ? rect.bottom + gap : Math.max(bounds.top + margin, rect.top - gap - height);
    let left = align === 'end' ? rect.right - width : rect.left;
    left = Math.min(Math.max(left, bounds.left + margin), bounds.right - margin - width);

    setStyle({
      top: top - bounds.top,
      left: left - bounds.left,
      maxHeight: Math.max(120, placeBelow ? below : above),
      '--menu-origin': `${placeBelow ? 'top' : 'bottom'} ${align === 'end' ? 'right' : 'left'}`,
    } as CSSProperties);

    const first = element.querySelector<HTMLElement>('[data-autofocus]') ?? element.querySelector<HTMLElement>('.ui-menu__item:not(:disabled)');
    (first ?? element).focus({ preventScroll: true });
    return () => {
      const previous = opener.current;
      if (previous && document.contains(previous)) previous.focus({ preventScroll: true });
    };
  }, [anchor, align]);

  // A popover that has lost its anchor (scroll, resize, rotation) is simply closed.
  useEffect(() => {
    const close = () => onClose();
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
    };
  }, [onClose]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const element = menu.current;
    if (!element) return;
    const enabled = [...element.querySelectorAll<HTMLButtonElement>('.ui-menu__item:not(:disabled)')];
    const index = enabled.indexOf(document.activeElement as HTMLButtonElement);
    const focusAt = (next: number) => {
      event.preventDefault();
      enabled[(next + enabled.length) % enabled.length]?.focus();
    };
    if (event.key === 'ArrowDown') focusAt(index + 1);
    else if (event.key === 'ArrowUp') focusAt(index <= 0 ? enabled.length - 1 : index - 1);
    else if (event.key === 'Home') focusAt(0);
    else if (event.key === 'End') focusAt(enabled.length - 1);
    else if (event.key === 'Tab') {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <OverlayPortal>
      <div className="ui-menu-layer" data-overlay="" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
        <div ref={menu} className="ui-menu" role="menu" aria-label={label} tabIndex={-1} style={style} onKeyDown={onKeyDown}>
          <MenuItems items={items} onClose={onClose} />
        </div>
      </div>
    </OverlayPortal>
  );
}

/**
 * A short list of commands or choices attached to a control. A popover on
 * tablet and wide; on a phone the same items come up as a bottom sheet.
 * Arrow keys move, Enter chooses, Escape closes, focus returns to the anchor.
 */
export function Menu({ open, onClose, anchor, items, label, align }: MenuProps) {
  const layout = useLayoutClass();
  if (layout === 'phone') {
    return (
      <Sheet open={open} onClose={onClose} title={label} flush scrim="light">
        <div className="ui-menu--sheet" role="menu" aria-label={label}>
          <MenuItems items={items} onClose={onClose} sheet />
        </div>
      </Sheet>
    );
  }
  if (!open) return null;
  return <Popover onClose={onClose} anchor={anchor} items={items} label={label} {...(align ? { align } : {})} />;
}

export interface MenuButtonProps {
  /** Accessible name of the button and of its menu. */
  label: string;
  items: readonly MenuEntry[];
  icon?: ReactNode;
  align?: 'start' | 'end';
  className?: string;
  tone?: 'default' | 'secondary' | 'accent';
  variant?: 'plain' | 'filled';
  /** Called when the menu opens or closes. */
  onOpenChange?: (open: boolean) => void;
}

/** An icon button that opens a menu — the usual "more" (…) control. */
export function MenuButton({ label, items, icon, align = 'end', className, tone = 'secondary', variant = 'plain', onOpenChange }: MenuButtonProps) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpenState] = useState(false);
  const setOpen = useCallback(
    (next: boolean) => {
      setOpenState(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );
  const close = useCallback(() => setOpen(false), [setOpen]);
  return (
    <>
      <IconButton
        ref={anchor}
        label={label}
        icon={icon ?? <Ellipsis size={20} />}
        tone={tone}
        variant={variant}
        aria-haspopup="menu"
        aria-expanded={open}
        {...(className ? { className } : {})}
        onClick={() => setOpen(!open)}
      />
      <Menu open={open} onClose={close} anchor={anchor} items={items} label={label} align={align} />
    </>
  );
}

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  hint?: string;
  icon?: ReactNode;
}

export interface SelectProps<T extends string> {
  /** Accessible name; the current choice is appended to it. */
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: readonly SelectOption<T>[];
  /** Full-width, bordered like a text field (for forms). */
  block?: boolean;
  /** No background (for the trailing edge of a list row). */
  quiet?: boolean;
  disabled?: boolean;
  id?: string;
}

/** Choose one of several named options. Opens a menu (a bottom sheet on a phone). */
export function Select<T extends string>({ label, value, onChange, options, block, quiet, disabled, id }: SelectProps<T>) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const current = options.find((option) => option.value === value);
  return (
    <>
      <button
        ref={anchor}
        id={id}
        type="button"
        className="ui-select"
        data-block={block || undefined}
        data-quiet={quiet || undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${label}: ${current?.label ?? ''}`}
        disabled={disabled}
        onClick={() => setOpen((previous) => !previous)}
      >
        <span className="ui-select__value">{current?.label ?? ''}</span>
        <ChevronsUpDown size={16} aria-hidden="true" />
      </button>
      <Menu
        open={open}
        onClose={close}
        anchor={anchor}
        label={label}
        align={quiet ? 'end' : 'start'}
        items={options.map((option) => ({
          id: option.value,
          label: option.label,
          ...(option.hint ? { hint: option.hint } : {}),
          ...(option.icon ? { icon: option.icon } : {}),
          checked: option.value === value,
          onSelect: () => {
            if (option.value !== value) onChange(option.value);
          },
        }))}
      />
    </>
  );
}
