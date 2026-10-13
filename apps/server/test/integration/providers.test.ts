import { readFileSync, readdirSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import {
  type Agent,
  type CreatedApiToken,
  type DiscoverModelsResponse,
  PROVIDERS_CHANGED_EVENT,
  PROVIDERS_TOPIC,
  type Provider,
  type ProviderBalance,
  type ProviderPreset,
  type ProviderVerifyResult,
  type ServerFrame,
  type UpdateProviderResponse,
} from '@agent-studio/protocol';
import WebSocket from 'ws';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { StudioEvent } from '../../src/kernel/events.js';
import { type ProvidersKit, TEST_KEY, TEST_MODELS, createProvidersKit } from '../../src/modules/providers/testing/providers-kit.js';
import { until } from '../../src/testing/agents-kit.js';
import { TestClient, type TestResponse, createTestStudio } from '../../src/testing/harness.js';

type ErrorBody = { error: { code: string; message: string; details?: { reason?: string } } };

/** Every 8-character piece of the key: what "no part of it" means. */
const pieces = (key: string): string[] => Array.from({ length: key.length - 7 }, (_unused, index) => key.slice(index, index + 8));

function expectNoKey(text: string, key = TEST_KEY): void {
  for (const piece of pieces(key)) expect(text, `a piece of the key ("${piece.slice(0, 3)}…") leaked`).not.toContain(piece);
}

let kit: ProvidersKit;
let member: TestClient;
const published: StudioEvent[] = [];

beforeAll(async () => {
  kit = await createProvidersKit();
  member = await kit.t.member('mia');
  kit.t.studio.context.bus.onTopic(PROVIDERS_TOPIC, (event) => published.push(event));
});
afterAll(async () => {
  await kit.close();
});
beforeEach(async () => {
  // Every test starts without providers (there is a cap on how many can exist) and with a quiet model server.
  for (const provider of (await kit.owner.get<{ providers: Provider[] }>('/api/providers')).body.providers) await kit.owner.delete(`/api/providers/${provider.id}`);
  kit.model.reset();
  kit.model.models = ['fake-model'];
  kit.model.balance = null;
});

const agentIds = async (): Promise<string[]> => (await kit.owner.get<{ agents: Agent[] }>('/api/agents')).body.agents.map((agent) => agent.id);
const reauthAfter = (minutesAgo: number): void => {
  kit.t.studio.context.db.run('UPDATE auth_sessions SET authenticated_at = ?', Date.now() - minutesAgo * 60_000);
};

describe('provider records', () => {
  it('answers nobody who is not signed in', async () => {
    const provider = await kit.provider();
    const anonymous = kit.t.anonymous();
    const attempts: Array<Promise<TestResponse>> = [
      anonymous.get('/api/providers'),
      anonymous.get('/api/providers/presets'),
      anonymous.get(`/api/providers/${provider.id}`),
      anonymous.post('/api/providers', { name: 'x', baseUrl: 'https://example.com' }),
      anonymous.patch(`/api/providers/${provider.id}`, { name: 'x' }),
      anonymous.delete(`/api/providers/${provider.id}`),
      anonymous.put(`/api/providers/${provider.id}/key`, { apiKey: TEST_KEY }),
      anonymous.delete(`/api/providers/${provider.id}/key`),
      anonymous.post(`/api/providers/${provider.id}/verify`),
      anonymous.post(`/api/providers/${provider.id}/discover-models`),
      anonymous.get(`/api/providers/${provider.id}/balance`),
    ];
    for (const response of await Promise.all(attempts)) expect(response.status).toBe(401);
    expect(kit.model.requests).toHaveLength(0);
  });

  it('lets the owner create a provider, which becomes an agent at once', async () => {
    const created = await kit.owner.post<Provider>('/api/providers', {
      name: 'My Local LLM',
      baseUrl: `${kit.model.url}/`,
      allowPrivateNetwork: true,
      keyRequired: false,
      models: [{ id: 'llama-3', name: 'Llama 3', contextWindow: 8192, tools: true }, { id: 'old-one', name: 'Old one', hidden: true }],
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      id: 'my-local-llm',
      agentId: 'api-my-local-llm',
      name: 'My Local LLM',
      kind: 'openai-compatible',
      enabled: true,
      configured: true,
      defaultModel: 'llama-3',
      models: [{ id: 'llama-3', name: 'Llama 3', contextWindow: 8192, images: false, tools: true }],
      settings: {
        baseUrl: kit.model.url,
        allowPrivateNetwork: true,
        keyRequired: false,
        balance: 'none',
        key: { configured: false, hint: null, updatedAt: null, readable: true },
        createdBy: kit.owner.userId,
        preset: null,
        lastCheck: null,
      },
    });
    // The catalogue keeps the hidden model, with the defaults filled in.
    expect(created.body.settings!.catalogue).toEqual([
      { id: 'llama-3', name: 'Llama 3', contextWindow: 8192, images: false, tools: true, prices: null, hidden: false },
      { id: 'old-one', name: 'Old one', contextWindow: null, images: false, tools: false, prices: null, hidden: true },
    ]);

    const agent = (await kit.owner.get<Agent>('/api/agents/api-my-local-llm')).body;
    expect(agent).toMatchObject({
      id: 'api-my-local-llm',
      displayName: 'My Local LLM',
      kind: 'api',
      capabilities: {
        models: [{ id: 'llama-3', label: 'Llama 3', recommended: true, contextWindow: 8192 }],
        defaultModel: 'llama-3',
        permissionModes: ['plan', 'ask', 'accept-edits', 'auto'],
        images: false,
        steering: false,
        resume: false,
        usage: true,
      },
      status: { installed: true, signedIn: true, account: null, problem: null },
    });

    // A second provider with the same name gets its own id; an explicit id that is taken is refused.
    const twin = await kit.owner.post<Provider>('/api/providers', { name: 'My Local LLM', baseUrl: 'https://example.com/v1' });
    expect(twin.body.id).toBe('my-local-llm-2');
    const clash = await kit.owner.post<ErrorBody>('/api/providers', { id: 'my-local-llm', name: 'Again', baseUrl: 'https://example.com/v1' });
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe('provider_exists');
    // A name without Latin letters still gets a usable id.
    expect((await kit.owner.post<Provider>('/api/providers', { name: '本地模型', baseUrl: 'https://example.com/v1' })).body.id).toBe('provider');
  });

  it('shows a member what there is to pick from, and nothing about where it lives or its key', async () => {
    const provider = await kit.provider({ name: 'Shared Model' });
    const list = await member.get<{ providers: Provider[] }>('/api/providers');
    expect(list.status).toBe(200);
    const seen = list.body.providers.find((entry) => entry.id === provider.id)!;
    expect(seen).toEqual({
      id: provider.id,
      agentId: provider.agentId,
      name: 'Shared Model',
      kind: 'openai-compatible',
      enabled: true,
      configured: true,
      models: [
        { id: 'fake-model', name: 'Fake Model', contextWindow: 64_000, images: false, tools: true },
        { id: 'fake-vision', name: 'Fake Vision', contextWindow: 64_000, images: true, tools: false },
        { id: 'fake-plain', name: 'Fake Plain', contextWindow: null, images: false, tools: false },
      ],
      defaultModel: 'fake-model',
      settings: null,
    });
    for (const entry of list.body.providers) expect(entry.settings).toBeNull();
    const one = await member.get<Provider>(`/api/providers/${provider.id}`);
    expect(one.body.settings).toBeNull();
    // No address, no hint, no price anywhere in what a member receives.
    const everything = list.raw.body + one.raw.body + (await member.get('/api/agents')).raw.body;
    expect(everything).not.toContain('127.0.0.1');
    expect(everything).not.toContain(String(kit.model.port));
    expect(everything).not.toContain(TEST_KEY.slice(-4));
    expect(everything).not.toContain('cachedInput');
    expectNoKey(everything);
    expect((await member.get<ErrorBody>('/api/providers/no-such-provider')).body.error.code).toBe('provider_not_found');
  });

  it('lets a member use a provider but never manage one', async () => {
    const provider = await kit.provider();
    const refused: Array<Promise<TestResponse<ErrorBody>>> = [
      member.get('/api/providers/presets'),
      member.post('/api/providers', { name: 'Mine', baseUrl: 'https://example.com/v1' }),
      member.patch(`/api/providers/${provider.id}`, { name: 'Renamed' }),
      member.patch(`/api/providers/${provider.id}`, { baseUrl: 'https://evil.example/v1' }),
      member.delete(`/api/providers/${provider.id}`),
      member.put(`/api/providers/${provider.id}/key`, { apiKey: 'sk-attacker-0123456789abcdef' }),
      member.delete(`/api/providers/${provider.id}/key`),
      member.post(`/api/providers/${provider.id}/verify`),
      member.post(`/api/providers/${provider.id}/discover-models`),
      member.get(`/api/providers/${provider.id}/balance`),
    ];
    for (const response of await Promise.all(refused)) {
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('owner_required');
    }
    expect(kit.model.requests).toHaveLength(0);
    const after = (await kit.owner.get<Provider>(`/api/providers/${provider.id}`)).body;
    expect(after).toMatchObject({ name: provider.name, settings: { baseUrl: kit.model.url, key: { configured: true } } });

    // Using it is another matter: a member with a project can start a session with the provider's agent.
    const project = await kit.makeProject('members-own');
    await kit.share(project, member);
    const session = await kit.session(provider, member, { projectId: project.id });
    kit.model.script({ text: 'hello mia' });
    expect((await kit.turn(member, session.id, 'hi')).status).toBe('completed');
  });

  it('offers presets that fill the form, are editable, and claim nothing', async () => {
    const { presets } = (await kit.owner.get<{ presets: ProviderPreset[] }>('/api/providers/presets')).body;
    expect(presets.map((preset) => preset.id)).toEqual(['deepseek', 'openai', 'custom']);
    expect(presets.every((preset) => preset.verified === false)).toBe(true);
    const deepseek = presets[0]!;
    expect(deepseek).toMatchObject({ baseUrl: 'https://api.deepseek.com', balance: 'deepseek', keyRequired: true });

    // What the form sends is the preset, edited: nothing about a preset is fixed.
    const created = await kit.owner.post<Provider>('/api/providers', {
      preset: deepseek.id,
      name: deepseek.name,
      baseUrl: deepseek.baseUrl,
      balance: deepseek.balance,
      models: [...deepseek.models, { id: 'my-fine-tune', name: 'My fine-tune', contextWindow: 32_000 }],
      defaultModel: 'my-fine-tune',
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ id: 'deepseek', configured: false, defaultModel: 'my-fine-tune', settings: { preset: 'deepseek', balance: 'deepseek' } });
    // No key yet: the agent exists and says what is missing. Creating it contacted nobody.
    const agent = (await kit.owner.get<Agent>('/api/agents/api-deepseek')).body;
    expect(agent.status).toMatchObject({ installed: true, signedIn: false });
    expect(agent.status.problem).toContain('No API key is saved for DeepSeek');
    expect(kit.model.requests).toHaveLength(0);
    await kit.owner.delete('/api/providers/deepseek');
  });

  it('refuses records that make no sense', async () => {
    const post = (body: Record<string, unknown>) => kit.owner.post<ErrorBody>('/api/providers', { name: 'Bad', baseUrl: 'https://example.com/v1', ...body });
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ id: 'Not Valid' }, 'invalid_request'],
      [{ id: 'presets' }, 'provider_exists'],
      [{ name: '   ' }, 'invalid_request'],
      [{ kind: 'something-else' }, 'invalid_request'],
      [{ models: [{ id: 'a', name: 'A' }, { id: 'a', name: 'A again' }] }, 'invalid_models'],
      [{ models: [{ id: 'has space', name: 'x' }] }, 'invalid_request'],
      [{ models: [{ id: 'a', name: 'A' }], defaultModel: 'b' }, 'invalid_models'],
      [{ models: [{ id: 'a', name: 'A', prices: { input: -1, output: 1 } }] }, 'invalid_request'],
      [{ baseUrl: 'http://example.com/v1' }, 'insecure_url'],
      [{ baseUrl: 'https://127.0.0.1:9/v1' }, 'address_not_allowed'],
      [{ baseUrl: 'https://10.1.2.3/v1' }, 'address_not_allowed'],
      [{ baseUrl: 'https://user:pw@example.com/v1' }, 'invalid_url'],
      [{ baseUrl: 'https://example.com/v1?token=abc' }, 'invalid_url'],
      [{ baseUrl: 'ftp://example.com' }, 'invalid_url'],
      [{ baseUrl: 'http://169.254.169.254/latest', allowPrivateNetwork: true }, 'address_not_allowed'],
      [{ baseUrl: 'http://8.8.8.8/v1', allowPrivateNetwork: true }, 'insecure_url'],
      [{ apiKey: 'short' }, 'invalid_api_key'],
    ];
    const before = (await kit.owner.get<{ providers: Provider[] }>('/api/providers')).body.providers.length;
    for (const [body, code] of cases) {
      const response = await post(body);
      expect(response.status, JSON.stringify(body)).toBeGreaterThanOrEqual(400);
      expect(response.body.error.code, JSON.stringify(body)).toBe(code);
    }
    expect((await kit.owner.get<{ providers: Provider[] }>('/api/providers')).body.providers).toHaveLength(before);
  });

  it('changes a provider piece by piece', async () => {
    const provider = await kit.provider();
    const patch = (body: Record<string, unknown>) => kit.owner.patch<UpdateProviderResponse & ErrorBody>(`/api/providers/${provider.id}`, body);

    const renamed = await patch({ name: 'Renamed' });
    expect(renamed.body).toMatchObject({ keyCleared: false, provider: { name: 'Renamed', settings: { key: { configured: true } } } });
    expect((await kit.owner.get<Agent>(`/api/agents/${provider.agentId}`)).body.displayName).toBe('Renamed');

    // The catalogue is replaced as a whole; a default that is no longer listed stops being the default.
    const trimmed = await patch({ models: [{ id: 'only-one', name: 'Only one', tools: true }, { id: 'hidden-one', name: 'Hidden', hidden: true }] });
    expect(trimmed.body.provider).toMatchObject({ defaultModel: 'only-one', models: [{ id: 'only-one' }] });
    expect(trimmed.body.provider.settings!.catalogue.map((model) => model.id)).toEqual(['only-one', 'hidden-one']);
    expect((await patch({ defaultModel: 'nowhere' })).body.error.code).toBe('invalid_models');
    // A hidden model cannot be what new sessions start with.
    expect((await patch({ defaultModel: 'hidden-one' })).body.provider.defaultModel).toBe('only-one');
    expect((await kit.owner.get<Agent>(`/api/agents/${provider.agentId}`)).body.capabilities).toMatchObject({ defaultModel: 'only-one', models: [{ id: 'only-one', label: 'Only one', recommended: true }] });

    // With nothing on offer the agent says so instead of pretending.
    await patch({ models: [] });
    const empty = (await kit.owner.get<Agent>(`/api/agents/${provider.agentId}`)).body;
    expect(empty.capabilities).toMatchObject({ models: [], defaultModel: null });
    expect(empty.status.problem).toContain('offers no model yet');

    expect((await patch({ keyRequired: false, balance: 'deepseek' })).body.provider.settings).toMatchObject({ keyRequired: false, balance: 'deepseek' });
    expect((await patch({ name: '' })).status).toBe(400);
    expect((await kit.owner.patch<ErrorBody>('/api/providers/no-such-one', { name: 'x' })).body.error.code).toBe('provider_not_found');
  });

  it('adds and removes the agent as a provider is switched off, on, and deleted', async () => {
    const provider = await kit.provider();
    const session = await kit.session(provider);
    kit.model.script({ text: 'first answer' });
    expect((await kit.turn(kit.owner, session.id, 'hello')).status).toBe('completed');
    expect(await agentIds()).toContain(provider.agentId);

    await kit.owner.patch(`/api/providers/${provider.id}`, { enabled: false });
    expect(await agentIds()).not.toContain(provider.agentId);
    expect((await kit.owner.get('/api/agents/' + provider.agentId)).status).toBe(404);
    // Everyone still sees that it exists, switched off.
    expect((await member.get<Provider>(`/api/providers/${provider.id}`)).body).toMatchObject({ enabled: false, settings: null });
    const refused = await kit.send(kit.owner, session.id, 'anyone there?');
    expect(refused.status).toBe(422);
    expect((refused.body as unknown as ErrorBody).error.code).toBe('agent_unavailable');
    expect((await kit.owner.post<ErrorBody>('/api/sessions', { projectId: kit.project.id, agentId: provider.agentId })).body.error.code).toBe('agent_unavailable');

    await kit.owner.patch(`/api/providers/${provider.id}`, { enabled: true });
    expect(await agentIds()).toContain(provider.agentId);
    kit.model.script({ text: 'back again' });
    expect((await kit.turn(kit.owner, session.id, 'and now?')).status).toBe('completed');

    // Deleting takes the key along and leaves the conversation readable.
    const secrets = () => kit.t.studio.context.db.all<{ name: string }>('SELECT name FROM secrets WHERE name LIKE ?', `provider:${provider.id}:%`);
    expect(secrets()).toHaveLength(1);
    expect((await kit.owner.delete(`/api/providers/${provider.id}`)).status).toBe(204);
    expect(secrets()).toHaveLength(0);
    expect(await agentIds()).not.toContain(provider.agentId);
    expect((await kit.owner.get(`/api/providers/${provider.id}`)).status).toBe(404);
    expect((await kit.owner.delete(`/api/providers/${provider.id}`)).status).toBe(404);
    expect((await kit.owner.get(`/api/sessions/${session.id}`)).status).toBe(200);
    const events = await kit.events(kit.owner, session.id);
    expect(events.filter((event) => event.type === 'message.assistant').map((event) => (event.data as { text: string }).text)).toEqual(['first answer', 'back again']);
    expect(((await kit.send(kit.owner, session.id, 'still there?')).body as unknown as ErrorBody).error.code).toBe('agent_unavailable');

    // A provider created again under the same id starts without a key: nothing is inherited.
    const again = await kit.owner.post<Provider>('/api/providers', { id: provider.id, name: 'Reborn', baseUrl: kit.model.url, allowPrivateNetwork: true, models: TEST_MODELS });
    expect(again.body).toMatchObject({ configured: false, settings: { key: { configured: false } } });
  });

  it('caps how many providers there can be', async () => {
    const existing = (await kit.owner.get<{ providers: Provider[] }>('/api/providers')).body.providers.length;
    const made: string[] = [];
    for (let index = existing; index < 20; index += 1) {
      const response = await kit.owner.post<Provider>('/api/providers', { id: `filler-${index}`, name: `Filler ${index}`, baseUrl: 'https://example.com/v1', enabled: false });
      expect(response.status).toBe(201);
      made.push(response.body.id);
    }
    const tooMany = await kit.owner.post<ErrorBody>('/api/providers', { name: 'One too many', baseUrl: 'https://example.com/v1' });
    expect(tooMany.status).toBe(409);
    expect(tooMany.body.error.code).toBe('too_many_providers');
    for (const id of made) await kit.owner.delete(`/api/providers/${id}`);
  });

  it('tells every signed-in client that the list changed, and nothing more', async () => {
    const { url, wsUrl } = await kit.t.listen();
    const socket = new WebSocket(`${wsUrl}/api/realtime`, { headers: { origin: url, cookie: member.cookie! } });
    const frames: ServerFrame[] = [];
    socket.on('message', (raw: WebSocket.RawData) => frames.push(JSON.parse(String(raw as Buffer)) as ServerFrame));
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    try {
      socket.send(JSON.stringify({ op: 'subscribe', topic: PROVIDERS_TOPIC }));
      await until(() => frames.some((frame) => frame.op === 'subscribed' && frame.topic === PROVIDERS_TOPIC), { what: 'the subscription' });

      published.length = 0;
      const provider = await kit.provider({ id: 'announced' });
      await kit.owner.patch(`/api/providers/${provider.id}`, { name: 'Announced, renamed' });
      await kit.owner.put(`/api/providers/${provider.id}/key`, { apiKey: 'sk-another-key-0123456789abcdef' });
      await kit.owner.delete(`/api/providers/${provider.id}/key`);
      await kit.owner.delete(`/api/providers/${provider.id}`);
      const expected = [
        { providerId: 'announced', action: 'created' },
        { providerId: 'announced', action: 'updated' },
        { providerId: 'announced', action: 'updated' },
        { providerId: 'announced', action: 'updated' },
        { providerId: 'announced', action: 'removed' },
      ];
      expect(published.map((event) => [event.type, event.data])).toEqual(expected.map((data) => [PROVIDERS_CHANGED_EVENT, data]));

      const received = await until(() => {
        const events = frames.filter((frame): frame is Extract<ServerFrame, { op: 'event' }> => frame.op === 'event' && frame.topic === PROVIDERS_TOPIC);
        return events.length >= expected.length ? events : null;
      }, { what: 'the change events' });
      expect(received.map((frame) => frame.data)).toEqual(expected);
      expect(received.every((frame) => frame.type === PROVIDERS_CHANGED_EVENT)).toBe(true);
      expectNoKey(JSON.stringify(frames));
    } finally {
      socket.terminate();
    }
  });
});

