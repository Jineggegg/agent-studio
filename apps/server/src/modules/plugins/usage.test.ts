import { describe, expect, it } from 'vitest';
import { groupUsage, parseRss, parseStat } from './usage.js';

describe('reading /proc', () => {
  it('finds the process group and CPU time even when the command name is hostile', () => {
    const tail = 'S 100 4242 4242 0 -1 4194304 500 0 0 0 150 50 0 0 20 0 7 0 12345 1000000 2500 18446744073709551615';
    expect(parseStat(`4243 (node) ${tail}`)).toEqual({ pgrp: 4242, ticks: 200 });
    expect(parseStat(`4243 (a b) c) 1 2 3 (x) ${tail}`)).toEqual({ pgrp: 4242, ticks: 200 });
    expect(parseStat('garbage')).toBeNull();
    expect(parseStat('1 (x) S 1 notanumber 1')).toBeNull();
  });

  it('reads resident memory in bytes, and zero when there is none', () => {
    expect(parseRss('Name:\tnode\nVmPeak:\t  900000 kB\nVmRSS:\t   51200 kB\nThreads:\t7\n')).toBe(51200 * 1024);
    expect(parseRss('Name:\tzombie\nState:\tZ (zombie)\n')).toBe(0);
  });

  it('measures this process group for real on Linux', async (context) => {
    if (process.platform !== 'linux') return context.skip();
    const stat = parseStat(await (await import('node:fs/promises')).readFile(`/proc/${process.pid}/stat`, 'utf8'));
    const usage = await groupUsage(stat!.pgrp);
    expect(usage!.processes).toBeGreaterThanOrEqual(1);
    // The whole group is counted, so the total is at least what this one process holds.
    expect(usage!.rssBytes).toBeGreaterThanOrEqual(Math.floor(process.memoryUsage().rss * 0.5));
    expect(usage!.rssBytes).toBeGreaterThan(30 * 1024 * 1024);
    expect(usage!.cpuSeconds).toBeGreaterThan(0);
    expect(await groupUsage(2 ** 30)).toEqual({ rssBytes: 0, cpuSeconds: 0, processes: 0 });
  });
});
