import type { Project, Session, SessionUsage, UsageBucket, UsageFigures } from '@agent-studio/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { createUsageWorlds, errorOf } from '../../src/modules/usage/testing/kit.js';
import { ScriptedAdapter } from '../../src/testing/scripted-adapter.js';

const worlds = createUsageWorlds();
const start = worlds.start;
afterEach(() => worlds.closeAll());

const tokens = (figures: UsageFigures) => [figures.inputTokens, figures.outputTokens, figures.cacheReadTokens, figures.cacheWriteTokens, figures.totalTokens];
const byKey = (buckets: UsageBucket[]) => Object.fromEntries(buckets.map((bucket) => [bucket.key, bucket.totalTokens]));

describe('adding up what runs used', () => {
  it('totals tokens, cost, runs and sessions, and splits them by agent, model and project', async () => {
    const second = new ScriptedAdapter({ id: 'second', displayName: 'Second agent' });
    const world = await start({ kit: { adapters: [new ScriptedAdapter(), second] } });
    const { kit } = world;
    const { owner, project } = kit;
    const side = await kit.makeProject('side');
    const main = await kit.session(owner, { title: 'Quarterly numbers, confidential' });
    const other = (await owner.post<Session>('/api/sessions', { projectId: side.id, agentId: 'second' })).body;

    await world.run(owner, main.id, [{ input: 1000, output: 200, cacheRead: 300, cacheWrite: 50, cost: 0.1 }]);
    // Two models in one run: one with a cost, one without.
    await world.run(owner, main.id, [
      { input: 500, output: 100, cost: 0.05 },
      { model: 'scripted-small', input: 40, output: 10 },
    ]);
    await world.run(owner, other.id, [{ model: 'second-model', input: 7, output: 3 }], second);

    const report = await world.report(owner);
    expect(report).toMatchObject({ period: 'day', timeZone: 'UTC', scope: 'mine', userId: owner.userId, projectId: null, agentId: null, byUser: null, sessionUsageUrl: '/api/sessions/:sessionId/usage' });
    expect(tokens(report.totals)).toEqual([1547, 313, 300, 50, 2210]);
    expect(report.totals).toMatchObject({ runs: 3, sessions: 2, reasoningTokens: null });
    // 0.10 + 0.05 are known; the second run also used a model without a cost, and the third has none at all.
    expect(report.totals.cost).toEqual({ usd: 0.15, coverage: 'partial', pricedRuns: 1, unpricedRuns: 2 });
    expect(report.lastRecordedAt).toBeGreaterThan(0);

    // Thirty days, the last of them today, holding everything.
    expect(report.buckets).toHaveLength(30);
    const today = report.buckets.at(-1)!;
    expect(today.current).toBe(true);
    expect(tokens(today)).toEqual([1547, 313, 300, 50, 2210]);
    expect(today.cost).toEqual(report.totals.cost);
    for (const earlier of report.buckets.slice(0, -1)) {
      expect(earlier).toMatchObject({ totalTokens: 0, runs: 0, sessions: 0, current: false, cost: { usd: null, coverage: 'none', pricedRuns: 0, unpricedRuns: 0 } });
    }
    expect(report.start).toBe(report.buckets[0]!.start);
    expect(report.end).toBe(today.end);

    expect(report.byAgent.others).toBeNull();
    expect(report.byAgent.rows.map((row) => [row.agentId, row.agentName, row.totalTokens, row.runs, row.sessions, row.cost.coverage, row.cost.usd])).toEqual([
      ['scripted', 'Scripted agent', 2200, 2, 1, 'partial', 0.15],
      ['second', 'Second agent', 10, 1, 1, 'unknown', null],
    ]);
    expect(report.byModel.rows.map((row) => [row.agentId, row.model, row.totalTokens, row.runs, row.cost.coverage, row.cost.usd])).toEqual([
      ['scripted', 'scripted-large', 2150, 2, 'complete', 0.15],
      ['scripted', 'scripted-small', 50, 1, 'unknown', null],
      ['second', 'second-model', 10, 1, 'unknown', null],
    ]);
    expect(report.byProject.rows.map((row) => [row.kind, row.projectId, row.projectName, row.totalTokens, row.runs])).toEqual([
      ['project', project.id, 'demo', 2200, 2],
      ['project', side.id, 'side', 10, 1],
    ]);

    // One session's own figures are the runtime's; the report agrees with them and points there.
    const session = (await owner.get<SessionUsage>(report.sessionUsageUrl.replace(':sessionId', main.id))).body;
    expect(session.totals.reduce((sum, model) => sum + model.inputTokens + model.outputTokens + model.cacheReadTokens + model.cacheWriteTokens, 0)).toBe(2200);

    // Nothing of a conversation is in a usage report: not its name, not what was asked.
    const text = JSON.stringify(report);
    expect(text).not.toContain('confidential');
    expect(text).not.toContain('do the work');
    expect(text).not.toContain(main.id);
  });

  it('narrows to one agent or one project', async () => {
    const second = new ScriptedAdapter({ id: 'second', displayName: 'Second agent' });
    const world = await start({ kit: { adapters: [new ScriptedAdapter(), second] } });
    const { kit } = world;
    const { owner, project } = kit;
    const side = await kit.makeProject('side');
    const first = await kit.session(owner);
    const inSide = (await owner.post<Session>('/api/sessions', { projectId: side.id, agentId: 'scripted' })).body;
    const withSecond = await kit.session(owner, { agentId: 'second' });
    await world.run(owner, first.id, [{ input: 100 }]);
    await world.run(owner, inSide.id, [{ input: 20 }]);
    await world.run(owner, withSecond.id, [{ input: 3 }], second);

    expect((await world.report(owner)).totals.totalTokens).toBe(123);
    const scripted = await world.report(owner, 'agentId=scripted');
    expect(scripted.totals).toMatchObject({ totalTokens: 120, runs: 2 });
    expect(scripted.agentId).toBe('scripted');
    expect(scripted.byAgent.rows.map((row) => row.agentId)).toEqual(['scripted']);
    const demo = await world.report(owner, `projectId=${project.id}`);
    expect(demo.totals).toMatchObject({ totalTokens: 103, runs: 2 });
    expect(demo.byProject.rows.map((row) => row.projectId)).toEqual([project.id]);
    expect((await world.report(owner, `projectId=${side.id}&agentId=second`)).totals).toMatchObject({ totalTokens: 0, runs: 0, cost: { coverage: 'none', usd: null } });
    expect((await world.report(owner, 'agentId=never-heard-of')).totals.runs).toBe(0);
  });
});

