import { ChevronRight } from 'lucide-react';
import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { Link } from 'react-router';
import { useT } from '@/i18n';
import { MenuButton } from './Menu';

export interface ListProps {
  /** A short heading above the group. */
  header?: ReactNode;
  /** A control at the end of the heading line ("Add", "Show all"). */
  headerAction?: ReactNode;
  /** A sentence under the group explaining what the rows do. */
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
  'aria-label'?: string;
}

/** A group of rows on one surface, with an optional heading and explanation. */
export function List({ header, headerAction, footer, children, className, 'aria-label': ariaLabel }: ListProps) {
  const headingId = useId();
  return (
    <section className={className ? `ui-list ${className}` : 'ui-list'} aria-labelledby={header ? headingId : undefined} aria-label={header ? undefined : ariaLabel}>
      {(header || headerAction) && (
        <div className="ui-list__header">
          <h2 id={headingId}>{header}</h2>
          {headerAction}
        </div>
      )}
      <div className="ui-list__group" role="list">
        {children}
      </div>
      {footer && <p className="ui-list__footer">{footer}</p>}
    </section>
  );
}

export interface RowAction {
  id: string;
  label: string;
  icon?: ReactNode;
  tone?: 'neutral' | 'accent' | 'warning' | 'danger';
  onSelect: () => void;
}

export interface ListRowProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** The current value, shown in a quieter colour at the trailing edge. */
  value?: ReactNode;
  leading?: ReactNode;
  /** Trailing accessory that is not a control (a badge, a mark, a time). */
  trailing?: ReactNode;
  /** A control at the trailing edge (a `Switch`). The whole row becomes its label. */
  control?: ReactNode;
  /** Navigate in the app. Shows a chevron so the row is recognisable as one that goes somewhere. */
  to?: string;
  /** With `to`: replace the current history entry (moving between siblings). */
  replace?: boolean;
  onPress?: () => void;
  /** Force or suppress the chevron. Default: shown when `to` is set. */
  chevron?: boolean;
  /** Marks the row as the current choice of a list beside its detail. */
  selected?: boolean;
  disabled?: boolean;
  tone?: 'default' | 'accent' | 'danger';
  /**
   * Actions revealed by sliding the row towards the leading edge. The same
   * actions are always reachable without swiping, from a "more" button.
   * Put the destructive one last: it ends up at the far edge.
   */
  actions?: readonly RowAction[];
  /** Accessible name of the "more" button. Default: "More actions". */
  actionsLabel?: string;
  className?: string;
}

const ACTION_WIDTH = 76;
/** The row whose actions are showing, so that opening another closes it. */
let closeOpenRow: (() => void) | null = null;

