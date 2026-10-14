import { COLLAB_EVENT, USER_AGENT_EVENT, collabEventSchema, userTopic } from '@agent-studio/protocol';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useRealtimeTopic } from '@/data/realtime';
import { useUser } from '@/data/session';
import { collabKeys } from './api';

const COLLAB_TYPES = new Set<string>(Object.values(COLLAB_EVENT));
const RUN_TYPES = new Set<string>(Object.values(USER_AGENT_EVENT));

/**
 * Keeps task views, task lists and the running list current from the user's
 * live topic. A task in an event carries no answers or usage, so a task on
 * screen is read again; bursts become one read.
 *
 * `running`: also follow the runtime's own events (a run started, ended,
 * waits) — for the screen that lists everything running.
 */
export function useCollabLiveUpdates(options: { running?: boolean } = {}): void {
  const user = useUser();
  const queryClient = useQueryClient();
  const pending = useRef<{ timer: ReturnType<typeof setTimeout> | null; tasks: Set<string>; lists: boolean; running: boolean }>({ timer: null, tasks: new Set(), lists: false, running: false });
  const followRuns = options.running === true;

  useEffect(
    () => () => {
      if (pending.current.timer) clearTimeout(pending.current.timer);
    },
    [],
  );

  const flush = () => {
    const batch = pending.current;
    batch.timer = null;
    for (const taskId of batch.tasks) void queryClient.invalidateQueries({ queryKey: collabKeys.task(taskId) });
    if (batch.lists) void queryClient.invalidateQueries({ queryKey: [...collabKeys.tasks, 'list'] });
    if (batch.running) void queryClient.invalidateQueries({ queryKey: collabKeys.running });
    batch.tasks.clear();
    batch.lists = false;
    batch.running = false;
  };
  const schedule = () => {
    if (!pending.current.timer) pending.current.timer = setTimeout(flush, 350);
  };

  useRealtimeTopic(user ? userTopic(user.id) : null, (event) => {
    if (COLLAB_TYPES.has(event.type)) {
      const parsed = collabEventSchema.safeParse({ type: event.type, data: event.data });
      if (!parsed.success) return;
      const message = parsed.data;
      if (message.type === COLLAB_EVENT.taskRemoved) {
        queryClient.removeQueries({ queryKey: collabKeys.task(message.data.taskId) });
      } else if (message.type === COLLAB_EVENT.taskCreated || message.type === COLLAB_EVENT.taskUpdated) {
        pending.current.tasks.add(message.data.task.id);
      }
      pending.current.lists = true;
      pending.current.running = true;
      schedule();
      return;
    }
    if (followRuns && RUN_TYPES.has(event.type) && event.type !== USER_AGENT_EVENT.draftChanged) {
      pending.current.running = true;
      schedule();
    }
  });
}
