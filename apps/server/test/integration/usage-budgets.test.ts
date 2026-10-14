import type { Budget, BudgetThresholdEvent, Provider, ProviderUsage, Session } from '@agent-studio/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeOpenAI } from '../../src/modules/providers/testing/fake-openai.js';
import { TEST_KEY, TEST_MODELS } from '../../src/modules/providers/testing/providers-kit.js';
import { type UsageWorld, createUsageWorlds, errorOf } from '../../src/modules/usage/testing/kit.js';
import type { TestClient } from '../../src/testing/harness.js';
import { ScriptedAdapter } from '../../src/testing/scripted-adapter.js';

const worlds = createUsageWorlds();
const start = worlds.start;
const models: FakeOpenAI[] = [];
afterEach(async () => {
  await worlds.closeAll();
  for (const model of models.splice(0)) await model.close();
});

const budgetsOf = async (client: TestClient): Promise<Budget[]> => (await client.get<{ budgets: Budget[] }>('/api/usage/budgets')).body.budgets;
const thresholds = (world: UsageWorld): BudgetThresholdEvent[] => world.internal.filter((event) => event.type === 'budget.threshold').map((event) => event.data as BudgetThresholdEvent);

describe('budgets', () => {
  it('shows this month\'s progress and announces each threshold exactly once', async () => {
    const world = await start();
    const { kit } = world;
    const { owner } = kit;
    const session = await kit.session(owner);
    const created = await owner.post<Budget>('/api/usage/budgets', { metric: 'tokens', amount: 1000 });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ agentId: null, agentName: null, metric: 'tokens', amount: 1000, timeZone: 'UTC', used: 0, fraction: 0, state: 'ok', announcedThreshold: 0, unpricedRuns: 0 });
    const id = created.body.id;
    const step = async (tokens: number) => {
      await world.run(owner, session.id, [{ input: tokens }]);
      return (await budgetsOf(owner))[0]!;
    };

    expect(await step(500)).toMatchObject({ used: 500, fraction: 0.5, state: 'ok', announcedThreshold: 0 });
    expect(thresholds(world)).toEqual([]);

    // 850 of 1000: the first mark.
    expect(await step(350)).toMatchObject({ used: 850, fraction: 0.85, state: 'warning', announcedThreshold: 80 });
    expect(thresholds(world)).toHaveLength(1);
    expect(thresholds(world)[0]).toMatchObject({ budgetId: id, userId: owner.userId, agentId: null, metric: 'tokens', amount: 1000, used: 850, fraction: 0.85, threshold: 80, timeZone: 'UTC' });
    expect(thresholds(world)[0]!.month).toMatch(/^\d{4}-\d{2}$/);

    // More usage below the next mark says nothing again.
    expect(await step(50)).toMatchObject({ used: 900, state: 'warning', announcedThreshold: 80 });
    expect(thresholds(world)).toHaveLength(1);

    // Over the amount: the second mark, once.
    expect(await step(200)).toMatchObject({ used: 1100, fraction: 1.1, state: 'exceeded', announcedThreshold: 100 });
    expect(thresholds(world).map((event) => event.threshold)).toEqual([80, 100]);
    expect(await step(400)).toMatchObject({ used: 1500, state: 'exceeded', announcedThreshold: 100 });
    expect(thresholds(world).map((event) => event.threshold)).toEqual([80, 100]);

    // The person hears of it on their own devices too — and of nothing else.
    const told = kit.userEvents(owner.userId, 'usage.budget.changed').map((event) => event.data as { change: string; threshold: number | null; budget: Budget | null });
    expect(told.map((event) => [event.change, event.threshold])).toEqual([['created', null], ['threshold', 80], ['threshold', 100]]);
    expect(told[1]!.budget).toMatchObject({ id, state: 'warning', announcedThreshold: 80, used: 850 });
  });

  it('never stops a run: an exceeded budget only informs', async () => {
    const world = await start();
    const { kit } = world;
    const session = await kit.session(kit.owner);
    await kit.owner.post('/api/usage/budgets', { metric: 'tokens', amount: 10 });
    const first = await world.run(kit.owner, session.id, [{ input: 5000 }]);
    const second = await world.run(kit.owner, session.id, [{ input: 5000 }]);
    expect([first.status, second.status]).toEqual(['completed', 'completed']);
    expect((await budgetsOf(kit.owner))[0]).toMatchObject({ used: 10_000, fraction: 1000, state: 'exceeded' });
    // Both marks were passed in one step: one announcement, of the higher.
    expect(thresholds(world).map((event) => event.threshold)).toEqual([100]);
  });

  it('counts one agent, or everything, and money where runs have a cost', async () => {
    const second = new ScriptedAdapter({ id: 'second', displayName: 'Second agent' });
    const world = await start({ kit: { adapters: [new ScriptedAdapter(), second] } });
    const { kit } = world;
    const { owner } = kit;
    const first = await kit.session(owner);
    const other = await kit.session(owner, { agentId: 'second' });
    const post = (body: Record<string, unknown>) => owner.post<Budget>('/api/usage/budgets', body);
    const overall = (await post({ metric: 'tokens', amount: 10_000 })).body;
    const scripted = (await post({ agentId: 'scripted', metric: 'tokens', amount: 1000 })).body;
    const money = (await post({ agentId: 'second', metric: 'cost', amount: 2 })).body;
    expect(scripted).toMatchObject({ agentId: 'scripted', agentName: 'Scripted agent' });

    await world.run(owner, first.id, [{ input: 600, cost: 9 }]);
    await world.run(owner, other.id, [{ input: 300, cost: 1.25 }], second);
    await world.run(owner, other.id, [{ input: 100 }], second); // no cost reported

    const byId = new Map((await budgetsOf(owner)).map((budget) => [budget.id, budget]));
    expect(byId.get(overall.id)).toMatchObject({ used: 1000, fraction: 0.1, state: 'ok' });
    expect(byId.get(scripted.id)).toMatchObject({ used: 600, fraction: 0.6, state: 'ok' });
    // 1.25 of 2 dollars is known; one run has no cost, so that is a lower bound — and says so.
    expect(byId.get(money.id)).toMatchObject({ used: 1.25, fraction: 0.625, state: 'ok', unpricedRuns: 1 });
    expect(thresholds(world)).toEqual([]);

    await world.run(owner, other.id, [{ input: 1, cost: 0.5 }], second);
    expect(thresholds(world).map((event) => [event.budgetId, event.agentId, event.metric, event.threshold, event.used])).toEqual([[money.id, 'second', 'cost', 80, 1.75]]);
  });

  it('starts from where usage stands when a budget is made or changed, and afresh each month', async () => {
    const world = await start();
    const { kit } = world;
    const { owner } = kit;
    world.clock.set('2026-10-20T10:00:00Z');
    const session = await kit.session(owner);
    const spend = async (tokens: number, at: string) => {
      const run = await world.run(owner, session.id, [{ input: tokens }]);
      world.place(run.id, at);
      // Placing the record is the test's doing; the next run's end is what looks at the budgets.
      return run;
    };
    await spend(900, '2026-10-05T10:00:00Z');

    // 90 % already: the person has just seen that, so only 100 % is news.
    const budget = (await owner.post<Budget>('/api/usage/budgets', { metric: 'tokens', amount: 1000 })).body;
    expect(budget).toMatchObject({ month: '2026-10', used: 900, state: 'warning', announcedThreshold: 80, monthStart: Date.parse('2026-10-01T00:00:00Z'), monthEnd: Date.parse('2026-11-01T00:00:00Z') });
    await spend(1, '2026-10-06T10:00:00Z');
    await world.run(owner, session.id, []);
    expect(thresholds(world)).toEqual([]);

    // Doubling the amount takes it back under the first mark; passing that mark again is news again.
    const raised = (await owner.patch<Budget>(`/api/usage/budgets/${budget.id}`, { amount: 2000 })).body;
    expect(raised).toMatchObject({ amount: 2000, used: 901, state: 'ok', announcedThreshold: 0 });
    await spend(800, '2026-10-07T10:00:00Z');
    await world.run(owner, session.id, []);
    expect(thresholds(world).map((event) => [event.threshold, event.month, event.used])).toEqual([[80, '2026-10', 1701]]);

    // A new month: nothing used, nothing announced.
    world.clock.set('2026-11-03T10:00:00Z');
    expect((await budgetsOf(owner))[0]).toMatchObject({ month: '2026-11', used: 0, fraction: 0, state: 'ok', announcedThreshold: 0 });
    await spend(1900, '2026-11-02T10:00:00Z');
    await world.run(owner, session.id, []);
    expect(thresholds(world).map((event) => [event.threshold, event.month])).toEqual([[80, '2026-10'], [80, '2026-11']]);

    // The month is cut in the budget's own zone: November starts at three in the afternoon UTC of 31 October in Tokyo.
    const tokyo = (await owner.patch<Budget>(`/api/usage/budgets/${budget.id}`, { timeZone: 'Asia/Tokyo' })).body;
    expect(tokyo).toMatchObject({ timeZone: 'Asia/Tokyo', month: '2026-11', monthStart: Date.parse('2026-10-31T15:00:00Z') });
  });

  it('belongs to its user: nobody else can see, change or remove it', async () => {
    const world = await start();
    const { kit } = world;
    const { owner } = kit;
    const member = await kit.t.member();
    const mine = (await member.post<Budget>('/api/usage/budgets', { metric: 'tokens', amount: 500 })).body;
    expect(await budgetsOf(owner)).toEqual([]);
    // Not even the owner of the Studio: a budget is a person's own mark.
    expect(errorOf(await owner.patch(`/api/usage/budgets/${mine.id}`, { amount: 1 }))).toEqual([404, 'budget_not_found']);
    expect(errorOf(await owner.delete(`/api/usage/budgets/${mine.id}`))).toEqual([404, 'budget_not_found']);
    expect((await budgetsOf(member)).map((budget) => budget.amount)).toEqual([500]);

    // Somebody else's usage does not move it.
    const session = await kit.session(owner);
    await world.run(owner, session.id, [{ input: 5000 }]);
    expect((await budgetsOf(member))[0]).toMatchObject({ used: 0, state: 'ok' });
    expect(thresholds(world)).toEqual([]);
    expect(kit.userEvents(owner.userId, 'usage.budget.changed')).toEqual([]);

    expect((await member.delete(`/api/usage/budgets/${mine.id}`)).status).toBe(204);
    expect(await budgetsOf(member)).toEqual([]);
    expect(errorOf(await member.delete(`/api/usage/budgets/${mine.id}`))).toEqual([404, 'budget_not_found']);
    expect(kit.userEvents(member.userId, 'usage.budget.changed').map((event) => (event.data as { change: string }).change)).toEqual(['created', 'removed']);
  });

  it('refuses what is not a budget', async () => {
    const world = await start();
    const { owner } = world.kit;
    const post = (body: unknown) => owner.post('/api/usage/budgets', body);
    expect((await post({ metric: 'tokens', amount: 1000 })).status).toBe(201);
    expect(errorOf(await post({ metric: 'tokens', amount: 5 }))).toEqual([409, 'budget_exists']);
    expect((await post({ metric: 'cost', amount: 5 })).status).toBe(201);
    expect(errorOf(await post({ agentId: 'no-such-agent', metric: 'tokens', amount: 5 }))).toEqual([422, 'agent_unavailable']);
    for (const body of [
      {},
      { metric: 'tokens' },
      { metric: 'tokens', amount: 0 },
      { metric: 'tokens', amount: -5 },
      { metric: 'tokens', amount: 'lots' },
      { metric: 'hours', amount: 5 },
      { metric: 'tokens', amount: 5, timeZone: 'Mars/Phobos' },
      { metric: 'tokens', amount: 5, blocking: true },
      { metric: 'tokens', amount: 5, userId: owner.userId },
    ]) {
      expect((await post(body)).status, JSON.stringify(body)).toBe(400);
    }
    const [first] = await budgetsOf(owner);
    expect((await owner.patch(`/api/usage/budgets/${first!.id}`, {})).status).toBe(400);
    expect((await owner.patch(`/api/usage/budgets/${first!.id}`, { amount: 0 })).status).toBe(400);
    expect((await owner.patch(`/api/usage/budgets/${first!.id}`, { metric: 'cost' })).status).toBe(400);
    expect((await owner.patch('/api/usage/budgets/not-an-id', { amount: 5 })).status).toBe(400);

    // One budget per agent and metric, besides the two over everything.
    const agents = ['scripted', 'claude-code', 'codex'];
    let made = 2;
    for (const agentId of agents) {
      for (const metric of ['tokens', 'cost']) {
        expect((await post({ agentId, metric, amount: 1 })).status).toBe(201);
        made += 1;
      }
    }
    expect(made).toBe(8);
    expect(await budgetsOf(owner)).toHaveLength(8);
  });
});

