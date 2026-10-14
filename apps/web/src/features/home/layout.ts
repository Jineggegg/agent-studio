/**
 * The launcher's arrangement as a pure model: which tiles show where, folders,
 * hidden tiles, names, page starts and widgets. It is stored as one account
 * preference (`home.layout`) and so follows the person to every device.
 *
 * Reading never trusts what is stored: anything malformed falls back to the
 * default for that part, a tile ends up in exactly one place, names are one
 * short line. Ids this device does not know (a project not loaded yet, a
 * plugin's tile) are kept in the stored value — they are not this device's to
 * drop — and pruned only when a write is made with the whole catalogue known.
 *
 * Every operation returns a new layout and never mutates its input.
 */

export const HOME_LAYOUT_KEY = 'home.layout';
export const LAYOUT_VERSION = 1;
/** Custom names are cut to this many characters (code points). */
export const NAME_MAX = 24;
export const MAX_WIDGETS = 12;
const MAX_IDS = 600;

export const WIDGET_TYPES = ['usage', 'inbox', 'running', 'plugin-links'] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];
export const WIDGET_SIZES = ['small', 'medium', 'large'] as const;
export type WidgetSize = (typeof WIDGET_SIZES)[number];

export interface WidgetEntry {
  id: string;
  type: WidgetType;
  size: WidgetSize;
  /** For `plugin-links`: whose links. */
  pluginId?: string;
}

export interface Folder {
  name: string;
  /** Tile ids, in order. Never a folder: folders do not nest. */
  items: string[];
}

export interface HomeLayout {
  version: typeof LAYOUT_VERSION;
  /** Top level, in order: tile ids and folder ids. Empty means "the natural order". */
  order: string[];
  /** Top-level ids that begin a new page. */
  pageStarts: string[];
  folders: Record<string, Folder>;
  hidden: string[];
  /** Custom names of tiles, by tile id. */
  names: Record<string, string>;
  /** Null: never chosen — the device shows its defaults. */
  widgets: WidgetEntry[] | null;
}

export type LayoutStatus = 'empty' | 'ok' | 'repaired' | 'unreadable';

export const EMPTY_LAYOUT: HomeLayout = Object.freeze({ version: LAYOUT_VERSION, order: [], pageStarts: [], folders: {}, hidden: [], names: {}, widgets: null }) as HomeLayout;

// ---- ids ------------------------------------------------------------------------------------

const TILE_ID = /^(system:[a-z0-9][a-z0-9-]{0,63}|project:[0-9a-z]{26}|panel:[a-z][a-z0-9.-]{1,47}:[a-z][a-z0-9-]{0,31}|link:[a-z][a-z0-9.-]{1,47}:[a-z][a-z0-9-]{0,31})$/;
const FOLDER_ID = /^folder:[a-z0-9]{4,24}$/;
const WIDGET_ID = /^w:[a-z0-9]{4,24}$/;
const PLUGIN_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;

export const isTileId = (value: unknown): value is string => typeof value === 'string' && TILE_ID.test(value);
export const isFolderId = (value: unknown): value is string => typeof value === 'string' && FOLDER_ID.test(value);

export const tileIds = {
  system: (id: string): string => `system:${id}`,
  project: (id: string): string => `project:${id}`,
  panel: (pluginId: string, panelId: string): string => `panel:${pluginId}:${panelId}`,
  link: (pluginId: string, linkId: string): string => `link:${pluginId}:${linkId}`,
};

function randomPart(): string {
  const bytes = new Uint8Array(8);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (byte) => (byte % 36).toString(36)).join('');
}
export const newFolderId = (): string => `folder:${randomPart()}`;
export const newWidgetId = (): string => `w:${randomPart()}`;

// ---- names ------------------------------------------------------------------------------------

/** A name as stored and shown: one line, no control characters, at most NAME_MAX characters. */
export function cleanName(value: string): string {
  // eslint-disable-next-line no-control-regex
  const line = value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(line).slice(0, NAME_MAX).join('').trim();
}

