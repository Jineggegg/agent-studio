import type { LayoutClass } from '@/platform/layout';
import { INSPECTOR_MIN_WIDTH, LIST_MAX_WIDTH, LIST_MIN_WIDTH, clampInspectorWidth, clampListWidth } from './device';

/**
 * How the workbench's columns share the width: the conversation list at the
 * leading edge, the chat, and the docked inspector at the trailing edge.
 *
 * The widths the reader chose are stored as chosen; what is drawn is decided
 * here from the space there is now, so a window made narrower and then wide
 * again gets the chosen widths back.
 */

/** The chat column never gets narrower than this while the list or the inspector is made wider. */
export const CHAT_MIN_WIDTH = 380;

/** Docked beside the chat on tablet and wide; a sheet from the leading edge on a phone; or hidden by the reader. */
export type ListPresentation = 'docked' | 'sheet' | 'hidden';

export function listPresentation(layout: LayoutClass, collapsed: boolean): ListPresentation {
  if (layout === 'phone') return 'sheet';
  return collapsed ? 'hidden' : 'docked';
}

export interface ColumnsInput {
  /** The workbench frame's width. */
  frameWidth: number;
  /** The list is docked beside the chat. */
  listDocked: boolean;
  /** The list's chosen width. */
  listWidth: number;
  /** The inspector is open as a docked column (wide only). */
  inspectorDocked: boolean;
  /** The inspector's chosen width. */
  inspectorWidth: number;
}

export interface Columns {
  /** The list's width as drawn (0 when it is not docked). */
  list: number;
  /** How wide the list may be made right now: as wide as the chat can spare, never by pushing the inspector. */
  listMax: number;
  /** How wide the docked inspector may get without squeezing the chat below its minimum. */
  inspectorMax: number;
}

export function arrangeColumns(input: ColumnsInput): Columns {
  const { frameWidth, inspectorDocked } = input;
  // When the window gets narrower the inspector gives way first, down to its minimum; then the list does.
  const list = input.listDocked ? Math.min(clampListWidth(input.listWidth), Math.max(LIST_MIN_WIDTH, frameWidth - CHAT_MIN_WIDTH - (inspectorDocked ? INSPECTOR_MIN_WIDTH : 0))) : 0;
  const inspectorMax = frameWidth - list - CHAT_MIN_WIDTH;
  const inspector = inspectorDocked ? Math.min(clampInspectorWidth(input.inspectorWidth), Math.max(INSPECTOR_MIN_WIDTH, inspectorMax)) : 0;
  const listMax = input.listDocked ? Math.max(list, Math.min(LIST_MAX_WIDTH, frameWidth - CHAT_MIN_WIDTH - inspector)) : 0;
  return { list, listMax, inspectorMax };
}
