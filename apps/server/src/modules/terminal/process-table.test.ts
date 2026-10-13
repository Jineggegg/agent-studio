import { describe, expect, it } from 'vitest';
import {
  type ProcessEntry,
  type TerminalIdentity,
  identifyLeader,
  membersOf,
  parseProcStat,
  parsePsOutput,
  procProcessLister,
  terminateTerminal,
} from './process-table.js';

const entry = (pid: number, sid: number | null, extra: Partial<ProcessEntry> = {}): ProcessEntry => ({
  pid,
  ppid: 1,
  pgid: pid,
  sid,
  startTime: 1000 + pid,
  zombie: false,
  ...extra,
});

describe('reading the process table', () => {
  it('parses a stat line, also when the command name is hostile', () => {
    const line = '4321 (sh) S 4300 4321 4321 34820 4321 4194304 100 0 0 0 0 0 0 0 20 0 1 0 987654 1000 100 18446744073709551615 0 0 0';
    expect(parseProcStat(line)).toEqual({ pid: 4321, ppid: 4300, pgid: 4321, sid: 4321, startTime: 987654, zombie: false });
    const tricky = '77 (a b) c) (d) Z 1 70 60 0 -1 4 0 0 0 0 0 0 0 0 20 0 1 0 555 0 0';
    expect(parseProcStat(tricky)).toEqual({ pid: 77, ppid: 1, pgid: 70, sid: 60, startTime: 555, zombie: true });
    expect(parseProcStat('garbage')).toBeNull();
    expect(parseProcStat('12 (x)')).toBeNull();
    expect(parseProcStat('')).toBeNull();
  });

  it('parses the portable ps listing', () => {
    expect(parsePsOutput('    1     0     1 Ss\n  200     1   200 S+\n  201   200   200 Z\nnonsense line here\n\n')).toEqual([
      { pid: 1, ppid: 0, pgid: 1, sid: null, startTime: null, zombie: false },
      { pid: 200, ppid: 1, pgid: 200, sid: null, startTime: null, zombie: false },
      { pid: 201, ppid: 200, pgid: 200, sid: null, startTime: null, zombie: true },
    ]);
  });

  it.runIf(process.platform === 'linux')('sees this very process in /proc', async () => {
    const table = await procProcessLister()();
    const me = table.find((candidate) => candidate.pid === process.pid);
    expect(me).toMatchObject({ pid: process.pid, ppid: process.ppid, zombie: false });
    expect(identifyLeader(process.pid)).toEqual({ leaderPid: process.pid, startTime: me!.startTime });
    expect(identifyLeader(0x7ffffff0)).toEqual({ leaderPid: 0x7ffffff0, startTime: null });
  });
});

describe('deciding which processes belong to a terminal', () => {
  const identity: TerminalIdentity = { leaderPid: 500, startTime: 1500 };

  it('takes the leader and everything in its session', () => {
    const table = [entry(1, 1), entry(400, 400), entry(500, 500), entry(501, 500, { ppid: 500 }), entry(502, 500, { ppid: 1, pgid: 502 }), entry(600, 600, { ppid: 500 })];
    expect(membersOf(table, identity).map((member) => member.pid)).toEqual([500, 501, 502]);
  });

  it('leaves alone a process that moved to a session of its own', () => {
    // 600 is a child of the shell but called setsid: it is no longer part of the terminal.
    const table = [entry(500, 500), entry(600, 600, { ppid: 500 })];
    expect(membersOf(table, identity).map((member) => member.pid)).toEqual([500]);
  });

  it('counts a leader that has not yet moved into its own session', () => {
    // Right after the fork the new process is still in the server's session.
    const table = [entry(100, 100), entry(500, 100, { ppid: 100, pgid: 100 })];
    expect(membersOf(table, identity).map((member) => member.pid)).toEqual([500]);
  });

  it('still finds what a dead leader left behind', () => {
    const table = [entry(501, 500), entry(502, 500, { startTime: 99999 })];
    expect(membersOf(table, identity).map((member) => member.pid)).toEqual([501, 502]);
    // A leader that is dead but not yet collected is not itself a member.
    const withZombie = [entry(500, 500, { zombie: true }), entry(501, 500)];
    expect(membersOf(withZombie, identity).map((member) => member.pid)).toEqual([501]);
  });

  it("claims nothing when another process now holds the leader's pid", () => {
    // pid 500 was reused by an unrelated program that started its own session.
    const table = [entry(500, 500, { startTime: 424242 }), entry(501, 500), entry(502, 500)];
    expect(membersOf(table, identity)).toEqual([]);
  });

  it('ignores zombies, init and itself', () => {
    const table = [entry(1, 500), entry(process.pid, 500), entry(501, 500, { zombie: true }), entry(502, 500)];
    expect(membersOf(table, { leaderPid: 500, startTime: null }).map((member) => member.pid)).toEqual([502]);
    expect(membersOf([], identity)).toEqual([]);
  });

  it('falls back to ancestry where session ids are not reported', () => {
    const plain = (pid: number, ppid: number, pgid: number): ProcessEntry => ({ pid, ppid, pgid, sid: null, startTime: null, zombie: false });
    const table = [plain(1, 0, 1), plain(500, 100, 500), plain(501, 500, 501), plain(502, 501, 501), plain(503, 1, 500), plain(700, 1, 700)];
    expect(membersOf(table, { leaderPid: 500, startTime: null }).map((member) => member.pid)).toEqual([500, 501, 502, 503]);
    // Without the leader there is nothing to go by, so nothing is claimed.
    expect(membersOf(table.filter((candidate) => candidate.pid !== 500), { leaderPid: 500, startTime: null })).toEqual([]);
  });
});

