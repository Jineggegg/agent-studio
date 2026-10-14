import type { Task } from '@agent-studio/protocol';
import { useInfiniteQuery } from '@tanstack/react-query';
import { type TaskListParams, collabApi, collabKeys } from '../api';

const PAGE = 20;

/** The caller's tasks, a page at a time, newest first; kept current from the live topic. */
export function useTaskList(params: TaskListParams, options: { enabled?: boolean; limit?: number } = {}) {
  const limit = options.limit ?? PAGE;
  return useInfiniteQuery({
    queryKey: [...collabKeys.taskList(params), limit],
    queryFn: ({ pageParam, signal }) => collabApi.tasks({ ...params, limit, ...(pageParam ? { before: pageParam } : {}) }, signal),
    initialPageParam: '' as string,
    getNextPageParam: (last) => (last.hasMore && last.tasks.length > 0 ? last.tasks.at(-1)!.id : undefined),
    enabled: options.enabled ?? true,
    meta: { live: true },
  });
}

export function flattenTasks(pages: { tasks: Task[] }[] | undefined): Task[] {
  const seen = new Set<string>();
  const tasks: Task[] = [];
  for (const page of pages ?? []) {
    for (const task of page.tasks) {
      if (seen.has(task.id)) continue;
      seen.add(task.id);
      tasks.push(task);
    }
  }
  return tasks;
}
