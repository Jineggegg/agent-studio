import { z } from 'zod';
import { idSchema, limitQuery, timestampSchema } from './common.js';
import { filePathSchema } from './files.js';
import { projectSchema } from './projects.js';

/**
 * Wire contracts for the "git" feature. Everything is addressed by project:
 * the working directory always comes from the stored project, never from the
 * client. Paths are project-relative with forward slashes.
 */

// ---- names a client may send -----------------------------------------------------

/**
 * A branch, tag or remote-tracking name as a client may send it. The server
 * applies git's own ref-name rules plus a stricter character set; this schema
 * only bounds the size so that the server can answer with a precise reason.
 */
export const gitRefInputSchema = z.string().trim().min(1).max(250);

/** A full or abbreviated commit id. */
export const gitOidSchema = z.string().regex(/^[0-9a-f]{4,64}$/, 'Not a commit id.');

// ---- failures --------------------------------------------------------------------

/**
 * Stable `error.code` values of this feature. The message is a sentence for
 * the user; `details.output`, when present, is git's own (redacted) wording.
 */
export const GIT_ERROR_CODES = [
  'git_unavailable',
  'git_untrusted',
  'git_not_a_repository',
  'git_invalid_ref',
  'git_invalid_remote',
  'git_unknown_ref',
  'git_no_common_history',
  'git_no_commits',
  'git_no_remote',
  'git_no_upstream',
  'git_detached_head',
  'git_auth_failed',
  'git_network',
  'git_remote_not_found',
  'git_timeout',
  'git_push_rejected',
  'git_diverged',
  'git_conflict',
  'git_would_overwrite',
  'git_operation_in_progress',
  'git_nothing_to_commit',
  'git_identity_missing',
  'git_commit_rejected',
  'git_commit_pushed',
  'git_branch_exists',
  'git_branch_current',
  'git_branch_not_merged',
  'git_branch_in_use',
  'git_unknown_path',
  'git_not_tracked',
  'git_not_untracked',
  'git_nothing_to_discard',
  'git_worktree_dirty',
  'git_worktree_main',
  'git_worktree_exists',
  'git_worktree_unknown',
  'git_worktree_location',
  'git_merge_commit',
  'git_busy',
  'git_failed',
] as const;
export type GitErrorCode = (typeof GIT_ERROR_CODES)[number];

// ---- status ----------------------------------------------------------------------

/**
 * `ready` the project folder is the top of a work tree; `none` it is not a
 * repository; `nested` it lies inside a larger repository, which is not
 * managed from here; `bare` it is a repository without a work tree;
 * `untrusted` git refuses to use it (it belongs to another system account);
 * `unavailable` git is not installed on the server.
 */
export const gitRepositoryStateSchema = z.enum(['ready', 'none', 'nested', 'bare', 'untrusted', 'unavailable']);
export type GitRepositoryState = z.infer<typeof gitRepositoryStateSchema>;

export const gitIndexChangeSchema = z.enum(['added', 'modified', 'deleted', 'renamed', 'copied', 'type_changed']);
export const gitWorktreeChangeSchema = z.enum(['modified', 'deleted', 'type_changed', 'untracked']);

export const gitFileStatusSchema = z.object({
  path: z.string(),
  /** Where a renamed or copied file came from. */
  originalPath: z.string().nullable(),
  /** What is staged for the next commit, compared with the last commit. */
  index: gitIndexChangeSchema.nullable(),
  /** What differs in the folder from what is staged. */
  worktree: gitWorktreeChangeSchema.nullable(),
  /** Both sides of a merge changed this file. Never counted as staged. */
  conflicted: z.boolean(),
  submodule: z.boolean(),
});
export type GitFileStatus = z.infer<typeof gitFileStatusSchema>;