describe('keys', () => {
  it('takes a key in and never gives it back — not in an answer, not in the database, not in the audit log', async () => {
    const key = 'sk-live-4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c';
    const provider = await kit.provider({ apiKey: undefined });
    expect(provider).toMatchObject({ configured: false, settings: { key: { configured: false, hint: null } } });

    const responses: string[] = [];
    const keep = <T>(response: TestResponse<T>): TestResponse<T> => {
      responses.push(response.raw.body);
      return response;
    };
    const saved = keep(await kit.owner.put<Provider>(`/api/providers/${provider.id}/key`, { apiKey: `  ${key}\n` }));
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ configured: true, settings: { key: { configured: true, hint: `…${key.slice(-4)}`, readable: true } } });
    expect(saved.body.settings!.key.updatedAt).toBeGreaterThan(Date.now() - 5000);

    // It is used…
    kit.model.script({ text: 'key works' });
    const session = await kit.session(provider);
    await kit.turn(kit.owner, session.id, 'hello');
    expect(kit.model.lastChat.key).toBe(key);
    expect(kit.model.lastChat.headers.authorization).toBe(`Bearer ${key}`);

    // …and appears nowhere a client can read.
    for (const url of [
      '/api/providers',
      `/api/providers/${provider.id}`,
      '/api/providers/presets',
      '/api/agents',
      `/api/agents/${provider.agentId}`,
      `/api/sessions/${session.id}`,
      `/api/sessions/${session.id}/events?after=0`,
      `/api/sessions/${session.id}/state`,
      `/api/sessions/${session.id}/usage`,
      `/api/providers/${provider.id}/balance`,
    ]) {
      keep(await kit.owner.get(url));
    }
    keep(await kit.owner.post(`/api/providers/${provider.id}/verify`));
    keep(await kit.owner.post(`/api/providers/${provider.id}/discover-models`));
    keep(await kit.owner.patch(`/api/providers/${provider.id}`, { name: 'Renamed with key' }));
    for (const body of responses) expectNoKey(body, key);

    // On disk it is sealed: no file of the data directory holds the key or a piece of it.
    kit.t.studio.context.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const files = readdirSync(kit.t.dataDir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile());
    expect(files.some((entry) => entry.name === 'studio.db')).toBe(true);
    for (const entry of files) expectNoKey(readFileSync(path.join(entry.parentPath, entry.name)).toString('latin1'), key);
    const row = kit.t.studio.context.db.get<{ sealed: string; hint: string }>('SELECT sealed, hint FROM secrets WHERE name = ?', `provider:${provider.id}:api-key`)!;
    expect(row.hint).toBe(`…${key.slice(-4)}`);
    expectNoKey(row.sealed, key);

    const audit = kit.t.studio.context.db.all<{ action: string; subject: string; detail: string }>('SELECT action, subject, detail FROM audit_events WHERE subject LIKE ?', `%(${provider.id})`);
    expect(audit.map((entry) => entry.action)).toEqual(expect.arrayContaining(['provider.created', 'provider.key.saved', 'provider.updated']));
    expectNoKey(JSON.stringify(audit), key);
  });

  it('keeps the saved key when an update leaves the field blank, and replaces it when one is typed', async () => {
    const provider = await kit.provider();
    const hint = `…${TEST_KEY.slice(-4)}`;
    for (const body of [{ name: 'Still has its key' }, { apiKey: '' }, { apiKey: '   ' }, { name: 'Again', apiKey: '' }]) {
      const response = await kit.owner.patch<UpdateProviderResponse>(`/api/providers/${provider.id}`, body);
      expect(response.body).toMatchObject({ keyCleared: false, provider: { settings: { key: { configured: true, hint } } } });
    }
    const replaced = await kit.owner.patch<UpdateProviderResponse>(`/api/providers/${provider.id}`, { apiKey: 'sk-second-key-0123456789abcdWXYZ' });
    expect(replaced.body.provider.settings!.key).toMatchObject({ configured: true, hint: '…WXYZ' });
    kit.model.script({ text: 'ok' });
    await kit.turn(kit.owner, (await kit.session(provider)).id, 'which key?');
    expect(kit.model.lastChat.key).toBe('sk-second-key-0123456789abcdWXYZ');

    // Removing always works, and removing nothing is not an error.
    const removed = await kit.owner.delete<Provider>(`/api/providers/${provider.id}/key`);
    expect(removed.body).toMatchObject({ configured: false, settings: { key: { configured: false, hint: null } } });
    expect((await kit.owner.delete<Provider>(`/api/providers/${provider.id}/key`)).status).toBe(200);
    const agent = (await kit.owner.get<Agent>(`/api/agents/${provider.agentId}`)).body;
    expect(agent.status).toMatchObject({ signedIn: false });
    expect(agent.status.problem).toContain('No API key is saved');
  });

  it('refuses what is plainly not an API key, without repeating it', async () => {
    const provider = await kit.provider();
    const cases: Array<[string, string]> = [
      ['', 'empty'],
      ['sk-1', 'too_short'],
      [`sk-${'z'.repeat(600)}`, 'too_long'],
      ['sk-0123456789 abcdefghij', 'whitespace'],
      ['sk-0123456789\r\nx-injected: 1', 'whitespace'],
      ['sk-0123456789ключ', 'characters'],
      ['https://api.deepseek.com/v1', 'looks_like_url'],
      ['sk-ant-oat01-Qw7Zx9Lm2Vb4Nc6Hj8Kd0Fs3Gp5Tr1Ye', 'sign_in_token'],
      ['eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJjaGF0Z3B0In0.c2lnbmF0dXJlLWJ5dGVz', 'sign_in_token'],
      ['sk-admin-Qw7Zx9Lm2Vb4Nc6Hj8Kd0Fs3Gp5Tr1Ye', 'admin_key'],
      ['ghp_Qw7Zx9Lm2Vb4Nc6Hj8Kd0Fs3Gp5Tr1YeUi4', 'other_service'],
    ];
    for (const [value, reason] of cases) {
      const attempts = [await kit.owner.put<ErrorBody>(`/api/providers/${provider.id}/key`, { apiKey: value })];
      // In an update or at creation a blank key simply means "none", so only a typed one can be refused there.
      if (value !== '') {
        attempts.push(
          await kit.owner.patch<ErrorBody>(`/api/providers/${provider.id}`, { apiKey: value, name: 'Should not be saved' }),
          await kit.owner.post<ErrorBody>('/api/providers', { name: 'Never created', baseUrl: 'https://example.com/v1', apiKey: value }),
        );
      }
      for (const response of attempts) {
        expect(response.status, value.slice(0, 12)).toBe(400);
        expect(response.body.error).toMatchObject({ code: 'invalid_api_key', details: { reason } });
        if (value.trim().length >= 8) expectNoKey(response.raw.body, value.trim());
      }
    }
    // Nothing of all that was saved: the first key is still the one in use, the name unchanged.
    const now = (await kit.owner.get<Provider>(`/api/providers/${provider.id}`)).body;
    expect(now.settings!.key.hint).toBe(`…${TEST_KEY.slice(-4)}`);
    expect(now.name).toBe(provider.name);
    expect((await kit.owner.get<{ providers: Provider[] }>('/api/providers')).body.providers.some((entry) => entry.name === 'Never created')).toBe(false);
  });

  it('removes the key when the base URL changes, and says so', async () => {
    const other = await startPlainServer();
    try {
      const provider = await kit.provider();
      const moved = await kit.owner.patch<UpdateProviderResponse>(`/api/providers/${provider.id}`, { baseUrl: other.url });
      expect(moved.status).toBe(200);
      expect(moved.body).toMatchObject({ keyCleared: true, provider: { configured: false, settings: { baseUrl: other.url, key: { configured: false, hint: null } } } });
      expect(kit.t.studio.context.db.all('SELECT name FROM secrets WHERE name = ?', `provider:${provider.id}:api-key`)).toHaveLength(0);

      // Nothing is sent to the new address with the old key — or at all, until a key is saved again.
      const session = await kit.session(provider);
      const run = await kit.turn(kit.owner, session.id, 'hello?');
      expect(run).toMatchObject({ status: 'failed', error: { code: 'provider_not_configured' } });
      expect(other.requests).toHaveLength(0);

      // Writing the same address differently is not a change.
      await kit.owner.put(`/api/providers/${provider.id}/key`, { apiKey: TEST_KEY });
      const same = await kit.owner.patch<UpdateProviderResponse>(`/api/providers/${provider.id}`, { baseUrl: `${other.url}/` });
      expect(same.body).toMatchObject({ keyCleared: false, provider: { configured: true } });

      // A new address together with a new key: the new key is kept, for the new address.
      const both = await kit.owner.patch<UpdateProviderResponse>(`/api/providers/${provider.id}`, { baseUrl: kit.model.url, apiKey: 'sk-key-for-the-new-address-012345' });
      expect(both.body).toMatchObject({ keyCleared: false, provider: { configured: true, settings: { baseUrl: kit.model.url, key: { hint: '…2345' } } } });
      kit.model.script({ text: 'ok' });
      await kit.turn(kit.owner, session.id, 'again');
      expect(kit.model.lastChat.key).toBe('sk-key-for-the-new-address-012345');
      expect(other.requests).toHaveLength(0);
    } finally {
      await other.close();
    }
  });

  it('needs a fresh sign-in for what redirects conversations or the key', async () => {
    const provider = await kit.provider({ allowPrivateNetwork: false, baseUrl: 'https://example.com/v1' });
    const local = await kit.provider();
    const url = `/api/providers/${provider.id}`;
    try {
      reauthAfter(16);
      const refused: Array<TestResponse<ErrorBody>> = [
        await kit.owner.post('/api/providers', { name: 'Late', baseUrl: 'https://example.com/v1' }),
        await kit.owner.put(`${url}/key`, { apiKey: 'sk-replacement-0123456789abcdef' }),
        await kit.owner.patch(url, { apiKey: 'sk-replacement-0123456789abcdef' }),
        await kit.owner.patch(url, { baseUrl: 'https://elsewhere.example/v1' }),
        await kit.owner.patch(url, { allowPrivateNetwork: true }),
        await kit.owner.patch(url, { name: 'Smuggled along', baseUrl: 'https://elsewhere.example/v1' }),
      ];
      for (const response of refused) {
        expect(response.status).toBe(403);
        expect(response.body.error.code).toBe('reauth_required');
      }
      const untouched = (await kit.owner.get<Provider>(url)).body;
      expect(untouched).toMatchObject({ name: provider.name, settings: { baseUrl: 'https://example.com/v1', allowPrivateNetwork: false, key: { hint: `…${TEST_KEY.slice(-4)}` } } });

      // Everything that cannot redirect anything still works with an older sign-in — including taking things away.
      expect((await kit.owner.patch(url, { name: 'Renamed late' })).status).toBe(200);
      expect((await kit.owner.patch(url, { models: [{ id: 'm', name: 'M' }], enabled: false })).status).toBe(200);
      expect((await kit.owner.patch(url, { baseUrl: 'https://example.com/v1/' })).status).toBe(200);
      expect((await kit.owner.patch(url, { allowPrivateNetwork: false, apiKey: '' })).status).toBe(200);
      expect((await kit.owner.post<ProviderVerifyResult>(`/api/providers/${local.id}/verify`)).body.ok).toBe(true);
      expect((await kit.owner.delete(`${url}/key`)).status).toBe(200);
      expect((await kit.owner.delete(url)).status).toBe(204);
    } finally {
      reauthAfter(0);
    }
    // With a fresh sign-in the rest works again.
    expect((await kit.owner.put(`/api/providers/${local.id}/key`, { apiKey: 'sk-replacement-0123456789abcdef' })).status).toBe(200);
  });

  it('never lets an API token redirect a provider or set its key', async () => {
    const provider = await kit.provider({ allowPrivateNetwork: false, baseUrl: 'https://example.com/v1' });
    const made = await kit.owner.post<CreatedApiToken>('/api/auth/tokens', { name: 'automation', scopes: ['read', 'write', 'admin'] });
    expect(made.body.token).toBeTruthy();
    const robot = new TestClient(kit.t.studio);
    robot.bearer = made.body.token;
    const url = `/api/providers/${provider.id}`;

    const refused: Array<TestResponse<ErrorBody>> = [
      await robot.post('/api/providers', { name: 'By robot', baseUrl: 'https://example.com/v1' }),
      await robot.put(`${url}/key`, { apiKey: 'sk-robot-key-0123456789abcdef' }),
      await robot.patch(url, { apiKey: 'sk-robot-key-0123456789abcdef' }),
      await robot.patch(url, { baseUrl: 'https://elsewhere.example/v1' }),
      await robot.patch(url, { allowPrivateNetwork: true }),
    ];
    for (const response of refused) {
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('session_required');
    }
    expect((await kit.owner.get<Provider>(url)).body.settings).toMatchObject({ baseUrl: 'https://example.com/v1', allowPrivateNetwork: false, key: { hint: `…${TEST_KEY.slice(-4)}` } });

    // An admin token may read, rename, switch off and take a key away; a lesser token may only read the list.
    expect((await robot.get<Provider>(url)).body.settings).not.toBeNull();
    expect((await robot.patch(url, { name: 'Renamed by robot' })).status).toBe(200);
    expect((await robot.delete(`${url}/key`)).status).toBe(200);
    const reader = new TestClient(kit.t.studio);
    reader.bearer = (await kit.owner.post<CreatedApiToken>('/api/auth/tokens', { name: 'reader', scopes: ['read', 'write'] })).body.token;
    expect((await reader.get('/api/providers')).status).toBe(200);
    expect((await reader.patch<ErrorBody>(url, { name: 'no' })).body.error.code).toBe('insufficient_scope');
    expect((await reader.delete<ErrorBody>(`${url}/key`)).body.error.code).toBe('insufficient_scope');
    expect((await reader.post<ErrorBody>(`${url}/verify`)).body.error.code).toBe('insufficient_scope');
  });

  it('reports a key that can no longer be decrypted instead of failing', async () => {
    const provider = await kit.provider();
    // What a changed installation key or a damaged record looks like: the sealed value does not open.
    const other = await kit.provider();
    const foreign = kit.t.studio.context.db.get<{ sealed: string }>('SELECT sealed FROM secrets WHERE name = ?', `provider:${other.id}:api-key`)!.sealed;
    kit.t.studio.context.db.run('UPDATE secrets SET sealed = ?, updated_at = updated_at + 1 WHERE name = ?', foreign, `provider:${provider.id}:api-key`);

    const shown = (await kit.owner.get<Provider>(`/api/providers/${provider.id}`)).body;
    expect(shown).toMatchObject({ configured: false, settings: { key: { configured: true, readable: false } } });
    const verified = (await kit.owner.post<ProviderVerifyResult>(`/api/providers/${provider.id}/verify`)).body;
    expect(verified).toMatchObject({ ok: false, code: 'provider_key_unreadable', method: 'none' });
    expect(verified.message).toContain('save it again');
    const agent = (await kit.owner.get<Agent>(`/api/agents/${provider.agentId}`)).body;
    expect(agent.status).toMatchObject({ installed: true, signedIn: false });
    const run = await kit.turn(kit.owner, (await kit.session(provider)).id, 'hello');
    expect(run).toMatchObject({ status: 'failed', error: { code: 'provider_key_unreadable' } });
    expect(kit.model.requests).toHaveLength(0);

    // Saving it again repairs it.
    await kit.owner.put(`/api/providers/${provider.id}/key`, { apiKey: TEST_KEY });
    expect((await kit.owner.get<Provider>(`/api/providers/${provider.id}`)).body).toMatchObject({ configured: true, settings: { key: { readable: true } } });
  });
});

