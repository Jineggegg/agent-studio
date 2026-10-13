import { z } from 'zod';
import { idSchema, timestampSchema } from './common.js';

/**
 * Wire contracts for the "github" feature.
 *
 * The Studio talks to GitHub only through the `gh` command-line tool that is
 * signed in on the server. It never reads, stores or returns the token, and
 * there is no sign-in from the browser. Because that login belongs to the
 * owner of the Studio, everything here except the per-project branch lookup is
 * for the owner only.
 */

// ---- names a client may send -------------------------------------------------------

export const githubOwnerSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/, 'Not a GitHub account name.');

export const githubRepoNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,100}$/, 'Not a GitHub repository name.')
  .refine((value) => value !== '.' && value !== '..', 'Not a GitHub repository name.');

/** A pull-request number in a URL: a positive integer without leading zeros. */
export const githubPullNumberParamSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,8}$/, 'Not a pull-request number.')
  .transform((value) => Number(value));

/** A full commit id, as GitHub reports it. */
export const githubShaSchema = z.string().regex(/^[0-9a-f]{40}$/, 'Not a full commit id.');

export const githubRepoParamsSchema = z.object({ owner: githubOwnerSchema, repo: githubRepoNameSchema });
export const githubPullParamsSchema = z.object({
  owner: githubOwnerSchema,
  repo: githubRepoNameSchema,
  number: githubPullNumberParamSchema,
});

/** `refresh=true` asks for a fresh read instead of a recent cached one. */
export const githubRefreshQuerySchema = z.object({ refresh: z.enum(['true', 'false']).default('false') });

// ---- failures ----------------------------------------------------------------------

export const GITHUB_ERROR_CODES = [
  'github_tool_missing',
  'github_signed_out',
  'github_expired',
  'github_forbidden',
  'github_sso_required',
  'github_rate_limited',
  'github_not_found',
  'github_unreachable',
  'github_timeout',
  'github_busy',
  'github_failed',
  'github_merge_refused',
  'github_head_moved',
  'github_method_not_allowed',
  'github_action_in_progress',
  'github_outcome_unknown',
  'github_fix_not_applicable',
] as const;
export type GithubErrorCode = (typeof GITHUB_ERROR_CODES)[number];

// ---- sign-in state -----------------------------------------------------------------

/**
 * `ready` signed in and able to write; `limited` signed in, but the login
 * lacks the permission to merge; `tool_missing` gh is not installed;
 * `signed_out` gh has no login for github.com; `expired` the stored login is
 * no longer accepted; `unreachable` GitHub could not be reached; `error`
 * anything else (see `message`).
 */
export const githubAccountStateSchema = z.enum(['ready', 'limited', 'tool_missing', 'signed_out', 'expired', 'unreachable', 'error']);
export type GithubAccountState = z.infer<typeof githubAccountStateSchema>;

export const githubAccountSchema = z.object({
  state: githubAccountStateSchema,
  /** One sentence explaining the state. */
  message: z.string(),
  /** The command to run in a terminal on the server to fix the state, when there is one. */
  command: z.string().nullable(),
  login: z.string().nullable(),
  /** Whether the login may merge. Null when the kind of login does not say. */
  canWrite: z.boolean().nullable(),
  /** Names of the permissions the login carries. Never the token. */
  scopes: z.array(z.string()),
  checkedAt: timestampSchema,
});
export type GithubAccount = z.infer<typeof githubAccountSchema>;

/** Sent with every read so that a client can say "may be out of date". */
export const githubFreshnessSchema = z.object({
  fetchedAt: timestampSchema,
  /** The data is older than it should be because the last refresh failed. */
  stale: z.boolean(),
  /** Why the refresh failed. */
  staleReason: z.string().nullable(),
});
export type GithubFreshness = z.infer<typeof githubFreshnessSchema>;

// ---- checks ------------------------------------------------------------------------

export const githubCheckStateSchema = z.enum(['none', 'passing', 'failing', 'pending']);
export type GithubCheckState = z.infer<typeof githubCheckStateSchema>;

export const githubChecksSummarySchema = z.object({
  state: githubCheckStateSchema,
  total: z.number().int(),
  passing: z.number().int(),
  failing: z.number().int(),
  pending: z.number().int(),
  skipped: z.number().int(),
});
export type GithubChecksSummary = z.infer<typeof githubChecksSummarySchema>;