describe('ending the processes of a terminal', () => {
  const identity: TerminalIdentity = { leaderPid: 500, startTime: 1500 };

  /** A pretend host: processes die of the signals listed for them. */
  function host(processes: Array<{ pid: number; diesOf: NodeJS.Signals[] }>) {
    const living = new Map(processes.map((process) => [process.pid, process]));
    const sent: Array<[number, NodeJS.Signals]> = [];
    return {
      sent,
      living,
      list: () => Promise.resolve([...living.keys()].map((pid) => entry(pid, 500, pid === 500 ? {} : { ppid: 500 }))),
      signal: (pid: number, signal: NodeJS.Signals) => {
        sent.push([pid, signal]);
        if (living.get(pid)?.diesOf.includes(signal)) living.delete(pid);
      },
    };
  }

  it('hangs up first and reports nothing left when that is enough', async () => {
    const fake = host([
      { pid: 500, diesOf: ['SIGHUP', 'SIGKILL'] },
      { pid: 501, diesOf: ['SIGHUP', 'SIGKILL'] },
    ]);
    expect(await terminateTerminal(identity, { list: fake.list, signal: fake.signal, graceMs: 50, killWaitMs: 50 })).toEqual([]);
    // The hang-up, then a continue for whatever might have been stopped; never a kill.
    expect(fake.sent).toEqual([
      [500, 'SIGHUP'],
      [501, 'SIGHUP'],
      [500, 'SIGCONT'],
      [501, 'SIGCONT'],
    ]);
  });

  it('continues stopped jobs and kills what ignores the hang-up', async () => {
    const fake = host([
      { pid: 500, diesOf: ['SIGHUP', 'SIGKILL'] },
      { pid: 501, diesOf: ['SIGKILL'] }, // nohup
      { pid: 502, diesOf: ['SIGCONT', 'SIGKILL'] }, // stopped: acts on the hang-up once continued
    ]);
    expect(await terminateTerminal(identity, { list: fake.list, signal: fake.signal, graceMs: 30, killWaitMs: 50 })).toEqual([]);
    expect(fake.sent).toEqual([
      [500, 'SIGHUP'],
      [501, 'SIGHUP'],
      [502, 'SIGHUP'],
      [500, 'SIGCONT'],
      [501, 'SIGCONT'],
      [502, 'SIGCONT'],
      [501, 'SIGKILL'],
    ]);
    expect(fake.living.size).toBe(0);
  });

  it('reports what survives even a kill', async () => {
    const fake = host([
      { pid: 500, diesOf: ['SIGHUP'] },
      { pid: 501, diesOf: [] },
    ]);
    const started = Date.now();
    expect(await terminateTerminal(identity, { list: fake.list, signal: fake.signal, graceMs: 30, killWaitMs: 30 })).toEqual([501]);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(fake.sent.filter(([, signal]) => signal === 'SIGKILL')).toEqual([[501, 'SIGKILL']]);
  });

  it('does nothing when there is nothing to end', async () => {
    const fake = host([]);
    expect(await terminateTerminal(identity, { list: fake.list, signal: fake.signal, graceMs: 30, killWaitMs: 30 })).toEqual([]);
    expect(fake.sent).toEqual([]);
  });

  it("signals nobody when the leader's pid belongs to someone else now", async () => {
    const sent: number[] = [];
    const list = () => Promise.resolve([entry(500, 500, { startTime: 777 }), entry(501, 500)]);
    expect(await terminateTerminal(identity, { list, signal: (pid) => sent.push(pid), graceMs: 30, killWaitMs: 30 })).toEqual([]);
    expect(sent).toEqual([]);
  });
});
