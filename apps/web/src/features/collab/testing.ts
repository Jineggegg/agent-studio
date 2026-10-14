import type { Agent, PermissionMode, Session, Task, TaskParticipant } from '@agent-studio/protocol';

/** Builders for the collab tests: an agent, a session, a task — complete, with what a test needs changed. */

export function agent(id: string, overrides: { installed?: boolean; signedIn?: boolean; modes?: PermissionMode[]; models?: string[]; kind?: 'cli' | 'api' } = {}): Agent {
  const models = overrides.models ?? [`${id}-large`, `${id}-small`];
  return {
    id,
    displayName: id.replace(/(^|-)(\w)/g, (_, gap: string, letter: string) => `${gap ? ' ' : ''}${letter.toUpperCase()}`),
    kind: overrides.kind ?? 'cli',
    capabilities: {
      models: models.map((model, index) => ({ id: model, label: model, ...(index === 0 ? { recommended: true } : {}) })),
      defaultModel: models[0] ?? null,
      permissionModes: overrides.modes ?? ['plan', 'ask', 'accept-edits', 'auto'],
      images: true,
      steering: true,
      resume: true,
      planMode: true,
      usage: true,
    },
    status: { installed: overrides.installed ?? true, version: '1.0.0', signedIn: overrides.signedIn ?? true, account: 'me@example.test', problem: null },
  };
}

let sequence = 0;
/** A 26-character id, distinct per call and sorting by call order. */
export function id(): string {
  sequence += 1;
  return sequence.toString(36).padStart(26, '0');
}

export function session(overrides: Partial<Session> = {}): Session {
  return {
    id: id(),
    projectId: '0000000000000000000000proj',
    userId: '0000000000000000000000user',
    agentId: 'claude-code',
    model: null,
    effort: null,
    permissionMode: 'ask',
    effectivePermissionMode: 'ask',
    title: 'A conversation',
    titleSource: 'manual',
    pinned: false,
    archived: false,
    chainId: null,
    parentSessionId: null,
    attention: 'none',
    activeRunId: null,
    hasDraft: false,
    resumable: false,
    lastSeq: 1,
    lastActivityAt: 1_000,
    lastUserMessageAt: 1_000,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

export function participant(overrides: Partial<TaskParticipant> = {}): TaskParticipant {
  return {
    position: 1,
    agentId: 'claude-code',
    agentName: 'Claude Code',
    model: null,
    effort: null,
    permissionMode: 'plan',
    sessionId: id(),
    sessionProjectId: '0000000000000000000000proj',
    runId: id(),
    link: null,
    state: 'running',
    acknowledged: false,
    error: null,
    startedAt: 1_000,
    finishedAt: null,
    durationMs: null,
    answer: null,
    usage: null,
    worktree: null,
    ...overrides,
  };
}

export function task(overrides: Partial<Task> = {}): Task {
  return {
    id: id(),
    projectId: '0000000000000000000000proj',
    userId: '0000000000000000000000user',
    title: 'Compare approaches',
    prompt: 'How should we cache this?',
    promptTruncated: false,
    isolation: 'shared',
    state: 'running',
    participants: [participant({ position: 1 }), participant({ position: 2, agentId: 'codex', agentName: 'Codex' })],
    synthesis: null,
    stoppedAt: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    finishedAt: null,
    ...overrides,
  };
}