// ---- reading what is stored -----------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Turns whatever is stored into a layout, keeping every part that is sound. */
export function parseLayout(value: unknown): { layout: HomeLayout; status: LayoutStatus } {
  if (value === undefined || value === null) return { layout: EMPTY_LAYOUT, status: 'empty' };
  if (!isRecord(value) || value.version !== LAYOUT_VERSION) return { layout: EMPTY_LAYOUT, status: 'unreadable' };
  let repaired = false;
  const strings = (input: unknown, accept: (item: string) => boolean): string[] => {
    if (input === undefined) return [];
    if (!Array.isArray(input)) {
      repaired = true;
      return [];
    }
    const out: string[] = [];
    for (const item of input.slice(0, MAX_IDS)) {
      if (typeof item === 'string' && accept(item) && !out.includes(item)) out.push(item);
      else repaired = true;
    }
    if (input.length > MAX_IDS) repaired = true;
    return out;
  };

  const hidden = strings(value.hidden, isTileId);
  // Folders: a valid id, a name, tile ids only; a tile belongs to the first folder that names it.
  const folders: Record<string, Folder> = {};
  const inFolder = new Set<string>();
  const rawFolders = value.folders === undefined ? {} : value.folders;
  if (!isRecord(rawFolders)) repaired = true;
  else {
    const rawOrder = Array.isArray(value.order) ? value.order : [];
    // Folders in the order they appear at the top level first: "first wins" follows what the person sees.
    const keys = [...rawOrder.filter((key): key is string => typeof key === 'string' && Object.hasOwn(rawFolders, key)), ...Object.keys(rawFolders)];
    for (const key of [...new Set(keys)]) {
      const raw = rawFolders[key];
      if (!isFolderId(key) || !isRecord(raw)) {
        repaired = true;
        continue;
      }
      const items = strings(raw.items, isTileId).filter((item) => {
        if (inFolder.has(item) || hidden.includes(item)) {
          repaired = true;
          return false;
        }
        inFolder.add(item);
        return true;
      });
      const name = typeof raw.name === 'string' ? cleanName(raw.name) : '';
      if (typeof raw.name !== 'string' || name !== raw.name) repaired = true;
      if (items.length === 0) {
        repaired = true;
        continue;
      }
      folders[key] = { name, items };
    }
  }

  const order = strings(value.order, (item) => (isTileId(item) && !inFolder.has(item) && !hidden.includes(item)) || (isFolderId(item) && Object.hasOwn(folders, item)));
  for (const key of Object.keys(folders)) if (!order.includes(key)) order.push(key);
  const pageStarts = strings(value.pageStarts, (item) => order.includes(item));

  const names: Record<string, string> = {};
  if (value.names !== undefined && !isRecord(value.names)) repaired = true;
  else if (isRecord(value.names)) {
    for (const [key, raw] of Object.entries(value.names)) {
      const name = typeof raw === 'string' ? cleanName(raw) : '';
      if (!isTileId(key) || name === '') {
        repaired = true;
        continue;
      }
      if (name !== raw) repaired = true;
      names[key] = name;
    }
  }

  let widgets: WidgetEntry[] | null = null;
  if (value.widgets !== undefined && value.widgets !== null) {
    if (!Array.isArray(value.widgets)) repaired = true;
    else {
      widgets = [];
      for (const raw of value.widgets.slice(0, MAX_WIDGETS)) {
        if (
          isRecord(raw) &&
          typeof raw.id === 'string' &&
          WIDGET_ID.test(raw.id) &&
          (WIDGET_TYPES as readonly unknown[]).includes(raw.type) &&
          (WIDGET_SIZES as readonly unknown[]).includes(raw.size) &&
          !widgets.some((widget) => widget.id === raw.id) &&
          (raw.type !== 'plugin-links' || (typeof raw.pluginId === 'string' && PLUGIN_ID.test(raw.pluginId)))
        ) {
          widgets.push({ id: raw.id, type: raw.type as WidgetType, size: raw.size as WidgetSize, ...(raw.type === 'plugin-links' ? { pluginId: raw.pluginId as string } : {}) });
        } else repaired = true;
      }
      if (value.widgets.length > MAX_WIDGETS) repaired = true;
    }
  }

  return { layout: { version: LAYOUT_VERSION, order, pageStarts, folders, hidden, names, widgets }, status: repaired ? 'repaired' : 'ok' };
}

