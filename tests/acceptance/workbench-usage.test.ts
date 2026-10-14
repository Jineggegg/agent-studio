import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiClient, RunningStudio } from './support/studio.js';
import {
  createMember,
  createProject,
  createSession,
  runToEnd,
  sandboxIsOn,
  SANDBOX_OFF,
  shareProject,
  startAgentStudio,
  transcript,
  type ErrorBody,
  type Json,
  type Project,
  type StoredEvent,
} from './support/workbench.js';

/**
 * 6.12 — Usage (requirements 01 §6.12, §5.13, §5.20, §5.21).
 *
 * Three views, each tested against what the runs themselves reported:
 *  - a session's own figures (context size, totals per model);
 *  - the report across sessions, in day/week/month buckets, by agent, model
 *    and project;
 *  - the plan windows an agent's own program reported ("quota").
 *
 * Deliberate differences: the Studio calls no usage endpoint of its own, so a
 * reading cannot be refreshed by hand (AT-WB-127's "Refresh now") and there
 * are no reset credits (AT-WB-129). Staleness after fifteen minutes needs a
 * clock the black box does not have.
 */

interface Figures {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  runs: number;
  sessions: number;
  cost: { usd: number | null; coverage: string; pricedRuns: number; unpricedRuns: number };
}

/** What a session's runs reported in the end: the last usage event of each run and model, added up. */
function reportedBy(events: StoredEvent[]): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
} {
  const last = new Map<string, Json>();
  for (const event of events)
    if (event.type === 'usage.reported')
      last.set(`${event.data.runId}/${event.data.model}`, event.data);
  const sum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const data of last.values()) {
    sum.input += data.inputTokens;
    sum.output += data.outputTokens;
    sum.cacheRead += data.cacheReadTokens;
    sum.cacheWrite += data.cacheWriteTokens;
    sum.cost += data.costUsd ?? 0;
  }
  return sum;
}

