import path from 'node:path';
import type {
  GithubAccount,
  GithubActionLog,
  GithubBranchPull,
  GithubCi,
  GithubFixResult,
  GithubInbox,
  GithubMergeResult,
  GithubPullDetail,
  GithubRepositories,
  GithubRepositoryPage,
  Project,
} from '@agent-studio/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StudioEvent } from '../../src/kernel/events.js';
import { createGitSandbox, type GhCall, type GhRule, type GitSandbox } from '../../src/modules/git/testing/fixtures.js';
import { createTestStudio, type TestClient, type TestStudio } from '../../src/testing/harness.js';

let sandbox: GitSandbox;
let t: TestStudio;
let owner: TestClient;

beforeEach(async () => {
  // The sandbox puts a stand-in `gh` first on PATH and gives the process an empty HOME:
  // nothing in this file can reach the real GitHub or the machine's real login.
  sandbox = await createGitSandbox();
  t = await createTestStudio();
  owner = await t.owner();
  t.studio.context.services.github.tuning.refreshFloorMs = 0;
});
afterEach(async () => {
  await t.close();
  await sandbox.restore();
});

// ---- canned answers ------------------------------------------------------------------

const HEAD = 'a'.repeat(40);
const MOVED = 'b'.repeat(40);
const MERGE_COMMIT = 'c'.repeat(40);
/** Token-shaped strings planted in the stand-in's output. None may ever come back out of the server. */
const SECRETS = ['gho_abcdefghijklmnopqrstuvwxyz0123456789', 'ghp_zyxwvutsrqponmlkjihgfedcba9876543210', '/home/someone/.config/gh/hosts.yml'];

function http(status: number, body: unknown, headers: Record<string, string> = {}): string {
  const lines = Object.entries({ 'Content-Type': 'application/json; charset=utf-8', 'X-Oauth-Scopes': 'gist, read:org, repo, workflow', ...headers }).map(([name, value]) => `${name}: ${value}\r\n`);
  return `HTTP/2.0 ${status} ${status < 300 ? 'OK' : 'Error'}\r\n${lines.join('')}\r\n${body === null ? '' : JSON.stringify(body)}`;
}
const ok = (body: unknown, headers?: Record<string, string>): GhRule => ({ stdout: http(200, body, headers) });
const failed = (status: number, message: string, headers?: Record<string, string>): GhRule => ({
  stdout: http(status, { message, documentation_url: 'https://docs.github.com' }, headers),
  stderr: `gh: ${message} (HTTP ${status})\n`,
  code: 1,
});

const check = (name: string, conclusion: string | null, required: boolean, status = 'COMPLETED') => ({
  __typename: 'CheckRun',
  name,
  status,
  conclusion,
  detailsUrl: `https://github.com/octo/demo/actions/runs/1/job/${name}`,
  isRequired: required,
  checkSuite: { workflowRun: { workflow: { name: 'CI' } } },
});
const contexts = (nodes: unknown[], hasNextPage = false) => ({ state: 'SUCCESS', contexts: { totalCount: nodes.length, pageInfo: { hasNextPage }, nodes } });

function rawPull(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'PR_kwDOnode7',
    number: 7,
    title: 'Add the thing',
    url: 'https://github.com/octo/demo/pull/7',
    isDraft: false,
    state: 'OPEN',
    author: { login: 'alice' },
    headRefName: 'feature/thing',
    baseRefName: 'main',
    headRefOid: HEAD,
    additions: 10,
    deletions: 2,
    changedFiles: 2,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: 'APPROVED',
    updatedAt: '2026-10-01T10:00:00Z',
    createdAt: '2026-09-30T10:00:00Z',
    isCrossRepository: false,
    repository: { name: 'demo', owner: { login: 'octo' } },
    commits: { nodes: [{ commit: { oid: HEAD, statusCheckRollup: contexts([check('build', 'SUCCESS', true)]) } }] },
    bodyText: 'What this does.',
    mergeCommit: null,
    files: { totalCount: 2, nodes: [{ path: 'src/a.ts', additions: 8, deletions: 2, changeType: 'MODIFIED' }, { path: 'src/new.ts', additions: 2, deletions: 0, changeType: 'ADDED' }] },
    ...overrides,
  };
}

const REPO_SETTINGS = { viewerPermission: 'WRITE', mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: false, deleteBranchOnMerge: false };
const withChecks = (nodes: unknown[], hasNextPage = false) => ({ commits: { nodes: [{ commit: { oid: HEAD, statusCheckRollup: contexts(nodes, hasNextPage) } }] } });

/** Rules that answer everything a read of pull request #7 asks for. Earlier rules win, so `first` can override. */
function pullRules(pull: Record<string, unknown> | null, options: { repo?: Record<string, unknown>; queue?: boolean; first?: GhRule[]; errors?: unknown[] } = {}): GhRule[] {
  return [
    ...(options.first ?? []),
    {
      args: ['api', 'graphql'],
      stdin: ['pullRequest(number'],
      ...(options.errors
        ? { stdout: http(200, { data: { repository: { ...REPO_SETTINGS, ...options.repo, pullRequest: pull } }, errors: options.errors }), stderr: 'gh: Something went wrong\n', code: 1 }
        : ok({ data: { repository: pull === null && options.repo === undefined ? null : { ...REPO_SETTINGS, ...options.repo, pullRequest: pull } } })),
    },
    { args: ['api', 'graphql'], stdin: ['mergeQueue(branch'], ...ok({ data: { repository: { mergeQueue: options.queue ? { id: 'MQ_1' } : null } } }) },
    { args: ['api', 'actions/runs?head_sha='], ...ok({ total_count: 0, workflow_runs: [] }) },
  ];
}

const MERGED_OK: GhRule = { args: ['api', '--method PUT', 'repos/octo/demo/pulls/7/merge'], ...ok({ sha: MERGE_COMMIT, merged: true, message: 'Pull Request successfully merged' }) };
const SIGNED_IN: GhRule = {
  args: ['auth', 'status'],
  stdout: JSON.stringify({ hosts: { 'github.com': [{ state: 'success', active: true, host: 'github.com', login: 'octo', tokenSource: SECRETS[2], scopes: 'gist, read:org, repo, workflow', gitProtocol: 'https', token: SECRETS[0] }] } }),
};

const PULL = '/api/github/repositories/octo/demo/pulls/7';
const errorOf = (response: { status: number; body: unknown }): [number, string | undefined] => [response.status, (response.body as { error?: { code?: string } } | undefined)?.error?.code];
const detailsOf = (response: { body: unknown }) => (response.body as { error: { details: Record<string, unknown>; message: string } }).error;
const isWrite = (call: GhCall) => /--method (PUT|POST|DELETE|PATCH)/.test(call.args.join(' ')) ? !call.args.includes('graphql') || call.stdin.includes('mutation') : false;
const writes = async () => (await sandbox.ghCalls()).filter(isWrite);
const merge = (body: Record<string, unknown> = {}, client: TestClient = owner) => client.post<GithubMergeResult>(`${PULL}/merge`, { method: 'squash', headSha: HEAD, ...body });
const log = async (action: 'merge' | 'all' = 'merge') => (await owner.get<GithubActionLog>(`/api/github/actions?action=${action}`)).body.entries;