// ---- what is shown ---------------------------------------------------------------------------------

export type Entry = { kind: 'tile'; id: string } | { kind: 'folder'; id: string; name: string; items: string[] };

export interface Arrangement {
  /** Top level, in order. Every known, visible tile is here once — directly or in a folder. */
  entries: Entry[];
  /** Ids of entries that begin a page. */
  pageStarts: ReadonlySet<string>;
  /** Hidden tiles this device knows, for the library. */
  hidden: string[];
}

/**
 * What the launcher shows: the stored arrangement, with tiles this device
 * does not know skipped (and kept in storage), empty folders left out, and
 * tiles the arrangement does not mention yet appended in their natural order.
 */
export function arrange(layout: HomeLayout, known: readonly string[]): Arrangement {
  const knownSet = new Set(known);
  const hidden = new Set(layout.hidden);
  const placed = new Set<string>();
  const entries: Entry[] = [];
  for (const id of layout.order) {
    if (isFolderId(id)) {
      const folder = layout.folders[id];
      if (!folder) continue;
      const items = folder.items.filter((item) => knownSet.has(item) && !hidden.has(item) && !placed.has(item));
      for (const item of items) placed.add(item);
      if (items.length > 0) entries.push({ kind: 'folder', id, name: folder.name, items });
    } else if (knownSet.has(id) && !hidden.has(id) && !placed.has(id)) {
      placed.add(id);
      entries.push({ kind: 'tile', id });
    }
  }
  // Tiles inside folders that the order does not mention (a damaged value) are still shown, in their folder.
  for (const [id, folder] of Object.entries(layout.folders)) {
    if (layout.order.includes(id)) continue;
    const items = folder.items.filter((item) => knownSet.has(item) && !hidden.has(item) && !placed.has(item));
    for (const item of items) placed.add(item);
    if (items.length > 0) entries.push({ kind: 'folder', id, name: folder.name, items });
  }
  for (const id of known) {
    if (placed.has(id) || hidden.has(id)) continue;
    placed.add(id);
    entries.push({ kind: 'tile', id });
  }
  const ids = new Set(entries.map((entry) => entry.id));
  return { entries, pageStarts: new Set(layout.pageStarts.filter((id) => ids.has(id))), hidden: layout.hidden.filter((id) => knownSet.has(id)) };
}

/**
 * Splits entries into pages: the first holds `firstCapacity` (the widgets
 * take room there), the others `capacity`; an entry that begins a page starts
 * a new one even when the page before is not full. Always at least one page.
 */
export function paginate<T extends { id: string }>(entries: readonly T[], firstCapacity: number, capacity: number, pageStarts: ReadonlySet<string>): T[][] {
  const pages: T[][] = [[]];
  for (const entry of entries) {
    let page = pages[pages.length - 1]!;
    const room = pages.length === 1 ? Math.max(0, firstCapacity) : Math.max(1, capacity);
    if (page.length >= room || (page.length > 0 && pageStarts.has(entry.id))) {
      page = [];
      pages.push(page);
    }
    page.push(entry);
  }
  return pages;
}

// ---- writing: keeping what this device does not know ---------------------------------------------------

/**
 * The stored order after a change made on what this device shows: the new
 * order of the known entries, with every id this device does not know kept
 * right after the known entry it followed before.
 */
