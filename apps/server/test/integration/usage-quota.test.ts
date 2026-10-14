import type { AgentQuota, QuotaResponse, UsageSummary } from '@agent-studio/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { type UsageWorld, createUsageWorlds } from '../../src/modules/usage/testing/kit.js';
import type { TestClient } from '../../src/testing/harness.js';

const worlds = createUsageWorlds();
const start = worlds.start;
afterEach(() => worlds.closeAll());

const MINUTE = 60 * 1000;
const NOON = '2026-10-14T12:00:00Z';
const seconds = (iso: string): number => Date.parse(iso) / 1000;

/** What Claude Code prints: fractions, and times in seconds. */
const claude = (fiveHour: number, sevenDay: number) => ({
  status: 'allowed',
  rateLimitType: 'five_hour',
  resetsAt: seconds('2026-10-14T15:00:00Z'),
  isUsingOverage: false,
  unifiedWindows: {
    five_hour: { utilization: fiveHour, resetsAt: seconds('2026-10-14T15:00:00Z') },
    seven_day: { utilization: sevenDay, resetsAt: seconds('2026-10-19T00:00:00Z') },
  },
});

/** Publishes what an adapter publishes when its program reports the account's limits. */
function observe(world: UsageWorld, userId: string | null, agentId: string, info: unknown, observedAt: number = world.clock.now()): void {
  world.kit.t.studio.context.bus.publish('internal:usage', 'rate-limit.observed', { agentId, userId, observedAt, info });
}

const quotaOf = async (client: TestClient, agentId: string): Promise<AgentQuota> => {
  const response = await client.get<QuotaResponse>('/api/usage/quota');
  expect(response.status).toBe(200);
  const found = response.body.agents.find((agent) => agent.agentId === agentId);
  if (!found) throw new Error(`No quota entry for ${agentId}.`);
  return found;
};

