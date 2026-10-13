import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  GitCreateWorktreeResult,
  GitMergeWorktreeResult,
  GitRemoveWorktreeResult,
  GitWorktree,
  GitWorktrees,
  Project,
} from '@agent-studio/protocol';
import { forbidden } from '../../kernel/errors.js';
import type { ModuleContext } from '../../kernel/module.js';
import { isInside } from '../../kernel/paths.js';
import type { Principal } from '../../kernel/principal.js';
import { cleanGitOutput, gitError, gitFailure } from './git.errors.js';
import type { ParsedWorktree } from './git.parse.js';
import { assertBranchName, assertRevision } from './git.refs.js';
import type { GitService } from './git.service.js';

const UNIT = '\u001f';

/** "feature/login form" → "feature-login-form": one folder name, whatever the branch is called. */
export function worktreeFolderName(branch: string): string {
  const name = branch
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 100);
  return name.length > 0 ? name : 'worktree';
}

interface Located {
  /** The repository's original checkout. */
  readonly main: ParsedWorktree & { realPath: string };
  readonly all: Array<ParsedWorktree & { realPath: string }>;
  /** The worktree the request came in through. */
  readonly currentPath: string;
}

/**
 * Worktrees: extra checkouts of one repository, each on its own branch and in
 * its own folder, so that several pieces of work (or several agents) do not
 * trip over each other. Each worktree is registered as its own project.
 *
 * New worktrees always go to one predictable place — the folder
 * `<repository>-worktrees` next to the repository — and only when that place
 * lies inside a configured workspace root. Creating, removing and merging
 * make and unmake project folders, so they are the owner's to do.
 */
export class WorktreeManager {
  readonly #git: GitService;
  readonly #context: ModuleContext;

  constructor(git: GitService, context: ModuleContext) {
    this.#git = git;
    this.#context = context;
  }

  async #locate(rootDir: string): Promise<Located> {
    const repo = await this.#git.repository(rootDir);
    const parsed = (await this.#git.worktreeList(repo.root)).filter((worktree) => !worktree.bare);
    const all = await Promise.all(parsed.map(async (worktree) => ({ ...worktree, realPath: await fs.realpath(worktree.path).catch(() => worktree.path) })));
    const main = all[0];
    if (!main) throw gitError(409, 'git_not_a_repository', 'This repository has no working checkout.');
    return { main, all, currentPath: repo.root };
  }