describe('cost that is not known', () => {
  it('is reported as unknown, never as zero', async () => {
    const world = await start();
    const { kit } = world;
    const session = await kit.session(kit.owner);

    // Nothing ran yet: there is nothing to price.
    const empty = await world.report(kit.owner);
    expect(empty.totals.cost).toEqual({ usd: null, coverage: 'none', pricedRuns: 0, unpricedRuns: 0 });
    expect(empty.lastRecordedAt).toBeNull();
    expect(empty.byAgent.rows).toEqual([]);

    await world.run(kit.owner, session.id, [{ input: 900, output: 100 }]);
    await world.run(kit.owner, session.id, [{ input: 50, output: 50 }]);
    const unknown = await world.report(kit.owner);
    expect(unknown.totals.totalTokens).toBe(1100);
    expect(unknown.totals.cost).toEqual({ usd: null, coverage: 'unknown', pricedRuns: 0, unpricedRuns: 2 });
    expect(unknown.buckets.at(-1)!.cost.usd).toBeNull();
    expect(unknown.byModel.rows[0]!.cost).toEqual({ usd: null, coverage: 'unknown', pricedRuns: 0, unpricedRuns: 2 });

    // A cost of nought that the agent did report is a cost: it is known.
    await world.run(kit.owner, session.id, [{ input: 10, cost: 0 }]);
    expect((await world.report(kit.owner)).totals.cost).toEqual({ usd: 0, coverage: 'partial', pricedRuns: 1, unpricedRuns: 2 });
  });

  it('is complete when every run has one', async () => {
    const world = await start();
    const session = await world.kit.session(world.kit.owner);
    await world.run(world.kit.owner, session.id, [{ input: 10, cost: 0.25 }]);
    await world.run(world.kit.owner, session.id, [{ input: 10, cost: 0.5 }, { input: 5, cost: 0.125 }]);
    expect((await world.report(world.kit.owner)).totals.cost).toEqual({ usd: 0.875, coverage: 'complete', pricedRuns: 2, unpricedRuns: 0 });
  });
});

