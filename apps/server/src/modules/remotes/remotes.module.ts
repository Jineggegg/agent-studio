import path from 'node:path';
import {
  REMOTE_LAUNCHERS,
  type RemoteHost,
  type RemoteHostList,
  type RemoteHostStatus,
  type RemoteProgram,
  isSafeRemoteDirectory,
  remoteHostIdSchema,
} from '@agent-studio/protocol';
import { z } from 'zod';
import { badRequest, forbidden, notFound, unavailable } from '../../kernel/errors.js';
import type { ModuleContext, StudioModule } from '../../kernel/module.js';
import type { TerminalLauncher } from '../terminal/launchers.js';
import { findExecutable } from '../terminal/login-shell.js';
import { type HostsSnapshot, type RemoteHostConfig, RemoteHostRegistry } from './hosts-file.js';
import { IDENTITY_UNREADABLE_MESSAGE, type ProbeSettings, RemoteProber, unreadableIdentity } from './probe.js';
import { buildSshArgs, deriveSessionName, deriveUserTag, sessionCommand } from './ssh-command.js';

/**
 * Remote machines.
 *
 * Which hosts exist is decided by the operator, in a file on the server
 * (`<data directory>/remote-hosts.json`, or `AGENT_STUDIO_REMOTE_HOSTS_FILE`;
 * format and rules in `hosts-file.ts`). The browser side of this feature is
 * read-only: the owner can list the hosts and ask whether one is reachable.
 * A client never supplies a host name, a user, a port, a key, a command or an
 * SSH option — it refers to a host by id.
 *
 * Working on a host means a terminal session: this module registers three
 * launchers with the terminal (`remote-shell`, `remote-claude`,
 * `remote-codex`) that run the SSH client inside the pseudo-terminal. They
 * take a host id and, as the single value a client influences, the directory
 * to start in — validated against a conservative pattern and then passed to
 * the remote side as a quoted parameter, never as part of a command
 * (`ssh-command.ts`). On the host the session lives in tmux, under a name
 * derived on the server, so work survives a disconnect.
 */

export const REMOTE_HOSTS_FILE_NAME = 'remote-hosts.json';
const SESSION_CONNECT_TIMEOUT_SECONDS = 10;

export interface ResolvedRemoteHost {
  readonly host: RemoteHostConfig;
  readonly jump: RemoteHostConfig | null;
}

/** What other modules may ask about remote hosts. */
export interface RemotesService {
  /** The hosts as currently configured, re-read if the file changed. */
  snapshot(): Promise<HostsSnapshot>;
  /** A host by id, or null when no such host is configured. */
  find(hostId: string): Promise<ResolvedRemoteHost | null>;
  status(hostId: string, options?: { refresh?: boolean }): Promise<RemoteHostStatus>;
}

declare module '../../kernel/module.js' {
  interface Services {
    remotes: RemotesService;
  }
}

export interface RemotesModuleOptions {
  /** Directories searched for the SSH client before the usual PATH. Tests put a stand-in there. */
  readonly pathPrepend?: readonly string[];
  readonly probe?: Partial<ProbeSettings>;
}

const PROGRAM_LABELS: Record<RemoteProgram, string> = { shell: 'shell', claude: 'Claude Code', codex: 'Codex' };

const hostParams = z.object({ hostId: remoteHostIdSchema });
const statusQuery = z.object({ refresh: z.enum(['1', 'true', '0', 'false']).optional() });

function present(host: RemoteHostConfig): RemoteHost {
  const address = host.hostname.includes(':') && host.port !== 22 ? `[${host.hostname}]` : host.hostname;
  return {
    id: host.id,
    name: host.name,
    target: `${host.user === null ? '' : `${host.user}@`}${address}${host.port === 22 ? '' : `:${host.port}`}`,
    viaHostId: host.jumpHost,
    defaultDirectory: host.defaultDirectory,
    agentsAllowed: host.agents,
  };
}