export function mergeUnknown(previous: readonly string[], next: readonly string[], isKnown: (id: string) => boolean): string[] {
  const nextSet = new Set(next);
  const result = [...next];
  const leading: string[] = [];
  const after = new Map<string, string[]>();
  let anchor: string | null = null;
  for (const id of previous) {
    if (nextSet.has(id)) {
      anchor = id;
      continue;
    }
    // Known here and no longer in the order: it was moved into a folder, hidden or dissolved.
    if (isKnown(id)) continue;
    if (anchor === null) leading.push(id);
    else after.set(anchor, [...(after.get(anchor) ?? []), id]);
  }
  for (const [key, ids] of after) result.splice(result.indexOf(key) + 1, 0, ...ids);
  return [...leading, ...result];
}

/** Context every arrangement operation needs: what is shown, and which ids this device knows. */
export interface Scene {
  arrangement: Arrangement;
  known: ReadonlySet<string>;
}

function withOrder(layout: HomeLayout, scene: Scene, nextIds: readonly string[], starts: ReadonlySet<string>): HomeLayout {
  // A folder is this device's to rearrange only when it shows it: one whose tiles are all unknown here (still loading) is kept.
  const shown = new Set(scene.arrangement.entries.map((entry) => entry.id));
  const isKnown = (id: string) => scene.known.has(id) || shown.has(id);
  const order = mergeUnknown(layout.order, nextIds, isKnown);
  return { ...layout, order, pageStarts: order.filter((id) => starts.has(id)) };
}

/** Page starts belong to places, not to tiles: after a move, the same places begin pages. */
function startsAtSamePlaces(before: readonly string[], after: readonly string[], starts: ReadonlySet<string>): Set<string> {
  const result = new Set<string>();
  before.forEach((id, index) => {
    if (starts.has(id) && after[index] !== undefined) result.add(after[index]!);
  });
  return result;
}

const idsOf = (scene: Scene): string[] => scene.arrangement.entries.map((entry) => entry.id);

/** Moves a top-level entry to `index` among what is shown. */
export function moveEntry(layout: HomeLayout, scene: Scene, id: string, index: number): HomeLayout {
  const ids = idsOf(scene);
  const from = ids.indexOf(id);
  if (from === -1) return layout;
  const target = Math.max(0, Math.min(ids.length - 1, index));
  if (target === from) return layout;
  const next = [...ids];
  next.splice(from, 1);
  next.splice(target, 0, id);
  return withOrder(layout, scene, next, startsAtSamePlaces(ids, next, scene.arrangement.pageStarts));
}

/** Moves an entry one place earlier (−1) or later (+1). */
export const moveBy = (layout: HomeLayout, scene: Scene, id: string, delta: -1 | 1): HomeLayout => {
  const index = idsOf(scene).indexOf(id);
  return index === -1 ? layout : moveEntry(layout, scene, id, index + delta);
};

/** Puts an order shown during a drag in place (the same entries, rearranged), keeping page starts at their places. */
export function applyOrder(layout: HomeLayout, scene: Scene, ids: readonly string[]): HomeLayout {
  const current = idsOf(scene);
  if (ids.length !== current.length || !ids.every((id) => current.includes(id))) return layout;
  return withOrder(layout, scene, ids, startsAtSamePlaces(current, ids, scene.arrangement.pageStarts));
}

/** Moves an entry to the end and starts a new page with it (a drop on the empty page offered while dragging). */
export function moveToNewPage(layout: HomeLayout, scene: Scene, id: string): HomeLayout {
  const ids = idsOf(scene);
  if (!ids.includes(id)) return layout;
  const next = [...ids.filter((entry) => entry !== id), id];
  const starts = startsAtSamePlaces(ids, next, scene.arrangement.pageStarts);
  starts.add(id);
  return withOrder(layout, scene, next, starts);
}

/** Takes a tile off the launcher (into the library). */
export function hideTile(layout: HomeLayout, scene: Scene, tileId: string): HomeLayout {
  if (!isTileId(tileId) || layout.hidden.includes(tileId)) return layout;
  const base = withOrder(layout, scene, idsOf(scene), scene.arrangement.pageStarts);
  const folders = removeFromFolders(base.folders, tileId);
  const order = base.order.filter((id) => id !== tileId && (!isFolderId(id) || Object.hasOwn(folders, id)));
  return { ...base, order, pageStarts: base.pageStarts.filter((id) => order.includes(id)), folders, hidden: [...base.hidden, tileId] };
}