describe('days, weeks and months in the zone the client names', () => {
  /** Three runs around the end of March 2026, seen from a clock that stands at noon UTC on 2 April. */
  async function marchIntoApril() {
    const world = await start();
    const { kit } = world;
    const session = await kit.session(kit.owner);
    const first = await world.run(kit.owner, session.id, [{ input: 100 }]);
    const second = await world.run(kit.owner, session.id, [{ input: 200 }]);
    const third = await world.run(kit.owner, session.id, [{ input: 400 }]);
    world.place(first.id, '2026-03-31T22:00:00Z');
    world.place(second.id, '2026-04-01T02:00:00Z');
    world.place(third.id, '2026-04-01T18:00:00Z');
    world.clock.set('2026-04-02T12:00:00Z');
    return world;
  }

  it('cuts days at the midnight of that zone', async () => {
    const world = await marchIntoApril();
    const { owner } = world.kit;
    const days = 'period=day&from=2026-03-31&to=2026-04-02';

    const utc = await world.report(owner, days);
    expect(byKey(utc.buckets)).toEqual({ '2026-03-31': 100, '2026-04-01': 600, '2026-04-02': 0 });
    expect(utc.buckets.map((bucket) => bucket.current)).toEqual([false, false, true]);
    expect(utc).toMatchObject({ from: '2026-03-31', to: '2026-04-02', start: Date.parse('2026-03-31T00:00:00Z'), end: Date.parse('2026-04-03T00:00:00Z') });

    // Shanghai is eight hours ahead: ten at night UTC is already the next morning there.
    const shanghai = await world.report(owner, `${days}&timeZone=Asia/Shanghai`);
    expect(byKey(shanghai.buckets)).toEqual({ '2026-03-31': 0, '2026-04-01': 300, '2026-04-02': 400 });
    expect(shanghai.timeZone).toBe('Asia/Shanghai');
    expect(shanghai.start).toBe(Date.parse('2026-03-30T16:00:00Z'));

    // Los Angeles is seven hours behind: two in the morning UTC is still the evening before.
    const losAngeles = await world.report(owner, `${days}&timeZone=America/Los_Angeles`);
    expect(byKey(losAngeles.buckets)).toEqual({ '2026-03-31': 300, '2026-04-01': 400, '2026-04-02': 0 });

    // One named day is that day in that zone, and nothing else.
    expect((await world.report(owner, 'from=2026-04-01&to=2026-04-01')).totals.totalTokens).toBe(600);
    expect((await world.report(owner, 'from=2026-04-01&to=2026-04-01&timeZone=Asia/Shanghai')).totals.totalTokens).toBe(300);
    expect((await world.report(owner, 'from=2026-04-01&to=2026-04-01&timeZone=America/Los_Angeles')).totals.totalTokens).toBe(400);
  });

  it('puts usage at a month end into the month it has in that zone', async () => {
    const world = await marchIntoApril();
    const { owner } = world.kit;
    const months = 'period=month&from=2026-03-15&to=2026-04-15';
    expect(byKey((await world.report(owner, months)).buckets)).toEqual({ '2026-03': 100, '2026-04': 600 });
    expect(byKey((await world.report(owner, `${months}&timeZone=Asia/Shanghai`)).buckets)).toEqual({ '2026-03': 0, '2026-04': 700 });
    expect(byKey((await world.report(owner, `${months}&timeZone=America/Los_Angeles`)).buckets)).toEqual({ '2026-03': 300, '2026-04': 400 });
    const report = await world.report(owner, months);
    expect([report.from, report.to]).toEqual(['2026-03-01', '2026-04-30']);
    expect(report.buckets.map((bucket) => bucket.current)).toEqual([false, true]);
  });

  it('returns twelve weeks without gaps, this week last and equal to the sum of its days', async () => {
    const world = await marchIntoApril();
    const { owner, project } = world.kit;
    // 31 March 2026 is a Tuesday: all three days lie in the week that starts on Monday the 30th.
    const weeks = await world.report(owner, 'period=week');
    expect(weeks.buckets).toHaveLength(12);
    for (let index = 1; index < weeks.buckets.length; index += 1) expect(weeks.buckets[index]!.start).toBe(weeks.buckets[index - 1]!.end);
    const thisWeek = weeks.buckets.at(-1)!;
    expect(thisWeek).toMatchObject({ key: '2026-03-30', current: true, totalTokens: 700, runs: 3 });
    expect(weeks.buckets.slice(0, -1).every((bucket) => bucket.totalTokens === 0)).toBe(true);
    const days = await world.report(owner, 'period=day&from=2026-03-30&to=2026-04-05');
    expect(days.buckets.reduce((sum, bucket) => sum + bucket.totalTokens, 0)).toBe(thisWeek.totalTokens);
    expect(weeks.byModel.rows.map((row) => [row.model, row.totalTokens])).toEqual([['scripted-large', 700]]);
    expect(weeks.byProject.rows.map((row) => [row.projectId, row.totalTokens])).toEqual([[project.id, 700]]);
  });

  it('refuses a zone, a date or a range it cannot work with', async () => {
    const world = await start();
    const { owner } = world.kit;
    const get = (query: string) => owner.get(`/api/usage/report?${query}`);
    expect((await get('timeZone=Mars/Olympus_Mons')).status).toBe(400);
    expect((await get('timeZone=')).status).toBe(400);
    expect((await get('period=fortnight')).status).toBe(400);
    expect((await get('from=2026-02-30')).status).toBe(400);
    expect((await get('from=yesterday')).status).toBe(400);
    expect((await get('from=2026-04-02&to=2026-04-01')).status).toBe(400);
    expect((await get('scope=everyone')).status).toBe(400);
    expect((await get('userId=not-an-id')).status).toBe(400);
    expect((await get('projectId=../../etc')).status).toBe(400);
    expect(errorOf(await get('period=day&from=2024-01-01&to=2026-01-01'))).toEqual([400, 'range_too_long']);
    expect(errorOf(await get('period=month&from=2019-01-01&to=2026-01-01'))).toEqual([400, 'range_too_long']);
    // The longest ranges that are allowed work.
    expect((await get('period=day&from=2025-04-03&to=2026-04-02')).status).toBe(200);
    expect((await get('period=week&from=2024-04-01&to=2026-04-02')).status).toBe(200);
    expect((await get('period=month&from=2021-05-01&to=2026-04-02')).status).toBe(200);
  });
});

