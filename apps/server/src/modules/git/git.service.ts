import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  GIT_IDENTITY_PREFERENCE,
  gitIdentitySchema,
  type GitBaseline,
  type GitBranch,
  type GitBranches,
  type GitChangedFile,
  type GitCommit,
  type GitCommitDetail,
  type GitCommitResult,
  type GitComparison,
  type GitFileDiff,
  type GitIdentity,
  type GitIdentityState,
  type GitLog,
  type GitRepositoryState,
  type GitStatus,
  type GitSyncResult,
} from '@agent-studio/protocol';
import { badRequest, isStudioError } from '../../kernel/errors.js';
import type { ModuleContext, Services } from '../../kernel/module.js';
import type { RunResult } from '../../kernel/process.js';
import { projectRoot, resolveEntry } from '../files/project-paths.js';
import { cleanGitOutput, gitError, gitFailure, type GitOperation } from './git.errors.js';
import { GitExec, type GitCallOptions } from './git.exec.js';
import { isBinaryDiff, parseNameStatus, parseNumstat, parseStatusV2, parseTrack, parseWorktreeList, type ParsedStatus, type ParsedWorktree } from './git.parse.js';
import { assertBranchName, assertOid, assertRemoteName, assertRevision, isFullOid } from './git.refs.js';

export interface GitLimits {
  /** A per-file diff is cut after this many bytes. */
  diffBytes: number;
  /** The diff of a whole commit is cut after this many bytes. */
  commitDiffBytes: number;
  /** Files in one status or comparison answer. */
  statusFiles: number;
  /** Largest last-committed file content handed to an editor. */
  baselineBytes: number;
}

export const DEFAULT_GIT_LIMITS: Readonly<GitLimits> = {
  diffBytes: 400_000,
  commitDiffBytes: 500_000,
  statusFiles: 5000,
  baselineBytes: 2 * 1024 * 1024,
};

const STATE_MESSAGES: Record<Exclude<GitRepositoryState, 'ready'>, string> = {
  none: 'This folder is not a git repository yet.',
  nested: "This folder is part of a larger repository. Open that repository's folder as a project to use git on it.",
  bare: 'This folder is a bare repository: it has no working files to manage here.',
  untrusted:
    'Git refuses to use this folder because it belongs to another system account. If you trust it, run "git config --global --add safe.directory <folder>" on the server.',
  unavailable: 'Git is not installed on the server.',
};

export interface Repository {
  /** The project's real folder, which is also the top of the work tree. */
  readonly root: string;
  /** The repository's (or linked worktree's) administrative directory. */
  readonly gitDir: string;
}

interface Inspection {
  readonly state: GitRepositoryState;
  readonly message: string | null;
  readonly root: string;
  readonly gitDir: string | null;
}

interface Upstream {
  /** Name of the remote. */
  readonly remote: string;
  /** The branch on the remote, e.g. refs/heads/main. */
  readonly remoteRef: string;
  /** The local remote-tracking ref, e.g. refs/remotes/origin/main. */
  readonly trackingRef: string;
}

const FIRST_COMMIT_MESSAGE = 'Initial commit';
const noRemote = () => gitError(409, 'git_no_remote', 'This repository has no remote configured.');
const UNIT = '\u001f';
const RECORD = '\u001e';

/** Cuts text that was collected up to a byte limit back to whole lines. */
function cutToLines(text: string, truncated: boolean): string {
  if (!truncated) return text;
  const end = text.lastIndexOf('\n');
  return end === -1 ? '' : text.slice(0, end + 1);
}

/**
 * Everything the Studio does with a project's repository. Each method takes
 * the project's stored folder; nothing here ever accepts a directory from a
 * client. Reads go through `GitExec.query` (no repository-controlled code),
 * changes through `act`/`network`, and changes to one repository are applied
 * one at a time.
 */
export class GitService {
  readonly exec: GitExec;
  readonly limits: GitLimits = { ...DEFAULT_GIT_LIMITS };
  readonly #context: ModuleContext;
  readonly #queues = new Map<string, Promise<unknown>>();

  constructor(context: ModuleContext) {
    this.#context = context;
    this.exec = new GitExec(context.processes);
  }

  // ---- plumbing ------------------------------------------------------------------

  /** Runs `work` after every earlier change to the same repository has finished. */
  exclusive<T>(root: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(root) ?? Promise.resolve();
    const next = previous.then(work, work);
    const settled = next.catch(() => undefined);
    this.#queues.set(root, settled);
    void settled.then(() => {
      if (this.#queues.get(root) === settled) this.#queues.delete(root);
    });
    return next;
  }

  #ok(result: RunResult, operation: GitOperation, timeoutMs?: number): RunResult {
    if (result.code !== 0 || result.timedOut) throw gitFailure(result, operation, timeoutMs);
    return result;
  }

  /** What kind of place the project folder is, as far as git is concerned. Never throws for "not a repository". */
  async inspect(rootDir: string): Promise<Inspection> {
    const root = await projectRoot(rootDir);
    const describe = (state: Exclude<GitRepositoryState, 'ready'>): Inspection => ({ state, message: STATE_MESSAGES[state], root, gitDir: null });
    let result: RunResult;
    try {
      result = await this.exec.discover(root, ['rev-parse', '--is-bare-repository', '--is-inside-work-tree', '--absolute-git-dir', '--show-toplevel']);
    } catch (error) {
      if (isStudioError(error) && error.code === 'git_unavailable') return describe('unavailable');
      throw error;
    }
    const lines = result.stdout.split('\n');
    if (result.code !== 0) {
      // Ownership is judged before anything else is read, deliberately without an override:
      // a folder git does not trust is not made trusted by this server.
      if (/dubious ownership/i.test(result.stderr)) return describe('untrusted');
      if (lines[0] === 'true') return describe('bare');
      return describe('none');
    }
    const [bare, inside, gitDir, toplevel] = lines;
    if (bare === 'true') return describe('bare');
    if (inside !== 'true' || !gitDir || !toplevel) return describe('none');
    const top = await fs.realpath(toplevel).catch(() => toplevel);
    // Also catches a repository whose configuration points its work tree somewhere else.
    if (top !== root) return describe('nested');
    return { state: 'ready', message: null, root, gitDir };
  }

  /** The repository of a project, or the fitting refusal. */
  async repository(rootDir: string): Promise<Repository> {
    const inspection = await this.inspect(rootDir);
    if (inspection.state === 'ready') return { root: inspection.root, gitDir: inspection.gitDir! };
    if (inspection.state === 'unavailable') throw gitError(503, 'git_unavailable', inspection.message!);
    if (inspection.state === 'untrusted') throw gitError(409, 'git_untrusted', inspection.message!);
    throw gitError(409, 'git_not_a_repository', inspection.message!, { state: inspection.state });
  }

