import { describe, expect, it } from 'vitest';
import {
  EMPTY_LAYOUT,
  type HomeLayout,
  NAME_MAX,
  type Scene,
  addToFolder,
  addWidget,
  applyOrder,
  arrange,
  cleanName,
  dissolveFolder,
  folderOfOne,
  hideTile,
  layoutCounts,
  makeFolder,
  mergeLayouts,
  mergeUnknown,
  moveBy,
  moveEntry,
  moveInFolder,
  moveToNewPage,
  moveWidget,
  paginate,
  parseLayout,
  prune,
  removeFromFolder,
  removeWidget,
  renameFolder,
  renameTile,
  resetArrangement,
  resetNames,
  resizeWidget,
  restoreTile,
  stepSize,
  tileIds,
} from './layout';

const A = 'system:a';
const B = 'system:b';
const C = 'system:c';
const D = 'system:d';
const P1 = tileIds.project('01jabcdefghjkmnpqrstvwxyz1');
const P2 = tileIds.project('01jabcdefghjkmnpqrstvwxyz2');
const GONE = tileIds.project('01jabcdefghjkmnpqrstvwxyz9');
const FOLDER = 'folder:abcd1234';

const layout = (overrides: Partial<HomeLayout> = {}): HomeLayout => ({ ...EMPTY_LAYOUT, ...overrides });
function scene(value: HomeLayout, known: string[]): Scene {
  return { arrangement: arrange(value, known), known: new Set(known) };
}
const shown = (value: HomeLayout, known: string[]) => arrange(value, known).entries.map((entry) => (entry.kind === 'folder' ? `${entry.id}[${entry.items.join(',')}]` : entry.id));

describe('reading what is stored', () => {
  it('treats nothing stored as the default, and a value it cannot read as unreadable — without inventing one', () => {
    expect(parseLayout(undefined)).toEqual({ layout: EMPTY_LAYOUT, status: 'empty' });
    expect(parseLayout(null).status).toBe('empty');
    for (const value of ['layout', 42, [], { version: 2, order: [A] }, { order: [A] }]) expect(parseLayout(value)).toEqual({ layout: EMPTY_LAYOUT, status: 'unreadable' });
  });

  it('keeps the sound parts of a damaged value: each tile once, folders with valid ids, names on one short line', () => {
    const { layout: read, status } = parseLayout({
      version: 1,
      order: [A, FOLDER, A, 42, 'folder:bad id', B, 'project:not-an-id', C],
      folders: {
        [FOLDER]: { name: 'Tools\nand more', items: [B, C, B] },
        'folder:zzzz9999': { name: 'Second', items: [C, D] },
        'folder:!!': { name: 'Broken', items: [D] },
        'folder:empty000': { name: 'Empty', items: [] },
      },
      hidden: [D, 'nonsense'],
      pageStarts: [FOLDER, 'system:nowhere'],
      names: { [A]: 'x'.repeat(30), 'not a tile': 'Name', [B]: '   ' },
      widgets: [{ id: 'w:abcd1234', type: 'usage', size: 'medium' }, { id: 'w:abcd1234', type: 'inbox', size: 'small' }, { id: 'w:other123', type: 'weather', size: 'small' }],
    });
    expect(status).toBe('repaired');
    // B and C are in the first folder (first wins); D is hidden, so it is in no folder; the second folder is left empty and goes.
    expect(read.folders).toEqual({ [FOLDER]: { name: 'Tools and more', items: [B, C] } });
    expect(read.order).toEqual([A, FOLDER]);
    expect(read.hidden).toEqual([D]);
    expect(read.pageStarts).toEqual([FOLDER]);
    expect(read.names).toEqual({ [A]: 'x'.repeat(NAME_MAX) });
    expect(read.widgets).toEqual([{ id: 'w:abcd1234', type: 'usage', size: 'medium' }]);
    // Shown: every tile exactly once.
    expect(shown(read, [A, B, C, D])).toEqual([A, `${FOLDER}[${B},${C}]`]);
  });

  it('reads a sound value as it is', () => {
    const value = { version: 1, order: [B, A], pageStarts: [A], folders: {}, hidden: [C], names: { [B]: 'Bee' }, widgets: [] };
    expect(parseLayout(value)).toEqual({ layout: value, status: 'ok' });
  });

  it('cuts names by characters, on one line', () => {
    expect(cleanName('  a\tb\u0000c  ')).toBe('a b c');
    expect(Array.from(cleanName('😀'.repeat(30)))).toHaveLength(NAME_MAX);
  });
});