/** Back from the library, at the end of the launcher. */
export function restoreTile(layout: HomeLayout, scene: Scene, tileId: string): HomeLayout {
  if (!layout.hidden.includes(tileId)) return layout;
  const base = withOrder(layout, scene, idsOf(scene), scene.arrangement.pageStarts);
  return { ...base, hidden: base.hidden.filter((id) => id !== tileId), order: [...base.order.filter((id) => id !== tileId), tileId] };
}

/** A custom name; empty, or the tile's own name, goes back to that name. */
export function renameTile(layout: HomeLayout, tileId: string, name: string, defaultName: string): HomeLayout {
  const clean = cleanName(name);
  const names = { ...layout.names };
  if (clean === '' || clean === cleanName(defaultName)) delete names[tileId];
  else names[tileId] = clean;
  return { ...layout, names };
}

function removeFromFolders(folders: Record<string, Folder>, tileId: string): Record<string, Folder> {
  const next: Record<string, Folder> = {};
  for (const [id, folder] of Object.entries(folders)) {
    const items = folder.items.filter((item) => item !== tileId);
    if (items.length > 0) next[id] = items.length === folder.items.length ? folder : { ...folder, items };
  }
  return next;
}

/** Drops tile `dragged` on tile `target`: a folder holding both takes the target's place. */
export function makeFolder(layout: HomeLayout, scene: Scene, dragged: string, target: string, name: string, folderId = newFolderId()): HomeLayout {
  if (dragged === target || !isTileId(dragged) || !isTileId(target)) return layout;
  const ids = idsOf(scene);
  if (!ids.includes(target)) return layout;
  const next = ids.filter((id) => id !== dragged).map((id) => (id === target ? folderId : id));
  const starts = new Set([...scene.arrangement.pageStarts].map((id) => (id === target ? folderId : id)).filter((id) => id !== dragged));
  const base = withOrder(layout, scene, next, starts);
  const folders = removeFromFolders(base.folders, dragged);
  folders[folderId] = { name: cleanName(name), items: [target, dragged] };
  return { ...base, folders, order: base.order.filter((id) => id !== dragged) };
}

/** Puts a tile into a folder, at its end. */
export function addToFolder(layout: HomeLayout, scene: Scene, tileId: string, folderId: string): HomeLayout {
  const folder = layout.folders[folderId];
  if (!folder || !isTileId(tileId) || folder.items.includes(tileId)) return layout;
  const ids = idsOf(scene).filter((id) => id !== tileId);
  const base = withOrder(layout, scene, ids, scene.arrangement.pageStarts);
  const folders = removeFromFolders(base.folders, tileId);
  const target = folders[folderId] ?? folder;
  folders[folderId] = { ...target, items: [...target.items, tileId] };
  const order = base.order.filter((id) => id !== tileId);
  if (!order.includes(folderId)) order.push(folderId);
  return { ...base, folders, order, pageStarts: base.pageStarts.filter((id) => order.includes(id)) };
}

/** A new folder that holds one tile, in that tile's place (the non-drag "add to a new folder"). */
export function folderOfOne(layout: HomeLayout, scene: Scene, tileId: string, name: string, folderId = newFolderId()): HomeLayout {
  const ids = idsOf(scene);
  if (!ids.includes(tileId) || !isTileId(tileId)) return layout;
  const next = ids.map((id) => (id === tileId ? folderId : id));
  const starts = new Set([...scene.arrangement.pageStarts].map((id) => (id === tileId ? folderId : id)));
  const base = withOrder(layout, scene, next, starts);
  return { ...base, folders: { ...base.folders, [folderId]: { name: cleanName(name), items: [tileId] } } };
}