describe('plan windows as the agent itself reports them', () => {
  it('lists every agent that runs a program of its own, with nothing to show before it has reported', async () => {
    const world = await start();
    world.clock.set(NOON);
    const response = await world.kit.owner.get<QuotaResponse>('/api/usage/quota');
    expect(response.body.checkedAt).toBe(Date.parse(NOON));
    expect(response.body.agents.map((agent) => agent.agentId)).toEqual(['claude-code', 'codex', 'scripted']);
    for (const agent of response.body.agents) {
      expect(agent).toMatchObject({ state: 'none', observedAt: null, windows: [], status: null, staleCode: null, refreshable: false, available: true });
      expect(agent.staleReason).toContain('has not reported its limits yet');
      expect(agent.refreshHint).toContain('asks no usage service');
    }
  });

  it('keeps what was reported during a run, and when', async () => {
    const world = await start();
    const { kit } = world;
    const { owner } = kit;
    world.clock.set(NOON);
    const session = await kit.session(owner);
    // The report arrives in the middle of a run, as it does from the real programs.
    kit.agent.script([
      { text: 'working' },
      { do: (run) => observe(world, run.request.userId, 'scripted', claude(0.37, 0.82)) },
      { text: 'done' },
    ]);
    await kit.turn(owner, session.id, 'do the work');

    const quota = await quotaOf(owner, 'scripted');
    expect(quota).toMatchObject({ agentName: 'Scripted agent', state: 'fresh', staleCode: null, staleReason: null, observedAt: Date.parse(NOON), status: 'allowed', limitingWindow: 'five_hour', usingOverage: false, refreshable: false });
    expect(quota.windows).toEqual([
      { id: 'five_hour', label: '5-hour window', usedFraction: 0.37, remainingFraction: 1 - 0.37, resetsAt: Date.parse('2026-10-14T15:00:00Z'), windowMinutes: 300, observedAt: Date.parse(NOON), resetPassed: false },
      { id: 'seven_day', label: 'Weekly window', usedFraction: 0.82, remainingFraction: 1 - 0.82, resetsAt: Date.parse('2026-10-19T00:00:00Z'), windowMinutes: 10080, observedAt: Date.parse(NOON), resetPassed: false },
    ]);
    // The other agents are untouched.
    expect((await quotaOf(owner, 'claude-code')).state).toBe('none');

    // Every device of that user hears of it.
    const events = kit.userEvents(owner.userId, 'usage.quota.changed');
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toMatchObject({ quota: { agentId: 'scripted', state: 'fresh', observedAt: Date.parse(NOON) } });
  });

  it('replaces a reading with a newer one and ignores one that is older', async () => {
    const world = await start();
    const { owner } = world.kit;
    world.clock.set(NOON);
    observe(world, owner.userId, 'claude-code', claude(0.1, 0.2));
    world.clock.advance(5 * MINUTE);
    observe(world, owner.userId, 'claude-code', claude(0.5, 0.6));
    let quota = await quotaOf(owner, 'claude-code');
    expect(quota.observedAt).toBe(Date.parse(NOON) + 5 * MINUTE);
    expect(quota.windows.map((window) => window.usedFraction)).toEqual([0.5, 0.6]);

    // A report that was delayed on its way does not overwrite what is newer.
    observe(world, owner.userId, 'claude-code', claude(0.01, 0.02), Date.parse(NOON) - 60 * MINUTE);
    quota = await quotaOf(owner, 'claude-code');
    expect(quota.observedAt).toBe(Date.parse(NOON) + 5 * MINUTE);
    expect(quota.windows.map((window) => window.usedFraction)).toEqual([0.5, 0.6]);
    expect(world.kit.userEvents(owner.userId, 'usage.quota.changed')).toHaveLength(2);

    // A report cannot be from the future: a clock that is off is brought back to now.
    observe(world, owner.userId, 'claude-code', claude(0.7, 0.7), Date.parse(NOON) + 24 * 60 * MINUTE);
    expect((await quotaOf(owner, 'claude-code')).observedAt).toBe(Date.parse(NOON) + 5 * MINUTE);
  });

  it('goes stale with age, is fresh again after the next report, and stale once a reset time has passed', async () => {
    const world = await start();
    const { owner } = world.kit;
    world.clock.set(NOON);
    observe(world, owner.userId, 'claude-code', claude(0.37, 0.82));
    expect((await quotaOf(owner, 'claude-code')).state).toBe('fresh');

    world.clock.advance(15 * MINUTE);
    expect((await quotaOf(owner, 'claude-code')).state).toBe('fresh');
    world.clock.advance(27 * MINUTE);
    const old = await quotaOf(owner, 'claude-code');
    expect(old).toMatchObject({ state: 'stale', staleCode: 'old', observedAt: Date.parse(NOON), refreshable: false });
    expect(old.staleReason).toBe('Claude Code reported this 42 minutes ago, and the account may have been used since. It is renewed the next time Claude Code runs.');
    // The figures are still there — labelled, not withheld.
    expect(old.windows.map((window) => window.usedFraction)).toEqual([0.37, 0.82]);

    // Only the agent reporting again renews it.
    observe(world, owner.userId, 'claude-code', claude(0.4, 0.83));
    expect(await quotaOf(owner, 'claude-code')).toMatchObject({ state: 'fresh', observedAt: Date.parse(NOON) + 42 * MINUTE });

    // Three in the afternoon: the five-hour window it described has started again.
    world.clock.set('2026-10-14T14:59:59Z');
    observe(world, owner.userId, 'claude-code', claude(0.9, 0.84));
    expect((await quotaOf(owner, 'claude-code')).state).toBe('fresh');
    world.clock.set('2026-10-14T15:00:00Z');
    const over = await quotaOf(owner, 'claude-code');
    expect(over).toMatchObject({ state: 'stale', staleCode: 'reset-passed' });
    expect(over.staleReason).toContain('5-hour window');
    expect(over.staleReason).toContain('2026-10-14 15:00 UTC');
    expect(over.windows.map((window) => [window.id, window.resetPassed])).toEqual([['five_hour', true], ['seven_day', false]]);
  });

  it('uses the threshold the server was set up with', async () => {
    const world = await start({ usage: { quotaStaleAfterMs: 2 * MINUTE } });
    const { owner } = world.kit;
    world.clock.set(NOON);
    observe(world, owner.userId, 'codex', { primary: { usedPercent: 12, windowMinutes: 300, resetsAt: Date.parse('2026-10-14T16:00:00Z') }, secondary: null, credits: null, reached: null });
    world.clock.advance(2 * MINUTE);
    expect((await quotaOf(owner, 'codex')).state).toBe('fresh');
    world.clock.advance(1000);
    expect(await quotaOf(owner, 'codex')).toMatchObject({ state: 'stale', staleCode: 'old' });
  });

  it('lays a sparse report over what was known, each window with its own time', async () => {
    const world = await start();
    const { owner } = world.kit;
    world.clock.set(NOON);
    observe(world, owner.userId, 'codex', {
      limitId: 'codex',
      limitName: null,
      planType: 'plus',
      primary: { usedPercent: 12.5, windowMinutes: 300, resetsAt: Date.parse('2026-10-14T16:30:00Z') },
      secondary: { usedPercent: 64, windowMinutes: 10080, resetsAt: Date.parse('2026-10-20T08:00:00Z') },
      credits: { hasCredits: true, unlimited: false, balance: '12.50' },
      reached: null,
    });
    world.clock.advance(MINUTE);
    observe(world, owner.userId, 'codex', { limitId: 'codex', limitName: null, planType: null, primary: { usedPercent: 20, windowMinutes: 300, resetsAt: Date.parse('2026-10-14T16:30:00Z') }, secondary: null, credits: null, reached: 'rate_limit_reached' });

    const quota = await quotaOf(owner, 'codex');
    expect(quota).toMatchObject({ plan: 'plus', status: 'limited', credits: { hasCredits: true, unlimited: false, balance: '12.50' }, observedAt: Date.parse(NOON) + MINUTE });
    expect(quota.windows.map((window) => [window.id, window.label, window.usedFraction, window.observedAt])).toEqual([
      ['primary', '5-hour window', 0.2, Date.parse(NOON) + MINUTE],
      ['secondary', 'Weekly window', 0.64, Date.parse(NOON)],
    ]);
  });

  it('keeps a reading per user: one person\'s runs say nothing to another', async () => {
    const world = await start();
    const { kit } = world;
    const member = await kit.t.member();
    world.clock.set(NOON);
    observe(world, kit.owner.userId, 'claude-code', claude(0.37, 0.82));
    expect((await quotaOf(kit.owner, 'claude-code')).state).toBe('fresh');
    expect(await quotaOf(member, 'claude-code')).toMatchObject({ state: 'none', windows: [], observedAt: null });
    expect(kit.userEvents(member.userId, 'usage.quota.changed')).toHaveLength(0);

    observe(world, member.userId, 'claude-code', claude(0.05, 0.06));
    expect((await quotaOf(member, 'claude-code')).windows.map((window) => window.usedFraction)).toEqual([0.05, 0.06]);
    expect((await quotaOf(kit.owner, 'claude-code')).windows.map((window) => window.usedFraction)).toEqual([0.37, 0.82]);
  });

  it('stores only what it recognises, and nothing at all from an event it cannot read', async () => {
    const world = await start();
    const { kit } = world;
    const { owner } = kit;
    world.clock.set(NOON);
    const db = kit.t.studio.context.db;
    const stored = () => db.all<{ agent_id: string; info: string }>('SELECT agent_id, info FROM usage_quota_readings');

    observe(world, owner.userId, 'claude-code', { foo: 'bar' });
    observe(world, owner.userId, 'claude-code', 'limited');
    observe(world, null, 'claude-code', claude(0.1, 0.1));
    observe(world, 'not-an-id', 'claude-code', claude(0.1, 0.1));
    observe(world, owner.userId, '', claude(0.1, 0.1));
    // An account that does not exist (any more): nothing is kept and nothing breaks.
    observe(world, '0123456789abcdefghjkmnpqrs', 'claude-code', claude(0.1, 0.1));
    kit.t.studio.context.bus.publish('internal:usage', 'rate-limit.observed', null);
    kit.t.studio.context.bus.publish('internal:usage', 'something.else', { agentId: 'claude-code', userId: owner.userId, observedAt: world.clock.now(), info: claude(0.1, 0.1) });
    expect(stored()).toEqual([]);
    expect(kit.userEvents(owner.userId, 'usage.quota.changed')).toHaveLength(0);

    // What is kept is the reduced reading: no field the Studio does not understand reaches the table.
    observe(world, owner.userId, 'claude-code', { ...claude(0.37, 0.82), overageDisabledReason: 'org_level_disabled', account: { email: 'someone@example.test' }, token: 'sk-ant-abcdefghijklmnopqrstuvwxyz' });
    const rows = stored();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.info).not.toContain('example.test');
    expect(rows[0]!.info).not.toContain('sk-ant');
    expect(rows[0]!.info).not.toContain('org_level_disabled');
    expect(Object.keys(JSON.parse(rows[0]!.info) as object).sort()).toEqual(['credits', 'limitingWindow', 'plan', 'status', 'usingOverage', 'windows']);
  });

  it('still shows the last reading of an agent that is no longer registered', async () => {
    const world = await start();
    const { owner } = world.kit;
    world.clock.set(NOON);
    observe(world, owner.userId, 'retired-agent', claude(0.2, 0.3));
    expect(await quotaOf(owner, 'retired-agent')).toMatchObject({ available: false, agentName: 'retired-agent', state: 'fresh' });
  });
});

