import type { PluginPermission, PluginToolEffect } from '@agent-studio/protocol';
import type { Role } from '../../kernel/principal.js';

/**
 * What a plugin may ask the Studio to do, decided in one place.
 *
 * A plugin process has no authority of its own. Every request it makes names
 * the call it is serving (its *scope*), and the Studio answers three questions
 * before doing anything:
 *
 *   1. Is that call still in progress?           (no ambient authority in time)
 *   2. Did the owner grant the permission?       (no ambient authority in kind)
 *   3. Does the call act for a user who may?     (no ambient authority in identity)
 *
 * The identity always comes from the Studio's own record of the call — never
 * from anything the plugin says.
 */

export type ScopeKind = 'start' | 'stop' | 'tool' | 'panel' | 'hook';

export interface ActingUser {
  readonly id: string;
  readonly displayName: string;
  readonly role: Role;
}

export interface CallScope {
  readonly id: string;
  readonly kind: ScopeKind;
  /** The call is a tool whose effect is `read`: it may look, not change. */
  readonly readOnly: boolean;
  /** Whom the call acts for. Hooks and start-up act for nobody. */
  readonly user: ActingUser | null;
  /** The project the call is about, if any. */
  readonly projectId: string | null;
  /** True when only `projectId` may be read: tool calls (the run's project) and project tabs. */
  readonly projectBound: boolean;
}

export const HOST_METHODS = [
  'host.storage.get',
  'host.storage.set',
  'host.storage.delete',
  'host.storage.list',
  'host.notify',
  'host.http.fetch',
  'host.projects.list',
  'host.files.read',
] as const;
export type HostMethod = (typeof HOST_METHODS)[number];

export const isHostMethod = (method: string): method is HostMethod => (HOST_METHODS as readonly string[]).includes(method);

/** A request from a plugin that the Studio declines. `code` goes back to the plugin; nothing else does. */
export class HostRefusal extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'HostRefusal';
    this.code = code;
  }
}

const isNetworkGrant = (permission: string): boolean => permission === 'network' || permission.startsWith('network:');

/**
 * The effect a tool is registered with.
 *
 * A plugin declares each tool `read` or `write`, and `read` tools are not
 * subject to approval — so the declaration cannot simply be believed. Two
 * things make it safe to honour:
 *
 * - During a `read` tool call the Studio refuses every capability that changes
 *   something (`storage.set`, `storage.delete`, `http.fetch`, `notify`).
 * - That check alone could be sidestepped by remembering the input and acting
 *   on it later, in a hook or a panel call. What makes "later" harmless is
 *   having no way to reach the outside. So a plugin that holds any network
 *   permission or may notify people gets **all** its tools registered as
 *   `write`, whatever it declared — and so does every plugin on a machine
 *   where the isolation in force does not keep plugin processes off the
 *   network (`networkContained` false).
 */
export function effectiveToolEffect(
  declared: PluginToolEffect,
  granted: Iterable<PluginPermission>,
  networkContained: boolean,
): PluginToolEffect {
  if (declared === 'write' || !networkContained) return 'write';
  for (const permission of granted) {
    if (permission === 'notifications' || isNetworkGrant(permission)) return 'write';
  }
  return 'read';
}

/** Throws unless `method` may be used in `scope` by a plugin holding `granted`. */
export function authorize(method: HostMethod, scope: CallScope, granted: ReadonlySet<string>): void {
  const need = (permission: string) => {
    if (!granted.has(permission)) {
      throw new HostRefusal('permission_denied', `This plugin has not been granted "${permission}".`);
    }
  };
  const needUser = () => {
    if (!scope.user) throw new HostRefusal('no_user', 'This call is not made for a user, so it cannot reach anything that belongs to one.');
  };
  const needWritable = () => {
    if (scope.readOnly) throw new HostRefusal('read_only_call', 'A tool declared "read" cannot change anything.');
  };

  switch (method) {
    case 'host.storage.get':
    case 'host.storage.list':
      return;
    case 'host.storage.set':
    case 'host.storage.delete':
      return needWritable();
    case 'host.notify':
      need('notifications');
      needWritable();
      return needUser();
    case 'host.http.fetch':
      // Which host is decided against the address, in checkFetchTarget.
      return needWritable();
    case 'host.projects.list':
    case 'host.files.read':
      need('projects:read');
      return needUser();
  }
}

/**
 * Decides whether a plugin may have the Studio fetch `raw`. Only https, only
 * the default port, only a host name granted by name — an IP address can never
 * be granted, so it can never be fetched.
 */
export function checkFetchTarget(raw: string, granted: ReadonlySet<string>): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HostRefusal('invalid_url', 'That is not a valid address.');
  }
  if (url.protocol !== 'https:') throw new HostRefusal('insecure_url', 'Only https:// addresses can be fetched.');
  if (url.username !== '' || url.password !== '') throw new HostRefusal('invalid_url', 'Addresses with a user name or password are not accepted.');
  if (url.port !== '') throw new HostRefusal('port_not_allowed', 'Only the standard https port can be used.');
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!granted.has(`network:${host}`)) {
    throw new HostRefusal('permission_denied', `This plugin has not been granted "network:${host}".`);
  }
  return url;
}

/** May a call in `scope` read from this project? Whether the user can see it is checked separately. */
export function projectInScope(scope: CallScope, projectId: string): boolean {
  return !scope.projectBound || scope.projectId === projectId;
}

/** Checks an owner's choice of permissions against what the manifest asks for. */
export function chosenGrant(requested: readonly PluginPermission[], chosen: readonly PluginPermission[]): PluginPermission[] {
  const allowed = new Set(requested);
  const result = new Set<PluginPermission>();
  for (const permission of chosen) {
    if (!allowed.has(permission)) {
      throw new HostRefusal('not_requested', `The plugin does not ask for "${permission}", so it cannot be granted.`);
    }
    result.add(permission);
  }
  return [...result].sort();
}

const SENSITIVE_NAMES = [
  /^\.env(\..*)?$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^\.pypirc$/i,
  /^\.git-credentials$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
  /^credentials(\.json)?$/i,
  /^secrets?\.(json|ya?ml|toml)$/i,
];
const SENSITIVE_FOLDERS = new Set(['.git', '.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker']);

/**
 * Files a plugin is not handed even with `projects:read`: the ones that most
 * often hold credentials. This narrows what an over-curious plugin sees by
 * accident; it is a courtesy, not a guarantee that no secret sits elsewhere.
 */
export function isSensitiveProjectPath(relativePath: string): boolean {
  const segments = relativePath.split('/').filter(Boolean);
  if (segments.slice(0, -1).some((segment) => SENSITIVE_FOLDERS.has(segment.toLowerCase()))) return true;
  const name = segments.at(-1) ?? '';
  if (SENSITIVE_FOLDERS.has(name.toLowerCase())) return true;
  return SENSITIVE_NAMES.some((pattern) => pattern.test(name));
}
