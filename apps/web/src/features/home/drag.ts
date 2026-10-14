import { type PointerEvent as ReactPointerEvent, type RefObject, useCallback, useEffect, useRef, useState } from 'react';

/**
 * Lifting and moving launcher tiles (or widgets) with a finger, a pen or a
 * mouse. Rules, from the requirements:
 *
 *  - outside edit mode a still press of ~450 ms enters edit mode and lifts
 *    what was pressed; the click that ends the press opens nothing;
 *  - in edit mode a mouse drags after a few pixels, a finger after a short
 *    hold (~160 ms) — so that a quick swipe still turns the page;
 *  - while a finger drags, the carried tile's centre decides the target and
 *    the browser never scrolls;
 *  - resting over the middle of another tile for a moment arms a merge (a
 *    folder); resting elsewhere makes room there; tiles merely passed over
 *    never move;
 *  - holding near the left or right edge turns the page;
 *  - Escape puts everything back.
 */

export type DropResult =
  | { kind: 'order'; dragged: string; ids: string[] }
  | { kind: 'merge'; dragged: string; target: string }
  | { kind: 'new-page'; dragged: string }
  | { kind: 'none'; dragged: string };

export interface GridDragOptions {
  /** Where the slots are: elements with `data-slot-id` inside it. */
  container: RefObject<HTMLElement | null>;
  editing: boolean;
  /** The ids in their current order. */
  ids: readonly string[];
  /** A still press outside edit mode: enter it. */
  onEnterEdit: () => void;
  onDrop: (result: DropResult) => void;
  /** Whether `dragged` may be dropped onto `target` to make or fill a folder. Default: never. */
  canMerge?: (dragged: string, target: string) => boolean;
  /** Turning pages while dragging near an edge; `extra` is the empty page offered after the last. */
  pages?: { current: number; count: number; goTo: (page: number) => void };
  /** Whether `id` can be lifted at all (the "new project" tile cannot). */
  canLift?: (id: string) => boolean;
}

