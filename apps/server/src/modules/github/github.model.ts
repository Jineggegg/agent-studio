import type {
  GithubBlocker,
  GithubCheckRun,
  GithubChecksSummary,
  GithubCheckState,
  GithubMergeMethod,
  GithubPullReason,
  GithubPullSummary,
  GithubPullVerdict,
  GithubRepository,
} from '@agent-studio/protocol';

/**
 * Turning what GitHub's GraphQL API says into what the Studio shows, and —
 * the part that matters most — deciding whether a pull request may be merged
 * from here. Everything in this file is a pure function of GitHub's answer.
 */

// ---- the shapes asked for ------------------------------------------------------------

export const CHECK_CONTEXT_FIELDS = `
  __typename
  ... on CheckRun { name status conclusion detailsUrl isRequired(pullRequestNumber: $number) checkSuite { workflowRun { workflow { name } } } }
  ... on StatusContext { context state targetUrl isRequired(pullRequestNumber: $number) }
`;

/** Check contexts without the "required" flag, for lists where no single pull-request number applies. */
export const CHECK_CONTEXT_FIELDS_BRIEF = `
  __typename
  ... on CheckRun { name status conclusion }
  ... on StatusContext { context state }
`;

export const PULL_SUMMARY_FIELDS = `
  id number title url isDraft state
  author { login }
  headRefName baseRefName headRefOid
  additions deletions changedFiles
  mergeable mergeStateStatus reviewDecision
  updatedAt createdAt isCrossRepository
  repository { name owner { login } }
`;

export const REPOSITORY_FIELDS = `
  name owner { login } description isPrivate isFork isArchived url pushedAt viewerPermission
  primaryLanguage { name }
  pullRequests(states: OPEN) { totalCount }
  issues(states: OPEN) { totalCount }
`;

export interface RawContext {
  __typename?: string;
  name?: string | null;
  status?: string | null;
  conclusion?: string | null;
  detailsUrl?: string | null;
  context?: string | null;
  state?: string | null;
  targetUrl?: string | null;
  isRequired?: boolean | null;
  checkSuite?: { workflowRun?: { workflow?: { name?: string | null } | null } | null } | null;
}

export interface RawRollup {
  state?: string | null;
  contexts?: { totalCount?: number | null; pageInfo?: { hasNextPage?: boolean | null } | null; nodes?: Array<RawContext | null> | null } | null;
}

export interface RawPull {
  id?: string | null;
  number?: number | null;
  title?: string | null;
  url?: string | null;
  isDraft?: boolean | null;
  state?: string | null;
  author?: { login?: string | null } | null;
  headRefName?: string | null;
  baseRefName?: string | null;
  headRefOid?: string | null;
  additions?: number | null;
  deletions?: number | null;
  changedFiles?: number | null;
  mergeable?: string | null;
  mergeStateStatus?: string | null;
  reviewDecision?: string | null;
  updatedAt?: string | null;
  createdAt?: string | null;
  isCrossRepository?: boolean | null;
  repository?: { name?: string | null; owner?: { login?: string | null } | null } | null;
  commits?: { nodes?: Array<{ commit?: { oid?: string | null; statusCheckRollup?: RawRollup | null } | null } | null> | null } | null;
}

export interface RawRepository {
  name?: string | null;
  owner?: { login?: string | null } | null;
  description?: string | null;
  isPrivate?: boolean | null;
  isFork?: boolean | null;
  isArchived?: boolean | null;
  url?: string | null;
  pushedAt?: string | null;
  viewerPermission?: string | null;
  primaryLanguage?: { name?: string | null } | null;
  pullRequests?: { totalCount?: number | null } | null;
  issues?: { totalCount?: number | null } | null;
  defaultBranchRef?: { name?: string | null; target?: { oid?: string | null; messageHeadline?: string | null; committedDate?: string | null; author?: { name?: string | null; user?: { login?: string | null } | null } | null; statusCheckRollup?: RawRollup | null } | null } | null;
}

// ---- small conversions -----------------------------------------------------------------

export const time = (value: string | null | undefined): number => {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
};

