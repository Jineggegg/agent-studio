import { z } from 'zod';
import { timestampSchema } from './common.js';

/**
 * Remote machines.
 *
 * Remote hosts are defined by the operator in a file on the server and are
 * read-only here: a client can list them, ask whether one is reachable, and
 * refer to one **by its id** when it opens a remote terminal session
 * (`packages/protocol/src/terminal.ts`). A client never supplies a host name,
 * a user, a port, a key, a command or an SSH option. The only free-form value
 * a client sends is the directory to open on the host, and that is limited to
 * {@link remoteDirectorySchema}.
 *
 *   GET /api/remotes/hosts                      → RemoteHostList
 *   GET /api/remotes/hosts/:hostId/status       → RemoteHostStatus   (?refresh=1 asks for a new check)
 *
 * Both are for the owner only. A status check opens one non-interactive SSH
 * connection, runs a fixed command and is cached; asking again within the
 * cache window answers from the cache (`cached: true`).
 */

/** Lower-case letters, digits and hyphens; at most 32 characters. */
export const REMOTE_HOST_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
export const remoteHostIdSchema = z.string().regex(REMOTE_HOST_ID_PATTERN, 'Not a remote host id.');
export type RemoteHostId = z.infer<typeof remoteHostIdSchema>;

export const REMOTE_DIRECTORY_MAX_LENGTH = 300;
const REMOTE_DIRECTORY_SEGMENT = /^[A-Za-z0-9._+@-]+$/;

/**
 * A directory on a remote host, as a client may name it: an absolute path of
 * plain segments. Letters, digits and `. _ + @ -` only — no spaces, quotes or
 * shell punctuation — no `.` or `..` segment, no segment that starts with a
 * dash, at most {@link REMOTE_DIRECTORY_MAX_LENGTH} characters.
 */
export function isSafeRemoteDirectory(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > REMOTE_DIRECTORY_MAX_LENGTH) return false;
  if (!value.startsWith('/')) return false;
  if (value === '/') return true;
  const segments = value.slice(1).split('/');
  // One trailing slash is tolerated; an empty segment anywhere else is not.
  if (segments[segments.length - 1] === '') segments.pop();
  return segments.every(
    (segment) => REMOTE_DIRECTORY_SEGMENT.test(segment) && segment !== '.' && segment !== '..' && !segment.startsWith('-'),
  );
}

export const remoteDirectorySchema = z
  .string()
  .max(REMOTE_DIRECTORY_MAX_LENGTH)
  .refine(isSafeRemoteDirectory, 'Use an absolute path made of letters, digits and . _ + @ - only.');

export const remoteHostSchema = z.object({
  id: remoteHostIdSchema,
  /** The operator's label for the host. */
  name: z.string(),
  /** Where it connects, for display: `user@host`, with `:port` when the port is not 22. */
  target: z.string(),
  /** Id of the host this one is reached through, when it sits behind a jump host. */
  viaHostId: remoteHostIdSchema.nullable(),
  /** Directory suggested for new sessions on this host. */
  defaultDirectory: z.string().nullable(),
  /** Whether agent CLIs may be started on this host (a plain shell always may). */
  agentsAllowed: z.boolean(),
});
export type RemoteHost = z.infer<typeof remoteHostSchema>;

/**
 * `ok` — the file was read; `missing` — there is no file yet (no hosts);
 * `invalid` — the file was rejected as a whole and no host is offered until
 * the operator fixes it. `message` says what is wrong without quoting values.
 */
export const remoteHostsConfigurationSchema = z.object({
  status: z.enum(['ok', 'missing', 'invalid']),
  message: z.string().nullable(),
  /** The file the operator edits, so the screen can say where hosts come from. */
  file: z.string(),
});
export type RemoteHostsConfiguration = z.infer<typeof remoteHostsConfigurationSchema>;

export const remoteHostListSchema = z.object({
  hosts: z.array(remoteHostSchema),
  configuration: remoteHostsConfigurationSchema,
});
export type RemoteHostList = z.infer<typeof remoteHostListSchema>;

/** Programs a status check looks for on the host. */
export const REMOTE_TOOLS = ['tmux', 'git', 'claude', 'codex'] as const;
export const remoteToolSchema = z.enum(REMOTE_TOOLS);
export type RemoteTool = z.infer<typeof remoteToolSchema>;

export const remoteToolsSchema = z.object({
  /** Without tmux a remote session ends when the terminal disconnects. */
  tmux: z.boolean(),
  git: z.boolean(),
  claude: z.boolean(),
  codex: z.boolean(),
});
export type RemoteTools = z.infer<typeof remoteToolsSchema>;

/** Why a host could not be checked. Stable codes; `message` is a short English sentence. */
export const remoteFailureCodeSchema = z.enum([
  'ssh_missing',
  'identity_unreadable',
  'timeout',
  'auth_failed',
  'host_key_failed',
  'dns_failed',
  'connection_refused',
  'network_unreachable',
  'unexpected_output',
  'ssh_failed',
]);
export type RemoteFailureCode = z.infer<typeof remoteFailureCodeSchema>;

export const remoteHostStatusSchema = z.object({
  hostId: remoteHostIdSchema,
  reachable: z.boolean(),
  /** How long the check took, when the host answered. */
  latencyMs: z.number().int().nonnegative().nullable(),
  checkedAt: timestampSchema,
  /** Null when the host could not be reached or did not run the check. */
  tools: remoteToolsSchema.nullable(),
  failure: z.object({ code: remoteFailureCodeSchema, message: z.string().max(200) }).nullable(),
  /** True when this answer came from the cache instead of a new connection. */
  cached: z.boolean(),
});
export type RemoteHostStatus = z.infer<typeof remoteHostStatusSchema>;

/**
 * Terminal launchers that open a session on a remote host. Pass one as
 * `launcher` together with `remote: { hostId, directory? }` when creating a
 * terminal session.
 */
export const REMOTE_LAUNCHERS = {
  shell: 'remote-shell',
  claude: 'remote-claude',
  codex: 'remote-codex',
} as const;
export type RemoteProgram = keyof typeof REMOTE_LAUNCHERS;