export const githubCheckRunSchema = z.object({
  name: z.string(),
  workflow: z.string().nullable(),
  state: z.enum(['failing', 'pending', 'passing', 'skipped']),
  /** The branch's rules require this check before merging. */
  required: z.boolean(),
  /** Link to the log; only https addresses are passed on. */
  url: z.string().nullable(),
});
export type GithubCheckRun = z.infer<typeof githubCheckRunSchema>;

// ---- pull requests -----------------------------------------------------------------

export const githubPullReasonSchema = z.enum(['authored', 'review_requested', 'own_repository']);
export type GithubPullReason = z.infer<typeof githubPullReasonSchema>;

export const githubPullSummarySchema = z.object({
  owner: z.string(),
  repo: z.string(),
  number: z.number().int(),
  title: z.string(),
  url: z.string(),
  author: z.string().nullable(),
  draft: z.boolean(),
  headRef: z.string(),
  baseRef: z.string(),
  headSha: z.string(),
  additions: z.number().int(),
  deletions: z.number().int(),
  changedFiles: z.number().int(),
  mergeable: z.enum(['mergeable', 'conflicting', 'unknown']),
  /** GitHub's own verdict: clean, blocked, behind, dirty, draft, unstable, has_hooks, unknown. */
  mergeState: z.string(),
  reviewDecision: z.enum(['approved', 'changes_requested', 'review_required']).nullable(),
  checks: githubChecksSummarySchema,
  updatedAt: timestampSchema,
  /** Why this pull request is in the inbox. Empty outside the inbox. */
  reasons: z.array(githubPullReasonSchema),
});
export type GithubPullSummary = z.infer<typeof githubPullSummarySchema>;

export const githubInboxFilterSchema = z.enum(['all', 'review_requested', 'authored', 'own_repositories']);
export type GithubInboxFilter = z.infer<typeof githubInboxFilterSchema>;

export const githubInboxQuerySchema = z.object({
  filter: githubInboxFilterSchema.default('all'),
  refresh: z.enum(['true', 'false']).default('false'),
});

export const githubInboxSchema = z.object({
  filter: githubInboxFilterSchema,
  /** Most recently updated first. */
  pulls: z.array(githubPullSummarySchema),
  counts: z.object({
    all: z.number().int(),
    reviewRequested: z.number().int(),
    authored: z.number().int(),
    ownRepositories: z.number().int(),
  }),
  /** At least one of the three searches had more results than were read. */
  truncated: z.boolean(),
  freshness: githubFreshnessSchema,
});
export type GithubInbox = z.infer<typeof githubInboxSchema>;

// ---- repositories ------------------------------------------------------------------

export const githubRepositorySchema = z.object({
  owner: z.string(),
  name: z.string(),
  description: z.string(),
  private: z.boolean(),
  fork: z.boolean(),
  archived: z.boolean(),
  defaultBranch: z.string().nullable(),
  pushedAt: timestampSchema.nullable(),
  url: z.string(),
  language: z.string().nullable(),
  openPullRequests: z.number().int(),
  openIssues: z.number().int(),
  /** Checks of the newest commit on the default branch. */
  checks: githubCheckStateSchema,
});
export type GithubRepository = z.infer<typeof githubRepositorySchema>;

export const githubRepositoriesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  /** `nextCursor` of the previous page. */
  cursor: z
    .string()
    .regex(/^[A-Za-z0-9+/=_:-]{1,200}$/)
    .optional(),
  refresh: z.enum(['true', 'false']).default('false'),
});

export const githubRepositoriesSchema = z.object({
  /** Most recently pushed first. */
  repositories: z.array(githubRepositorySchema),
  totalCount: z.number().int(),
  nextCursor: z.string().nullable(),
  freshness: githubFreshnessSchema,
});
export type GithubRepositories = z.infer<typeof githubRepositoriesSchema>;

export const githubRepositoryPageSchema = z.object({
  repository: githubRepositorySchema,
  /** The login may push to and merge in this repository. */
  canWrite: z.boolean(),
  latestCommit: z
    .object({
      oid: z.string(),
      title: z.string(),
      author: z.string().nullable(),
      committedAt: timestampSchema,
      checks: githubChecksSummarySchema,
    })
    .nullable(),
  pulls: z.array(githubPullSummarySchema),
  pullCount: z.number().int(),
  recentMerges: z.array(
    z.object({
      number: z.number().int(),
      title: z.string(),
      url: z.string(),
      author: z.string().nullable(),
      mergedAt: timestampSchema,
    }),
  ),
  freshness: githubFreshnessSchema,
});
export type GithubRepositoryPage = z.infer<typeof githubRepositoryPageSchema>;

