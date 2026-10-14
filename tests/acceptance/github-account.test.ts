import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGhStandIn, GH_LEAK, pathWithout, type GhStandIn } from './support/gh-standin.js';
import { initRepository, git } from './support/git.js';
import { until } from './support/realtime.js';
import { startTestStudio, type ApiClient, type RunningStudio } from './support/studio.js';
import {
  createMember,
  createProject,
  shareProject,
  type ErrorBody,
  type Json,
} from './support/workbench.js';

/**
 * 6.8 — GitHub (requirements 02 §6.8, §7.8), as far as a black box can go
 * without GitHub: what the product says about the server's `gh` login, one
 * read through it, and who may do what. The stand-in `gh` prints canned
 * answers and records every call, so "GitHub was not contacted" is checked,
 * not assumed. The module's own suite covers pull requests and merging.
 *
 * Deliberate differences: everything is the owner's (the login is the owner's
 * identity), and a change — merging above all — needs a browser session, so
 * an API token can never merge.
 *
 * The server's PATH is cut down to the system folders plus the stand-in, so a
 * real `gh` installed for whoever runs the tests cannot be reached.
 */
const NO_SYSTEM_GH =
  'skipped: this machine has a real gh in a system folder, and these tests must not reach it';

describe('6.8 GitHub with a (stand-in) gh on the server', () => {
  let studio: RunningStudio | null = null;
  let owner: ApiClient;
  let gh: GhStandIn;
  let safe = false;

  beforeAll(async () => {
    gh = await createGhStandIn();
    const PATH = pathWithout('gh', gh.dir);
    if (PATH === null) return;
    safe = true;
    studio = await startTestStudio({ env: { PATH } });
    owner = await studio.owner();
  });
  afterAll(async () => {
    await studio?.destroy();
    await gh?.remove();
  });

  const account = async (client: ApiClient = owner) =>
    (await client.get<Json>('/api/github/account?refresh=true')).body;
  /**
   * Re-checks until the account reads as expected. The product re-reads the login at most every few seconds
   * however often "re-check" is pressed, so a change made on the host shows up a moment later.
   */
  const accountOnce = (expected: (state: Json) => boolean, what: string) =>
    until(
      async () => {
        const state = await account();
        return expected(state) ? state : undefined;
      },
      { timeout: 20_000, interval: 500, what },
    );
  const signedIn = (scopes?: string) => {
    gh.setMode('signed-in', scopes === undefined ? {} : { scopes });
    const wanted = (scopes ?? 'gist, read:org, repo, workflow').split(', ').sort().join(',');
    return accountOnce(
      (state) =>
        (state.state === 'ready' || state.state === 'limited') &&
        [...state.scopes].sort().join(',') === wanted,
      'the account to read as signed in with those permissions',
    );
  };

  it('AT-PJ-117 (adapted): with the tool installed but nobody signed in, the product says so and names the command to run on the server — it offers no list and no sign-in of its own; after the login is done there, a re-check finds it', async (context) => {
    if (!safe) return context.skip(NO_SYSTEM_GH);
    gh.setMode('signed-out');
    const signedOut = await account();
    expect(signedOut).toMatchObject({
      state: 'signed_out',
      login: null,
      canWrite: null,
      scopes: [],
    });
    expect(signedOut.message.length).toBeGreaterThan(10);
    expect(signedOut.command).toContain('gh auth login');
    const list = await owner.get<ErrorBody>('/api/github/repositories?refresh=true');
    expect(list.status).toBeGreaterThanOrEqual(400);
    expect(list.status).not.toBe(401); // never an answer that would sign the user out of the Studio
    expect(list.body.error.code).toBe('github_signed_out');

    const ready = await signedIn(); // the operator ran the command on the host; re-check finds it
    expect(ready).toMatchObject({
      state: 'ready',
      login: 'octo-standin',
      command: null,
      canWrite: true,
    });
    expect(ready.scopes).toEqual(expect.arrayContaining(['repo', 'workflow']));
    expect(ready.message).toContain('octo-standin');
  });

  it('AT-PJ-121 (adapted): "my repositories" lists the account’s own repositories, private and archived ones included, and says how fresh the list is', async (context) => {
    if (!safe) return context.skip(NO_SYSTEM_GH);
    await signedIn();
    const listing = await owner.get<Json>('/api/github/repositories?refresh=true');
    expect(listing.status).toBe(200);
    expect(listing.body.totalCount).toBe(2);
    expect(listing.body.nextCursor).toBeNull();
    expect(listing.body.repositories.map((repo: Json) => `${repo.owner}/${repo.name}`)).toEqual([
      'octo-standin/studio-notes',
      'octo-standin/old-thing',
    ]);
    expect(listing.body.repositories[0]).toMatchObject({
      private: true,
      archived: false,
      defaultBranch: 'main',
      openPullRequests: 1,
      url: 'https://github.com/octo-standin/studio-notes',
    });
    expect(listing.body.repositories[1]).toMatchObject({
      private: false,
      archived: true,
      openIssues: 3,
    });
    expect(listing.body.freshness).toMatchObject({ stale: false, staleReason: null });
    // The request went to gh as data on standard input — nothing from a client on the command line.
    const call = gh
      .calls()
      .find((entry) => entry.args[0] === 'api' && entry.stdin.includes('repositories'))!;
    expect(call.args).toEqual(
      expect.arrayContaining(['--hostname', 'github.com', '--input', '-', 'graphql']),
    );
    expect(call.args.join(' ')).not.toContain('token');
  });

  it('§7.8: GitHub is the owner’s — a member gets nothing through the owner’s login, not even via a project that was shared with them', async (context) => {
    if (!safe) return context.skip(NO_SYSTEM_GH);
    await signedIn();
    const member = await createMember(studio!, owner, 'ghmember');
    const before = gh.calls().length;
    for (const url of [
      '/api/github/account',
      '/api/github/repositories',
      '/api/github/inbox',
      '/api/github/ci',
      '/api/github/actions',
      '/api/github/repositories/octo-standin/studio-notes',
      '/api/github/repositories/octo-standin/studio-notes/pulls/1',
    ]) {
      const refused = await member.get<ErrorBody>(url);
      expect(refused.status, url).toBe(403);
      expect(refused.body.error.code).toBe('owner_required');
      expect((await studio!.client().get(url)).status, url).toBe(401); // AT-PJ-205
    }
    const merge = await member.post<ErrorBody>(
      '/api/github/repositories/octo-standin/studio-notes/pulls/1/merge',
      { method: 'squash', headSha: 'a'.repeat(40) },
    );
    expect(merge.status).toBe(403);
    // A member could point a shared project's remote at any repository; the branch lookup tells them nothing.
    const project = await createProject(studio!, owner, 'gh-project');
    initRepository(project.rootDir);
    git(
      project.rootDir,
      'remote',
      'add',
      'origin',
      'https://github.com/octo-standin/studio-notes.git',
    );
    await shareProject(owner, project.id, member.userId!, 'write');
    const lookup = await member.get<Json>(`/api/projects/${project.id}/github/pull-request`);
    expect(lookup.status).toBe(200);
    expect(lookup.body.result).toBe('owner_only');
    expect(gh.calls().length).toBe(before); // none of it reached the tool
  });

  it('§7.8: an API token cannot merge or change anything on GitHub, whatever its scopes — the request is refused before the tool is run; reading with a token is allowed', async (context) => {
    if (!safe) return context.skip(NO_SYSTEM_GH);
    await signedIn();
    const created = await owner.post<{ token: string }>('/api/auth/tokens', {
      name: 'automation',
      scopes: ['read', 'write', 'admin'],
    });
    const robot = studio!.client();
    robot.bearer = created.body.token;
    expect((await robot.get<Json>('/api/github/account')).body.state).toBe('ready');

    const before = gh.calls().length;
    const pull = '/api/github/repositories/octo-standin/studio-notes/pulls/1';
    for (const [action, body] of [
      ['merge', { method: 'squash', headSha: 'a'.repeat(40) }],
      ['update-branch', { headSha: 'a'.repeat(40) }],
      ['ready', {}],
      ['approve-runs', { runIds: [1] }],
    ] as const) {
      const refused = await robot.post<ErrorBody>(`${pull}/${action}`, body);
      expect(refused.status, action).toBe(403);
      expect(refused.body.error.code, action).toBe('session_required');
    }
    expect(gh.calls().length).toBe(before);
    expect(gh.calls().some((call) => /mutation|merge/i.test(call.stdin))).toBe(false);
  });

  it('AT-PJ-129: an owner starting with a hyphen, a repository named "..", pull request "0" or "01", or a head that is not forty hexadecimal characters is refused without contacting GitHub', async (context) => {
    if (!safe) return context.skip(NO_SYSTEM_GH);
    await signedIn();
    const before = gh.calls().length;
    for (const url of [
      '/api/github/repositories/-flag/repo',
      '/api/github/repositories/--help/repo',
      '/api/github/repositories/octo-standin/..',
      '/api/github/repositories/octo-standin/%2e%2e',
      '/api/github/repositories/octo-standin/studio-notes/pulls/0',
      '/api/github/repositories/octo-standin/studio-notes/pulls/01',
      '/api/github/repositories/octo-standin/studio-notes/pulls/-1',
      '/api/github/repositories/octo-standin/studio-notes/pulls/1e3',
      '/api/github/repositories/octo%20standin/studio-notes',
    ]) {
      const refused = await owner.get(url);
      expect([400, 404], url).toContain(refused.status);
    }
    const pull = '/api/github/repositories/octo-standin/studio-notes/pulls/1';
    for (const headSha of [
      'abc',
      'A'.repeat(40),
      'g'.repeat(40),
      `${'a'.repeat(39)} `,
      '--admin',
    ]) {
      expect(
        (await owner.post(`${pull}/merge`, { method: 'squash', headSha })).status,
        headSha,
      ).toBe(400);
    }
    expect(
      (await owner.post(`${pull}/merge`, { method: 'force', headSha: 'a'.repeat(40) })).status,
    ).toBe(400);
    expect(
      (
        await owner.post(`${pull}/merge`, {
          method: 'squash',
          headSha: 'a'.repeat(40),
          admin: true,
          auto: true,
          acknowledgeFailingChecks: 'true',
        })
      ).status,
    ).toBe(400);
    expect(gh.calls().length).toBe(before);
  });

  it('AT-PJ-119 (adapted): a login that may read but not write is reported as read-only', async (context) => {
    if (!safe) return context.skip(NO_SYSTEM_GH);
    const readOnly = await signedIn('read:org, read:user');
    expect(readOnly).toMatchObject({ state: 'limited', login: 'octo-standin', canWrite: false });
    expect(readOnly.scopes).not.toContain('repo');
    expect(readOnly.message).toContain('"repo" permission'); // the sentence names what is missing
    expect(readOnly.message).toContain('not merge');
    expect((await signedIn()).canWrite).toBe(true);
  });

  it('AT-PJ-118/134: when the tool fails and prints the login’s token and where it keeps it, neither is passed on — and a list that was read before is kept, marked as possibly out of date, rather than blanked', async (context) => {
    if (!safe) return context.skip(NO_SYSTEM_GH);
    await signedIn();
    expect((await owner.get<Json>('/api/github/repositories')).status).toBe(200);
    gh.setMode('broken');
    const broken = await accountOnce(
      (state) => state.state !== 'ready',
      'the account to read as broken',
    );
    expect(['error', 'expired', 'unreachable']).toContain(broken.state);
    // The repositories were read well before; asked to refresh now, the product really tries again and fails.
    const kept = await until(
      async () => {
        const response = await owner.get<Json>('/api/github/repositories?refresh=true');
        return response.status !== 200 || response.body.freshness.stale ? response : undefined;
      },
      { timeout: 20_000, interval: 500, what: 'the refresh to be attempted' },
    );
    if (kept.status === 200) {
      expect(kept.body.repositories).toHaveLength(2);
      expect(kept.body.freshness.stale).toBe(true);
      expect(kept.body.freshness.staleReason.length).toBeGreaterThan(5);
    } else {
      // Refusing with a reason is the other honest answer; an empty list presented as current is not.
      expect(kept.status).toBeGreaterThanOrEqual(400);
      expect(kept.status).not.toBe(401);
      expect(kept.body.error.message.length).toBeGreaterThan(5);
    }
    const answers = [
      broken,
      kept.body,
      (await owner.get('/api/github/inbox?refresh=true')).body,
      (await owner.get('/api/github/ci?refresh=true')).body,
    ];
    const text = JSON.stringify(answers);
    expect(text).not.toContain(GH_LEAK.token);
    expect(text).not.toContain('ghp_');
    expect(text).not.toContain(GH_LEAK.path);
    expect(text).not.toContain('.config/gh');
    expect(studio!.output()).not.toContain(GH_LEAK.token);

    const fine = JSON.stringify(await signedIn());
    expect(fine).not.toContain('keyring');
    expect(fine).not.toMatch(/gh[pousr]_[A-Za-z0-9]{20,}/);
    // The tool was never asked for the token.
    for (const call of gh.calls()) {
      expect(call.args).not.toContain('--show-token');
      expect(call.args.slice(0, 2)).not.toEqual(['auth', 'token']);
    }
  });
});

