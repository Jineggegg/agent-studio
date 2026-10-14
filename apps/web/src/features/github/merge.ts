import type { GithubBlocker, GithubBlockerCode, GithubCheckState, GithubChecksSummary, GithubMergeMethod, GithubMergeRequest, GithubPullDetail, GithubPullSummary, GithubPullVerdict } from '@agent-studio/protocol';
import type { MessageKey, Translator } from '@/i18n';

/**
 * What the pull-request sheet may offer, derived from what the server said
 * about the pull request — and nothing more. The server decides again, on a
 * fresh read, when a merge is actually asked for; this only makes sure that
 * the screen never shows a control the server has already ruled out.
 *
 * There is no "merge anyway". A blocker removes the merge control; a refusal
 * is shown as the server worded it, with a reload.
 */
export interface MergeGuard {
  /** A merge may be offered: the pull request is open and nothing blocks it. */
  offered: boolean;
  /** Why not, in the server's order. Each alone prevents the merge. */
  blockers: readonly GithubBlocker[];
  /** The methods the repository allows, in the server's order. */
  methods: readonly GithubMergeMethod[];
  /** Checks that are not required are failing: the person must say they have seen that. */
  needsAcknowledgement: boolean;
  /** "Delete the branch afterwards" is the person's to choose (not a fork's branch, not already automatic, not a queue). */
  mayDeleteBranch: boolean;
  /** The base branch merges through a queue: the outcome will be "queued", not "merged". */
  queued: boolean;
}

export function mergeGuard(detail: Pick<GithubPullDetail, 'state' | 'blockers' | 'mergeMethods' | 'optionalChecksFailing' | 'crossRepository' | 'deleteBranchOnMerge' | 'mergeQueue'>): MergeGuard {
  const open = detail.state === 'open';
  return {
    offered: open && detail.blockers.length === 0 && detail.mergeMethods.length > 0,
    blockers: detail.blockers,
    methods: detail.mergeMethods,
    needsAcknowledgement: detail.optionalChecksFailing,
    mayDeleteBranch: !detail.crossRepository && !detail.deleteBranchOnMerge && !detail.mergeQueue,
    queued: detail.mergeQueue,
  };
}

export interface MergeChoice {
  method: GithubMergeMethod | null;
  deleteBranch: boolean;
  /** The head commit for which failing optional checks were acknowledged; it lapses when the head moves. */
  acknowledgedHead: string | null;
}

export const acknowledged = (choice: MergeChoice, headSha: string): boolean => choice.acknowledgedHead !== null && choice.acknowledgedHead === headSha;

/** Whether the merge button may be pressed with this choice. */
export function mayMerge(guard: MergeGuard, choice: MergeChoice, headSha: string): boolean {
  if (!guard.offered || choice.method === null || !guard.methods.includes(choice.method)) return false;
  return !guard.needsAcknowledgement || acknowledged(choice, headSha);
}

/**
 * The request for a merge: the method, and the head commit the person was
 * looking at — the server refuses when the pull request has moved on since.
 */
export function mergeRequest(detail: Pick<GithubPullDetail, 'headSha' | 'optionalChecksFailing'>, guard: MergeGuard, choice: MergeChoice & { method: GithubMergeMethod }): GithubMergeRequest {
  return {
    method: choice.method,
    headSha: detail.headSha,
    deleteBranch: guard.mayDeleteBranch && choice.deleteBranch,
    acknowledgeFailingChecks: detail.optionalChecksFailing && acknowledged(choice, detail.headSha),
  };
}

export const shortSha = (sha: string | null | undefined): string => (sha ? sha.slice(0, 7) : '');

const METHOD_SENTENCE: Record<GithubMergeMethod, MessageKey> = {
  squash: 'github.merge.confirm.squash',
  merge: 'github.merge.confirm.merge',
  rebase: 'github.merge.confirm.rebase',
};

