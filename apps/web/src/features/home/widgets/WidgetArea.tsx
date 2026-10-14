import type { PluginContributions } from '@agent-studio/protocol';
import { ChevronLeft, ChevronRight, Minus } from 'lucide-react';
import { type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type Ref, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { type MessageKey, useT } from '@/i18n';
import { featureRouteFor } from '@/registry';
import { type DropResult, type Ghost, useGridDrag } from '../drag';
import { useFlip } from '../flip';
import { WIDGET_SIZES, type WidgetEntry, type WidgetSize, moveWidget, removeWidget, resizeWidget, stepSize } from '../layout';
import { PluginLinks, type Reading, WIDGET_KINDS, useInboxReading, useRunningReading, useUsageReading } from './kinds';

export const SIZE_WORDS: Record<WidgetSize, MessageKey> = { small: 'home.widget.small', medium: 'home.widget.medium', large: 'home.widget.large' };

interface FrameProps {
  widget: WidgetEntry;
  editing: boolean;
  /** The size shown — while its handle is dragged, the one it would get. */
  size: WidgetSize;
  title: string;
  badge: string | null;
  /** Where a tap leads, outside edit mode; null when its parts are what is tapped. */
  to: string | null;
  onOpen: (to: string) => void;
  children: ReactNode;
}

/** The card every widget shares: its name and freshness on top, its reading below; tapping it opens its app. */
function WidgetFrame({ widget, editing, size, title, badge, to, onOpen, children }: FrameProps) {
  const t = useT();
  const kind = WIDGET_KINDS[widget.type];
  const Icon = kind.icon;
  const head = (
    <span className="hw-head">
      <span className="hw-head__icon" data-tint={kind.tint} aria-hidden="true">
        <Icon size={14} strokeWidth={2.4} />
      </span>
      <span className="hw-head__title u-truncate">{title}</span>
      {badge && <span className="hw-head__badge">{badge}</span>}
    </span>
  );
  // The whole card opens its app through one button stretched over it; what it shows stays ordinary text and lists.
  return (
    <div className="hw-card__face" data-size={size} role="group" aria-label={title}>
      {!editing && to && <button type="button" className="hw-card__open u-no-callout" onClick={() => onOpen(to)} aria-label={t('home.widget.open', { name: title })} />}
      {head}
      <div className="hw-card__body">{children}</div>
    </div>
  );
}

interface CardProps {
  widget: WidgetEntry;
  editing: boolean;
  size: WidgetSize;
  contributions: PluginContributions | undefined;
  onOpen: (to: string) => void;
}

const routeOf = (to: string | null): string | null => (to && featureRouteFor(to) ? to : null);

function ReadingCard({ reading, ...props }: CardProps & { reading: Reading }) {
  const t = useT();
  const kind = WIDGET_KINDS[props.widget.type];
  return (
    <WidgetFrame widget={props.widget} editing={props.editing} size={props.size} title={t(kind.title)} badge={reading.badge} to={routeOf(kind.to)} onOpen={props.onOpen}>
      {reading.body}
    </WidgetFrame>
  );
}

function UsageCard(props: CardProps) {
  return <ReadingCard {...props} reading={useUsageReading(props.size)} />;
}
function InboxCard(props: CardProps) {
  return <ReadingCard {...props} reading={useInboxReading(props.size)} />;
}
function RunningCard(props: CardProps) {
  return <ReadingCard {...props} reading={useRunningReading(props.size)} />;
}
function LinksCard(props: CardProps) {
  const t = useT();
  const name = props.contributions?.linkTiles.find((link) => link.pluginId === props.widget.pluginId)?.pluginName ?? props.widget.pluginId ?? '';
  return (
    <WidgetFrame widget={props.widget} editing={props.editing} size={props.size} title={t('home.widget.linksOf', { plugin: name })} badge={null} to={null} onOpen={props.onOpen}>
      <PluginLinks widget={props.widget} editing={props.editing} contributions={props.contributions} size={props.size} />
    </WidgetFrame>
  );
}

const CARDS = { usage: UsageCard, inbox: InboxCard, running: RunningCard, 'plugin-links': LinksCard } as const;

/**
 * The size handle at a widget's corner: dragged, it snaps between small,
 * medium and large as soon as the corner passes half a cell; for keyboards
 * and assistive technology it is a slider whose value is the size's name.
 */
function ResizeHandle({ widget, size, onPreview, onCommit, name }: { widget: WidgetEntry; size: WidgetSize; onPreview: (size: WidgetSize | null) => void; onCommit: (size: WidgetSize) => void; name: string }) {
  const t = useT();
  const start = useRef<{ id: number; left: number; top: number; cell: number; row: number; size: WidgetSize } | null>(null);
  const sizeFor = (x: number, y: number): WidgetSize => {
    const origin = start.current!;
    const tall = y - origin.top > origin.row * 1.5;
    const wide = x - origin.left > origin.cell * 1.5;
    return tall ? 'large' : wide ? 'medium' : 'small';
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next =
      event.key === 'ArrowRight' || event.key === 'ArrowUp'
        ? stepSize(size, 1)
        : event.key === 'ArrowLeft' || event.key === 'ArrowDown'
          ? stepSize(size, -1)
          : event.key === 'Home'
            ? 'small'
            : event.key === 'End'
              ? 'large'
              : null;
    if (!next) return;
    event.preventDefault();
    if (next !== size) onCommit(next);
  };
  return (
    <div
      className="hw-resize"
      role="slider"
      tabIndex={0}
      data-no-drag=""
      aria-label={t('home.widget.resize', { name })}
      aria-valuemin={0}
      aria-valuemax={WIDGET_SIZES.length - 1}
      aria-valuenow={WIDGET_SIZES.indexOf(size)}
      aria-valuetext={t(SIZE_WORDS[size])}
      onKeyDown={onKeyDown}
      onPointerDown={(event: ReactPointerEvent<HTMLDivElement>) => {
        const card = event.currentTarget.closest<HTMLElement>('.hw-card');
        const area = event.currentTarget.closest<HTMLElement>('.hw-area');
        if (!card || !area) return;
        event.stopPropagation();
        event.preventDefault();
        const rect = card.getBoundingClientRect();
        const columns = Number(getComputedStyle(area).getPropertyValue('--hw-columns')) || 2;
        const gap = 12;
        const cell = (area.clientWidth - gap * (columns - 1)) / columns;
        const row = Number.parseFloat(getComputedStyle(area).getPropertyValue('--hw-row')) || cell;
        start.current = { id: event.pointerId, left: rect.left, top: rect.top, cell, row, size };
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!start.current || start.current.id !== event.pointerId) return;
        onPreview(sizeFor(event.clientX, event.clientY));
      }}
      onPointerUp={(event) => {
        if (!start.current || start.current.id !== event.pointerId) return;
        const next = sizeFor(event.clientX, event.clientY);
        start.current = null;
        onPreview(null);
        if (next !== widget.size) onCommit(next);
      }}
      onPointerCancel={() => {
        start.current = null;
        onPreview(null);
      }}
    >
      <span aria-hidden="true" />
    </div>
  );
}

