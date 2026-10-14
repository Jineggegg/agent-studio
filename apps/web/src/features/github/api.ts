import {
  type GithubInboxFilter,
  type GithubMergeRequest,
  githubAccountSchema,
  githubActionLogSchema,
  githubBranchPullSchema,
  githubFixResultSchema,
  githubInboxSchema,
  githubMergeResultSchema,
  githubPullDetailSchema,
  githubRepositoriesSchema,
  githubRepositoryPageSchema,
} from '@agent-studio/protocol';
import { api } from '@/data/api';

/**
 * Every request the GitHub screens make. The server talks to GitHub through
 * the `gh` login on its own machine: there is no sign-in from the browser and
 * no token ever reaches it. Everything but the per-project branch lookup is
 * for the owner; the writes additionally need a signed-in browser.
 */
const enc = encodeURIComponent;
const withSignal = (signal?: AbortSignal) => (signal ? { signal } : {});
const fresh = (refresh: boolean) => (refresh ? { refresh: 'true' } : {});
const pullPath = (owner: string, repo: string, number: number) => `/api/github/repositories/${enc(owner)}/${enc(repo)}/pulls/${number}`;
/** GitHub can be slow, and a write must not be given up on while it may still be happening. */
const WRITE_TIMEOUT_MS = 60_000;

export interface PullRef {
  owner: string;
  repo: string;
  number: number;
}

export const githubApi = {
  account: (refresh = false, signal?: AbortSignal) => api.get('/api/github/account', { schema: githubAccountSchema, query: fresh(refresh), ...withSignal(signal) }),
  inbox: (filter: GithubInboxFilter, refresh = false, signal?: AbortSignal) =>
    api.get('/api/github/inbox', { schema: githubInboxSchema, query: { filter, ...fresh(refresh) }, timeoutMs: 40_000, ...withSignal(signal) }),
  repositories: (cursor: string | null, refresh = false, signal?: AbortSignal) =>
    api.get('/api/github/repositories', { schema: githubRepositoriesSchema, query: { limit: 30, cursor: cursor ?? undefined, ...fresh(refresh) }, timeoutMs: 40_000, ...withSignal(signal) }),
  repository: (owner: string, repo: string, refresh = false, signal?: AbortSignal) =>
    api.get(`/api/github/repositories/${enc(owner)}/${enc(repo)}`, { schema: githubRepositoryPageSchema, query: fresh(refresh), timeoutMs: 40_000, ...withSignal(signal) }),
  pull: (ref: PullRef, refresh = false, signal?: AbortSignal) => api.get(pullPath(ref.owner, ref.repo, ref.number), { schema: githubPullDetailSchema, query: fresh(refresh), timeoutMs: 40_000, ...withSignal(signal) }),
  actions: (signal?: AbortSignal) => api.get('/api/github/actions', { schema: githubActionLogSchema, query: { action: 'all', limit: 20 }, ...withSignal(signal) }).then((log) => log.entries),
  /** The open pull request of the branch a project has checked out. A non-owner always gets "owner_only". */
  branchPull: (projectId: string, refresh = false, signal?: AbortSignal) =>
    api.get(`/api/projects/${enc(projectId)}/github/pull-request`, { schema: githubBranchPullSchema, query: fresh(refresh), timeoutMs: 30_000, ...withSignal(signal) }),

  merge: (ref: PullRef, request: GithubMergeRequest) => api.post(`${pullPath(ref.owner, ref.repo, ref.number)}/merge`, request, { schema: githubMergeResultSchema, timeoutMs: WRITE_TIMEOUT_MS }),
  updateBranch: (ref: PullRef, headSha: string) => api.post(`${pullPath(ref.owner, ref.repo, ref.number)}/update-branch`, { headSha }, { schema: githubFixResultSchema, timeoutMs: WRITE_TIMEOUT_MS }),
  markReady: (ref: PullRef) => api.post(`${pullPath(ref.owner, ref.repo, ref.number)}/ready`, {}, { schema: githubFixResultSchema, timeoutMs: WRITE_TIMEOUT_MS }),
  approveRuns: (ref: PullRef, runIds: readonly number[]) => api.post(`${pullPath(ref.owner, ref.repo, ref.number)}/approve-runs`, { runIds }, { schema: githubFixResultSchema, timeoutMs: WRITE_TIMEOUT_MS }),
};

export const githubKeys = {
  all: ['github'] as const,
  account: ['github', 'account'] as const,
  inbox: (filter: GithubInboxFilter) => ['github', 'inbox', filter] as const,
  repositories: ['github', 'repositories'] as const,
  repository: (owner: string, repo: string) => ['github', 'repository', owner, repo] as const,
  pull: (ref: PullRef) => ['github', 'pull', ref.owner, ref.repo, ref.number] as const,
  actions: ['github', 'actions'] as const,
  branchPull: (projectId: string) => ['github', 'branch-pull', projectId] as const,
};