/** The carried copy: what it shows and how big it is. Where it is, is set on `ghostRef`'s element directly, every frame. */
export interface Ghost {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GridDrag {
  /** The id being carried, or null. */
  dragged: string | null;
  /** The order to show while carrying. */
  preview: readonly string[] | null;
  /** The tile a release would make a folder with. */
  mergeTarget: string | null;
  /** The carried copy, while there is one. */
  ghost: Ghost | null;
  /** Put on the carried copy's element: it is moved without re-rendering anything. */
  ghostRef: RefObject<HTMLDivElement | null>;
  /** True while the pointer rests on the empty page offered after the last. */
  overNewPage: boolean;
  /** Props for each slot. */
  bind: (id: string) => { onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void };
  cancel: () => void;
}

const LONG_PRESS_MS = 450;
const TOUCH_LIFT_MS = 160;
const SLOP = 8;
const MOUSE_SLOP = 4;
const MERGE_DWELL_MS = 350;
const MOVE_DWELL_MOUSE_MS = 200;
const MOVE_DWELL_TOUCH_MS = 330;
const EDGE = 36;
const EDGE_DWELL_MS = 600;
const EDGE_REPEAT_MS = 850;

interface Press {
  id: string;
  pointerId: number;
  pointerType: string;
  startX: number;
  startY: number;
  /** Where in the slot the pointer took hold, so the copy does not jump. */
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
  timer: number;
  phase: 'pending' | 'lifted' | 'dragging';
  x: number;
  y: number;
}

interface Dwell {
  key: string;
  since: number;
}

export function useGridDrag(options: GridDragOptions): GridDrag {
  const [dragged, setDragged] = useState<string | null>(null);
  const [preview, setPreview] = useState<readonly string[] | null>(null);
  const [mergeTarget, setMergeTarget] = useState<string | null>(null);
  const [ghost, setGhost] = useState<Ghost | null>(null);
  const [overNewPage, setOverNewPage] = useState(false);
  const press = useRef<Press | null>(null);
  const opts = useRef(options);
  opts.current = options;
  const previewRef = useRef<readonly string[] | null>(null);
  const mergeRef = useRef<string | null>(null);
  const newPageRef = useRef(false);
  const dwell = useRef<Dwell | null>(null);
  const edge = useRef<{ side: -1 | 1; since: number; last: number } | null>(null);
  const frame = useRef(0);
  const swallowClickUntil = useRef(0);
  const ghostRef = useRef<HTMLDivElement | null>(null);

  const reset = useCallback(() => {
    const current = press.current;
    if (current) window.clearTimeout(current.timer);
    press.current = null;
    previewRef.current = null;
    mergeRef.current = null;
    newPageRef.current = false;
    dwell.current = null;
    edge.current = null;
    if (frame.current) window.cancelAnimationFrame(frame.current);
    frame.current = 0;
    setDragged(null);
    setPreview(null);
    setMergeTarget(null);
    setGhost(null);
    setOverNewPage(false);
  }, []);

  const lift = useCallback((current: Press) => {
    current.phase = 'lifted';
    previewRef.current = [...opts.current.ids];
    setDragged(current.id);
    setPreview(previewRef.current);
    setGhost({ id: current.id, x: current.x - current.offsetX, y: current.y - current.offsetY, width: current.width, height: current.height });
    if (typeof navigator.vibrate === 'function') navigator.vibrate(8);
  }, []);

  /** Where the carried thing is aimed: its centre for a finger, the pointer for a mouse. */
  const aimPoint = (current: Press): { x: number; y: number } =>
    current.pointerType === 'mouse' ? { x: current.x, y: current.y } : { x: current.x - current.offsetX + current.width / 2, y: current.y - current.offsetY + current.height / 2 };

  const track = useCallback(() => {
    frame.current = 0;
    const current = press.current;
    const container = opts.current.container.current;
    if (!current || current.phase === 'pending' || !container) return;
    const now = Date.now();
    const bounds = container.getBoundingClientRect();
    const { x, y } = aimPoint(current);

    // Near an edge: turn the page after a moment, and keep turning while held there.
    const pages = opts.current.pages;
    const side: -1 | 1 | 0 = !pages ? 0 : current.x < bounds.left + EDGE ? -1 : current.x > bounds.right - EDGE ? 1 : 0;
    if (side === 0) edge.current = null;
    else if (pages) {
      if (!edge.current || edge.current.side !== side) edge.current = { side, since: now, last: 0 };
      const due = edge.current.last === 0 ? edge.current.since + EDGE_DWELL_MS : edge.current.last + EDGE_REPEAT_MS;
      const target = pages.current + side;
      if (now >= due && target >= 0 && target < pages.count) {
        edge.current.last = now;
        pages.goTo(target);
      }
    }

    // What is under the aim, among the slots on show.
    const slots = [...container.querySelectorAll<HTMLElement>('[data-slot-id]')];
    let over: { id: string; rect: DOMRect } | null = null;
    for (const slot of slots) {
      const rect = slot.getBoundingClientRect();
      if (rect.right < bounds.left || rect.left > bounds.right) continue;
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
        over = { id: slot.dataset.slotId!, rect };
        break;
      }
    }
    const onNewPage = (() => {
      const marker = container.querySelector<HTMLElement>('[data-new-page]');
      if (!marker) return false;
      const rect = marker.getBoundingClientRect();
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    })();

    const order = previewRef.current ?? opts.current.ids;
    let key = 'none';
    let apply: (() => void) | null = null;
    let wait = current.pointerType === 'mouse' ? MOVE_DWELL_MOUSE_MS : MOVE_DWELL_TOUCH_MS;
    if (onNewPage) {
      key = 'new-page';
      apply = () => {
        newPageRef.current = true;
        setOverNewPage(true);
      };
    } else if (over && over.id !== current.id) {
      const target = over.id;
      const middle = x > over.rect.left + over.rect.width * 0.25 && x < over.rect.right - over.rect.width * 0.25 && y > over.rect.top + over.rect.height * 0.12 && y < over.rect.top + over.rect.height * 0.62;
      if (middle && opts.current.canMerge?.(current.id, target)) {
        key = `merge:${target}`;
        wait = MERGE_DWELL_MS;
        apply = () => {
          mergeRef.current = target;
          setMergeTarget(target);
        };
      } else {
        const before = x < over.rect.left + over.rect.width / 2;
        const without = order.filter((id) => id !== current.id);
        const at = without.indexOf(target);
        const index = before ? at : at + 1;
        key = `move:${index}`;
        apply = () => {
          const next = [...without];
          next.splice(index, 0, current.id);
          if (next.join() !== order.join()) {
            previewRef.current = next;
            setPreview(next);
          }
        };
      }
    }
    // Leaving a merge target or the new page disarms it at once.
    if (!key.startsWith('merge:') && mergeRef.current) {
      mergeRef.current = null;
      setMergeTarget(null);
    }
    if (key !== 'new-page' && newPageRef.current) {
      newPageRef.current = false;
      setOverNewPage(false);
    }
    if (!dwell.current || dwell.current.key !== key) dwell.current = { key, since: now };
    else if (apply && now - dwell.current.since >= wait) {
      apply();
      dwell.current = { key: `${key}:done`, since: now };
    }
    // Keep looking while the pointer rests: dwell and edges are timed, not moved.
    frame.current = window.requestAnimationFrame(track);
  }, []);

