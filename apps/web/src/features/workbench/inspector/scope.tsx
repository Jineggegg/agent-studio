import { createContext, useContext, useMemo, useSyncExternalStore } from 'react';
import { type InspectorContext, type InspectorRequest, type InspectorRequestType, inspectorPanelsVersion, panelHandling, requestInspector, subscribeInspectorPanels } from './registry';

const Scope = createContext<InspectorContext | null>(null);

/** Tells everything inside the workbench which project and conversation a request to the inspector is about. */
export const InspectorScope = Scope.Provider;

/**
 * How the chat reaches a project tool: a function that hands a request of
 * this type to the panel that answers it, or null when no available panel
 * does — in which case the caller leaves its control out altogether.
 *
 *   const openFile = useInspectorAction('open-file');
 *   {openFile && <button onClick={() => openFile({ type: 'open-file', path })}>…</button>}
 */
export function useInspectorAction<T extends InspectorRequestType>(type: T): ((request: Extract<InspectorRequest, { type: T }>) => void) | null {
  const context = useContext(Scope);
  const version = useSyncExternalStore(subscribeInspectorPanels, inspectorPanelsVersion, inspectorPanelsVersion);
  return useMemo(() => {
    if (!context || !panelHandling(type, context)) return null;
    return (request: Extract<InspectorRequest, { type: T }>) => {
      requestInspector(request, context);
    };
    // `version` is what changes when a panel is registered.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context, type, version]);
}