export const gitBranchHeadSchema = z.object({
  /** Null when HEAD is detached. */
  name: z.string().nullable(),
  detached: z.boolean(),
  /** Null before the first commit. */
  oid: z.string().nullable(),
  /** Short name of the upstream branch, e.g. "origin/main". */
  upstream: z.string().nullable(),
  /** Commits here that the upstream lacks / commits there that are missing here, as of the last fetch. Null without an upstream. */
  ahead: z.number().int().nullable(),
  behind: z.number().int().nullable(),
});
export type GitBranchHead = z.infer<typeof gitBranchHeadSchema>;

export const gitStatusSchema = z.object({
  state: gitRepositoryStateSchema,
  /** A sentence explaining any state other than `ready`. */
  message: z.string().nullable(),
  branch: gitBranchHeadSchema.nullable(),
  hasCommits: z.boolean(),
  remotes: z.array(z.string()),
  /** The remote that fetch, pull and push use unless told otherwise. */
  defaultRemote: z.string().nullable(),
  /** An unfinished merge, rebase or similar that was started outside the Studio. */
  operation: z.enum(['merge', 'rebase', 'cherry-pick', 'revert', 'bisect']).nullable(),
  files: z.array(gitFileStatusSchema),
  counts: z.object({
    staged: z.number().int(),
    unstaged: z.number().int(),
    untracked: z.number().int(),
    conflicted: z.number().int(),
  }),
  /** The change list was cut because it is very long. */
  truncated: z.boolean(),
});
export type GitStatus = z.infer<typeof gitStatusSchema>;

// ---- diffs -----------------------------------------------------------------------

export const gitDiffQuerySchema = z.object({
  path: filePathSchema.min(1),
  /** `true` what is staged against the last commit; `false` the folder against what is staged. */
  staged: z.enum(['true', 'false']).default('false'),
});

export const gitFileDiffSchema = z.object({
  path: z.string(),
  /** Unified diff text; empty for binary files and when nothing differs. */
  diff: z.string(),
  binary: z.boolean(),
  /** The diff was cut at the size limit. */
  truncated: z.boolean(),
});
export type GitFileDiff = z.infer<typeof gitFileDiffSchema>;

export const gitBaselineQuerySchema = z.object({ path: filePathSchema.min(1) });

/** The last committed content of a file, for showing changes inside an editor. */
export const gitBaselineSchema = z.object({
  path: z.string(),
  /** `text` content follows; `binary` and `too_large` cannot be shown; `none` the file is not in the last commit. */
  kind: z.enum(['text', 'binary', 'too_large', 'none']),
  content: z.string().nullable(),
});
export type GitBaseline = z.infer<typeof gitBaselineSchema>;

// ---- staging and committing -------------------------------------------------------

export const gitPathsRequestSchema = z
  .object({
    paths: z.array(filePathSchema.min(1)).min(1).max(2000).optional(),
    all: z.boolean().optional(),
  })
  .refine((value) => (value.all === true) !== (value.paths !== undefined), 'Send either "paths" or "all": true.');
export type GitPathsRequest = z.infer<typeof gitPathsRequestSchema>;

export const gitPathRequestSchema = z.object({ path: filePathSchema.min(1) });

export const gitCommitRequestSchema = z.object({
  message: z.string().max(20_000),
  /** Stage these paths first. Without it, what is already staged is committed. */
  paths: z.array(filePathSchema.min(1)).min(1).max(2000).optional(),
});
export type GitCommitRequest = z.infer<typeof gitCommitRequestSchema>;

export const gitInitialCommitRequestSchema = z.object({ message: z.string().max(20_000).optional() });

export const gitCommitResultSchema = z.object({
  oid: z.string(),
  subject: z.string(),
  branch: z.string().nullable(),
});
export type GitCommitResult = z.infer<typeof gitCommitResultSchema>;

export const gitUndoCommitResultSchema = z.object({
  /** The commit that was removed; its changes are staged. */
  undone: z.string(),
  /** The commit HEAD points at now; null when the first commit was undone. */
  head: z.string().nullable(),
});

