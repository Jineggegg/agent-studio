import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROJECT_CLONE_UPDATED, type CloneJob, type CloneProjectRequest } from '@agent-studio/protocol';
import { newId } from '../../kernel/crypto.js';
import { badRequest, conflict, describeError, forbidden, isStudioError, notFound, unavailable } from '../../kernel/errors.js';
import type { ModuleContext } from '../../kernel/module.js';
import type { Principal } from '../../kernel/principal.js';
import { terminate, type ProcessSupervisor } from '../../kernel/process.js';
import { classifyGitFailure, cleanGitOutput } from './git.errors.js';
import type { GitExec } from './git.exec.js';
import { parseRepositoryAddress } from './git.refs.js';

/** A running child, as the kernel's process supervisor hands it out. */
type ChildProcess = ReturnType<ProcessSupervisor['spawn']>;

interface Job {
  snapshot: CloneJob;
  readonly userId: string;
  readonly principal: Principal;
  readonly projectName: string;
  child: ChildProcess | null;
  timer: NodeJS.Timeout | null;
  lastPublished: number;
  /** The tail of what git printed, for explaining a failure. */
  tail: string;
  cancelled: boolean;
  timedOut: boolean;
}

const FOLDER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const MAX_RUNNING = 2;
const KEEP_FINISHED_MS = 10 * 60_000;
const PROGRESS_INTERVAL_MS = 250;

