import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHAT_MIN_WIDTH, arrangeColumns, listPresentation } from '../columns';
import { INSPECTOR_MIN_WIDTH, LIST_DEFAULT_WIDTH, LIST_MAX_WIDTH, LIST_MIN_WIDTH, __resetDeviceMemoryForTests, clampListWidth, parseDeviceMemory, setListWidth, useDeviceMemory } from '../device';
import { LIST_KEY_STEP, ListColumn } from './ListColumn';

/** The list column as the workbench draws it: fitted to a frame of the given width, beside an inspector of the given width. */
function Harness({ frameWidth = 1440, inspector = 0 }: { frameWidth?: number; inspector?: number }) {
  const listWidth = useDeviceMemory((state) => state.listWidth);
  const columns = arrangeColumns({ frameWidth, listDocked: true, listWidth, inspectorDocked: inspector > 0, inspectorWidth: inspector });
  return (
    <div className="wb">
      <ListColumn width={columns.list} maxWidth={columns.listMax}>
        <p>The conversations</p>
      </ListColumn>
    </div>
  );
}

const handle = () => screen.getByRole('separator', { name: 'Resize the conversation list' });
const list = () => screen.getByRole('navigation', { name: 'Conversations' });
const stored = () => useDeviceMemory.getState().listWidth;

function dragBy(dx: number, { from = 320, release = true }: { from?: number; release?: boolean } = {}) {
  fireEvent.pointerDown(handle(), { pointerId: 1, button: 0, clientX: from });
  fireEvent.pointerMove(handle(), { pointerId: 1, clientX: from + dx / 2 });
  fireEvent.pointerMove(handle(), { pointerId: 1, clientX: from + dx });
  if (release) fireEvent.pointerUp(handle(), { pointerId: 1, clientX: from + dx });
}