export const gitInitResultSchema = z.object({ created: z.boolean() });

// ---- commit identity ---------------------------------------------------------------

/** Preference key under which the commit identity is stored for a user. */
export const GIT_IDENTITY_PREFERENCE = 'git.identity';

export const gitIdentitySchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[^<>\n\r\0]+$/, 'A name cannot contain angle brackets or line breaks.'),
  email: z
    .string()
    .trim()
    .max(200)
    .regex(/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/, 'That does not look like an e-mail address.'),
});
export type GitIdentity = z.infer<typeof gitIdentitySchema>;

export const gitIdentityStateSchema = z.object({
  /** `user` saved by the caller; `host` what git on the server would use; `none` neither exists. */
  source: z.enum(['user', 'host', 'none']),
  name: z.string().nullable(),
  email: z.string().nullable(),
});
export type GitIdentityState = z.infer<typeof gitIdentityStateSchema>;

// ---- branches ----------------------------------------------------------------------

export const gitBranchSchema = z.object({
  /** "main" for a local branch, "origin/main" for a remote one. */
  name: z.string(),
  kind: z.enum(['local', 'remote']),
  /** For remote branches: the remote's name. */
  remote: z.string().nullable(),
  current: z.boolean(),
  oid: z.string(),
  upstream: z.string().nullable(),
  /** The upstream was deleted on the remote. */
  upstreamGone: z.boolean(),
  ahead: z.number().int().nullable(),
  behind: z.number().int().nullable(),
  subject: z.string(),
  committedAt: timestampSchema,
  /** Checked out in another worktree, which is why it cannot be switched to or deleted here. */
  checkedOutElsewhere: z.boolean(),
});
export type GitBranch = z.infer<typeof gitBranchSchema>;

export const gitBranchesSchema = z.object({
  current: z.string().nullable(),
  detached: z.boolean(),
  /** The repository's main line, as far as it can be told (the remote's default branch, else "main" or "master"). */
  defaultBranch: z.string().nullable(),
  branches: z.array(gitBranchSchema),
});
export type GitBranches = z.infer<typeof gitBranchesSchema>;

export const gitCreateBranchRequestSchema = z.object({
  name: gitRefInputSchema,
  /** Branch, tag or commit to start from. Defaults to the current commit. */
  from: gitRefInputSchema.optional(),
  switch: z.boolean().default(true),
});
export type GitCreateBranchRequest = z.infer<typeof gitCreateBranchRequestSchema>;

export const gitSwitchBranchRequestSchema = z.object({
  /** A local branch, or with `kind: "remote"` a remote branch such as "origin/topic" to continue locally. */
  branch: gitRefInputSchema,
  kind: z.enum(['local', 'remote']).default('local'),
});
export type GitSwitchBranchRequest = z.infer<typeof gitSwitchBranchRequestSchema>;

export const gitDeleteBranchRequestSchema = z.object({
  name: gitRefInputSchema,
  /** Delete even when the branch holds commits that are merged nowhere. */
  force: z.boolean().default(false),
});
export type GitDeleteBranchRequest = z.infer<typeof gitDeleteBranchRequestSchema>;

export const gitBranchResultSchema = z.object({ branch: z.string(), current: z.string().nullable() });

// ---- remote sync -------------------------------------------------------------------

const remoteNameInput = z.string().trim().min(1).max(100);

export const gitFetchRequestSchema = z.object({ remote: remoteNameInput.optional() });

export const gitPullRequestSchema = z.object({
  remote: remoteNameInput.optional(),
  /**
   * `ff-only` (default) only moves the branch forward and reports divergence.
   * `merge` creates a merge commit when the branches diverged, and only when
   * that works without conflicts.
   */
  mode: z.enum(['ff-only', 'merge']).default('ff-only'),
});
export type GitPullRequest = z.infer<typeof gitPullRequestSchema>;

