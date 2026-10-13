import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type CloseTerminalSessionResponse,
  type CreateTerminalSessionRequest,
  TERMINAL_CLOSE_CODES,
  TERMINAL_EVENTS,
  TYPED_TEXT_MAX_CHARS,
  type TerminalCapability,
  type TerminalErrorCode,
  type TerminalLauncherInfo,
  type TerminalSession as TerminalSessionInfo,
  type TypeTextResponse,
} from '@agent-studio/protocol';
import type { WebSocket } from 'ws';
import { newId } from '../../kernel/crypto.js';
import { badRequest, conflict, describeError, forbidden, notFound, unavailable } from '../../kernel/errors.js';
import { RECENT_AUTH_WINDOW_MS } from '../../kernel/http.js';
import type { ModuleContext } from '../../kernel/module.js';
import type { Principal } from '../../kernel/principal.js';
import type { ProjectRecord } from '../projects/projects.service.js';
import { type LaunchPlan, LauncherRegistry, type TerminalLauncher } from './launchers.js';
import type { TerminalLimits } from './limits.js';
import { chooseLoginShell, findExecutable, probeHostShell } from './login-shell.js';
import { type ProcessLister, hostProcessLister, identifyLeader } from './process-table.js';
import type { PtyLoader, PtyProcess } from './pty.js';
import { TerminalSession } from './terminal.session.js';
import { sanitizeTypedText } from './typed-text.js';

export interface ShellCommand {
  readonly file: string;
  readonly args: readonly string[];
}

export interface TerminalServiceOptions {
  readonly limits: TerminalLimits;
  readonly loadPty: PtyLoader;
  /** Replaces the account's login shell. For tests; production always asks the operating system. */
  readonly shell: ShellCommand | null;
}

const isRecent = (principal: Principal): boolean =>
  principal.via === 'session' && Date.now() - principal.authenticatedAt <= RECENT_AUTH_WINDOW_MS;

/**
 * Owns every terminal session of the server: who may open one, what it may
 * run, how many there may be, and that none outlives the server.
 *
 * Sessions are kept per user and are looked up through their user, so one
 * account can never address another account's terminal — not even another
 * owner's. An unknown id and somebody else's id are the same "not found".
 */
export class TerminalService {
  readonly limits: TerminalLimits;
  readonly #context: ModuleContext;
  readonly #loadPty: PtyLoader;
  readonly #shellOverride: ShellCommand | null;
  readonly #launchers = new LauncherRegistry();
  readonly #byUser = new Map<string, Map<string, TerminalSession>>();
  readonly #removals = new Map<string, NodeJS.Timeout>();
  readonly #listProcesses: ProcessLister;
  readonly #heartbeat: NodeJS.Timeout;
  #shell: ShellCommand | null = null;
  #stopped = false;