describe('verify, discover, balance', () => {
  const verify = async (provider: Provider): Promise<ProviderVerifyResult> => {
    const response = await kit.owner.post<ProviderVerifyResult>(`/api/providers/${provider.id}/verify`);
    expect(response.status).toBe(200);
    return response.body;
  };

  it('verifies with the free model listing and remembers the outcome', async () => {
    const provider = await kit.provider();
    kit.model.models = ['a', 'b', 'c'];
    const result = await verify(provider);
    expect(result).toMatchObject({ ok: true, code: 'ok', method: 'models', modelCount: 3 });
    expect(result.checkedAt).toBeGreaterThan(Date.now() - 5000);
    // One request, to the listing, carrying the key; no completion was paid for.
    expect(kit.model.requests.map((request) => `${request.method} ${request.path}`)).toEqual(['GET /v1/models']);
    expect(kit.model.requests[0]!.key).toBe(TEST_KEY);
    expect((await kit.owner.get<Provider>(`/api/providers/${provider.id}`)).body.settings!.lastCheck).toMatchObject({ ok: true, code: 'ok' });
  });

  it.each([
    [401, 'provider_auth_failed', 'rejected the API key'],
    [403, 'provider_auth_failed', 'rejected the API key'],
    [402, 'provider_no_credit', 'no credit left'],
    [429, 'provider_rate_limited', 'limiting how fast'],
    [500, 'provider_unavailable', 'HTTP 500'],
    [400, 'provider_rejected', 'HTTP 400'],
    [302, 'provider_redirected', 'never followed'],
  ])('explains HTTP %i from the provider as %s, in its own words', async (status, code, phrase) => {
    const provider = await kit.provider();
    // The stand-in's error text names the key it was sent, as some providers do.
    kit.model.models = { status };
    const response = await kit.owner.post<ProviderVerifyResult>(`/api/providers/${provider.id}/verify`);
    expect(response.body).toMatchObject({ ok: false, code, method: 'models', modelCount: null });
    expect(response.body.message).toContain(phrase);
    expect(response.body.message).toContain(provider.name);
    expect(response.body.message).not.toContain('models are unavailable');
    expectNoKey(response.raw.body);
    expect(kit.model.requests).toHaveLength(1);

    // The agent's status shows the last failure without asking the provider again.
    const agent = (await kit.owner.get<Agent>(`/api/agents/${provider.agentId}`)).body;
    expect(agent.status.problem).toBe(response.body.message);
    expect(agent.status.signedIn).toBe(code !== 'provider_auth_failed');
    await kit.owner.get('/api/agents');
    expect(kit.model.requests).toHaveLength(1);
  });

  it('falls back to a one-token completion only when the server has no model listing', async () => {
    const provider = await kit.provider();
    kit.model.models = null;
    const result = await verify(provider);
    expect(result).toMatchObject({ ok: true, method: 'completion', modelCount: null });
    expect(kit.model.requests.map((request) => `${request.method} ${request.path}`)).toEqual(['GET /v1/models', 'POST /v1/chat/completions']);
    expect(kit.model.lastChat.body).toMatchObject({ model: 'fake-model', max_tokens: 1, stream: false });
    expect(kit.model.lastChat.key).toBe(TEST_KEY);

    kit.model.reset();
    kit.model.script({ status: 404 });
    expect(await verify(provider)).toMatchObject({ ok: false, code: 'provider_model_not_found', method: 'completion' });
    kit.model.script({ status: 401, echoKey: true });
    const rejected = await kit.owner.post<ProviderVerifyResult>(`/api/providers/${provider.id}/verify`);
    expect(rejected.body).toMatchObject({ ok: false, code: 'provider_auth_failed', method: 'completion' });
    expectNoKey(rejected.raw.body);

    // With no model named there is nothing to try.
    await kit.owner.patch(`/api/providers/${provider.id}`, { models: [] });
    kit.model.reset();
    expect(await verify(provider)).toMatchObject({ ok: false, code: 'provider_no_model', method: 'none' });
    expect(kit.model.chats).toHaveLength(0);
  });

  it('says what is wrong before sending anything when no key is saved, and when the server is not there', async () => {
    const keyless = await kit.provider({ apiKey: undefined });
    expect(await verify(keyless)).toMatchObject({ ok: false, code: 'provider_not_configured', method: 'none' });
    expect(kit.model.requests).toHaveLength(0);

    // A port nothing listens on.
    const gone = await startPlainServer();
    await gone.close();
    const unreachable = await kit.provider({ baseUrl: gone.url });
    const result = await verify(unreachable);
    expect(result).toMatchObject({ ok: false, code: 'provider_unreachable' });
    expect(result.message).not.toContain('ECONNREFUSED');
    expect(result.message).not.toContain('127.0.0.1');

    // Something that is not a model server at all.
    const web = await startPlainServer('<html>hello</html>');
    try {
      const wrong = await kit.provider({ baseUrl: web.url });
      expect(await verify(wrong)).toMatchObject({ ok: false, code: 'provider_protocol_error' });
    } finally {
      await web.close();
    }
  });

  it('adds what the provider lists to the catalogue, assuming nothing about new models', async () => {
    const provider = await kit.provider();
    kit.model.models = ['fake-model', 'brand-new', 'another new one', 'second-new', 'second-new'];
    const response = await kit.owner.post<DiscoverModelsResponse>(`/api/providers/${provider.id}/discover-models`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ found: 5, added: ['brand-new', 'second-new'], skipped: 0 });
    const catalogue = response.body.provider.settings!.catalogue;
    expect(catalogue.map((model) => model.id)).toEqual(['fake-model', 'fake-vision', 'fake-plain', 'brand-new', 'second-new']);
    // Known entries are untouched; new ones start hidden, without tools, images or a price.
    expect(catalogue[0]).toMatchObject({ id: 'fake-model', tools: true, hidden: false, prices: { input: 1 } });
    expect(catalogue[3]).toEqual({ id: 'brand-new', name: 'brand-new', contextWindow: null, images: false, tools: false, prices: null, hidden: true });
    expect(response.body.provider.models.map((model) => model.id)).toEqual(['fake-model', 'fake-vision', 'fake-plain']);

    // Asking again finds nothing new; asking for them visible is possible.
    expect((await kit.owner.post<DiscoverModelsResponse>(`/api/providers/${provider.id}/discover-models`)).body).toMatchObject({ found: 5, added: [] });
    kit.model.models = ['third-new'];
    const visible = await kit.owner.post<DiscoverModelsResponse>(`/api/providers/${provider.id}/discover-models`, { hidden: false });
    expect(visible.body.provider.models.map((model) => model.id)).toContain('third-new');

    // A provider with an empty catalogue gets its first models visible, so it is usable right away.
    const empty = await kit.provider({ models: [], defaultModel: undefined });
    kit.model.models = ['local-a', 'local-b'];
    const filled = await kit.owner.post<DiscoverModelsResponse>(`/api/providers/${empty.id}/discover-models`);
    expect(filled.body.provider).toMatchObject({ defaultModel: 'local-a', models: [{ id: 'local-a', tools: false }, { id: 'local-b' }] });
  });

  it('reports why discovery failed, with a status the client can tell from success', async () => {
    const provider = await kit.provider();
    kit.model.models = { status: 401 };
    const rejected = await kit.owner.post<ErrorBody>(`/api/providers/${provider.id}/discover-models`);
    expect(rejected.status).toBe(502);
    expect(rejected.body.error.code).toBe('provider_auth_failed');
    expectNoKey(rejected.raw.body);
    kit.model.models = null;
    expect((await kit.owner.post<ErrorBody>(`/api/providers/${provider.id}/discover-models`)).body.error.code).toBe('provider_model_not_found');
    const keyless = await kit.provider({ apiKey: undefined });
    const unconfigured = await kit.owner.post<ErrorBody>(`/api/providers/${keyless.id}/discover-models`);
    expect(unconfigured.status).toBe(409);
    expect(unconfigured.body.error.code).toBe('provider_not_configured');
    expect((await kit.owner.get<Provider>(`/api/providers/${provider.id}`)).body.settings!.catalogue).toHaveLength(TEST_MODELS.length);
  });

  it('reads the balance where the provider documents one', async () => {
    const provider = await kit.provider({ balance: 'deepseek' });
    kit.model.balance = { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' }, { currency: 'usd', total_balance: '3.5' }, { currency: 'XX', total_balance: 'lots' }] };
    const response = await kit.owner.get<ProviderBalance>(`/api/providers/${provider.id}/balance`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      available: true,
      code: 'ok',
      sufficient: true,
      balances: [
        { currency: 'CNY', total: '110.00', granted: '10.00', toppedUp: '100.00' },
        { currency: 'USD', total: '3.5', granted: null, toppedUp: null },
      ],
      estimatedSpend: { runs: 0, unpricedRuns: 0, totalUsd: null, last30DaysUsd: null, since: null },
    });
    // The documented endpoint, at the root of the provider's address, with the key.
    const request = kit.model.requests.at(-1)!;
    expect(`${request.method} ${request.path}`).toBe('GET /user/balance');
    expect(request.key).toBe(TEST_KEY);

    kit.model.balance = { status: 401 };
    const rejected = await kit.owner.get<ProviderBalance>(`/api/providers/${provider.id}/balance`);
    expect(rejected.body).toMatchObject({ available: false, code: 'provider_auth_failed', balances: [] });
    expectNoKey(rejected.raw.body);
    kit.model.balance = { something: 'else' };
    expect((await kit.owner.get<ProviderBalance>(`/api/providers/${provider.id}/balance`)).body).toMatchObject({ available: false, code: 'provider_protocol_error' });
  });

  it('offers an estimate from its own usage records where there is no balance to read', async () => {
    const provider = await kit.provider();
    const session = await kit.session(provider);
    kit.model.script({ text: 'priced', usage: { prompt_tokens: 1_000_000, completion_tokens: 500_000, prompt_tokens_details: { cached_tokens: 400_000 } } });
    await kit.turn(kit.owner, session.id, 'hello');
    // A model without a price: counted as a run, not as money.
    kit.model.script({ text: 'unpriced', usage: { prompt_tokens: 10, completion_tokens: 5 } });
    await kit.turn(kit.owner, session.id, 'again', { model: 'fake-plain' });

    kit.model.reset();
    const response = await kit.owner.get<ProviderBalance>(`/api/providers/${provider.id}/balance`);
    expect(response.body).toMatchObject({ available: false, code: 'balance_not_supported', sufficient: null, balances: [] });
    // 600k fresh input at $1, 400k cached at $0.10, 500k output at $2 per million.
    expect(response.body.estimatedSpend).toMatchObject({ runs: 2, unpricedRuns: 1 });
    expect(response.body.estimatedSpend.totalUsd).toBeCloseTo(0.6 + 0.04 + 1.0, 6);
    expect(response.body.estimatedSpend.last30DaysUsd).toBeCloseTo(1.64, 6);
    expect(response.body.estimatedSpend.since).toBeGreaterThan(Date.now() - 60_000);
    expect(kit.model.requests).toHaveLength(0);

    // Another provider's spending is not mixed in.
    const other = await kit.provider();
    expect((await kit.owner.get<ProviderBalance>(`/api/providers/${other.id}/balance`)).body.estimatedSpend).toMatchObject({ runs: 0, totalUsd: null });
  });
});

