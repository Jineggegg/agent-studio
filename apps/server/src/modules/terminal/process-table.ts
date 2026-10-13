import { existsSync, promises as fs, readFileSync } from 'node:fs';
import type { ProcessSupervisor } from '../../kernel/process.js';

/**
 * Finding and ending the processes of a terminal.
 *
 * The program in a pseudo-terminal is a session leader, and everything the
 * user starts from it (foreground jobs, background jobs, pipelines) stays in
 * that operating-system session, each job in its own process group. Signalling
 * only the shell would leave the jobs behind, so a terminal is ended by
 * signalling every process of its session, and "nothing is left" is confirmed
 * by looking at the process table again.
 *
 * A process that deliberately leaves the session (`setsid`, a daemon, a tmux
 * server) is no longer part of the terminal and is not touched. `nohup` alone
 * does not leave the session: closing a terminal here ends such a job too.
 */

export interface ProcessEntry {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  /** Session id; null where the platform does not report it. */
  readonly sid: number | null;
  /** Start time in clock ticks since boot; null where not reported. */
  readonly startTime: number | null;
  readonly zombie: boolean;
}

/** Parses one `/proc/<pid>/stat` line. The command name may itself contain spaces and parentheses. */
export function parseProcStat(text: string): ProcessEntry | null {
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open === -1 || close === -1 || close < open) return null;
  const pid = Number(text.slice(0, open).trim());
  const rest = text.slice(close + 1).trim().split(/\s+/);
  // rest[0] is field 3 (state); ppid is field 4, pgrp 5, session 6, starttime 22.
  const [state, ppid, pgid, sid] = [rest[0], Number(rest[1]), Number(rest[2]), Number(rest[3])];
  const startTime = Number(rest[19]);
  if (![pid, ppid, pgid, sid].every((value) => Number.isInteger(value)) || state === undefined) return null;
  return { pid, ppid, pgid, sid, startTime: Number.isFinite(startTime) ? startTime : null, zombie: state === 'Z' || state === 'X' };
}

/** Parses `ps -A -o pid=,ppid=,pgid=,stat=`: the portable fallback where there is no /proc. */
export function parsePsOutput(text: string): ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 3) continue;
    const [pid, ppid, pgid] = [Number(fields[0]), Number(fields[1]), Number(fields[2])];
    if (![pid, ppid, pgid].every((value) => Number.isInteger(value) && value >= 0)) continue;
    entries.push({ pid, ppid, pgid, sid: null, startTime: null, zombie: (fields[3] ?? '').startsWith('Z') });
  }
  return entries;
}

export type ProcessLister = () => Promise<ProcessEntry[]>;

export function procProcessLister(procDir = '/proc'): ProcessLister {
  return async () => {
    const names = (await fs.readdir(procDir)).filter((name) => /^\d+$/.test(name));
    const stats = await Promise.all(names.map((name) => fs.readFile(`${procDir}/${name}/stat`, 'utf8').catch(() => null)));
    const entries: ProcessEntry[] = [];
    for (const stat of stats) {
      const entry = stat === null ? null : parseProcStat(stat);
      if (entry) entries.push(entry);
    }
    return entries;
  };
}

export function psProcessLister(processes: Pick<ProcessSupervisor, 'run' | 'env'>): ProcessLister {
  return async () => {
    const result = await processes.run('ps', ['-A', '-o', 'pid=,ppid=,pgid=,stat='], { timeoutMs: 3000, env: processes.env({ LC_ALL: 'C' }) });
    return result.code === 0 ? parsePsOutput(result.stdout) : [];
  };
}