export const gitPushRequestSchema = z.object({
  remote: remoteNameInput.optional(),
  /** Publish a branch that has no upstream yet, and remember where it went. */
  publish: z.boolean().default(false),
});
export type GitPushRequest = z.infer<typeof gitPushRequestSchema>;

export const gitSyncResultSchema = z.object({
  operation: z.enum(['fetch', 'pull', 'push']),
  remote: z.string(),
  branch: z.string().nullable(),
  /** What git reported, shortened and with anything secret removed. */
  summary: z.string(),
  status: gitStatusSchema,
});
export type GitSyncResult = z.infer<typeof gitSyncResultSchema>;

// ---- history -----------------------------------------------------------------------

export const gitLogQuerySchema = z.object({
  limit: limitQuery(50, 200),
  /** `nextCursor` of the previous page. */
  cursor: z
    .string()
    .regex(/^\d{1,7}$/)
    .optional(),
  /** Only the history of this branch, tag or commit. Without it: every branch, remote branch and tag. */
  ref: gitRefInputSchema.optional(),
});

export const gitRefLabelSchema = z.object({
  name: z.string(),
  kind: z.enum(['head', 'branch', 'remote', 'tag']),
});

export const gitCommitSchema = z.object({
  oid: z.string(),
  /** Enough to draw the graph: commits arrive children before parents. */
  parents: z.array(z.string()),
  refs: z.array(gitRefLabelSchema),
  authorName: z.string(),
  authorEmail: z.string(),
  authoredAt: timestampSchema,
  subject: z.string(),
});
export type GitCommit = z.infer<typeof gitCommitSchema>;

export const gitLogSchema = z.object({
  commits: z.array(gitCommitSchema),
  nextCursor: z.string().nullable(),
});
export type GitLog = z.infer<typeof gitLogSchema>;

export const gitChangeLetterSchema = z.enum(['A', 'M', 'D', 'R', 'C', 'T', 'U']);

export const gitChangedFileSchema = z.object({
  path: z.string(),
  originalPath: z.string().nullable(),
  /** A added, M modified, D deleted, R renamed, C copied, T type changed, U untracked (comparisons only). */
  status: gitChangeLetterSchema,
  /** Null for binary files. */
  additions: z.number().int().nullable(),
  deletions: z.number().int().nullable(),
});
export type GitChangedFile = z.infer<typeof gitChangedFileSchema>;

export const gitCommitDetailSchema = gitCommitSchema.extend({
  body: z.string(),
  committerName: z.string(),
  committedAt: timestampSchema,
  /** Against the first parent. */
  files: z.array(gitChangedFileSchema),
  additions: z.number().int(),
  deletions: z.number().int(),
  diff: z.string(),
  diffTruncated: z.boolean(),
});
export type GitCommitDetail = z.infer<typeof gitCommitDetailSchema>;

export const gitCompareQuerySchema = z.object({ base: gitRefInputSchema });

/** Everything that differs from the common ancestor with `base`: committed, staged, unstaged and untracked. */
export const gitComparisonSchema = z.object({
  base: z.string(),
  mergeBase: z.string(),
  files: z.array(gitChangedFileSchema),
  truncated: z.boolean(),
});
export type GitComparison = z.infer<typeof gitComparisonSchema>;

export const gitCompareDiffQuerySchema = z.object({
  base: gitRefInputSchema,
  path: filePathSchema.min(1),
  originalPath: filePathSchema.min(1).optional(),
});

// ---- worktrees ---------------------------------------------------------------------

