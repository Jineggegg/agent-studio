import { promises as fs } from 'node:fs';
import net from 'node:net';
import { REMOTE_HOST_ID_PATTERN, isSafeRemoteDirectory } from '@agent-studio/protocol';
import { z } from 'zod';

/**
 * The operator's list of remote hosts.
 *
 * Remote hosts are configured in one JSON file on the server and nowhere
 * else. Nothing a browser sends can add a host or change one; the file is the
 * whole definition of where the server may open SSH connections:
 *
 *   {
 *     "hosts": [
 *       {
 *         "id": "build-box",                         required  slug, at most 32 characters
 *         "name": "Build box",                       required  label, at most 40 characters
 *         "hostname": "build.internal.example",      required  DNS name or IP address
 *         "user": "dev",                             optional  login name (default: ssh's own default)
 *         "port": 22,                                optional
 *         "identityFile": "/home/studio/.ssh/id_ed25519",   optional  absolute path of the private key
 *         "jumpHost": "bastion",                     optional  id of another entry to connect through
 *         "defaultDirectory": "/srv/work",           optional  where sessions start
 *         "agents": true,                            optional  may agent CLIs be started there (default false)
 *         "hostKeyChecking": "strict"                optional  "strict" (default) or "accept-new"
 *       }
 *     ]
 *   }
 *
 * The file is validated as a whole. One bad field rejects all of it, with a
 * message that names the field and the rule but never repeats the value, and
 * until the operator fixes it no host is offered at all. A half-accepted
 * file would be a quiet way to connect somewhere the operator did not mean.
 */

export const MAX_REMOTE_HOSTS = 16;
export const MAX_HOSTS_FILE_BYTES = 256 * 1024;

export interface RemoteHostConfig {
  readonly id: string;
  readonly name: string;
  readonly hostname: string;
  readonly user: string | null;
  readonly port: number;
  readonly identityFile: string | null;
  readonly jumpHost: string | null;
  readonly defaultDirectory: string | null;
  /** Whether agent CLIs may be started on the host. */
  readonly agents: boolean;
  /** `strict`: the host key must already be known. `accept-new`: a first key is recorded, a changed one is refused. */
  readonly hostKeyChecking: 'strict' | 'accept-new';
}

export class RemoteHostsFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemoteHostsFileError';
  }
}

// ---- field rules -------------------------------------------------------------
// Every value below ends up as an argument of the SSH client. The patterns are
// deliberately narrow: nothing can begin with a dash, and nothing contains a
// character that a shell, or ssh's own option syntax, gives a meaning to.

const DNS_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/** A DNS name, an IPv4 address or a bare IPv6 address (no brackets, no zone). */
export function isSafeHostname(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 253) return false;
  if (value.includes(':')) return net.isIPv6(value) && /^[0-9A-Fa-f:.]+$/.test(value);
  return value.split('.').every((label) => DNS_LABEL.test(label));
}

export function isSafeUser(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,31}$/.test(value);
}

const LOCAL_PATH_SEGMENT = /^[A-Za-z0-9._+@-]+$/;

/** An absolute path on this computer made of plain segments: no spaces, no `..`, no `%`, no leading dash. */
export function isSafeLocalPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 2 || value.length > 400 || !value.startsWith('/')) return false;
  return value
    .slice(1)
    .split('/')
    .every((segment) => LOCAL_PATH_SEGMENT.test(segment) && segment !== '.' && segment !== '..' && !segment.startsWith('-'));
}

function isLabel(value: string): boolean {
  if (value.length > 40 || value.trim().length === 0 || value !== value.trim() || value.startsWith('-')) return false;
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

export function isSafePort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
}

const ID_RULE = 'must be 1 to 32 lower-case letters, digits or hyphens, and neither start nor end with a hyphen';

const hostSchema = z.strictObject({
  id: z.string().regex(REMOTE_HOST_ID_PATTERN, ID_RULE),
  name: z.string().refine(isLabel, 'must be 1 to 40 characters, without control characters, surrounding spaces or a leading hyphen'),
  hostname: z.string().refine(isSafeHostname, 'must be a DNS name or an IP address'),
  user: z.string().refine(isSafeUser, 'must be 1 to 32 letters, digits, dots, underscores or hyphens, and not start with a hyphen or dot').optional(),
  port: z.number().refine(isSafePort, 'must be a whole number from 1 to 65535').optional(),
  identityFile: z
    .string()
    .refine(isSafeLocalPath, 'must be an absolute path made of letters, digits and . _ + @ - only, without ".." and at most 400 characters')
    .optional(),
  jumpHost: z.string().regex(REMOTE_HOST_ID_PATTERN, ID_RULE).optional(),
  defaultDirectory: z
    .string()
    .refine(isSafeRemoteDirectory, 'must be an absolute path made of letters, digits and . _ + @ - only, without ".." and at most 300 characters')
    .optional(),
  agents: z.boolean().optional(),
  hostKeyChecking: z.enum(['strict', 'accept-new']).optional(),
});

const fileSchema = z.strictObject({
  hosts: z.array(hostSchema).max(MAX_REMOTE_HOSTS, `lists more than ${MAX_REMOTE_HOSTS} hosts`),
});

