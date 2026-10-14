import type { Project, Role } from '@agent-studio/protocol';
import type { LucideIcon } from 'lucide-react';
import type { ComponentType } from 'react';
import { create } from 'zustand';
import type { MessageKey } from '@/i18n';
import type { ActivityKind } from '@/ui';
import { setInspectorMemory, useDeviceMemory } from '../device';

/**
 * The workbench's inspector: the area beside the chat where a project's tools
 * live — files, a terminal, Git, a preview. The workbench owns the container
 * (docked and resizable on wide screens, floating over the chat on tablets,
 * full screen on phones; what is open, which panel, and how wide are
 * remembered per device). Each tool is a panel registered here:
 *
 *   // src/features/files/index.ts
 *   registerInspectorPanel({
 *     id: 'files',
 *     title: 'files.title',
 *     icon: FolderTree,
 *     order: 10,
 *     handles: ['open-file', 'reveal-folder'],
 *     load: () => import('./FilesPanel'),
 *   });
 *
 * With no panel registered there is no inspector at all — no empty column
 * and no button that opens nothing.
 */
export type InspectorPresentation = 'docked' | 'floating' | 'fullscreen';

/** Something the chat asks a panel to do: a file reference was tapped, a shell block's Run was pressed. */
export type InspectorRequest =
  /** `view: 'changes'` opens the file on its uncommitted changes rather than on its text. */
  | { type: 'open-file'; path: string; line?: number; view?: 'changes' }
  | { type: 'reveal-folder'; path: string }
  | { type: 'run-command'; text: string }
  | { type: 'show-changes'; path?: string };

export type InspectorRequestType = InspectorRequest['type'];

export interface InspectorContext {
  /** The project the workbench is showing; null for a conversation outside any project. */
  project: Project | null;
  /** The open conversation; null while it has not been sent yet. */
  sessionId: string | null;
  role: Role;
}

export interface InspectorPanelProps {
  project: Project | null;
  sessionId: string | null;
  /** True while this panel is the one on show. Pause polling and animation when it is not. */
  active: boolean;
  presentation: InspectorPresentation;
  /**
   * A request addressed to this panel, delivered until the panel says it has
   * dealt with it. Handle it in an effect and call `onRequestHandled()`.
   */
  request: InspectorRequest | null;
  onRequestHandled: () => void;
  /** Closes the inspector (the panel's own "done" action, if it has one). */
  close: () => void;
}

export interface InspectorBadge {
  count?: number;
  mark?: ActivityKind;
  /** Spoken description: "3 changed files". */
  label: string;
}

export interface InspectorPanel {
  /** Stable, lower-case: `files`, `terminal`, `git`, `preview`. Remembered per device as the panel last on show. */
  id: string;
  title: MessageKey;
  icon: LucideIcon;
  /** Position among the tabs; lower comes first. Default 100. */
  order?: number;
  /** `() => import('./FilesPanel')` — the default export renders the panel's content and fills the area it is given. */
  load: () => Promise<{ default: ComponentType<InspectorPanelProps> }>;
  /**
   * Whether the panel can work here. Default: only inside a project. A panel
   * that is not available is not listed; when none is, there is no inspector.
   */
  available?: (context: InspectorContext) => boolean;
  /**
   * The requests this panel answers. The chat offers "open file" or "Run" only when some available panel does.
   * A function when the answer depends on who is asking (a terminal only the owner may use).
   */
  handles?: readonly InspectorRequestType[] | ((context: InspectorContext) => readonly InspectorRequestType[]);
  /**
   * Stay mounted (hidden) once opened, while another panel is on show or the
   * inspector is closed — for a terminal that must keep its shell and
   * scrollback. Default false: the panel unmounts when it is not on show.
   */
  keepAlive?: boolean;
  /** A hook for a badge on the panel's tab. Return null for none. Called only while the inspector's tabs are drawn. */
  useBadge?: (context: InspectorContext) => InspectorBadge | null;
}

const panels: InspectorPanel[] = [];
const listeners = new Set<() => void>();
let version = 0;

/** Add panels to the inspector. Call at module load, from the feature's `index.ts`. */
export function registerInspectorPanel(...added: InspectorPanel[]): void {
  for (const panel of added) {
    if (!/^[a-z][a-z0-9-]*$/.test(panel.id)) throw new Error(`"${panel.id}" is not a valid inspector panel id.`);
    if (panels.some((existing) => existing.id === panel.id)) throw new Error(`The inspector panel "${panel.id}" is registered twice.`);
    panels.push(panel);
  }
  version += 1;
  for (const listener of [...listeners]) listener();
}

const defaultAvailable = (context: InspectorContext): boolean => context.project !== null;

/** The panels that can work in this context, in display order. */
export function inspectorPanels(context: InspectorContext): InspectorPanel[] {
  return panels.filter((panel) => (panel.available ?? defaultAvailable)(context)).sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
}

export function subscribeInspectorPanels(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const inspectorPanelsVersion = (): number => version;

/** What a registered panel offers (`available`, `handles`) has changed: the workbench asks again. */
export function refreshInspectorPanels(): void {
  version += 1;
  for (const listener of [...listeners]) listener();
}

/** The panel that would take a request of this type, if any is available. */
export function panelHandling(type: InspectorRequestType, context: InspectorContext): InspectorPanel | null {
  return inspectorPanels(context).find((panel) => (typeof panel.handles === 'function' ? panel.handles(context) : panel.handles)?.includes(type)) ?? null;
}

// ---- what is open ------------------------------------------------------------------

interface InspectorRuntime {
  /** A request waiting for its panel, and the panel it is for. */
  pending: { panel: string; request: InspectorRequest; id: number } | null;
}

const useInspectorRuntime = create<InspectorRuntime>(() => ({ pending: null }));
let requestCounter = 0;

export interface InspectorState {
  open: boolean;
  /** The panel last on show; may name one that is not available here. */
  panel: string | null;
  width: number;
  pending: InspectorRuntime['pending'];
}

export function useInspectorState(): InspectorState {
  const memory = useDeviceMemory((state) => state.inspector);
  const pending = useInspectorRuntime((state) => state.pending);
  return { open: memory.open, panel: memory.panel, width: memory.width, pending };
}

export const setInspectorOpen = (open: boolean): void => setInspectorMemory({ open });
export const toggleInspector = (): void => setInspectorMemory({ open: !useDeviceMemory.getState().inspector.open });
export const showInspectorPanel = (panel: string): void => setInspectorMemory({ open: true, panel });
export const setInspectorWidth = (width: number): void => setInspectorMemory({ width });

/**
 * Opens the inspector on the panel that handles `request` and hands it over.
 * Returns false — and does nothing — when no available panel handles it, so
 * callers can leave the affordance out instead of offering a dead one
 * (check first with `panelHandling`).
 */
export function requestInspector(request: InspectorRequest, context: InspectorContext): boolean {
  const panel = panelHandling(request.type, context);
  if (!panel) return false;
  useInspectorRuntime.setState({ pending: { panel: panel.id, request, id: (requestCounter += 1) } });
  showInspectorPanel(panel.id);
  return true;
}

export function clearInspectorRequest(id: number): void {
  useInspectorRuntime.setState((state) => (state.pending?.id === id ? { pending: null } : state));
}

/** For tests. */
export function __resetInspectorForTests(): void {
  panels.length = 0;
  version += 1;
  useInspectorRuntime.setState({ pending: null });
}