describe('where a provider may live', () => {
  it('reaches a server on this machine only for the provider that was allowed to', async () => {
    const allowed = await kit.provider();
    expect((await kit.owner.post<ProviderVerifyResult>(`/api/providers/${allowed.id}/verify`)).body.ok).toBe(true);
    kit.model.reset();

    // The same address cannot even be saved without the flag — whatever way it is spelled.
    for (const baseUrl of [kit.model.url, `https://127.0.0.1:${kit.model.port}/v1`, `https://[::1]:${kit.model.port}/v1`, `https://[::ffff:127.0.0.1]:${kit.model.port}/v1`, `https://0.0.0.0:${kit.model.port}/v1`, `http://localhost:${kit.model.port}/v1`]) {
      const response = await kit.owner.post<ErrorBody>('/api/providers', { name: 'Sneaky', baseUrl, models: TEST_MODELS, apiKey: TEST_KEY });
      expect(response.status, baseUrl).toBeGreaterThanOrEqual(400);
      expect(['address_not_allowed', 'insecure_url'], baseUrl).toContain(response.body.error.code);
    }

    // A host name says nothing until it is resolved: this one can be saved, and is refused when it is used.
    const byName = await kit.owner.post<Provider>('/api/providers', { id: 'by-name', name: 'By name', baseUrl: `https://localhost:${kit.model.port}/v1`, models: TEST_MODELS, defaultModel: 'fake-model', apiKey: TEST_KEY });
    expect(byName.status).toBe(201);
    const verified = (await kit.owner.post<ProviderVerifyResult>('/api/providers/by-name/verify')).body;
    expect(verified).toMatchObject({ ok: false, code: 'provider_address_not_allowed' });
    expect(verified.message).toContain('allow private network');
    await expect(kit.owner.post<ErrorBody>('/api/providers/by-name/discover-models')).resolves.toMatchObject({ status: 502, body: { error: { code: 'provider_address_not_allowed' } } });
    const run = await kit.turn(kit.owner, (await kit.session(byName.body)).id, 'are you local?');
    expect(run).toMatchObject({ status: 'failed', error: { code: 'provider_address_not_allowed' } });
    // Not one byte reached the server on loopback.
    expect(kit.model.requests).toHaveLength(0);
  });

  it('never reaches link-local addresses, flag or no flag', async () => {
    for (const allowPrivateNetwork of [false, true]) {
      for (const baseUrl of ['http://169.254.169.254/latest/meta-data', 'https://169.254.169.254/v1', 'https://[fe80::1]/v1']) {
        const response = await kit.owner.post<ErrorBody>('/api/providers', { name: 'Metadata', baseUrl, allowPrivateNetwork });
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(['address_not_allowed', 'insecure_url']).toContain(response.body.error.code);
      }
    }
    const provider = await kit.provider();
    expect((await kit.owner.patch<ErrorBody>(`/api/providers/${provider.id}`, { baseUrl: 'http://169.254.169.254/' })).body.error.code).toBe('address_not_allowed');
    expect((await kit.owner.get<Provider>(`/api/providers/${provider.id}`)).body.settings).toMatchObject({ baseUrl: kit.model.url, key: { configured: true } });
  });

  it('does not follow a redirect — least of all to a private address', async () => {
    const target = await startPlainServer(JSON.stringify({ data: [{ id: 'stolen' }] }));
    const redirector = http.createServer((_request, response) => {
      response.writeHead(307, { location: `${target.url}/models` }).end();
    });
    await new Promise<void>((resolve) => redirector.listen(0, '127.0.0.1', resolve));
    try {
      const provider = await kit.provider({ baseUrl: `http://127.0.0.1:${(redirector.address() as AddressInfo).port}/v1` });
      const verified = (await kit.owner.post<ProviderVerifyResult>(`/api/providers/${provider.id}/verify`)).body;
      expect(verified).toMatchObject({ ok: false, code: 'provider_redirected' });
      const run = await kit.turn(kit.owner, (await kit.session(provider)).id, 'follow me');
      expect(run).toMatchObject({ status: 'failed', error: { code: 'provider_redirected' } });
      // The key was never presented to the place the redirect pointed at.
      expect(target.requests).toHaveLength(0);
    } finally {
      await new Promise<void>((resolve) => redirector.close(() => resolve()));
      await target.close();
    }
    // The stand-in redirecting a chat request: one request, no second one anywhere.
    const provider = await kit.provider();
    kit.model.reset();
    kit.model.script({ redirect: 'http://169.254.169.254/latest/meta-data' });
    const run = await kit.turn(kit.owner, (await kit.session(provider)).id, 'hello');
    expect(run).toMatchObject({ status: 'failed', error: { code: 'provider_redirected' } });
    expect(kit.model.chats).toHaveLength(1);
  });

  it('refuses to drop the flag while the address still needs it', async () => {
    const provider = await kit.provider();
    const response = await kit.owner.patch<ErrorBody>(`/api/providers/${provider.id}`, { allowPrivateNetwork: false });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('insecure_url');
    expect((await kit.owner.get<Provider>(`/api/providers/${provider.id}`)).body.settings!.allowPrivateNetwork).toBe(true);
    // Together with a public address it is fine (and the key goes, because the address changed).
    const moved = await kit.owner.patch<UpdateProviderResponse>(`/api/providers/${provider.id}`, { allowPrivateNetwork: false, baseUrl: 'https://example.com/v1' });
    expect(moved.body).toMatchObject({ keyCleared: true, provider: { settings: { allowPrivateNetwork: false, baseUrl: 'https://example.com/v1' } } });
  });
});