/** The process table of this host. Concurrent callers share one scan. */
export function hostProcessLister(processes: Pick<ProcessSupervisor, 'run' | 'env'>): ProcessLister {
  const scan = process.platform === 'linux' && existsSync('/proc/self/stat') ? procProcessLister() : psProcessLister(processes);
  let inFlight: Promise<ProcessEntry[]> | null = null;
  return () => {
    inFlight ??= scan().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}

/** What identifies a terminal's processes: its leader, and when that leader started. */
export interface TerminalIdentity {
  readonly leaderPid: number;
  /** Tells our leader from a later process that was given the same pid. Null where there is no /proc. */
  readonly startTime: number | null;
}

/** Records the identity of a freshly started terminal leader. */
export function identifyLeader(pid: number, procDir = '/proc'): TerminalIdentity {
  try {
    const entry = parseProcStat(readFileSync(`${procDir}/${pid}/stat`, 'utf8'));
    if (entry && entry.pid === pid) return { leaderPid: pid, startTime: entry.startTime };
  } catch {
    // No /proc, or the program is already gone.
  }
  return { leaderPid: pid, startTime: null };
}

/**
 * The living processes that belong to a terminal: its leader, and every
 * process whose session id is the leader's pid.
 *
 * Process ids are reused, so the match is guarded. A session id stays
 * reserved for as long as any process of that session is alive, which means
 * the processes found are the terminal's own unless the id was released and
 * handed to an unrelated session in the meantime. That is ruled out when the
 * leader is still the process we started, and refused outright when some
 * other process now holds the leader's pid. With the leader gone, the callers
 * look only once right after its exit (see `TerminalSession`), before the id
 * could come round again, and afterwards only while members remain.
 */
export function membersOf(table: readonly ProcessEntry[], identity: TerminalIdentity): ProcessEntry[] {
  const { leaderPid } = identity;
  const alive = (entry: ProcessEntry) => !entry.zombie && entry.pid > 1 && entry.pid !== process.pid;
  const holder = table.find((entry) => entry.pid === leaderPid) ?? null;
  const leaderIsOurs = holder !== null && (identity.startTime === null || holder.startTime === null || holder.startTime === identity.startTime);
  if (holder !== null && !leaderIsOurs) return [];

  if (table.some((entry) => entry.sid !== null)) {
    // The leader itself always counts: in its first instants it has not yet moved into its own session.
    return table.filter((entry) => alive(entry) && (entry.sid === leaderPid || (leaderIsOurs && entry.pid === leaderPid)));
  }

  // No session ids on this platform: the leader's own group plus everything
  // descended from it, and only while the leader itself can still be seen.
  if (!leaderIsOurs) return [];
  const members = new Set<number>([leaderPid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const entry of table) {
      if (members.has(entry.pid)) continue;
      if (members.has(entry.ppid) || entry.pgid === leaderPid) {
        members.add(entry.pid);
        grew = true;
      }
    }
  }
  return table.filter((entry) => members.has(entry.pid) && alive(entry));
}

export interface TerminationOptions {
  readonly list: ProcessLister;
  /** How long to wait after the hang-up before forcing. */
  readonly graceMs: number;
  /** How long to wait after forcing before reporting what is left. */
  readonly killWaitMs: number;
  /** Injected in tests. */
  readonly signal?: (pid: number, signal: NodeJS.Signals) => void;
}

function send(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone, or not ours to signal.
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Ends every process of a terminal: a hang-up first (what closing a terminal
 * window sends), then, for whatever is still there after the grace period, a
 * kill. Returns the pids that survived even that; normally none.
 */
export async function terminateTerminal(identity: TerminalIdentity, options: TerminationOptions): Promise<number[]> {
  const signal = options.signal ?? send;
  const current = async () => membersOf(await options.list(), identity);
  const waitUntilGone = async (limitMs: number): Promise<boolean> => {
    const deadline = Date.now() + limitMs;
    for (let pause = 10; ; pause = Math.min(pause * 2, 160)) {
      if ((await current()).length === 0) return true;
      const left = deadline - Date.now();
      if (left <= 0) return false;
      await sleep(Math.min(pause, left));
    }
  };

  const first = await current();
  if (first.length === 0) return [];
  for (const entry of first) signal(entry.pid, 'SIGHUP');
  // A stopped job cannot react to a hang-up until it is continued.
  for (const entry of first) signal(entry.pid, 'SIGCONT');
  if (await waitUntilGone(options.graceMs)) return [];

  for (const entry of await current()) signal(entry.pid, 'SIGKILL');
  if (await waitUntilGone(options.killWaitMs)) return [];
  return (await current()).map((entry) => entry.pid);
}