describe('what the launcher shows', () => {
  it('keeps unknown ids out of sight and puts new tiles at the end, in their natural order', () => {
    const stored = layout({ order: [GONE, B, A] });
    expect(shown(stored, [A, B, C, P1])).toEqual([B, A, C, P1]);
  });

  it('leaves out a folder whose tiles are all unknown here, and the hidden tiles', () => {
    const stored = layout({ order: [FOLDER, A], folders: { [FOLDER]: { name: 'Projects', items: [GONE] } }, hidden: [B] });
    const arrangement = arrange(stored, [A, B, C]);
    expect(arrangement.entries.map((entry) => entry.id)).toEqual([A, C]);
    expect(arrangement.hidden).toEqual([B]);
  });

  it('splits into pages by what fits, the first holding less beside the widgets, and starts a page where asked', () => {
    const entries = [A, B, C, D, P1, P2].map((id) => ({ id }));
    expect(paginate(entries, 2, 4, new Set()).map((page) => page.map((entry) => entry.id))).toEqual([[A, B], [C, D, P1, P2]]);
    expect(paginate(entries, 4, 4, new Set([C])).map((page) => page.map((entry) => entry.id))).toEqual([[A, B], [C, D, P1, P2]]);
    expect(paginate(entries, 0, 3, new Set()).map((page) => page.length)).toEqual([0, 3, 3]);
    expect(paginate([], 4, 4, new Set())).toEqual([[]]);
  });
});

describe('rearranging', () => {
  const known = [A, B, C, D];

  it('moves a tile, and keeps ids this device does not know where they were', () => {
    const stored = layout({ order: [A, GONE, B, C, D] });
    const next = moveEntry(stored, scene(stored, known), C, 0);
    expect(next.order).toEqual([C, A, GONE, B, D]);
    expect(stored.order).toEqual([A, GONE, B, C, D]);
  });

  it('moves one place earlier and later, and from the last place of a page to the first of the next', () => {
    const stored = layout();
    const s = scene(stored, known);
    expect(moveBy(stored, s, B, -1).order).toEqual([B, A, C, D]);
    expect(moveBy(stored, s, B, 1).order).toEqual([A, C, B, D]);
    // Pages of two: B is the last of page 1. One place later it is the first of page 2.
    const after = moveBy(stored, s, B, 1);
    expect(paginate(arrange(after, known).entries, 2, 2, new Set()).map((page) => page.map((entry) => entry.id))).toEqual([[A, C], [B, D]]);
    // An explicit page start stays where it was: the moved tile begins the page.
    const paged = layout({ order: [A, B, C, D], pageStarts: [C] });
    const crossed = moveBy(paged, scene(paged, known), B, 1);
    expect(crossed.order).toEqual([A, C, B, D]);
    expect(crossed.pageStarts).toEqual([B]);
  });

  it('puts a dragged order in place, and starts a new page with a tile dropped on the empty page', () => {
    const stored = layout();
    expect(applyOrder(stored, scene(stored, known), [D, C, B, A]).order).toEqual([D, C, B, A]);
    expect(applyOrder(stored, scene(stored, known), [D, C])).toBe(stored);
    const paged = moveToNewPage(stored, scene(stored, known), B);
    expect(paged.order).toEqual([A, C, D, B]);
    expect(paged.pageStarts).toEqual([B]);
  });

  it('hides a tile into the library and brings it back at the end', () => {
    const stored = layout();
    const hidden = hideTile(stored, scene(stored, known), B);
    expect(shown(hidden, known)).toEqual([A, C, D]);
    expect(hidden.hidden).toEqual([B]);
    const back = restoreTile(hidden, scene(hidden, known), B);
    expect(shown(back, known)).toEqual([A, C, D, B]);
    expect(back.hidden).toEqual([]);
  });

  it('renames in place: 24 characters are kept; empty or the original name goes back to the default', () => {
    const named = renameTile(layout(), A, 'A very long name for the tile', 'Workbench');
    expect(named.names[A]).toBe('A very long name for the');
    expect(renameTile(named, A, '   ', 'Workbench').names).toEqual({});
    expect(renameTile(named, A, 'Workbench', 'Workbench').names).toEqual({});
  });
});