/** Takes a tile out of its folder; it goes right after the folder. A folder left empty disappears. */
export function removeFromFolder(layout: HomeLayout, scene: Scene, tileId: string): HomeLayout {
  const entry = Object.entries(layout.folders).find(([, folder]) => folder.items.includes(tileId));
  if (!entry) return layout;
  const [folderId] = entry;
  const base = withOrder(layout, scene, idsOf(scene), scene.arrangement.pageStarts);
  const folders = removeFromFolders(base.folders, tileId);
  const order = [...base.order];
  const at = order.indexOf(folderId);
  if (Object.hasOwn(folders, folderId)) order.splice(at === -1 ? order.length : at + 1, 0, tileId);
  else if (at === -1) order.push(tileId);
  else order.splice(at, 1, tileId);
  const pageStarts = base.pageStarts.map((id) => (id === folderId && !Object.hasOwn(folders, folderId) ? tileId : id));
  return { ...base, folders, order, pageStarts };
}

/** A folder's new name; an empty one changes nothing. */
export function renameFolder(layout: HomeLayout, folderId: string, name: string): HomeLayout {
  const folder = layout.folders[folderId];
  const clean = cleanName(name);
  if (!folder || clean === '' || clean === folder.name) return layout;
  return { ...layout, folders: { ...layout.folders, [folderId]: { ...folder, name: clean } } };
}

/** Moves a tile inside its folder. */
export function moveInFolder(layout: HomeLayout, folderId: string, tileId: string, index: number): HomeLayout {
  const folder = layout.folders[folderId];
  if (!folder) return layout;
  const from = folder.items.indexOf(tileId);
  const target = Math.max(0, Math.min(folder.items.length - 1, index));
  if (from === -1 || from === target) return layout;
  const items = [...folder.items];
  items.splice(from, 1);
  items.splice(target, 0, tileId);
  return { ...layout, folders: { ...layout.folders, [folderId]: { ...folder, items } } };
}

/** Undoes a folder: its tiles take its place, in its order. */
export function dissolveFolder(layout: HomeLayout, scene: Scene, folderId: string): HomeLayout {
  const folder = layout.folders[folderId];
  if (!folder) return layout;
  const base = withOrder(layout, scene, idsOf(scene), scene.arrangement.pageStarts);
  const order = base.order.flatMap((id) => (id === folderId ? folder.items : [id]));
  if (!base.order.includes(folderId)) order.push(...folder.items);
  const folders = { ...base.folders };
  delete folders[folderId];
  const pageStarts = base.pageStarts.map((id) => (id === folderId ? folder.items[0]! : id));
  return { ...base, order, folders, pageStarts };
}

/** Every custom tile name goes; folders keep theirs. */
export const resetNames = (layout: HomeLayout): HomeLayout => ({ ...layout, names: {} });

/** Order, folders, hidden tiles and page starts go back to the default; names and widgets stay. */
export const resetArrangement = (layout: HomeLayout): HomeLayout => ({ ...layout, order: [], pageStarts: [], folders: {}, hidden: [] });

/** Forgets ids that no longer exist anywhere. Only call with the whole catalogue known. */
export function prune(layout: HomeLayout, known: ReadonlySet<string>): HomeLayout {
  const folders: Record<string, Folder> = {};
  for (const [id, folder] of Object.entries(layout.folders)) {
    const items = folder.items.filter((item) => known.has(item));
    if (items.length > 0) folders[id] = items.length === folder.items.length ? folder : { ...folder, items };
  }
  const order = layout.order.filter((id) => (isFolderId(id) ? Object.hasOwn(folders, id) : known.has(id)));
  const names = Object.fromEntries(Object.entries(layout.names).filter(([id]) => known.has(id)));
  return { ...layout, order, folders, names, hidden: layout.hidden.filter((id) => known.has(id)), pageStarts: layout.pageStarts.filter((id) => order.includes(id)) };
}

// ---- widgets -------------------------------------------------------------------------------------