// ---- one pull request ----------------------------------------------------------------

export const githubMergeMethodSchema = z.enum(['merge', 'squash', 'rebase']);
export type GithubMergeMethod = z.infer<typeof githubMergeMethodSchema>;

/** Each blocker alone prevents a merge from the Studio. */
export const githubBlockerCodeSchema = z.enum([
  'incomplete',
  'not_open',
  'draft',
  'no_permission',
  'conflicts',
  'checking',
  'required_checks_failed',
  'required_checks_pending',
  'behind',
  'blocked',
  'no_merge_method',
]);
export type GithubBlockerCode = z.infer<typeof githubBlockerCodeSchema>;

export const githubBlockerSchema = z.object({ code: githubBlockerCodeSchema, message: z.string() });
export type GithubBlocker = z.infer<typeof githubBlockerSchema>;

export const githubPendingRunSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  url: z.string().nullable(),
});
export type GithubPendingRun = z.infer<typeof githubPendingRunSchema>;

export const githubPullDetailSchema = githubPullSummarySchema.extend({
  state: z.enum(['open', 'closed', 'merged']),
  /** The description as plain text, shortened. */
  body: z.string(),
  bodyTruncated: z.boolean(),
  createdAt: timestampSchema,
  /** Failing first, then pending, passing, skipped; required ones first within each. */
  checkRuns: z.array(githubCheckRunSchema),
  checkRunsTruncated: z.boolean(),
  files: z.array(
    z.object({
      path: z.string(),
      status: z.enum(['A', 'M', 'D', 'R', 'C']),
      additions: z.number().int(),
      deletions: z.number().int(),
    }),
  ),
  filesTruncated: z.boolean(),
  /** The methods the repository allows, in the order squash, merge, rebase. */
  mergeMethods: z.array(githubMergeMethodSchema),
  /** The repository deletes merged branches by itself. */
  deleteBranchOnMerge: z.boolean(),
  /** The head branch lives in a fork. */
  crossRepository: z.boolean(),
  /** The login may merge in this repository. */
  canMerge: z.boolean(),
  /** The base branch only accepts merges through a merge queue. */
  mergeQueue: z.boolean(),
  /** Empty means the pull request can be merged from here. */
  blockers: z.array(githubBlockerSchema),
  /** Checks that are not required are failing: merging needs an explicit acknowledgement. */
  optionalChecksFailing: z.boolean(),
  mergeCommit: z.string().nullable(),
  /** Workflow runs of the head commit that wait for a maintainer's approval. */
  pendingRuns: z.array(githubPendingRunSchema),
  /** Which of the small fixes apply right now. */
  fixes: z.object({ updateBranch: z.boolean(), markReady: z.boolean(), approveRuns: z.boolean() }),
  /** How soon to read again while something is still moving (checks running, mergeability being computed); null when settled. */
  pollAfterMs: z.number().int().nullable(),
  freshness: githubFreshnessSchema,
});
export type GithubPullDetail = z.infer<typeof githubPullDetailSchema>;

export const githubMergeRequestSchema = z.object({
  method: githubMergeMethodSchema,
  /** The head commit the user was looking at. A pull request whose head moved since is not merged. */
  headSha: githubShaSchema,
  deleteBranch: z.boolean().default(false),
  /** Required when checks that are not required are failing. */
  acknowledgeFailingChecks: z.boolean().default(false),
});
export type GithubMergeRequest = z.infer<typeof githubMergeRequestSchema>;

export const githubMergeResultSchema = z.object({
  outcome: z.enum(['merged', 'queued']),
  mergeCommit: z.string().nullable(),
  message: z.string(),
  /** Null when deleting the branch was not asked for. */
  branchDeleted: z.boolean().nullable(),
});
export type GithubMergeResult = z.infer<typeof githubMergeResultSchema>;

export const githubUpdateBranchRequestSchema = z.object({ headSha: githubShaSchema });

export const githubApproveRunsRequestSchema = z.object({
  runIds: z
    .array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER))
    .min(1)
    .max(20)
    .refine((ids) => new Set(ids).size === ids.length, 'Each run can be named only once.'),
});