describe('sign-in state', () => {
  const account = async (rules: GhRule[]): Promise<GithubAccount> => {
    await sandbox.ghRules(rules);
    const response = await owner.get<GithubAccount>('/api/github/account?refresh=true');
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return response.body;
  };

  it('reports a working login without ever touching the token', async () => {
    const ready = await account([SIGNED_IN]);
    expect(ready).toMatchObject({ state: 'ready', login: 'octo', canWrite: true, command: null, scopes: ['gist', 'read:org', 'repo', 'workflow'] });
    expect(Object.keys(ready).sort()).toEqual(['canWrite', 'checkedAt', 'command', 'login', 'message', 'scopes', 'state']);
    for (const secret of SECRETS) expect(JSON.stringify(ready)).not.toContain(secret);
    // The tool was asked about the account, never for the token.
    for (const call of await sandbox.ghCalls()) {
      expect(call.args.join(' ')).toBe('auth status --hostname github.com --active --json hosts');
      expect(call.args.join(' ')).not.toMatch(/show-token|auth token|-t\b/);
    }
  });

  it('tells apart: tool missing, not signed in, login expired, login without the needed permission, GitHub unreachable', async () => {
    expect(await account([{ args: ['auth', 'status'], stdout: JSON.stringify({ hosts: {} }) }])).toMatchObject({ state: 'signed_out', login: null, command: 'gh auth login --hostname github.com --git-protocol https --web' });
    expect(await account([{ args: ['auth', 'status'], stdout: '', stderr: 'You are not logged into any GitHub hosts. To log in, run: gh auth login\n', code: 1 }])).toMatchObject({ state: 'signed_out' });

    const expired = await account([{ args: ['auth', 'status'], stdout: JSON.stringify({ hosts: { 'github.com': [{ state: 'error', active: true, login: 'octo', error: `HTTP 401: Bad credentials (token ${SECRETS[0]} in ${SECRETS[2]})` }] } }) }]);
    expect(expired).toMatchObject({ state: 'expired', login: 'octo', canWrite: null });
    expect(expired.command).toContain('gh auth login');

    const limited = await account([{ args: ['auth', 'status'], stdout: JSON.stringify({ hosts: { 'github.com': [{ state: 'success', active: true, login: 'octo', scopes: 'read:org, gist' }] } }) }]);
    expect(limited).toMatchObject({ state: 'limited', canWrite: false, command: 'gh auth refresh --hostname github.com --scopes repo' });
    expect(limited.message).toContain('"repo"');

    // A login that does not list permissions (a fine-grained token) is not second-guessed.
    expect(await account([{ args: ['auth', 'status'], stdout: JSON.stringify({ hosts: { 'github.com': [{ state: 'success', active: true, login: 'octo', scopes: '' }] } }) }])).toMatchObject({ state: 'ready', canWrite: null });
    expect(await account([{ args: ['auth', 'status'], stdout: JSON.stringify({ hosts: { 'github.com': [{ state: 'timeout', active: true, login: 'octo', error: 'dial tcp: lookup api.github.com: no such host' }] } }) }])).toMatchObject({ state: 'unreachable' });
    expect(await account([{ args: ['auth', 'status'], stdout: 'garbage', stderr: 'panic: something odd\n', code: 2 }])).toMatchObject({ state: 'error' });

    const pathWithGh = process.env.PATH;
    process.env.PATH = path.join(sandbox.dir, 'no-such-bin');
    try {
      const missing = await owner.get<GithubAccount>('/api/github/account?refresh=true');
      expect(missing.body).toMatchObject({ state: 'tool_missing', login: null });
      expect(missing.body.message).toContain('not installed');
      // Every other capability says the same thing as a refusal, not as a crash.
      expect(errorOf(await owner.get('/api/github/inbox'))).toEqual([503, 'github_tool_missing']);
    } finally {
      process.env.PATH = pathWithGh;
    }
    for (const secret of SECRETS) expect(JSON.stringify(expired)).not.toContain(secret);
  });

  it('falls back to asking the API who it is when the tool is too old for --json', async () => {
    const old: GhRule = { args: ['auth', 'status'], stderr: 'unknown flag: --json\n', code: 1 };
    expect(await account([old, { args: ['api', 'user'], ...ok({ login: 'octo', id: 1 }) }])).toMatchObject({ state: 'ready', login: 'octo', canWrite: true });
    expect(await account([old, { args: ['api', 'user'], ...ok({ login: 'octo' }, { 'X-Oauth-Scopes': 'public_repo' }) }])).toMatchObject({ state: 'limited', canWrite: false });
    expect(await account([old, { args: ['api', 'user'], ...failed(401, 'Bad credentials') }])).toMatchObject({ state: 'expired' });
    expect(await account([old, { args: ['api', 'user'], stderr: 'To get started with GitHub CLI, please run:  gh auth login\n', code: 4 }])).toMatchObject({ state: 'signed_out' });
  });

  it('remembers the answer for a while, and checks again when asked to', async () => {
    await sandbox.ghRules([{ args: ['auth', 'status'], stdout: JSON.stringify({ hosts: {} }) }]);
    expect((await owner.get<GithubAccount>('/api/github/account')).body.state).toBe('signed_out');
    // The owner signs in on the server…
    await sandbox.ghRules([SIGNED_IN]);
    expect((await owner.get<GithubAccount>('/api/github/account')).body.state).toBe('signed_out');
    // …and presses "check again".
    expect((await owner.get<GithubAccount>('/api/github/account?refresh=true')).body.state).toBe('ready');
    expect(await sandbox.ghCalls()).toHaveLength(2);
    expect((await owner.get('/api/github/account?refresh=maybe')).status).toBe(400);
  });
});

describe('names from clients', () => {
  it.each([
    ['an owner starting with a hyphen', '/api/github/repositories/-octo/demo'],
    ['an owner with odd characters', '/api/github/repositories/oc%20to/demo'],
    ['an owner that is too long', `/api/github/repositories/${'o'.repeat(40)}/demo`],
    ['a repository called ..', '/api/github/repositories/octo/..'],
    ['a repository called .', '/api/github/repositories/octo/.'],
    ['a repository with a slash smuggled in', '/api/github/repositories/octo/demo%2F..%2Fother'],
    ['a repository with an option-like name', '/api/github/repositories/octo/--jq%20.x'],
    ['pull request 0', '/api/github/repositories/octo/demo/pulls/0'],
    ['pull request 01', '/api/github/repositories/octo/demo/pulls/01'],
    ['a negative pull request', '/api/github/repositories/octo/demo/pulls/-1'],
    ['a pull request that is not a number', '/api/github/repositories/octo/demo/pulls/7abc'],
    ['an inbox filter that does not exist', '/api/github/inbox?filter=everything'],
    ['a cursor with odd characters', '/api/github/repositories?cursor=%22%7D%20injected'],
    ['a page size of 500', '/api/github/repositories?limit=500'],
  ])('refuses %s without contacting GitHub', async (_what, url) => {
    await sandbox.ghRules([SIGNED_IN, ...pullRules(rawPull())]);
    const response = await owner.get(url);
    expect([400, 404], JSON.stringify(response.body)).toContain(response.status);
    expect(await sandbox.ghCalls()).toEqual([]);
  });

  it.each([
    ['a short commit id', { headSha: 'abc1234' }],
    ['an upper-case commit id', { headSha: 'A'.repeat(40) }],
    ['a commit id with an option inside', { headSha: `${'a'.repeat(30)} --admin` }],
    ['no commit id', { headSha: undefined }],
    ['an unknown method', { method: 'fast-forward' }],
    ['an option as the method', { method: '--admin' }],
    ['a string where a boolean belongs', { deleteBranch: 'true' }],
    ['a string acknowledgement', { acknowledgeFailingChecks: 'yes' }],
  ])('refuses a merge request with %s, records it as invalid, and contacts nobody', async (_what, body) => {
    await sandbox.ghRules([SIGNED_IN, ...pullRules(rawPull()), MERGED_OK]);
    expect(errorOf(await merge(body))).toEqual([400, 'invalid_request']);
    expect(await sandbox.ghCalls()).toEqual([]);
    expect(await log()).toMatchObject([{ action: 'merge', owner: 'octo', repo: 'demo', number: 7, outcome: 'invalid' }]);
  });

  it('refuses a merge aimed at a malformed repository or number the same way', async () => {
    await sandbox.ghRules([...pullRules(rawPull()), MERGED_OK]);
    for (const url of ['/api/github/repositories/-octo/demo/pulls/7/merge', '/api/github/repositories/octo/../pulls/7/merge', '/api/github/repositories/octo/demo/pulls/007/merge', '/api/github/repositories/octo/demo/pulls/0/merge']) {
      const response = await owner.post(url, { method: 'squash', headSha: HEAD });
      expect([400, 404], url).toContain(response.status);
    }
    expect(await sandbox.ghCalls()).toEqual([]);
    expect((await log()).every((entry) => entry.outcome === 'invalid')).toBe(true);
  });
});