export function addWidget(widgets: readonly WidgetEntry[], type: WidgetType, size: WidgetSize, pluginId?: string, id = newWidgetId()): WidgetEntry[] {
  if (widgets.length >= MAX_WIDGETS) return [...widgets];
  return [...widgets, { id, type, size, ...(type === 'plugin-links' && pluginId ? { pluginId } : {}) }];
}

export const removeWidget = (widgets: readonly WidgetEntry[], id: string): WidgetEntry[] => widgets.filter((widget) => widget.id !== id);

export const resizeWidget = (widgets: readonly WidgetEntry[], id: string, size: WidgetSize): WidgetEntry[] => widgets.map((widget) => (widget.id === id ? { ...widget, size } : widget));

export function moveWidget(widgets: readonly WidgetEntry[], id: string, index: number): WidgetEntry[] {
  const from = widgets.findIndex((widget) => widget.id === id);
  const target = Math.max(0, Math.min(widgets.length - 1, index));
  if (from === -1 || from === target) return [...widgets];
  const next = [...widgets];
  const [moved] = next.splice(from, 1);
  next.splice(target, 0, moved!);
  return next;
}

/** One size bigger or smaller, within small…large. */
export function stepSize(size: WidgetSize, step: number): WidgetSize {
  const index = Math.max(0, Math.min(WIDGET_SIZES.length - 1, WIDGET_SIZES.indexOf(size) + step));
  return WIDGET_SIZES[index]!;
}

// ---- two devices at once ----------------------------------------------------------------------------

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Two devices changed the layout at about the same time: keeps both changes
 * where they touch different things. The arrangement (order, folders, hidden
 * tiles, page starts) and the widgets each change as a whole — when both
 * devices changed the same one, this device's change wins; names merge one by
 * one.
 */
export function mergeLayouts(base: HomeLayout, mine: HomeLayout, theirs: HomeLayout): HomeLayout {
  const arrangementOf = (layout: HomeLayout) => ({ order: layout.order, pageStarts: layout.pageStarts, folders: layout.folders, hidden: layout.hidden });
  // Where everything is: the order, the pages, what each folder holds, what is hidden (folder names apart).
  const placesOf = (layout: HomeLayout) => ({ ...arrangementOf(layout), folders: Object.entries(layout.folders).map(([id, folder]) => [id, folder.items]) });
  const placed = same(placesOf(mine), placesOf(base)) ? arrangementOf(theirs) : arrangementOf(mine);
  // A folder's name is merged on its own, like a tile's: a rename on one device survives a rearrangement on the other.
  const folders: Record<string, Folder> = {};
  for (const [id, folder] of Object.entries(placed.folders)) {
    const mineRenamed = base.folders[id]?.name !== mine.folders[id]?.name;
    const name = mineRenamed ? mine.folders[id]?.name : theirs.folders[id]?.name;
    folders[id] = name !== undefined && name !== folder.name ? { ...folder, name } : folder;
  }
  const arrangement = { ...placed, folders };
  const widgets = same(mine.widgets, base.widgets) ? theirs.widgets : mine.widgets;
  const names: Record<string, string> = {};
  for (const key of new Set([...Object.keys(base.names), ...Object.keys(mine.names), ...Object.keys(theirs.names)])) {
    const mineChanged = base.names[key] !== mine.names[key];
    const value = mineChanged ? mine.names[key] : theirs.names[key];
    if (value !== undefined) names[key] = value;
  }
  return { version: LAYOUT_VERSION, ...arrangement, names, widgets };
}

/** What the home settings page counts. */
export function layoutCounts(layout: HomeLayout, arrangement: Arrangement): { folders: number; inFolders: number; hidden: number; renamed: number } {
  const folders = arrangement.entries.filter((entry): entry is Extract<Entry, { kind: 'folder' }> => entry.kind === 'folder');
  return {
    folders: folders.length,
    inFolders: folders.reduce((sum, folder) => sum + folder.items.length, 0),
    hidden: arrangement.hidden.length,
    renamed: Object.keys(layout.names).length,
  };
}
