import { MEMORY_CHANGED, type MemoryChangedEvent, memoryChangedEventSchema, memoryTopic } from '@agent-studio/protocol';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { realtime, useOnReconnect } from '@/data/realtime';
import { memoryKeys } from './api';

/** Folders listened to at most at once: the live connection paces its frames, and a list rarely shows more. */
export const MAX_LIVE_FOLDERS = 12;

/**
 * Notes this tab is moving away, renaming or deleting. The news of that can
 * arrive before the answer does; it must not make an open reader ask again
 * for a note that no longer exists under that name.
 */
const leavingHere = new Map<string, number>();
const LEAVING_MS = 15_000;

/** About to move, rename or delete `id` from here. */
export function noteLeaving(id: string): void {
  leavingHere.set(id, Date.now() + LEAVING_MS);
}

/** It stayed after all (the change was refused, or kept its name). */
export function noteStayed(id: string): void {
  leavingHere.delete(id);
}

function isLeavingHere(id: string): boolean {
  const until = leavingHere.get(id);
  if (until === undefined) return false;
  if (until >= Date.now()) return true;
  leavingHere.delete(id);
  return false;
}

/**
 * Keeps the memory app current: a note written by an assistant, on another
 * device or by hand in its file shows up without a reload. Changes in a
 * burst become one re-read. `onChange` hears every event (the editor uses it
 * to say that the note being edited changed underneath).
 */
export function useMemoryEvents(folders: readonly string[], onChange?: (event: MemoryChangedEvent) => void): void {
  const queryClient = useQueryClient();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listener = useRef(onChange);
  useEffect(() => {
    listener.current = onChange;
  });
  const key = folders.slice(0, MAX_LIVE_FOLDERS).join('\n');

  useEffect(() => {
    if (key === '') return;
    const refresh = () => {
      if (timer.current) return;
      timer.current = setTimeout(() => {
        timer.current = null;
        void queryClient.invalidateQueries({ queryKey: memoryKeys.all, predicate: (query) => query.queryKey[1] !== 'note' });
      }, 350);
    };
    const stops = key.split('\n').map((folder) =>
      realtime.subscribe(memoryTopic(folder), (event) => {
        if (event.type !== MEMORY_CHANGED) return;
        const parsed = memoryChangedEventSchema.safeParse(event.data);
        if (!parsed.success) return;
        listener.current?.(parsed.data);
        for (const id of [parsed.data.id, parsed.data.previousId]) {
          if (id && !isLeavingHere(id)) void queryClient.invalidateQueries({ queryKey: memoryKeys.note(id) });
        }
        refresh();
      }),
    );
    return () => {
      for (const stop of stops) stop();
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, [key, queryClient]);

  useOnReconnect(() => void queryClient.invalidateQueries({ queryKey: memoryKeys.all }));
}
