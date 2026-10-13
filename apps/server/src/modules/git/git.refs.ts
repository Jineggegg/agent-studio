import { badRequest } from '../../kernel/errors.js';

/**
 * Validation of every name a client can hand to git.
 *
 * Two layers. First git's own rules for reference names (the ones
 * `git check-ref-format` enforces), so that a name git would reject is refused
 * with a reason before git starts. Then a stricter character set of our own:
 * letters and digits of any script plus `. _ / + - @ =`. Git itself would
 * accept `;`, `$`, quotes, parentheses and more inside a branch name; nothing
 * here ever passes a name through a shell, but there is no reason to let such
 * names be created from a browser, and refusing them keeps every later
 * consumer of branch names (hooks, CI, scripts) out of trouble.
 *
 * A name that starts with `-` is refused in every case: it would be an option.
 */

const ALLOWED = /^[\p{L}\p{N}\p{M}._/+@=-]+$/u;

export type RefProblem =
  | 'empty'
  | 'too_long'
  | 'leading_dash'
  | 'characters'
  | 'slashes'
  | 'dots'
  | 'component_dot'
  | 'component_lock'
  | 'at_brace'
  | 'reserved';

const SENTENCES: Record<RefProblem, string> = {
  empty: 'Give the branch a name.',
  too_long: 'That name is too long.',
  leading_dash: 'A name cannot start with a dash.',
  characters: 'A name can contain letters, digits and . _ / + - @ = only.',
  slashes: 'A name cannot start or end with a slash, or contain two slashes in a row.',
  dots: 'A name cannot contain "..", or end with a dot.',
  component_dot: 'No part of a name can start with a dot.',
  component_lock: 'No part of a name can end with ".lock".',
  at_brace: 'A name cannot be "@" or contain "@{".',
  reserved: 'That name is reserved.',
};

/** Why `name` cannot be used as a reference name, or null when it can. */
export function refProblem(name: string): RefProblem | null {
  if (name.length === 0) return 'empty';
  if (name.length > 200) return 'too_long';
  if (name.startsWith('-')) return 'leading_dash';
  if (!ALLOWED.test(name)) return 'characters';
  if (name.startsWith('/') || name.endsWith('/') || name.includes('//')) return 'slashes';
  if (name.includes('..') || name.endsWith('.')) return 'dots';
  if (name === '@' || name.includes('@{')) return 'at_brace';
  for (const component of name.split('/')) {
    if (component.startsWith('.')) return 'component_dot';
    if (component.toLowerCase().endsWith('.lock')) return 'component_lock';
  }
  return null;
}

function invalid(problem: RefProblem, code = 'git_invalid_ref') {
  return badRequest(SENTENCES[problem], { problem }, code);
}

/** A name for a local branch. Returns it unchanged, or throws 400 before git is involved. */
export function assertBranchName(name: string): string {
  const problem = refProblem(name);
  if (problem) throw invalid(problem);
  // These would be legal reference names but are confusing or dangerous as branches.
  if (name === 'HEAD' || /^(refs|FETCH_HEAD|ORIG_HEAD|MERGE_HEAD)(\/|$)/.test(name)) throw invalid('reserved');
  return name;
}

/**
 * Something that names a commit: a branch, a remote branch, a tag, `HEAD`,
 * or a commit id. Revision syntax (`~`, `^`, `:`, `@{…}`, ranges) is not
 * accepted from clients.
 */
export function assertRevision(name: string): string {
  const problem = refProblem(name);
  if (problem) throw invalid(problem);
  return name;
}

const REMOTE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9_-])?$/;

/** A remote's name. Callers additionally check that the repository really has that remote. */
export function assertRemoteName(name: string): string {
  if (!REMOTE.test(name) || name.includes('..') || name.endsWith('.lock')) {
    throw badRequest('That is not a valid remote name.', undefined, 'git_invalid_remote');
  }
  return name;
}

const OID = /^[0-9a-f]{4,64}$/;

export function assertOid(value: string): string {
  if (!OID.test(value)) throw badRequest('That is not a commit id.', undefined, 'git_invalid_ref');
  return value;
}

export const isFullOid = (value: string): boolean => /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(value);

// ---- repository addresses ----------------------------------------------------------

