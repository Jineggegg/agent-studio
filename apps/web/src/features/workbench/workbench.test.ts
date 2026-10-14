import type { Agent, Approval, SessionEvent } from '@agent-studio/protocol';
import { FolderTree, Terminal } from 'lucide-react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentUnavailable, agentsFor, choiceFor, defaultChoice, nextMode, resolveEffort, resolveMode } from './agents';
import { DEFAULT_MEMORY, INSPECTOR_MAX_WIDTH, INSPECTOR_MIN_WIDTH, clampInspectorWidth, parseDeviceMemory } from './device';
import { __resetInspectorForTests, inspectorPanels, panelHandling, registerInspectorPanel } from './inspector/registry';
import { describeOutcome, formatElapsed, runProgress } from './run/status';
import { applyEvent, applyLive, applySnapshot, initialTranscript } from './transcript/reducer';
import { contextLevel } from './usage/ContextRing';

vi.mock('./api', () => ({ workbenchApi: {}, SEND_TIMEOUT_MS: 20_000 }));

const agent = (id: string, overrides: Partial<Agent> = {}, status: Partial<Agent['status']> = {}): Agent => ({
  id,
  displayName: id,
  kind: 'cli',
  capabilities: {
    models: [
      { id: 'large', label: 'Large', recommended: true, contextWindow: 200_000, efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
      { id: 'small', label: 'Small' },
    ],
    defaultModel: 'large',
    permissionModes: ['plan', 'ask', 'accept-edits', 'auto'],
    images: true,
    steering: true,
    resume: true,
    planMode: true,
    usage: true,
  },
  status: { installed: true, version: '1', signedIn: true, account: null, problem: null, ...status },
  ...overrides,
});

const writable = { agents: null, access: 'write' as const };
const memory = { lastAgentId: null, lastModel: {}, lastEffort: {}, lastMode: {} };

describe('which agent a new conversation starts with', () => {
  const ready = agent('ready');
  const missing = agent('missing', {}, { installed: false, problem: 'Not found on this server.' });
  const signedOut = agent('signed-out', {}, { signedIn: false });
  const api = agent('api-openai', { kind: 'api' });

  it('says why an agent cannot be used', () => {
    expect(agentUnavailable(ready, writable)).toBeNull();
    expect(agentUnavailable(missing, writable)).toBe('not-installed');
    expect(agentUnavailable(signedOut, writable)).toBe('not-signed-in');
    expect(agentUnavailable(ready, { agents: ['other'], access: 'write' })).toBe('not-offered');
    expect(agentUnavailable(ready, { agents: null, access: 'read' })).toBe('read-only');
  });

  it('lists what the project offers, the usable ones first; what it does not offer is not listed at all', () => {
    expect(agentsFor([missing, ready, signedOut], writable).map((entry) => entry.id)).toEqual(['ready', 'missing', 'signed-out']);
    expect(agentsFor([missing, ready], { agents: ['missing'], access: 'write' }).map((entry) => entry.id)).toEqual(['missing']);
    // Outside any project only a plain chat model can work.
    expect(agentsFor([ready, api], null).map((entry) => entry.id)).toEqual(['api-openai']);
  });

  it('prefers the agent used last, falls back to the first that can run, and never picks a dead one while a live one exists', () => {
    expect(defaultChoice([missing, ready], writable, { ...memory, lastAgentId: 'ready' })?.agentId).toBe('ready');
    expect(defaultChoice([missing, ready], writable, { ...memory, lastAgentId: 'missing' })?.agentId).toBe('ready');
    expect(defaultChoice([missing], writable, memory)?.agentId).toBe('missing');
    expect(defaultChoice([], writable, memory)).toBeNull();
  });

  it('starts from the remembered model, effort and mode where they still exist', () => {
    expect(choiceFor(ready, { lastModel: { ready: 'small' }, lastEffort: {}, lastMode: { ready: 'accept-edits' } })).toEqual({ agentId: 'ready', model: 'small', effort: null, mode: 'accept-edits' });
    expect(choiceFor(ready, { lastModel: { ready: 'retired' }, lastEffort: { 'ready:large': 'high' }, lastMode: {} })).toEqual({ agentId: 'ready', model: 'large', effort: 'high', mode: 'ask' });
    // Auto is never where a conversation starts by itself.
    expect(choiceFor(ready, { lastModel: {}, lastEffort: {}, lastMode: { ready: 'auto' } }).mode).toBe('ask');
  });

  it('copes with an agent that lists no models', () => {
    const bare = agent('bare', { capabilities: { ...ready.capabilities, models: [], defaultModel: null } });
    expect(choiceFor(bare, memory)).toEqual({ agentId: 'bare', model: null, effort: null, mode: 'ask' });
  });

  it('clamps the effort to what the model has', () => {
    const large = ready.capabilities.models[0]!;
    expect(resolveEffort(large, 'high')).toBe('high');
    expect(resolveEffort(large, 'extreme')).toBe('medium');
    expect(resolveEffort(ready.capabilities.models[1], 'high')).toBeNull();
    expect(resolveEffort({ id: 'x', label: 'X', efforts: ['a', 'b', 'c'] }, null)).toBe('b');
  });

  it('steps through the modes without ever landing on auto', () => {
    const seen = new Set<string>();
    let mode = resolveMode(ready, undefined);
    for (let step = 0; step < 8; step += 1) {
      mode = nextMode(ready, mode);
      seen.add(mode);
    }
    expect([...seen].sort()).toEqual(['accept-edits', 'ask', 'plan']);
    expect(nextMode(ready, 'auto')).toBe('plan');
  });
});

describe('what the device remembers', () => {
  it('reads stored memory defensively', () => {
    expect(parseDeviceMemory(null)).toBe(DEFAULT_MEMORY);
    expect(parseDeviceMemory('nonsense')).toBe(DEFAULT_MEMORY);
    const parsed = parseDeviceMemory({ scope: 'all', lastProjectId: 5, lastConversation: { p: 's', q: 3 }, listCollapsed: 'yes', inspector: { open: true, panel: 'files', width: 99_999 }, lastMode: { demo: 'auto', other: 'root' } });
    expect(parsed).toMatchObject({ scope: 'all', lastProjectId: null, lastConversation: { p: 's' }, listCollapsed: false, inspector: { open: true, panel: 'files', width: INSPECTOR_MAX_WIDTH }, lastMode: { demo: 'auto' } });
  });

  it('keeps the inspector within its limits', () => {
    expect(clampInspectorWidth(10)).toBe(INSPECTOR_MIN_WIDTH);
    expect(clampInspectorWidth(500.4)).toBe(500);
    expect(clampInspectorWidth(Number.NaN)).toBe(440);
  });
});

describe('the inspector registry', () => {
  afterEach(() => __resetInspectorForTests());
  const load = async () => ({ default: () => null });
  const inProject = { project: { id: 'p' } as never, sessionId: null, role: 'member' as const };
  const nowhere = { project: null, sessionId: null, role: 'member' as const };

  it('lists the panels that can work here, in order — and none where none can', () => {
    registerInspectorPanel(
      { id: 'terminal', title: 'workbench.inspector.sample', icon: Terminal, order: 20, load, handles: ['run-command'] },
      { id: 'files', title: 'workbench.inspector.sample', icon: FolderTree, order: 10, load, handles: ['open-file', 'reveal-folder'] },
      { id: 'owner-only', title: 'workbench.inspector.sample', icon: Terminal, load, available: (context) => context.role === 'owner' },
    );
    expect(inspectorPanels(inProject).map((panel) => panel.id)).toEqual(['files', 'terminal']);
    expect(inspectorPanels({ ...inProject, role: 'owner' }).map((panel) => panel.id)).toEqual(['files', 'terminal', 'owner-only']);
    // By default a panel needs a project.
    expect(inspectorPanels(nowhere)).toEqual([]);
  });

  it('finds the panel that answers a request, or says there is none', () => {
    registerInspectorPanel({ id: 'files', title: 'workbench.inspector.sample', icon: FolderTree, load, handles: ['open-file'] });
    expect(panelHandling('open-file', inProject)?.id).toBe('files');
    expect(panelHandling('run-command', inProject)).toBeNull();
    expect(panelHandling('open-file', nowhere)).toBeNull();
  });

  it('refuses a panel registered twice or with an unusable id', () => {
    registerInspectorPanel({ id: 'files', title: 'workbench.inspector.sample', icon: FolderTree, load });
    expect(() => registerInspectorPanel({ id: 'files', title: 'workbench.inspector.sample', icon: FolderTree, load })).toThrow(/twice/);
    expect(() => registerInspectorPanel({ id: 'My Panel', title: 'workbench.inspector.sample', icon: FolderTree, load })).toThrow(/valid/);
  });
});

describe('the run status line', () => {
  const RUN = '01rrrrrrrrrrrrrrrrrrrrrrr1';
  const at = (seq: number) => 1000 + seq;
  const events: SessionEvent[] = [
    { seq: 1, at: at(1), type: 'message.user', data: { runId: RUN, requestId: 'r1', origin: 'interactive', text: 'go', attachments: [], quote: null, continuesRunId: null } },
    { seq: 2, at: at(2), type: 'run.started', data: { runId: RUN, agentId: 'demo', model: null, effort: null, permissionMode: 'ask', origin: 'interactive' } },
  ];
  const tool = (seq: number, id: string, parent: string | null = null): SessionEvent => ({
    seq,
    at: at(seq),
    type: 'tool.started',
    data: { runId: RUN, toolCallId: id, name: 'Bash', kind: 'execute', title: `Run ${id}`, input: { command: id }, inputTruncated: false, parentToolCallId: parent },
  });
  const base = () => events.reduce(applyEvent, initialTranscript('s'));

  it('is absent when nothing runs', () => {
    expect(runProgress(initialTranscript('s'))).toBeNull();
  });

  it('says the run is starting until the agent has begun', () => {
    expect(runProgress(applyEvent(initialTranscript('s'), events[0]!))?.activity.phase).toBe('starting');
    expect(runProgress(base())).toMatchObject({ activity: { phase: 'working' }, since: at(2), steps: 0 });
  });

  it('names the tool at work — the innermost one when a sub-agent is running', () => {
    let state = applyEvent(base(), tool(3, 'npm test'));
    expect(runProgress(state)).toMatchObject({ activity: { phase: 'tool', tool: { toolCallId: 'npm test' } }, steps: 1 });
    state = applyEvent(state, tool(4, 'inner', 'npm test'));
    expect(runProgress(state)).toMatchObject({ activity: { phase: 'tool', tool: { toolCallId: 'inner' } }, steps: 1 });
  });

  it('tells writing from thinking', () => {
    const writing = applyLive(base(), { type: 'message.delta', data: { runId: RUN, messageId: 'm', offset: 0, text: 'Hi', parentToolCallId: null } });
    expect(runProgress(writing)?.activity.phase).toBe('writing');
    const thinking = applyLive(base(), { type: 'thinking.delta', data: { runId: RUN, messageId: 't', offset: 0, text: 'Hm', parentToolCallId: null } });
    expect(runProgress(thinking)?.activity.phase).toBe('thinking');
  });

  it('puts "waiting for you" before everything else', () => {
    const approval = { id: 'a1', runId: RUN, kind: 'tool', title: 'Run npm test' } as Approval;
    const state = applySnapshot(applyEvent(base(), tool(3, 'npm test')), {
      sessionId: 's',
      lastSeq: 3,
      run: { id: RUN, status: 'running', startedAt: at(2), createdAt: at(1) } as never,
      streaming: [],
      toolOutput: [],
      pendingApprovals: [approval, { ...approval, id: 'a2' }],
      queue: [],
      unresolvedRuns: [],
    });
    expect(runProgress(state)).toMatchObject({ activity: { phase: 'waiting', approval: { id: 'a1' }, more: 1 } });
  });

  it('writes elapsed time without jumping in width', () => {
    const labels = { seconds: 's', minutes: 'min', hours: 'h' };
    expect(formatElapsed(8_400, labels)).toBe('8 s');
    expect(formatElapsed(125_000, labels)).toBe('2 min 05 s');
    expect(formatElapsed(4_320_000, labels)).toBe('1 h 12 min');
  });

  it('gives the common failures words of their own, with the server’s sentence underneath', () => {
    expect(describeOutcome('completed', null, false)).toMatchObject({ title: 'workbench.run.completed', tone: 'positive' });
    expect(describeOutcome('stopped', null, false)).toMatchObject({ title: 'workbench.run.stopped', tone: 'neutral' });
    expect(describeOutcome('interrupted', { code: 'server_restart', message: 'x' }, true)).toMatchObject({ title: 'workbench.run.interruptedByRestart', tone: 'warning' });
    for (const [code, title] of [
      ['not_installed', 'workbench.runError.not_installed'],
      ['not_signed_in', 'workbench.runError.not_signed_in'],
      ['rate_limited', 'workbench.runError.rate_limited'],
      ['usage_limit', 'workbench.runError.rate_limited'],
    ] as const) {
      expect(describeOutcome('failed', { code, message: 'The details.' }, false)).toEqual({ title, detail: 'The details.', tone: 'danger' });
    }
    expect(describeOutcome('failed', { code: 'something_new', message: 'It broke.' }, false)).toEqual({ title: 'workbench.run.failed', detail: 'It broke.', tone: 'danger' });
  });
});

describe('the context ring', () => {
  const withWindow = agent('a');
  const reading = (tokens: number, window: number | null, model = 'large') => ({ tokens, window, model, at: 1 });

  it.each([
    [reading(40_000, 200_000), 0.2, 'normal'],
    [reading(160_000, 200_000), 0.8, 'warning'],
    [reading(190_000, 200_000), 0.95, 'danger'],
    [reading(999_999, 200_000), 1, 'danger'],
  ] as const)('%o → %s %s', (context, fraction, tone) => {
    expect(contextLevel(context, withWindow)).toMatchObject({ fraction, tone });
  });

  it('takes the window from the agent when the report leaves it out, and shows no percentage when nobody knows it', () => {
    expect(contextLevel(reading(100_000, null), withWindow)).toMatchObject({ fraction: 0.5, window: 200_000 });
    expect(contextLevel(reading(100_000, null, 'small'), withWindow)).toEqual({ fraction: null, window: null, tone: 'normal' });
    expect(contextLevel(reading(100_000, null), undefined)).toEqual({ fraction: null, window: null, tone: 'normal' });
    expect(contextLevel(null, withWindow).fraction).toBeNull();
  });
});