function expandHome(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

/**
 * Creates a project by cloning a repository.
 *
 * The address is checked before git is involved (https and ssh only, no
 * credentials inside, nothing option-like), git is additionally told to accept
 * no other transport, the destination is a new folder inside a workspace root,
 * git cannot prompt, and the whole thing has a time limit. A clone that fails,
 * is cancelled or times out leaves no folder behind. Progress is published on
 * the user's realtime topic; the job can also be polled.
 */
export class CloneManager {
  readonly #exec: GitExec;
  readonly #context: ModuleContext;
  readonly #jobs = new Map<string, Job>();

  constructor(exec: GitExec, context: ModuleContext) {
    this.#exec = exec;
    this.#context = context;
  }

  #publish(job: Job, force: boolean): void {
    const now = Date.now();
    if (!force && now - job.lastPublished < PROGRESS_INTERVAL_MS) return;
    job.lastPublished = now;
    this.#context.bus.publish(`user:${job.userId}`, PROJECT_CLONE_UPDATED, job.snapshot);
  }

  #forgetOld(): void {
    const now = Date.now();
    for (const [id, job] of this.#jobs) {
      if (job.snapshot.finishedAt !== null && now - job.snapshot.finishedAt > KEEP_FINISHED_MS) this.#jobs.delete(id);
    }
  }

  #own(principal: Principal, id: string): Job {
    const job = this.#jobs.get(id);
    // Another user's job answers exactly like one that never existed.
    if (!job || job.userId !== principal.userId) throw notFound('No such clone.', 'clone_not_found');
    return job;
  }

  get(principal: Principal, id: string): CloneJob {
    return this.#own(principal, id).snapshot;
  }

  cancel(principal: Principal, id: string): CloneJob {
    const job = this.#own(principal, id);
    if (job.snapshot.state === 'running' && job.child) {
      job.cancelled = true;
      terminate(job.child, 1500);
    }
    return job.snapshot;
  }

  /** Stops every running clone. Called when the server shuts down. */
  stop(): void {
    for (const job of this.#jobs.values()) {
      if (job.timer) clearTimeout(job.timer);
      if (job.snapshot.state === 'running' && job.child) {
        job.cancelled = true;
        terminate(job.child, 1000);
      }
    }
  }

  async start(principal: Principal, request: CloneProjectRequest): Promise<CloneJob> {
    if (principal.role !== 'owner') throw forbidden('Only the owner can add projects.', 'owner_required');
    this.#forgetOld();
    const address = parseRepositoryAddress(request.url);

    const folder = (request.directoryName ?? address.name).trim();
    if (!FOLDER_NAME.test(folder) || folder.includes('..') || folder.toLowerCase() === '.git') {
      throw badRequest(
        folder.length === 0 ? 'Give the folder for the clone a name.' : 'The folder name can contain letters, digits, dots, dashes and underscores only.',
        undefined,
        'invalid_directory_name',
      );
    }
    const parent = request.parentDir ?? this.#context.config.workspaceRoots[0];
    if (parent === undefined) throw unavailable('No workspace folder is configured, so there is nowhere to clone into.', 'no_workspace_root');
    if (parent.includes('\0')) throw badRequest('That path is not valid.', undefined, 'invalid_path');
    const expanded = expandHome(parent.trim());
    if (!path.isAbsolute(expanded)) throw badRequest('Give the full path of the folder to clone into.', undefined, 'invalid_path');
    const candidate = path.join(path.resolve(expanded), folder);

    if ([...this.#jobs.values()].filter((job) => job.snapshot.state === 'running').length >= MAX_RUNNING) {
      throw unavailable('Other clones are still running. Wait for one of them to finish.', 'git_busy');
    }
    // An existing folder — even an empty one — is never cloned into, so a failed clone can always be removed whole.
    if (await fs.lstat(candidate).then(() => true, () => false)) {
      throw conflict(`A folder called "${folder}" already exists there.`, 'target_exists');
    }
    // Applies every location rule (workspace roots, system folders, links) and only then creates the folder.
    const target = await this.#context.services.projects.resolveRootDir(candidate, true);

    const job: Job = {
      snapshot: {
        id: newId(),
        url: address.url,
        targetDir: target,
        state: 'running',
        phase: 'Starting',
        percent: null,
        startedAt: Date.now(),
        finishedAt: null,
        project: null,
        error: null,
      },
      userId: principal.userId,
      principal,
      projectName: request.name ?? folder,
      child: null,
      timer: null,
      lastPublished: 0,
      tail: '',
      cancelled: false,
      timedOut: false,
    };
    this.#jobs.set(job.snapshot.id, job);

    const { args, env } = this.#exec.cloneInvocation(address.url, target);
    let child: ChildProcess;
    try {
      child = this.#context.processes.spawn('git', args, { cwd: path.dirname(target), env });
    } catch (error) {
      await fs.rm(target, { recursive: true, force: true });
      this.#jobs.delete(job.snapshot.id);
      throw error;
    }
    job.child = child;
    job.timer = setTimeout(() => {
      job.timedOut = true;
      terminate(child, 1500);
    }, this.#exec.timeouts.clone);
    job.timer.unref();

    let pending = '';
    const onOutput = (chunk: Buffer) => {
      pending += chunk.toString('utf8');
      const lines = pending.split(/[\r\n]/);
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim().length === 0) continue;
        job.tail = `${job.tail}\n${line}`.slice(-4000);
        const progress = /^(?:remote: )?([A-Za-z][A-Za-z ]{2,40}?):\s+(\d{1,3})%/.exec(line);
        if (progress) {
          const phase = progress[1]!;
          const percent = Math.min(100, Number(progress[2]));
          const changed = phase !== job.snapshot.phase;
          job.snapshot = { ...job.snapshot, phase, percent };
          this.#publish(job, changed);
        }
      }
    };
    child.stderr?.on('data', onOutput);
    child.stdout?.on('data', () => {});
    child.once('error', (error) => {
      job.tail = `${job.tail}\n${describeError(error)}`;
      void this.#finish(job, null, (error as NodeJS.ErrnoException).code === 'ENOENT');
    });
    child.once('close', (code) => {
      job.tail = `${job.tail}\n${pending}`.slice(-4000);
      void this.#finish(job, code, false);
    });

    this.#publish(job, true);
    return job.snapshot;
  }

  async #finish(job: Job, code: number | null, gitMissing: boolean): Promise<void> {
    if (job.snapshot.state !== 'running') return;
    if (job.timer) clearTimeout(job.timer);
    job.child = null;
    const target = job.snapshot.targetDir;
    const fail = async (state: 'failed' | 'cancelled', error: { code: string; message: string } | null) => {
      // Nothing half-cloned stays behind. The folder did not exist before this job created it.
      await fs.rm(target, { recursive: true, force: true }).catch(() => undefined);
      job.snapshot = { ...job.snapshot, state, percent: null, finishedAt: Date.now(), error };
      this.#publish(job, true);
    };

    try {
      if (job.cancelled) return await fail('cancelled', null);
      if (gitMissing) return await fail('failed', { code: 'git_unavailable', message: 'Git is not installed on the server.' });
      if (job.timedOut) {
        const minutes = Math.max(1, Math.round(this.#exec.timeouts.clone / 60_000));
        return await fail('failed', { code: 'git_timeout', message: `The clone did not finish within ${minutes} minute(s) and was stopped.` });
      }
      if (code !== 0) {
        const output = cleanGitOutput(job.tail, 600);
        const classified = classifyGitFailure(output, 'clone');
        const lastLine = output.split('\n').filter((line) => line.length > 0).pop();
        return await fail('failed', {
          code: classified.code,
          message: classified.code === 'git_failed' && lastLine ? `${classified.message} Git said: ${lastLine}` : classified.message,
        });
      }
      const project = await this.#context.services.projects.create(job.principal, {
        name: job.projectName,
        rootDir: target,
        description: '',
        createDirectory: false,
      });
      job.snapshot = { ...job.snapshot, state: 'done', phase: 'Done', percent: 100, finishedAt: Date.now(), project };
      this.#publish(job, true);
    } catch (error) {
      await fail('failed', {
        code: isStudioError(error) ? error.code : 'internal_error',
        message: isStudioError(error) ? error.message : 'The repository was cloned but could not be registered as a project.',
      });
      if (!isStudioError(error)) this.#context.log.error({ err: describeError(error) }, 'clone could not be completed');
    }
  }
}