export function createRemotesModule(options: RemotesModuleOptions = {}): StudioModule {
  const pathPrepend = options.pathPrepend ?? [];

  return {
    name: 'remotes',

    setup(context: ModuleContext) {
      const { http, config, log, processes } = context;
      const file = config.remoteHostsFile ?? path.join(config.dataDir, REMOTE_HOSTS_FILE_NAME);

      /** What the SSH client is given: the scrubbed child environment, nothing more. */
      const environment = (): Record<string, string> => {
        const env = processes.env();
        if (pathPrepend.length > 0) env.PATH = [...pathPrepend, ...(env.PATH ? [env.PATH] : [])].join(path.delimiter);
        return env;
      };
      const findSsh = (env: Readonly<Record<string, string>>) => findExecutable('ssh', env.PATH);

      const prober = new RemoteProber({ run: (program, args, runOptions) => processes.run(program, args, runOptions), environment, findSsh }, options.probe);
      const registry = new RemoteHostRegistry(file, (snapshot) => {
        prober.retain(new Set(snapshot.hosts.map((host) => host.id)));
        // The message names fields and rules, never values.
        if (snapshot.status === 'invalid') log.warn({ file, problem: snapshot.message }, 'remote hosts file rejected; no remote host is offered');
        else if (snapshot.status === 'ok') log.info({ file, hosts: snapshot.hosts.length }, 'remote hosts loaded');
      });

      const resolve = (snapshot: HostsSnapshot, hostId: string): ResolvedRemoteHost | null => {
        const host = snapshot.hosts.find((candidate) => candidate.id === hostId);
        if (!host) return null;
        const jump = host.jumpHost === null ? null : (snapshot.hosts.find((candidate) => candidate.id === host.jumpHost) ?? null);
        return { host, jump };
      };

      /** The host, or the error a client should see. Decided before any connection is attempted. */
      const requireHost = async (hostId: string): Promise<ResolvedRemoteHost> => {
        const snapshot = await registry.snapshot();
        if (snapshot.status === 'invalid') {
          throw unavailable('The list of remote hosts on this server is not valid, so none can be used.', 'remote_hosts_invalid', { problem: snapshot.message });
        }
        const resolved = resolve(snapshot, hostId);
        if (!resolved) throw notFound('There is no such remote host.', 'remote_host_not_found');
        return resolved;
      };

      const service: RemotesService = {
        snapshot: () => registry.snapshot(),
        find: async (hostId) => resolve(await registry.snapshot(), hostId),
        status: async (hostId, statusOptions = {}) => {
          const { host, jump } = await requireHost(hostId);
          return prober.status(host, jump, statusOptions);
        },
      };
      context.services.remotes = service;

      http.route({
        method: 'GET',
        url: '/api/remotes/hosts',
        access: 'owner',
        handler: async (): Promise<RemoteHostList> => {
          const snapshot = await registry.snapshot();
          return { hosts: snapshot.hosts.map(present), configuration: { status: snapshot.status, message: snapshot.message, file } };
        },
      });

      http.route({
        method: 'GET',
        url: '/api/remotes/hosts/:hostId/status',
        access: 'owner',
        params: hostParams,
        query: statusQuery,
        rateLimit: { max: config.env === 'test' ? 10_000 : 60, windowMs: 60_000 },
        handler: ({ params, query }) => service.status(params.hostId, { refresh: query.refresh === '1' || query.refresh === 'true' }),
      });

      // Remote sessions are terminals. Without the terminal module there is nothing to plug into.
      const terminal = context.services.terminal as typeof context.services.terminal | undefined;
      if (!terminal) return;
      for (const program of Object.keys(REMOTE_LAUNCHERS) as RemoteProgram[]) {
        const launcher: TerminalLauncher = {
          key: REMOTE_LAUNCHERS[program],
          title: program === 'shell' ? 'Shell on a remote host' : `${PROGRAM_LABELS[program]} on a remote host`,
          kind: 'remote',
          remote: true,
          unavailableReason: () => (findSsh(environment()) === null ? 'No SSH client is installed on this computer.' : null),
          plan: async ({ user, remote }) => {
            if (!remote) throw badRequest('Choose the remote host to open.', undefined, 'remote_required');
            const { host, jump } = await requireHost(remote.hostId);
            if (program !== 'shell' && !host.agents) {
              throw forbidden('Agent CLIs may not be started on this host.', 'remote_agents_not_allowed');
            }
            const directory = remote.directory ?? host.defaultDirectory;
            // Already checked where the request was parsed; checked again where it is used.
            if (directory !== null && !isSafeRemoteDirectory(directory)) {
              throw badRequest('That is not a directory this server will open on a remote host.', undefined, 'invalid_remote_directory');
            }
            const env = environment();
            const ssh = findSsh(env);
            if (!ssh) throw unavailable('No SSH client is installed on this computer.', 'ssh_missing');
            if ((await unreadableIdentity(host, jump)) !== null) throw unavailable(IDENTITY_UNREADABLE_MESSAGE, 'identity_unreadable');
            const args = buildSshArgs({
              mode: 'session',
              host,
              jump,
              remoteCommand: sessionCommand({
                program,
                directory,
                sessionName: deriveSessionName(user.userId, program, directory),
                userTag: deriveUserTag(user.userId),
              }),
              connectTimeoutSeconds: SESSION_CONNECT_TIMEOUT_SECONDS,
              sshProgram: ssh,
            });
            return {
              // An absolute path, also used for the jump leg: no later PATH lookup decides which client runs.
              file: ssh,
              args,
              // The SSH client does not care where it starts; the project folder is not involved.
              cwd: 'neutral',
              title: `${host.name}: ${PROGRAM_LABELS[program]}`,
              remoteHostId: host.id,
              remoteDirectory: directory,
            };
          },
        };
        terminal.registerLauncher(launcher);
      }
    },
  };
}

export const remotesModule: StudioModule = createRemotesModule();
