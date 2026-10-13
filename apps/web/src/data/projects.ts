import {
  type FolderListing,
  PROJECT_CHANGED,
  type Project,
  type UpdateProjectRequest,
  type createProjectRequestSchema,
  folderListingSchema,
  projectSchema,
  userTopic,
} from '@agent-studio/protocol';
import { type UseQueryResult, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { api } from './api';
import { useRealtimeTopic } from './realtime';
import { useUser } from './session';

/**
 * Projects, as every feature reads them. One cache entry holds the list;
 * creating, changing or removing a project updates it in place, and a change
 * made elsewhere (another device, the owner sharing a project with you)
 * arrives over the live connection.
 */

const listSchema = z.object({ projects: z.array(projectSchema) });

/** What creating a project takes; fields with server-side defaults may be left out. */
export type CreateProjectInput = z.input<typeof createProjectRequestSchema>;

export const projectKeys = {
  all: ['projects'] as const,
  list: (archived: 'exclude' | 'include') => ['projects', 'list', archived] as const,
  folders: (path: string | null) => ['projects', 'folders', path] as const,
};

async function fetchProjects(archived: 'exclude' | 'include', signal?: AbortSignal): Promise<Project[]> {
  const { projects } = await api.get('/api/projects', { schema: listSchema, query: { archived }, ...(signal ? { signal } : {}) });
  return projects;
}

/** The caller's projects. `archived: 'include'` adds the archived ones (for a "manage projects" list). */
export function useProjects(options: { archived?: 'exclude' | 'include'; enabled?: boolean } = {}): UseQueryResult<Project[]> {
  const archived = options.archived ?? 'exclude';
  return useQuery({
    queryKey: projectKeys.list(archived),
    queryFn: ({ signal }) => fetchProjects(archived, signal),
    enabled: options.enabled ?? true,
    meta: { live: true },
  });
}

/** Keep the project list current from the user's live topic. Mount once where projects are shown. */
export function useProjectsLiveUpdates(): void {
  const user = useUser();
  const queryClient = useQueryClient();
  useRealtimeTopic(user ? userTopic(user.id) : null, (event) => {
    if (event.type === PROJECT_CHANGED) void queryClient.invalidateQueries({ queryKey: projectKeys.all });
  });
}

export function useCreateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateProjectInput) => api.post('/api/projects', input, { schema: projectSchema }),
    onSuccess: (project) => {
      queryClient.setQueriesData<Project[]>({ queryKey: ['projects', 'list'] }, (current) =>
        current && !current.some((item) => item.id === project.id) ? [...current, project] : current,
      );
      void queryClient.invalidateQueries({ queryKey: projectKeys.all });
    },
  });
}

export function useUpdateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, changes }: { id: string; changes: UpdateProjectRequest }) => api.patch(`/api/projects/${id}`, changes, { schema: projectSchema }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: projectKeys.all }),
  });
}

export function useRemoveProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/projects/${id}`),
    onSuccess: (_result, id) => {
      queryClient.setQueriesData<Project[]>({ queryKey: ['projects', 'list'] }, (current) => current?.filter((item) => item.id !== id));
      void queryClient.invalidateQueries({ queryKey: projectKeys.all });
    },
  });
}

/** Folders on the server that may become a project (owner only). `path: null` lists the workspace roots. */
export function useFolderListing(path: string | null, enabled: boolean): UseQueryResult<FolderListing> {
  return useQuery({
    queryKey: projectKeys.folders(path),
    queryFn: ({ signal }) => api.get('/api/projects/browse', { schema: folderListingSchema, query: { path }, signal }),
    enabled,
    staleTime: 10_000,
  });
}
