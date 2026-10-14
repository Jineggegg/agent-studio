import { PREFERENCES_CHANGED, userTopic } from '@agent-studio/protocol';
import { useCallback, useMemo, useRef } from 'react';
import { getPreference, setPreference, usePreference } from '@/data/preferences';
import { useRealtimeTopic } from '@/data/realtime';
import { useUser } from '@/data/session';
import type { LayoutClass } from '@/platform/layout';
import {
  type Arrangement,
  HOME_LAYOUT_KEY,
  type HomeLayout,
  type LayoutStatus,
  type Scene,
  type WidgetEntry,
  arrange,
  mergeLayouts,
  parseLayout,
  prune,
} from './layout';

/** How long after this device's own change a different value from elsewhere is taken as a concurrent change. */
const CONCURRENT_MS = 4_000;

/** What this device knows about its own recent changes, for merging with another device's. */
export interface Recent {
  at: number;
  /** The common ground: the newest layout this device knows the server holds, from before its own unsaved changes. */
  base: HomeLayout;
  /** What this device wrote last. */
  mine: HomeLayout;
  /** What this device wrote and has not heard back yet. Hearing one means the server holds it: it becomes the common ground. */
  unheard: HomeLayout[];
}
let recent: Recent | null = null;
const UNHEARD_MAX = 8;

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** This device wrote `next` over `current`: changes in quick succession share the ground they started from. */
export function afterOwnWrite(state: Recent | null, current: HomeLayout, next: HomeLayout, now: number): Recent {
  const going = state && now - state.at < CONCURRENT_MS ? state : null;
  return { at: now, base: going ? going.base : current, mine: next, unheard: [...(going?.unheard ?? []), parseLayout(next).layout].slice(-UNHEARD_MAX) };
}

/**
 * A layout arrived from the server. Either it is this device's own change
 * coming back (which makes it the common ground), or another device's: merged
 * with this device's change when that is still on its way, so neither is lost.
 * Returns the new state and what to write, if anything.
 */
export function onLayoutHeard(state: Recent | null, theirs: HomeLayout, now: number): { state: Recent | null; write: HomeLayout | null } {
  if (!state) return { state, write: null };
  const heard = state.unheard.findIndex((value) => sameJson(value, theirs));
  if (heard >= 0) return { state: { ...state, base: theirs, unheard: state.unheard.slice(heard + 1) }, write: null };
  // Nothing of this device's is on its way, or not lately: the other device's value simply applies.
  if (state.unheard.length === 0 || now - state.at > CONCURRENT_MS) return { state, write: null };
  const merged = mergeLayouts(state.base, state.mine, theirs);
  if (sameJson(merged, state.mine)) return { state, write: null };
  // What they wrote is the new common ground: a later value from them is compared against it, so the two devices settle.
  return { state: { at: now, base: theirs, mine: merged, unheard: [merged] }, write: merged };
}

/** The widgets a device shows before the person has chosen any: one on a phone, three across on larger screens. */
export function defaultWidgets(layout: LayoutClass): WidgetEntry[] {
  if (layout === 'phone') return [{ id: 'w:default01', type: 'usage', size: 'medium' }];
  return [
    { id: 'w:default01', type: 'usage', size: 'medium' },
    { id: 'w:default02', type: 'inbox', size: 'small' },
    { id: 'w:default03', type: 'running', size: 'small' },
  ];
}

export interface HomeLayoutState {
  layout: HomeLayout;
  status: LayoutStatus;
  arrangement: Arrangement;
  scene: Scene;
  /** Changes the arrangement, starting from the newest value; prunes what no longer exists once everything is known. */
  write: (change: (layout: HomeLayout, scene: Scene) => HomeLayout) => void;
}

/**
 * The launcher's arrangement from the `home.layout` preference: parsed
 * defensively, arranged over the tiles this device knows, written back with
 * what this device does not know left in place — and merged when another
 * device changed it at the same moment.
 */
export function useHomeLayout(known: readonly string[], complete: boolean): HomeLayoutState {
  const raw = usePreference(HOME_LAYOUT_KEY, (value) => value);
  const { layout, status } = useMemo(() => parseLayout(raw), [raw]);
  const arrangement = useMemo(() => arrange(layout, known), [layout, known]);
  const scene = useMemo<Scene>(() => ({ arrangement, known: new Set(known) }), [arrangement, known]);
  const knownRef = useRef({ known, complete });
  knownRef.current = { known, complete };

  const write = useCallback((change: (layout: HomeLayout, scene: Scene) => HomeLayout) => {
    const { known: ids, complete: whole } = knownRef.current;
    const current = parseLayout(getPreference(HOME_LAYOUT_KEY)).layout;
    const currentScene: Scene = { arrangement: arrange(current, ids), known: new Set(ids) };
    let next = change(current, currentScene);
    if (next === current) return;
    if (whole) next = prune(next, new Set(ids));
    recent = afterOwnWrite(recent, current, next, Date.now());
    setPreference(HOME_LAYOUT_KEY, next);
  }, []);

  return { layout, status, arrangement, scene, write };
}

/**
 * Another device saved the layout while this one had just changed it: this
 * device's unsaved value would win outright, so the two are merged instead —
 * each keeps what the other did not touch. Mount once (the launcher does).
 */
export function useLayoutMerging(): void {
  const user = useUser();
  useRealtimeTopic(user ? userTopic(user.id) : null, (event) => {
    if (event.type !== PREFERENCES_CHANGED || !recent) return;
    const values = (event.data as { values?: Record<string, unknown> } | null)?.values;
    if (!values || !Object.hasOwn(values, HOME_LAYOUT_KEY)) return;
    const result = onLayoutHeard(recent, parseLayout(values[HOME_LAYOUT_KEY]).layout, Date.now());
    recent = result.state;
    if (result.write) setPreference(HOME_LAYOUT_KEY, result.write);
  });
}

/** For tests. */
export function __resetLayoutMergingForTests(): void {
  recent = null;
}