describe('6.8 GitHub with no gh on the server at all', () => {
  let studio: RunningStudio | null = null;
  let owner: ApiClient;
  let safe = false;

  beforeAll(async () => {
    const PATH = pathWithout('gh');
    if (PATH === null) return;
    safe = true;
    studio = await startTestStudio({ env: { PATH } });
    owner = await studio.owner();
  });
  afterAll(() => studio?.destroy());

  it('AT-PJ-116: the product says the tool is not installed and how to get it — a state to show, not an error; lists are refused with that same reason', async (context) => {
    if (!safe) return context.skip(NO_SYSTEM_GH);
    const account = await owner.get<Json>('/api/github/account?refresh=true');
    expect(account.status).toBe(200);
    expect(account.body).toMatchObject({
      state: 'tool_missing',
      login: null,
      canWrite: null,
      scopes: [],
    });
    expect(account.body.message).toContain('not installed');
    expect(account.body.message).toContain('https://cli.github.com');
    for (const url of ['/api/github/repositories', '/api/github/inbox', '/api/github/ci']) {
      const refused = await owner.get<ErrorBody>(`${url}?refresh=true`);
      expect(refused.status, url).toBeGreaterThanOrEqual(400);
      expect(refused.status, url).toBeLessThan(600);
      expect(refused.status).not.toBe(401);
      expect(refused.body.error.code, url).toBe('github_tool_missing');
    }
    // Re-checking is always possible and gives the same plain answer; the rest of the product is unaffected.
    expect((await owner.get<Json>('/api/github/account?refresh=true')).body.state).toBe(
      'tool_missing',
    );
    expect((await owner.get('/api/projects')).status).toBe(200);
    // A project's branch lookup simply has nothing to show.
    const project = await createProject(studio!, owner, 'no-gh-project');
    const lookup = await owner.get<Json>(`/api/projects/${project.id}/github/pull-request`);
    expect(lookup.status).toBe(200);
    expect(lookup.body.result).not.toBe('found');
  });
});
