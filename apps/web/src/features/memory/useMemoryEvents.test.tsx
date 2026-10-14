import { MEMORY_CHANGED, memoryTopic } from '@agent-studio/protocol';
import { act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderInApp } from '@/test/render';
import { memoryKeys } from './api';
import { noteLeaving, noteStayed, useMemoryEvents } from './useMemoryEvents';

type Handler = (event: { type: string; data: unknown }) => void;
const live = vi.hoisted(() => ({ handlers: new Map<string, Handler>() }));
vi.mock('@/data/realtime', () => ({
  realtime: {
    subscribe: (topic: string, handler: Handler) => {
      live.handlers.set(topic, handler);
      return () => live.handlers.delete(topic);
    },
  },
  useOnReconnect: () => {},
}));

function Listener() {
  useMemoryEvents(['global']);
  return null;
}

/** The note queries a spy on `invalidateQueries` was asked to re-read. */
function noteKeysInvalidated(spy: { mock: { calls: unknown[][] } }): (readonly unknown[])[] {
  return spy.mock.calls
    .map((call) => (call[0] as { queryKey?: readonly unknown[] } | undefined)?.queryKey)
    .filter((key): key is readonly unknown[] => Array.isArray(key) && key[1] === 'note');
}

describe('live memory news', () => {
  it('re-reads a note changed elsewhere, but not one this tab is moving away or deleting', () => {
    const { queryClient } = renderInApp(<Listener />);
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    const send = (data: unknown) => act(() => live.handlers.get(memoryTopic('global'))?.({ type: MEMORY_CHANGED, data }));

    // Changed on another device: the open note is read again.
    send({ action: 'updated', id: 'global/house-style' });
    expect(noteKeysInvalidated(spy)).toEqual([memoryKeys.note('global/house-style')]);

    // Moved from here: the news may arrive before the answer; the old name no longer exists and is not asked for.
    spy.mockClear();
    noteLeaving('global/release-checklist');
    send({ action: 'moved', id: 'global/process/release-checklist', previousId: 'global/release-checklist' });
    expect(noteKeysInvalidated(spy)).toEqual([memoryKeys.note('global/process/release-checklist')]);

    // Deleted from here: nothing to read again.
    spy.mockClear();
    noteLeaving('global/process/release-checklist');
    send({ action: 'deleted', id: 'global/process/release-checklist' });
    expect(noteKeysInvalidated(spy)).toEqual([]);

    // A refused delete keeps the note: news of it is followed again.
    spy.mockClear();
    noteStayed('global/process/release-checklist');
    send({ action: 'updated', id: 'global/process/release-checklist' });
    expect(noteKeysInvalidated(spy)).toEqual([memoryKeys.note('global/process/release-checklist')]);
  });
});