describe('the width of the conversation list', () => {
  beforeEach(() => __resetDeviceMemoryForTests());
  afterEach(() => {
    vi.useRealTimers();
    __resetDeviceMemoryForTests();
  });

  it('is clamped to its limits and read back defensively', () => {
    expect(clampListWidth(10)).toBe(LIST_MIN_WIDTH);
    expect(clampListWidth(10_000)).toBe(LIST_MAX_WIDTH);
    expect(clampListWidth(333.6)).toBe(334);
    expect(clampListWidth(Number.NaN)).toBe(LIST_DEFAULT_WIDTH);
    expect(parseDeviceMemory({}).listWidth).toBe(LIST_DEFAULT_WIDTH);
    expect(parseDeviceMemory({ listWidth: '400' }).listWidth).toBe(LIST_DEFAULT_WIDTH);
    expect(parseDeviceMemory({ listWidth: 400 }).listWidth).toBe(400);
    expect(parseDeviceMemory({ listWidth: 5 }).listWidth).toBe(LIST_MIN_WIDTH);
    expect(parseDeviceMemory({ listWidth: 9_999 }).listWidth).toBe(LIST_MAX_WIDTH);
  });

  it('is a column beside the chat on tablet and wide, and never on a phone, where the list is a sheet', () => {
    expect(listPresentation('wide', false)).toBe('docked');
    expect(listPresentation('tablet', false)).toBe('docked');
    expect(listPresentation('wide', true)).toBe('hidden');
    expect(listPresentation('phone', false)).toBe('sheet');
    expect(listPresentation('phone', true)).toBe('sheet');
    expect(arrangeColumns({ frameWidth: 390, listDocked: false, listWidth: 400, inspectorDocked: false, inspectorWidth: 440 })).toEqual({ list: 0, listMax: 0, inspectorMax: 390 - CHAT_MIN_WIDTH });
  });

  it('leaves the chat its minimum when the window is narrow, and gets the chosen width back when it is wide again', () => {
    const at = (frameWidth: number, inspectorDocked = false, inspectorWidth = 440) => arrangeColumns({ frameWidth, listDocked: true, listWidth: 460, inspectorDocked, inspectorWidth });
    expect(at(1440)).toMatchObject({ list: 460, listMax: LIST_MAX_WIDTH });
    // A small tablet: only what the chat can spare.
    expect(at(700)).toMatchObject({ list: 700 - CHAT_MIN_WIDTH, listMax: 700 - CHAT_MIN_WIDTH });
    // Never below the minimum, even if the chat must then give way.
    expect(at(560).list).toBe(LIST_MIN_WIDTH);
    // With the inspector docked, the inspector gives way to its own minimum first…
    expect(at(1440, true, 440)).toEqual({ list: 460, listMax: LIST_MAX_WIDTH, inspectorMax: 1440 - 460 - CHAT_MIN_WIDTH });
    expect(at(1024, true, 440)).toEqual({ list: 1024 - CHAT_MIN_WIDTH - INSPECTOR_MIN_WIDTH, listMax: 1024 - CHAT_MIN_WIDTH - INSPECTOR_MIN_WIDTH, inspectorMax: INSPECTOR_MIN_WIDTH });
    // …and the list is never made wider by pushing the inspector.
    const roomy = arrangeColumns({ frameWidth: 1440, listDocked: true, listWidth: 300, inspectorDocked: true, inspectorWidth: 700 });
    expect(roomy).toMatchObject({ list: 300, listMax: 1440 - CHAT_MIN_WIDTH - 700 });
  });

  it('is the default until it is changed, and says so to assistive technology', () => {
    render(<Harness />);
    expect(list()).toHaveStyle({ width: `${LIST_DEFAULT_WIDTH}px` });
    expect(handle()).toHaveAttribute('aria-orientation', 'vertical');
    expect(handle()).toHaveAttribute('aria-valuenow', String(LIST_DEFAULT_WIDTH));
    expect(handle()).toHaveAttribute('aria-valuemin', String(LIST_MIN_WIDTH));
    expect(handle()).toHaveAttribute('aria-valuemax', String(LIST_MAX_WIDTH));
    expect(handle()).toHaveAttribute('tabindex', '0');
  });

  it('follows a drag live and remembers it on release, on this device', () => {
    vi.useFakeTimers();
    render(<Harness />);
    dragBy(60, { release: false });
    expect(list()).toHaveStyle({ width: '380px' });
    expect(list()).toHaveAttribute('data-dragging');
    expect(handle()).toHaveAttribute('aria-valuenow', '380');
    // Nothing is stored until the pointer lets go.
    expect(stored()).toBe(LIST_DEFAULT_WIDTH);
    fireEvent.pointerUp(handle(), { pointerId: 1, clientX: 380 });
    expect(stored()).toBe(380);
    expect(list()).not.toHaveAttribute('data-dragging');
    expect(list()).toHaveStyle({ width: '380px' });
    act(() => vi.advanceTimersByTime(500));
    expect(JSON.parse(window.localStorage.getItem('studio.workbench.device') ?? '{}')).toMatchObject({ listWidth: 380 });
  });

  it('stops at the minimum and the maximum however far it is dragged', () => {
    render(<Harness />);
    dragBy(-500);
    expect(stored()).toBe(LIST_MIN_WIDTH);
    expect(list()).toHaveStyle({ width: `${LIST_MIN_WIDTH}px` });
    dragBy(2_000);
    expect(stored()).toBe(LIST_MAX_WIDTH);
  });

  it('never takes the room the chat needs, beside a docked inspector', () => {
    render(<Harness frameWidth={1100} inspector={400} />);
    const max = 1100 - CHAT_MIN_WIDTH - 400;
    expect(handle()).toHaveAttribute('aria-valuemax', String(max));
    dragBy(300);
    expect(stored()).toBe(max);
  });

  it('ignores a second pointer, a right button and a click without movement', () => {
    render(<Harness />);
    fireEvent.pointerDown(handle(), { pointerId: 1, button: 2, clientX: 320 });
    fireEvent.pointerMove(handle(), { pointerId: 1, clientX: 400 });
    expect(list()).toHaveStyle({ width: '320px' });
    fireEvent.pointerDown(handle(), { pointerId: 1, button: 0, clientX: 320 });
    fireEvent.pointerMove(handle(), { pointerId: 2, clientX: 420 });
    expect(list()).toHaveStyle({ width: '320px' });
    fireEvent.pointerUp(handle(), { pointerId: 1, clientX: 320 });
    expect(stored()).toBe(LIST_DEFAULT_WIDTH);
  });

  it('changes in steps with the arrow keys, and jumps to its limits with Home and End', () => {
    render(<Harness />);
    act(() => handle().focus());
    fireEvent.keyDown(handle(), { key: 'ArrowRight' });
    expect(stored()).toBe(LIST_DEFAULT_WIDTH + LIST_KEY_STEP);
    expect(handle()).toHaveAttribute('aria-valuenow', String(LIST_DEFAULT_WIDTH + LIST_KEY_STEP));
    fireEvent.keyDown(handle(), { key: 'ArrowLeft' });
    fireEvent.keyDown(handle(), { key: 'ArrowLeft' });
    expect(stored()).toBe(LIST_DEFAULT_WIDTH - LIST_KEY_STEP);
    fireEvent.keyDown(handle(), { key: 'Home' });
    expect(stored()).toBe(LIST_MIN_WIDTH);
    fireEvent.keyDown(handle(), { key: 'ArrowLeft' });
    expect(stored()).toBe(LIST_MIN_WIDTH);
    fireEvent.keyDown(handle(), { key: 'End' });
    expect(stored()).toBe(LIST_MAX_WIDTH);
    fireEvent.keyDown(handle(), { key: 'ArrowRight' });
    expect(stored()).toBe(LIST_MAX_WIDTH);
    // Other keys are left alone.
    const tab = fireEvent.keyDown(handle(), { key: 'Tab' });
    expect(tab).toBe(true);
  });

  it('steps from the width on show when the window has made it narrower than chosen', () => {
    act(() => setListWidth(460));
    render(<Harness frameWidth={760} />);
    expect(list()).toHaveStyle({ width: `${760 - CHAT_MIN_WIDTH}px` });
    fireEvent.keyDown(handle(), { key: 'ArrowLeft' });
    expect(stored()).toBe(760 - CHAT_MIN_WIDTH - LIST_KEY_STEP);
  });

  it('goes back to the default width on a double click', () => {
    act(() => setListWidth(450));
    render(<Harness />);
    expect(list()).toHaveStyle({ width: '450px' });
    fireEvent.doubleClick(handle());
    expect(stored()).toBe(LIST_DEFAULT_WIDTH);
    expect(list()).toHaveStyle({ width: `${LIST_DEFAULT_WIDTH}px` });
  });

  it('comes back as it was left when the page is loaded again', async () => {
    window.localStorage.setItem('studio.workbench.device', JSON.stringify({ listWidth: 410 }));
    vi.resetModules();
    const fresh = await import('../device');
    expect(fresh.useDeviceMemory.getState().listWidth).toBe(410);
    fresh.__resetDeviceMemoryForTests();
  });
});
