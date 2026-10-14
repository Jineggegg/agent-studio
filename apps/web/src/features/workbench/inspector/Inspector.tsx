import { X } from 'lucide-react';
import { type ComponentType, type PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useT } from '@/i18n';
import type { LayoutClass } from '@/platform/layout';
import { ScreenBoundary } from '@/shell/Boundary';
import { type LazyComponent, lazyScreen } from '@/shell/LazyScreen';
import { ActivityMark, CountBadge, Tabs, tabPanelProps } from '@/ui';
import { INSPECTOR_MAX_WIDTH, INSPECTOR_MIN_WIDTH, clampInspectorWidth } from '../device';
import {
  type InspectorContext,
  type InspectorPanel,
  type InspectorPanelProps,
  type InspectorPresentation,
  clearInspectorRequest,
  inspectorPanels,
  inspectorPanelsVersion,
  setInspectorOpen,
  setInspectorWidth,
  showInspectorPanel,
  subscribeInspectorPanels,
  useInspectorState,
} from './registry';

const loaders = new Map<string, LazyComponent<InspectorPanelProps>>();
function componentFor(panel: InspectorPanel): LazyComponent<InspectorPanelProps> {
  let component = loaders.get(panel.id);
  if (!component) loaders.set(panel.id, (component = lazyScreen(panel.load as () => Promise<{ default: ComponentType<InspectorPanelProps> }>)));
  return component;
}

/** The panels that can work here. Re-evaluated when a feature registers one (in practice: once, at start-up). */
export function useInspectorPanels(context: InspectorContext): InspectorPanel[] {
  const version = useSyncExternalStore(subscribeInspectorPanels, inspectorPanelsVersion, inspectorPanelsVersion);
  // `version` is what changes when the registry does.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => inspectorPanels(context), [context.project, context.sessionId, context.role, version]);
}

export const presentationFor = (layout: LayoutClass): InspectorPresentation => (layout === 'wide' ? 'docked' : layout === 'tablet' ? 'floating' : 'fullscreen');

const useNoBadge = (): null => null;

function TabBadge({ panel, context }: { panel: InspectorPanel; context: InspectorContext }) {
  // A panel always brings the same hook, so the hook called here never changes for a given tab.
  const useBadge = panel.useBadge ?? useNoBadge;
  const badge = useBadge(context);
  if (!badge) return null;
  if (badge.mark) return <ActivityMark kind={badge.mark} label={badge.label} />;
  return <CountBadge count={badge.count ?? 0} label={badge.label} />;
}

export interface InspectorProps {
  context: InspectorContext;
  panels: readonly InspectorPanel[];
  layout: LayoutClass;
  /** How wide the docked inspector may get without squeezing the chat below its minimum. */
  maxWidth: number;
}

/**
 * The container for a project's tools beside the chat. It decides how the
 * area is presented, which panel is on show, and how wide it is; what is
 * inside each panel is the panel's own business.
 *
 * It is rendered only while at least one panel is available. Closed, it
 * keeps "keep alive" panels mounted (hidden), so a terminal opened earlier
 * still has its shell when the inspector comes back.
 */
