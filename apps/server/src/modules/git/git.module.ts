import {
  FILES_CHANGED,
  GIT_CHANGED,
  cloneProjectRequestSchema,
  gitBaselineQuerySchema,
  gitCommitRequestSchema,
  gitCompareDiffQuerySchema,
  gitCompareQuerySchema,
  gitCreateBranchRequestSchema,
  gitCreateWorktreeRequestSchema,
  gitDeleteBranchRequestSchema,
  gitDiffQuerySchema,
  gitFetchRequestSchema,
  gitIdentitySchema,
  gitInitialCommitRequestSchema,
  gitLogQuerySchema,
  gitMergeWorktreeRequestSchema,
  gitOidSchema,
  gitPathRequestSchema,
  gitPathsRequestSchema,
  gitPullRequestSchema,
  gitPushRequestSchema,
  gitRemoveWorktreeRequestSchema,
  gitSwitchBranchRequestSchema,
  gitWorktreePathRequestSchema,
  idSchema,
  projectTopic,
} from '@agent-studio/protocol';
import { z } from 'zod';
import type { ModuleContext, StudioModule } from '../../kernel/module.js';
import type { Principal } from '../../kernel/principal.js';
import { CloneManager } from './git.clone.js';
import { GitService } from './git.service.js';
import { WorktreeManager } from './git.worktrees.js';

declare module '../../kernel/module.js' {
  interface Services {
    git: GitService;
  }
}

const projectParams = z.object({ projectId: idSchema });
const commitParams = z.object({ projectId: idSchema, oid: gitOidSchema });
const cloneParams = z.object({ cloneId: idSchema });
const empty = z.object({}).optional();

/** One clone manager per Studio instance (tests run several side by side). */
const cloneManagers = new WeakMap<ModuleContext, CloneManager>();

/**
 * Git for a project's folder. Every route names a project; the folder comes
 * from the stored project and the caller's access to it is checked first, so
 * a project the caller cannot see answers 404 whatever else is in the request.
 * Reading needs read access, changing needs write access, and the worktree
 * operations that create or remove project folders are the owner's.
 */