describe('reading', () => {
  it('builds the inbox from three searches, with reasons, counts and filters', async () => {
    const mine = rawPull({ number: 7, title: 'Mine' });
    const both = rawPull({ number: 8, title: 'Mine, in my repository', updatedAt: '2026-10-02T10:00:00Z', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', ...withChecks([check('build', 'FAILURE', false), check('lint', null, false, 'IN_PROGRESS'), check('docs', 'SUCCESS', false)]) });
    const toReview = rawPull({ number: 3, title: 'Please review', repository: { name: 'other', owner: { login: 'team' } }, author: { login: 'bob' }, reviewDecision: 'REVIEW_REQUIRED', updatedAt: '2026-10-03T10:00:00Z', isDraft: true });
    await sandbox.ghRules([
      {
        args: ['api', 'graphql'],
        stdin: ['authored: search'],
        ...ok({ data: { authored: { issueCount: 2, nodes: [mine, both] }, review: { issueCount: 1, nodes: [toReview] }, own: { issueCount: 70, nodes: [both, {}] } } }),
      },
    ]);
    const inbox = (await owner.get<GithubInbox>('/api/github/inbox')).body;
    expect(inbox.pulls.map((pull) => [pull.owner, pull.repo, pull.number, pull.reasons])).toEqual([
      ['team', 'other', 3, ['review_requested']],
      ['octo', 'demo', 8, ['authored', 'own_repository']],
      ['octo', 'demo', 7, ['authored']],
    ]);
    expect(inbox.counts).toEqual({ all: 3, reviewRequested: 1, authored: 2, ownRepositories: 1 });
    // One search had more results than were read.
    expect(inbox.truncated).toBe(true);
    expect(inbox.freshness).toMatchObject({ stale: false, staleReason: null });
    expect(inbox.pulls[1]).toMatchObject({ title: 'Mine, in my repository', mergeable: 'conflicting', mergeState: 'dirty', headRef: 'feature/thing', baseRef: 'main', headSha: HEAD, additions: 10, deletions: 2 });
    expect(inbox.pulls[1]!.checks).toEqual({ state: 'failing', total: 3, passing: 1, failing: 1, pending: 1, skipped: 0 });
    expect(inbox.pulls[0]).toMatchObject({ draft: true, reviewDecision: 'review_required', author: 'bob' });

    expect((await owner.get<GithubInbox>('/api/github/inbox?filter=review_requested')).body.pulls.map((pull) => pull.number)).toEqual([3]);
    expect((await owner.get<GithubInbox>('/api/github/inbox?filter=authored')).body.pulls.map((pull) => pull.number)).toEqual([8, 7]);
    const own = (await owner.get<GithubInbox>('/api/github/inbox?filter=own_repositories')).body;
    expect(own.pulls.map((pull) => pull.number)).toEqual([8]);
    expect(own.counts.all).toBe(3);
    // Four requests, one call to GitHub: the answer is cached.
    const calls = await sandbox.ghCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args.join(' ')).toBe('api --hostname github.com --include --method POST -H Accept: application/vnd.github+json --input - graphql');
    const sent = JSON.parse(calls[0]!.stdin) as { variables: Record<string, unknown> };
    expect(sent.variables).toEqual({
      authored: 'is:pr is:open archived:false sort:updated-desc author:@me',
      review: 'is:pr is:open archived:false sort:updated-desc review-requested:@me',
      own: 'is:pr is:open archived:false sort:updated-desc user:@me',
      first: 50,
    });
  });

  it('lists the account’s repositories page by page, most recently pushed first', async () => {
    const repository = (name: string, pushedAt: string, extra: Record<string, unknown> = {}) => ({
      name,
      owner: { login: 'octo' },
      description: `About ${name}`,
      isPrivate: false,
      isFork: false,
      isArchived: false,
      url: `https://github.com/octo/${name}`,
      pushedAt,
      viewerPermission: 'ADMIN',
      primaryLanguage: { name: 'TypeScript' },
      pullRequests: { totalCount: 2 },
      issues: { totalCount: 5 },
      defaultBranchRef: { name: 'main', target: { statusCheckRollup: { state: 'FAILURE' } } },
      ...extra,
    });
    await sandbox.ghRules([
      {
        args: ['api', 'graphql'],
        stdin: ['repositories(first', '"after":"CURSOR-2"'],
        ...ok({ data: { viewer: { repositories: { totalCount: 3, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [repository('oldest', '2026-01-01T00:00:00Z', { isArchived: true, isPrivate: true, defaultBranchRef: null })] } } } }),
      },
      {
        args: ['api', 'graphql'],
        stdin: ['repositories(first'],
        ...ok({ data: { viewer: { repositories: { totalCount: 3, pageInfo: { hasNextPage: true, endCursor: 'CURSOR-2' }, nodes: [repository('newest', '2026-10-10T00:00:00Z'), repository('middle', '2026-06-01T00:00:00Z', { isFork: true })] } } } }),
      },
    ]);
    const first = (await owner.get<GithubRepositories>('/api/github/repositories?limit=2')).body;
    expect(first).toMatchObject({ totalCount: 3, nextCursor: 'CURSOR-2' });
    expect(first.repositories.map((entry) => entry.name)).toEqual(['newest', 'middle']);
    expect(first.repositories[0]).toMatchObject({ owner: 'octo', description: 'About newest', private: false, fork: false, archived: false, defaultBranch: 'main', language: 'TypeScript', openPullRequests: 2, openIssues: 5, checks: 'failing' });
    const second = (await owner.get<GithubRepositories>(`/api/github/repositories?limit=2&cursor=${first.nextCursor}`)).body;
    expect(second).toMatchObject({ nextCursor: null });
    expect(second.repositories[0]).toMatchObject({ name: 'oldest', archived: true, private: true, defaultBranch: null, checks: 'none' });
    const sent = (await sandbox.ghCalls()).map((call) => (JSON.parse(call.stdin) as { query: string; variables: unknown }));
    expect(sent.map((request) => request.variables)).toEqual([{ first: 2, after: null }, { first: 2, after: 'CURSOR-2' }]);
    expect(sent[0]!.query).toContain('ownerAffiliations: OWNER');
    expect(sent[0]!.query).toContain('field: PUSHED_AT, direction: DESC');
  });

  it('shows a repository page: facts, latest commit with checks, open pull requests, recent merges', async () => {
    await sandbox.ghRules([
      {
        args: ['api', 'graphql'],
        stdin: ['open: pullRequests', '"owner":"octo"', '"name":"demo"'],
        ...ok({
          data: {
            repository: {
              name: 'demo',
              owner: { login: 'octo' },
              description: 'd'.repeat(400),
              isPrivate: true,
              isFork: false,
              isArchived: false,
              url: 'javascript:alert(1)',
              pushedAt: '2026-10-10T00:00:00Z',
              viewerPermission: 'READ',
              primaryLanguage: null,
              pullRequests: { totalCount: 31 },
              issues: { totalCount: 0 },
              defaultBranchRef: { name: 'trunk', target: { oid: HEAD, messageHeadline: 'Fix the build', committedDate: '2026-10-10T00:00:00Z', author: { name: 'Alice A', user: { login: 'alice' } }, statusCheckRollup: contexts([check('build', 'SUCCESS', false), check('deploy', null, false, 'QUEUED')]) } },
              open: { totalCount: 31, nodes: [rawPull(), null] },
              merged: { nodes: [{ number: 5, title: 'Earlier work', url: 'https://github.com/octo/demo/pull/5', mergedAt: '2026-10-09T00:00:00Z', author: { login: 'bob' } }] },
            },
          },
        }),
      },
    ]);
    const page = (await owner.get<GithubRepositoryPage>('/api/github/repositories/octo/demo')).body;
    expect(page.repository).toMatchObject({ owner: 'octo', name: 'demo', private: true, defaultBranch: 'trunk', checks: 'pending', url: 'https://github.com/octo/demo' });
    expect(page.repository.description).toHaveLength(300);
    expect(page.canWrite).toBe(false);
    expect(page.latestCommit).toMatchObject({ oid: HEAD, title: 'Fix the build', author: 'alice', checks: { state: 'pending', total: 2, passing: 1, pending: 1 } });
    expect(page.pulls.map((pull) => pull.number)).toEqual([7]);
    expect(page.pullCount).toBe(31);
    expect(page.recentMerges).toEqual([{ number: 5, title: 'Earlier work', url: 'https://github.com/octo/demo/pull/5', author: 'bob', mergedAt: Date.parse('2026-10-09T00:00:00Z') }]);
  });

  it('describes one pull request for the sheet: facts, ordered checks, files, blockers and when to look again', async () => {
    const longBody = `${'A sentence about the change. '.repeat(80)}\nTail that must be cut.`;
    await sandbox.ghRules(
      pullRules(
        rawPull({
          bodyText: longBody,
          mergeStateStatus: 'BLOCKED',
          reviewDecision: 'CHANGES_REQUESTED',
          files: { totalCount: 140, nodes: [{ path: 'a.ts', additions: 1, deletions: 0, changeType: 'ADDED' }, { path: 'b.ts', additions: 0, deletions: 4, changeType: 'DELETED' }, { path: 'c.ts', additions: 0, deletions: 0, changeType: 'RENAMED' }, null] },
          ...withChecks([
            check('passing', 'SUCCESS', true),
            check('running', null, true, 'IN_PROGRESS'),
            check('optional-failing', 'FAILURE', false),
            check('required-failing', 'TIMED_OUT', true),
            check('skipped', 'SKIPPED', false),
            { __typename: 'StatusContext', context: 'legacy/status', state: 'PENDING', targetUrl: 'http://insecure.example/log', isRequired: false },
          ]),
        }),
      ),
    );
    const response = await owner.get<GithubPullDetail>(PULL);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const pull = response.body;
    expect(pull).toMatchObject({ owner: 'octo', repo: 'demo', number: 7, state: 'open', title: 'Add the thing', author: 'alice', headSha: HEAD, canMerge: true, crossRepository: false, mergeQueue: false, deleteBranchOnMerge: false, mergeCommit: null });
    expect(pull.mergeMethods).toEqual(['squash', 'merge']);
    // Failing first, then pending, passing, skipped; required ones first within each group.
    expect(pull.checkRuns.map((run) => [run.name, run.state, run.required])).toEqual([
      ['required-failing', 'failing', true],
      ['optional-failing', 'failing', false],
      ['running', 'pending', true],
      ['legacy/status', 'pending', false],
      ['passing', 'passing', true],
      ['skipped', 'skipped', false],
    ]);
    expect(pull.checkRuns[0]).toMatchObject({ workflow: 'CI', url: 'https://github.com/octo/demo/actions/runs/1/job/required-failing' });
    // Only https log links are passed on.
    expect(pull.checkRuns.find((run) => run.name === 'legacy/status')!.url).toBeNull();
    expect(pull.checks).toMatchObject({ state: 'failing', total: 6, failing: 2, pending: 2, passing: 1, skipped: 1 });
    expect(pull.files).toEqual([
      { path: 'a.ts', status: 'A', additions: 1, deletions: 0 },
      { path: 'b.ts', status: 'D', additions: 0, deletions: 4 },
      { path: 'c.ts', status: 'R', additions: 0, deletions: 0 },
    ]);
    expect(pull.filesTruncated).toBe(true);
    expect(pull.bodyTruncated).toBe(true);
    expect(pull.body.length).toBeLessThanOrEqual(1600);
    expect(pull.body.endsWith('.')).toBe(true);
    expect(pull.blockers.map((blocker) => blocker.code)).toEqual(['required_checks_failed', 'required_checks_pending']);
    expect(pull.blockers.every((blocker) => blocker.message.length > 10)).toBe(true);
    expect(pull.optionalChecksFailing).toBe(true);
    expect(pull.fixes).toEqual({ updateBranch: false, markReady: false, approveRuns: false });
    // Checks are still running: read again soon.
    expect(pull.pollAfterMs).toBe(15_000);
    expect((JSON.parse((await sandbox.ghCalls())[0]!.stdin) as { variables: unknown }).variables).toEqual({ owner: 'octo', name: 'demo', number: 7 });

    await sandbox.ghRules(pullRules(rawPull()));
    const settled = (await owner.get<GithubPullDetail>(`${PULL}?refresh=true`)).body;
    expect(settled).toMatchObject({ blockers: [], optionalChecksFailing: false, pollAfterMs: null });
  });

  it('serves what it has, marked stale, when GitHub cannot be reached — and maps each failure to its own answer', async () => {
    await sandbox.ghRules(pullRules(rawPull()));
    expect((await owner.get<GithubPullDetail>(PULL)).body.freshness.stale).toBe(false);

    const unreachable: GhRule = { args: ['api', 'graphql'], stderr: 'error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com\n', code: 1 };
    await sandbox.ghRules([unreachable]);
    const stale = (await owner.get<GithubPullDetail>(`${PULL}?refresh=true`)).body;
    expect(stale).toMatchObject({ number: 7, freshness: { stale: true } });
    expect(stale.freshness.staleReason).toMatch(/cannot reach GitHub/);
    // Without anything to fall back on, the failure itself is the answer.
    expect(errorOf(await owner.get('/api/github/inbox'))).toEqual([502, 'github_unreachable']);

    const cases: Array<[GhRule, [number, string]]> = [
      [{ args: ['api'], ...failed(404, 'Not Found') }, [404, 'github_not_found']],
      [{ args: ['api'], ...failed(401, 'Bad credentials') }, [409, 'github_expired']],
      [{ args: ['api'], stderr: 'To get started with GitHub CLI, please run:  gh auth login\n', code: 4 }, [409, 'github_signed_out']],
      [{ args: ['api'], ...failed(403, 'API rate limit exceeded for user ID 1.', { 'X-Ratelimit-Remaining': '0', 'Retry-After': '30' }) }, [429, 'github_rate_limited']],
      [{ args: ['api'], ...failed(403, 'Resource protected by organization SAML enforcement.', { 'X-Github-Sso': 'required; url=https://github.com/orgs/x/sso?authorization_request=SECRET' }) }, [403, 'github_sso_required']],
      [{ args: ['api'], ...failed(403, 'Resource not accessible by personal access token') }, [403, 'github_forbidden']],
      [{ args: ['api'], ...failed(500, `Server Error with token ${SECRETS[1]} at ${SECRETS[2]}`) }, [502, 'github_failed']],
      [{ args: ['api'], stdout: http(200, { data: null, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a Repository' }] }), stderr: 'gh: Could not resolve to a Repository\n', code: 1 }, [404, 'github_not_found']],
      [{ args: ['api'], stdout: http(200, { data: { repository: null }, errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] }), code: 1 }, [429, 'github_rate_limited']],
      [{ args: ['api'], stdout: 'not http at all', code: 0 }, [502, 'github_failed']],
    ];
    for (const [rule, expected] of cases) {
      await sandbox.ghRules([rule]);
      const response = await owner.get('/api/github/repositories/octo/fresh');
      expect(errorOf(response), JSON.stringify(rule).slice(0, 80)).toEqual(expected);
      const text = JSON.stringify(response.body);
      for (const secret of [...SECRETS, 'authorization_request']) expect(text).not.toContain(secret);
    }
  });

  it('gives up on a call that takes too long, and refuses new work when too much is already waiting', async () => {
    const github = t.studio.context.services.github;
    github.gh.timeouts.read = 400;
    await sandbox.ghRules([{ args: ['api'], sleepMs: 5000, ...ok({ data: {} }) }]);
    const started = Date.now();
    expect(errorOf(await owner.get('/api/github/inbox'))).toEqual([504, 'github_timeout']);
    expect(Date.now() - started).toBeLessThan(4000);

    github.gh.timeouts.read = 20_000;
    await sandbox.ghRules([{ args: ['api'], sleepMs: 250, ...ok({ data: { repository: null }, errors: [{ type: 'NOT_FOUND', message: 'nope' }] }) }]);
    const answers = await Promise.all(Array.from({ length: 40 }, (_, index) => owner.get(`/api/github/repositories/octo/repo-${index}`)));
    const codes = answers.map((answer) => errorOf(answer)[1]);
    // Three run at a time and two dozen may wait; the rest are told to come back.
    expect(codes.filter((code) => code === 'github_busy')).toHaveLength(13);
    expect(codes.filter((code) => code === 'github_not_found')).toHaveLength(27);
    expect(answers.find((answer) => errorOf(answer)[1] === 'github_busy')!.status).toBe(503);
  });

  it('shares one call between identical requests made at the same time', async () => {
    await sandbox.ghRules([{ args: ['api', 'graphql'], stdin: ['authored: search'], sleepMs: 200, ...ok({ data: { authored: { issueCount: 0, nodes: [] }, review: { issueCount: 0, nodes: [] }, own: { issueCount: 0, nodes: [] } } }) }]);
    const answers = await Promise.all(Array.from({ length: 6 }, () => owner.get<GithubInbox>('/api/github/inbox')));
    expect(answers.every((answer) => answer.status === 200)).toBe(true);
    expect(await sandbox.ghCalls()).toHaveLength(1);
  });
});

describe('guarded merge', () => {
  it('merges what the user saw, by the chosen method, and records it', async () => {
    await sandbox.ghRules([...pullRules(rawPull()), MERGED_OK]);
    const events: StudioEvent[] = [];
    t.studio.context.bus.onTopic(`user:${owner.userId}`, (event) => events.push(event));

    const merged = await merge();
    expect(merged.status, JSON.stringify(merged.body)).toBe(200);
    expect(merged.body).toEqual({ outcome: 'merged', mergeCommit: MERGE_COMMIT, message: 'Merged #7 into main (squash).', branchDeleted: null });

    // Exactly one change was sent to GitHub: the merge, pinned to the commit that was reviewed.
    const sent = await writes();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.args.join(' ')).toBe('api --hostname github.com --include --method PUT -H Accept: application/vnd.github+json --input - repos/octo/demo/pulls/7/merge');
    expect(JSON.parse(sent[0]!.stdin)).toEqual({ merge_method: 'squash', sha: HEAD });
    // The decision was made on a read taken just before, not on anything cached.
    const calls = await sandbox.ghCalls();
    expect(calls.findIndex((call) => call.stdin.includes('pullRequest(number'))).toBeLessThan(calls.findIndex(isWrite));
    for (const call of calls) expect(`${call.args.join(' ')} ${call.stdin}`).not.toMatch(/--admin|--auto|enablePullRequestAutoMerge|bypass/i);

    expect(await log()).toMatchObject([{ action: 'merge', owner: 'octo', repo: 'demo', number: 7, method: 'squash', headSha: HEAD, outcome: 'merged', message: 'Merged #7 into main (squash).' }]);
    const audit = t.studio.context.services.audit.list({ limit: 50 }).filter((event) => event.action === 'github.merge');
    expect(audit.map((event) => [event.category, event.subject, (JSON.parse(event.detail) as { o: string }).o])).toEqual([
      ['change', 'octo/demo#7', 'merged'],
      ['change', 'octo/demo#7', 'started'],
    ]);
    expect(events.find((event) => event.type === 'github.changed')?.data).toEqual({ owner: 'octo', repo: 'demo', number: 7 });
  });

  it('hides a merged pull request from the lists at once, although GitHub’s search still returns it', async () => {
    const stillListed = { args: ['api', 'graphql'], stdin: ['authored: search'], ...ok({ data: { authored: { issueCount: 2, nodes: [rawPull(), rawPull({ number: 9 })] }, review: { issueCount: 0, nodes: [] }, own: { issueCount: 0, nodes: [] } } }) };
    await sandbox.ghRules([stillListed, ...pullRules(rawPull()), MERGED_OK]);
    expect((await owner.get<GithubInbox>('/api/github/inbox')).body.pulls.map((pull) => pull.number)).toEqual([7, 9]);
    expect((await merge()).status).toBe(200);
    const after = (await owner.get<GithubInbox>('/api/github/inbox')).body;
    expect(after.pulls.map((pull) => pull.number)).toEqual([9]);
    expect(after.counts.all).toBe(1);
    expect((await owner.get<GithubInbox>('/api/github/inbox?refresh=true')).body.pulls.map((pull) => pull.number)).toEqual([9]);
  });

  const blocked: Array<[string, Record<string, unknown>, Record<string, unknown> | undefined, string]> = [
    ['is closed', { state: 'CLOSED' }, undefined, 'not_open'],
    ['is already merged', { state: 'MERGED', mergeCommit: { oid: MERGE_COMMIT } }, undefined, 'not_open'],
    ['is a draft', { isDraft: true, mergeStateStatus: 'DRAFT' }, undefined, 'draft'],
    ['cannot be merged by this login', {}, { viewerPermission: 'READ' }, 'no_permission'],
    ['has conflicts', { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }, undefined, 'conflicts'],
    ['is still being checked for mergeability', { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }, undefined, 'checking'],
    ['has a failing required check', { mergeStateStatus: 'BLOCKED', ...withChecks([check('build', 'FAILURE', true)]) }, undefined, 'required_checks_failed'],
    ['has a required check still running', { mergeStateStatus: 'BLOCKED', ...withChecks([check('build', null, true, 'IN_PROGRESS')]) }, undefined, 'required_checks_pending'],
    ['is behind its base', { mergeStateStatus: 'BEHIND' }, undefined, 'behind'],
    ['is blocked by branch rules, even for an administrator', { mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED' }, { viewerPermission: 'ADMIN' }, 'blocked'],
    ['is in a repository that allows no merge method', {}, { mergeCommitAllowed: false, squashMergeAllowed: false, rebaseMergeAllowed: false }, 'no_merge_method'],
    ['has more checks than could be read', withChecks([check('build', 'SUCCESS', true)], true), undefined, 'incomplete'],
    ['came back without a mergeability verdict', { mergeable: null, mergeStateStatus: null }, undefined, 'incomplete'],
  ];
  it.each(blocked)('refuses a pull request that %s', async (_what, pull, repo, blocker) => {
    await sandbox.ghRules([...pullRules(rawPull(pull), repo ? { repo } : {}), MERGED_OK]);
    // The same verdict is shown before anyone presses the button…
    const shown = (await owner.get<GithubPullDetail>(PULL)).body;
    expect(shown.blockers[0]?.code).toBe(blocker);
    // …and a direct request is refused with it, whatever it claims to acknowledge.
    for (const extra of [{}, { acknowledgeFailingChecks: true }, { admin: true, force: true, bypass: true, auto: true }]) {
      const refused = await merge(extra);
      expect(errorOf(refused)).toEqual([409, 'github_merge_refused']);
      expect(detailsOf(refused).details.blocker).toBe(blocker);
      expect(detailsOf(refused).message).toBe(shown.blockers[0]!.message.replace('This pull request is not open.', detailsOf(refused).message));
    }
    expect(await writes()).toEqual([]);
    const entries = await log();
    expect(entries).toHaveLength(3);
    expect(entries.every((entry) => entry.outcome === 'refused' && entry.number === 7 && entry.method === 'squash')).toBe(true);
  });

  it('refuses when GitHub’s answer came with errors, because half an answer is no basis for merging', async () => {
    await sandbox.ghRules([...pullRules(rawPull(), { errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible' }] }), MERGED_OK]);
    const refused = await merge();
    expect(errorOf(refused)).toEqual([409, 'github_merge_refused']);
    expect(detailsOf(refused).details.blocker).toBe('incomplete');
    expect(await writes()).toEqual([]);
  });

  it('refuses when the head moved since the user looked, naming the new commit', async () => {
    await sandbox.ghRules([...pullRules(rawPull({ headRefOid: MOVED })), MERGED_OK]);
    const refused = await merge({ headSha: HEAD });
    expect(errorOf(refused)).toEqual([409, 'github_head_moved']);
    expect(detailsOf(refused).message).toContain('bbbbbbb');
    expect(detailsOf(refused).details.headSha).toBe(MOVED);
    expect(await writes()).toEqual([]);
    expect(await log()).toMatchObject([{ outcome: 'refused', headSha: HEAD }]);
  });

  it('uses only a method the repository allows, and needs an explicit yes when optional checks fail', async () => {
    await sandbox.ghRules([...pullRules(rawPull({ mergeStateStatus: 'UNSTABLE', ...withChecks([check('build', 'SUCCESS', true), check('flaky', 'FAILURE', false)]) })), MERGED_OK]);
    expect(errorOf(await merge({ method: 'rebase' }))).toEqual([400, 'github_method_not_allowed']);

    const unacknowledged = await merge();
    expect(errorOf(unacknowledged)).toEqual([409, 'github_merge_refused']);
    expect(detailsOf(unacknowledged).details.blocker).toBe('optional_checks_failing');
    expect(await writes()).toEqual([]);

    const acknowledged = await merge({ method: 'merge', acknowledgeFailingChecks: true });
    expect(acknowledged.status, JSON.stringify(acknowledged.body)).toBe(200);
    expect(JSON.parse((await writes())[0]!.stdin)).toEqual({ merge_method: 'merge', sha: HEAD });
    expect((await log()).map((entry) => entry.outcome)).toEqual(['merged', 'refused', 'refused']);
  });

  it('deletes the branch afterwards only when asked, and never one in a fork', async () => {
    const deleted: GhRule = { args: ['api', '--method DELETE', 'repos/octo/demo/git/refs/heads/feature/thing'], stdout: http(204, null) };
    await sandbox.ghRules([...pullRules(rawPull()), MERGED_OK, deleted]);
    expect((await merge({ deleteBranch: true })).body).toMatchObject({ outcome: 'merged', branchDeleted: true });
    expect((await writes()).map((call) => call.args.at(-1))).toEqual(['repos/octo/demo/pulls/7/merge', 'repos/octo/demo/git/refs/heads/feature/thing']);

    await sandbox.ghForget();
    await sandbox.ghRules([...pullRules(rawPull({ isCrossRepository: true, headRefName: 'main' })), MERGED_OK, deleted]);
    expect((await merge({ deleteBranch: true })).body).toMatchObject({ outcome: 'merged', branchDeleted: false });
    expect((await writes()).map((call) => call.args.at(-1))).toEqual(['repos/octo/demo/pulls/7/merge']);
  });

  it('reports truthfully when GitHub itself says no, or does not answer', async () => {
    await sandbox.ghRules([...pullRules(rawPull()), { args: ['api', '--method PUT', 'pulls/7/merge'], ...failed(405, 'Required status check "build" is expected. You can use --admin to bypass.') }]);
    const refused = await merge();
    expect(errorOf(refused)).toEqual([409, 'github_merge_refused']);
    expect(detailsOf(refused).message).toContain('Required status check');
    // Advice on how to get round the refusal is not passed on.
    expect(JSON.stringify(refused.body)).not.toMatch(/--admin|bypass/);

    await sandbox.ghRules([...pullRules(rawPull()), { args: ['api', '--method PUT', 'pulls/7/merge'], ...failed(409, 'Head branch was modified. Review and try the merge again.') }]);
    expect(errorOf(await merge())).toEqual([409, 'github_head_moved']);

    t.studio.context.services.github.gh.timeouts.merge = 500;
    await sandbox.ghRules([...pullRules(rawPull()), { args: ['api', '--method PUT', 'pulls/7/merge'], sleepMs: 5000, ...ok({ merged: true }) }]);
    const unknown = await merge();
    expect(errorOf(unknown)).toEqual([504, 'github_outcome_unknown']);
    expect(detailsOf(unknown).message).toMatch(/may or may not have happened/);
    expect((await log()).map((entry) => entry.outcome)).toEqual(['unknown', 'refused', 'refused']);
  });

  it('lets only one action on a pull request run at a time', async () => {
    await sandbox.ghRules([...pullRules(rawPull()), { ...MERGED_OK, sleepMs: 600 }]);
    const [first, second] = await Promise.all([merge(), new Promise<Awaited<ReturnType<typeof merge>>>((resolve) => setTimeout(() => resolve(merge()), 150))]);
    expect(first.status).toBe(200);
    expect(errorOf(second)).toEqual([409, 'github_action_in_progress']);
    expect(await writes()).toHaveLength(1);
    expect((await log()).map((entry) => entry.outcome).sort()).toEqual(['merged', 'refused']);
  });

  it('enters the merge queue where the base branch has one, instead of merging directly', async () => {
    await sandbox.ghRules([
      { args: ['api', 'graphql'], stdin: ['enqueuePullRequest'], ...ok({ data: { enqueuePullRequest: { mergeQueueEntry: { id: 'MQE_1' } } } }) },
      ...pullRules(rawPull({ mergeStateStatus: 'BLOCKED' }), { queue: true }),
      MERGED_OK,
    ]);
    const shown = (await owner.get<GithubPullDetail>(PULL)).body;
    expect(shown).toMatchObject({ mergeQueue: true, blockers: [] });
    const queued = await merge();
    expect(queued.body).toMatchObject({ outcome: 'queued', mergeCommit: null });
    const sent = await writes();
    expect(sent).toHaveLength(1);
    expect((JSON.parse(sent[0]!.stdin) as { variables: unknown }).variables).toEqual({ id: 'PR_kwDOnode7', head: HEAD });
    expect(await log()).toMatchObject([{ outcome: 'queued' }]);
  });

  it('does nothing at all when the attempt cannot be recorded first', async () => {
    await sandbox.ghRules([...pullRules(rawPull()), MERGED_OK]);
    const audit = t.studio.context.services.audit;
    const record = audit.record.bind(audit);
    audit.record = () => {
      throw new Error('disk full');
    };
    try {
      const response = await merge();
      expect(response.status).toBeGreaterThanOrEqual(500);
      expect(await sandbox.ghCalls()).toEqual([]);
    } finally {
      audit.record = record;
    }
  });

  it('belongs to the owner’s browser session: not to members, not to API tokens, not to strangers', async () => {
    await sandbox.ghRules([SIGNED_IN, ...pullRules(rawPull()), MERGED_OK]);
    const member = await t.member('alice');
    const token = (await owner.post<{ token: string }>('/api/auth/tokens', { name: 'automation', scopes: ['read', 'write', 'admin'] })).body.token;
    const viaToken = t.anonymous();
    viaToken.bearer = token;

    for (const route of ['merge', 'update-branch', 'ready', 'approve-runs']) {
      const body = { method: 'squash', headSha: HEAD, runIds: [1] };
      expect((await t.anonymous().post(`${PULL}/${route}`, body)).status, route).toBe(401);
      expect(errorOf(await member.post(`${PULL}/${route}`, body)), route).toEqual([403, 'owner_required']);
      expect(errorOf(await viaToken.post(`${PULL}/${route}`, body)), route).toEqual([403, 'session_required']);
    }
    for (const route of ['account', 'inbox', 'repositories', 'repositories/octo/demo', 'repositories/octo/demo/pulls/7', 'ci', 'actions']) {
      expect((await t.anonymous().get(`/api/github/${route}`)).status, route).toBe(401);
      expect(errorOf(await member.get(`/api/github/${route}`)), route).toEqual([403, 'owner_required']);
    }
    expect(await sandbox.ghCalls()).toEqual([]);
    // A token may read on the owner's behalf.
    expect((await viaToken.get('/api/github/account')).status).toBe(200);
    // A member's own log is empty; they never see the owner's attempts.
    await merge();
    expect(await log()).toHaveLength(1);
    expect(t.studio.context.services.github.actionLog(member.userId!, { limit: 20, action: 'all' }).entries).toEqual([]);
  });
});

describe('small fixes', () => {
  it('updates a branch that is behind, pinned to the head the user saw', async () => {
    const updated: GhRule = { args: ['api', '--method PUT', 'pulls/7/update-branch'], stdout: http(202, { message: 'Updating pull request branch.' }) };
    await sandbox.ghRules([...pullRules(rawPull({ mergeStateStatus: 'BEHIND' })), updated]);
    expect((await owner.get<GithubPullDetail>(PULL)).body.fixes).toEqual({ updateBranch: true, markReady: false, approveRuns: false });

    expect(errorOf(await owner.post(`${PULL}/update-branch`, { headSha: MOVED }))).toEqual([409, 'github_head_moved']);
    expect(errorOf(await owner.post(`${PULL}/update-branch`, {}))).toEqual([400, 'invalid_request']);
    expect(await writes()).toEqual([]);

    const done = await owner.post<GithubFixResult>(`${PULL}/update-branch`, { headSha: HEAD });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.message).toContain('feature/thing');
    expect(done.body.pull).toMatchObject({ number: 7, freshness: { stale: false } });
    const sent = await writes();
    expect(sent.map((call) => call.args.at(-1))).toEqual(['repos/octo/demo/pulls/7/update-branch']);
    expect(JSON.parse(sent[0]!.stdin)).toEqual({ expected_head_sha: HEAD });

    // Not behind: nothing to do, and nothing is done.
    await sandbox.ghForget();
    await sandbox.ghRules([...pullRules(rawPull()), updated]);
    expect(errorOf(await owner.post(`${PULL}/update-branch`, { headSha: HEAD }))).toEqual([409, 'github_fix_not_applicable']);
    expect(await writes()).toEqual([]);
    expect((await log('all')).map((entry) => [entry.action, entry.outcome])).toEqual([
      ['update_branch', 'refused'],
      ['update_branch', 'done'],
      ['update_branch', 'invalid'],
      ['update_branch', 'refused'],
    ]);
    // The merge log proper lists merges only.
    expect(await log('merge')).toEqual([]);
  });

  it('marks a draft as ready, and only a draft', async () => {
    const ready: GhRule = { args: ['api', 'graphql'], stdin: ['markPullRequestReadyForReview'], ...ok({ data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } }) };
    await sandbox.ghRules([ready, ...pullRules(rawPull())]);
    expect(errorOf(await owner.post(`${PULL}/ready`))).toEqual([409, 'github_fix_not_applicable']);
    expect(await writes()).toEqual([]);

    await sandbox.ghRules([ready, ...pullRules(rawPull({ isDraft: true, mergeStateStatus: 'DRAFT' }))]);
    const done = await owner.post<GithubFixResult>(`${PULL}/ready`);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const sent = await writes();
    expect(sent).toHaveLength(1);
    expect((JSON.parse(sent[0]!.stdin) as { variables: unknown }).variables).toEqual({ id: 'PR_kwDOnode7' });
  });

  it('approves only workflow runs that a fresh read lists as waiting for this pull request', async () => {
    const waiting = { args: ['api', `actions/runs?head_sha=${HEAD}&status=action_required`], ...ok({ workflow_runs: [{ id: 101, name: 'CI', html_url: 'https://github.com/octo/demo/actions/runs/101' }, { id: 102, name: 'Docs', html_url: 'https://github.com/octo/demo/actions/runs/102' }] }) };
    const approve = (id: number, rule: GhRule = { stdout: http(201, {}) }): GhRule => ({ args: ['api', '--method POST', `repos/octo/demo/actions/runs/${id}/approve`], ...rule });
    const fromFork = rawPull({ isCrossRepository: true });
    await sandbox.ghRules([waiting, approve(101), approve(102), approve(999), ...pullRules(fromFork)]);

    const shown = (await owner.get<GithubPullDetail>(PULL)).body;
    expect(shown.pendingRuns).toEqual([{ id: 101, name: 'CI', url: 'https://github.com/octo/demo/actions/runs/101' }, { id: 102, name: 'Docs', url: 'https://github.com/octo/demo/actions/runs/102' }]);
    expect(shown.fixes.approveRuns).toBe(true);

    // One run that is not waiting spoils the whole request: nothing is approved.
    const refused = await owner.post(`${PULL}/approve-runs`, { runIds: [101, 999] });
    expect(errorOf(refused)).toEqual([409, 'github_fix_not_applicable']);
    expect(detailsOf(refused).details.notWaiting).toEqual([999]);
    for (const runIds of [[], [101, 101], ['101'], [0], [-5], Array.from({ length: 21 }, (_, i) => i + 1), [1.5]]) {
      expect(errorOf(await owner.post(`${PULL}/approve-runs`, { runIds })), JSON.stringify(runIds)).toEqual([400, 'invalid_request']);
    }
    expect(await writes()).toEqual([]);

    const done = await owner.post<GithubFixResult>(`${PULL}/approve-runs`, { runIds: [102, 101] });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.message).toBe('Approved 2 workflow run(s).');
    expect((await writes()).map((call) => call.args.at(-1))).toEqual(['repos/octo/demo/actions/runs/102/approve', 'repos/octo/demo/actions/runs/101/approve']);

    // When one of them fails part-way, the answer says how far it got.
    await sandbox.ghForget();
    await sandbox.ghRules([waiting, approve(101), approve(102, failed(403, 'Resource not accessible by integration')), ...pullRules(fromFork)]);
    const partial = await owner.post(`${PULL}/approve-runs`, { runIds: [101, 102] });
    expect(errorOf(partial)).toEqual([403, 'github_forbidden']);
    expect(detailsOf(partial).message).toMatch(/^1 of 2 run\(s\) were approved/);
    expect(detailsOf(partial).details).toMatchObject({ approved: [101], failed: 102 });
  });
});

describe('the pull request of a project’s branch', () => {
  async function projectWithRemote(name: string, remoteUrl: string | null, branch = 'feature/thing'): Promise<Project> {
    const dir = path.join(t.workspace, name);
    await sandbox.repo(dir);
    if (remoteUrl !== null) await sandbox.git(dir, 'remote', 'add', 'origin', remoteUrl);
    await sandbox.git(dir, 'switch', '--quiet', '-c', branch);
    return (await owner.post<Project>('/api/projects', { name, rootDir: dir })).body;
  }
  const branchRule = (nodes: unknown[]): GhRule => ({ args: ['api', 'graphql'], stdin: ['headRefName: $branch'], ...ok({ data: { repository: { pullRequests: { nodes } } } }) });
  const lookup = (project: Project, client: TestClient = owner, query = '') => client.get<GithubBranchPull>(`/api/projects/${project.id}/github/pull-request${query}`);

  it('finds the open pull request of the checked-out branch and sums it up in one word', async () => {
    const project = await projectWithRemote('with-pr', 'https://github.com/octo/demo.git');
    await sandbox.ghRules([branchRule([rawPull({ isCrossRepository: true, number: 99 }), rawPull({ mergeStateStatus: 'BEHIND' })])]);
    const found = (await lookup(project)).body;
    expect(found).toMatchObject({ result: 'found', owner: 'octo', repo: 'demo', branch: 'feature/thing', verdict: 'behind', pull: { number: 7, title: 'Add the thing' } });
    expect((JSON.parse((await sandbox.ghCalls())[0]!.stdin) as { variables: unknown }).variables).toEqual({ owner: 'octo', name: 'demo', branch: 'feature/thing' });
    // Cached per project and branch.
    await lookup(project);
    expect(await sandbox.ghCalls()).toHaveLength(1);

    const verdicts: Array<[Record<string, unknown>, string]> = [
      [{ isDraft: true }, 'draft'],
      [{ mergeable: 'CONFLICTING' }, 'conflicts'],
      [withChecks([check('build', 'FAILURE', false)]), 'checks_failed'],
      [withChecks([check('build', null, false, 'QUEUED')]), 'checks_running'],
      [{ reviewDecision: 'CHANGES_REQUESTED' }, 'changes_requested'],
      [{ reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'BLOCKED' }, 'review_required'],
      [{ mergeStateStatus: 'BLOCKED' }, 'blocked'],
      [{ mergeable: 'UNKNOWN' }, 'checking'],
      [{}, 'mergeable'],
    ];
    for (const [overrides, verdict] of verdicts) {
      await sandbox.ghRules([branchRule([rawPull(overrides)])]);
      expect((await lookup(project, owner, '?refresh=true')).body.verdict, verdict).toBe(verdict);
    }
  });

  it('answers with a reason to show nothing — never with an error — whatever is missing', async () => {
    await sandbox.ghRules([branchRule([])]);
    expect((await lookup(await projectWithRemote('no-pr', 'git@github.com:octo/demo.git'))).body).toMatchObject({ result: 'none', owner: 'octo', repo: 'demo', pull: null, verdict: null });
    // Only a pull request from the same repository counts; one from a fork with the same branch name does not.
    await sandbox.ghRules([branchRule([rawPull({ isCrossRepository: true })])]);
    expect((await lookup(await projectWithRemote('fork-pr', 'https://github.com/octo/other.git'))).body.result).toBe('none');

    await sandbox.ghForget();
    expect((await lookup(await projectWithRemote('elsewhere', 'https://gitlab.com/octo/demo.git'))).body).toMatchObject({ result: 'not_github', branch: 'feature/thing' });
    expect((await lookup(await projectWithRemote('lookalike', 'https://github.com.evil.example/octo/demo.git'))).body.result).toBe('not_github');
    expect((await lookup(await projectWithRemote('no-remote', null))).body.result).toBe('no_remote');
    const detached = await projectWithRemote('detached', 'https://github.com/octo/demo.git');
    await sandbox.git(detached.rootDir, 'checkout', '--quiet', '--detach');
    expect((await lookup(detached)).body.result).toBe('detached');
    const plain = (await owner.post<Project>('/api/projects', { name: 'plain', rootDir: path.join(t.workspace, 'plain'), createDirectory: true })).body;
    expect((await lookup(plain)).body.result).toBe('not_a_repository');
    // None of these needed GitHub at all.
    expect(await sandbox.ghCalls()).toEqual([]);

    // GitHub signed out, unreachable or failing: still just "nothing to show".
    const project = await projectWithRemote('unavailable', 'https://github.com/octo/demo.git');
    for (const rule of [{ args: ['api'], stderr: 'To get started with GitHub CLI, please run:  gh auth login\n', code: 4 }, { args: ['api'], stderr: 'error connecting to api.github.com\n', code: 1 }, { args: ['api'], ...failed(500, 'boom') }]) {
      await sandbox.ghRules([rule]);
      const response = await lookup(project, owner, '?refresh=true');
      expect([response.status, response.body.result]).toEqual([200, 'unavailable']);
    }
    await sandbox.ghRules([{ args: ['api'], stdout: http(200, { data: { repository: null }, errors: [{ type: 'NOT_FOUND', message: 'nope' }] }), code: 1 }]);
    expect((await lookup(project, owner, '?refresh=true')).body.result).toBe('none');
  });

  it('never sends a branch name to GitHub that is not a plain branch name', async () => {
    const project = await projectWithRemote('odd-branch', 'https://github.com/octo/demo.git', 'odd;$(name)');
    await sandbox.ghRules([branchRule([rawPull()])]);
    expect((await lookup(project)).body).toMatchObject({ result: 'none', branch: 'odd;$(name)' });
    expect(await sandbox.ghCalls()).toEqual([]);
  });

  it('tells members nothing and strangers that there is no such project', async () => {
    const project = await projectWithRemote('shared', 'https://github.com/octo/demo.git');
    await sandbox.ghRules([branchRule([rawPull()])]);
    const member = await t.member('alice');
    const stranger = await t.member('stranger');
    await owner.put(`/api/projects/${project.id}/members/${member.userId}`, { access: 'write' });
    expect((await lookup(project, member)).body).toEqual({ result: 'owner_only', owner: null, repo: null, branch: null, pull: null, verdict: null, freshness: null });
    expect(await sandbox.ghCalls()).toEqual([]);
    expect((await lookup(project, stranger)).status).toBe(404);
    expect((await lookup(project, t.anonymous())).status).toBe(401);
    expect((await lookup(project)).body.result).toBe('found');
  });
});

describe('CI runs', () => {
  it('reads the runs of recently pushed repositories: running first, then queued, then the newest finished', async () => {
    const now = Date.now();
    const iso = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
    const repository = (name: string, pushedDaysAgo: number, archived = false) => ({ name, owner: { login: 'octo' }, isArchived: archived, pushedAt: new Date(now - pushedDaysAgo * 86_400_000).toISOString(), url: `https://github.com/octo/${name}` });
    const run = (id: number, status: string, conclusion: string | null, minutesAgo: number) => ({ id, name: 'CI', display_title: `Run ${id}`, status, conclusion, head_branch: 'main', event: 'push', html_url: `https://github.com/octo/x/actions/runs/${id}`, run_started_at: iso(minutesAgo + 1), updated_at: iso(minutesAgo) });
    await sandbox.ghRules([
      { args: ['api', 'graphql'], stdin: ['repositories(first'], ...ok({ data: { viewer: { repositories: { totalCount: 4, pageInfo: { hasNextPage: false }, nodes: [repository('active', 0), repository('broken', 1), repository('stale', 10), repository('archived', 0, true)] } } } }) },
      { args: ['api', 'repos/octo/active/actions/runs?per_page=15'], ...ok({ workflow_runs: [run(1, 'completed', 'success', 50), run(2, 'in_progress', null, 2), run(3, 'queued', null, 1), run(4, 'completed', 'failure', 5), run(5, 'waiting', null, 3)] }) },
      { args: ['api', 'repos/octo/broken/actions/runs'], ...failed(404, 'Not Found') },
    ]);
    const ci = (await owner.get<GithubCi>('/api/github/ci')).body;
    expect(ci.repositories).toEqual(['octo/active', 'octo/broken']);
    expect(ci.runs.map((entry) => [entry.id, entry.status, entry.conclusion])).toEqual([
      [2, 'running', null],
      [3, 'queued', null],
      [5, 'waiting', null],
      [4, 'completed', 'failure'],
      [1, 'completed', 'success'],
    ]);
    expect(ci.runs[0]).toMatchObject({ repository: 'octo/active', title: 'Run 2', workflow: 'CI', branch: 'main', event: 'push', url: 'https://github.com/octo/x/actions/runs/2' });
    expect(ci.counts).toEqual({ running: 1, queued: 1, waiting: 1 });
    // One unreadable repository is a note, not a failure of the whole reading.
    expect(ci.problems).toEqual([{ repository: 'octo/broken', message: expect.stringContaining('no such repository') }]);
    expect(ci.freshness.stale).toBe(false);

    // Not being signed in fails the reading as a whole.
    await sandbox.ghRules([{ args: ['api'], stderr: 'To get started with GitHub CLI, please run:  gh auth login\n', code: 4 }]);
    expect(errorOf(await owner.get('/api/github/ci?refresh=true'))).toEqual([409, 'github_signed_out']);
  });
});

describe('the token never leaves the tool', () => {
  it('appears in no answer, no log entry and no argument, however the tool misbehaves', async () => {
    const leaky = `token ${SECRETS[0]} stored in ${SECRETS[2]}; Authorization: Bearer ${SECRETS[1]}`;
    await sandbox.ghRules([
      { args: ['auth', 'status'], stdout: JSON.stringify({ hosts: { 'github.com': [{ state: 'error', active: true, login: 'octo', error: leaky, token: SECRETS[0], tokenSource: SECRETS[2] }] } }), stderr: leaky },
      { args: ['api', '--method PUT'], ...failed(422, `Validation failed: ${leaky}`) },
      { args: ['api', 'graphql'], stdin: ['authored: search'], ...failed(500, leaky) },
      ...pullRules(rawPull({ title: 'Legit title', bodyText: 'Body' })),
    ]);
    const responses = [
      await owner.get('/api/github/account'),
      await owner.get('/api/github/inbox'),
      await owner.get(PULL),
      await merge(),
      await owner.get('/api/github/actions?action=all'),
      await owner.get('/api/audit?limit=200'),
    ];
    expect(responses.map((response) => response.status)).toEqual([200, 502, 200, 409, 200, 200]);
    for (const response of responses) {
      for (const secret of SECRETS) expect(response.raw.body).not.toContain(secret);
      expect(response.raw.body).not.toMatch(/gh[pousr]_[A-Za-z0-9]{20,}/);
    }
    for (const event of t.studio.context.services.audit.list({ limit: 200 })) {
      for (const secret of SECRETS) expect(`${event.detail} ${event.subject ?? ''}`).not.toContain(secret);
    }
    // The server never asked the tool for the token, never passed one in, and never left github.com.
    const calls = await sandbox.ghCalls();
    expect(calls.length).toBeGreaterThan(3);
    for (const call of calls) {
      const line = call.args.join(' ');
      expect(line).not.toMatch(/show-token|auth token|--with-token|GH_TOKEN|GITHUB_TOKEN|Authorization/i);
      expect(line).toContain('--hostname github.com');
      expect(call.args[0] === 'api' || call.args[0] === 'auth').toBe(true);
    }
  });
});