export function Inspector({ context, panels, layout, maxWidth }: InspectorProps) {
  const t = useT();
  const state = useInspectorState();
  const presentation = presentationFor(layout);
  const container = useRef<HTMLElement>(null);
  const active = panels.find((panel) => panel.id === state.panel) ?? panels[0];
  const open = state.open && active !== undefined;
  /** Panels that have been shown at least once and asked to stay mounted. */
  const [kept, setKept] = useState<string[]>([]);
  const [dragWidth, setDragWidth] = useState<number | null>(null);

  useEffect(() => {
    if (!open || !active?.keepAlive || kept.includes(active.id)) return;
    setKept((current) => [...current, active.id]);
  }, [open, active, kept]);

  // Covering the screen, the inspector behaves like any full-screen layer: focus moves in, Escape leaves.
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open || presentation === 'docked') return;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    container.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"], button')?.focus({ preventScroll: true });
    return () => {
      const previous = opener.current;
      if (previous && document.contains(previous)) previous.focus({ preventScroll: true });
    };
  }, [open, presentation]);

  const width = Math.min(clampInspectorWidth(dragWidth ?? state.width), Math.max(INSPECTOR_MIN_WIDTH, maxWidth));

  // ---- resizing (docked) -------------------------------------------------------
  const drag = useRef<{ id: number; startX: number; startWidth: number } | null>(null);
  const onHandleDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    drag.current = { id: event.pointerId, startX: event.clientX, startWidth: width };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  };
  const onHandleMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.id !== event.pointerId) return;
    // The inspector is at the trailing edge: dragging towards the leading edge widens it.
    setDragWidth(Math.min(Math.max(INSPECTOR_MIN_WIDTH, maxWidth), clampInspectorWidth(current.startWidth + (current.startX - event.clientX))));
  };
  const onHandleUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current || drag.current.id !== event.pointerId) return;
    drag.current = null;
    if (dragWidth !== null) setInspectorWidth(dragWidth);
    setDragWidth(null);
  };

  const close = useCallback(() => setInspectorOpen(false), []);
  const pending = state.pending;
  const handled = useCallback(() => {
    if (pending) clearInspectorRequest(pending.id);
  }, [pending]);

  if (!active) return null;
  const mounted = panels.filter((panel) => (open && panel.id === active.id) || kept.includes(panel.id));
  if (!open && mounted.length === 0) return null;

  return (
    <aside
      ref={container}
      className="wb-inspector"
      data-presentation={presentation}
      data-dragging={dragWidth !== null || undefined}
      hidden={!open}
      aria-label={t('workbench.inspector.title')}
      style={presentation === 'docked' ? { width } : undefined}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || presentation === 'docked' || event.defaultPrevented) return;
        // A panel with its own keys (an editor, a terminal) keeps Escape for itself.
        if (event.target instanceof Element && event.target.closest('.cm-editor, .xterm, [data-keys="own"]')) return;
        event.preventDefault();
        event.stopPropagation();
        close();
      }}
    >
      {presentation === 'docked' && (
        <div
          className="wb-inspector__handle"
          role="separator"
          aria-orientation="vertical"
          aria-label={t('workbench.inspector.resize')}
          aria-valuemin={INSPECTOR_MIN_WIDTH}
          aria-valuemax={Math.min(INSPECTOR_MAX_WIDTH, Math.max(INSPECTOR_MIN_WIDTH, maxWidth))}
          aria-valuenow={Math.round(width)}
          tabIndex={0}
          onPointerDown={onHandleDown}
          onPointerMove={onHandleMove}
          onPointerUp={onHandleUp}
          onPointerCancel={onHandleUp}
          onKeyDown={(event) => {
            const step = event.key === 'ArrowLeft' ? 24 : event.key === 'ArrowRight' ? -24 : 0;
            if (step === 0) return;
            event.preventDefault();
            setInspectorWidth(Math.min(Math.max(INSPECTOR_MIN_WIDTH, maxWidth), clampInspectorWidth(width + step)));
          }}
        />
      )}
      <header className="wb-inspector__bar">
        <Tabs
          label={t('workbench.inspector.title')}
          idBase="wb-inspector"
          value={active.id}
          onChange={showInspectorPanel}
          tabs={panels.map((panel) => {
            const Icon = panel.icon;
            return { value: panel.id, label: t(panel.title), icon: <Icon size={17} aria-hidden="true" />, accessory: <TabBadge panel={panel} context={context} /> };
          })}
        />
        <button type="button" className="wb-bar-button" onClick={close} aria-label={t('workbench.inspector.hide')} title={t('workbench.inspector.hide')}>
          <X size={20} aria-hidden="true" />
        </button>
      </header>
      {mounted.map((panel) => {
        const Panel = componentFor(panel);
        const shown = open && panel.id === active.id;
        return (
          <div key={panel.id} className="wb-inspector__panel" hidden={!shown} {...tabPanelProps('wb-inspector', panel.id)} tabIndex={-1}>
            <ScreenBoundary resetKey={`${panel.id}:${context.project?.id ?? ''}`}>
              <Panel
                project={context.project}
                sessionId={context.sessionId}
                active={shown}
                presentation={presentation}
                request={pending && pending.panel === panel.id ? pending.request : null}
                onRequestHandled={handled}
                close={close}
              />
            </ScreenBoundary>
          </div>
        );
      })}
    </aside>
  );
}
