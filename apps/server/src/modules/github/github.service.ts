import {
  GITHUB_CHANGED,
  githubApproveRunsRequestSchema,
  githubMergeRequestSchema,
  githubPullParamsSchema,
  githubUpdateBranchRequestSchema,
  type GithubAccount,
  type GithubAction,
  type GithubActionLog,
  type GithubActionLogEntry,
  type GithubActionOutcome,
  type GithubBranchPull,
  type GithubCi,
  type GithubFixResult,
  type GithubFreshness,
  type GithubInbox,
  type GithubInboxFilter,
  type GithubMergeMethod,
  type GithubMergeResult,
  type GithubPendingRun,
  type GithubPullDetail,
  type GithubPullReason,
  type GithubPullSummary,
  type GithubRepositories,
  type GithubRepository,
  type GithubRepositoryPage,
  type GithubWorkflowRun,
} from '@agent-studio/protocol';
import { z } from 'zod';
import { newId } from '../../kernel/crypto.js';
import { StudioError, badRequest, describeError, isStudioError, unavailable } from '../../kernel/errors.js';
import type { ModuleContext, Services } from '../../kernel/module.js';
import type { Principal } from '../../kernel/principal.js';
import { githubRepositoryOf, refProblem } from '../git/git.refs.js';
import { GITHUB_HOST, GhRunner, cleanToolText, githubError, type GhResponse } from './gh.runner.js';
import {
  CHECK_CONTEXT_FIELDS,
  CHECK_CONTEXT_FIELDS_BRIEF,
  PULL_SUMMARY_FIELDS,
  REPOSITORY_FIELDS,
  blockersOf,
  canWriteWith,
  changeLetter,
  checkRuns,
  httpsOnly,
  optionalChecksFailing,
  shortenBody,
  summariseChecks,
  time,
  toPullSummary,
  toRepository,
  verdictOf,
  type RawPull,
  type RawRepository,
} from './github.model.js';

type PullDetail = Omit<GithubPullDetail, 'freshness'>;

interface Actor {
  readonly userId: string;
  readonly address: string | null;
}

interface Target {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}

const TTL = { account: 60_000, lists: 45_000, branch: 30_000, ci: 30_000, ciRepositories: 10 * 60_000, mergeQueue: 10 * 60_000 } as const;
/** A forced refresh this soon after the last read reuses it: several widgets refreshing at once make one call. */
const REFRESH_FLOOR_MS = 5000;
/** How long data may be served, marked stale, while GitHub cannot be reached. */
const STALE_LIMIT_MS = 60 * 60_000;
/** GitHub's search keeps listing a merged pull request as open for a while; hide it ourselves meanwhile. */
const HIDE_MERGED_MS = 5 * 60_000;
const MAX_CACHE_ENTRIES = 500;
const TRANSIENT = new Set(['github_unreachable', 'github_timeout', 'github_busy', 'github_rate_limited', 'github_failed']);

const COMMANDS = {
  signIn: `gh auth login --hostname ${GITHUB_HOST} --git-protocol https --web`,
  refresh: `gh auth refresh --hostname ${GITHUB_HOST} --scopes repo`,
} as const;

const AUDIT_ACTIONS: Record<GithubAction, string> = {
  merge: 'github.merge',
  update_branch: 'github.update-branch',
  mark_ready: 'github.mark-ready',
  approve_runs: 'github.approve-runs',
};

const INBOX_QUERY = `
query($authored: String!, $review: String!, $own: String!, $first: Int!) {
  authored: search(query: $authored, type: ISSUE, first: $first) { issueCount nodes { ...Row } }
  review: search(query: $review, type: ISSUE, first: $first) { issueCount nodes { ...Row } }
  own: search(query: $own, type: ISSUE, first: $first) { issueCount nodes { ...Row } }
}
fragment Row on PullRequest {
  ${PULL_SUMMARY_FIELDS}
  commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 40) { nodes { ${CHECK_CONTEXT_FIELDS_BRIEF} } } } } } }
}`;

const REPOSITORIES_QUERY = `
query($first: Int!, $after: String) {
  viewer {
    repositories(first: $first, after: $after, ownerAffiliations: OWNER, orderBy: { field: PUSHED_AT, direction: DESC }) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes { ${REPOSITORY_FIELDS} defaultBranchRef { name target { ... on Commit { statusCheckRollup { state } } } } }
    }
  }
}`;

const REPOSITORY_QUERY = `
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    ${REPOSITORY_FIELDS}
    defaultBranchRef { name target { ... on Commit { oid messageHeadline committedDate author { name user { login } } statusCheckRollup { state contexts(first: 60) { nodes { ${CHECK_CONTEXT_FIELDS_BRIEF} } } } } } }
    open: pullRequests(states: OPEN, first: 30, orderBy: { field: UPDATED_AT, direction: DESC }) {
      totalCount
      nodes { ${PULL_SUMMARY_FIELDS} commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 40) { nodes { ${CHECK_CONTEXT_FIELDS_BRIEF} } } } } } } }
    }
    merged: pullRequests(states: MERGED, first: 6, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { number title url mergedAt author { login } } }
  }
}`;