export interface RepositoryAddress {
  /** The address to give to git. */
  readonly url: string;
  readonly transport: 'https' | 'ssh';
  readonly host: string;
  /** Last path segment without ".git": the natural folder name. */
  readonly name: string;
}

const HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const IPV6_HOST = /^\[[0-9A-Fa-f:.]{2,45}\]$/;
const SSH_USER = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
/** Path characters of a repository address. Notably no whitespace, quotes, backslashes or control characters. */
const REPO_PATH = /^[A-Za-z0-9._~/+@%-]+$/;

function fail(message: string): never {
  throw badRequest(message, undefined, 'invalid_repository_url');
}

function folderName(pathname: string): string {
  const segments = pathname.split('/').filter((segment) => segment.length > 0);
  let last = segments[segments.length - 1] ?? '';
  try {
    last = decodeURIComponent(last);
  } catch {
    /* keep the raw segment */
  }
  const name = last.replace(/\.git$/i, '');
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name) && !name.includes('..') ? name : '';
}

/**
 * Accepts exactly three shapes of repository address:
 *
 *   https://host[:port]/path        ssh://[user@]host[:port]/path        user@host:path
 *
 * Everything else is refused — in particular `ext::`, `file:`, `git:`,
 * plain `http:`, local paths, anything that starts with a dash (an option),
 * and any address that carries a password or token.
 */
export function parseRepositoryAddress(raw: string): RepositoryAddress {
  const value = raw.trim();
  if (value.length === 0 || value.length > 500) fail('Give the address of the repository.');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0020\u007f]/.test(value)) fail('A repository address cannot contain spaces or control characters.');
  if (value.startsWith('-')) fail('That is not a repository address.');
  if (value.includes('::')) fail('Only https and ssh repository addresses are accepted.');

  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(value);
  if (scheme) {
    const protocol = scheme[1]!.toLowerCase();
    if (protocol !== 'https' && protocol !== 'ssh') fail('Only https and ssh repository addresses are accepted.');
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      fail('That is not a valid repository address.');
    }
    if (url.password !== '') fail('Do not put a password or token in the address. Sign git in on the server instead.');
    if (protocol === 'https' && url.username !== '') {
      fail('Do not put a user name or token in the address. Sign git in on the server instead.');
    }
    if (url.search !== '' || url.hash !== '') fail('A repository address cannot have a query or a fragment.');
    const host = url.hostname;
    if (!HOST.test(host) && !IPV6_HOST.test(host)) fail('That is not a valid repository address.');
    if (protocol === 'ssh' && url.username !== '' && !SSH_USER.test(decodeURIComponent(url.username))) {
      fail('That is not a valid repository address.');
    }
    if (url.pathname.length < 2 || !REPO_PATH.test(url.pathname) || url.pathname.split('/').some((segment) => segment.startsWith('-'))) {
      fail('That is not a valid repository address.');
    }
    const name = folderName(url.pathname);
    return { url: url.href, transport: protocol, host, name };
  }

  // The short ssh form: user@host:path. The user part is required so that a
  // Windows drive ("C:\repo") or a local "host:path" lookalike is never mistaken for it.
  const scp = /^([^@:/]+)@([^@:/]+):(.+)$/.exec(value);
  if (!scp) fail('Only https and ssh repository addresses are accepted.');
  const [, user, host, repoPath] = scp as unknown as [string, string, string, string];
  if (!SSH_USER.test(user) || !HOST.test(host) || host.startsWith('-')) fail('That is not a valid repository address.');
  if (!REPO_PATH.test(repoPath) || repoPath.startsWith('-') || repoPath.split('/').some((segment) => segment.startsWith('-'))) {
    fail('That is not a valid repository address.');
  }
  return { url: `${user}@${host}:${repoPath}`, transport: 'ssh', host, name: folderName(repoPath) };
}

/** `owner/name` when a remote address points at github.com, else null. Never returns credentials. */
export function githubRepositoryOf(remoteUrl: string): { owner: string; repo: string } | null {
  const value = remoteUrl.trim();
  const match =
    /^https:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(value) ??
    /^ssh:\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(value) ??
    /^(?:[^@:/]+@)?github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(value);
  if (!match) return null;
  const owner = match[1]!;
  const repo = match[2]!;
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner)) return null;
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(repo) || repo === '.' || repo === '..') return null;
  return { owner, repo };
}