function printableKey(key: string): string {
  // Printable ASCII only, and nothing that could close the quotes around it.
  const clean = key.replace(/[^\u0020-\u007e]/g, '?').replace(/["\\]/g, '?');
  return `"${clean.length > 40 ? `${clean.slice(0, 40)}…` : clean}"`;
}

function formatPath(path: ReadonlyArray<PropertyKey>): string {
  let out = '';
  for (const part of path) out += typeof part === 'number' ? `[${part}]` : `${out ? '.' : ''}${String(part)}`;
  return out || 'the file';
}

/** Names the field and the rule. Values are never repeated: this text is logged and shown to the owner. */
function describeIssue(issue: z.core.$ZodIssue): string {
  const where = formatPath(issue.path);
  if (issue.code === 'unrecognized_keys') {
    return `${where}: unknown ${issue.keys.length === 1 ? 'key' : 'keys'} ${issue.keys.slice(0, 5).map(printableKey).join(', ')}`;
  }
  if (issue.code === 'invalid_type') return `${where}: has the wrong type (expected ${issue.expected})`;
  if (issue.code === 'invalid_value') return `${where}: is not one of the allowed values`;
  return `${where}: ${issue.message}`;
}

/**
 * Parses and validates the whole file. Throws {@link RemoteHostsFileError}
 * with a precise message when anything is off.
 */
export function parseRemoteHostsFile(text: string): RemoteHostConfig[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new RemoteHostsFileError('the file is not valid JSON');
  }
  const parsed = fileSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues;
    const shown = issues.slice(0, 5).map(describeIssue);
    if (issues.length > shown.length) shown.push(`and ${issues.length - shown.length} more`);
    throw new RemoteHostsFileError(shown.join('; '));
  }

  const hosts: RemoteHostConfig[] = parsed.data.hosts.map((host) => ({
    id: host.id,
    name: host.name,
    hostname: host.hostname,
    user: host.user ?? null,
    port: host.port ?? 22,
    identityFile: host.identityFile ?? null,
    jumpHost: host.jumpHost ?? null,
    defaultDirectory: host.defaultDirectory ?? null,
    agents: host.agents ?? false,
    hostKeyChecking: host.hostKeyChecking ?? 'strict',
  }));

  const indexById = new Map<string, number>();
  hosts.forEach((host, index) => {
    const earlier = indexById.get(host.id);
    if (earlier !== undefined) throw new RemoteHostsFileError(`hosts[${index}].id: is the same as hosts[${earlier}].id`);
    indexById.set(host.id, index);
  });
  hosts.forEach((host, index) => {
    if (host.jumpHost === null) return;
    const jump = indexById.get(host.jumpHost);
    if (jump === undefined) throw new RemoteHostsFileError(`hosts[${index}].jumpHost: is not the id of a host in this file`);
    if (jump === index) throw new RemoteHostsFileError(`hosts[${index}].jumpHost: is the host itself`);
    if (hosts[jump]!.jumpHost !== null) {
      throw new RemoteHostsFileError(`hosts[${index}].jumpHost: names a host that is itself reached through a jump host; only one hop is supported`);
    }
  });
  return hosts;
}

export interface HostsSnapshot {
  /** `missing`: there is no file, which simply means no hosts. `invalid`: the file was rejected. */
  readonly status: 'ok' | 'missing' | 'invalid';
  readonly hosts: readonly RemoteHostConfig[];
  /** What is wrong, when `invalid`. */
  readonly message: string | null;
}

const NOTHING: HostsSnapshot = { status: 'missing', hosts: [], message: null };

/**
 * Reads the hosts file on use and again whenever it has changed (by its
 * modification time, size and identity), so the operator never has to
 * restart the server after an edit.
 */
export class RemoteHostRegistry {
  readonly file: string;
  readonly #onChange: (snapshot: HostsSnapshot) => void;
  /** Identity of the version of the file that `#snapshot` was read from. */
  #stamp: string | null = null;
  #snapshot: HostsSnapshot = NOTHING;

  constructor(file: string, onChange: (snapshot: HostsSnapshot) => void = () => {}) {
    this.file = file;
    this.#onChange = onChange;
  }

  async snapshot(): Promise<HostsSnapshot> {
    let stat: Awaited<ReturnType<typeof statBig>>;
    try {
      stat = await statBig(this.file);
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      return this.#adopt(missing ? 'missing' : 'unreadable', missing ? NOTHING : invalid('the file cannot be read'));
    }
    const stamp = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode, stat.uid].join(':');
    if (stamp === this.#stamp) return this.#snapshot;
    return this.#adopt(stamp, await this.#load(stat));
  }

  async #load(stat: Awaited<ReturnType<typeof statBig>>): Promise<HostsSnapshot> {
    if (!stat.isFile()) return invalid('the path is not a regular file');
    if (stat.size > BigInt(MAX_HOSTS_FILE_BYTES)) return invalid(`the file is larger than ${MAX_HOSTS_FILE_BYTES / 1024} kB`);
    if (process.platform !== 'win32') {
      // Whoever can write this file decides where the server connects and with which key.
      if ((stat.mode & 0o022n) !== 0n) return invalid('the file must not be writable by group or others (chmod 600)');
      const uid = process.getuid?.();
      if (uid !== undefined && stat.uid !== BigInt(uid) && stat.uid !== 0n) {
        return invalid('the file must belong to the account the server runs as, or to root');
      }
    }
    try {
      return { status: 'ok', hosts: parseRemoteHostsFile(await fs.readFile(this.file, 'utf8')), message: null };
    } catch (error) {
      return invalid(error instanceof RemoteHostsFileError ? error.message : 'the file cannot be read');
    }
  }

  #adopt(stamp: string, snapshot: HostsSnapshot): HostsSnapshot {
    const changed = stamp !== this.#stamp;
    this.#stamp = stamp;
    this.#snapshot = snapshot;
    if (changed) this.#onChange(snapshot);
    return snapshot;
  }
}

const statBig = (file: string) => fs.stat(file, { bigint: true });
const invalid = (message: string): HostsSnapshot => ({ status: 'invalid', hosts: [], message });
