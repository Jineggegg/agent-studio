import { describe, expect, it } from 'vitest';
import { EMPTY_LAYOUT, type HomeLayout, parseLayout } from './layout';
import { afterOwnWrite, onLayoutHeard } from './useHomeLayout';

/**
 * Two devices change the arrangement at about the same time. This device
 * remembers what it wrote until it hears it back from the server; another
 * device's value is merged with it only while it is still on its way.
 */
const A = 'system:a';
const B = 'system:b';
const C = 'system:c';
const FOLDER = 'folder:abcd1234';
/** As the server sends it back, read the way the launcher reads it. */
const stored = (overrides: Partial<HomeLayout>): HomeLayout => parseLayout({ ...EMPTY_LAYOUT, ...overrides }).layout;
const withFolder = (base: HomeLayout, name: string): HomeLayout => stored({ ...base, folders: { [FOLDER]: { name, items: [A, B] } } });

describe('merging the arrangement with another device', () => {
  const start = stored({ order: [FOLDER, C], folders: { [FOLDER]: { name: 'Tools', items: [A, B] } } });

  it('takes this device’s saved change as the common ground, so a later rename elsewhere is kept', () => {
    // This device renamed the folder, then moved C first, in quick succession.
    const renamed = withFolder(start, 'Daily');
    const moved = stored({ ...renamed, order: [C, FOLDER] });
    let state = afterOwnWrite(null, start, renamed, 1_000);
    state = afterOwnWrite(state, renamed, moved, 2_000);
    expect(state.base).toEqual(start);
    // Both come back from the server: the common ground is now what this device wrote last.
    state = onLayoutHeard(state, renamed, 2_100).state!;
    state = onLayoutHeard(state, moved, 2_200).state!;
    expect(state.base).toEqual(moved);
    expect(state.unheard).toEqual([]);
    // Another device, which saw "Daily", calls it "Elsewhere": nothing of this device's is on its way, so nothing is written over it.
    expect(onLayoutHeard(state, withFolder(moved, 'Elsewhere'), 3_000).write).toBeNull();
  });

  it('merges another device’s change with this device’s unsaved one, each keeping what the other did not touch', () => {
    const moved = stored({ ...start, order: [C, FOLDER] });
    const state = afterOwnWrite(null, start, moved, 1_000);
    const theirs = stored({ ...withFolder(start, 'Daily'), names: { [A]: 'Alpha' } });
    const result = onLayoutHeard(state, theirs, 1_500);
    expect(result.write).toMatchObject({ order: [C, FOLDER], folders: { [FOLDER]: { name: 'Daily' } }, names: { [A]: 'Alpha' } });
    // The merge is this device's newest write; hearing it back settles both devices.
    const settled = onLayoutHeard(result.state, result.write!, 1_800);
    expect(settled.write).toBeNull();
    expect(settled.state).toMatchObject({ base: result.write, unheard: [] });
  });

  it('leaves another device’s value alone long after this device’s last change', () => {
    const state = afterOwnWrite(null, start, stored({ ...start, order: [C, FOLDER] }), 1_000);
    expect(onLayoutHeard(state, start, 60_000).write).toBeNull();
    expect(onLayoutHeard(null, start, 1_000)).toEqual({ state: null, write: null });
  });

  it('starts from the value it changed when its last change was a while ago', () => {
    const first = afterOwnWrite(null, start, withFolder(start, 'One'), 1_000);
    const later = afterOwnWrite(first, start, withFolder(start, 'Two'), 20_000);
    expect(later.base).toEqual(start);
    expect(later.unheard).toEqual([withFolder(start, 'Two')]);
  });
});
