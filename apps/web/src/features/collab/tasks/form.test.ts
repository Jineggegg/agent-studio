import { COLLAB_LIMITS, createTaskRequestSchema } from '@agent-studio/protocol';
import { describe, expect, it } from 'vitest';
import { agent } from '../testing';
import { initialTaskDraft, moveDraft, participantBlock, participantFor, repositoryReady, taskProblems, taskRequest, usableAgents } from './form';

const claude = agent('claude-code');
const codex = agent('codex');
const signedOut = agent('gemini', { signedIn: false });
const noPlan = agent('quick', { modes: ['ask'] });
const all = [claude, codex, signedOut, noPlan];

describe('who can take part in a task', () => {
  it('says why an agent cannot', () => {
    expect(participantBlock(signedOut, null)).toBe('not-signed-in');
    expect(participantBlock(agent('x', { installed: false }), null)).toBe('not-installed');
    expect(participantBlock(codex, { agents: ['claude-code'] })).toBe('not-offered');
    expect(participantBlock(codex, { agents: null })).toBeNull();
    expect(usableAgents(all, { agents: null }).map((entry) => entry.id)).toEqual(['claude-code', 'codex', 'quick']);
  });

  it('starts with two participants — the same agent twice when only one can take part', () => {
    expect(initialTaskDraft([claude, codex], 'p').participants.map((entry) => entry.agentId)).toEqual(['claude-code', 'codex']);
    expect(initialTaskDraft([claude], 'p').participants.map((entry) => entry.agentId)).toEqual(['claude-code', 'claude-code']);
    expect(initialTaskDraft([], 'p').participants).toEqual([]);
  });

  it('gives a participant its agent’s default model and a mode that is never Auto by itself', () => {
    expect(participantFor(codex)).toMatchObject({ agentId: 'codex', model: 'codex-large', permissionMode: 'ask' });
    expect(participantFor(agent('auto-first', { modes: ['auto', 'plan'] })).permissionMode).toBe('plan');
  });
});

describe('the rules a task meets before it is sent', () => {
  const usable = usableAgents(all, { agents: null });
  const ready = { ...initialTaskDraft(usable, 'project'), prompt: 'Which cache should we use?' };

  it('accepts a complete draft', () => {
    expect(taskProblems(ready, usable, false)).toEqual([]);
  });

  it('names every broken rule', () => {
    expect(taskProblems({ ...ready, projectId: null }, usable, false)).toEqual(['no-project']);
    expect(taskProblems({ ...ready, prompt: '   ' }, usable, false)).toEqual(['no-prompt']);
    expect(taskProblems({ ...ready, prompt: 'x'.repeat(COLLAB_LIMITS.taskPromptChars + 1) }, usable, false)).toEqual(['prompt-too-long']);
    expect(taskProblems({ ...ready, title: 'x'.repeat(COLLAB_LIMITS.taskTitleChars + 1) }, usable, false)).toEqual(['title-too-long']);
    expect(taskProblems({ ...ready, participants: ready.participants.slice(0, 1) }, usable, false)).toEqual(['too-few']);
    const seven = Array.from({ length: 7 }, () => participantFor(claude));
    expect(taskProblems({ ...ready, participants: seven }, usable, false)).toEqual(['too-many']);
    expect(taskProblems({ ...ready, participants: [...ready.participants, participantFor(signedOut)] }, usable, false)).toEqual(['participant-unusable']);
    expect(taskProblems({ ...ready, isolation: 'worktrees' }, usable, false)).toEqual(['worktrees-owner-only']);
    expect(taskProblems({ ...ready, isolation: 'worktrees' }, usable, true)).toEqual([]);
    expect(taskProblems({ ...ready, synthesis: true, synthesisAgentId: 'quick' }, usable, false)).toEqual(['synthesis-unusable']);
  });

  it('wants a ready Git repository with a commit for a worktree each, once the project’s state is known', () => {
    expect(repositoryReady({ state: 'ready', hasCommits: true })).toBe(true);
    expect(repositoryReady({ state: 'ready', hasCommits: false })).toBe(false);
    expect(repositoryReady({ state: 'none', hasCommits: false })).toBe(false);
    expect(repositoryReady({ state: 'bare', hasCommits: true })).toBe(false);
    const worktrees = { ...ready, isolation: 'worktrees' as const };
    expect(taskProblems(worktrees, usable, true, null)).toEqual([]);
    expect(taskProblems(worktrees, usable, true, true)).toEqual([]);
    expect(taskProblems(worktrees, usable, true, false)).toEqual(['needs-repository']);
    // One folder needs no repository; a member hears first that worktrees are the owner's.
    expect(taskProblems(ready, usable, true, false)).toEqual([]);
    expect(taskProblems(worktrees, usable, false, false)).toEqual(['worktrees-owner-only']);
    expect(taskProblems({ ...ready, synthesis: true, synthesisAgentId: 'codex' }, usable, false)).toEqual([]);
  });
});

