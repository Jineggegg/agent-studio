import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Which program a plain terminal runs. It is never chosen by a client: it is
 * the login shell of the account the server runs as, taken from the
 * operating system's account database, then from `$SHELL`, and it is accepted
 * only if it is an absolute path to an executable file that `/etc/shells`
 * lists (when that file exists). Anything else falls back to `/bin/sh`.
 */

export const FALLBACK_SHELL = '/bin/sh';

/** Account "shells" whose whole purpose is to refuse a login. */
const NOT_A_SHELL = new Set(['nologin', 'false', 'true', 'sync', 'halt', 'shutdown']);

export interface ShellProbe {
  /** The shell recorded for the account in the OS account database, if any. */
  readonly accountShell: string | null;
  /** `$SHELL` as the server sees it. */
  readonly environmentShell: string | undefined;
  /** Contents of `/etc/shells`, or null when there is no such file. */
  readonly etcShells: string | null;
  isExecutableFile(file: string): boolean;
  /** Resolves symbolic links; returns the input when that fails. */
  realPath(file: string): string;
}

export interface ChosenShell {
  readonly file: string;
  readonly source: 'account' | 'environment' | 'fallback';
}

export function parseEtcShells(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter((line) => line.startsWith('/'));
}

function acceptable(candidate: string | null | undefined, probe: ShellProbe): candidate is string {
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > 4096) return false;
  if (candidate.includes('\0') || !path.isAbsolute(candidate) || path.normalize(candidate) !== candidate) return false;
  if (NOT_A_SHELL.has(path.basename(candidate))) return false;
  if (!probe.isExecutableFile(candidate)) return false;
  if (probe.etcShells === null) return true;
  const listed = parseEtcShells(probe.etcShells);
  if (listed.includes(candidate)) return true;
  // /bin is a link to /usr/bin on many systems, and /etc/shells may list either spelling.
  const real = probe.realPath(candidate);
  return listed.some((entry) => probe.realPath(entry) === real);
}

export function chooseLoginShell(probe: ShellProbe): ChosenShell {
  if (acceptable(probe.accountShell, probe)) return { file: probe.accountShell, source: 'account' };
  if (acceptable(probe.environmentShell, probe)) return { file: probe.environmentShell, source: 'environment' };
  return { file: FALLBACK_SHELL, source: 'fallback' };
}

export function isExecutableFile(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Reads the host's real answers for {@link chooseLoginShell}. */
export function probeHostShell(environmentShell: string | undefined): ShellProbe {
  let accountShell: string | null = null;
  try {
    accountShell = os.userInfo().shell ?? null;
  } catch {
    // No account entry (some containers run with a bare numeric uid).
  }
  let etcShells: string | null;
  try {
    etcShells = readFileSync('/etc/shells', 'utf8');
  } catch {
    etcShells = null; // no such file on this system
  }
  return {
    accountShell,
    environmentShell,
    etcShells,
    isExecutableFile,
    realPath: (file) => {
      try {
        return realpathSync(file);
      } catch {
        return file;
      }
    },
  };
}

/**
 * Finds a program the way a shell would, on the given `PATH`, without running
 * anything. A name containing a slash must already be an absolute path.
 * Relative `PATH` entries are skipped: what runs must not depend on the
 * directory a session happens to start in.
 */
export function findExecutable(name: string, searchPath: string | undefined): string | null {
  if (name.length === 0 || name.includes('\0')) return null;
  if (name.includes('/')) return path.isAbsolute(name) && isExecutableFile(name) ? name : null;
  for (const directory of (searchPath ?? '').split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}