const text = (value: string | null | undefined, max: number): string => {
  // eslint-disable-next-line no-control-regex
  const cleaned = (value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
};

/** Only https links are passed on to a browser. */
export const httpsOnly = (value: string | null | undefined): string | null => (typeof value === 'string' && /^https:\/\/[^\s]+$/.test(value) ? value : null);

/** Cuts a description at a sentence or line end near the limit. */
export function shortenBody(body: string | null | undefined, max = 1600): { body: string; truncated: boolean } {
  const whole = text(body, Number.MAX_SAFE_INTEGER).trim();
  if (whole.length <= max) return { body: whole, truncated: false };
  const slice = whole.slice(0, max);
  const cut = Math.max(slice.lastIndexOf('\n'), slice.lastIndexOf('. ') + 1);
  return { body: (cut > max * 0.6 ? slice.slice(0, cut) : slice).trimEnd(), truncated: true };
}

// ---- checks ----------------------------------------------------------------------------

type RunState = GithubCheckRun['state'];

function contextState(context: RawContext): RunState {
  if (context.__typename === 'StatusContext') {
    switch (context.state) {
      case 'SUCCESS':
        return 'passing';
      case 'FAILURE':
      case 'ERROR':
        return 'failing';
      default:
        return 'pending'; // EXPECTED, PENDING
    }
  }
  if (context.status !== 'COMPLETED') return 'pending';
  switch (context.conclusion) {
    case 'SUCCESS':
      return 'passing';
    case 'NEUTRAL':
    case 'SKIPPED':
      return 'skipped';
    case 'FAILURE':
    case 'CANCELLED':
    case 'TIMED_OUT':
    case 'ACTION_REQUIRED':
    case 'STARTUP_FAILURE':
    case 'STALE':
      return 'failing';
    default:
      return 'pending';
  }
}

const ORDER: Record<RunState, number> = { failing: 0, pending: 1, passing: 2, skipped: 3 };

export function checkRuns(rollup: RawRollup | null | undefined): { runs: GithubCheckRun[]; truncated: boolean } {
  const nodes = (rollup?.contexts?.nodes ?? []).filter((node): node is RawContext => node !== null);
  const runs = nodes.map(
    (node): GithubCheckRun => ({
      name: text(node.__typename === 'StatusContext' ? node.context : node.name, 120) || 'check',
      workflow: node.checkSuite?.workflowRun?.workflow?.name ? text(node.checkSuite.workflowRun.workflow.name, 120) : null,
      state: contextState(node),
      required: node.isRequired === true,
      url: httpsOnly(node.__typename === 'StatusContext' ? node.targetUrl : node.detailsUrl),
    }),
  );
  runs.sort((a, b) => ORDER[a.state] - ORDER[b.state] || Number(b.required) - Number(a.required) || a.name.localeCompare(b.name));
  return { runs, truncated: rollup?.contexts?.pageInfo?.hasNextPage === true };
}

export function summariseChecks(rollup: RawRollup | null | undefined): GithubChecksSummary {
  const { runs } = checkRuns(rollup);
  const summary: GithubChecksSummary = { state: 'none', total: runs.length, passing: 0, failing: 0, pending: 0, skipped: 0 };
  for (const run of runs) summary[run.state] += 1;
  summary.state = rollupState(rollup, summary);
  return summary;
}

function rollupState(rollup: RawRollup | null | undefined, counts: { total: number; failing: number; pending: number }): GithubCheckState {
  if (counts.failing > 0) return 'failing';
  if (counts.pending > 0) return 'pending';
  if (counts.total > 0) return 'passing';
  // No individual contexts were read: fall back to GitHub's own roll-up.
  switch (rollup?.state) {
    case 'SUCCESS':
      return 'passing';
    case 'FAILURE':
    case 'ERROR':
      return 'failing';
    case 'PENDING':
    case 'EXPECTED':
      return 'pending';
    default:
      return 'none';
  }
}

export const checkStateOf = (rollup: RawRollup | null | undefined): GithubCheckState => summariseChecks(rollup).state;

// ---- pull requests and repositories -------------------------------------------------------

export function toPullSummary(raw: RawPull, reasons: GithubPullReason[] = []): GithubPullSummary | null {
  const owner = raw.repository?.owner?.login;
  const repo = raw.repository?.name;
  if (!owner || !repo || typeof raw.number !== 'number' || !raw.headRefOid) return null;
  const mergeable = raw.mergeable === 'MERGEABLE' ? 'mergeable' : raw.mergeable === 'CONFLICTING' ? 'conflicting' : 'unknown';
  const review = raw.reviewDecision === 'APPROVED' ? 'approved' : raw.reviewDecision === 'CHANGES_REQUESTED' ? 'changes_requested' : raw.reviewDecision === 'REVIEW_REQUIRED' ? 'review_required' : null;
  return {
    owner,
    repo,
    number: raw.number,
    title: text(raw.title, 300),
    url: httpsOnly(raw.url) ?? `https://github.com/${owner}/${repo}/pull/${raw.number}`,
    author: raw.author?.login ?? null,
    draft: raw.isDraft === true,
    headRef: text(raw.headRefName, 250),
    baseRef: text(raw.baseRefName, 250),
    headSha: raw.headRefOid,
    additions: raw.additions ?? 0,
    deletions: raw.deletions ?? 0,
    changedFiles: raw.changedFiles ?? 0,
    mergeable,
    mergeState: (raw.mergeStateStatus ?? 'UNKNOWN').toLowerCase(),
    reviewDecision: review,
    checks: summariseChecks(raw.commits?.nodes?.[0]?.commit?.statusCheckRollup),
    updatedAt: time(raw.updatedAt),
    reasons,
  };
}

export function toRepository(raw: RawRepository): GithubRepository | null {
  const owner = raw.owner?.login;
  if (!owner || !raw.name) return null;
  return {
    owner,
    name: raw.name,
    description: text(raw.description, 300),
    private: raw.isPrivate === true,
    fork: raw.isFork === true,
    archived: raw.isArchived === true,
    defaultBranch: raw.defaultBranchRef?.name ?? null,
    pushedAt: raw.pushedAt ? time(raw.pushedAt) : null,
    url: httpsOnly(raw.url) ?? `https://github.com/${owner}/${raw.name}`,
    language: raw.primaryLanguage?.name ?? null,
    openPullRequests: raw.pullRequests?.totalCount ?? 0,
    openIssues: raw.issues?.totalCount ?? 0,
    checks: checkStateOf(raw.defaultBranchRef?.target?.statusCheckRollup),
  };
}

export const canWriteWith = (permission: string | null | undefined): boolean => permission === 'ADMIN' || permission === 'MAINTAIN' || permission === 'WRITE';

// ---- may it be merged? ---------------------------------------------------------------------

export interface MergeFacts {
  /** The answer from GitHub was incomplete (errors alongside data, or more checks than were read). */
  readonly incomplete: boolean;
  readonly state: 'open' | 'closed' | 'merged';
  readonly draft: boolean;
  readonly canMerge: boolean;
  readonly mergeable: GithubPullSummary['mergeable'];
  readonly mergeState: string;
  readonly checkRuns: readonly GithubCheckRun[];
  readonly mergeQueue: boolean;
  readonly mergeMethods: readonly GithubMergeMethod[];
}

const SENTENCES: Record<GithubBlocker['code'], string> = {
  incomplete: 'GitHub did not send complete information about this pull request, so it is not merged from here. Reload and try again.',
  not_open: 'This pull request is not open.',
  draft: 'This pull request is still a draft.',
  no_permission: "The server's GitHub login is not allowed to merge in this repository.",
  conflicts: 'This pull request has conflicts with its base branch.',
  checking: 'GitHub is still working out whether this pull request can be merged.',
  required_checks_failed: 'A required check has failed.',
  required_checks_pending: 'A required check has not finished yet.',
  behind: 'The branch is behind its base and must be updated first.',
  blocked: "The repository's rules do not allow merging this yet (for example a required review is missing).",
  no_merge_method: 'The repository allows none of the merge methods.',
};

/**
 * Everything that stands between a pull request and a merge from the Studio,
 * most fundamental first. An empty list is the only thing that lets a merge
 * through — there is no override, and a repository rule that GitHub would let
 * an administrator ignore is a blocker here all the same.
 */
export function blockersOf(facts: MergeFacts): GithubBlocker[] {
  const blockers: GithubBlocker[] = [];
  const add = (code: GithubBlocker['code']) => blockers.push({ code, message: SENTENCES[code] });

  if (facts.incomplete) add('incomplete');
  if (facts.state !== 'open') {
    add('not_open');
    return blockers;
  }
  if (facts.draft || facts.mergeState === 'draft') add('draft');
  if (!facts.canMerge) add('no_permission');
  if (facts.mergeable === 'conflicting' || facts.mergeState === 'dirty') add('conflicts');
  else if (facts.mergeable === 'unknown' || facts.mergeState === 'unknown') add('checking');

  const required = facts.checkRuns.filter((run) => run.required);
  const requiredFailed = required.some((run) => run.state === 'failing');
  const requiredPending = required.some((run) => run.state === 'pending');
  if (requiredFailed) add('required_checks_failed');
  if (requiredPending) add('required_checks_pending');

  // A merge queue brings the branch up to date and re-runs the rules itself.
  if (!facts.mergeQueue) {
    if (facts.mergeState === 'behind') add('behind');
    if (facts.mergeState === 'blocked' && !requiredFailed && !requiredPending) add('blocked');
  }
  if (facts.mergeMethods.length === 0 && !facts.mergeQueue) add('no_merge_method');
  return blockers;
}

/** Whether checks that are not required are failing, which a merge must acknowledge explicitly. */
export const optionalChecksFailing = (runs: readonly GithubCheckRun[]): boolean => runs.some((run) => !run.required && run.state === 'failing');

/** One word for the chip next to a branch, worst news first. */
export function verdictOf(pull: GithubPullSummary, pendingRuns = 0): GithubPullVerdict {
  if (pull.draft) return 'draft';
  if (pull.mergeable === 'conflicting' || pull.mergeState === 'dirty') return 'conflicts';
  if (pull.mergeState === 'behind') return 'behind';
  if (pendingRuns > 0) return 'awaiting_approval';
  if (pull.checks.state === 'failing') return 'checks_failed';
  if (pull.checks.state === 'pending') return 'checks_running';
  if (pull.reviewDecision === 'changes_requested') return 'changes_requested';
  if (pull.reviewDecision === 'review_required') return 'review_required';
  if (pull.mergeState === 'blocked') return 'blocked';
  if (pull.mergeable === 'unknown' || pull.mergeState === 'unknown') return 'checking';
  return 'mergeable';
}

export function changeLetter(changeType: string | null | undefined): 'A' | 'M' | 'D' | 'R' | 'C' {
  switch (changeType) {
    case 'ADDED':
      return 'A';
    case 'DELETED':
      return 'D';
    case 'RENAMED':
      return 'R';
    case 'COPIED':
      return 'C';
    default:
      return 'M';
  }
}