export const githubFixResultSchema = z.object({ message: z.string(), pull: githubPullDetailSchema });
export type GithubFixResult = z.infer<typeof githubFixResultSchema>;

// ---- the record of what was attempted ----------------------------------------------------

export const githubActionSchema = z.enum(['merge', 'update_branch', 'mark_ready', 'approve_runs']);
export type GithubAction = z.infer<typeof githubActionSchema>;

/**
 * `started` the attempt was recorded and has no outcome yet; `unknown` the
 * call timed out, so the action may or may not have happened.
 */
export const githubActionOutcomeSchema = z.enum(['started', 'merged', 'queued', 'done', 'refused', 'failed', 'unknown', 'invalid']);
export type GithubActionOutcome = z.infer<typeof githubActionOutcomeSchema>;

export const githubActionLogEntrySchema = z.object({
  id: z.string(),
  at: timestampSchema,
  action: githubActionSchema,
  owner: z.string(),
  repo: z.string(),
  number: z.number().int().nullable(),
  method: githubMergeMethodSchema.nullable(),
  headSha: z.string().nullable(),
  outcome: githubActionOutcomeSchema,
  message: z.string(),
});
export type GithubActionLogEntry = z.infer<typeof githubActionLogEntrySchema>;

export const githubActionLogQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  /** Only merges, or every recorded action. */
  action: z.enum(['merge', 'all']).default('merge'),
});

export const githubActionLogSchema = z.object({ entries: z.array(githubActionLogEntrySchema) });
export type GithubActionLog = z.infer<typeof githubActionLogSchema>;

// ---- the pull request of a project's branch ----------------------------------------------

/** One word for the chip next to a branch, worst news first. */
export const githubPullVerdictSchema = z.enum([
  'draft',
  'conflicts',
  'behind',
  'awaiting_approval',
  'checks_failed',
  'checks_running',
  'changes_requested',
  'review_required',
  'blocked',
  'checking',
  'mergeable',
]);
export type GithubPullVerdict = z.infer<typeof githubPullVerdictSchema>;

export const githubBranchPullSchema = z.object({
  /**
   * `found` there is an open pull request; every other value means "show
   * nothing": `none` no open pull request; `owner_only` the caller is not the
   * owner; `not_a_repository`, `detached`, `no_remote`, `not_github` the
   * folder does not qualify; `unavailable` GitHub cannot be asked right now.
   */
  result: z.enum(['found', 'none', 'owner_only', 'not_a_repository', 'detached', 'no_remote', 'not_github', 'unavailable']),
  owner: z.string().nullable(),
  repo: z.string().nullable(),
  branch: z.string().nullable(),
  pull: githubPullSummarySchema.nullable(),
  verdict: githubPullVerdictSchema.nullable(),
  freshness: githubFreshnessSchema.nullable(),
});
export type GithubBranchPull = z.infer<typeof githubBranchPullSchema>;

// ---- CI runs -----------------------------------------------------------------------------

export const githubWorkflowRunSchema = z.object({
  id: z.number().int(),
  repository: z.string(),
  title: z.string(),
  workflow: z.string(),
  status: z.enum(['running', 'queued', 'waiting', 'completed']),
  /** success, failure, cancelled, skipped, …; null until completed. */
  conclusion: z.string().nullable(),
  branch: z.string().nullable(),
  event: z.string(),
  url: z.string().nullable(),
  startedAt: timestampSchema.nullable(),
  updatedAt: timestampSchema.nullable(),
});
export type GithubWorkflowRun = z.infer<typeof githubWorkflowRunSchema>;

export const githubCiSchema = z.object({
  /** Running first, then queued and waiting, then the newest finished. */
  runs: z.array(githubWorkflowRunSchema),
  counts: z.object({ running: z.number().int(), queued: z.number().int(), waiting: z.number().int() }),
  /** The repositories that were looked at: the account's own, pushed recently. */
  repositories: z.array(z.string()),
  /** Repositories whose runs could not be read. */
  problems: z.array(z.object({ repository: z.string(), message: z.string() })),
  freshness: githubFreshnessSchema,
});
export type GithubCi = z.infer<typeof githubCiSchema>;

/** Published on the owner's user topic after a merge or fix, so open lists reload. Data: `{ owner, repo, number }`. */
export const GITHUB_CHANGED = 'github.changed';

export const githubChangedEventSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  number: z.number().int().nullable(),
  projectId: idSchema.nullable().optional(),
});