describe('moving a draft to another project', () => {
  it('keeps what was written and chosen, and replaces only what the new project does not offer', () => {
    const everywhere = usableAgents(all, { agents: null });
    const draft = { ...initialTaskDraft(everywhere, 'a'), prompt: 'Compare', title: 'Cache', isolation: 'worktrees' as const, synthesis: true, synthesisAgentId: 'codex', synthesisModel: 'm' };
    const same = moveDraft(draft, everywhere, 'b');
    expect(same).toMatchObject({ projectId: 'b', prompt: 'Compare', title: 'Cache', isolation: 'worktrees', synthesis: true, synthesisAgentId: 'codex', synthesisModel: 'm' });
    expect(same.participants).toBe(draft.participants);

    // A project that offers Codex only: both participants become Codex, and Codex still compares.
    const codexOnly = usableAgents(all, { agents: ['codex'] });
    const moved = moveDraft({ ...draft, synthesisAgentId: 'claude-code' }, codexOnly, 'c');
    expect(moved.participants.map((participant) => participant.agentId)).toEqual(['codex', 'codex']);
    expect(moved).toMatchObject({ isolation: 'worktrees', synthesis: true, synthesisAgentId: 'codex', synthesisModel: null });
  });
});

describe('the task request', () => {
  const usable = usableAgents(all, { agents: null });
  const ready = { ...initialTaskDraft(usable, 'project'), prompt: 'Which cache should we use?' };

  it('in one shared folder sends no mode: the server makes every participant plan', () => {
    const request = taskRequest({ ...ready, participants: ready.participants.map((entry) => ({ ...entry, permissionMode: 'accept-edits' as const })) }, 'req-1');
    expect(request).toEqual({
      requestId: 'req-1',
      prompt: 'Which cache should we use?',
      isolation: 'shared',
      participants: [
        { agentId: 'claude-code', model: 'claude-code-large' },
        { agentId: 'codex', model: 'codex-large' },
      ],
    });
    expect(createTaskRequestSchema.safeParse(request).success).toBe(true);
  });

  it('with a worktree each sends each participant’s mode, the trimmed name and the comparison', () => {
    const request = taskRequest({ ...ready, isolation: 'worktrees', title: '  Cache choice ', synthesis: true, synthesisAgentId: 'codex', synthesisModel: 'codex-small' }, 'req-2');
    expect(request).toEqual({
      requestId: 'req-2',
      title: 'Cache choice',
      prompt: 'Which cache should we use?',
      isolation: 'worktrees',
      participants: [
        { agentId: 'claude-code', model: 'claude-code-large', permissionMode: 'ask' },
        { agentId: 'codex', model: 'codex-large', permissionMode: 'ask' },
      ],
      synthesis: { agentId: 'codex', model: 'codex-small' },
    });
    expect(createTaskRequestSchema.safeParse(request).success).toBe(true);
  });

  it('sends the same request id every time it is sent, so a retry starts nothing twice', () => {
    expect(taskRequest(ready, 'same').requestId).toBe(taskRequest(ready, 'same').requestId);
  });
});
