import type { Budget, Provider } from '@agent-studio/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeOpenAI } from '../../src/modules/providers/testing/fake-openai.js';
import { TEST_KEY, TEST_MODELS } from '../../src/modules/providers/testing/providers-kit.js';
import { createUsageWorlds, errorOf } from '../../src/modules/usage/testing/kit.js';
import { ScriptedAdapter } from '../../src/testing/scripted-adapter.js';

const worlds = createUsageWorlds();
const models: FakeOpenAI[] = [];
afterEach(async () => {
  await worlds.closeAll();
  for (const model of models.splice(0)) await model.close();
});

describe('optional recorded-usage request gates', () => {
  it('preserves advisory defaults, blocks before launch without recording usage, and allows disabling', async () => {
    const world = await worlds.start();
    const { kit } = world;
    const session = await kit.session();
    const budget = (
      await kit.owner.post<Budget>('/api/usage/budgets', { metric: 'tokens', amount: 10 })
    ).body;
    expect(budget.enforce).toBe(false);
    await world.run(kit.owner, session.id, [{ input: 10 }]);
    await world.run(kit.owner, session.id, [{ input: 10 }]);
    expect(
      (await kit.owner.patch<Budget>(`/api/usage/budgets/${budget.id}`, { enforce: true })).body,
    ).toMatchObject({ enforce: true, used: 20 });
    const before = (await world.report(kit.owner)).totals;
    const launches = kit.agent.runs.length;
    expect(errorOf(await kit.send(kit.owner, session.id, 'blocked'))).toEqual([
      403,
      'budget_exhausted',
    ]);
    expect(kit.agent.runs).toHaveLength(launches);
    expect((await world.report(kit.owner)).totals).toEqual(before);
    expect(
      (await kit.owner.patch<Budget>(`/api/usage/budgets/${budget.id}`, { enforce: false })).body
        .enforce,
    ).toBe(false);
    expect((await world.run(kit.owner, session.id, [{ input: 1 }])).status).toBe('completed');
  });

  it('filters by user and agent and restricts gate changes to the budget owner with write access', async () => {
    const second = new ScriptedAdapter({ id: 'second', displayName: 'Second' });
    const world = await worlds.start({ kit: { adapters: [new ScriptedAdapter(), second] } });
    const { kit } = world;
    const member = await kit.t.member();
    await kit.share(kit.project, member);
    const session = await kit.session(member);
    const budget = (
      await member.post<Budget>('/api/usage/budgets', {
        metric: 'tokens',
        agentId: 'scripted',
        amount: 5,
        enforce: true,
      })
    ).body;
    await world.run(member, session.id, [{ input: 5 }]);
    expect(errorOf(await kit.send(member, session.id, 'blocked'))).toEqual([
      403,
      'budget_exhausted',
    ]);
    // Even the instance owner cannot start work charged to another person's session.
    expect(errorOf(await kit.send(kit.owner, session.id, 'owner override'))).toEqual([
      403,
      'not_your_session',
    ]);
    expect(
      errorOf(await kit.owner.patch(`/api/usage/budgets/${budget.id}`, { enforce: false })),
    ).toEqual([404, 'budget_not_found']);
    const reader = await world.token(member, ['read']);
    expect((await reader.patch(`/api/usage/budgets/${budget.id}`, { enforce: false })).status).toBe(
      403,
    );
    expect(
      (await member.patch(`/api/usage/budgets/${budget.id}`, { enforce: 'true' })).status,
    ).toBe(400);
    const otherAgent = await kit.session(member, { agentId: second.id });
    expect((await world.run(member, otherAgent.id, [{ input: 10 }], second)).status).toBe(
      'completed',
    );
    const ownerSession = await kit.session();
    expect((await world.run(kit.owner, ownerSession.id, [{ input: 10 }])).status).toBe('completed');
    const gate = kit.t.studio.context.services.usage;
    expect(() => gate.assertRequestAllowed(member.userId!, 'scripted')).toThrow(
      /recorded monthly usage/,
    );
    expect(() => gate.assertRequestAllowed(kit.owner.userId!, 'scripted')).not.toThrow();
  });

  it('resets at the selected timezone month boundary and uses a half-open time window', async () => {
    const world = await worlds.start();
    const { kit } = world;
    const session = await kit.session();
    const recorded = await world.run(kit.owner, session.id, [{ input: 10 }]);
    world.place(recorded.id, '2026-10-31T14:59:59Z');
    world.clock.set('2026-10-31T14:59:59Z');
    const budget = (
      await kit.owner.post<Budget>('/api/usage/budgets', {
        metric: 'tokens',
        amount: 10,
        timeZone: 'Asia/Tokyo',
        enforce: true,
      })
    ).body;
    expect(budget).toMatchObject({ month: '2026-10', used: 10 });
    const gate = () =>
      kit.t.studio.context.services.usage.assertRequestAllowed(kit.owner.userId!, 'scripted');
    expect(gate).toThrow();
    world.clock.set('2026-10-31T15:00:00Z');
    expect(gate).not.toThrow();
    world.place(recorded.id, '2026-10-31T15:00:00Z');
    expect(gate).toThrow();
    world.place(recorded.id, '2026-11-30T15:00:00Z');
    expect(gate).not.toThrow();
  });

  it('exposes unpriced runs and compares raw known costs without rounding up to the limit', async () => {
    const world = await worlds.start();
    const { kit } = world;
    const session = await kit.session();
    await world.run(kit.owner, session.id, [{ input: 10 }]);
    await world.run(kit.owner, session.id, [{ input: 1, cost: 0.0000003 }]);
    const budget = (
      await kit.owner.post<Budget>('/api/usage/budgets', {
        metric: 'cost',
        amount: 0.0000004,
        enforce: true,
      })
    ).body;
    expect(budget).toMatchObject({ unpricedRuns: 1, used: 0.0000003, enforce: true });
    expect(() =>
      kit.t.studio.context.services.usage.assertRequestAllowed(kit.owner.userId!, 'scripted'),
    ).not.toThrow();
    await world.run(kit.owner, session.id, [{ input: 1, cost: 0.00000011 }]);
    expect(errorOf(await kit.send(kit.owner, session.id, 'blocked'))).toEqual([
      403,
      'budget_exhausted',
    ]);
    expect(
      (await kit.owner.patch<Budget>(`/api/usage/budgets/${budget.id}`, { amount: 1 })).body
        .enforce,
    ).toBe(true);
    expect((await world.run(kit.owner, session.id, [{ input: 1 }])).status).toBe('completed');
  });

  it('rechecks queued work after active usage reaches the limit and preserves the queued message', async () => {
    const rigid = new ScriptedAdapter({ steering: false });
    const world = await worlds.start({ kit: { adapters: [rigid] } });
    const { kit } = world;
    const session = await kit.session();
    const budget = (
      await kit.owner.post<Budget>('/api/usage/budgets', {
        metric: 'tokens',
        amount: 10,
        enforce: true,
      })
    ).body;
    rigid.script([
      { gate: 'before-usage' },
      { emit: { type: 'usage', model: 'scripted-large', inputTokens: 10, outputTokens: 0 } },
      { text: 'done' },
    ]);
    const first = await kit.send(kit.owner, session.id, 'first');
    await rigid.reached('before-usage');
    const queued = await kit.send(kit.owner, session.id, 'queued before the limit');
    expect(queued.body.disposition).toBe('queued');
    rigid.open('before-usage');
    expect((await kit.runEnded(kit.owner, first.body.runId!)).status).toBe('completed');
    const route = `/api/sessions/${session.id}/queue/${queued.body.queueItemId}/send-now`;
    expect(errorOf(await kit.owner.post(route))).toEqual([403, 'budget_exhausted']);
    expect(rigid.runs).toHaveLength(1);
    expect((await kit.state(kit.owner, session.id)).queue).toMatchObject([
      { id: queued.body.queueItemId, text: 'queued before the limit' },
    ]);
    await kit.owner.patch(`/api/usage/budgets/${budget.id}`, { enforce: false });
    expect((await kit.owner.post(route)).status).toBe(200);
  });

  it('stops a provider tool follow-up before the next network request and charges no blocked request', async () => {
    const model = await FakeOpenAI.start();
    models.push(model);
    const world = await worlds.start();
    const { kit } = world;
    const created = await kit.owner.post<Provider>('/api/providers', {
      id: 'gate-fake',
      name: 'Gate fake',
      baseUrl: model.url,
      allowPrivateNetwork: true,
      models: TEST_MODELS,
      defaultModel: 'fake-model',
      apiKey: TEST_KEY,
    });
    expect(created.status).toBe(201);
    const session = await kit.session(kit.owner, { agentId: 'api-gate-fake', model: 'fake-model' });
    await kit.owner.post('/api/usage/budgets', { metric: 'tokens', amount: 10, enforce: true });
    model.script(
      {
        toolCalls: [{ name: 'read_file', arguments: { path: 'absent.txt' } }],
        usage: { prompt_tokens: 10, completion_tokens: 0 },
      },
      { text: 'must not be requested', usage: { prompt_tokens: 1000, completion_tokens: 1000 } },
    );
    const run = await kit.turn(kit.owner, session.id, 'inspect absent.txt');
    expect(run).toMatchObject({ status: 'failed', error: { code: 'budget_exhausted' } });
    expect(model.chats).toHaveLength(1);
    const before = (await world.report(kit.owner)).totals;
    expect(before.totalTokens).toBe(10);
    expect(errorOf(await kit.send(kit.owner, session.id, 'still blocked'))).toEqual([
      403,
      'budget_exhausted',
    ]);
    expect(model.chats).toHaveLength(1);
    expect((await world.report(kit.owner)).totals).toEqual(before);
  });
});
