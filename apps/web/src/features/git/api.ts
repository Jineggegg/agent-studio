import {
  type GitCommitRequest,
  type GitCreateBranchRequest,
  type GitCreateWorktreeRequest,
  type GitIdentity,
  type GitMergeWorktreeRequest,
  type GitRemoveWorktreeRequest,
  gitBaselineSchema,
  gitBranchResultSchema,
  gitBranchesSchema,
  gitCommitDetailSchema,
  gitCommitResultSchema,
  gitComparisonSchema,
  gitCreateWorktreeResultSchema,
  gitFileDiffSchema,
  gitIdentityStateSchema,
  gitInitResultSchema,
  gitLogSchema,
  gitMergeWorktreeResultSchema,
  gitRemoveWorktreeResultSchema,
  gitStatusSchema,
  gitSyncResultSchema,
  gitUndoCommitResultSchema,
  gitWorktreesSchema,
  projectSchema,
} from '@agent-studio/protocol';
import { z } from 'zod';
import { api } from '@/data/api';

/**
 * Every request the Git panel makes. The working folder always comes from the
 * project on the server; a client only ever names files inside it and refs.
 */
const enc = encodeURIComponent;
const base = (projectId: string) => `/api/projects/${enc(projectId)}/git`;
const withSignal = (signal?: AbortSignal) => (signal ? { signal } : {});
/** Talking to a remote can take a while on a phone's connection; the server has its own, shorter, limit and says so. */
const REMOTE_TIMEOUT_MS = 150_000;