  async #parsedStatus(root: string): Promise<{ parsed: ParsedStatus; truncated: boolean }> {
    const result = this.#ok(
      await this.exec.query(
        root,
        ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all', '--ignore-submodules=dirty', '--find-renames', '--ahead-behind'],
        { readsWorktree: true, maxOutputBytes: 8 * 1024 * 1024 },
      ),
      'other',
    );
    // A cut-off answer ends in half a record: drop it.
    const output = result.truncated ? result.stdout.slice(0, result.stdout.lastIndexOf('\0') + 1) : result.stdout;
    return { parsed: parseStatusV2(output), truncated: result.truncated };
  }

  async #remotes(root: string): Promise<string[]> {
    const result = this.#ok(await this.exec.query(root, ['remote']), 'other');
    return result.stdout.split('\n').filter((name) => name.length > 0);
  }

  async #upstream(root: string, branch: string): Promise<Upstream | null> {
    const result = await this.exec.query(root, [
      'for-each-ref',
      '--format=%(upstream)%00%(upstream:remotename)%00%(upstream:remoteref)',
      '--',
      `refs/heads/${branch}`,
    ]);
    if (result.code !== 0) return null;
    const [trackingRef, remote, remoteRef] = result.stdout.replace(/\n$/, '').split('\0');
    // A branch that follows another local branch has no remote to sync with.
    if (!trackingRef || !remote || remote === '.' || !remoteRef) return null;
    return { remote, remoteRef, trackingRef };
  }

  async #operation(gitDir: string): Promise<GitStatus['operation']> {
    const exists = (name: string) =>
      fs.access(path.join(gitDir, name)).then(
        () => true,
        () => false,
      );
    if (await exists('MERGE_HEAD')) return 'merge';
    if ((await exists('rebase-merge')) || (await exists('rebase-apply'))) return 'rebase';
    if (await exists('CHERRY_PICK_HEAD')) return 'cherry-pick';
    if (await exists('REVERT_HEAD')) return 'revert';
    if (await exists('BISECT_LOG')) return 'bisect';
    return null;
  }

  async #refuseUnfinished(repo: Repository): Promise<void> {
    const operation = await this.#operation(repo.gitDir);
    if (operation) {
      throw gitError(409, 'git_operation_in_progress', `An unfinished ${operation} is in the way. Finish or abort it in a terminal first.`, { operation });
    }
  }

  /** The commit a client-supplied revision names, or 400. */
  async #resolveCommit(root: string, revision: string): Promise<string> {
    assertRevision(revision);
    const result = await this.exec.query(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${revision}^{commit}`]);
    const oid = result.stdout.trim();
    if (result.code !== 0 || !isFullOid(oid)) {
      throw gitError(400, 'git_unknown_ref', `There is no branch, tag or commit called "${revision}" here.`);
    }
    return oid;
  }

  async #branchExists(root: string, name: string): Promise<boolean> {
    const result = await this.exec.query(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `refs/heads/${name}^{commit}`]);
    return result.code === 0;
  }

  /** Project-relative paths that git may be given, each confined to the project first. */
  async #paths(rootDir: string, requested: readonly string[]): Promise<string[]> {
    const paths: string[] = [];
    for (const entry of requested) {
      const resolved = await resolveEntry(rootDir, entry);
      if (resolved.relative === '') throw badRequest('Name a file inside the project.', undefined, 'invalid_path');
      paths.push(resolved.relative);
    }
    return paths;
  }

  // ---- commit identity -------------------------------------------------------------

  #preferences(): Services['preferences'] | undefined {
    return (this.#context.services as Partial<Services>).preferences;
  }

  #storedIdentity(userId: string): GitIdentity | null {
    const parsed = gitIdentitySchema.safeParse(this.#preferences()?.get<unknown>(userId, GIT_IDENTITY_PREFERENCE));
    return parsed.success ? parsed.data : null;
  }

  /** The author and committer for commits made by this user: their saved identity, else whatever git has. */
  identityEnv(userId: string): Record<string, string> {
    const identity = this.#storedIdentity(userId);
    if (!identity) return {};
    return {
      GIT_AUTHOR_NAME: identity.name,
      GIT_AUTHOR_EMAIL: identity.email,
      GIT_COMMITTER_NAME: identity.name,
      GIT_COMMITTER_EMAIL: identity.email,
    };
  }

  async identity(userId: string): Promise<GitIdentityState> {
    const stored = this.#storedIdentity(userId);
    if (stored) return { source: 'user', ...stored };
    // What git itself would use on this server; read outside any repository.
    const read = async (key: string): Promise<string | null> => {
      try {
        const result = await this.exec.discover(this.#context.config.dataDir, ['config', '--global', '--get', key]);
        const value = result.stdout.trim();
        return result.code === 0 && value.length > 0 ? value : null;
      } catch {
        return null;
      }
    };
    const [name, email] = await Promise.all([read('user.name'), read('user.email')]);
    return name || email ? { source: 'host', name, email } : { source: 'none', name: null, email: null };
  }

  saveIdentity(userId: string, identity: GitIdentity): GitIdentityState {
    const preferences = this.#preferences();
    if (!preferences) throw gitError(503, 'git_unavailable', 'Preferences are not available, so the identity cannot be saved.');
    preferences.patch(userId, { [GIT_IDENTITY_PREFERENCE]: identity });
    return { source: 'user', ...identity };
  }

  // ---- for the files feature ----------------------------------------------------------

  /** Which of the given project-relative paths the repository's ignore rules match. Empty when the folder is not a work tree. */
  async ignored(rootDir: string, relativePaths: readonly string[]): Promise<Set<string>> {
    const ignored = new Set<string>();
    if (relativePaths.length === 0) return ignored;
    const inspection = await this.inspect(rootDir);
    if (inspection.state !== 'ready') return ignored;
    // A leading ":" would be read as pathspec magic by this command; such names are simply not asked about.
    const askable = relativePaths.filter((entry) => !entry.startsWith(':') && !entry.includes('\0'));
    if (askable.length === 0) return ignored;
    const result = await this.exec.query(inspection.root, ['check-ignore', '-z', '--stdin'], {
      input: askable.join('\0') + '\0',
      maxOutputBytes: 16 * 1024 * 1024,
      plainPathspecs: true,
    });
    // Exit 1 only means "none of them".
    if (result.code !== 0 && result.code !== 1) return ignored;
    for (const entry of result.stdout.split('\0')) if (entry.length > 0) ignored.add(entry);
    return ignored;
  }

  /** Tracked files plus untracked ones that are not ignored, or null when the folder is not a work tree. */
  async listFiles(rootDir: string, maxBytes = 8 * 1024 * 1024): Promise<{ files: string[]; truncated: boolean } | null> {
    const inspection = await this.inspect(rootDir);
    if (inspection.state !== 'ready') return null;
    const result = await this.exec.query(inspection.root, ['ls-files', '--cached', '--others', '--exclude-standard', '--deduplicate', '-z'], {
      maxOutputBytes: maxBytes,
    });
    if (result.code !== 0) return null;
    const output = result.truncated ? result.stdout.slice(0, result.stdout.lastIndexOf('\0') + 1) : result.stdout;
    return { files: output.split('\0').filter((entry) => entry.length > 0), truncated: result.truncated };
  }

  /**
   * Literal text search over tracked and untracked-but-not-ignored files.
   * Null when the folder is not a work tree. Binary files are skipped.
   */
  async grep(
    rootDir: string,
    query: string,
    options: { caseSensitive: boolean; directory: string; limit: number; skip?: (file: string) => boolean },
  ): Promise<{ matches: Array<{ path: string; line: number; text: string }>; truncated: boolean } | null> {
    const inspection = await this.inspect(rootDir);
    if (inspection.state !== 'ready') return null;
    const result = await this.exec.query(
      inspection.root,
      [
        'grep',
        '--line-number',
        '-I',
        '-z',
        '--no-color',
        '--untracked',
        '--no-recurse-submodules',
        '--fixed-strings',
        '--max-count=50',
        ...(options.caseSensitive ? [] : ['--ignore-case']),
        '-e',
        query,
        '--',
        options.directory === '' ? '.' : options.directory,
      ],
      { maxOutputBytes: 4 * 1024 * 1024, timeoutMs: 15_000 },
    );
    // 1 means no match; anything else unexpected is reported as "nothing found" rather than as an error page.
    if (result.code !== 0 && result.code !== 1 && !result.truncated) return { matches: [], truncated: result.timedOut };
    const matches: Array<{ path: string; line: number; text: string }> = [];
    let truncated = result.truncated || result.timedOut;
    let position = 0;
    const output = result.stdout;
    while (position < output.length) {
      const pathEnd = output.indexOf('\0', position);
      if (pathEnd === -1) break;
      const lineEnd = output.indexOf('\0', pathEnd + 1);
      if (lineEnd === -1) break;
      let textEnd = output.indexOf('\n', lineEnd + 1);
      if (textEnd === -1) textEnd = output.length;
      const line = Number(output.slice(pathEnd + 1, lineEnd));
      const file = output.slice(position, pathEnd);
      if (Number.isInteger(line) && line > 0 && !options.skip?.(file)) {
        if (matches.length >= options.limit) {
          truncated = true;
          break;
        }
        const text = output.slice(lineEnd + 1, textEnd).replace(/\r$/, '');
        matches.push({ path: file, line, text: text.length > 400 ? `${text.slice(0, 400)}…` : text });
      }
      position = textEnd + 1;
    }
    return { matches, truncated };
  }

  // ---- status ------------------------------------------------------------------------

  async status(rootDir: string): Promise<GitStatus> {
    const inspection = await this.inspect(rootDir);
    if (inspection.state !== 'ready') {
      return {
        state: inspection.state,
        message: inspection.message,
        branch: null,
        hasCommits: false,
        remotes: [],
        defaultRemote: null,
        operation: null,
        files: [],
        counts: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
        truncated: false,
      };
    }
    const { root } = inspection;
    const [{ parsed, truncated }, remotes, operation] = await Promise.all([
      this.#parsedStatus(root),
      this.#remotes(root),
      this.#operation(inspection.gitDir!),
    ]);
    const counts = { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 };
    for (const file of parsed.files) {
      if (file.conflicted) counts.conflicted += 1;
      else if (file.worktree === 'untracked') counts.untracked += 1;
      else {
        if (file.index !== null) counts.staged += 1;
        if (file.worktree !== null) counts.unstaged += 1;
      }
    }
    const upstreamRemote = parsed.upstream === null ? null : (remotes.filter((name) => parsed.upstream!.startsWith(`${name}/`)).sort((a, b) => b.length - a.length)[0] ?? null);
    return {
      state: 'ready',
      message: null,
      branch: {
        name: parsed.head,
        detached: parsed.detached,
        oid: parsed.oid,
        upstream: parsed.upstream,
        ahead: parsed.ahead,
        behind: parsed.behind,
      },
      hasCommits: parsed.oid !== null,
      remotes,
      defaultRemote: upstreamRemote ?? (remotes.includes('origin') ? 'origin' : (remotes[0] ?? null)),
      operation,
      files: parsed.files.slice(0, this.limits.statusFiles),
      counts,
      truncated: truncated || parsed.files.length > this.limits.statusFiles,
    };
  }

  // ---- diffs -------------------------------------------------------------------------

  #diffResult(file: string, result: RunResult): GitFileDiff {
    const binary = isBinaryDiff(result.stdout);
    return { path: file, diff: binary ? '' : cutToLines(result.stdout, result.truncated), binary, truncated: result.truncated };
  }

  /** The diff of one file: what is staged against the last commit, or the folder against what is staged. */
  async diff(rootDir: string, requested: string, staged: boolean): Promise<GitFileDiff> {
    const repo = await this.repository(rootDir);
    const [file] = await this.#paths(rootDir, [requested]);
    const options = { readsWorktree: true, maxOutputBytes: this.limits.diffBytes };
    const base = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--ignore-submodules=dirty', '--find-renames'];
    const result = this.#ok(await this.exec.query(repo.root, [...base, ...(staged ? ['--cached'] : []), '--', file!], options), 'other');
    if (result.stdout.length > 0 || staged) return this.#diffResult(file!, result);

    // Nothing unstaged for a tracked file — or the file is not tracked at all, in which case all of it is new.
    const untracked = await this.exec.query(repo.root, ['ls-files', '--others', '--exclude-standard', '-z', '--', file!]);
    if (untracked.code !== 0 || !untracked.stdout.split('\0').includes(file!)) return this.#diffResult(file!, result);
    return this.#untrackedDiff(repo.root, file!);
  }

  async #untrackedDiff(root: string, file: string): Promise<GitFileDiff> {
    const result = await this.exec.query(root, ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--no-color', '--', '/dev/null', file], {
      readsWorktree: true,
      maxOutputBytes: this.limits.diffBytes,
    });
    // Exit 1 is "they differ", which is the expected answer here.
    if (result.code !== 0 && result.code !== 1 && !result.truncated) throw gitFailure(result, 'other');
    return this.#diffResult(file, result);
  }

  /** The last committed content of a file. */
  async baseline(rootDir: string, requested: string): Promise<GitBaseline> {
    const repo = await this.repository(rootDir);
    const [file] = await this.#paths(rootDir, [requested]);
    const size = await this.exec.query(repo.root, ['cat-file', '-s', `HEAD:${file!}`]);
    if (size.code !== 0) return { path: file!, kind: 'none', content: null };
    const bytes = Number(size.stdout.trim());
    if (!Number.isFinite(bytes) || bytes > this.limits.baselineBytes) return { path: file!, kind: 'too_large', content: null };
    const blob = this.#ok(await this.exec.query(repo.root, ['cat-file', 'blob', `HEAD:${file!}`], { maxOutputBytes: this.limits.baselineBytes + 1 }), 'other');
    // Output is decoded as UTF-8; a replacement character or a NUL means it was not text.
    if (blob.stdout.includes('\0') || blob.stdout.includes('�')) return { path: file!, kind: 'binary', content: null };
    return { path: file!, kind: 'text', content: blob.stdout };
  }

  // ---- staging -------------------------------------------------------------------------

  /** Adds the other half of a staged rename, so that it is never taken apart by accident. */
  #withRenameSources(parsed: ParsedStatus, paths: readonly string[]): string[] {
    const all = new Set(paths);
    for (const file of parsed.files) {
      if (file.originalPath !== null && all.has(file.path)) all.add(file.originalPath);
    }
    return [...all];
  }

  async stage(rootDir: string, request: { paths?: readonly string[] | undefined; all?: boolean | undefined }): Promise<void> {
    const repo = await this.repository(rootDir);
    const paths = request.all ? null : await this.#paths(rootDir, request.paths ?? []);
    await this.exclusive(repo.root, async () => {
      this.#ok(await this.exec.act(repo.root, ['add', '--all', '--', ...(paths ?? ['.'])]), 'other');
    });
  }

  async unstage(rootDir: string, request: { paths?: readonly string[] | undefined; all?: boolean | undefined }): Promise<void> {
    const repo = await this.repository(rootDir);
    const requested = request.all ? null : await this.#paths(rootDir, request.paths ?? []);
    await this.exclusive(repo.root, async () => {
      const { parsed } = await this.#parsedStatus(repo.root);
      const paths = requested === null ? null : this.#withRenameSources(parsed, requested);
      if (parsed.oid === null) {
        // Before the first commit there is nothing to restore from: take the paths out of the index.
        const result = await this.exec.act(repo.root, ['rm', '--cached', '-r', '--quiet', '--ignore-unmatch', '--', ...(paths ?? ['.'])]);
        this.#ok(result, 'other');
        return;
      }
      if (paths === null) this.#ok(await this.exec.act(repo.root, ['reset', '--quiet', '--']), 'other');
      else this.#ok(await this.exec.act(repo.root, ['restore', '--staged', '--', ...paths]), 'other');
    });
  }

  /** Throws away every change to one tracked file, staged or not. A file that was only just added is unstaged and kept. */
  async discard(rootDir: string, requested: string): Promise<void> {
    const repo = await this.repository(rootDir);
    const [file] = await this.#paths(rootDir, [requested]);
    await this.exclusive(repo.root, async () => {
      const { parsed } = await this.#parsedStatus(repo.root);
      const entry = parsed.files.find((candidate) => candidate.path === file);
      if (!entry) throw gitError(400, 'git_nothing_to_discard', 'That file has no changes to discard.');
      if (entry.worktree === 'untracked') {
        throw gitError(400, 'git_not_tracked', 'That file is not tracked by git. Delete it instead.');
      }
      if (entry.index === 'added' || parsed.oid === null) {
        // The file does not exist in the last commit, so there is nothing to go back to: unstage it and leave it on disk.
        const args =
          parsed.oid === null ? ['rm', '--cached', '--quiet', '--ignore-unmatch', '--', file!] : ['restore', '--staged', '--', file!];
        this.#ok(await this.exec.act(repo.root, args), 'other');
        return;
      }
      const paths = entry.originalPath === null ? [file!] : [entry.originalPath, file!];
      this.#ok(await this.exec.act(repo.root, ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...paths]), 'other');
    });
  }

  /** Deletes one file that git does not track. Refuses anything tracked. */
  async deleteUntracked(rootDir: string, requested: string): Promise<string> {
    const repo = await this.repository(rootDir);
    const resolved = await resolveEntry(rootDir, requested);
    if (resolved.relative === '') throw badRequest('Name a file inside the project.', undefined, 'invalid_path');
    return this.exclusive(repo.root, async () => {
      const { parsed } = await this.#parsedStatus(repo.root);
      const entry = parsed.files.find((candidate) => candidate.path === resolved.relative);
      if (!entry || entry.worktree !== 'untracked') {
        throw gitError(400, 'git_not_untracked', 'Only a file that git does not track can be deleted this way.');
      }
      // Removes the entry itself; a link is unlinked, never followed.
      await fs.unlink(resolved.absolute);
      return resolved.relative;
    });
  }

  // ---- committing ---------------------------------------------------------------------

  #message(message: string): string {
    if (message.includes('\0')) throw badRequest('A commit message cannot contain that character.', undefined, 'invalid_message');
    const trimmed = message.trim();
    if (trimmed.length === 0) throw badRequest('Write a commit message first.', undefined, 'invalid_message');
    return `${trimmed}\n`;
  }

  async #commitStaged(repo: Repository, message: string, userId: string): Promise<GitCommitResult> {
    // The message travels on standard input: it can never be read as an option, whatever it starts with.
    // Hooks run and signing applies exactly as configured — there is no "skip verification" here.
    const result = await this.exec.act(repo.root, ['commit', '--file=-'], { input: message, env: this.identityEnv(userId) });
    if (result.code !== 0 || result.timedOut) {
      const failure = gitFailure(result, 'commit', this.exec.timeouts.act);
      // An unrecognised refusal of a commit is nearly always a hook saying no.
      if (failure.code === 'git_failed') {
        throw gitError(409, 'git_commit_rejected', 'The commit was refused, most likely by one of the repository’s commit hooks.', failure.details);
      }
      throw failure;
    }
    const head = this.#ok(await this.exec.query(repo.root, ['log', '-1', '--no-show-signature', `--format=%H${UNIT}%s`]), 'other');
    const [oid, subject] = head.stdout.replace(/\n$/, '').split(UNIT);
    const branch = await this.exec.query(repo.root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    return { oid: oid ?? '', subject: subject ?? '', branch: branch.code === 0 ? branch.stdout.trim() : null };
  }

  /** Commits what is staged (after staging `paths`, when given). */
  async commit(rootDir: string, userId: string, request: { message: string; paths?: readonly string[] | undefined }): Promise<GitCommitResult> {
    const message = this.#message(request.message);
    const repo = await this.repository(rootDir);
    const paths = request.paths ? await this.#paths(rootDir, request.paths) : null;
    return this.exclusive(repo.root, async () => {
      if (paths) this.#ok(await this.exec.act(repo.root, ['add', '--all', '--', ...paths]), 'other');
      const { parsed } = await this.#parsedStatus(repo.root);
      if (parsed.files.some((file) => file.conflicted)) {
        throw gitError(409, 'git_conflict', 'Some files still have merge conflicts. Resolve them before committing.');
      }
      const merging = (await this.#operation(repo.gitDir)) === 'merge';
      if (!merging && !parsed.files.some((file) => file.index !== null)) {
        throw gitError(409, 'git_nothing_to_commit', 'There is nothing staged to commit.');
      }
      return this.#commitStaged(repo, message, userId);
    });
  }

  /** Makes the folder a repository. Reports, without changing anything, when it already is one. */
  async init(rootDir: string): Promise<{ created: boolean }> {
    const inspection = await this.inspect(rootDir);
    if (inspection.state === 'ready') return { created: false };
    if (inspection.state === 'unavailable') throw gitError(503, 'git_unavailable', inspection.message!);
    if (inspection.state === 'untrusted') throw gitError(409, 'git_untrusted', inspection.message!);
    if (inspection.state === 'bare') throw gitError(409, 'git_not_a_repository', inspection.message!, { state: 'bare' });
    this.#ok(await this.exec.act(inspection.root, ['init', '--quiet']), 'other');
    return { created: true };
  }

  /** Stages everything and creates the first commit. Refused once the repository has commits. */
  async initialCommit(rootDir: string, userId: string, message: string | undefined): Promise<GitCommitResult> {
    const text = this.#message(message === undefined || message.trim() === '' ? FIRST_COMMIT_MESSAGE : message);
    const repo = await this.repository(rootDir);
    return this.exclusive(repo.root, async () => {
      const before = await this.#parsedStatus(repo.root);
      if (before.parsed.oid !== null) throw badRequest('This repository already has commits.', undefined, 'git_has_commits');
      this.#ok(await this.exec.act(repo.root, ['add', '--all', '--', '.']), 'other');
      const after = await this.#parsedStatus(repo.root);
      if (!after.parsed.files.some((file) => file.index !== null)) {
        throw gitError(409, 'git_nothing_to_commit', 'The folder has no files to commit yet.');
      }
      return this.#commitStaged(repo, text, userId);
    });
  }

  /**
   * Removes the latest commit and keeps its changes staged — only while that
   * commit exists nowhere but here. A commit that has been pushed is left
   * alone: rewriting it would diverge from everyone who already has it.
   */
  async undoCommit(rootDir: string): Promise<{ undone: string; head: string | null }> {
    const repo = await this.repository(rootDir);
    return this.exclusive(repo.root, async () => {
      await this.#refuseUnfinished(repo);
      const head = await this.exec.query(repo.root, ['rev-list', '--parents', '-n', '1', 'HEAD']);
      if (head.code !== 0) throw gitError(400, 'git_no_commits', 'There is no commit to undo.');
      const [undone, ...parents] = head.stdout.trim().split(' ');
      if (parents.length > 1) {
        throw gitError(409, 'git_merge_commit', 'The latest commit is a merge. Undoing a merge is not supported here.');
      }
      const pushed = this.#ok(await this.exec.query(repo.root, ['for-each-ref', '--contains', 'HEAD', '--count=1', '--format=%(refname:short)', 'refs/remotes']), 'other');
      if (pushed.stdout.trim().length > 0) {
        throw gitError(409, 'git_commit_pushed', `The latest commit has already been pushed (it is on ${pushed.stdout.trim()}), so it is not undone.`);
      }
      if (parents.length === 0) this.#ok(await this.exec.act(repo.root, ['update-ref', '-d', 'HEAD']), 'other');
      else this.#ok(await this.exec.act(repo.root, ['reset', '--soft', 'HEAD~1']), 'other');
      return { undone: undone!, head: parents[0] ?? null };
    });
  }

  // ---- branches ----------------------------------------------------------------------

  async worktreeList(root: string): Promise<ParsedWorktree[]> {
    const result = this.#ok(await this.exec.query(root, ['worktree', 'list', '--porcelain', '-z']), 'other');
    return parseWorktreeList(result.stdout);
  }

  async branches(rootDir: string): Promise<GitBranches> {
    const repo = await this.repository(rootDir);
    const format = ['%(refname)', '%(objectname)', '%(HEAD)', '%(upstream:short)', '%(upstream:track,nobracket)', '%(committerdate:unix)', '%(symref)', '%(contents:subject)'].join('%00');
    const [refs, remotes, worktrees] = await Promise.all([
      this.exec.query(repo.root, ['for-each-ref', `--format=${format}%00${RECORD}`, 'refs/heads', 'refs/remotes'], { maxOutputBytes: 8 * 1024 * 1024 }),
      this.#remotes(repo.root),
      this.worktreeList(repo.root),
    ]);
    this.#ok(refs, 'other');
    const elsewhere = new Set(worktrees.filter((worktree) => worktree.path !== repo.root && worktree.branch !== null).map((worktree) => worktree.branch!));

    const branches: GitBranch[] = [];
    let current: string | null = null;
    let remoteDefault: string | null = null;
    for (const record of refs.stdout.split(RECORD)) {
      const parts = record.replace(/^\n/, '').split('\0');
      if (parts.length < 8) continue;
      const [refname, oid, head, upstream, track, date, symref, subject] = parts as [string, string, string, string, string, string, string, string];
      if (refname.startsWith('refs/remotes/')) {
        const short = refname.slice('refs/remotes/'.length);
        const remote = remotes.filter((name) => short.startsWith(`${name}/`)).sort((a, b) => b.length - a.length)[0] ?? null;
        if (symref !== '') {
          // "origin/HEAD" is a pointer to the remote's default branch, not a branch.
          if (remote === 'origin' || remoteDefault === null) remoteDefault = symref.slice('refs/remotes/'.length);
          continue;
        }
        branches.push({
          name: short,
          kind: 'remote',
          remote,
          current: false,
          oid,
          upstream: null,
          upstreamGone: false,
          ahead: null,
          behind: null,
          subject,
          committedAt: Number(date) * 1000,
          checkedOutElsewhere: false,
        });
        continue;
      }
      const name = refname.slice('refs/heads/'.length);
      const tracking = parseTrack(track);
      if (head === '*') current = name;
      branches.push({
        name,
        kind: 'local',
        remote: null,
        current: head === '*',
        oid,
        upstream: upstream === '' ? null : upstream,
        upstreamGone: tracking.gone,
        ahead: upstream === '' || tracking.gone ? null : tracking.ahead,
        behind: upstream === '' || tracking.gone ? null : tracking.behind,
        subject,
        committedAt: Number(date) * 1000,
        checkedOutElsewhere: elsewhere.has(name),
      });
    }

    const locals = new Set(branches.filter((branch) => branch.kind === 'local').map((branch) => branch.name));
    const remoteDefaultLocal = remoteDefault === null ? null : remoteDefault.slice(remoteDefault.indexOf('/') + 1);
    const defaultBranch =
      (remoteDefaultLocal !== null && locals.has(remoteDefaultLocal) ? remoteDefaultLocal : null) ??
      remoteDefault ??
      (locals.has('main') ? 'main' : locals.has('master') ? 'master' : null);
    const head = await this.exec.query(repo.root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    return { current: current ?? (head.code === 0 ? head.stdout.trim() : null), detached: head.code !== 0, defaultBranch, branches };
  }

  async createBranch(rootDir: string, request: { name: string; from?: string | undefined; switch: boolean }): Promise<{ branch: string; current: string | null }> {
    const name = assertBranchName(request.name);
    if (request.from !== undefined) assertRevision(request.from);
    const repo = await this.repository(rootDir);
    return this.exclusive(repo.root, async () => {
      if (await this.#branchExists(repo.root, name)) throw gitError(409, 'git_branch_exists', `A branch called "${name}" already exists.`);
      const start = request.from === undefined ? null : await this.#resolveCommit(repo.root, request.from);
      if (request.switch) {
        // "-c" takes the new name as its value, so it is never read as an option; the start point is a commit id.
        this.#ok(await this.exec.act(repo.root, ['switch', '-c', name, ...(start ? [start] : [])]), 'switch');
        return { branch: name, current: name };
      }
      this.#ok(await this.exec.act(repo.root, ['branch', '--', name, ...(start ? [start] : [])]), 'branch');
      const head = await this.exec.query(repo.root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
      return { branch: name, current: head.code === 0 ? head.stdout.trim() : null };
    });
  }

  /**
   * Switches branches. Git decides whether uncommitted changes can come
   * along; when they cannot, nothing is changed and the refusal says so. There
   * is no way to force a switch from here.
   */
  async switchBranch(rootDir: string, request: { branch: string; kind: 'local' | 'remote' }): Promise<{ branch: string; current: string | null }> {
    assertRevision(request.branch);
    const repo = await this.repository(rootDir);
    return this.exclusive(repo.root, async () => {
      await this.#refuseUnfinished(repo);
      let local = request.branch;
      let track: string | null = null;
      if (request.kind === 'remote') {
        const remotes = await this.#remotes(repo.root);
        const remote = remotes.filter((name) => request.branch.startsWith(`${name}/`)).sort((a, b) => b.length - a.length)[0];
        if (!remote) throw gitError(400, 'git_unknown_ref', `There is no remote branch called "${request.branch}" here.`);
        local = assertBranchName(request.branch.slice(remote.length + 1));
        const tracking = `refs/remotes/${request.branch}`;
        const known = await this.exec.query(repo.root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${tracking}^{commit}`]);
        if (known.code !== 0) throw gitError(400, 'git_unknown_ref', `There is no remote branch called "${request.branch}" here.`);
        if (!(await this.#branchExists(repo.root, local))) track = tracking;
      } else {
        assertBranchName(local);
        if (!(await this.#branchExists(repo.root, local))) throw gitError(400, 'git_unknown_ref', `There is no branch called "${local}" here.`);
      }
      const args = track ? ['switch', '-c', local, '--track', track] : ['switch', '--no-guess', '--', local];
      this.#ok(await this.exec.act(repo.root, args), 'switch');
      return { branch: local, current: local };
    });
  }

  async deleteBranch(rootDir: string, request: { name: string; force: boolean }): Promise<{ branch: string; current: string | null }> {
    const name = assertBranchName(request.name);
    const repo = await this.repository(rootDir);
    return this.exclusive(repo.root, async () => {
      const head = await this.exec.query(repo.root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
      const current = head.code === 0 ? head.stdout.trim() : null;
      if (current === name) throw gitError(400, 'git_branch_current', 'The branch you are on cannot be deleted. Switch to another branch first.');
      if (!(await this.#branchExists(repo.root, name))) throw gitError(400, 'git_unknown_ref', `There is no branch called "${name}" here.`);
      const result = await this.exec.act(repo.root, ['branch', request.force ? '-D' : '-d', '--', name]);
      if (result.code !== 0) {
        const output = cleanGitOutput(result.stderr);
        if (/not fully merged/i.test(output)) {
          throw gitError(409, 'git_branch_not_merged', `"${name}" holds commits that are merged nowhere else. Deleting it would lose them; confirm explicitly to delete it anyway.`, { output });
        }
        if (/used by worktree|checked out at/i.test(output)) {
          throw gitError(409, 'git_branch_in_use', `"${name}" is checked out in another worktree and cannot be deleted.`, { output });
        }
        throw gitFailure(result, 'branch');
      }
      return { branch: name, current };
    });
  }

  // ---- remote sync --------------------------------------------------------------------

  async #pickRemote(root: string, requested: string | undefined, preferred: string | null): Promise<string> {
    const remotes = await this.#remotes(root);
    if (remotes.length === 0) throw noRemote();
    if (requested !== undefined) {
      assertRemoteName(requested);
      if (!remotes.includes(requested)) throw gitError(400, 'git_invalid_remote', `This repository has no remote called "${requested}".`);
      return requested;
    }
    if (preferred !== null && remotes.includes(preferred)) return preferred;
    return remotes.includes('origin') ? 'origin' : remotes[0]!;
  }

  /**
   * Pull and push have nothing to sync with in a repository without any remote,
   * whatever state its branch is in, so they say that first — rather than
   * advising to publish a branch, which needs a remote too.
   */
  async #requireRemote(root: string): Promise<void> {
    if ((await this.#remotes(root)).length === 0) throw noRemote();
  }

  async #aheadBehind(root: string, left: string, right: string): Promise<{ ahead: number; behind: number } | null> {
    const result = await this.exec.query(root, ['rev-list', '--left-right', '--count', '--end-of-options', `${left}...${right}`]);
    const match = /^(\d+)\s+(\d+)/.exec(result.stdout);
    if (result.code !== 0 || !match) return null;
    return { ahead: Number(match[1]), behind: Number(match[2]) };
  }

  /** Files that would conflict if `theirs` were merged into `ours`. Computed without touching the work tree. */
  async mergeConflicts(root: string, ours: string, theirs: string): Promise<string[]> {
    const result = await this.exec.act(root, ['merge-tree', '--write-tree', '--name-only', '-z', '--no-messages', '--end-of-options', ours, theirs]);
    if (result.code === 0) return [];
    if (result.code !== 1) throw gitFailure(result, 'merge');
    return result.stdout
      .split('\0')
      .slice(1)
      .filter((entry) => entry.length > 0);
  }

  async #synced(rootDir: string, operation: GitSyncResult['operation'], remote: string, branch: string | null, output: string): Promise<GitSyncResult> {
    return { operation, remote, branch, summary: cleanGitOutput(output, 600), status: await this.status(rootDir) };
  }

  async fetch(rootDir: string, request: { remote?: string | undefined }): Promise<GitSyncResult> {
    if (request.remote !== undefined) assertRemoteName(request.remote);
    const repo = await this.repository(rootDir);
    return this.exclusive(repo.root, async () => {
      const { parsed } = await this.#parsedStatus(repo.root);
      const upstream = parsed.head === null ? null : await this.#upstream(repo.root, parsed.head);
      const remote = await this.#pickRemote(repo.root, request.remote, upstream?.remote ?? null);
      const result = await this.exec.network(repo.root, ['fetch', '--no-recurse-submodules', '--', remote]);
      this.#ok(result, 'fetch', this.exec.timeouts.network);
      return this.#synced(rootDir, 'fetch', remote, parsed.head, result.stderr);
    });
  }

  /**
   * Brings the branch up to date with its upstream. By default only by moving
   * it forward; when both sides have commits of their own the answer is
   * "diverged" and nothing changes. `merge` creates a merge commit, and only
   * when that is possible without conflicts — a half-finished merge is never
   * left behind.
   */
  async pull(rootDir: string, userId: string, request: { mode: 'ff-only' | 'merge' }): Promise<GitSyncResult> {
    const repo = await this.repository(rootDir);
    return this.exclusive(repo.root, async () => {
      await this.#requireRemote(repo.root);
      await this.#refuseUnfinished(repo);
      const { parsed } = await this.#parsedStatus(repo.root);
      if (parsed.head === null) throw gitError(409, 'git_detached_head', 'No branch is checked out, so there is nothing to pull into.');
      const upstream = await this.#upstream(repo.root, parsed.head);
      if (!upstream) throw gitError(409, 'git_no_upstream', 'This branch has no upstream branch on a remote yet. Publish it first.');

      const fetched = await this.exec.network(repo.root, ['fetch', '--no-recurse-submodules', '--', upstream.remote]);
      this.#ok(fetched, 'pull', this.exec.timeouts.network);

      const known = await this.exec.query(repo.root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${upstream.trackingRef}^{commit}`]);
      if (known.code !== 0) throw gitError(409, 'git_no_upstream', 'The upstream branch no longer exists on the remote.');

      if (parsed.oid !== null) {
        const counts = await this.#aheadBehind(repo.root, 'HEAD', upstream.trackingRef);
        if (counts === null) throw gitError(502, 'git_failed', 'The branch could not be compared with its upstream.');
        if (counts.behind === 0) return this.#synced(rootDir, 'pull', upstream.remote, parsed.head, 'Already up to date.');
        if (counts.ahead > 0) {
          if (request.mode === 'ff-only') {
            throw gitError(
              409,
              'git_diverged',
              `This branch and its upstream have diverged: ${counts.ahead} commit(s) here and ${counts.behind} there. Nothing was changed.`,
              counts,
            );
          }
          const conflicts = await this.mergeConflicts(repo.root, 'HEAD', upstream.trackingRef);
          if (conflicts.length > 0) {
            throw gitError(409, 'git_conflict', 'Merging the upstream would conflict. Nothing was changed.', { files: conflicts.slice(0, 200) });
          }
          const merged = await this.exec.act(repo.root, ['merge', '--no-edit', '--no-ff', upstream.trackingRef], { env: this.identityEnv(userId) });
          if (merged.code !== 0 || merged.timedOut) {
            // Whatever stopped it, do not leave the folder in the middle of a merge.
            await this.exec.act(repo.root, ['merge', '--abort']);
            throw gitFailure(merged, 'pull', this.exec.timeouts.act);
          }
          return this.#synced(rootDir, 'pull', upstream.remote, parsed.head, merged.stdout);
        }
      }
      const forwarded = await this.exec.act(repo.root, ['merge', '--ff-only', upstream.trackingRef]);
      this.#ok(forwarded, 'pull', this.exec.timeouts.act);
      return this.#synced(rootDir, 'pull', upstream.remote, parsed.head, forwarded.stdout);
    });
  }

  /** Pushes the current branch to its upstream, or publishes it. Never forces. */
  async push(rootDir: string, request: { remote?: string | undefined; publish: boolean }): Promise<GitSyncResult> {
    if (request.remote !== undefined) assertRemoteName(request.remote);
    const repo = await this.repository(rootDir);
    return this.exclusive(repo.root, async () => {
      await this.#requireRemote(repo.root);
      const { parsed } = await this.#parsedStatus(repo.root);
      if (parsed.head === null) throw gitError(409, 'git_detached_head', 'No branch is checked out, so there is nothing to push.');
      if (parsed.oid === null) throw gitError(409, 'git_no_commits', 'There are no commits to push yet.');
      const upstream = await this.#upstream(repo.root, parsed.head);
      let remote: string;
      let remoteRef: string;
      const args = ['push', '--porcelain'];
      if (upstream) {
        remote = upstream.remote;
        remoteRef = upstream.remoteRef;
      } else {
        if (!request.publish) throw gitError(409, 'git_no_upstream', 'This branch has no upstream branch on a remote yet. Publish it first.');
        remote = await this.#pickRemote(repo.root, request.remote, null);
        remoteRef = `refs/heads/${parsed.head}`;
        args.push('--set-upstream');
      }
      // An explicit, fully spelled refspec: no configured push rule and no "+" can turn this into a forced push.
      const result = await this.exec.network(repo.root, [...args, '--', remote, `refs/heads/${parsed.head}:${remoteRef}`]);
      this.#ok(result, 'push', this.exec.timeouts.network);
      return this.#synced(rootDir, 'push', remote, parsed.head, `${result.stdout}\n${result.stderr}`);
    });
  }

  // ---- history ------------------------------------------------------------------------

  #parseCommits(output: string): GitCommit[] {
    const commits: GitCommit[] = [];
    for (const record of output.split(RECORD)) {
      const parts = record.replace(/^\n/, '').split('\0');
      if (parts.length < 7) continue;
      const [oid, parents, authorName, authorEmail, authoredAt, decorations, subject] = parts as [string, string, string, string, string, string, string];
      commits.push({
        oid,
        parents: parents.length === 0 ? [] : parents.split(' '),
        refs: decorations
          .split(', ')
          .filter((entry) => entry.length > 0)
          .flatMap((entry): GitCommit['refs'] => {
            const name = entry.startsWith('HEAD -> ') ? entry.slice('HEAD -> '.length) : entry;
            const labels: GitCommit['refs'] = entry === 'HEAD' || entry.startsWith('HEAD -> ') ? [{ name: 'HEAD', kind: 'head' }] : [];
            if (name.startsWith('refs/heads/')) labels.push({ name: name.slice('refs/heads/'.length), kind: 'branch' });
            else if (name.startsWith('refs/remotes/')) {
              if (!name.endsWith('/HEAD')) labels.push({ name: name.slice('refs/remotes/'.length), kind: 'remote' });
            } else if (name.startsWith('tag: refs/tags/')) labels.push({ name: name.slice('tag: refs/tags/'.length), kind: 'tag' });
            return labels;
          }),
        authorName,
        authorEmail,
        authoredAt: Number(authoredAt) * 1000,
        subject,
      });
    }
    return commits;
  }

  /** A page of history, newest first, children before parents. */
  async log(rootDir: string, request: { limit: number; cursor?: string | undefined; ref?: string | undefined }): Promise<GitLog> {
    const repo = await this.repository(rootDir);
    const skip = request.cursor === undefined ? 0 : Number(request.cursor);
    const start = request.ref === undefined ? null : await this.#resolveCommit(repo.root, request.ref);
    const head = await this.exec.query(repo.root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
    if (head.code !== 0 && start === null) return { commits: [], nextCursor: null };
    const format = `--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%D%x00%s%x00%x1e`;
    const result = this.#ok(
      await this.exec.query(
        repo.root,
        [
          'log',
          '--no-show-signature',
          '--topo-order',
          '--decorate=full',
          format,
          `--max-count=${request.limit + 1}`,
          `--skip=${skip}`,
          // Stashes live under refs/stash and are deliberately not part of the picture.
          ...(start === null ? ['--branches', '--remotes', '--tags', 'HEAD'] : [start]),
          '--',
        ],
        { maxOutputBytes: 8 * 1024 * 1024 },
      ),
      'other',
    );
    const commits = this.#parseCommits(result.stdout);
    const more = commits.length > request.limit;
    return { commits: commits.slice(0, request.limit), nextCursor: more ? String(skip + request.limit) : null };
  }

  async #changedFiles(root: string, treeArgs: readonly string[]): Promise<{ files: GitChangedFile[]; additions: number; deletions: number }> {
    const common = ['--no-ext-diff', '--no-textconv', '--find-renames', '-z', ...treeArgs];
    const [names, numbers] = await Promise.all([
      this.exec.query(root, ['diff-tree', '-r', '--root', '--no-commit-id', '--name-status', ...common], { maxOutputBytes: 8 * 1024 * 1024 }),
      this.exec.query(root, ['diff-tree', '-r', '--root', '--no-commit-id', '--numstat', ...common], { maxOutputBytes: 8 * 1024 * 1024 }),
    ]);
    this.#ok(names, 'other');
    this.#ok(numbers, 'other');
    const counts = parseNumstat(numbers.stdout);
    let additions = 0;
    let deletions = 0;
    const files = parseNameStatus(names.stdout).map((file) => {
      const count = counts.get(file.path) ?? { additions: null, deletions: null };
      additions += count.additions ?? 0;
      deletions += count.deletions ?? 0;
      return { ...file, additions: count.additions, deletions: count.deletions };
    });
    return { files, additions, deletions };
  }

  /** One commit with its changed files and a size-limited diff, against its first parent. */
  async commitDetail(rootDir: string, requested: string): Promise<GitCommitDetail> {
    assertOid(requested);
    const repo = await this.repository(rootDir);
    const oid = await this.#resolveCommit(repo.root, requested);
    const format = `--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%D%x00%s%x00%cn%x00%ct%x00%b%x00%x1e`;
    const meta = this.#ok(await this.exec.query(repo.root, ['log', '-1', '--no-show-signature', '--decorate=full', format, oid, '--']), 'other');
    const [commit] = this.#parseCommits(meta.stdout);
    if (!commit) throw gitError(400, 'git_unknown_ref', 'That commit could not be read.');
    const extra = meta.stdout.split(RECORD)[0]!.split('\0');

    // Against the first parent: for a merge this is "what the merge brought in".
    const treeArgs = commit.parents.length === 0 ? [oid] : [commit.parents[0]!, oid];
    const [changed, patch] = await Promise.all([
      this.#changedFiles(repo.root, treeArgs),
      this.exec.query(repo.root, ['diff-tree', '-r', '--root', '--no-commit-id', '--patch', '--no-ext-diff', '--no-textconv', '--find-renames', '--no-color', ...treeArgs], {
        maxOutputBytes: this.limits.commitDiffBytes,
      }),
    ]);
    if (patch.code !== 0 && !patch.truncated) throw gitFailure(patch, 'other');
    return {
      ...commit,
      body: (extra[9] ?? '').trim(),
      committerName: extra[7] ?? '',
      committedAt: Number(extra[8] ?? 0) * 1000,
      files: changed.files.slice(0, this.limits.statusFiles),
      additions: changed.additions,
      deletions: changed.deletions,
      diff: cutToLines(patch.stdout, patch.truncated),
      diffTruncated: patch.truncated,
    };
  }

  async #mergeBase(root: string, base: string): Promise<string> {
    const baseOid = await this.#resolveCommit(root, base);
    const head = await this.exec.query(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
    if (head.code !== 0) throw gitError(400, 'git_no_commits', 'This repository has no commits to compare yet.');
    const result = await this.exec.query(root, ['merge-base', '--end-of-options', baseOid, 'HEAD']);
    const mergeBase = result.stdout.trim();
    if (result.code !== 0 || !isFullOid(mergeBase)) {
      throw gitError(400, 'git_no_common_history', `"${base}" shares no history with the current branch, so there is nothing to compare against.`);
    }
    return mergeBase;
  }

  /** Everything that differs from the common ancestor with `base`, uncommitted and untracked files included. */
  async compare(rootDir: string, base: string): Promise<GitComparison> {
    const repo = await this.repository(rootDir);
    const mergeBase = await this.#mergeBase(repo.root, base);
    const options = { readsWorktree: true, maxOutputBytes: 8 * 1024 * 1024 };
    const common = ['diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=dirty', '--find-renames', '-z'];
    const [names, numbers, untracked] = await Promise.all([
      this.exec.query(repo.root, [...common, '--name-status', mergeBase, '--'], options),
      this.exec.query(repo.root, [...common, '--numstat', mergeBase, '--'], options),
      this.exec.query(repo.root, ['ls-files', '--others', '--exclude-standard', '-z'], { maxOutputBytes: 8 * 1024 * 1024 }),
    ]);
    this.#ok(names, 'other');
    this.#ok(numbers, 'other');
    this.#ok(untracked, 'other');
    const counts = parseNumstat(numbers.stdout);
    const files: GitChangedFile[] = parseNameStatus(names.stdout).map((file) => ({
      ...file,
      additions: counts.get(file.path)?.additions ?? null,
      deletions: counts.get(file.path)?.deletions ?? null,
    }));
    for (const file of untracked.stdout.split('\0')) {
      if (file.length > 0) files.push({ path: file, originalPath: null, status: 'U', additions: null, deletions: null });
    }
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return {
      base,
      mergeBase,
      files: files.slice(0, this.limits.statusFiles),
      truncated: files.length > this.limits.statusFiles || names.truncated || untracked.truncated,
    };
  }

  /** The diff of one file against the common ancestor with `base`. An untracked file is all additions. */
  async compareDiff(rootDir: string, request: { base: string; path: string; originalPath?: string | undefined }): Promise<GitFileDiff> {
    const repo = await this.repository(rootDir);
    const paths = await this.#paths(rootDir, request.originalPath === undefined ? [request.path] : [request.originalPath, request.path]);
    const file = paths[paths.length - 1]!;
    const mergeBase = await this.#mergeBase(repo.root, request.base);
    const result = this.#ok(
      await this.exec.query(
        repo.root,
        ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--ignore-submodules=dirty', '--find-renames', mergeBase, '--', ...paths],
        { readsWorktree: true, maxOutputBytes: this.limits.diffBytes },
      ),
      'other',
    );
    if (result.stdout.length > 0) return this.#diffResult(file, result);
    const untracked = await this.exec.query(repo.root, ['ls-files', '--others', '--exclude-standard', '-z', '--', file]);
    if (untracked.code === 0 && untracked.stdout.split('\0').includes(file)) return this.#untrackedDiff(repo.root, file);
    return this.#diffResult(file, result);
  }

  // ---- used by the worktree and GitHub features ----------------------------------------

  /** Whether a work tree has anything uncommitted (untracked files count). Null when it cannot be read. */
  async changeCount(root: string): Promise<number | null> {
    try {
      const result = await this.exec.query(root, ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignore-submodules=dirty'], {
        readsWorktree: true,
        maxOutputBytes: 8 * 1024 * 1024,
      });
      if (result.code !== 0) return null;
      return parseStatusV2(result.stdout).files.length;
    } catch {
      return null;
    }
  }

  aheadBehind(root: string, left: string, right: string): Promise<{ ahead: number; behind: number } | null> {
    return this.#aheadBehind(root, left, right);
  }

  run(kind: 'query' | 'act', root: string, args: readonly string[], options: GitCallOptions = {}): Promise<RunResult> {
    return kind === 'query' ? this.exec.query(root, args, options) : this.exec.act(root, args, options);
  }

  /** The current branch and the address of the remote it would be published to, for looking up its pull request. */
  async branchAndRemote(rootDir: string): Promise<{ state: GitRepositoryState; branch: string | null; remoteUrl: string | null }> {
    const inspection = await this.inspect(rootDir);
    if (inspection.state !== 'ready') return { state: inspection.state, branch: null, remoteUrl: null };
    const { root } = inspection;
    const head = await this.exec.query(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { timeoutMs: 5000 });
    const branch = head.code === 0 ? head.stdout.trim() : null;
    const upstream = branch === null ? null : await this.#upstream(root, branch);
    const remotes = await this.#remotes(root);
    const remote = upstream?.remote ?? (remotes.includes('origin') ? 'origin' : remotes[0]);
    if (remote === undefined) return { state: 'ready', branch, remoteUrl: null };
    const url = await this.exec.query(root, ['config', '--get', `remote.${remote}.url`], { timeoutMs: 5000 });
    return { state: 'ready', branch, remoteUrl: url.code === 0 ? url.stdout.trim() : null };
  }
}