export const gitModule: StudioModule = {
  name: 'git',

  setup(context: ModuleContext) {
    const { http, bus } = context;
    const git = new GitService(context);
    context.services.git = git;
    const worktrees = new WorktreeManager(git, context);
    const cloneManager = new CloneManager(git.exec, context);
    cloneManagers.set(context, cloneManager);

    const projects = () => context.services.projects;
    const readable = (user: Principal, projectId: string) => projects().requireAccess(user, projectId, 'read').rootDir;
    const writable = (user: Principal, projectId: string) => projects().requireAccess(user, projectId, 'write').rootDir;

    /** Tells open clients to read again. `files` when the folder's contents may have changed too. */
    const changed = (projectId: string, user: Principal, reason: string, files = false): void => {
      bus.publish(projectTopic(projectId), GIT_CHANGED, { projectId, reason });
      if (files) bus.publish(projectTopic(projectId), FILES_CHANGED, { projectId, kind: 'tree', paths: [], userId: user.userId });
    };

    const base = '/api/projects/:projectId/git';

    // ---- reading ----
    http.route({
      method: 'GET',
      url: `${base}/status`,
      access: 'user',
      params: projectParams,
      handler: ({ user, params }) => git.status(readable(user, params.projectId)),
    });
    http.route({
      method: 'GET',
      url: `${base}/diff`,
      access: 'user',
      params: projectParams,
      query: gitDiffQuerySchema,
      handler: ({ user, params, query }) => git.diff(readable(user, params.projectId), query.path, query.staged === 'true'),
    });
    http.route({
      method: 'GET',
      url: `${base}/baseline`,
      access: 'user',
      params: projectParams,
      query: gitBaselineQuerySchema,
      handler: ({ user, params, query }) => git.baseline(readable(user, params.projectId), query.path),
    });
    http.route({
      method: 'GET',
      url: `${base}/branches`,
      access: 'user',
      params: projectParams,
      handler: ({ user, params }) => git.branches(readable(user, params.projectId)),
    });
    http.route({
      method: 'GET',
      url: `${base}/log`,
      access: 'user',
      params: projectParams,
      query: gitLogQuerySchema,
      handler: ({ user, params, query }) => git.log(readable(user, params.projectId), query),
    });
    http.route({
      method: 'GET',
      url: `${base}/commits/:oid`,
      access: 'user',
      params: commitParams,
      handler: ({ user, params }) => git.commitDetail(readable(user, params.projectId), params.oid),
    });
    http.route({
      method: 'GET',
      url: `${base}/compare`,
      access: 'user',
      params: projectParams,
      query: gitCompareQuerySchema,
      handler: ({ user, params, query }) => git.compare(readable(user, params.projectId), query.base),
    });
    http.route({
      method: 'GET',
      url: `${base}/compare/diff`,
      access: 'user',
      params: projectParams,
      query: gitCompareDiffQuerySchema,
      handler: ({ user, params, query }) => git.compareDiff(readable(user, params.projectId), query),
    });
    http.route({
      method: 'GET',
      url: `${base}/worktrees`,
      access: 'user',
      params: projectParams,
      handler: ({ user, params }) => worktrees.list(readable(user, params.projectId), user),
    });

    // ---- starting a repository ----
    http.route({
      method: 'POST',
      url: `${base}/init`,
      access: 'user',
      params: projectParams,
      body: empty,
      handler: async ({ user, params }) => {
        const result = await git.init(writable(user, params.projectId));
        if (result.created) changed(params.projectId, user, 'init');
        return result;
      },
    });
    http.route({
      method: 'POST',
      url: `${base}/initial-commit`,
      access: 'user',
      params: projectParams,
      body: gitInitialCommitRequestSchema,
      handler: async ({ user, params, body }) => {
        const result = await git.initialCommit(writable(user, params.projectId), user.userId, body.message);
        changed(params.projectId, user, 'commit');
        return result;
      },
    });

    // ---- staging ----
    http.route({
      method: 'POST',
      url: `${base}/stage`,
      access: 'user',
      params: projectParams,
      body: gitPathsRequestSchema,
      handler: async ({ user, params, body }) => {
        await git.stage(writable(user, params.projectId), body);
        changed(params.projectId, user, 'stage');
      },
    });
    http.route({
      method: 'POST',
      url: `${base}/unstage`,
      access: 'user',
      params: projectParams,
      body: gitPathsRequestSchema,
      handler: async ({ user, params, body }) => {
        await git.unstage(writable(user, params.projectId), body);
        changed(params.projectId, user, 'unstage');
      },
    });
    http.route({
      method: 'POST',
      url: `${base}/discard`,
      access: 'user',
      params: projectParams,
      body: gitPathRequestSchema,
      handler: async ({ user, params, body }) => {
        await git.discard(writable(user, params.projectId), body.path);
        changed(params.projectId, user, 'discard', true);
      },
    });
    http.route({
      method: 'POST',
      url: `${base}/delete-untracked`,
      access: 'user',
      params: projectParams,
      body: gitPathRequestSchema,
      handler: async ({ user, params, body }) => {
        const removed = await git.deleteUntracked(writable(user, params.projectId), body.path);
        bus.publish(projectTopic(params.projectId), FILES_CHANGED, { projectId: params.projectId, kind: 'deleted', paths: [removed], userId: user.userId });
        changed(params.projectId, user, 'delete-untracked');
      },
    });

    // ---- committing ----
    http.route({
      method: 'POST',
      url: `${base}/commit`,
      access: 'user',
      params: projectParams,
      body: gitCommitRequestSchema,
      handler: async ({ user, params, body }) => {
        const result = await git.commit(writable(user, params.projectId), user.userId, body);
        changed(params.projectId, user, 'commit');
        return result;
      },
    });
    http.route({
      method: 'POST',
      url: `${base}/undo-commit`,
      access: 'user',
      params: projectParams,
      body: empty,
      handler: async ({ user, params }) => {
        const result = await git.undoCommit(writable(user, params.projectId));
        changed(params.projectId, user, 'undo-commit');
        return result;
      },
    });

    // ---- branches ----
    http.route({
      method: 'POST',
      url: `${base}/branches`,
      access: 'user',
      params: projectParams,
      body: gitCreateBranchRequestSchema,
      handler: async ({ user, params, body, reply }) => {
        const result = await git.createBranch(writable(user, params.projectId), body);
        changed(params.projectId, user, 'branch-created', body.switch);
        void reply.status(201);
        return result;
      },
    });
    http.route({
      method: 'POST',
      url: `${base}/switch`,
      access: 'user',
      params: projectParams,
      body: gitSwitchBranchRequestSchema,
      handler: async ({ user, params, body }) => {
        const result = await git.switchBranch(writable(user, params.projectId), body);
        changed(params.projectId, user, 'switch', true);
        return result;
      },
    });
    http.route({
      method: 'POST',
      url: `${base}/branches/delete`,
      access: 'user',
      params: projectParams,
      body: gitDeleteBranchRequestSchema,
      handler: async ({ user, params, body }) => {
        const result = await git.deleteBranch(writable(user, params.projectId), body);
        changed(params.projectId, user, 'branch-deleted');
        return result;
      },
    });

    // ---- remote sync ----
    http.route({
      method: 'POST',
      url: `${base}/fetch`,
      access: 'user',
      params: projectParams,
      body: gitFetchRequestSchema,
      handler: async ({ user, params, body }) => {
        const result = await git.fetch(writable(user, params.projectId), body);
        changed(params.projectId, user, 'fetch');
        return result;
      },
    });
    http.route({
      method: 'POST',
      url: `${base}/pull`,
      access: 'user',
      params: projectParams,
      body: gitPullRequestSchema,
      handler: async ({ user, params, body }) => {
        const result = await git.pull(writable(user, params.projectId), user.userId, body);
        changed(params.projectId, user, 'pull', true);
        return result;
      },
    });
    http.route({
      method: 'POST',
      url: `${base}/push`,
      access: 'user',
      params: projectParams,
      body: gitPushRequestSchema,
      handler: async ({ user, params, body }) => {
        const result = await git.push(writable(user, params.projectId), body);
        changed(params.projectId, user, 'push');
        return result;
      },
    });

    // ---- worktrees (changes are the owner's; the project check comes first so nothing leaks) ----
    http.route({
      method: 'POST',
      url: `${base}/worktrees`,
      access: 'user',
      params: projectParams,
      body: gitCreateWorktreeRequestSchema,
      handler: async ({ user, params, body, reply }) => {
        const result = await worktrees.create(writable(user, params.projectId), user, body);
        changed(params.projectId, user, 'worktree-created');
        void reply.status(201);
        return result;
      },
    });
    http.route({
      method: 'POST',
      url: `${base}/worktrees/open`,
      access: 'user',
      params: projectParams,
      body: gitWorktreePathRequestSchema,
      handler: async ({ user, params, body }) => ({ project: await worktrees.open(writable(user, params.projectId), user, body.path) }),
    });
    http.route({
      method: 'POST',
      url: `${base}/worktrees/remove`,
      access: 'user',
      params: projectParams,
      body: gitRemoveWorktreeRequestSchema,
      handler: async ({ user, params, body }) => {
        const result = await worktrees.remove(writable(user, params.projectId), user, body);
        changed(params.projectId, user, 'worktree-removed');
        return result;
      },
    });
    http.route({
      method: 'POST',
      url: `${base}/worktrees/merge`,
      access: 'user',
      params: projectParams,
      body: gitMergeWorktreeRequestSchema,
      handler: async ({ user, params, body }) => {
        const result = await worktrees.merge(writable(user, params.projectId), user, body);
        changed(params.projectId, user, 'worktree-merged', true);
        return result;
      },
    });

    // ---- the caller's commit identity ----
    http.route({
      method: 'GET',
      url: '/api/git/identity',
      access: 'user',
      handler: ({ user }) => git.identity(user.userId),
    });
    http.route({
      method: 'PUT',
      url: '/api/git/identity',
      access: 'user',
      body: gitIdentitySchema,
      handler: ({ user, body }) => git.saveIdentity(user.userId, body),
    });

    // ---- creating a project by cloning (owner only, like creating any project) ----
    http.route({
      method: 'POST',
      url: '/api/projects/clone',
      access: 'owner',
      body: cloneProjectRequestSchema,
      rateLimit: { max: 30, windowMs: 60_000 },
      handler: async ({ user, body, reply }) => {
        const job = await cloneManager.start(user, body);
        void reply.status(202);
        return job;
      },
    });
    http.route({
      method: 'GET',
      url: '/api/projects/clone/:cloneId',
      access: 'owner',
      params: cloneParams,
      handler: ({ user, params }) => cloneManager.get(user, params.cloneId),
    });
    http.route({
      method: 'DELETE',
      url: '/api/projects/clone/:cloneId',
      access: 'owner',
      params: cloneParams,
      handler: ({ user, params }) => cloneManager.cancel(user, params.cloneId),
    });
  },

  stop(context) {
    cloneManagers.get(context)?.stop();
    cloneManagers.delete(context);
  },
};