/** One row of a `List`. */
export function ListRow({
  title,
  subtitle,
  value,
  leading,
  trailing,
  control,
  to,
  replace,
  onPress,
  chevron,
  selected,
  disabled,
  tone = 'default',
  actions,
  actionsLabel,
  className,
}: ListRowProps) {
  const t = useT();
  const titleId = useId();
  const row = useRef<HTMLDivElement>(null);
  const slider = useRef<HTMLDivElement>(null);
  const [revealed, setRevealed] = useState(false);
  const hasActions = !!actions && actions.length > 0;
  const width = hasActions ? actions.length * ACTION_WIDTH : 0;

  const gesture = useRef<{ id: number; x: number; y: number; origin: number; decided: 'none' | 'swipe' | 'scroll'; lastX: number; lastTime: number; velocity: number } | null>(
    null,
  );
  /**
   * Until when a click is not a tap on the row but the end of a swipe. A browser sends no click after a
   * finger that moved, so the window closes shortly after the gesture: the next real tap must work.
   */
  const swallowClick = useRef(0);

  const settle = useCallback(
    (open: boolean) => {
      const element = slider.current;
      row.current?.removeAttribute('data-swiping');
      if (element) {
        row.current?.setAttribute('data-settling', '');
        element.style.transform = open ? `translateX(${-width}px)` : '';
        window.setTimeout(() => row.current?.removeAttribute('data-settling'), 260);
      }
      setRevealed(open);
    },
    [width],
  );

  const close = useCallback(() => settle(false), [settle]);

  useEffect(() => {
    if (!revealed) return;
    closeOpenRow?.();
    closeOpenRow = close;
    const onPointerDown = (event: PointerEvent) => {
      if (row.current && event.target instanceof Node && !row.current.contains(event.target)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      if (closeOpenRow === close) closeOpenRow = null;
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [revealed, close]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!hasActions || event.pointerType === 'mouse') return;
    swallowClick.current = 0;
    gesture.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      origin: revealed ? -width : 0,
      decided: 'none',
      lastX: event.clientX,
      lastTime: event.timeStamp,
      velocity: 0,
    };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = gesture.current;
    const element = slider.current;
    if (!state || state.id !== event.pointerId || !element) return;
    const dx = event.clientX - state.x;
    const dy = event.clientY - state.y;
    if (state.decided === 'none') {
      if (Math.abs(dy) > 8 && Math.abs(dy) >= Math.abs(dx)) {
        state.decided = 'scroll';
        return;
      }
      if (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(dy) * 1.4) return;
      state.decided = 'swipe';
      swallowClick.current = Number.POSITIVE_INFINITY;
      row.current?.removeAttribute('data-settling');
      row.current?.setAttribute('data-swiping', '');
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
    if (state.decided !== 'swipe') return;
    state.velocity = (event.clientX - state.lastX) / Math.max(1, event.timeStamp - state.lastTime);
    state.lastX = event.clientX;
    state.lastTime = event.timeStamp;
    let offset = state.origin + dx;
    // 1:1 inside its travel, resistance beyond either end.
    if (offset > 0) offset = offset / 5;
    else if (offset < -width) offset = -width + (offset + width) / 4;
    element.style.transform = `translateX(${offset}px)`;
  };
  const onPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = gesture.current;
    if (!state || state.id !== event.pointerId) return;
    gesture.current = null;
    if (state.decided !== 'swipe') return;
    swallowClick.current = performance.now() + 400;
    const offset = state.origin + (event.clientX - state.x);
    const open = event.type === 'pointercancel' ? revealed : state.velocity < -0.35 ? true : state.velocity > 0.35 ? false : offset < -width / 2;
    settle(open);
  };

  const onClickCapture = (event: ReactMouseEvent) => {
    if (performance.now() < swallowClick.current) {
      swallowClick.current = 0;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    // A tap on an open row closes it instead of activating it.
    if (revealed && !(event.target as Element).closest('.ui-row__actions, .ui-row__more')) {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };

  const showChevron = chevron ?? to !== undefined;
  const interactive = !disabled && (to !== undefined || onPress !== undefined || control !== undefined);

  const content = (
    <>
      {leading && <span className="ui-row__leading">{leading}</span>}
      <span className="ui-row__text">
        <span className="ui-row__title" id={titleId}>
          {title}
        </span>
        {subtitle && <span className="ui-row__subtitle">{subtitle}</span>}
      </span>
      {value !== undefined && value !== null && <span className="ui-row__value">{value}</span>}
      {trailing && <span className="ui-row__trailing">{trailing}</span>}
      {control && <span className="ui-row__control">{control}</span>}
      {showChevron && <ChevronRight className="ui-row__chevron" size={18} aria-hidden="true" />}
    </>
  );

  const main =
    to !== undefined && !disabled ? (
      <Link className="ui-row__main" to={to} replace={replace} aria-current={selected ? 'page' : undefined} draggable={false}>
        {content}
      </Link>
    ) : onPress && !disabled ? (
      <button type="button" className="ui-row__main" onClick={onPress} aria-pressed={selected === undefined ? undefined : selected}>
        {content}
      </button>
    ) : control ? (
      <label className="ui-row__main">{content}</label>
    ) : (
      <div className="ui-row__main">{content}</div>
    );

  return (
    <div
      ref={row}
      role="listitem"
      className={className ? `ui-row ${className}` : 'ui-row'}
      data-leading={leading ? '' : undefined}
      data-interactive={interactive || undefined}
      data-selected={selected || undefined}
      data-disabled={disabled || undefined}
      data-tone={tone}
      data-revealed={revealed || undefined}
      onClickCapture={onClickCapture}
    >
      {hasActions && (
        <div className="ui-row__actions" inert={!revealed} aria-hidden={!revealed}>
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              className="ui-row__action"
              data-tone={action.tone ?? 'neutral'}
              onClick={() => {
                close();
                action.onSelect();
              }}
            >
              {action.icon}
              <span>{action.label}</span>
            </button>
          ))}
        </div>
      )}
      <div
        ref={slider}
        className="ui-row__slider"
        style={hasActions ? { touchAction: 'pan-y' } : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
      >
        {main}
        {hasActions && (
          <MenuButton
            className="ui-row__more"
            label={actionsLabel ?? t('common.moreActions')}
            items={actions.map((action) => ({
              id: action.id,
              label: action.label,
              ...(action.icon ? { icon: action.icon } : {}),
              tone: action.tone === 'danger' ? ('danger' as const) : ('default' as const),
              onSelect: action.onSelect,
            }))}
          />
        )}
      </div>
    </div>
  );
}
