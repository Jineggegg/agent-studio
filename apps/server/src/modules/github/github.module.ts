import {
  githubActionLogQuerySchema,
  githubInboxQuerySchema,
  githubPullParamsSchema,
  githubRefreshQuerySchema,
  githubRepoParamsSchema,
  githubRepositoriesQuerySchema,
  idSchema,
} from '@agent-studio/protocol';
import { z } from 'zod';
import type { ModuleContext, StudioModule } from '../../kernel/module.js';
import { GithubService } from './github.service.js';

declare module '../../kernel/module.js' {
  interface Services {
    github: GithubService;
  }
}

const projectParams = z.object({ projectId: idSchema });
/** Accepted as they come, so that even a malformed attempt to change something is recorded before it is refused. */
const anything = z.unknown();
const looseParams = z.object({ owner: z.string(), repo: z.string(), number: z.string() });

/**
 * GitHub through the server's `gh` login.
 *
 * That login is the owner's own GitHub identity, so everything here is for
 * the owner only: a member must not read the owner's private repositories or
 * act on GitHub in the owner's name. The one exception is the per-project
 * lookup of a branch's pull request, which members may call — and which tells
 * them nothing.
 *
 * Changes (merging and the small fixes) additionally need a signed-in browser
 * session: an API token, which automation might hold, can never merge.
 */
export const githubModule: StudioModule = {
  name: 'github',

  setup(context: ModuleContext) {
    const { http } = context;
    const github = new GithubService(context);
    context.services.github = github;
    const refresh = (query: { refresh: 'true' | 'false' }) => query.refresh === 'true';

    // ---- reading (owner; an API token with read scope is enough) ----
    http.route({
      method: 'GET',
      url: '/api/github/account',
      access: 'owner',
      scope: 'read',
      query: githubRefreshQuerySchema,
      handler: ({ user, query }) => github.account(user.userId, refresh(query)),
    });
    http.route({
      method: 'GET',
      url: '/api/github/inbox',
      access: 'owner',
      scope: 'read',
      query: githubInboxQuerySchema,
      handler: ({ user, query }) => github.inbox(user.userId, query.filter, refresh(query)),
    });
    http.route({
      method: 'GET',
      url: '/api/github/repositories',
      access: 'owner',
      scope: 'read',
      query: githubRepositoriesQuerySchema,
      handler: ({ user, query }) => github.repositories(user.userId, { limit: query.limit, cursor: query.cursor, refresh: refresh(query) }),
    });
    http.route({
      method: 'GET',
      url: '/api/github/repositories/:owner/:repo',
      access: 'owner',
      scope: 'read',
      params: githubRepoParamsSchema,
      query: githubRefreshQuerySchema,
      handler: ({ user, params, query }) => github.repository(user.userId, params.owner, params.repo, refresh(query)),
    });
    http.route({
      method: 'GET',
      url: '/api/github/repositories/:owner/:repo/pulls/:number',
      access: 'owner',
      scope: 'read',
      params: githubPullParamsSchema,
      query: githubRefreshQuerySchema,
      handler: ({ user, params, query }) => github.pull(user.userId, params, refresh(query)),
    });
    http.route({
      method: 'GET',
      url: '/api/github/ci',
      access: 'owner',
      scope: 'read',
      query: githubRefreshQuerySchema,
      handler: ({ user, query }) => github.ci(user.userId, refresh(query)),
    });
    http.route({
      method: 'GET',
      url: '/api/github/actions',
      access: 'owner',
      scope: 'read',
      query: githubActionLogQuerySchema,
      handler: ({ user, query }) => github.actionLog(user.userId, query),
    });

    // ---- the pull request of a project's branch (any member of the project; non-owners learn nothing) ----
    http.route({
      method: 'GET',
      url: '/api/projects/:projectId/github/pull-request',
      access: 'user',
      params: projectParams,
      query: githubRefreshQuerySchema,
      handler: ({ user, params, query }) => {
        const record = context.services.projects.requireAccess(user, params.projectId, 'read');
        return github.branchPull(user, params.projectId, record.rootDir, refresh(query));
      },
    });

    // ---- changing (owner, from a browser session only) ----
    const pull = '/api/github/repositories/:owner/:repo/pulls/:number';
    const actor = (user: { userId: string }, ip: string) => ({ userId: user.userId, address: ip });
    http.route({
      method: 'POST',
      url: `${pull}/merge`,
      access: 'owner',
      scope: 'write',
      sessionOnly: true,
      params: looseParams,
      body: anything,
      rateLimit: { max: 30, windowMs: 60_000 },
      handler: ({ user, params, body, request }) => github.merge(actor(user, request.ip), params, body),
    });
    http.route({
      method: 'POST',
      url: `${pull}/update-branch`,
      access: 'owner',
      scope: 'write',
      sessionOnly: true,
      params: looseParams,
      body: anything,
      rateLimit: { max: 30, windowMs: 60_000 },
      handler: ({ user, params, body, request }) => github.updateBranch(actor(user, request.ip), params, body),
    });
    http.route({
      method: 'POST',
      url: `${pull}/ready`,
      access: 'owner',
      scope: 'write',
      sessionOnly: true,
      params: looseParams,
      body: anything,
      rateLimit: { max: 30, windowMs: 60_000 },
      handler: ({ user, params, body, request }) => github.markReady(actor(user, request.ip), params, body),
    });
    http.route({
      method: 'POST',
      url: `${pull}/approve-runs`,
      access: 'owner',
      scope: 'write',
      sessionOnly: true,
      params: looseParams,
      body: anything,
      rateLimit: { max: 30, windowMs: 60_000 },
      handler: ({ user, params, body, request }) => github.approveRuns(actor(user, request.ip), params, body),
    });
  },
};
