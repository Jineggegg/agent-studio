import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

/**
 * Real `git` for fixtures: throw-away repositories inside the harness's
 * workspace, and for checking afterwards what the product really did to
 * them. The machine's own git configuration is never read or written — every
 * call runs with an empty global and system configuration.
 */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: '/nonexistent',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      LANG: 'C.UTF-8',
    },
  }).trim();
}

/** Like {@link git}, but a failure is returned as text instead of thrown. */
export function tryGit(cwd: string, ...args: string[]): { ok: boolean; output: string } {
  try {
    return { ok: true, output: git(cwd, ...args) };
  } catch (error) {
    const failure = error as { stderr?: string; stdout?: string; message: string };
    return { ok: false, output: `${failure.stdout ?? ''}${failure.stderr ?? failure.message}` };
  }
}

/** Makes `dir` a repository on branch `main` with a local identity (nothing global is touched). */
export function initRepository(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Fixture Author');
  git(dir, 'config', 'user.email', 'fixture@example.test');
  git(dir, 'config', 'commit.gpgsign', 'false');
}

/** A bare repository to serve as the remote. */
export function initBareRepository(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '--bare', '-b', 'main');
}

/** Stages everything and commits it; returns the new commit's id. */
export function commitAll(dir: string, message: string): string {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}
