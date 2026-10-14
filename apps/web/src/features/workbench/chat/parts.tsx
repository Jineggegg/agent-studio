import { Bot, Check, Copy } from 'lucide-react';
import { type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useT } from '@/i18n';
import { copyText } from '@/platform/clipboard';
import { useLayoutClass } from '@/platform/layout';
import { isApplePlatform, useCanHover } from '@/platform/media';
import { Sheet, tintFor } from '@/ui';
import { OverlayPortal, focusableWithin, useOverlayLayer } from '@/ui/overlay';

/** The small plate that stands for an agent: the same tint wherever that agent appears. */
export function AgentMark({ agentId, size = 28, label }: { agentId: string; size?: number; label?: string }) {
  return (
    <span className="wb-agent-mark" data-tint={tintFor(agentId)} style={{ '--mark-size': `${size}px` } as CSSProperties} {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}>
      <Bot size={Math.round(size * 0.6)} strokeWidth={2.1} />
    </span>
  );
}

const SYMBOLS: Record<string, string> = { mod: '⌘', shift: '⇧', alt: '⌥', enter: '⏎' };
const WORDS: Record<string, string> = { mod: 'Ctrl', shift: 'Shift', alt: 'Alt', enter: 'Enter' };

/** How a shortcut is written on this platform: "⌘K" on a Mac, "Ctrl+K" elsewhere. */
export function shortcutText(keys: readonly string[]): string {
  const apple = isApplePlatform();
  const parts = keys.map((key) => (apple ? SYMBOLS[key] : WORDS[key]) ?? key.toUpperCase());
  return apple ? parts.join('') : parts.join('+');
}

/** A keyboard shortcut hint. Rendered only where there is a keyboard to press it on. */
export function ShortcutHint({ keys }: { keys: readonly string[] }) {
  const canHover = useCanHover();
  if (!canHover) return null;
  return (
    <kbd className="wb-kbd" aria-hidden="true">
      {shortcutText(keys)}
    </kbd>
  );
}

/** A small "copy" control that confirms itself for a moment. */
export function CopyButton({ text, label, className }: { text: string | (() => string); label: string; className?: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      className={className ? `wb-copy ${className}` : 'wb-copy'}
      aria-label={copied ? t('common.copied') : label}
      title={copied ? t('common.copied') : label}
      onClick={() => {
        void copyText(typeof text === 'function' ? text() : text).then((ok) => ok && setCopied(true));
      }}
    >
      {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
      <span className="visually-hidden" aria-live="polite">
        {copied ? t('common.copied') : ''}
      </span>
    </button>
  );
}

export interface AdaptivePopoverProps {
  open: boolean;
  onClose: () => void;
  /** The control it belongs to: positioned against it, and focus returns to it. */
  anchor: RefObject<HTMLElement | null>;
  /** Names it for assistive technology; the sheet's visible title on a phone. */
  title: string;
  children: ReactNode;
  /** Which edge of the anchor it lines up with. Default `start`. */
  align?: 'start' | 'end';
  /** Preferred width in CSS px on tablet and wide. Default 340. */
  width?: number;
  footer?: ReactNode;
  className?: string;
}

function Floating({ onClose, anchor, title, children, align = 'start', width = 340, footer, className }: Omit<AdaptivePopoverProps, 'open'>) {
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden', width });

  useLayoutEffect(() => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : anchor.current;
  }, [anchor]);

  useOverlayLayer(true, onClose);

  useLayoutEffect(() => {
    const element = panel.current;
    const target = anchor.current;
    const frame = element?.offsetParent ?? document.documentElement;
    if (!element || !target) return;
    const bounds = frame.getBoundingClientRect();
    const rect = target.getBoundingClientRect();
    const margin = 10;
    const gap = 8;
    const actualWidth = Math.min(width, bounds.width - margin * 2);
    const below = bounds.bottom - rect.bottom - gap - margin;
    const above = rect.top - bounds.top - gap - margin;
    const height = element.offsetHeight;
    const placeBelow = below >= height || below >= above;
    let left = align === 'end' ? rect.right - actualWidth : rect.left;
    left = Math.min(Math.max(left, bounds.left + margin), bounds.right - margin - actualWidth);
    const maxHeight = Math.max(160, placeBelow ? below : above);
    const next: CSSProperties & Record<'--popover-origin', string> = {
      width: actualWidth,
      left: left - bounds.left,
      maxHeight,
      '--popover-origin': `${placeBelow ? 'top' : 'bottom'} ${align === 'end' ? 'right' : 'left'}`,
    };
    if (placeBelow) next.top = rect.bottom + gap - bounds.top;
    else next.bottom = bounds.bottom - rect.top + gap;
    setStyle(next);
    const first = element.querySelector<HTMLElement>('[data-autofocus]') ?? focusableWithin(element)[0];
    (first ?? element).focus({ preventScroll: true });
    return () => {
      const previous = opener.current;
      if (previous && document.contains(previous)) previous.focus({ preventScroll: true });
    };
  }, [anchor, align, width]);

  // A popover that has lost its anchor (rotation, a resized window) is simply closed.
  useEffect(() => {
    window.addEventListener('resize', onClose);
    return () => window.removeEventListener('resize', onClose);
  }, [onClose]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return;
    const element = panel.current;
    if (!element) return;
    const items = focusableWithin(element);
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (event.shiftKey && (document.activeElement === first || document.activeElement === element)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <OverlayPortal>
      <div className="wb-popover-layer" data-overlay="" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
        <div ref={panel} className={className ? `wb-popover ${className}` : 'wb-popover'} role="dialog" aria-label={title} tabIndex={-1} style={style} onKeyDown={onKeyDown}>
          <div className="wb-popover__body u-scroll">{children}</div>
          {footer && <div className="wb-popover__footer">{footer}</div>}
        </div>
      </div>
    </OverlayPortal>
  );
}

/**
 * Content attached to a control: a popover beside it on tablet and wide, a
 * bottom sheet on a phone. Escape and a press outside close it; focus returns
 * to the control. Like every overlay it adds no history.
 */
export function AdaptivePopover({ open, onClose, anchor, title, children, align, width, footer, className }: AdaptivePopoverProps) {
  const layout = useLayoutClass();
  if (layout === 'phone') {
    return (
      <Sheet open={open} onClose={onClose} title={title} flush footer={footer} {...(className ? { className } : {})}>
        <div className="wb-popover__sheet">{children}</div>
      </Sheet>
    );
  }
  if (!open) return null;
  return (
    <Floating onClose={onClose} anchor={anchor} title={title} {...(align ? { align } : {})} {...(width ? { width } : {})} footer={footer} {...(className ? { className } : {})}>
      {children}
    </Floating>
  );
}

/** A radio row inside a popover or sheet: a label, an explanation, and a tick on the current choice. */
export function ChoiceRow({
  selected,
  disabled,
  onSelect,
  icon,
  title,
  description,
  badge,
  tone,
}: {
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  badge?: ReactNode;
  tone?: 'default' | 'warning';
}) {
  return (
    <button type="button" role="radio" aria-checked={selected} className="wb-choice" data-tone={tone ?? 'default'} data-autofocus={selected ? '' : undefined} disabled={disabled} onClick={onSelect}>
      {icon && <span className="wb-choice__icon">{icon}</span>}
      <span className="wb-choice__text">
        <span className="wb-choice__title">
          {title}
          {badge}
        </span>
        {description && <span className="wb-choice__description">{description}</span>}
      </span>
      <Check className="wb-choice__check" size={20} aria-hidden="true" data-on={selected || undefined} />
    </button>
  );
}