describe('6.12 usage', () => {
  let studio: RunningStudio;
  let owner: ApiClient;
  let member: ApiClient;
  let one: Project;
  let two: Project;
  let codexRan = false;
  const sessions: string[] = [];
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, runs: 0 };

  beforeAll(async () => {
    studio = await startAgentStudio();
    owner = await studio.owner();
    one = await createProject(studio, owner, 'usage-one');
    two = await createProject(studio, owner, 'usage-two');
    member = await createMember(studio, owner, 'spender');
    await shareProject(owner, two.id, member.userId!, 'write');
  });
  afterAll(() => studio?.destroy());

  it('before anything has run there is no usage: an empty report says "none", not zero cost, and no plan window is claimed', async () => {
    const report = (await owner.get<Json>('/api/usage/report?period=week')).body;
    expect(report.totals).toMatchObject({
      totalTokens: 0,
      runs: 0,
      sessions: 0,
      cost: { usd: null, coverage: 'none' },
    });
    expect(report.lastRecordedAt).toBeNull();
    const quota = (await owner.get<{ agents: Json[] }>('/api/usage/quota')).body;
    const claude = quota.agents.find((agent) => agent.agentId === 'claude-code')!;
    expect(claude).toMatchObject({
      state: 'none',
      observedAt: null,
      windows: [],
      refreshable: false,
    });
    expect(claude.staleReason.length).toBeGreaterThan(5);
  });

  it('AT-WB-124 (adapted): a session reports how full the context is — used and window — and what it has used per model; an unknown window is null, never guessed', async () => {
    const session = await createSession(owner, one.id);
    sessions.push(session.id);
    await runToEnd(owner, session.id, 'first turn');
    await runToEnd(owner, session.id, 'second turn [[scenario:thinking]]');
    const events = await transcript(owner, session.id);
    const reports = events.filter((event) => event.type === 'usage.reported');
    // While the agent is still mid-request the window is not known yet; it is reported as unknown.
    expect(reports[0]!.data.contextWindow).toBeNull();
    const newest = reports.at(-1)!.data;
    expect(newest.contextWindow).toBe(200_000);

    const usage = (await owner.get<Json>(`/api/sessions/${session.id}/usage`)).body;
    expect(usage.context).toMatchObject({
      tokens: newest.contextTokens,
      window: 200_000,
      model: newest.model,
    });
    expect(usage.context.tokens).toBeGreaterThan(0);
    expect(usage.context.tokens).toBeLessThan(usage.context.window);
    const mine = reportedBy(events);
    expect(usage.totals).toHaveLength(1);
    expect(usage.totals[0]).toMatchObject({
      model: newest.model,
      inputTokens: mine.input,
      outputTokens: mine.output,
      cacheReadTokens: mine.cacheRead,
      cacheWriteTokens: mine.cacheWrite,
    });
    expect(usage.totals[0].costUsd).toBeCloseTo(mine.cost, 6);
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'cost'] as const)
      total[key] += mine[key];
    total.runs += 2;
  });

  it('AT-WB-125 (adapted): what another session uses does not change this session’s figures', async () => {
    const a = await createSession(owner, one.id);
    const b = await createSession(owner, one.id);
    sessions.push(a.id, b.id);
    await runToEnd(owner, a.id, 'session A speaks');
    const before = (await owner.get<Json>(`/api/sessions/${a.id}/usage`)).body;
    await runToEnd(
      owner,
      b.id,
      'session B speaks at length [[scenario:todo]] [[scenario:thinking]]',
    );
    expect((await owner.get<Json>(`/api/sessions/${a.id}/usage`)).body).toEqual(before);
    const other = (await owner.get<Json>(`/api/sessions/${b.id}/usage`)).body;
    expect(other.totals[0].outputTokens).toBeGreaterThan(before.totals[0].outputTokens);
    for (const id of [a.id, b.id]) {
      const mine = reportedBy(await transcript(owner, id));
      for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'cost'] as const)
        total[key] += mine[key];
      total.runs += 1;
    }
  });

  it('WB-131 (Codex): an agent that reports no cost is recorded with tokens and an unknown cost — not a cost of zero', async (context) => {
    if (!(await sandboxIsOn(owner))) return context.skip(SANDBOX_OFF);
    const session = await createSession(owner, two.id, 'codex');
    await runToEnd(owner, session.id, 'codex turn');
    codexRan = true;
    const usage = (await owner.get<Json>(`/api/sessions/${session.id}/usage`)).body;
    expect(usage.totals).toHaveLength(1);
    expect(usage.totals[0].inputTokens).toBeGreaterThan(0);
    expect(usage.totals[0].costUsd).toBeNull();
    expect(usage.context.window).toBeGreaterThan(usage.context.tokens);
    const report = (await owner.get<Json>(`/api/usage/report?period=day&agentId=codex`)).body;
    expect(report.totals).toMatchObject({
      runs: 1,
      inputTokens: usage.totals[0].inputTokens,
      cost: { usd: null, coverage: 'unknown', pricedRuns: 0, unpricedRuns: 1 },
    });
  });

  it('AT-WB-130 (adapted): the weekly report is twelve consecutive weeks ending with this one, whose totals are the sum of what the runs reported, split by agent, model and project', async () => {
    const report = (await owner.get<Json>('/api/usage/report?period=week&agentId=claude-code'))
      .body;
    expect(report).toMatchObject({
      period: 'week',
      timeZone: 'UTC',
      scope: 'mine',
      agentId: 'claude-code',
    });
    const buckets = report.buckets as Array<
      Figures & { key: string; start: number; end: number; current: boolean }
    >;
    expect(buckets).toHaveLength(12);
    const week = 7 * 24 * 60 * 60 * 1000;
    for (let index = 1; index < buckets.length; index += 1) {
      expect(buckets[index]!.start).toBe(buckets[index - 1]!.end); // consecutive, no gap
      expect(buckets[index]!.end - buckets[index]!.start).toBe(week);
    }
    expect(buckets.map((bucket) => bucket.current)).toEqual([
      ...Array.from({ length: 11 }, () => false),
      true,
    ]);
    expect(new Date(buckets.at(-1)!.start).getUTCDay()).toBe(1); // weeks start on Monday
    expect(buckets.at(-1)!.start).toBeLessThanOrEqual(Date.now());
    expect(buckets.at(-1)!.end).toBeGreaterThan(Date.now());

    // This week's figures are exactly what the Claude Code runs of this file reported.
    const now = buckets.at(-1)!;
    expect(now).toMatchObject({
      inputTokens: total.input,
      outputTokens: total.output,
      cacheReadTokens: total.cacheRead,
      cacheWriteTokens: total.cacheWrite,
      runs: total.runs,
      sessions: sessions.length,
    });
    expect(now.totalTokens).toBe(total.input + total.output + total.cacheRead + total.cacheWrite);
    expect(now.cost.coverage).toBe('complete');
    expect(now.cost.usd!).toBeCloseTo(total.cost, 5);
    expect(
      buckets.slice(0, 11).every((bucket) => bucket.runs === 0 && bucket.cost.coverage === 'none'),
    ).toBe(true);
    expect(report.totals).toMatchObject({
      inputTokens: total.input,
      outputTokens: total.output,
      runs: total.runs,
    });

    expect(report.byAgent.rows.map((row: Json) => row.agentId)).toEqual(['claude-code']);
    expect(report.byAgent.rows[0]).toMatchObject({ agentName: 'Claude Code', runs: total.runs });
    expect(report.byModel.rows.map((row: Json) => `${row.agentId}/${row.model}`)).toEqual([
      'claude-code/claude-opus-standin',
    ]);
    expect(report.byProject.rows).toHaveLength(1);
    expect(report.byProject.rows[0]).toMatchObject({
      kind: 'project',
      projectId: one.id,
      projectName: 'usage-one',
      runs: total.runs,
    });
    expect(report.byUser).toBeNull();

    // The same in day and month buckets: the totals do not depend on how the range is cut.
    const days = (await owner.get<Json>('/api/usage/report?period=day&agentId=claude-code')).body;
    expect(days.buckets).toHaveLength(30);
    expect(days.totals.totalTokens).toBe(now.totalTokens);
    const months = (await owner.get<Json>('/api/usage/report?period=month&agentId=claude-code'))
      .body;
    expect(months.buckets).toHaveLength(12);
    expect(months.buckets.at(-1)).toMatchObject({ current: true, totalTokens: now.totalTokens });
    // Across agents the project split names both projects (when Codex ran).
    const everything = (await owner.get<Json>('/api/usage/report?period=week')).body;
    expect(everything.byProject.rows.map((row: Json) => row.projectId).sort()).toEqual(
      (codexRan ? [one.id, two.id] : [one.id]).sort(),
    );
    if (codexRan)
      expect(everything.totals.cost).toMatchObject({
        coverage: 'partial',
        unpricedRuns: 1,
        pricedRuns: total.runs,
      });
  });

  it('AT-WB-131: an unknown period, a reversed range or a range past the limit is refused as invalid', async () => {
    expect((await owner.get('/api/usage/report?period=fortnight')).status).toBe(400);
    expect(
      (await owner.get('/api/usage/report?period=day&from=2026-05-02&to=2026-05-01')).status,
    ).toBe(400);
    const tooLong = await owner.get<ErrorBody>(
      '/api/usage/report?period=day&from=2024-01-01&to=2026-06-01',
    );
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error.code).toBe('range_too_long');
    expect((await owner.get('/api/usage/report?timeZone=Mars/Olympus')).status).toBe(400);
    // A named range is honoured to the day.
    const ranged = (
      await owner.get<Json>(
        '/api/usage/report?period=day&from=2026-05-01&to=2026-05-07&timeZone=Asia/Shanghai',
      )
    ).body;
    expect(ranged.buckets.map((bucket: Json) => bucket.key)).toEqual([
      '2026-05-01',
      '2026-05-02',
      '2026-05-03',
      '2026-05-04',
      '2026-05-05',
      '2026-05-06',
      '2026-05-07',
    ]);
    expect(ranged.totals.runs).toBe(0);
  });

  it('WB-137: usage is one’s own — a member sees only theirs, cannot ask for everybody’s or another person’s; the owner can, broken down per user', async () => {
    const session = await createSession(member, two.id);
    await runToEnd(member, session.id, 'the member spends a little');
    const mine = reportedBy(await transcript(member, session.id));
    const own = (await member.get<Json>('/api/usage/report?period=week')).body;
    expect(own.totals).toMatchObject({
      runs: 1,
      sessions: 1,
      inputTokens: mine.input,
      outputTokens: mine.output,
    });
    expect(own.byProject.rows.map((row: Json) => row.projectId)).toEqual([two.id]);

    for (const url of ['/api/usage/report?scope=all', `/api/usage/report?userId=${owner.userId}`]) {
      const refused = await member.get<ErrorBody>(url);
      expect(refused.status, url).toBe(403);
      expect(refused.body.error.code).toBe('owner_required');
    }
    expect((await member.get(`/api/usage/report?projectId=${one.id}`)).status).toBe(404); // a project they cannot see
    expect((await member.get(`/api/usage/report?userId=${member.userId}`)).status).toBe(200); // naming oneself is fine

    const all = (await owner.get<Json>('/api/usage/report?period=week&scope=all')).body;
    const users = all.byUser.rows as Array<Json>;
    expect(users.map((row) => row.username).sort()).toEqual(['owner', 'spender']);
    expect(users.find((row) => row.username === 'spender')).toMatchObject({
      userId: member.userId,
      runs: 1,
      inputTokens: mine.input,
    });
    expect(all.totals.runs).toBe(users.reduce((sum, row) => sum + row.runs, 0));
    // The owner's own view does not include the member's run.
    const ownerOnly = (await owner.get<Json>('/api/usage/report?period=week')).body;
    expect(ownerOnly.totals.runs).toBe(all.totals.runs - 1);

    // A report is figures only: no prompt, no title, no session id.
    const text = JSON.stringify(all) + JSON.stringify(own);
    expect(text).not.toContain(session.id);
    expect(text).not.toContain('the member spends a little');
    for (const id of sessions) expect(text).not.toContain(id);
  });

  it('AT-WB-126/127 (adapted): a plan window is reported as used and as remaining — two views of one reading — with when it was observed; a window whose reset time has passed is flagged, with the reason, never shown as current', async () => {
    const quota = (await owner.get<{ agents: Json[]; checkedAt: number }>('/api/usage/quota')).body;
    const claude = quota.agents.find((agent) => agent.agentId === 'claude-code')!;
    // The stand-in's windows reset hours and days from now, so the reading of this file's runs is current.
    expect(claude).toMatchObject({
      agentName: 'Claude Code',
      available: true,
      refreshable: false,
      status: 'allowed',
      state: 'fresh',
      staleCode: null,
      staleReason: null,
    });
    expect(claude.observedAt).toBeLessThanOrEqual(quota.checkedAt);
    expect(quota.checkedAt - claude.observedAt).toBeLessThan(60_000); // read during the runs of this file
    expect(claude.windows.map((window: Json) => window.id).sort()).toEqual([
      'five_hour',
      'seven_day',
    ]);
    for (const window of claude.windows as Json[]) {
      expect(window.usedFraction).toBeGreaterThanOrEqual(0);
      expect(window.usedFraction).toBeLessThanOrEqual(1);
      expect(window.remainingFraction).toBeCloseTo(1 - window.usedFraction, 9);
      expect(window.label.length).toBeGreaterThan(0);
      expect(window.resetPassed).toBe(false);
      expect(window.resetsAt).toBeGreaterThan(quota.checkedAt);
    }
    expect(claude.refreshHint.length).toBeGreaterThan(10); // says in words how the reading gets renewed

    // A reading whose window has reset since is flagged, with the reason — never shown as current.
    const session = await createSession(owner, one.id);
    const reset = await runToEnd(
      owner,
      session.id,
      'just after a reset [[scenario:rate-reset-passed]]',
    );
    expect(reset.status).toBe('completed');
    const after = (await owner.get<{ agents: Json[]; checkedAt: number }>('/api/usage/quota')).body;
    const passed = after.agents.find((agent) => agent.agentId === 'claude-code')!;
    expect(passed.observedAt).toBeGreaterThanOrEqual(claude.observedAt);
    expect(passed).toMatchObject({ state: 'stale', staleCode: 'reset-passed' });
    expect(passed.staleReason).toContain('out of date');
    expect(
      Object.fromEntries(
        (passed.windows as Json[]).map((window) => [window.id, window.resetPassed]),
      ),
    ).toEqual({ five_hour: true, seven_day: false });
    // A reading belongs to the person whose run observed it.
    const fresh = await createMember(studio, owner, 'newcomer');
    const theirs = (await fresh.get<{ agents: Json[] }>('/api/usage/quota')).body.agents.find(
      (agent) => agent.agentId === 'claude-code',
    )!;
    expect(theirs.state).toBe('none');
  });

  it('AT-WB-128 (adapted): when the agent reports that its limit is reached, the run fails readably and the reading says "limited" rather than showing the old one as fine', async () => {
    const session = await createSession(owner, one.id);
    const warned = await runToEnd(owner, session.id, 'nearly there [[scenario:rate-warning]]');
    expect(warned.status).toBe('completed');
    const afterWarning = (await owner.get<{ agents: Json[] }>('/api/usage/quota')).body.agents.find(
      (agent) => agent.agentId === 'claude-code',
    )!;
    expect(afterWarning.status).toBe('warning');
    expect(
      (await transcript(owner, session.id)).some(
        (event) => event.type === 'notice' && event.data.code === 'rate_limit_warning',
      ),
    ).toBe(true);

    const limited = await runToEnd(owner, session.id, 'over the line [[scenario:usage-limit]]');
    expect(limited.status).toBe('failed');
    expect(limited.error!.code).toBe('rate_limited');
    const afterLimit = (await owner.get<{ agents: Json[] }>('/api/usage/quota')).body.agents.find(
      (agent) => agent.agentId === 'claude-code',
    )!;
    expect(afterLimit.status).toBe('limited');
    expect(afterLimit.observedAt).toBeGreaterThanOrEqual(afterWarning.observedAt);
  });
});
