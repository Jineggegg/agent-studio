import type { GitErrorCode } from '@agent-studio/protocol';
import { StudioError } from '../../kernel/errors.js';
import type { RunResult } from '../../kernel/process.js';
import { redactSecrets } from '../../kernel/redact.js';

/**
 * Turns what git printed into something safe to show: escape sequences and
 * control characters go, credentials inside addresses go, anything
 * token-shaped goes, and the text is capped.
 */
export function cleanGitOutput(text: string, maxLength = 1500): string {
  const cleaned = text
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    // Progress output rewrites its line with carriage returns; keep the final state of each line.
    .split('\n')
    .map((line) => line.slice(line.lastIndexOf('\r') + 1))
    .join('\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    // Everything up to the last @ before the path: a password may itself contain an @.
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/?#\s]+@/gi, '$1')
    .replace(/^hint: .*$/gm, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
  const redacted = redactSecrets(cleaned);
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength)}…` : redacted;
}

/**
 * Adds what git printed to the tail kept for explaining a failure. Each piece
 * is redacted while it is whole, and only then is the tail cut to `max`
 * characters: a credential cut in two at the start of the tail would no longer
 * be recognised.
 */
export function appendToTail(tail: string, text: string, max: number): string {
  return `${tail}\n${redactSecrets(text)}`.slice(-max);
}

export function gitError(status: number, code: GitErrorCode, message: string, details?: unknown): StudioError {
  return new StudioError(status, code, message, details);
}

export type GitOperation = 'fetch' | 'pull' | 'push' | 'clone' | 'commit' | 'switch' | 'merge' | 'branch' | 'other';

interface Classification {
  readonly status: number;
  readonly code: GitErrorCode;
  readonly message: string;
}

const RULES: ReadonlyArray<{ test: RegExp; result: (operation: GitOperation) => Classification }> = [
  {
    test: /detected dubious ownership/i,
    result: () => ({ status: 409, code: 'git_untrusted', message: 'Git refuses to use this folder because it belongs to another system account.' }),
  },
  {
    test: /authentication failed|could not read username|could not read password|terminal prompts disabled|permission denied \(publickey|permission denied, please try again|invalid username or (password|token)|http basic: access denied|returned error: 40[13]|host key verification failed|invalid credentials|access denied|not authorized|logon failed/i,
    result: () => ({
      status: 502,
      code: 'git_auth_failed',
      message: 'The remote refused the credentials git has on this server. Sign git in on the server (a credential helper or an SSH key) and try again.',
    }),
  },
  {
    test: /\[rejected\]|\[remote rejected\]|non-fast-forward|fetch first|failed to push some refs|updates were rejected/i,
    result: () => ({
      status: 409,
      code: 'git_push_rejected',
      message: 'The remote rejected the push because it has commits this branch lacks (non-fast-forward). Pull first, then push again.',
    }),
  },
  {
    test: /repository (.* )?not found|does not appear to be a git repository|returned error: 404|no such remote|remote .* does not exist/i,
    result: () => ({ status: 502, code: 'git_remote_not_found', message: 'The remote repository was not found, or this server may not read it.' }),
  },
  {
    test: /could not resolve host|couldn't connect|failed to connect|connection timed out|connection refused|connection reset|network is unreachable|no route to host|unable to access|the remote end hung up|early eof|ssl (certificate|connect|error|handshake|routines)|tls (connection|handshake|error)|gnutls|certificate verif|could not read from remote repository|name or service not known|temporary failure in name resolution/i,
    result: () => ({ status: 502, code: 'git_network', message: 'The remote could not be reached. Check the network and the address of the remote.' }),
  },
  {
    test: /no tracking information|has no upstream branch|no upstream configured|no such ref was fetched/i,
    result: () => ({ status: 409, code: 'git_no_upstream', message: 'This branch has no upstream branch on a remote yet. Publish it first.' }),
  },
  {
    test: /not possible to fast-forward|diverging branches|divergent branches|refusing to merge unrelated histories/i,
    result: () => ({
      status: 409,
      code: 'git_diverged',
      message: 'This branch and its upstream have diverged: each has commits the other lacks. Nothing was changed.',
    }),
  },
  {
    test: /would be overwritten by (merge|checkout|switch)|please commit your changes or stash them|untracked working tree files would be (overwritten|removed)/i,
    result: () => ({
      status: 409,
      code: 'git_would_overwrite',
      message: 'Uncommitted changes in this folder are in the way and would be lost. Commit or discard them first. Nothing was changed.',
    }),
  },
  {
    test: /you have not concluded your merge|unmerged files|you need to resolve your current index first|is not possible because you have unmerged|rebase in progress|cherry-pick is already in progress/i,
    result: () => ({
      status: 409,
      code: 'git_operation_in_progress',
      message: 'An unfinished merge or rebase is in the way. Finish or abort it in a terminal first.',
    }),
  },
  {
    test: /conflict \(|merge conflict|automatic merge failed|fix conflicts/i,
    result: () => ({ status: 409, code: 'git_conflict', message: 'The changes conflict and cannot be combined automatically.' }),
  },
  {
    test: /please tell me who you are|unable to auto-detect email address|empty ident name|no email was given|author identity unknown/i,
    result: () => ({
      status: 409,
      code: 'git_identity_missing',
      message: 'Git does not know who is committing. Set your commit name and e-mail first.',
    }),
  },
  {
    test: /nothing to commit|nothing added to commit|no changes added to commit/i,
    result: () => ({ status: 409, code: 'git_nothing_to_commit', message: 'There is nothing staged to commit.' }),
  },
  {
    test: /pathspec '.*' did not match|did not match any file\(s\) known to git/i,
    result: () => ({ status: 400, code: 'git_unknown_path', message: 'Git does not know a file at that path.' }),
  },
  {
    test: /index\.lock|unable to create '.*\.lock'|another git process seems to be running/i,
    result: () => ({ status: 409, code: 'git_busy', message: 'Another git command is running in this repository. Try again in a moment.' }),
  },
  {
    test: /not a git repository/i,
    result: () => ({ status: 409, code: 'git_not_a_repository', message: 'This folder is not a git repository.' }),
  },
];

const FALLBACK: Record<GitOperation, string> = {
  fetch: 'Fetching from the remote failed.',
  pull: 'Pulling from the remote failed.',
  push: 'Pushing to the remote failed.',
  clone: 'Cloning the repository failed.',
  commit: 'The commit was not created.',
  switch: 'The branch could not be switched.',
  merge: 'The merge could not be completed.',
  branch: 'The branch operation failed.',
  other: 'Git could not complete that.',
};

/** Recognises the common ways a git command fails, from what it printed. */
export function classifyGitFailure(output: string, operation: GitOperation): Classification {
  for (const rule of RULES) {
    if (rule.test.test(output)) return rule.result(operation);
  }
  return { status: 502, code: 'git_failed', message: FALLBACK[operation] };
}

/**
 * The error to answer with when a git command did not succeed. It always says
 * what really happened: a recognised cause gets its own code and sentence,
 * anything else is reported as a failure with git's own (cleaned) words.
 */
export function gitFailure(result: RunResult, operation: GitOperation, timeoutMs?: number): StudioError {
  const output = cleanGitOutput(`${result.stderr}\n${result.stdout}`);
  if (result.timedOut) {
    const seconds = timeoutMs === undefined ? '' : ` within ${Math.round(timeoutMs / 1000)} seconds`;
    const remote = operation === 'fetch' || operation === 'pull' || operation === 'push' || operation === 'clone';
    return gitError(
      504,
      'git_timeout',
      remote
        ? `The remote did not answer${seconds}, so the ${operation} was stopped.${operation === 'push' ? ' Check the remote before pushing again: part of it may have arrived.' : ''}`
        : `Git did not finish${seconds} and was stopped.`,
      { output },
    );
  }
  const classified = classifyGitFailure(output, operation);
  return gitError(classified.status, classified.code, classified.message, { output });
}