export interface WidgetAreaProps {
  widgets: readonly WidgetEntry[];
  editing: boolean;
  contributions: PluginContributions | undefined;
  onEnterEdit: () => void;
  /** Commits a new list of widgets. */
  onChange: (widgets: WidgetEntry[]) => void;
  onOpen: (to: string) => void;
  announce: (text: string) => void;
  areaRef?: Ref<HTMLDivElement>;
}

/** The widgets above the first page's tiles: reordered by dragging or by their move buttons, resized, removed. */
export function WidgetArea({ widgets, editing, contributions, onEnterEdit, onChange, onOpen, announce, areaRef }: WidgetAreaProps) {
  const t = useT();
  const area = useRef<HTMLDivElement | null>(null);
  const [resizing, setResizing] = useState<{ id: string; size: WidgetSize } | null>(null);
  const ids = widgets.map((widget) => widget.id);
  const nameOf = (widget: WidgetEntry): string =>
    widget.type === 'plugin-links'
      ? t('home.widget.linksOf', { plugin: contributions?.linkTiles.find((link) => link.pluginId === widget.pluginId)?.pluginName ?? widget.pluginId ?? '' })
      : t(WIDGET_KINDS[widget.type].title);

  const drag = useGridDrag({
    container: area,
    editing,
    ids,
    onEnterEdit,
    onDrop: (result: DropResult) => {
      if (result.kind !== 'order') return;
      const index = result.ids.indexOf(result.dragged);
      onChange(moveWidget(widgets, result.dragged, index));
      const moved = widgets.find((widget) => widget.id === result.dragged);
      if (moved) announce(t('home.widget.moved', { name: nameOf(moved), position: t.number(index + 1), count: t.number(widgets.length) }));
    },
  });
  const order = drag.preview ?? ids;
  const shown = order.map((id) => widgets.find((widget) => widget.id === id)).filter((widget): widget is WidgetEntry => widget !== undefined);
  useFlip(area, `${order.join()}|${widgets.map((widget) => widget.size).join()}`);

  const move = (widget: WidgetEntry, delta: -1 | 1) => {
    const index = ids.indexOf(widget.id) + delta;
    if (index < 0 || index >= ids.length) return;
    onChange(moveWidget(widgets, widget.id, index));
    announce(t('home.widget.moved', { name: nameOf(widget), position: t.number(index + 1), count: t.number(widgets.length) }));
  };

  return (
    <div
      ref={(element) => {
        area.current = element;
        if (typeof areaRef === 'function') areaRef(element);
        else if (areaRef) (areaRef as { current: HTMLDivElement | null }).current = element;
      }}
      className="hw-area"
      data-editing={editing || undefined}
      role="list"
      aria-label={t('home.widget.areaLabel')}
    >
      {shown.map((widget) => {
        const size = resizing?.id === widget.id ? resizing.size : widget.size;
        const Card = CARDS[widget.type];
        const name = nameOf(widget);
        const index = ids.indexOf(widget.id);
        return (
          <div
            key={widget.id}
            role="listitem"
            className="hw-card u-no-callout"
            data-size={size}
            data-slot-id={widget.id}
            data-flip-id={`widget:${widget.id}`}
            data-lifted={drag.dragged === widget.id || undefined}
            data-resizing={resizing?.id === widget.id || undefined}
            {...drag.bind(widget.id)}
          >
            <Card widget={widget} editing={editing} size={size} contributions={contributions} onOpen={onOpen} />
            {editing && (
              <>
                <button
                  type="button"
                  className="tile__badge hw-card__badge"
                  data-no-drag=""
                  aria-label={t('home.widget.remove', { name })}
                  title={t('home.widget.remove', { name })}
                  onClick={() => {
                    onChange(removeWidget(widgets, widget.id));
                    announce(t('home.widget.removed', { name }));
                  }}
                >
                  <Minus size={14} strokeWidth={3} aria-hidden="true" />
                </button>
                <ResizeHandle
                  widget={widget}
                  size={size}
                  name={name}
                  onPreview={(next) => setResizing(next ? { id: widget.id, size: next } : null)}
                  onCommit={(next) => {
                    onChange(resizeWidget(widgets, widget.id, next));
                    announce(t('home.widget.resized', { name, size: t(SIZE_WORDS[next]) }));
                  }}
                />
                <div className="tile__access hw-card__access" data-no-drag="" role="group" aria-label={t('home.widget.controlsOf', { name })}>
                  <button type="button" className="tile__access-button" aria-label={t('home.widget.earlier', { name })} disabled={index <= 0} onClick={() => move(widget, -1)}>
                    <ChevronLeft size={16} aria-hidden="true" />
                  </button>
                  <button type="button" className="tile__access-button" aria-label={t('home.widget.later', { name })} disabled={index >= ids.length - 1} onClick={() => move(widget, 1)}>
                    <ChevronRight size={16} aria-hidden="true" />
                  </button>
                </div>
              </>
            )}
          </div>
        );
      })}
      {drag.ghost && <WidgetGhost ghost={drag.ghost} ghostRef={drag.ghostRef} widget={widgets.find((widget) => widget.id === drag.ghost!.id)} name={nameOf(widgets.find((widget) => widget.id === drag.ghost!.id) ?? widgets[0]!)} />}
    </div>
  );
}

/** The lifted copy: a still picture of the card, following the finger. */
function WidgetGhost({ ghost, ghostRef, widget, name }: { ghost: Ghost; ghostRef: Ref<HTMLDivElement | null>; widget: WidgetEntry | undefined; name: string }) {
  const own = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (own.current) own.current.style.transform = `translate3d(${ghost.x}px, ${ghost.y}px, 0)`;
    // Placed once; the drag moves it from here on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ghost.id]);
  if (!widget) return null;
  const kind = WIDGET_KINDS[widget.type];
  const Icon = kind.icon;
  // Above everything, and outside any scrolled or moving ancestor.
  return createPortal(
    <div
      ref={(element) => {
        own.current = element;
        if (typeof ghostRef === 'function') ghostRef(element);
        else if (ghostRef) (ghostRef as { current: HTMLDivElement | null }).current = element;
      }}
      className="hw-ghost"
      style={{ width: ghost.width, height: ghost.height } as CSSProperties}
      aria-hidden="true"
    >
      <span className="hw-head">
        <span className="hw-head__icon" data-tint={kind.tint}>
          <Icon size={14} strokeWidth={2.4} />
        </span>
        <span className="hw-head__title u-truncate">{name}</span>
      </span>
    </div>,
    document.body,
  );
}