export const gitApi = {
  status: (projectId: string, signal?: AbortSignal) => api.get(`${base(projectId)}/status`, { schema: gitStatusSchema, ...withSignal(signal) }),
  diff: (projectId: string, path: string, staged: boolean, signal?: AbortSignal) =>
    api.get(`${base(projectId)}/diff`, { schema: gitFileDiffSchema, query: { path, staged: staged ? 'true' : 'false' }, ...withSignal(signal) }),
  baseline: (projectId: string, path: string, signal?: AbortSignal) => api.get(`${base(projectId)}/baseline`, { schema: gitBaselineSchema, query: { path }, ...withSignal(signal) }),
  branches: (projectId: string, signal?: AbortSignal) => api.get(`${base(projectId)}/branches`, { schema: gitBranchesSchema, ...withSignal(signal) }),
  log: (projectId: string, cursor: string | null, signal?: AbortSignal) =>
    api.get(`${base(projectId)}/log`, { schema: gitLogSchema, query: { limit: 40, cursor: cursor ?? undefined }, ...withSignal(signal) }),
  commit: (projectId: string, oid: string, signal?: AbortSignal) => api.get(`${base(projectId)}/commits/${enc(oid)}`, { schema: gitCommitDetailSchema, ...withSignal(signal) }),
  compare: (projectId: string, baseRef: string, signal?: AbortSignal) => api.get(`${base(projectId)}/compare`, { schema: gitComparisonSchema, query: { base: baseRef }, ...withSignal(signal) }),
  compareDiff: (projectId: string, baseRef: string, path: string, originalPath: string | null, signal?: AbortSignal) =>
    api.get(`${base(projectId)}/compare/diff`, { schema: gitFileDiffSchema, query: { base: baseRef, path, originalPath: originalPath ?? undefined }, ...withSignal(signal) }),
  worktrees: (projectId: string, signal?: AbortSignal) => api.get(`${base(projectId)}/worktrees`, { schema: gitWorktreesSchema, ...withSignal(signal) }),

  init: (projectId: string) => api.post(`${base(projectId)}/init`, {}, { schema: gitInitResultSchema }),
  initialCommit: (projectId: string, message?: string) => api.post(`${base(projectId)}/initial-commit`, message ? { message } : {}, { schema: gitCommitResultSchema, timeoutMs: 60_000 }),
  stage: (projectId: string, paths: readonly string[] | 'all') => api.post(`${base(projectId)}/stage`, paths === 'all' ? { all: true } : { paths }),
  unstage: (projectId: string, paths: readonly string[] | 'all') => api.post(`${base(projectId)}/unstage`, paths === 'all' ? { all: true } : { paths }),
  discard: (projectId: string, path: string) => api.post(`${base(projectId)}/discard`, { path }),
  deleteUntracked: (projectId: string, path: string) => api.post(`${base(projectId)}/delete-untracked`, { path }),
  commitStaged: (projectId: string, request: GitCommitRequest) => api.post(`${base(projectId)}/commit`, request, { schema: gitCommitResultSchema, timeoutMs: 60_000 }),
  undoCommit: (projectId: string) => api.post(`${base(projectId)}/undo-commit`, {}, { schema: gitUndoCommitResultSchema }),

  createBranch: (projectId: string, request: Pick<GitCreateBranchRequest, 'name'> & Partial<GitCreateBranchRequest>) => api.post(`${base(projectId)}/branches`, request, { schema: gitBranchResultSchema }),
  switchBranch: (projectId: string, branch: string, kind: 'local' | 'remote') => api.post(`${base(projectId)}/switch`, { branch, kind }, { schema: gitBranchResultSchema, timeoutMs: 60_000 }),
  deleteBranch: (projectId: string, name: string, force: boolean) => api.post(`${base(projectId)}/branches/delete`, { name, force }, { schema: gitBranchResultSchema }),

  fetch: (projectId: string) => api.post(`${base(projectId)}/fetch`, {}, { schema: gitSyncResultSchema, timeoutMs: REMOTE_TIMEOUT_MS }),
  pull: (projectId: string, mode: 'ff-only' | 'merge') => api.post(`${base(projectId)}/pull`, { mode }, { schema: gitSyncResultSchema, timeoutMs: REMOTE_TIMEOUT_MS }),
  push: (projectId: string, publish: boolean) => api.post(`${base(projectId)}/push`, { publish }, { schema: gitSyncResultSchema, timeoutMs: REMOTE_TIMEOUT_MS }),

  createWorktree: (projectId: string, request: GitCreateWorktreeRequest) => api.post(`${base(projectId)}/worktrees`, request, { schema: gitCreateWorktreeResultSchema, timeoutMs: 60_000 }),
  openWorktree: (projectId: string, path: string) => api.post(`${base(projectId)}/worktrees/open`, { path }, { schema: z.object({ project: projectSchema }) }),
  removeWorktree: (projectId: string, request: Pick<GitRemoveWorktreeRequest, 'path'> & Partial<GitRemoveWorktreeRequest>) =>
    api.post(`${base(projectId)}/worktrees/remove`, request, { schema: gitRemoveWorktreeResultSchema, timeoutMs: 60_000 }),
  mergeWorktree: (projectId: string, request: Pick<GitMergeWorktreeRequest, 'path'> & Partial<GitMergeWorktreeRequest>) =>
    api.post(`${base(projectId)}/worktrees/merge`, request, { schema: gitMergeWorktreeResultSchema, timeoutMs: 90_000 }),

  identity: (signal?: AbortSignal) => api.get('/api/git/identity', { schema: gitIdentityStateSchema, ...withSignal(signal) }),
  saveIdentity: (identity: GitIdentity) => api.put('/api/git/identity', identity, { schema: gitIdentityStateSchema }),
};

export const gitKeys = {
  all: (projectId: string) => ['git', projectId] as const,
  status: (projectId: string) => ['git', projectId, 'status'] as const,
  diff: (projectId: string, path: string, staged: boolean) => ['git', projectId, 'diff', path, staged] as const,
  branches: (projectId: string) => ['git', projectId, 'branches'] as const,
  log: (projectId: string) => ['git', projectId, 'log'] as const,
  commit: (projectId: string, oid: string) => ['git', projectId, 'commit', oid] as const,
  compare: (projectId: string, baseRef: string) => ['git', projectId, 'compare', baseRef] as const,
  compareDiff: (projectId: string, baseRef: string, path: string) => ['git', projectId, 'compare-diff', baseRef, path] as const,
  worktrees: (projectId: string) => ['git', projectId, 'worktrees'] as const,
  identity: ['git', 'identity'] as const,
};