describe('across a restart', () => {
  it('finds its providers, their agents and their keys again', async () => {
    const first = await createProvidersKit();
    let second: Awaited<ReturnType<typeof createTestStudio>> | null = null;
    try {
      const provider = await first.provider({ name: 'Survivor' });
      const disabled = await first.provider({ name: 'Switched off', enabled: false });
      await first.owner.post(`/api/providers/${provider.id}/verify`);
      await first.t.studio.stop();

      second = await createTestStudio({ config: { dataDir: first.t.dataDir, workspaceRoots: [first.t.workspace] } });
      const owner = await second.signIn('owner');
      const listed = (await owner.get<{ providers: Provider[] }>('/api/providers')).body.providers;
      expect(listed.map((entry) => [entry.id, entry.enabled, entry.configured])).toEqual([[provider.id, true, true], [disabled.id, false, true]]);
      // What was learned about the provider's health is not kept: a new process has no opinion yet.
      expect(listed[0]!.settings).toMatchObject({ baseUrl: first.model.url, key: { configured: true, readable: true, hint: `…${TEST_KEY.slice(-4)}` }, lastCheck: null });
      const agents = (await owner.get<{ agents: Agent[] }>('/api/agents')).body.agents.map((agent) => agent.id);
      expect(agents).toContain(provider.agentId);
      expect(agents).not.toContain(disabled.agentId);

      // The key still opens: a conversation reaches the provider with it.
      const project = (await owner.get<{ projects: Array<{ id: string }> }>('/api/projects')).body.projects[0]!;
      const session = (await owner.post<{ id: string }>('/api/sessions', { projectId: project.id, agentId: provider.agentId })).body;
      first.model.reset();
      first.model.script({ text: 'still here after the restart' });
      const receipt = await owner.post<{ runId: string }>(`/api/sessions/${session.id}/messages`, { requestId: 'after-restart-1', text: 'hello again' });
      expect(receipt.status).toBe(202);
      await until(async () => ['completed', 'failed'].includes((await owner.get<{ status: string }>(`/api/runs/${receipt.body.runId}`)).body.status), { what: 'the run to end' });
      expect((await owner.get<{ status: string }>(`/api/runs/${receipt.body.runId}`)).body.status).toBe('completed');
      expect(first.model.lastChat.key).toBe(TEST_KEY);
    } finally {
      await second?.close();
      await first.close();
    }
  });
});

