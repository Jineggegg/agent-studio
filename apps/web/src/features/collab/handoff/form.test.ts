import { COLLAB_LIMITS, handoffRequestSchema } from '@agent-studio/protocol';
import { describe, expect, it } from 'vitest';
import { agent } from '../testing';
import { carriedMode, draftProblem, handoffRequest, handoffTargets, initialDraft, summaryWriters } from './form';

const claude = agent('claude-code');
const codex = agent('codex', { modes: ['plan', 'ask', 'auto'] });
const signedOut = agent('gemini', { signedIn: false });
const missing = agent('aider', { installed: false });
const chatOnly = agent('api-chat', { kind: 'api', modes: ['ask'] });
const all = [claude, codex, signedOut, missing, chatOnly];

describe('who may take a conversation over', () => {
  it('lists the agents that can continue first, and says why each other one cannot', () => {
    const targets = handoffTargets(all, { agents: null }, 'claude-code');
    expect(targets.map((entry) => [entry.agent.id, entry.blocked])).toEqual([
      ['codex', null],
      ['api-chat', null],
      ['claude-code', 'same-agent'],
      ['gemini', 'not-signed-in'],
      ['aider', 'not-installed'],
    ]);
  });

  it('only offers the agents the project offers', () => {
    const targets = handoffTargets(all, { agents: ['claude-code', 'codex'] }, 'claude-code');
    expect(targets.find((entry) => entry.agent.id === 'api-chat')?.blocked).toBe('not-offered');
    expect(targets.find((entry) => entry.agent.id === 'codex')?.blocked).toBeNull();
  });

  it('lets only agents that can work read-only, signed in and offered, write the summary', () => {
    expect(summaryWriters(all, { agents: null }).map((writer) => writer.id)).toEqual(['claude-code', 'codex']);
    expect(summaryWriters(all, { agents: ['codex'] }).map((writer) => writer.id)).toEqual(['codex']);
  });

  it('carries the conversation’s mode over where the new agent has it, else asks', () => {
    expect(carriedMode(codex, 'auto')).toBe('auto');
    expect(carriedMode(codex, 'accept-edits')).toBe('ask');
    expect(carriedMode(agent('odd', { modes: ['plan'] }), 'ask')).toBe('plan');
    expect(carriedMode(undefined, 'ask')).toBeNull();
  });
});

describe('the handoff request', () => {
  const targets = handoffTargets(all, { agents: null }, 'claude-code');
  const writers = summaryWriters(all, { agents: null });

  it('starts from the first agent that can continue, its default model, the digest, nothing sent', () => {
    const draft = initialDraft(targets, 'accept-edits', writers);
    expect(draft).toMatchObject({ agentId: 'codex', model: 'codex-large', permissionMode: 'ask', brief: 'digest', summaryAgentId: 'claude-code', note: '', start: false });
    expect(draftProblem(draft, targets, writers)).toBeNull();
  });

  it('becomes a request the server accepts: the digest, opened only', () => {
    const request = handoffRequest(initialDraft(targets, 'ask', writers), 'req-1');
    expect(request).toEqual({ requestId: 'req-1', agentId: 'codex', model: 'codex-large', permissionMode: 'ask', start: false });
    expect(handoffRequestSchema.safeParse(request).success).toBe(true);
  });

  it('asks for a summary by the chosen writer, sends the trimmed note and starts at once', () => {
    const draft = { ...initialDraft(targets, 'ask', writers), brief: 'summary' as const, summaryAgentId: 'codex', summaryModel: 'codex-small', note: '  Please finish the tests.  ', start: true };
    const request = handoffRequest(draft, 'req-2');
    expect(request).toEqual({ requestId: 'req-2', agentId: 'codex', model: 'codex-large', permissionMode: 'ask', note: 'Please finish the tests.', start: true, summary: { agentId: 'codex', model: 'codex-small' } });
    expect(handoffRequestSchema.safeParse(request).success).toBe(true);
  });

  it('leaves out an empty note and a summary that was not asked for', () => {
    const draft = { ...initialDraft(targets, 'ask', writers), note: '   ', summaryAgentId: 'codex' };
    const request = handoffRequest(draft, 'req-3');
    expect(request).not.toHaveProperty('note');
    expect(request).not.toHaveProperty('summary');
  });

  it('refuses a draft that cannot be sent, saying which rule it breaks', () => {
    const base = initialDraft(targets, 'ask', writers);
    expect(draftProblem({ ...base, agentId: null }, targets, writers)).toBe('no-agent');
    expect(draftProblem({ ...base, agentId: 'claude-code' }, targets, writers)).toBe('blocked-agent');
    expect(draftProblem({ ...base, agentId: 'gemini' }, targets, writers)).toBe('blocked-agent');
    expect(draftProblem({ ...base, brief: 'summary', summaryAgentId: 'gemini' }, targets, writers)).toBe('no-writer');
    expect(draftProblem({ ...base, note: 'x'.repeat(COLLAB_LIMITS.noteChars + 1) }, targets, writers)).toBe('note-too-long');
    expect(() => handoffRequest({ ...base, agentId: null }, 'r')).toThrow();
  });
});