const PULL_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    viewerPermission mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed deleteBranchOnMerge
    pullRequest(number: $number) {
      ${PULL_SUMMARY_FIELDS}
      bodyText mergeCommit { oid }
      files(first: 100) { totalCount nodes { path additions deletions changeType } }
      commits(last: 1) { nodes { commit { oid statusCheckRollup { state contexts(first: 100) { totalCount pageInfo { hasNextPage } nodes { ${CHECK_CONTEXT_FIELDS} } } } } } }
    }
  }
}`;

const MERGE_QUEUE_QUERY = `
query($owner: String!, $name: String!, $branch: String!) {
  repository(owner: $owner, name: $name) { mergeQueue(branch: $branch) { id } }
}`;

const BRANCH_PULLS_QUERY = `
query($owner: String!, $name: String!, $branch: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(headRefName: $branch, states: OPEN, first: 10, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes { ${PULL_SUMMARY_FIELDS} commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 40) { nodes { ${CHECK_CONTEXT_FIELDS_BRIEF} } } } } } } }
    }
  }
}`;

const ENQUEUE_MUTATION = `
mutation($id: ID!, $head: GitObjectID!) {
  enqueuePullRequest(input: { pullRequestId: $id, expectedHeadOid: $head }) { mergeQueueEntry { id } }
}`;

const READY_MUTATION = `
mutation($id: ID!) {
  markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } }
}`;

interface RawRepositoryPage extends RawRepository {
  open?: { totalCount?: number | null; nodes?: Array<RawPull | null> | null } | null;
  merged?: { nodes?: Array<{ number?: number | null; title?: string | null; url?: string | null; mergedAt?: string | null; author?: { login?: string | null } | null } | null> | null } | null;
}

interface RawPullDetail extends RawPull {
  bodyText?: string | null;
  mergeCommit?: { oid?: string | null } | null;
  files?: { totalCount?: number | null; nodes?: Array<{ path?: string | null; additions?: number | null; deletions?: number | null; changeType?: string | null } | null> | null } | null;
}

interface RawWorkflowRun {
  id?: number;
  name?: string | null;
  display_title?: string | null;
  status?: string | null;
  conclusion?: string | null;
  head_branch?: string | null;
  event?: string | null;
  html_url?: string | null;
  run_started_at?: string | null;
  updated_at?: string | null;
}

const short = (sha: string): string => sha.slice(0, 7);

/** For actions that take no parameters: whatever was sent is ignored. */
const githubEmptySchema = z.object({});

/**
 * GitHub, through the `gh` login of the server.
 *
 * Reads are cached briefly per user, shared between identical concurrent
 * requests, and served stale — and marked so — when GitHub cannot be reached.
 * Writes are few and guarded: each is recorded before it runs, decided on a
 * fresh and complete read, serialised per pull request, and recorded again
 * with its outcome.
 */
export class GithubService {
  readonly gh: GhRunner;
  /** A forced refresh this soon after the last read reuses it. Operators (and tests) may change it. */
  readonly tuning = { refreshFloorMs: REFRESH_FLOOR_MS };
  readonly #context: ModuleContext;
  readonly #cache = new Map<string, { at: number; value: unknown }>();
  readonly #loading = new Map<string, Promise<unknown>>();
  readonly #busy = new Set<string>();
  readonly #hidden = new Map<string, number>();

  constructor(context: ModuleContext) {
    this.#context = context;
    this.gh = new GhRunner(context.processes);
  }

  // ---- caching ---------------------------------------------------------------------

  async #cached<T>(key: string, ttlMs: number, refresh: boolean, load: () => Promise<T>): Promise<{ value: T; freshness: GithubFreshness }> {
    const entry = this.#cache.get(key) as { at: number; value: T } | undefined;
    const age = entry ? Date.now() - entry.at : Infinity;
    if (entry && age < (refresh ? Math.min(this.tuning.refreshFloorMs, ttlMs) : ttlMs)) {
      return { value: entry.value, freshness: { fetchedAt: entry.at, stale: false, staleReason: null } };
    }
    let running = this.#loading.get(key) as Promise<T> | undefined;
    if (!running) {
      running = load().finally(() => this.#loading.delete(key));
      this.#loading.set(key, running);
    }
    try {
      const value = await running;
      const at = Date.now();
      if (this.#cache.size >= MAX_CACHE_ENTRIES) this.#cache.delete(this.#cache.keys().next().value!);
      this.#cache.set(key, { at, value });
      return { value, freshness: { fetchedAt: at, stale: false, staleReason: null } };
    } catch (error) {
      // GitHub being unreachable is no reason to blank a screen that was fine a minute ago.
      if (entry && age < STALE_LIMIT_MS && isStudioError(error) && TRANSIENT.has(error.code)) {
        return { value: entry.value, freshness: { fetchedAt: entry.at, stale: true, staleReason: error.message } };
      }
      throw error;
    }
  }

  #forget(userId: string, target?: Target): void {
    for (const key of [...this.#cache.keys()]) {
      if (!key.startsWith(`${userId} `)) continue;
      const kind = key.slice(userId.length + 1).split(' ')[0];
      if (kind === 'inbox' || kind === 'repositories' || kind === 'branch' || kind === 'ci') this.#cache.delete(key);
      else if (target && (key.endsWith(` ${target.owner}/${target.repo}`) || key.endsWith(` ${target.owner}/${target.repo}#${target.number}`))) this.#cache.delete(key);
    }
  }

  #isHidden(pull: { owner: string; repo: string; number: number }): boolean {
    const key = `${pull.owner}/${pull.repo}#${pull.number}`.toLowerCase();
    const until = this.#hidden.get(key);
    if (until === undefined) return false;
    if (until < Date.now()) {
      this.#hidden.delete(key);
      return false;
    }
    return true;
  }

  // ---- sign-in state -----------------------------------------------------------------

  async #readAccount(): Promise<GithubAccount> {
    const now = Date.now();
    const state = (account: Omit<GithubAccount, 'checkedAt'>): GithubAccount => ({ ...account, checkedAt: now });
    const signedOut = state({ state: 'signed_out', message: 'The server is not signed in to GitHub. Sign in from a terminal on the server.', command: COMMANDS.signIn, login: null, canWrite: null, scopes: [] });
    const fromScopes = (login: string | null, raw: string): GithubAccount => {
      const scopes = raw
        .split(',')
        .map((scope) => scope.trim())
        .filter((scope) => /^[a-z_:.-]{1,40}$/i.test(scope));
      // A classic token says what it may do. Other kinds of login do not, and each repository then speaks for itself.
      const canWrite = scopes.length === 0 ? null : scopes.includes('repo');
      if (canWrite === false) {
        return state({
          state: 'limited',
          message: 'The server is signed in to GitHub, but its login lacks the "repo" permission, so it can read and not merge.',
          command: COMMANDS.refresh,
          login,
          canWrite,
          scopes,
        });
      }
      return state({ state: 'ready', message: login ? `Signed in to GitHub as ${login}.` : 'Signed in to GitHub.', command: null, login, canWrite, scopes });
    };
    const broken = (text: string, login: string | null): GithubAccount => {
      if (/timeout|timed out|dial tcp|no such host|connection|network|unreachable|tls/i.test(text)) {
        return state({ state: 'unreachable', message: 'The server cannot reach GitHub right now.', command: null, login, canWrite: null, scopes: [] });
      }
      if (/401|bad credentials|invalid|expired|revoked|no longer valid/i.test(text)) {
        return state({ state: 'expired', message: "The server's GitHub login is no longer accepted. Sign in again from a terminal on the server.", command: COMMANDS.signIn, login, canWrite: null, scopes: [] });
      }
      return state({ state: 'error', message: `The GitHub sign-in could not be checked: ${cleanToolText(text) || 'unknown problem'}`, command: null, login, canWrite: null, scopes: [] });
    };

    let result;
    try {
      // "--json hosts" prints the account, its permissions and whether it works. The token is never asked for.
      result = await this.gh.run(['auth', 'status', '--hostname', GITHUB_HOST, '--active', '--json', 'hosts'], { timeoutMs: this.gh.timeouts.read });
    } catch (error) {
      if (isStudioError(error) && error.code === 'github_tool_missing') {
        return state({ state: 'tool_missing', message: 'The GitHub command-line tool (gh) is not installed on the server. Install it from https://cli.github.com, then sign in.', command: COMMANDS.signIn, login: null, canWrite: null, scopes: [] });
      }
      throw error;
    }
    if (result.timedOut) return broken('timed out', null);

    let hosts: unknown;
    try {
      hosts = (JSON.parse(result.stdout) as { hosts?: unknown }).hosts;
    } catch {
      hosts = undefined;
    }
    if (hosts !== undefined && typeof hosts === 'object' && hosts !== null) {
      const accounts = (hosts as Record<string, unknown>)[GITHUB_HOST];
      const list = Array.isArray(accounts) ? (accounts as Array<Record<string, unknown>>) : [];
      const account = list.find((entry) => entry.active === true) ?? list[0];
      if (!account) return signedOut;
      const login = typeof account.login === 'string' && /^[A-Za-z0-9-]{1,39}$/.test(account.login) ? account.login : null;
      // Only these fields are ever read; where gh keeps the login is deliberately not among them.
      if (account.state === 'success') return fromScopes(login, typeof account.scopes === 'string' ? account.scopes : '');
      return broken(`${typeof account.error === 'string' ? account.error : ''} ${typeof account.state === 'string' ? account.state : ''}`, login);
    }

    // An older gh without "--json": ask the API who we are and read the permission header.
    if (/unknown flag|unknown shorthand/i.test(result.stderr)) {
      try {
        const response = await this.gh.api('user');
        const login = (response.body as { login?: unknown } | null)?.login;
        return fromScopes(typeof login === 'string' ? login : null, response.headers['x-oauth-scopes'] ?? '');
      } catch (error) {
        if (!isStudioError(error)) throw error;
        if (error.code === 'github_signed_out') return signedOut;
        if (error.code === 'github_expired') return broken('bad credentials', null);
        if (error.code === 'github_unreachable' || error.code === 'github_timeout') return broken('network', null);
        return broken(error.message, null);
      }
    }
    if (/not logged in|gh auth login|no oauth token/i.test(`${result.stderr} ${result.stdout}`)) return signedOut;
    return broken(result.stderr || result.stdout, null);
  }

  /** Whether, and as whom, the server can use GitHub. Never contains the token or where it is kept. */
  async account(userId: string, refresh: boolean): Promise<GithubAccount> {
    return (await this.#cached(`${userId} account`, TTL.account, refresh, () => this.#readAccount())).value;
  }

  // ---- lists -------------------------------------------------------------------------

  async inbox(userId: string, filter: GithubInboxFilter, refresh: boolean): Promise<GithubInbox> {
    const base = 'is:pr is:open archived:false sort:updated-desc';
    const { value, freshness } = await this.#cached(`${userId} inbox`, TTL.lists, refresh, async () => {
      type Search = { issueCount?: number | null; nodes?: Array<RawPull | null> | null } | null;
      const { data } = await this.gh.graphql<{ authored: Search; review: Search; own: Search }>(INBOX_QUERY, {
        authored: `${base} author:@me`,
        review: `${base} review-requested:@me`,
        own: `${base} user:@me`,
        first: 50,
      });
      const merged = new Map<string, GithubPullSummary>();
      let truncated = false;
      const take = (search: Search, reason: GithubPullReason) => {
        const nodes = (search?.nodes ?? []).filter((node): node is RawPull => node !== null);
        if ((search?.issueCount ?? 0) > nodes.length) truncated = true;
        for (const node of nodes) {
          const pull = toPullSummary(node, [reason]);
          if (!pull) continue;
          const key = `${pull.owner}/${pull.repo}#${pull.number}`;
          const existing = merged.get(key);
          if (existing) existing.reasons.push(reason);
          else merged.set(key, pull);
        }
      };
      take(data!.authored, 'authored');
      take(data!.review, 'review_requested');
      take(data!.own, 'own_repository');
      const pulls = [...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt);
      return { pulls: pulls.slice(0, 150), truncated: truncated || pulls.length > 150 };
    });
    const pulls = value.pulls.filter((pull) => !this.#isHidden(pull));
    const having = (reason: GithubPullReason) => pulls.filter((pull) => pull.reasons.includes(reason));
    const selected = filter === 'all' ? pulls : filter === 'authored' ? having('authored') : filter === 'review_requested' ? having('review_requested') : having('own_repository');
    return {
      filter,
      pulls: selected,
      counts: { all: pulls.length, reviewRequested: having('review_requested').length, authored: having('authored').length, ownRepositories: having('own_repository').length },
      truncated: value.truncated,
      freshness,
    };
  }

  async #repositoryPage(first: number, after: string | null): Promise<{ repositories: GithubRepository[]; totalCount: number; nextCursor: string | null }> {
    const { data } = await this.gh.graphql<{ viewer: { repositories: { totalCount?: number; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }; nodes?: Array<RawRepository | null> } | null } | null }>(
      REPOSITORIES_QUERY,
      { first, after },
    );
    const connection = data?.viewer?.repositories;
    if (!connection) throw githubError(502, 'github_failed', 'GitHub sent an answer that could not be read.', { status: 200, detail: '' });
    return {
      repositories: (connection.nodes ?? []).flatMap((node) => (node ? [toRepository(node)].filter((repo): repo is GithubRepository => repo !== null) : [])),
      totalCount: connection.totalCount ?? 0,
      nextCursor: connection.pageInfo?.hasNextPage && connection.pageInfo.endCursor ? connection.pageInfo.endCursor : null,
    };
  }

  /** The account's own repositories, most recently pushed first. */
  async repositories(userId: string, request: { limit: number; cursor?: string | undefined; refresh: boolean }): Promise<GithubRepositories> {
    const { value, freshness } = await this.#cached(`${userId} repositories ${request.limit} ${request.cursor ?? ''}`, TTL.lists, request.refresh, () =>
      this.#repositoryPage(request.limit, request.cursor ?? null),
    );
    return { ...value, freshness };
  }

  async repository(userId: string, owner: string, repo: string, refresh: boolean): Promise<GithubRepositoryPage> {
    const { value, freshness } = await this.#cached(`${userId} repository ${owner}/${repo}`, TTL.lists, refresh, async () => {
      const { data } = await this.gh.graphql<{ repository: RawRepositoryPage | null }>(REPOSITORY_QUERY, { owner, name: repo });
      const raw = data?.repository;
      const repository = raw ? toRepository(raw) : null;
      if (!raw || !repository) throw githubError(404, 'github_not_found', 'GitHub has no such repository, or the login may not see it.');
      const commit = raw.defaultBranchRef?.target;
      return {
        repository,
        canWrite: canWriteWith(raw.viewerPermission),
        latestCommit:
          commit?.oid && commit.committedDate
            ? {
                oid: commit.oid,
                title: (commit.messageHeadline ?? '').slice(0, 200),
                author: commit.author?.user?.login ?? commit.author?.name ?? null,
                committedAt: time(commit.committedDate),
                checks: summariseChecks(commit.statusCheckRollup),
              }
            : null,
        pulls: (raw.open?.nodes ?? []).flatMap((node) => {
          const pull = node ? toPullSummary(node) : null;
          return pull ? [pull] : [];
        }),
        pullCount: raw.open?.totalCount ?? 0,
        recentMerges: (raw.merged?.nodes ?? []).flatMap((node) =>
          node && typeof node.number === 'number' && node.mergedAt
            ? [{ number: node.number, title: (node.title ?? '').slice(0, 300), url: httpsOnly(node.url) ?? `https://github.com/${owner}/${repo}/pull/${node.number}`, author: node.author?.login ?? null, mergedAt: time(node.mergedAt) }]
            : [],
        ),
      };
    });
    const pulls = value.pulls.filter((pull) => !this.#isHidden(pull));
    return { ...value, pulls, pullCount: Math.max(0, value.pullCount - (value.pulls.length - pulls.length)), freshness };
  }

  // ---- one pull request ----------------------------------------------------------------

  async #hasMergeQueue(userId: string, owner: string, repo: string, branch: string): Promise<boolean> {
    if (refProblem(branch) !== null) return false;
    try {
      const { value } = await this.#cached(`${userId} merge-queue ${branch} ${owner}/${repo}`, TTL.mergeQueue, false, async () => {
        const { data } = await this.gh.graphql<{ repository: { mergeQueue?: { id?: string } | null } | null }>(MERGE_QUEUE_QUERY, { owner, name: repo, branch });
        return Boolean(data?.repository?.mergeQueue?.id);
      });
      return value;
    } catch {
      // Not knowing means "no queue": then the ordinary rules apply, which only ever block more.
      return false;
    }
  }

  async #pendingRuns(owner: string, repo: string, headSha: string): Promise<GithubPendingRun[]> {
    const response = await this.gh.api(`repos/${owner}/${repo}/actions/runs?head_sha=${headSha}&status=action_required&per_page=20`);
    const runs = (response.body as { workflow_runs?: RawWorkflowRun[] } | null)?.workflow_runs ?? [];
    return runs.flatMap((run) =>
      typeof run.id === 'number' && Number.isSafeInteger(run.id) ? [{ id: run.id, name: (run.name ?? run.display_title ?? 'workflow run').slice(0, 120), url: httpsOnly(run.html_url) }] : [],
    );
  }

  /** Reads one pull request from GitHub, completely, with everything a merge decision needs. */
  async #readPull(userId: string, target: Target): Promise<{ detail: PullDetail; nodeId: string | null }> {
    const { owner, repo, number } = target;
    const { data, partial } = await this.gh.graphql<{
      repository: {
        viewerPermission?: string | null;
        mergeCommitAllowed?: boolean | null;
        squashMergeAllowed?: boolean | null;
        rebaseMergeAllowed?: boolean | null;
        deleteBranchOnMerge?: boolean | null;
        pullRequest?: RawPullDetail | null;
      } | null;
    }>(PULL_QUERY, { owner, name: repo, number });
    const repository = data?.repository;
    const raw = repository?.pullRequest;
    const summary = raw ? toPullSummary(raw) : null;
    if (!repository || !raw || !summary) throw githubError(404, 'github_not_found', 'GitHub has no such pull request, or the login may not see it.');

    const state: PullDetail['state'] = raw.state === 'MERGED' ? 'merged' : raw.state === 'CLOSED' ? 'closed' : 'open';
    const rollup = raw.commits?.nodes?.[0]?.commit?.statusCheckRollup;
    const checks = checkRuns(rollup);
    const mergeMethods: GithubMergeMethod[] = [];
    if (repository.squashMergeAllowed) mergeMethods.push('squash');
    if (repository.mergeCommitAllowed) mergeMethods.push('merge');
    if (repository.rebaseMergeAllowed) mergeMethods.push('rebase');
    const crossRepository = raw.isCrossRepository === true;
    const canMerge = canWriteWith(repository.viewerPermission);

    const [mergeQueue, pendingRuns] = await Promise.all([
      state === 'open' ? this.#hasMergeQueue(userId, owner, repo, summary.baseRef) : Promise.resolve(false),
      // Only runs triggered from a fork wait for a maintainer's approval.
      state === 'open' && crossRepository ? this.#pendingRuns(owner, repo, summary.headSha) : Promise.resolve([]),
    ]);

    const blockers = blockersOf({
      incomplete: partial || checks.truncated || raw.mergeable == null || raw.mergeStateStatus == null,
      state,
      draft: summary.draft,
      canMerge,
      mergeable: summary.mergeable,
      mergeState: summary.mergeState,
      checkRuns: checks.runs,
      mergeQueue,
      mergeMethods,
    });
    const body = shortenBody(raw.bodyText);
    const files = (raw.files?.nodes ?? []).flatMap((file) =>
      file?.path ? [{ path: file.path, status: changeLetter(file.changeType), additions: file.additions ?? 0, deletions: file.deletions ?? 0 }] : [],
    );
    const moving = state === 'open' && (summary.checks.pending > 0 || summary.mergeable === 'unknown' || summary.mergeState === 'unknown');
    const detail: PullDetail = {
      ...summary,
      state,
      body: body.body,
      bodyTruncated: body.truncated,
      createdAt: time(raw.createdAt),
      checkRuns: checks.runs,
      checkRunsTruncated: checks.truncated,
      files,
      filesTruncated: (raw.files?.totalCount ?? files.length) > files.length,
      mergeMethods,
      deleteBranchOnMerge: repository.deleteBranchOnMerge === true,
      crossRepository,
      canMerge,
      mergeQueue,
      blockers,
      optionalChecksFailing: optionalChecksFailing(checks.runs),
      mergeCommit: raw.mergeCommit?.oid ?? null,
      pendingRuns,
      fixes: {
        updateBranch: state === 'open' && canMerge && summary.mergeState === 'behind',
        markReady: state === 'open' && canMerge && summary.draft,
        approveRuns: state === 'open' && canMerge && pendingRuns.length > 0,
      },
      pollAfterMs: moving ? 15_000 : null,
    };
    return { detail, nodeId: raw.id ?? null };
  }

  async pull(userId: string, target: Target, refresh: boolean): Promise<GithubPullDetail> {
    const { value, freshness } = await this.#cached(`${userId} pull ${target.owner}/${target.repo}#${target.number}`, TTL.lists, refresh, async () => (await this.#readPull(userId, target)).detail);
    return { ...value, freshness };
  }

  // ---- the record of what was attempted ---------------------------------------------------

  #audit(): Services['audit'] {
    const audit = (this.#context.services as Partial<Services>).audit;
    if (!audit) throw unavailable('The audit log is not available, so nothing is changed on GitHub.', 'audit_unavailable');
    return audit;
  }

  /** Writes one line of the action log. Throws when it cannot be written — and then nothing may run. */
  #record(actor: Actor, action: GithubAction, subject: string, entry: { id: string; outcome: GithubActionOutcome; method?: string | null; head?: string | null; message: string }): void {
    const good = entry.outcome === 'started' || entry.outcome === 'merged' || entry.outcome === 'queued' || entry.outcome === 'done';
    this.#audit().record({
      category: good ? 'change' : 'failure',
      action: AUDIT_ACTIONS[action],
      userId: actor.userId,
      subject,
      // Short keys and a message without quotes keep the line well-formed after redaction and inside the log's size limit.
      detail: JSON.stringify({ i: entry.id, o: entry.outcome, m: entry.method ?? null, h: entry.head ?? null, t: cleanToolText(entry.message, 220).replace(/["\\]/g, "'") }),
      address: actor.address,
    });
  }

  /** The caller's recent merge attempts (or all recorded actions), each with how it ended. */
  actionLog(userId: string, request: { limit: number; action: 'merge' | 'all' }): GithubActionLog {
    const byAction = new Map(Object.entries(AUDIT_ACTIONS).map(([action, name]) => [name, action as GithubAction]));
    const attempts = new Map<string, GithubActionLogEntry>();
    // Oldest first, so that an attempt's outcome replaces its "started" line.
    const events = this.#audit().list({ userId, limit: 2000 }).reverse();
    for (const event of events) {
      const action = byAction.get(event.action);
      if (!action || (request.action === 'merge' && action !== 'merge')) continue;
      let detail: { i?: unknown; o?: unknown; m?: unknown; h?: unknown; t?: unknown };
      try {
        detail = JSON.parse(event.detail) as typeof detail;
      } catch {
        continue;
      }
      if (typeof detail.i !== 'string' || typeof detail.o !== 'string') continue;
      const subject = /^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})#(\d{1,9})$/.exec(event.subject ?? '');
      const previous = attempts.get(detail.i);
      // Two lines of one attempt can carry the same millisecond: an outcome always wins over "started", whichever is read last.
      if (previous && previous.outcome !== 'started' && detail.o === 'started') continue;
      attempts.set(detail.i, {
        id: detail.i,
        at: Math.min(previous?.at ?? event.at, event.at),
        action,
        owner: subject?.[1] ?? '',
        repo: subject?.[2] ?? '',
        number: subject ? Number(subject[3]) : null,
        method: detail.m === 'merge' || detail.m === 'squash' || detail.m === 'rebase' ? detail.m : (previous?.method ?? null),
        headSha: typeof detail.h === 'string' ? detail.h : (previous?.headSha ?? null),
        outcome: detail.o as GithubActionOutcome,
        message: typeof detail.t === 'string' ? detail.t : '',
      });
    }
    return { entries: [...attempts.values()].sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1)).slice(0, request.limit) };
  }

  /**
   * The frame every change to GitHub runs in: validate, record the attempt,
   * take the pull request's lock, read it afresh, let `decide` refuse or act,
   * and record how it ended. A request that cannot even be parsed is recorded
   * too. If the attempt cannot be recorded, nothing happens.
   */
  async #guarded<B, R>(
    actor: Actor,
    action: GithubAction,
    rawTarget: unknown,
    rawBody: unknown,
    schema: z.ZodType<B>,
    describe: (body: B) => { method?: string | null; head?: string | null },
    decide: (context: { target: Target; body: B; detail: PullDetail; nodeId: string | null }) => Promise<{ result: R; outcome: GithubActionOutcome; message: string }>,
  ): Promise<R> {
    const id = newId();
    const parsedTarget = githubPullParamsSchema.safeParse(rawTarget);
    const parsedBody = schema.safeParse(rawBody ?? {});
    if (!parsedTarget.success || !parsedBody.success) {
      const subject = parsedTarget.success ? `${parsedTarget.data.owner}/${parsedTarget.data.repo}#${parsedTarget.data.number}` : 'invalid target';
      this.#record(actor, action, subject, { id, outcome: 'invalid', message: 'The request was not valid and nothing was done.' });
      throw badRequest('The request is not valid.', [...(parsedTarget.error?.issues ?? []), ...(parsedBody.error?.issues ?? [])].map((issue) => ({ path: issue.path.join('.'), message: issue.message })), 'invalid_request');
    }
    const target = parsedTarget.data;
    const body = parsedBody.data;
    const subject = `${target.owner}/${target.repo}#${target.number}`;
    const described = describe(body);
    const key = subject.toLowerCase();

    // Recorded before anything runs. If this throws, nothing runs.
    this.#record(actor, action, subject, { id, outcome: 'started', ...described, message: 'Started.' });
    const finish = (outcome: GithubActionOutcome, message: string) => {
      try {
        this.#record(actor, action, subject, { id, outcome, ...described, message });
      } catch (error) {
        this.#context.log.error({ err: describeError(error), subject }, 'could not record the outcome of a GitHub action');
      }
    };

    if (this.#busy.has(key)) {
      finish('refused', 'Another action on this pull request was still in progress.');
      throw githubError(409, 'github_action_in_progress', 'Another action on this pull request is still in progress.');
    }
    this.#busy.add(key);
    try {
      const { detail, nodeId } = await this.#readPull(actor.userId, target);
      const done = await decide({ target, body, detail, nodeId });
      finish(done.outcome, done.message);
      this.#forget(actor.userId, target);
      this.#context.bus.publish(`user:${actor.userId}`, GITHUB_CHANGED, { owner: target.owner, repo: target.repo, number: target.number });
      return done.result;
    } catch (error) {
      if (isStudioError(error)) {
        const outcome: GithubActionOutcome =
          error.code === 'github_outcome_unknown' ? 'unknown' : error.status === 409 || error.status === 400 || error.status === 403 || error.status === 404 ? 'refused' : 'failed';
        finish(outcome, error.message);
        // After an unknown outcome the next read must come from GitHub, not from memory.
        if (outcome !== 'refused') this.#forget(actor.userId, target);
      } else {
        finish('failed', 'The server failed while handling the request.');
      }
      throw error;
    } finally {
      this.#busy.delete(key);
    }
  }

  // ---- changes ---------------------------------------------------------------------------

  /**
   * Merges a pull request — only the commit the user saw, only by a method the
   * repository allows, and only when nothing blocks it. There is no override
   * of any kind: a rule that an administrator could bypass on GitHub is a
   * blocker here, and automatic merging is never switched on.
   */
  merge(actor: Actor, rawTarget: unknown, rawBody: unknown): Promise<GithubMergeResult> {
    return this.#guarded(
      actor,
      'merge',
      rawTarget,
      rawBody,
      githubMergeRequestSchema,
      (body) => ({ method: body.method, head: body.headSha }),
      async ({ target, body, detail, nodeId }) => {
        const { owner, repo, number } = target;
        if (detail.state !== 'open') {
          throw githubError(409, 'github_merge_refused', `This pull request is ${detail.state === 'merged' ? 'already merged' : 'closed'}.`, { blocker: 'not_open' });
        }
        if (detail.headSha !== body.headSha) {
          throw githubError(409, 'github_head_moved', `The pull request changed since you looked at it: its head is now ${short(detail.headSha)}. Review it again before merging.`, { headSha: detail.headSha });
        }
        const blocker = detail.blockers[0];
        if (blocker) throw githubError(409, 'github_merge_refused', blocker.message, { blocker: blocker.code, blockers: detail.blockers.map((entry) => entry.code) });
        if (!detail.mergeQueue && !detail.mergeMethods.includes(body.method)) {
          throw githubError(400, 'github_method_not_allowed', `This repository does not allow the "${body.method}" merge method.`, { allowed: detail.mergeMethods });
        }
        if (detail.optionalChecksFailing && !body.acknowledgeFailingChecks) {
          throw githubError(409, 'github_merge_refused', 'Some checks that are not required are failing. Confirm explicitly that you want to merge anyway.', { blocker: 'optional_checks_failing' });
        }

        if (detail.mergeQueue) {
          if (!nodeId) throw githubError(502, 'github_failed', 'GitHub did not identify the pull request, so it was not queued.', { status: 200, detail: '' });
          await this.gh.graphql(ENQUEUE_MUTATION, { id: nodeId, head: body.headSha }, { write: true, timeoutMs: this.gh.timeouts.merge });
          const message = `#${number} entered the merge queue of ${owner}/${repo}.`;
          const queued: GithubMergeResult = { outcome: 'queued', mergeCommit: null, message, branchDeleted: null };
          return { result: queued, outcome: 'queued' as const, message };
        }

        // "sha" makes GitHub itself refuse if the head moves between our read and its merge.
        const response = await this.gh.api(`repos/${owner}/${repo}/pulls/${number}/merge`, {
          method: 'PUT',
          body: { merge_method: body.method, sha: body.headSha },
          timeoutMs: this.gh.timeouts.merge,
          accept: [405, 409, 422],
        });
        if (response.status !== 200) throw this.#mergeRefusal(response);
        const mergeCommit = (response.body as { sha?: unknown } | null)?.sha;
        this.#hidden.set(`${owner}/${repo}#${number}`.toLowerCase(), Date.now() + HIDE_MERGED_MS);

        let branchDeleted: boolean | null = null;
        if (body.deleteBranch) {
          // Never a branch in someone's fork, and nothing when the repository tidies up by itself.
          if (detail.crossRepository || detail.deleteBranchOnMerge || refProblem(detail.headRef) !== null) {
            branchDeleted = false;
          } else {
            try {
              const reference = detail.headRef.split('/').map(encodeURIComponent).join('/');
              await this.gh.api(`repos/${owner}/${repo}/git/refs/heads/${reference}`, { method: 'DELETE', timeoutMs: this.gh.timeouts.fix });
              branchDeleted = true;
            } catch {
              branchDeleted = false;
            }
          }
        }
        const message = `Merged #${number} into ${detail.baseRef} (${body.method}).`;
        const merged: GithubMergeResult = { outcome: 'merged', mergeCommit: typeof mergeCommit === 'string' ? mergeCommit : null, message, branchDeleted };
        return { result: merged, outcome: 'merged' as const, message };
      },
    );
  }

  #mergeRefusal(response: GhResponse): StudioError {
    const said = cleanToolText(typeof (response.body as { message?: unknown } | null)?.message === 'string' ? (response.body as { message: string }).message : '');
    if (response.status === 409) {
      return githubError(409, 'github_head_moved', 'The pull request changed while it was being merged, so GitHub did not merge it. Review it again.', { detail: said });
    }
    return githubError(409, 'github_merge_refused', `GitHub did not merge the pull request${said ? `: ${said}` : '.'}`, { blocker: 'github', status: response.status });
  }

  /** Brings a pull request's branch up to date with its base. Only while it is behind, and only the head the user saw. */
  updateBranch(actor: Actor, rawTarget: unknown, rawBody: unknown): Promise<GithubFixResult> {
    return this.#guarded(actor, 'update_branch', rawTarget, rawBody, githubUpdateBranchRequestSchema, (body) => ({ head: body.headSha }), async ({ target, body, detail }) => {
      if (detail.state !== 'open' || !detail.fixes.updateBranch) {
        throw githubError(409, 'github_fix_not_applicable', 'This pull request is not behind its base branch, so there is nothing to update.');
      }
      if (detail.headSha !== body.headSha) {
        throw githubError(409, 'github_head_moved', `The pull request changed since you looked at it: its head is now ${short(detail.headSha)}.`, { headSha: detail.headSha });
      }
      await this.gh.api(`repos/${target.owner}/${target.repo}/pulls/${target.number}/update-branch`, {
        method: 'PUT',
        body: { expected_head_sha: body.headSha },
        timeoutMs: this.gh.timeouts.fix,
      });
      const message = `GitHub is updating ${detail.headRef} with the latest ${detail.baseRef}.`;
      return { result: { message, pull: await this.#fresh(actor.userId, target) }, outcome: 'done' as const, message };
    });
  }

  markReady(actor: Actor, rawTarget: unknown, rawBody: unknown): Promise<GithubFixResult> {
    return this.#guarded(actor, 'mark_ready', rawTarget, rawBody, githubEmptySchema, () => ({}), async ({ target, detail, nodeId }) => {
      if (detail.state !== 'open' || !detail.fixes.markReady) {
        throw githubError(409, 'github_fix_not_applicable', 'This pull request is not a draft, so there is nothing to mark as ready.');
      }
      if (!nodeId) throw githubError(502, 'github_failed', 'GitHub did not identify the pull request.', { status: 200, detail: '' });
      await this.gh.graphql(READY_MUTATION, { id: nodeId }, { write: true, timeoutMs: this.gh.timeouts.fix });
      const message = `#${target.number} is marked as ready for review.`;
      return { result: { message, pull: await this.#fresh(actor.userId, target) }, outcome: 'done' as const, message };
    });
  }

  /** Approves workflow runs that wait for a maintainer — only runs a fresh read lists as waiting for this pull request. */
  approveRuns(actor: Actor, rawTarget: unknown, rawBody: unknown): Promise<GithubFixResult> {
    return this.#guarded(actor, 'approve_runs', rawTarget, rawBody, githubApproveRunsRequestSchema, () => ({}), async ({ target, body, detail }) => {
      const waiting = new Set(detail.pendingRuns.map((run) => run.id));
      const unknown = body.runIds.filter((runId) => !waiting.has(runId));
      if (detail.state !== 'open' || !detail.canMerge || unknown.length > 0) {
        throw githubError(409, 'github_fix_not_applicable', 'Not every one of those workflow runs is waiting for approval on this pull request. Nothing was approved.', { notWaiting: unknown });
      }
      const approved: number[] = [];
      for (const runId of body.runIds) {
        try {
          await this.gh.api(`repos/${target.owner}/${target.repo}/actions/runs/${runId}/approve`, { method: 'POST', timeoutMs: this.gh.timeouts.fix });
          approved.push(runId);
        } catch (error) {
          if (!isStudioError(error)) throw error;
          throw new StudioError(error.status, error.code, `${approved.length} of ${body.runIds.length} run(s) were approved before one failed: ${error.message}`, { approved, failed: runId });
        }
      }
      const message = `Approved ${approved.length} workflow run(s).`;
      return { result: { message, pull: await this.#fresh(actor.userId, target) }, outcome: 'done' as const, message };
    });
  }

  async #fresh(userId: string, target: Target): Promise<GithubPullDetail> {
    const { detail } = await this.#readPull(userId, target);
    return { ...detail, freshness: { fetchedAt: Date.now(), stale: false, staleReason: null } };
  }

  // ---- the pull request of a project's branch ------------------------------------------------

  /**
   * The open pull request for the branch a project has checked out. Whatever
   * goes wrong, the answer is a reason to show nothing — never an error.
   */
  async branchPull(principal: Principal, projectId: string, rootDir: string, refresh: boolean): Promise<GithubBranchPull> {
    const nothing = (result: GithubBranchPull['result'], extra: Partial<GithubBranchPull> = {}): GithubBranchPull => ({
      result,
      owner: null,
      repo: null,
      branch: null,
      pull: null,
      verdict: null,
      freshness: null,
      ...extra,
    });
    // The login is the owner's. A member could point a project's remote anywhere and read through it.
    if (principal.role !== 'owner') return nothing('owner_only');
    const git = (this.#context.services as Partial<Services>).git;
    if (!git) return nothing('unavailable');
    let local;
    try {
      local = await git.branchAndRemote(rootDir);
    } catch {
      return nothing('not_a_repository');
    }
    if (local.state !== 'ready') return nothing('not_a_repository');
    if (local.branch === null) return nothing('detached');
    if (local.remoteUrl === null) return nothing('no_remote', { branch: local.branch });
    const repository = githubRepositoryOf(local.remoteUrl);
    if (!repository) return nothing('not_github', { branch: local.branch });
    const { owner, repo } = repository;
    const branch = local.branch;
    // A branch name git accepts but we would not send anywhere simply has no pull request as far as we are concerned.
    if (refProblem(branch) !== null) return nothing('none', { owner, repo, branch });
    try {
      const { value, freshness } = await this.#cached(`${principal.userId} branch ${projectId} ${branch} ${owner}/${repo}`, TTL.branch, refresh, async () => {
        const { data } = await this.gh.graphql<{ repository: { pullRequests?: { nodes?: Array<RawPull | null> | null } | null } | null }>(BRANCH_PULLS_QUERY, { owner, name: repo, branch });
        const nodes = (data?.repository?.pullRequests?.nodes ?? []).filter((node): node is RawPull => node !== null);
        // A branch of the same name in somebody's fork is somebody else's pull request.
        const own = nodes.find((node) => node.isCrossRepository !== true);
        return own ? toPullSummary(own) : null;
      });
      if (!value || this.#isHidden(value)) return nothing('none', { owner, repo, branch, freshness });
      return { result: 'found', owner, repo, branch, pull: value, verdict: verdictOf(value), freshness };
    } catch (error) {
      if (!isStudioError(error)) throw error;
      return nothing(error.code === 'github_not_found' ? 'none' : 'unavailable', { owner, repo, branch });
    }
  }

  // ---- CI runs -------------------------------------------------------------------------------

  /** Workflow runs of the account's own repositories that were pushed to recently. */
  async ci(userId: string, refresh: boolean): Promise<GithubCi> {
    const { value, freshness } = await this.#cached(`${userId} ci`, TTL.ci, refresh, async () => {
      const recent = await this.#cached(`${userId} ci-repositories`, TTL.ciRepositories, false, async () => {
        const page = await this.#repositoryPage(100, null);
        const since = Date.now() - 3 * 24 * 60 * 60_000;
        return page.repositories.filter((repository) => !repository.archived && (repository.pushedAt ?? 0) >= since).slice(0, 6);
      });
      const runs: GithubWorkflowRun[] = [];
      const problems: GithubCi['problems'] = [];
      await Promise.all(
        recent.value.map(async (repository) => {
          const name = `${repository.owner}/${repository.name}`;
          try {
            const response = await this.gh.api(`repos/${repository.owner}/${repository.name}/actions/runs?per_page=15`);
            for (const run of (response.body as { workflow_runs?: RawWorkflowRun[] } | null)?.workflow_runs ?? []) {
              if (typeof run.id !== 'number') continue;
              const status: GithubWorkflowRun['status'] =
                run.status === 'completed' ? 'completed' : run.status === 'in_progress' ? 'running' : run.status === 'waiting' || run.status === 'action_required' ? 'waiting' : 'queued';
              runs.push({
                id: run.id,
                repository: name,
                title: (run.display_title ?? run.name ?? '').slice(0, 200),
                workflow: (run.name ?? '').slice(0, 120),
                status,
                conclusion: status === 'completed' ? (run.conclusion ?? null) : null,
                branch: run.head_branch ?? null,
                event: run.event ?? '',
                url: httpsOnly(run.html_url),
                startedAt: run.run_started_at ? time(run.run_started_at) : null,
                updatedAt: run.updated_at ? time(run.updated_at) : null,
              });
            }
          } catch (error) {
            // One unreadable repository is a note; not being signed in fails the whole reading.
            if (!isStudioError(error) || error.code === 'github_signed_out' || error.code === 'github_expired' || error.code === 'github_tool_missing') throw error;
            problems.push({ repository: name, message: error.message });
          }
        }),
      );
      const newest = (a: GithubWorkflowRun, b: GithubWorkflowRun) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
      const running = runs.filter((run) => run.status === 'running').sort(newest);
      const queued = runs.filter((run) => run.status === 'queued' || run.status === 'waiting').sort(newest);
      const finished = runs.filter((run) => run.status === 'completed').sort(newest).slice(0, 6);
      return {
        runs: [...running, ...queued, ...finished],
        counts: { running: running.length, queued: queued.filter((run) => run.status === 'queued').length, waiting: queued.filter((run) => run.status === 'waiting').length },
        repositories: recent.value.map((repository) => `${repository.owner}/${repository.name}`),
        problems: problems.sort((a, b) => a.repository.localeCompare(b.repository)),
      };
    });
    return { ...value, freshness };
  }
}