  async #find(located: Located, requested: string): Promise<ParsedWorktree & { realPath: string }> {
    if (requested.includes('\0') || !path.isAbsolute(requested)) {
      throw gitError(404, 'git_worktree_unknown', 'That is not a worktree of this repository.');
    }
    // The path is only ever compared with git's own list; it is never used on its word.
    const real = await fs.realpath(requested).catch(() => path.resolve(requested));
    const found = located.all.find((worktree) => worktree.realPath === real || worktree.path === path.resolve(requested));
    if (!found) throw gitError(404, 'git_worktree_unknown', 'That is not a worktree of this repository.');
    return found;
  }

  /** Where new worktrees of this repository go, or null when that place is outside every workspace root. */
  async #location(mainPath: string): Promise<string | null> {
    const location = path.join(path.dirname(mainPath), `${path.basename(mainPath)}-worktrees`);
    const roots = await Promise.all(this.#context.config.workspaceRoots.map((root) => fs.realpath(root).catch(() => path.resolve(root))));
    return roots.some((root) => isInside(root, location)) ? location : null;
  }

  #requireOwner(principal: Principal): void {
    if (principal.role !== 'owner') {
      throw forbidden('Worktrees create and remove project folders, which only the owner can do.', 'owner_required');
    }
  }

  async #describe(located: Located, worktree: ParsedWorktree & { realPath: string }, principal: Principal, facts?: Map<string, { subject: string; committedAt: number }>): Promise<GitWorktree> {
    const projects = this.#context.services.projects;
    const isMain = worktree === located.main;
    const exists = await fs.stat(worktree.realPath).then(
      (stat) => stat.isDirectory(),
      () => false,
    );
    const base = located.main.branch;
    const counts =
      isMain || worktree.branch === null || base === null
        ? null
        : await this.#git.aheadBehind(located.main.realPath, `refs/heads/${worktree.branch}`, `refs/heads/${base}`);
    const record = projects.findByRootDir(worktree.realPath);
    const visible = record !== null && projects.accessOf(principal, record.id) !== null;
    const fact = worktree.oid === null ? undefined : facts?.get(worktree.oid);
    return {
      path: worktree.realPath,
      branch: worktree.branch,
      oid: worktree.oid,
      main: isMain,
      current: worktree.realPath === located.currentPath,
      detached: worktree.detached,
      locked: worktree.locked,
      missing: !exists,
      changes: exists ? await this.#git.changeCount(worktree.realPath) : null,
      ahead: counts?.ahead ?? null,
      behind: counts?.behind ?? null,
      subject: fact?.subject ?? null,
      committedAt: fact?.committedAt ?? null,
      projectId: visible ? record.id : null,
      projectArchived: visible ? record.archivedAt !== null : false,
    };
  }

  async list(rootDir: string, principal: Principal): Promise<GitWorktrees> {
    const located = await this.#locate(rootDir);
    const oids = [...new Set(located.all.map((worktree) => worktree.oid).filter((oid): oid is string => oid !== null))];
    const facts = new Map<string, { subject: string; committedAt: number }>();
    if (oids.length > 0) {
      const log = await this.#git.run('query', located.main.realPath, ['log', '--no-walk', '--no-show-signature', `--format=%H${UNIT}%ct${UNIT}%s`, ...oids, '--']);
      for (const line of log.stdout.split('\n')) {
        const [oid, time, subject] = line.split(UNIT);
        if (oid && time !== undefined) facts.set(oid, { subject: subject ?? '', committedAt: Number(time) * 1000 });
      }
    }
    const worktrees: GitWorktree[] = [];
    // One at a time: each status is a process, and a repository can have many worktrees.
    for (const worktree of located.all) worktrees.push(await this.#describe(located, worktree, principal, facts));
    return { baseBranch: located.main.branch, location: await this.#location(located.main.realPath), worktrees };
  }

  /** Registers (or revives) the project that lives in a worktree's folder. */
  async #projectFor(principal: Principal, located: Located, worktree: ParsedWorktree & { realPath: string }): Promise<Project> {
    const projects = this.#context.services.projects;
    const existing = projects.findByRootDir(worktree.realPath);
    if (existing) {
      if (existing.archivedAt !== null) return projects.update(principal, existing.id, { archived: false });
      return projects.present(existing, 'write', principal);
    }
    const label = worktree.branch ?? (worktree.oid ? `detached ${worktree.oid.slice(0, 7)}` : 'worktree');
    const name = `${path.basename(located.main.realPath)} · ${label}`.slice(0, 80);
    return projects.create(principal, { name, rootDir: worktree.realPath, description: '', createDirectory: false });
  }

  async create(rootDir: string, principal: Principal, request: { branch: string; base?: string | undefined }): Promise<GitCreateWorktreeResult> {
    this.#requireOwner(principal);
    const branch = assertBranchName(request.branch);
    if (request.base !== undefined) assertRevision(request.base);
    const located = await this.#locate(rootDir);
    const mainPath = located.main.realPath;

    const location = await this.#location(mainPath);
    if (location === null) {
      throw gitError(
        409,
        'git_worktree_location',
        'Worktrees are created in a folder next to the repository, and for this repository that place is outside the allowed workspace folders.',
      );
    }
    const target = path.join(location, worktreeFolderName(branch));

    return this.#git.exclusive(mainPath, async () => {
      if (located.all.some((worktree) => worktree.branch === branch)) {
        throw gitError(409, 'git_branch_in_use', `"${branch}" is already checked out in another worktree.`);
      }
      if (await fs.lstat(target).then(() => true, () => false)) {
        throw gitError(409, 'git_worktree_exists', `The folder for this worktree already exists: ${target}`);
      }
      const exists = (await this.#git.run('query', mainPath, ['rev-parse', '--verify', '--quiet', '--end-of-options', `refs/heads/${branch}^{commit}`])).code === 0;

      let args: string[];
      if (exists) {
        args = ['worktree', 'add', '--', target, branch];
      } else {
        // A new branch starts where the caller says, else continues a remote branch of the same name, else from the main checkout.
        let start: string | null;
        let track = false;
        if (request.base !== undefined) {
          const resolved = await this.#git.run('query', mainPath, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${request.base}^{commit}`]);
          if (resolved.code !== 0) throw gitError(400, 'git_unknown_ref', `There is no branch, tag or commit called "${request.base}" here.`);
          start = resolved.stdout.trim();
        } else {
          const remote = await this.#git.run('query', mainPath, ['for-each-ref', '--format=%(refname)', '--', `refs/remotes/*/${branch}`]);
          const candidates = remote.stdout.split('\n').filter((line) => line.length > 0);
          if (candidates.length === 1) {
            start = candidates[0]!;
            track = true;
          } else {
            start = located.main.oid;
          }
        }
        if (start === null) throw gitError(400, 'git_no_commits', 'This repository has no commits yet, so there is nothing to base a worktree on.');
        args = ['worktree', 'add', ...(track ? ['--track'] : ['--no-track']), '-b', branch, '--', target, start];
      }

      await fs.mkdir(location, { recursive: true });
      const added = await this.#git.run('act', mainPath, args);
      if (added.code !== 0 || added.timedOut) {
        await fs.rm(target, { recursive: true, force: true });
        await this.#git.run('act', mainPath, ['worktree', 'prune']);
        throw gitFailure(added, 'branch');
      }

      const fresh = await this.#locate(rootDir);
      const realTarget = await fs.realpath(target);
      const worktree = fresh.all.find((candidate) => candidate.realPath === realTarget);
      try {
        if (!worktree) throw gitError(502, 'git_failed', 'The worktree was created but could not be found afterwards.');
        const project = await this.#projectFor(principal, fresh, worktree);
        return { worktree: await this.#describe(fresh, worktree, principal), project, branchCreated: !exists };
      } catch (error) {
        // A worktree nobody can open is worse than none: take it away again, and the branch only if this call made it.
        await this.#git.run('act', mainPath, ['worktree', 'remove', '--force', '--', target]);
        if (!exists) await this.#git.run('act', mainPath, ['branch', '-D', '--', branch]);
        throw error;
      }
    });
  }

  async open(rootDir: string, principal: Principal, requested: string): Promise<Project> {
    this.#requireOwner(principal);
    const located = await this.#locate(rootDir);
    return this.#projectFor(principal, located, await this.#find(located, requested));
  }

  async #remove(
    principal: Principal,
    located: Located,
    worktree: ParsedWorktree & { realPath: string },
    options: { force: boolean; deleteBranch: boolean; forceBranch: boolean },
  ): Promise<GitRemoveWorktreeResult> {
    const mainPath = located.main.realPath;
    if (worktree === located.main) throw gitError(400, 'git_worktree_main', 'The main checkout of a repository cannot be removed.');

    const present = await fs.stat(worktree.realPath).then(() => true, () => false);
    if (present) {
      const changes = await this.#git.changeCount(worktree.realPath);
      // When the folder cannot be checked, it is not removed: "probably clean" is not good enough to delete work.
      if (changes === null && !options.force) {
        throw gitError(409, 'git_worktree_dirty', 'The worktree could not be checked for uncommitted changes, so it was not removed.');
      }
      if (changes !== null && changes > 0 && !options.force) {
        throw gitError(409, 'git_worktree_dirty', `The worktree has ${changes} uncommitted change(s). Removing it would lose them.`, { side: 'worktree', changes });
      }
      const removed = await this.#git.run('act', mainPath, ['worktree', 'remove', ...(options.force ? ['--force'] : []), '--', worktree.path]);
      if (removed.code !== 0 || removed.timedOut) throw gitFailure(removed, 'other');
    } else {
      // Its folder is already gone: let git forget the leftover record.
      const pruned = await this.#git.run('act', mainPath, ['worktree', 'prune']);
      if (pruned.code !== 0) throw gitFailure(pruned, 'other');
    }

    let branchDeleted = false;
    let branchNote: string | null = null;
    if (options.deleteBranch && worktree.branch !== null) {
      const deleted = await this.#git.run('act', mainPath, ['branch', options.forceBranch ? '-D' : '-d', '--', worktree.branch]);
      branchDeleted = deleted.code === 0;
      if (!branchDeleted) {
        branchNote = /not fully merged/i.test(deleted.stderr)
          ? `"${worktree.branch}" was kept because it holds commits that are merged nowhere else.`
          : `"${worktree.branch}" could not be deleted: ${cleanGitOutput(deleted.stderr, 200)}`;
      }
    }

    // The project stays, archived, so its conversations remain restorable.
    const projects = this.#context.services.projects;
    const record = projects.findByRootDir(worktree.realPath);
    const project = record ? projects.update(principal, record.id, { archived: true }) : null;
    return { path: worktree.realPath, branch: worktree.branch, branchDeleted, branchNote, project };
  }

  async remove(rootDir: string, principal: Principal, request: { path: string; force: boolean; deleteBranch: boolean }): Promise<GitRemoveWorktreeResult> {
    this.#requireOwner(principal);
    const located = await this.#locate(rootDir);
    const worktree = await this.#find(located, request.path);
    return this.#git.exclusive(located.main.realPath, () =>
      this.#remove(principal, located, worktree, { force: request.force, deleteBranch: request.deleteBranch, forceBranch: request.force }),
    );
  }

  /**
   * Merges a worktree's branch into the branch of the main checkout — only
   * when both folders are clean and the merge is free of conflicts. Conflicts
   * are found without touching any file, so a refused merge changes nothing.
   */
  async merge(
    rootDir: string,
    principal: Principal,
    request: { path: string; squash: boolean; message?: string | undefined; cleanup: boolean },
  ): Promise<GitMergeWorktreeResult> {
    this.#requireOwner(principal);
    const located = await this.#locate(rootDir);
    const worktree = await this.#find(located, request.path);
    const { main } = located;
    const mainPath = main.realPath;
    if (worktree === main) throw gitError(400, 'git_worktree_main', 'The main checkout cannot be merged into itself.');
    if (worktree.branch === null) throw gitError(400, 'git_detached_head', 'The worktree is not on a branch, so there is nothing to merge.');
    if (main.branch === null) throw gitError(400, 'git_detached_head', 'The main checkout is not on a branch, so there is nothing to merge into.');
    const source = `refs/heads/${worktree.branch}`;
    const into = main.branch;
    if (request.message !== undefined && request.message.includes('\0')) {
      throw gitError(400, 'git_invalid_ref', 'A commit message cannot contain that character.');
    }
    const fallback = request.squash ? `Squash merge branch '${worktree.branch}'` : `Merge branch '${worktree.branch}'`;
    const message = `${request.message === undefined || request.message.trim() === '' ? fallback : request.message.trim()}\n`;

    const result = await this.#git.exclusive(mainPath, async () => {
      for (const [side, folder] of [['main', mainPath], ['worktree', worktree.realPath]] as const) {
        const changes = await this.#git.changeCount(folder);
        if (changes === null) throw gitError(409, 'git_worktree_dirty', `The ${side === 'main' ? 'main checkout' : 'worktree'} could not be checked for uncommitted changes.`, { side });
        if (changes > 0) {
          throw gitError(409, 'git_worktree_dirty', `The ${side === 'main' ? 'main checkout' : 'worktree'} has uncommitted changes. Commit or discard them first.`, { side, changes });
        }
      }
      const counts = await this.#git.aheadBehind(mainPath, source, `refs/heads/${into}`);
      if (counts !== null && counts.ahead === 0) {
        throw gitError(409, 'git_nothing_to_commit', `"${worktree.branch}" has no commits that "${into}" lacks.`);
      }
      const conflicts = await this.#git.mergeConflicts(mainPath, `refs/heads/${into}`, source);
      if (conflicts.length > 0) {
        throw gitError(409, 'git_conflict', `Merging "${worktree.branch}" into "${into}" would conflict. Nothing was changed.`, { files: conflicts.slice(0, 200) });
      }

      const env = this.#git.identityEnv(principal.userId);
      // Both forms stop before committing; the commit is then made the same way as any other, hooks included.
      const merged = await this.#git.run('act', mainPath, ['merge', request.squash ? '--squash' : '--no-ff', '--no-commit', source], { env });
      const undo = async () => {
        const aborted = await this.#git.run('act', mainPath, ['merge', '--abort']);
        if (aborted.code !== 0) await this.#git.run('act', mainPath, ['reset', '--merge']);
      };
      if (merged.code !== 0 || merged.timedOut) {
        await undo();
        throw gitFailure(merged, 'merge');
      }
      const committed = await this.#git.run('act', mainPath, ['commit', '--file=-'], { input: message, env });
      if (committed.code !== 0 || committed.timedOut) {
        await undo();
        const failure = gitFailure(committed, 'commit');
        throw failure.code === 'git_failed'
          ? gitError(409, 'git_commit_rejected', 'The merge commit was refused, most likely by a commit hook. Nothing was changed.', failure.details)
          : failure;
      }
      const head = await this.#git.run('query', mainPath, ['rev-parse', '--verify', 'HEAD']);
      return head.stdout.trim();
    });

    let cleanup: GitRemoveWorktreeResult | null = null;
    let cleanupError: string | null = null;
    if (request.cleanup) {
      try {
        const fresh = await this.#locate(rootDir).catch(() => located);
        const target = fresh.all.find((candidate) => candidate.realPath === worktree.realPath) ?? worktree;
        cleanup = await this.#git.exclusive(mainPath, () =>
          // The branch's work is in the base branch now, so deleting it loses nothing even though a squash leaves it "unmerged".
          this.#remove(principal, fresh, target, { force: false, deleteBranch: true, forceBranch: true }),
        );
      } catch (error) {
        cleanupError = error instanceof Error ? error.message : 'The clean-up failed.';
      }
    }
    return { oid: result, into, branch: worktree.branch, squash: request.squash, cleanup, cleanupError };
  }
}