/** The last question before a merge: it names the repository, the pull request, the method and the commit, and says it cannot be undone here. */
export function mergeConfirmation(
  detail: Pick<GithubPullSummary, 'owner' | 'repo' | 'number' | 'headRef' | 'baseRef' | 'headSha'>,
  method: GithubMergeMethod,
  options: { deleteBranch: boolean; queued: boolean },
  t: Translator,
): { title: string; message: string; confirmLabel: string } {
  const repository = `${detail.owner}/${detail.repo}`;
  const parts = [
    t(METHOD_SENTENCE[method], { head: detail.headRef, base: detail.baseRef, sha: shortSha(detail.headSha) }),
    options.queued ? t('github.merge.confirm.queued') : '',
    options.deleteBranch ? t('github.merge.confirm.deleteBranch', { head: detail.headRef }) : '',
    t('github.merge.confirm.irreversible'),
  ];
  return {
    title: t('github.merge.confirm.title', { repository, number: detail.number }),
    message: parts.filter(Boolean).join(' '),
    confirmLabel: t('github.merge.confirm.action', { number: detail.number }),
  };
}

// ---- words for what the server reports ------------------------------------------------

export const blockerKey = (code: GithubBlockerCode): MessageKey => `github.blocker.${code}`;
export const verdictKey = (verdict: GithubPullVerdict): MessageKey => `github.verdict.${verdict}`;
export const methodKey = (method: GithubMergeMethod): MessageKey => `github.method.${method}`;
export const methodHintKey = (method: GithubMergeMethod): MessageKey => `github.method.${method}.hint`;

export type Tone = 'positive' | 'danger' | 'warning' | 'running' | 'neutral';

/** The colour of the chip beside a branch: red for what must be fixed, amber for what waits on someone, moving for what is in progress. */
export function verdictTone(verdict: GithubPullVerdict): Tone {
  switch (verdict) {
    case 'mergeable':
      return 'positive';
    case 'conflicts':
    case 'checks_failed':
      return 'danger';
    case 'checks_running':
    case 'checking':
      return 'running';
    case 'draft':
      return 'neutral';
    default:
      return 'warning';
  }
}

export function checkTone(state: GithubCheckState): Tone {
  return state === 'passing' ? 'positive' : state === 'failing' ? 'danger' : state === 'pending' ? 'running' : 'neutral';
}

/** "2 failing", "3 running", "All 5 passing", "No checks" — the worst news first. */
export function checksLabel(checks: GithubChecksSummary, t: Translator): string {
  if (checks.state === 'none' || checks.total === 0) return t('github.checks.none');
  if (checks.failing > 0) return t.plural('github.checks.failing', checks.failing);
  if (checks.pending > 0) return t.plural('github.checks.pending', checks.pending);
  return t.plural('github.checks.passing', checks.passing);
}

/** One word for a pull request in a list, from the facts a summary carries. */
export function summaryVerdict(pull: Pick<GithubPullSummary, 'draft' | 'mergeable' | 'checks' | 'reviewDecision' | 'mergeState'>): GithubPullVerdict {
  if (pull.draft) return 'draft';
  if (pull.mergeable === 'conflicting') return 'conflicts';
  if (pull.mergeState === 'behind') return 'behind';
  if (pull.checks.state === 'failing') return 'checks_failed';
  if (pull.checks.state === 'pending') return 'checks_running';
  if (pull.reviewDecision === 'changes_requested') return 'changes_requested';
  if (pull.reviewDecision === 'review_required') return 'review_required';
  if (pull.mergeState === 'blocked') return 'blocked';
  if (pull.mergeable === 'unknown') return 'checking';
  return 'mergeable';
}

// ---- what this device remembers --------------------------------------------------------

const METHOD_PREFIX = 'studio.github.method.';

/** The method used last in a repository, offered first the next time — when the repository still allows it. */
export function rememberedMethod(owner: string, repo: string, allowed: readonly GithubMergeMethod[], storage: Pick<Storage, 'getItem'> | null = typeof window === 'undefined' ? null : window.localStorage): GithubMergeMethod | null {
  try {
    const stored = storage?.getItem(`${METHOD_PREFIX}${owner}/${repo}`);
    if (stored && (allowed as readonly string[]).includes(stored)) return stored as GithubMergeMethod;
  } catch {
    /* nothing remembered */
  }
  return allowed[0] ?? null;
}

export function rememberMethod(owner: string, repo: string, method: GithubMergeMethod, storage: Pick<Storage, 'setItem'> | null = typeof window === 'undefined' ? null : window.localStorage): void {
  try {
    storage?.setItem(`${METHOD_PREFIX}${owner}/${repo}`, method);
  } catch {
    /* this device will not remember */
  }
}
