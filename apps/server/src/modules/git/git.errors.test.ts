import { describe, expect, it } from 'vitest';
import type { RunResult } from '../../kernel/process.js';
import { appendToTail, classifyGitFailure, cleanGitOutput, gitFailure } from './git.errors.js';

const failed = (stderr: string, extra: Partial<RunResult> = {}): RunResult => ({ code: 1, signal: null, stdout: '', stderr, truncated: false, timedOut: false, ...extra });

describe('recognising why git failed', () => {
  it.each([
    ["fatal: Authentication failed for 'https://example.org/repo.git/'", 'git_auth_failed'],
    ["fatal: could not read Username for 'https://github.com': terminal prompts disabled", 'git_auth_failed'],
    ['git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.', 'git_auth_failed'],
    ["remote: Permission to octo/demo.git denied to someone.\nfatal: unable to access 'https://github.com/octo/demo.git/': The requested URL returned error: 403", 'git_auth_failed'],
    ['Host key verification failed.\nfatal: Could not read from remote repository.', 'git_auth_failed'],
    ['To example.org:repo.git\n ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs to \'example.org:repo.git\'', 'git_push_rejected'],
    ['!\trefs/heads/tls-fix:refs/heads/tls-fix\t[rejected] (non-fast-forward)\nDone', 'git_push_rejected'],
    [' ! [remote rejected] main -> main (protected branch hook declined)', 'git_push_rejected'],
    ['remote: Repository not found.\nfatal: repository \'https://github.com/octo/nope.git/\' not found', 'git_remote_not_found'],
    ["fatal: '/srv/nope.git' does not appear to be a git repository\nfatal: Could not read from remote repository.", 'git_remote_not_found'],
    ["fatal: unable to access 'https://example.invalid/x.git/': Could not resolve host: example.invalid", 'git_network'],
    ['ssh: connect to host example.org port 22: Connection refused\nfatal: Could not read from remote repository.', 'git_network'],
    ['fatal: the remote end hung up unexpectedly', 'git_network'],
    ['There is no tracking information for the current branch.', 'git_no_upstream'],
    ['fatal: The current branch topic has no upstream branch.', 'git_no_upstream'],
    ['fatal: Not possible to fast-forward, aborting.', 'git_diverged'],
    ['fatal: refusing to merge unrelated histories', 'git_diverged'],
    ['error: Your local changes to the following files would be overwritten by merge:\n\tconflict.txt\nPlease commit your changes or stash them before you merge.', 'git_would_overwrite'],
    ['error: The following untracked working tree files would be overwritten by checkout:\n\tnew.txt', 'git_would_overwrite'],
    ['CONFLICT (content): Merge conflict in a.txt\nAutomatic merge failed; fix conflicts and then commit the result.', 'git_conflict'],
    ['error: You have not concluded your merge (MERGE_HEAD exists).', 'git_operation_in_progress'],
    ['Author identity unknown\n\n*** Please tell me who you are.', 'git_identity_missing'],
    ['On branch main\nnothing to commit, working tree clean', 'git_nothing_to_commit'],
    ["fatal: Unable to create '/srv/repo/.git/index.lock': File exists.", 'git_busy'],
    ['fatal: not a git repository (or any of the parent directories): .git', 'git_not_a_repository'],
    ["fatal: detected dubious ownership in repository at '/srv/repo'", 'git_untrusted'],
    ['error: something nobody has seen before', 'git_failed'],
  ])('%s → %s', (output, code) => {
    expect(classifyGitFailure(output, 'other').code).toBe(code);
  });

  it('reports a timeout as a timeout, and says a push may have partly arrived', () => {
    const timedOut = gitFailure(failed('', { code: null, signal: 'SIGTERM', timedOut: true }), 'push', 60_000);
    expect(timedOut).toMatchObject({ status: 504, code: 'git_timeout' });
    expect(timedOut.message).toContain('60 seconds');
    expect(timedOut.message).toContain('may have arrived');
    expect(gitFailure(failed('', { timedOut: true }), 'fetch', 5000).message).not.toContain('may have arrived');
  });

  it('never reports an unrecognised failure as anything but a failure, and keeps git’s words', () => {
    const failure = gitFailure(failed('error: pre-push hook said no'), 'push');
    expect(failure).toMatchObject({ status: 502, code: 'git_failed', message: 'Pushing to the remote failed.' });
    expect(failure.details).toEqual({ output: 'error: pre-push hook said no' });
  });
});

describe('cleaning what git printed', () => {
  it('removes credentials inside addresses and token-shaped text', () => {
    const cleaned = cleanGitOutput(
      "fatal: unable to access 'https://alice:hunter2secret@example.org/repo.git/': failed\nremote: token ghp_abcdefghijklmnopqrstuvwxyz0123456789 is invalid\nAuthorization: Bearer abcdefghijklmnop",
    );
    expect(cleaned).not.toContain('hunter2secret');
    expect(cleaned).not.toContain('alice');
    expect(cleaned).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(cleaned).not.toContain('abcdefghijklmnop');
    expect(cleaned).toContain('https://example.org/repo.git/');
  });

  it('removes the whole of a password that itself contains an @', () => {
    const cleaned = cleanGitOutput("fatal: unable to access 'https://alice:p@ss@w0rd-secret@example.org/repo.git/': failed");
    expect(cleaned).not.toMatch(/alice|p@ss|w0rd-secret/);
    expect(cleaned).toBe("fatal: unable to access 'https://example.org/repo.git/': failed");
    // An @ in the path is not a credential.
    expect(cleanGitOutput('see https://example.org/team/@scope/pkg')).toBe('see https://example.org/team/@scope/pkg');
  });

  it('removes escape sequences, control characters, progress rewrites and advice lines', () => {
    const cleaned = cleanGitOutput('\u001b[31merror:\u001b[0m bad\u0007 thing\nReceiving objects:  10%\rReceiving objects: 100%\nhint: use --force to override\nhint: or --admin\ndone');
    expect(cleaned).toBe('error: bad thing\nReceiving objects: 100%\ndone');
  });

  it('caps the length', () => {
    expect(cleanGitOutput('x'.repeat(5000), 100)).toHaveLength(101);
  });
});

describe('keeping the tail of what git printed', () => {
  it('redacts a line while it is whole, before the tail is cut', () => {
    // The token starts just before where the 100-character cut will fall.
    const token = 'ghp_ZQ7ZQ7ZQ7ZQ7ZQ7ZQ7ZQ7ZQ7ZQ7ZQ7ZQ7ZQ7';
    const tail = appendToTail('', `${'a'.repeat(79)} ${token} ${'b'.repeat(69)}`, 100);
    expect(tail.length).toBeLessThanOrEqual(100);
    expect(tail).not.toContain('ZQ7');
    expect(tail).toBe(`${'a'.repeat(19)} [redacted] ${'b'.repeat(69)}`);
  });

  it('keeps the newest lines within the limit', () => {
    let tail = '';
    for (let i = 0; i < 50; i += 1) tail = appendToTail(tail, `line ${i}`, 40);
    expect(tail.length).toBeLessThanOrEqual(40);
    expect(tail.endsWith('\nline 49')).toBe(true);
  });
});