describe('folders', () => {
  const known = [A, B, C, D];

  it('dropping a tile on another makes a folder with both in the target’s place', () => {
    const stored = layout();
    const next = makeFolder(stored, scene(stored, known), A, C, 'Tools', FOLDER);
    expect(shown(next, known)).toEqual([B, `${FOLDER}[${C},${A}]`, D]);
    expect(next.folders[FOLDER]?.name).toBe('Tools');
  });

  it('adds a tile to a folder, and a new folder can hold a single tile', () => {
    const stored = makeFolder(layout(), scene(layout(), known), A, C, 'Tools', FOLDER);
    const added = addToFolder(stored, scene(stored, known), D, FOLDER);
    expect(shown(added, known)).toEqual([B, `${FOLDER}[${C},${A},${D}]`]);
    const single = folderOfOne(layout(), scene(layout(), known), B, 'Mine', 'folder:single01');
    expect(shown(single, known)).toEqual([A, 'folder:single01[system:b]', C, D]);
  });

  it('a tile taken out goes right after its folder; the folder goes with its last tile', () => {
    const stored = makeFolder(layout(), scene(layout(), known), A, B, 'Tools', FOLDER);
    expect(shown(stored, known)).toEqual([`${FOLDER}[${B},${A}]`, C, D]);
    const one = removeFromFolder(stored, scene(stored, known), A);
    expect(shown(one, known)).toEqual([`${FOLDER}[${B}]`, A, C, D]);
    const none = removeFromFolder(one, scene(one, known), B);
    expect(shown(none, known)).toEqual([B, A, C, D]);
    expect(none.folders).toEqual({});
  });

  it('reorders inside, renames (never to nothing) and dissolves in place', () => {
    const folded = makeFolder(layout(), scene(layout(), known), A, B, 'Tools', FOLDER);
    const stored = addToFolder(folded, scene(folded, known), D, FOLDER);
    const reordered = moveInFolder(stored, FOLDER, D, 0);
    expect(reordered.folders[FOLDER]?.items).toEqual([D, B, A]);
    expect(renameFolder(reordered, FOLDER, '  ').folders[FOLDER]?.name).toBe('Tools');
    expect(renameFolder(reordered, FOLDER, 'Daily').folders[FOLDER]?.name).toBe('Daily');
    const dissolved = dissolveFolder(reordered, scene(reordered, known), FOLDER);
    expect(shown(dissolved, known)).toEqual([D, B, A, C]);
    expect(dissolved.folders).toEqual({});
  });

  it('a deleted project leaves its folder; an emptied folder disappears', () => {
    const stored = layout({ order: [FOLDER, A], folders: { [FOLDER]: { name: 'Projects', items: [P1, P2] } } });
    expect(shown(stored, [A, P1])).toEqual([`${FOLDER}[${P1}]`, A]);
    expect(shown(stored, [A])).toEqual([A]);
    const pruned = prune(stored, new Set([A]));
    expect(pruned.folders).toEqual({});
    expect(pruned.order).toEqual([A]);
  });

  it('keeps a folder this device cannot show yet (its projects are still loading) when something else changes', () => {
    const stored = layout({ order: [FOLDER, A, B], folders: { [FOLDER]: { name: 'Projects', items: [P1] } } });
    const next = moveBy(stored, scene(stored, [A, B]), B, -1);
    expect(next.order).toEqual([FOLDER, B, A]);
    expect(next.folders[FOLDER]).toEqual({ name: 'Projects', items: [P1] });
  });
});

describe('resets', () => {
  const stored = layout({ order: [B, FOLDER], folders: { [FOLDER]: { name: 'Mine', items: [A] } }, hidden: [C], pageStarts: [FOLDER], names: { [B]: 'Bee' }, widgets: [{ id: 'w:abcd1234', type: 'usage', size: 'small' }] });

  it('restoring names clears every custom tile name and nothing else', () => {
    const next = resetNames(stored);
    expect(next.names).toEqual({});
    expect(next.folders[FOLDER]?.name).toBe('Mine');
    expect(next.order).toEqual(stored.order);
  });

  it('resetting the arrangement keeps names and widgets', () => {
    const next = resetArrangement(stored);
    expect(next).toMatchObject({ order: [], folders: {}, hidden: [], pageStarts: [], names: { [B]: 'Bee' }, widgets: stored.widgets });
    expect(shown(next, [A, B, C])).toEqual([A, B, C]);
  });

  it('counts folders, hidden and renamed tiles for the settings page', () => {
    expect(layoutCounts(stored, arrange(stored, [A, B, C]))).toEqual({ folders: 1, inFolders: 1, hidden: 1, renamed: 1 });
  });
});