describe('API providers: balance, noted amount, estimate', () => {
  async function withProvider() {
    const model = await FakeOpenAI.start();
    models.push(model);
    const world = await start();
    const { kit } = world;
    const created = await kit.owner.post<Provider>('/api/providers', {
      id: 'fake',
      name: 'Fake provider',
      baseUrl: model.url,
      allowPrivateNetwork: true,
      models: TEST_MODELS,
      defaultModel: 'fake-model',
      apiKey: TEST_KEY,
      balance: 'deepseek',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const chat = async (client: TestClient, usage: { prompt_tokens: number; completion_tokens: number }, modelId = 'fake-model') => {
      const session = (await client.post<Session>('/api/sessions', { projectId: kit.project.id, agentId: 'api-fake', model: modelId })).body;
      model.script({ text: 'answer', usage });
      return kit.turn(client, session.id, 'a question');
    };
    const usageOf = async (client: TestClient): Promise<ProviderUsage> => (await client.get<{ providers: ProviderUsage[] }>('/api/usage/providers')).body.providers[0]!;
    return { world, kit, model, chat, usageOf };
  }

  it('estimates what is left from a noted amount minus what was spent since', async () => {
    const { world, kit, chat, usageOf } = await withProvider();
    const { owner } = kit;
    // Spent before the note: not counted against it.
    await chat(owner, { prompt_tokens: 500_000, completion_tokens: 0 });
    expect(await usageOf(owner)).toEqual({ providerId: 'fake', agentId: 'api-fake', name: 'Fake provider', spendScope: 'everyone', note: null, estimate: null, balance: null });

    const noted = await owner.put<ProviderUsage>('/api/usage/providers/fake/note', { amount: 25 });
    expect(noted.status).toBe(200);
    expect(noted.body.note).toMatchObject({ amount: 25, currency: 'USD' });
    expect(noted.body.estimate).toMatchObject({ spentUsd: null, runs: 0, unpricedRuns: 0, remaining: 25 });

    // Two answers at list prices: 100k input tokens at $1 a million, 25k output tokens at $2 a million.
    await chat(owner, { prompt_tokens: 100_000, completion_tokens: 0 });
    await chat(owner, { prompt_tokens: 0, completion_tokens: 25_000 });
    const after = await usageOf(owner);
    expect(after.estimate).toMatchObject({ spentUsd: 0.15, runs: 2, unpricedRuns: 0, remaining: 24.85 });
    expect(after.estimate!.caveat).toContain('estimate');

    // A model without a price: the run is counted, and the estimate says it is too high.
    await chat(owner, { prompt_tokens: 1000, completion_tokens: 1000 }, 'fake-plain');
    const unpriced = await usageOf(owner);
    expect(unpriced.estimate).toMatchObject({ spentUsd: 0.15, runs: 3, unpricedRuns: 1, remaining: 24.85 });
    expect(unpriced.estimate!.caveat).toContain('1 run since the note has no price');

    // Clearing the note removes the estimate.
    expect((await owner.delete('/api/usage/providers/fake/note')).status).toBe(204);
    expect(await usageOf(owner)).toMatchObject({ note: null, estimate: null });
    expect((await owner.delete('/api/usage/providers/fake/note')).status).toBe(204);
    expect(kit.userEvents(owner.userId, 'usage.provider-note.changed').map((event) => (event.data as { note: unknown }).note === null)).toEqual([false, true]);
    expect(world.internal).toEqual([]);
  });

  it('counts from the day the note names, and works out nothing for a note in another currency', async () => {
    const { world, kit, chat, usageOf } = await withProvider();
    const { owner } = kit;
    world.clock.set('2026-10-14T12:00:00Z');
    const early = await chat(owner, { prompt_tokens: 1_000_000, completion_tokens: 0 });
    const late = await chat(owner, { prompt_tokens: 2_000_000, completion_tokens: 0 });
    world.place(early.id, '2026-10-02T09:00:00Z');
    world.place(late.id, '2026-10-05T09:00:00Z');

    // "I topped up 20 on the 3rd."
    const put = (body: Record<string, unknown>) => owner.put<ProviderUsage>('/api/usage/providers/fake/note', body);
    expect((await put({ amount: 20, notedAt: Date.parse('2026-10-03T00:00:00Z') })).body.estimate).toMatchObject({ spentUsd: 2, runs: 1, remaining: 18 });
    expect((await put({ amount: 20, notedAt: Date.parse('2026-10-01T00:00:00Z') })).body.estimate).toMatchObject({ spentUsd: 3, runs: 2, remaining: 17 });
    // More was spent than was noted: the estimate says so rather than stopping at nought.
    expect((await put({ amount: 1, notedAt: Date.parse('2026-10-01T00:00:00Z') })).body.estimate).toMatchObject({ spentUsd: 3, remaining: -2 });

    const yuan = (await put({ amount: 150, currency: 'CNY', notedAt: Date.parse('2026-10-01T00:00:00Z') })).body;
    expect(yuan.note).toMatchObject({ amount: 150, currency: 'CNY', notedAt: Date.parse('2026-10-01T00:00:00Z') });
    expect(yuan.estimate).toMatchObject({ spentUsd: 3, remaining: null });
    expect(yuan.estimate!.caveat).toContain('The note is in CNY');
    expect(await usageOf(owner)).toMatchObject({ note: { currency: 'CNY' } });

    expect(errorOf(await put({ amount: 5, notedAt: Date.parse('2026-10-15T12:00:00Z') }))).toEqual([400, 'noted_in_future']);
    for (const body of [{}, { amount: -1 }, { amount: 'ten' }, { amount: 5, currency: 'dollars' }, { amount: 5, currency: 'usd' }, { amount: 5, notedAt: -1 }, { amount: 5, spent: 1 }]) {
      expect((await put(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(errorOf(await owner.put('/api/usage/providers/nope/note', { amount: 5 }))).toEqual([404, 'provider_not_found']);
    expect((await owner.put('/api/usage/providers/Bad_Id!/note', { amount: 5 })).status).toBe(400);
  });

  it('gives the owner the balance the provider reports, and a member their own figures only', async () => {
    const { kit, model, chat, usageOf } = await withProvider();
    const { owner } = kit;
    const member = await kit.t.member();
    await kit.share(kit.project, member, 'write');
    model.balance = { is_available: true, balance_infos: [{ currency: 'USD', total_balance: '19.80', granted_balance: '0.00', topped_up_balance: '19.80' }] };

    await member.put('/api/usage/providers/fake/note', { amount: 10 });
    await owner.put('/api/usage/providers/fake/note', { amount: 25 });
    await chat(owner, { prompt_tokens: 100_000, completion_tokens: 0 });
    await chat(member, { prompt_tokens: 0, completion_tokens: 25_000 });

    // The balance belongs to the one key everybody uses: the owner's estimate counts everybody's runs.
    const owners = (await owner.get<ProviderUsage>('/api/usage/providers/fake')).body;
    expect(owners).toMatchObject({ spendScope: 'everyone', note: { amount: 25 }, estimate: { spentUsd: 0.15, runs: 2, remaining: 24.85 } });
    expect(owners.balance).toMatchObject({ available: true, code: 'ok', sufficient: true, balances: [{ currency: 'USD', total: '19.80' }] });
    expect(model.requests.filter((request) => request.path === '/user/balance')).toHaveLength(1);
    // The list asks the provider nothing.
    expect((await usageOf(owner)).balance).toBeNull();
    expect(model.requests.filter((request) => request.path === '/user/balance')).toHaveLength(1);

    // A member: their own note, their own spend, and no balance — reading it uses the provider's key.
    const members = (await member.get<ProviderUsage>('/api/usage/providers/fake')).body;
    expect(members).toMatchObject({ spendScope: 'own', note: { amount: 10 }, estimate: { spentUsd: 0.05, runs: 1, remaining: 9.95 }, balance: null });
    expect(members.estimate!.caveat).toContain('only your own runs');
    expect(model.requests.filter((request) => request.path === '/user/balance')).toHaveLength(1);
    expect(JSON.stringify(members)).not.toContain(TEST_KEY);
    expect(JSON.stringify(owners)).not.toContain(TEST_KEY);

    expect(errorOf(await owner.get('/api/usage/providers/nope'))).toEqual([404, 'provider_not_found']);
    expect((await kit.t.anonymous().get('/api/usage/providers/fake')).status).toBe(401);
    expect((await kit.t.anonymous().put('/api/usage/providers/fake/note', { amount: 1 })).status).toBe(401);
  });
});
