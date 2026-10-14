import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useProjectEvents } from '@/features/projects/tools/kit';
import type { InspectorBadge, InspectorContext } from '@/features/workbench/inspector/registry';
import { useT } from '@/i18n';
import { gitApi, gitKeys } from './api';
import { changedFileCount } from './status';

/**
 * The number on the Git tab: files with uncommitted changes. It shares the
 * panel's own reading of the status and is kept current by the project's
 * change events, so it costs one request when the tools are first shown.
 */
export function useGitBadge(context: InspectorContext): InspectorBadge | null {
  const t = useT();
  const queryClient = useQueryClient();
  const projectId = context.project?.id ?? null;
  const status = useQuery({
    queryKey: gitKeys.status(projectId ?? ''),
    queryFn: ({ signal }) => gitApi.status(projectId!, signal),
    enabled: projectId !== null,
    staleTime: 15_000,
    retry: false,
  });
  const reread = () => {
    if (projectId) void queryClient.invalidateQueries({ queryKey: gitKeys.status(projectId) });
  };
  useProjectEvents(projectId, { onGit: reread, onFiles: reread, onReconnect: reread });
  const count = status.data?.state === 'ready' ? changedFileCount(status.data) : 0;
  return count > 0 ? { count, label: t.plural('git.badge', count) } : null;
}