  constructor(context: ModuleContext, options: TerminalServiceOptions) {
    this.#context = context;
    this.limits = options.limits;
    this.#loadPty = options.loadPty;
    this.#shellOverride = options.shell;
    this.#listProcesses = hostProcessLister(context.processes);

    this.#heartbeat = setInterval(() => this.heartbeat(), this.limits.heartbeatMs);
    this.#heartbeat.unref();

    const { bus } = context;
    // A browser session that is signed out loses its connections at once, and its
    // standing permission to attach.
    bus.on('auth.credential.revoked', (event) => {
      const { credentialId } = event.data as { credentialId: string };
      for (const session of this.#all()) session.revokeCredential(credentialId);
      this.#endSessionsOfIneligibleUsers();
    });
    bus.on('auth.user.revoked', (event) => {
      const { userId } = event.data as { userId: string };
      for (const session of this.#of(userId).values()) void session.terminate('revoked');
    });
    bus.on('project.deleting', (event) => {
      const { projectId } = event.data as { projectId: string };
      for (const session of this.#all()) if (session.projectId === projectId) void session.terminate('project_removed');
    });
  }

  // ---- launchers -------------------------------------------------------------

  /**
   * Adds a program that a terminal may start besides the login shell. This is
   * the only way to extend what terminals run; clients pick launchers by key.
   */
  registerLauncher(launcher: TerminalLauncher, options: { replace?: boolean } = {}): void {
    this.#launchers.register(launcher, options);
  }

  // ---- reading ----------------------------------------------------------------

  async capability(principal: Principal): Promise<TerminalCapability> {
    const limits = {
      maxSessionsPerUser: this.limits.maxSessionsPerUser,
      maxSessions: this.limits.maxSessions,
      maxClientsPerSession: this.limits.maxClientsPerSession,
      idleTimeoutMs: this.limits.idleTimeoutMs,
      maxLifetimeMs: this.limits.maxLifetimeMs,
      replayBufferBytes: this.limits.replayBufferBytes,
      maxInputFrameBytes: this.limits.maxInputFrameBytes,
      typedTextMaxChars: TYPED_TEXT_MAX_CHARS,
    };
    const no = (code: NonNullable<TerminalCapability['reason']>['code'], message: string): TerminalCapability => ({
      available: false,
      reason: { code, message },
      needsReauth: false,
      shell: null,
      launchers: [],
      limits,
    });
    if (!this.#context.config.terminalEnabled) return no('disabled', 'Terminals are turned off on this server.');
    if (principal.role !== 'owner') return no('owner_only', 'Only the owner of this Studio can use a terminal.');
    if (principal.via !== 'session') return no('session_required', 'A terminal can only be used from a signed-in browser.');
    const pty = await this.#loadPty();
    if (!pty.available) return no('pty_unavailable', pty.reason.slice(0, 300));

    const environment = this.#environment();
    const launchers: TerminalLauncherInfo[] = this.#launchers.list().map((launcher) => {
      const unavailableReason = launcher.unavailableReason?.(environment) ?? null;
      return {
        key: launcher.key,
        title: launcher.title,
        kind: launcher.kind,
        requiresProject: !launcher.projectOptional,
        requiresRemote: launcher.remote === true,
        available: unavailableReason === null,
        unavailableReason,
      };
    });
    return {
      available: true,
      reason: null,
      needsReauth: !this.#mayCreate(principal),
      shell: path.basename(this.#loginShell().file),
      launchers,
      limits,
    };
  }

  list(principal: Principal, projectId?: string): TerminalSessionInfo[] {
    this.#requireEnabled();
    return [...this.#of(principal.userId).values()]
      .filter((session) => projectId === undefined || session.projectId === projectId)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .map((session) => session.describe(this.#mayAttach(session, principal)));
  }

  get(principal: Principal, sessionId: string): TerminalSessionInfo {
    const session = this.#require(principal, sessionId);
    return session.describe(this.#mayAttach(session, principal));
  }

  // ---- changes ----------------------------------------------------------------

  async create(principal: Principal, request: CreateTerminalSessionRequest, meta: { ip: string }): Promise<TerminalSessionInfo> {
    this.#requireEnabled();
    const pty = await this.#loadPty();
    if (!pty.available) throw unavailable('Terminals cannot run on this server.', 'terminal_unavailable', { reason: pty.reason.slice(0, 300) });

    const launcher = request.launcher === undefined ? null : this.#launchers.get(request.launcher);
    if (request.launcher !== undefined && !launcher) throw badRequest('There is no such launcher.', undefined, 'unknown_launcher');
    if (request.remote && !launcher?.remote) throw badRequest('Only a remote launcher takes a remote host.', undefined, 'remote_not_expected');
    if (launcher?.remote && !request.remote) throw badRequest('Choose the remote host to open.', undefined, 'remote_required');
    if (request.projectId === undefined && !launcher?.projectOptional) {
      throw badRequest('Choose the project to open a terminal in.', undefined, 'project_required');
    }
    // The folder comes from the project record. A shell can write, so write access is what is asked for.
    const project = request.projectId === undefined ? null : this.#context.services.projects.requireAccess(principal, request.projectId, 'write');

    if (!this.#mayCreate(principal)) throw forbidden('Confirm your identity to open a terminal.', 'reauth_required');
    this.#requireRoom(principal.userId);

    const shell = this.#loginShell();
    const plan: LaunchPlan = launcher
      ? await launcher.plan({
          user: principal,
          project,
          remote: request.remote ? { hostId: request.remote.hostId, directory: request.remote.directory ?? null } : null,
        })
      : { file: shell.file, args: shell.args };
    const environment = this.#environment({ SHELL: shell.file, ...plan.env });
    const cwd = await this.#workingDirectory(plan, project);

    let file = findExecutable(plan.file, environment.PATH);
    if (!file) {
      throw unavailable(`The ${path.basename(plan.file)} command is not installed on this computer.`, 'launcher_unavailable');
    }
    let args = [...plan.args];
    if (plan.sandbox) {
      const wrapped = this.#context.sandbox.wrap(file, args, plan.sandbox);
      if (wrapped.sandboxed) {
        const outer = findExecutable(wrapped.file, environment.PATH);
        if (!outer) throw unavailable('The sandbox this launcher needs is not available.', 'launcher_unavailable');
        file = outer;
        args = wrapped.args;
      }
    }

    // No awaits from here until the session is registered: the room check and
    // the start cannot be interleaved with another request.
    if (this.#stopped) throw unavailable('The server is shutting down.', 'terminal_unavailable');
    this.#requireRoom(principal.userId);
    let process: PtyProcess;
    try {
      process = pty.backend.spawn(file, args, { cwd, env: environment, cols: request.cols, rows: request.rows });
    } catch (error) {
      this.#context.log.error({ err: describeError(error), launcher: launcher?.key ?? 'shell' }, 'terminal could not be started');
      throw unavailable('The terminal could not be started.', 'terminal_start_failed');
    }

    const remoteHostId = plan.remoteHostId ?? null;
    const session = new TerminalSession({
      id: newId(),
      userId: principal.userId,
      createdBy: principal.credentialId,
      projectId: project?.id ?? null,
      title: request.title ?? (launcher ? (plan.title ?? launcher.title) : (project?.name ?? path.basename(shell.file))),
      launcher: launcher?.key ?? null,
      remoteHostId,
      directory: remoteHostId !== null ? (plan.remoteDirectory ?? null) : plan.cwd === 'neutral' ? null : (project?.rootDir ?? null),
      cols: request.cols,
      rows: request.rows,
      pty: process,
      identity: identifyLeader(process.pid),
      limits: this.limits,
      listProcesses: this.#listProcesses,
      onChange: (changed, what) => this.#onChange(changed, what),
      reportProblem: (error) => this.#context.log.warn({ err: describeError(error) }, 'terminal process table could not be read'),
    });
    let mine = this.#byUser.get(principal.userId);
    if (!mine) this.#byUser.set(principal.userId, (mine = new Map()));
    mine.set(session.id, session);

    // Who opened what, where — never what was typed or printed.
    this.#context.services.audit.record({
      category: 'change',
      action: 'terminal.session.created',
      userId: principal.userId,
      subject: project?.name ?? null,
      detail: [
        `launcher: ${launcher?.key ?? 'shell'}`,
        `project: ${project?.id ?? 'none'}`,
        ...(remoteHostId === null ? [] : [`remote host: ${remoteHostId}`, `remote directory: ${plan.remoteDirectory ?? 'default'}`]),
      ].join('; '),
      address: meta.ip,
    });
    this.#publish(session, TERMINAL_EVENTS.created);
    return session.describe(true);
  }

  rename(principal: Principal, sessionId: string, title: string): TerminalSessionInfo {
    const session = this.#require(principal, sessionId);
    session.rename(title);
    return session.describe(this.#mayAttach(session, principal));
  }

  /** Ends a session and everything running in it, and answers only once the process table confirms it. */
  async close(principal: Principal, sessionId: string): Promise<CloseTerminalSessionResponse> {
    const session = this.#require(principal, sessionId);
    const remaining = await session.terminate('closed');
    this.#remove(session);
    if (remaining.length > 0) {
      this.#context.log.warn({ sessionId: session.id, remaining: remaining.length }, 'terminal processes survived termination');
    }
    return { closed: true, remainingProcesses: remaining.length };
  }

  /** Types text into a session without pressing Enter. See `typed-text.ts` for what is removed and why. */
  typeText(principal: Principal, sessionId: string, input: string): TypeTextResponse {
    const session = this.#require(principal, sessionId);
    if (!this.#admit(session, principal)) throw forbidden('Confirm your identity to use this terminal.', 'reauth_required');
    if (!session.alive) throw conflict('That terminal has ended.', 'terminal_ended');
    const typed = sanitizeTypedText(input);
    if (typed.multiline) {
      throw badRequest('Only one line can be typed into the terminal at a time.', undefined, 'multiline_text');
    }
    if (typed.text.length === 0) throw badRequest('There is nothing to type.', undefined, 'nothing_to_type');
    session.write(Buffer.from(typed.text, 'utf8'));
    return { typed: typed.text, removed: typed.removed };
  }

  /** Hands a freshly upgraded WebSocket to its session, or closes it saying why not. */
  connect(socket: WebSocket, principal: Principal, sessionId: string): void {
    const refuse = (code: TerminalErrorCode, message: string, closeCode: number) => {
      // Nothing is read from a refused connection.
      socket.on('error', () => {});
      socket.send(JSON.stringify({ type: 'error', code, message }));
      socket.close(closeCode, code);
    };
    if (!this.#context.config.terminalEnabled || this.#stopped) {
      return refuse('terminal_disabled', 'Terminals are turned off on this server.', TERMINAL_CLOSE_CODES.unavailable);
    }
    const session = this.#of(principal.userId).get(sessionId);
    if (!session) return refuse('session_not_found', 'There is no such terminal.', TERMINAL_CLOSE_CODES.notFound);
    if (!this.#admit(session, principal)) {
      return refuse('reauth_required', 'Confirm your identity to attach to this terminal.', TERMINAL_CLOSE_CODES.reauthRequired);
    }
    session.accept(socket, principal);
  }

  // ---- housekeeping -------------------------------------------------------------

  /** Pings every attached client, drops the dead ones, and ends connections whose browser session has expired. */
  heartbeat(): void {
    this.#endSessionsOfIneligibleUsers();
    const authenticator = this.#context.http.authenticator;
    for (const session of this.#all()) session.heartbeat((principal) => authenticator.isCredentialLive(principal));
  }

  get liveSessionCount(): number {
    let count = 0;
    for (const session of this.#all()) if (session.alive) count += 1;
    return count;
  }

  /** Process id of a session's program, for diagnostics and tests. It is not part of the API. */
  processIdOf(userId: string, sessionId: string): number | null {
    return this.#of(userId).get(sessionId)?.pid ?? null;
  }

  /** Ends every terminal. Called when the server stops; afterwards nothing can be opened. */
  async shutdown(): Promise<void> {
    this.#stopped = true;
    clearInterval(this.#heartbeat);
    for (const timer of this.#removals.values()) clearTimeout(timer);
    this.#removals.clear();
    const sessions = this.#all();
    const results = await Promise.all(sessions.map((session) => session.terminate('shutdown')));
    const remaining = results.reduce((sum, pids) => sum + pids.length, 0);
    if (remaining > 0) this.#context.log.warn({ remaining }, 'terminal processes survived shutdown');
    this.#byUser.clear();
  }

  // ---- internals ------------------------------------------------------------------

  #all(): TerminalSession[] {
    return [...this.#byUser.values()].flatMap((sessions) => [...sessions.values()]);
  }

  #of(userId: string): Map<string, TerminalSession> {
    return this.#byUser.get(userId) ?? new Map<string, TerminalSession>();
  }

  #requireEnabled(): void {
    if (!this.#context.config.terminalEnabled) throw forbidden('Terminals are turned off on this server.', 'terminal_disabled');
  }

  /** The caller's own session, or "not found" — which is also the answer for somebody else's. */
  #require(principal: Principal, sessionId: string): TerminalSession {
    this.#requireEnabled();
    const session = this.#of(principal.userId).get(sessionId);
    if (!session) throw notFound('There is no such terminal.', 'terminal_not_found');
    return session;
  }

  /** Whether this browser may attach right now without confirming identity. Does not record anything. */
  #mayAttach(session: TerminalSession, principal: Principal): boolean {
    return session.isAdmitted(principal.credentialId) || isRecent(principal);
  }

  /** As {@link #mayAttach}, and remembers a browser that has just proved itself. */
  #admit(session: TerminalSession, principal: Principal): boolean {
    if (session.isAdmitted(principal.credentialId)) return true;
    if (!isRecent(principal)) return false;
    session.admit(principal.credentialId);
    return true;
  }

  /**
   * The first terminal of a browser session needs a recent proof of identity.
   * A browser that already holds a live terminal gains nothing from a second
   * one, so it is not asked again.
   */
  #mayCreate(principal: Principal): boolean {
    if (isRecent(principal)) return true;
    for (const session of this.#of(principal.userId).values()) {
      if (session.alive && session.isAdmitted(principal.credentialId)) return true;
    }
    return false;
  }

  #requireRoom(userId: string): void {
    let mine = 0;
    for (const session of this.#of(userId).values()) if (session.alive) mine += 1;
    if (mine >= this.limits.maxSessionsPerUser) {
      throw conflict('You have too many terminals open. Close one and try again.', 'terminal_limit_reached', {
        scope: 'user',
        limit: this.limits.maxSessionsPerUser,
      });
    }
    if (this.liveSessionCount >= this.limits.maxSessions) {
      throw conflict('Too many terminals are open on this server. Close one and try again.', 'terminal_limit_reached', {
        scope: 'server',
        limit: this.limits.maxSessions,
      });
    }
  }

  #loginShell(): ShellCommand {
    if (this.#shellOverride) return this.#shellOverride;
    if (!this.#shell) {
      const chosen = chooseLoginShell(probeHostShell(this.#context.processes.env().SHELL));
      if (chosen.source === 'fallback') this.#context.log.warn({ shell: chosen.file }, 'no usable login shell for the account; terminals use the fallback');
      this.#shell = { file: chosen.file, args: ['-l'] };
    }
    return this.#shell;
  }

  /**
   * The scrubbed child environment plus what a terminal needs. Nothing named
   * AGENT_STUDIO_* can be in it: the kernel drops such names from the baseline
   * and refuses them as additions.
   */
  #environment(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
    const processes = this.#context.processes;
    const base = processes.env();
    const hasLocale = Boolean(base.LC_ALL || base.LC_CTYPE || base.LANG);
    return processes.env({
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      // The browser side speaks UTF-8; say so when the server's own environment has no locale.
      ...(hasLocale ? {} : { LANG: 'C.UTF-8' }),
      ...extra,
    });
  }

  async #workingDirectory(plan: LaunchPlan, project: ProjectRecord | null): Promise<string> {
    const isDirectory = async (candidate: string) => (await fs.stat(candidate).catch(() => null))?.isDirectory() === true;
    if (project && plan.cwd !== 'neutral') {
      if (!(await isDirectory(project.rootDir))) {
        throw conflict("The project's folder no longer exists.", 'project_folder_missing');
      }
      return project.rootDir;
    }
    const home = os.homedir();
    return (await isDirectory(home)) ? home : path.parse(home).root || '/';
  }

  #endSessionsOfIneligibleUsers(): void {
    for (const [userId, sessions] of this.#byUser) {
      if (![...sessions.values()].some((session) => session.alive)) continue;
      const user = this.#context.services.auth.findUser(userId);
      if (user && user.role === 'owner' && !user.disabled) continue;
      for (const session of sessions.values()) void session.terminate('revoked');
    }
  }

  #onChange(session: TerminalSession, what: 'updated' | 'ended'): void {
    if (this.#stopped) return;
    if (what === 'updated') return this.#publish(session, TERMINAL_EVENTS.updated);
    this.#publish(session, TERMINAL_EVENTS.ended);
    // An ended terminal stays listed for a while so that a client which was away can read how it ended.
    const timer = setTimeout(() => this.#remove(session), this.limits.endedRetentionMs);
    timer.unref();
    this.#removals.set(session.id, timer);
    const ended = [...this.#of(session.userId).values()].filter((other) => !other.alive).sort((a, b) => (a.exit?.at ?? 0) - (b.exit?.at ?? 0));
    for (const oldest of ended.slice(0, Math.max(0, ended.length - this.limits.maxEndedSessionsPerUser))) this.#remove(oldest);
  }

  #remove(session: TerminalSession): void {
    const timer = this.#removals.get(session.id);
    if (timer) clearTimeout(timer);
    this.#removals.delete(session.id);
    const mine = this.#byUser.get(session.userId);
    if (!mine?.delete(session.id)) return;
    if (mine.size === 0) this.#byUser.delete(session.userId);
    if (!this.#stopped) this.#publish(session, TERMINAL_EVENTS.removed);
  }

  #publish(session: TerminalSession, type: string): void {
    this.#context.bus.publish(`user:${session.userId}`, type, { sessionId: session.id, projectId: session.projectId });
  }
}