describe('widgets', () => {
  it('are added at the end, resized, moved and removed', () => {
    let widgets = addWidget([], 'usage', 'medium', undefined, 'w:first001');
    widgets = addWidget(widgets, 'inbox', 'small', undefined, 'w:second01');
    widgets = addWidget(widgets, 'plugin-links', 'large', 'notes-counter', 'w:third001');
    expect(widgets.map((widget) => widget.type)).toEqual(['usage', 'inbox', 'plugin-links']);
    expect(widgets[2]).toEqual({ id: 'w:third001', type: 'plugin-links', size: 'large', pluginId: 'notes-counter' });
    widgets = resizeWidget(widgets, 'w:first001', 'large');
    widgets = moveWidget(widgets, 'w:first001', 2);
    expect(widgets.map((widget) => `${widget.type}:${widget.size}`)).toEqual(['inbox:small', 'plugin-links:large', 'usage:large']);
    expect(removeWidget(widgets, 'w:second01').map((widget) => widget.id)).toEqual(['w:third001', 'w:first001']);
  });

  it('step between sizes and stop at the ends', () => {
    expect(stepSize('small', 1)).toBe('medium');
    expect(stepSize('medium', 1)).toBe('large');
    expect(stepSize('large', 1)).toBe('large');
    expect(stepSize('small', -1)).toBe('small');
  });

  it('are at most twelve', () => {
    let widgets = addWidget([], 'usage', 'small');
    for (let index = 0; index < 20; index += 1) widgets = addWidget(widgets, 'inbox', 'small');
    expect(widgets).toHaveLength(12);
  });
});

describe('two devices at once', () => {
  const base = layout({ order: [A, B, C], names: { [A]: 'Alpha' }, widgets: [] });

  it('keeps both changes when they touch different things', () => {
    const mine = { ...base, order: [C, A, B] };
    const theirs = { ...base, names: { [A]: 'Alpha', [B]: 'Beta' }, widgets: [{ id: 'w:their001', type: 'inbox' as const, size: 'small' as const }] };
    expect(mergeLayouts(base, mine, theirs)).toEqual({ ...base, order: [C, A, B], names: { [A]: 'Alpha', [B]: 'Beta' }, widgets: theirs.widgets });
  });

  it('lets this device’s change win where both changed the same thing, name by name', () => {
    const mine = { ...base, order: [B, A, C], names: { [A]: 'Mine' } };
    const theirs = { ...base, order: [C, B, A], names: { [C]: 'Theirs' } };
    const merged = mergeLayouts(base, mine, theirs);
    expect(merged.order).toEqual([B, A, C]);
    expect(merged.names).toEqual({ [A]: 'Mine', [C]: 'Theirs' });
  });

  it('keeps a folder renamed on one device while the other rearranged', () => {
    const start = layout({ order: [FOLDER, C], folders: { [FOLDER]: { name: 'Tools', items: [A, B] } } });
    const rearranged = { ...start, order: [C, FOLDER], pageStarts: [FOLDER] };
    const renamed = { ...start, folders: { [FOLDER]: { name: 'Daily', items: [A, B] } } };
    // Their rename reaches this device's arrangement, and this device's rename reaches theirs.
    expect(mergeLayouts(start, rearranged, renamed)).toMatchObject({ order: [C, FOLDER], pageStarts: [FOLDER], folders: { [FOLDER]: { name: 'Daily', items: [A, B] } } });
    expect(mergeLayouts(start, renamed, rearranged)).toMatchObject({ order: [C, FOLDER], pageStarts: [FOLDER], folders: { [FOLDER]: { name: 'Daily', items: [A, B] } } });
    // Both renamed it: this device's name wins, as with tiles.
    const alsoRenamed = { ...rearranged, folders: { [FOLDER]: { name: 'Mine', items: [A, B] } } };
    expect(mergeLayouts(start, alsoRenamed, renamed).folders[FOLDER]?.name).toBe('Mine');
  });

  it('drops a name either device removed', () => {
    const mine = { ...base, names: {} };
    expect(mergeLayouts(base, mine, base).names).toEqual({});
    expect(mergeLayouts(base, base, mine).names).toEqual({});
  });

  it('keeps unknown ids after the tile they followed', () => {
    expect(mergeUnknown([A, GONE, B, C], [C, A, B], (id) => id !== GONE)).toEqual([C, A, GONE, B]);
    expect(mergeUnknown([GONE, A], [A], (id) => id !== GONE)).toEqual([GONE, A]);
  });
});