  const finish = useCallback(
    (cancelled: boolean) => {
      const current = press.current;
      if (!current) return;
      const result: DropResult | null =
        current.phase === 'pending'
          ? null
          : cancelled
            ? { kind: 'none', dragged: current.id }
            : mergeRef.current
              ? { kind: 'merge', dragged: current.id, target: mergeRef.current }
              : newPageRef.current
                ? { kind: 'new-page', dragged: current.id }
                : previewRef.current && previewRef.current.join() !== opts.current.ids.join()
                  ? { kind: 'order', dragged: current.id, ids: [...previewRef.current] }
                  : { kind: 'none', dragged: current.id };
      if (current.phase !== 'pending') swallowClickUntil.current = Date.now() + 400;
      reset();
      if (result) opts.current.onDrop(result);
    },
    [reset],
  );

  // While something is lifted the page must not scroll under the finger, and Escape puts it back.
  useEffect(() => {
    const onTouchMove = (event: TouchEvent) => {
      if (press.current && press.current.phase !== 'pending' && event.cancelable) event.preventDefault();
    };
    const onClick = (event: MouseEvent) => {
      if (Date.now() < swallowClickUntil.current) {
        event.preventDefault();
        event.stopPropagation();
        swallowClickUntil.current = 0;
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && press.current && press.current.phase !== 'pending') {
        event.preventDefault();
        event.stopPropagation();
        finish(true);
      }
    };
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('click', onClick, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('click', onClick, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [finish]);

  // Following the pointer once it went down on a slot.
  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const current = press.current;
      if (!current || event.pointerId !== current.pointerId) return;
      current.x = event.clientX;
      current.y = event.clientY;
      const moved = Math.hypot(event.clientX - current.startX, event.clientY - current.startY);
      if (current.phase === 'pending') {
        if (opts.current.editing && current.pointerType === 'mouse' && moved > MOUSE_SLOP) {
          lift(current);
          current.phase = 'dragging';
        } else if (moved > SLOP) {
          // A swipe or a scroll: not ours.
          window.clearTimeout(current.timer);
          press.current = null;
          return;
        } else return;
      }
      if (current.phase === 'lifted' && moved > SLOP) current.phase = 'dragging';
      const element = ghostRef.current;
      if (element) element.style.transform = `translate3d(${current.x - current.offsetX}px, ${current.y - current.offsetY}px, 0)`;
      if (!frame.current) frame.current = window.requestAnimationFrame(track);
    };
    const onUp = (event: PointerEvent) => {
      if (press.current && event.pointerId === press.current.pointerId) finish(false);
    };
    const onCancel = (event: PointerEvent) => {
      if (press.current && event.pointerId === press.current.pointerId) finish(true);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    };
  }, [finish, lift, track]);

  // Leaving edit mode, or the ids changing under a pending press, ends any press.
  useEffect(() => {
    if (!options.editing && press.current && press.current.phase !== 'pending') reset();
  }, [options.editing, reset]);
  useEffect(() => () => reset(), [reset]);

  const bind = useCallback(
    (id: string) => ({
      onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
        if (press.current || (event.pointerType === 'mouse' && event.button !== 0)) return;
        if (opts.current.canLift && !opts.current.canLift(id)) return;
        // Controls inside a slot (its badges, a name being typed) keep their own presses.
        if (event.target instanceof Element && event.target.closest('[data-no-drag], input, textarea')) return;
        const rect = event.currentTarget.getBoundingClientRect();
        const record: Press = {
          id,
          pointerId: event.pointerId,
          pointerType: event.pointerType,
          startX: event.clientX,
          startY: event.clientY,
          offsetX: event.clientX - rect.left,
          offsetY: event.clientY - rect.top,
          width: rect.width,
          height: rect.height,
          timer: 0,
          phase: 'pending',
          x: event.clientX,
          y: event.clientY,
        };
        const editing = opts.current.editing;
        if (!editing) {
          record.timer = window.setTimeout(() => {
            if (press.current !== record) return;
            opts.current.onEnterEdit();
            swallowClickUntil.current = Date.now() + 2000;
            lift(record);
          }, LONG_PRESS_MS);
        } else if (event.pointerType !== 'mouse') {
          record.timer = window.setTimeout(() => {
            if (press.current === record) lift(record);
          }, TOUCH_LIFT_MS);
        }
        press.current = record;
      },
    }),
    [lift],
  );

  return { dragged, preview, mergeTarget, ghost, ghostRef, overNewPage, bind, cancel: () => finish(true) };
}