describe('limits on asking the provider', () => {
  it('gives up on a provider that does not answer in time', async () => {
    const slow = await createProvidersKit({ providers: { probeTimeoutMs: 300 } });
    const hanging = http.createServer(() => {
      /* accepts the request and never answers */
    });
    await new Promise<void>((resolve) => hanging.listen(0, '127.0.0.1', resolve));
    try {
      const provider = await slow.provider({ baseUrl: `http://127.0.0.1:${(hanging.address() as AddressInfo).port}/v1`, balance: 'deepseek' });
      const started = Date.now();
      const verified = (await slow.owner.post<ProviderVerifyResult>(`/api/providers/${provider.id}/verify`)).body;
      expect(verified).toMatchObject({ ok: false, code: 'provider_timeout' });
      expect((await slow.owner.post<ErrorBody>(`/api/providers/${provider.id}/discover-models`)).body.error.code).toBe('provider_timeout');
      expect((await slow.owner.get<ProviderBalance>(`/api/providers/${provider.id}/balance`)).body).toMatchObject({ available: false, code: 'provider_timeout' });
      expect(Date.now() - started).toBeLessThan(15_000);
    } finally {
      hanging.closeAllConnections();
      await new Promise<void>((resolve) => hanging.close(() => resolve()));
      await slow.close();
    }
  });

  it('limits how often verify, discover and balance may be called', async () => {
    const limited = await createProvidersKit({ providers: { probeRateLimit: { max: 3, windowMs: 60_000 } } });
    try {
      const provider = await limited.provider();
      for (let attempt = 0; attempt < 3; attempt += 1) expect((await limited.owner.post(`/api/providers/${provider.id}/verify`)).status).toBe(200);
      const fourth = await limited.owner.post<ErrorBody>(`/api/providers/${provider.id}/verify`);
      expect(fourth.status).toBe(429);
      expect(fourth.body.error.code).toBe('rate_limited');
      expect(limited.model.requests).toHaveLength(3);
      // Each of the three routes has its own allowance; ordinary routes are not affected.
      expect((await limited.owner.get(`/api/providers/${provider.id}/balance`)).status).toBe(200);
      expect((await limited.owner.get('/api/providers')).status).toBe(200);
    } finally {
      await limited.close();
    }
  });
});

/** A bare HTTP server on loopback that records what it is asked and answers everything with one body. */
async function startPlainServer(body = '{}'): Promise<{ url: string; requests: string[]; close(): Promise<void> }> {
  const requests: string[] = [];
  const server = http.createServer((request, response) => {
    requests.push(`${request.method} ${request.url} ${request.headers.authorization ?? ''}`);
    response.writeHead(200, { 'content-type': 'text/html' }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  return {
    url,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