export const gitWorktreeSchema = z.object({
  /** Absolute path of the worktree's folder. Send it back to name the worktree. */
  path: z.string(),
  branch: z.string().nullable(),
  oid: z.string().nullable(),
  /** The repository's original checkout. It can be neither removed nor merged. */
  main: z.boolean(),
  /** The worktree of the project this was asked through. */
  current: z.boolean(),
  detached: z.boolean(),
  locked: z.boolean(),
  /** Its folder is gone; git would prune it. */
  missing: z.boolean(),
  /** Changed files, or null when the folder could not be read. */
  changes: z.number().int().nullable(),
  /** Against the branch of the main checkout. */
  ahead: z.number().int().nullable(),
  behind: z.number().int().nullable(),
  subject: z.string().nullable(),
  committedAt: timestampSchema.nullable(),
  projectId: idSchema.nullable(),
  projectArchived: z.boolean(),
});
export type GitWorktree = z.infer<typeof gitWorktreeSchema>;

export const gitWorktreesSchema = z.object({
  /** The branch checked out in the main checkout: what "merge back" merges into. */
  baseBranch: z.string().nullable(),
  /** Where new worktrees are created. Null when the repository has no room next to it inside a workspace root. */
  location: z.string().nullable(),
  worktrees: z.array(gitWorktreeSchema),
});
export type GitWorktrees = z.infer<typeof gitWorktreesSchema>;

export const gitCreateWorktreeRequestSchema = z.object({
  /** An existing local branch is checked out as it is; otherwise the branch is created. */
  branch: gitRefInputSchema,
  /** Where a new branch starts. Defaults to the branch of the main checkout. */
  base: gitRefInputSchema.optional(),
});
export type GitCreateWorktreeRequest = z.infer<typeof gitCreateWorktreeRequestSchema>;

export const gitCreateWorktreeResultSchema = z.object({
  worktree: gitWorktreeSchema,
  project: projectSchema,
  branchCreated: z.boolean(),
});
export type GitCreateWorktreeResult = z.infer<typeof gitCreateWorktreeResultSchema>;

export const gitWorktreePathRequestSchema = z.object({ path: z.string().min(1).max(4096) });

export const gitRemoveWorktreeRequestSchema = z.object({
  path: z.string().min(1).max(4096),
  /** Remove even with uncommitted changes, which are lost. */
  force: z.boolean().default(false),
  deleteBranch: z.boolean().default(false),
});
export type GitRemoveWorktreeRequest = z.infer<typeof gitRemoveWorktreeRequestSchema>;

export const gitRemoveWorktreeResultSchema = z.object({
  path: z.string(),
  branch: z.string().nullable(),
  branchDeleted: z.boolean(),
  /** Why the branch was kept, when it was asked to be deleted. */
  branchNote: z.string().nullable(),
  /** The project that lived in the worktree; it is archived, never deleted. */
  project: projectSchema.nullable(),
});
export type GitRemoveWorktreeResult = z.infer<typeof gitRemoveWorktreeResultSchema>;

export const gitMergeWorktreeRequestSchema = z.object({
  path: z.string().min(1).max(4096),
  /** One commit with all the changes (default) instead of a merge commit. */
  squash: z.boolean().default(true),
  message: z.string().max(20_000).optional(),
  /** Afterwards remove the worktree and delete its branch. */
  cleanup: z.boolean().default(false),
});
export type GitMergeWorktreeRequest = z.infer<typeof gitMergeWorktreeRequestSchema>;

export const gitMergeWorktreeResultSchema = z.object({
  oid: z.string(),
  /** The branch that received the changes. */
  into: z.string(),
  branch: z.string(),
  squash: z.boolean(),
  /** The outcome of the requested clean-up; null when none was asked for. */
  cleanup: gitRemoveWorktreeResultSchema.nullable(),
  /** Why the clean-up did not happen although the merge did. */
  cleanupError: z.string().nullable(),
});
export type GitMergeWorktreeResult = z.infer<typeof gitMergeWorktreeResultSchema>;

// ---- events ------------------------------------------------------------------------

/** Published on the project's topic after the Studio changed the repository. Data: `{ projectId, reason }`. */
export const GIT_CHANGED = 'git.changed';

export const gitChangedEventSchema = z.object({ projectId: idSchema, reason: z.string() });
export type GitChangedEvent = z.infer<typeof gitChangedEventSchema>;