describe('whose usage a caller may see', () => {
  async function ownerAndMember() {
    const world = await start();
    const { kit } = world;
    const { owner, project } = kit;
    const member = await kit.t.member();
    await kit.share(project, member, 'write');
    const mine = await kit.session(owner, { title: 'The owner writes a secret memo' });
    const theirs = await kit.session(member, { title: 'The member plans a surprise' });
    await world.run(owner, mine.id, [{ input: 70, cost: 0.07 }]);
    await world.run(member, theirs.id, [{ input: 30, cost: 0.03 }]);
    return { world, kit, owner, member, project: project as Project };
  }

  it('shows a member their own usage and nobody else\'s', async () => {
    const { world, owner, member } = await ownerAndMember();
    const report = await world.report(member);
    expect(report.totals).toMatchObject({ totalTokens: 30, runs: 1, sessions: 1 });
    expect(report).toMatchObject({ scope: 'mine', userId: member.userId, byUser: null });
    // Naming yourself is fine; naming anyone else, or everybody, is the owner's alone.
    expect((await world.report(member, `userId=${member.userId}`)).totals.totalTokens).toBe(30);
    expect(errorOf(await member.get('/api/usage/report?scope=all'))).toEqual([403, 'owner_required']);
    expect(errorOf(await member.get(`/api/usage/report?userId=${owner.userId}`))).toEqual([403, 'owner_required']);
    expect(errorOf(await member.get(`/api/usage/report?scope=all&userId=${member.userId}`))).toEqual([403, 'owner_required']);
  });

  it('shows the owner their own by default, and everybody\'s per user when asked', async () => {
    const { world, owner, member, project } = await ownerAndMember();
    expect((await world.report(owner)).totals.totalTokens).toBe(70);

    const all = await world.report(owner, 'scope=all');
    expect(all.totals).toMatchObject({ totalTokens: 100, runs: 2, sessions: 2 });
    expect(all.totals.cost).toEqual({ usd: 0.1, coverage: 'complete', pricedRuns: 2, unpricedRuns: 0 });
    expect(all).toMatchObject({ scope: 'all', userId: null });
    expect(all.byUser!.rows.map((row) => [row.userId, row.username, row.totalTokens, row.runs])).toEqual([
      [owner.userId, 'owner', 70, 1],
      [member.userId, 'member1', 30, 1],
    ]);
    // Per user, in total — and nothing that says what anybody talked about.
    const text = JSON.stringify(all);
    expect(text).not.toContain('surprise');
    expect(text).not.toContain('secret memo');

    const one = await world.report(owner, `userId=${member.userId}`);
    expect(one.totals.totalTokens).toBe(30);
    expect(one).toMatchObject({ userId: member.userId, byUser: null });
    // A project's total is everybody's work in it.
    expect((await world.report(owner, `scope=all&projectId=${project.id}`)).totals.totalTokens).toBe(100);
    expect((await world.report(owner, `projectId=${project.id}`)).totals.totalTokens).toBe(70);
  });

  it('keeps counting a member\'s usage in a project they can no longer see, without naming the project', async () => {
    const { world, kit, member, project } = await ownerAndMember();
    const before = await world.report(member);
    expect(before.byProject.rows.map((row) => [row.kind, row.projectId, row.projectName])).toEqual([['project', project.id, 'demo']]);

    await kit.share(project, member, null);
    const after = await world.report(member);
    expect(after.totals.totalTokens).toBe(30);
    expect(after.byProject.rows).toHaveLength(1);
    expect(after.byProject.rows[0]).toMatchObject({ kind: 'unavailable', projectId: null, projectName: null, totalTokens: 30, runs: 1 });
    const text = JSON.stringify(after);
    expect(text).not.toContain(project.id);
    expect(text).not.toContain('demo');
    // Asking for the project by id answers like a project that does not exist.
    expect(errorOf(await member.get(`/api/usage/report?projectId=${project.id}`))).toEqual([404, 'project_not_found']);
  });

  it('answers 404 for a project the caller was never in', async () => {
    const { kit, member } = await ownerAndMember();
    const hidden = await kit.makeProject('hidden');
    expect(errorOf(await member.get(`/api/usage/report?projectId=${hidden.id}`))).toEqual([404, 'project_not_found']);
  });

  it('adds up usage outside any project and in removed projects in rows of their own', async () => {
    const world = await start();
    const { kit } = world;
    const { owner } = kit;
    const gone = await kit.makeProject('short-lived');
    const session = (await owner.post<Session>('/api/sessions', { projectId: gone.id, agentId: 'scripted' })).body;
    const run = await world.run(owner, session.id, [{ input: 55 }]);
    const kept = await kit.session(owner);
    const outside = await world.run(owner, kept.id, [{ input: 5 }]);
    // A conversation with an API model may have no project: its records carry none.
    kit.t.studio.context.db.run('UPDATE agent_usage SET project_id = NULL WHERE run_id = ?', outside.id);
    expect((await owner.delete(`/api/projects/${gone.id}`)).status).toBe(204);

    const report = await world.report(owner);
    // The record of what was spent outlives the project.
    expect(report.totals.totalTokens).toBe(60);
    expect(report.byProject.rows.map((row) => [row.kind, row.projectId, row.totalTokens])).toEqual([
      ['none', null, 5],
      ['unavailable', null, 55],
    ]);
    expect(JSON.stringify(report)).not.toContain(gone.id);
    expect(run.status).toBe('completed');
  });

  it('needs a signed-in caller, and a token with the right scope', async () => {
    const world = await start();
    const { kit } = world;
    const anonymous = kit.t.anonymous();
    for (const url of ['/api/usage/report', '/api/usage/summary', '/api/usage/quota', '/api/usage/providers', '/api/usage/budgets']) {
      expect((await anonymous.get(url)).status, url).toBe(401);
    }
    expect((await anonymous.post('/api/usage/budgets', { metric: 'tokens', amount: 10 })).status).toBe(401);

    const reader = await world.token(kit.owner, ['read']);
    expect((await reader.get('/api/usage/report')).status).toBe(200);
    expect((await reader.get('/api/usage/quota')).status).toBe(200);
    expect(errorOf(await reader.post('/api/usage/budgets', { metric: 'tokens', amount: 10 }))).toEqual([403, 'insufficient_scope']);
    const writer = await world.token(kit.owner, ['read', 'write']);
    expect((await writer.post('/api/usage/budgets', { metric: 'tokens', amount: 10 })).status).toBe(201);
    // A token of a member is a member: no more than their own usage.
    const member = await kit.t.member();
    const memberToken = await world.token(member, ['read']);
    expect(errorOf(await memberToken.get('/api/usage/report?scope=all'))).toEqual([403, 'owner_required']);
  });
});

describe('breakdowns with many rows', () => {
  it('shows the largest and adds the rest up, without counting a run twice', async () => {
    const world = await start();
    const { kit } = world;
    const session = await kit.session(kit.owner);
    // One run that used sixty models: the breakdown shows fifty and sums ten.
    const run = await world.run(kit.owner, session.id, Array.from({ length: 60 }, (_unused, index) => ({ model: `model-${String(index).padStart(2, '0')}`, input: 1000 - index })));
    const report = await world.report(kit.owner);
    expect(report.byModel.rows).toHaveLength(50);
    expect(report.byModel.rows[0]).toMatchObject({ model: 'model-00', totalTokens: 1000 });
    expect(report.byModel.rows[49]).toMatchObject({ model: 'model-49', totalTokens: 951 });
    const rest = Array.from({ length: 10 }, (_unused, index) => 1000 - (50 + index)).reduce((sum, value) => sum + value, 0);
    // The ten models left over belong to the same single run.
    expect(report.byModel.others).toMatchObject({ count: 10, totalTokens: rest, runs: 1, sessions: 1 });
    expect(report.totals.runs).toBe(1);
    expect(run.status).toBe('completed');
  });
});