describe('the summary for a home-screen tile', () => {
  it('gives each agent one line and one fraction, from the best thing that is known', async () => {
    const world = await start();
    const { kit } = world;
    const { owner } = kit;
    world.clock.set(NOON);
    const session = await kit.session(owner);
    const run = await world.run(owner, session.id, [{ input: 1000, output: 234, cost: 0.5 }]);
    world.place(run.id, '2026-10-14T09:00:00Z');
    const earlier = await world.run(owner, session.id, [{ input: 4000 }]);
    world.place(earlier.id, '2026-10-02T09:00:00Z');
    observe(world, owner.userId, 'claude-code', claude(0.37, 0.82));

    const summary = (await owner.get<UsageSummary>('/api/usage/summary')).body;
    expect(summary).toMatchObject({ timeZone: 'UTC', generatedAt: Date.parse(NOON), budgetsAtRisk: [] });
    const agent = (id: string) => summary.agents.find((entry) => entry.agentId === id)!;
    expect(summary.agents.map((entry) => entry.agentId)).toEqual(['claude-code', 'codex', 'scripted']);

    // A plan window was reported: the fullest one is the figure.
    expect(agent('claude-code')).toMatchObject({
      agentName: 'Claude Code',
      kind: 'cli',
      basis: 'quota',
      fraction: 0.82,
      line: '82% of the weekly window used',
      window: { id: 'seven_day', label: 'Weekly window', resetsAt: Date.parse('2026-10-19T00:00:00Z') },
      quotaState: 'fresh',
      staleReason: null,
      observedAt: Date.parse(NOON),
    });
    // Nothing reported and no budget: what was used this month, and no fraction is made up.
    expect(agent('scripted')).toMatchObject({
      basis: 'usage',
      fraction: null,
      line: '5,234 tokens this month · $0.50+',
      window: null,
      quotaState: 'none',
      month: { totalTokens: 5234, runs: 2, cost: { usd: 0.5, coverage: 'partial' } },
      today: { totalTokens: 1234, runs: 1, cost: { usd: 0.5, coverage: 'complete' } },
    });
    expect(agent('codex')).toMatchObject({ basis: 'usage', fraction: null, line: 'No usage this month', quotaState: 'none', month: { totalTokens: 0, runs: 0, cost: { coverage: 'none' } } });

    // A budget of the caller's own for that agent becomes the figure.
    expect((await owner.post('/api/usage/budgets', { agentId: 'scripted', metric: 'tokens', amount: 10_000 })).status).toBe(201);
    const withBudget = (await owner.get<UsageSummary>('/api/usage/summary')).body.agents.find((entry) => entry.agentId === 'scripted')!;
    expect(withBudget).toMatchObject({ basis: 'budget', fraction: 0.5234, line: "52% of this month's token budget used" });
  });

  it('says so when the figure may be out of date, and follows the zone for "today" and "this month"', async () => {
    const world = await start();
    const { kit } = world;
    const { owner } = kit;
    world.clock.set(NOON);
    observe(world, owner.userId, 'claude-code', claude(0.37, 0.82));
    const session = await kit.session(owner);
    const run = await world.run(owner, session.id, [{ input: 700 }]);
    // Half past eleven at night on 30 September in New York; already October in UTC.
    world.place(run.id, '2026-10-01T03:30:00Z');

    world.clock.advance(60 * MINUTE);
    const summary = (await owner.get<UsageSummary>('/api/usage/summary')).body;
    const claudeCode = summary.agents.find((entry) => entry.agentId === 'claude-code')!;
    expect(claudeCode).toMatchObject({ basis: 'quota', fraction: 0.82, line: '82% of the weekly window used (may be out of date)', quotaState: 'stale' });
    expect(claudeCode.staleReason).toContain('1 hour ago');
    expect(summary.agents.find((entry) => entry.agentId === 'scripted')!.month.totalTokens).toBe(700);

    const newYork = (await owner.get<UsageSummary>('/api/usage/summary?timeZone=America/New_York')).body;
    expect(newYork.timeZone).toBe('America/New_York');
    expect(newYork.agents.find((entry) => entry.agentId === 'scripted')!.month).toMatchObject({ totalTokens: 0, runs: 0 });
    expect((await owner.get('/api/usage/summary?timeZone=Nowhere/Land')).status).toBe(400);

    // Once the fullest window has started again, the tile falls back to one that has not.
    world.clock.set('2026-10-19T00:00:01Z');
    const later = (await owner.get<UsageSummary>('/api/usage/summary')).body.agents.find((entry) => entry.agentId === 'claude-code')!;
    expect(later).toMatchObject({ basis: 'usage', fraction: null, quotaState: 'stale', window: null });
  });

  it('is the caller\'s own', async () => {
    const world = await start();
    const { kit } = world;
    const member = await kit.t.member();
    await kit.share(kit.project, member, 'write');
    const session = await kit.session(kit.owner);
    await world.run(kit.owner, session.id, [{ input: 999 }]);
    observe(world, kit.owner.userId, 'claude-code', claude(0.37, 0.82));
    const summary = (await member.get<UsageSummary>('/api/usage/summary')).body;
    for (const agent of summary.agents) expect(agent).toMatchObject({ fraction: null, quotaState: 'none', month: { totalTokens: 0 } });
  });
});
