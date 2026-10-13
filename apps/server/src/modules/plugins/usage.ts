import { promises as fs } from 'node:fs';

/**
 * What a plugin's processes consume, read from /proc.
 *
 * A plugin runs as a process group (the sandbox launcher and what it starts),
 * so its use is the sum over that group. Where there is no /proc the answer
 * is null and the limits that depend on it are simply not enforced — the
 * documentation says so.
 */

export interface GroupUsage {
  /** Resident memory of the whole group. */
  readonly rssBytes: number;
  /** CPU time the group has used so far, user and system. */
  readonly cpuSeconds: number;
  readonly processes: number;
}

/** Clock ticks per second in /proc; 100 on every Linux this server runs on. */
const TICKS_PER_SECOND = 100;

/** Picks the process group and CPU ticks out of one /proc/<pid>/stat line. */
export function parseStat(text: string): { pgrp: number; ticks: number } | null {
  // The second field is the command name in parentheses and may itself contain spaces and parentheses.
  const end = text.lastIndexOf(')');
  if (end === -1) return null;
  const fields = text.slice(end + 2).split(' ');
  const pgrp = Number(fields[2]);
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  if (!Number.isInteger(pgrp) || !Number.isFinite(utime) || !Number.isFinite(stime)) return null;
  return { pgrp, ticks: utime + stime };
}

/** Resident memory in bytes from /proc/<pid>/status; 0 for a process that has none (a zombie). */
export function parseRss(status: string): number {
  const match = /^VmRSS:\s+(\d+)\s+kB/m.exec(status);
  return match ? Number(match[1]) * 1024 : 0;
}

export async function groupUsage(processGroup: number): Promise<GroupUsage | null> {
  if (process.platform !== 'linux') return null;
  let names: string[];
  try {
    names = await fs.readdir('/proc');
  } catch {
    return null;
  }
  // Each process is read on its own and the figures are added up afterwards:
  // adding to a shared total across an await would lose most of them.
  const members = await Promise.all(
    names
      .filter((name) => /^\d+$/.test(name))
      .map(async (pid): Promise<{ ticks: number; rssBytes: number } | null> => {
        try {
          const stat = parseStat(await fs.readFile(`/proc/${pid}/stat`, 'utf8'));
          if (!stat || stat.pgrp !== processGroup) return null;
          return { ticks: stat.ticks, rssBytes: parseRss(await fs.readFile(`/proc/${pid}/status`, 'utf8')) };
        } catch {
          return null; // the process ended while being looked at
        }
      }),
  );
  let rssBytes = 0;
  let ticks = 0;
  let processes = 0;
  for (const member of members) {
    if (!member) continue;
    processes += 1;
    ticks += member.ticks;
    rssBytes += member.rssBytes;
  }
  return { rssBytes, cpuSeconds: ticks / TICKS_PER_SECOND, processes };
}
