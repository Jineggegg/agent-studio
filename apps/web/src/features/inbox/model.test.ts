import type { Inbox, InboxItem } from '@agent-studio/protocol';
import { describe, expect, it } from 'vitest';
import { getTranslator } from '@/i18n';
import { acknowledgeRefusal, isEmpty, itemDetail, itemTitle, withoutAcknowledged } from './model';

const t = getTranslator('en');

function item(kind: InboxItem['kind'], overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: `${kind}-1`,
    kind,
    runId: `run-${kind}`.padEnd(26, '0'),
    sessionId: 'session'.padEnd(26, '0'),
    projectId: null,
    projectName: null,
    userId: 'user'.padEnd(26, '0'),
    agentId: 'claude-code',
    agentName: 'Claude Code',
    title: 'Fix the login form',
    preview: 'Please fix the login form',
    runStatus: kind === 'running' ? 'running' : kind === 'result' ? 'completed' : 'failed',
    updatedAt: 0,
    link: '/',
    approval: null,
    error: null,
    interruptedByRestart: false,
    acknowledgeable: kind === 'result' || kind === 'needs-handling',
    ...overrides,
  };
}

function inbox(groups: Partial<Inbox['groups']>): Inbox {
  const full = { approvals: [], needsHandling: [], results: [], running: [], ...groups };
  return {
    groups: full,
    counts: { approvals: full.approvals.length, needsHandling: full.needsHandling.length, results: full.results.length, running: full.running.length },
    truncated: false,
    checkedAt: 0,
  };
}

describe('the inbox', () => {
  it('says what each row waits for, why it stopped, or how it ended — never what a tool was asked to do', () => {
    expect(itemDetail(item('approval', { approval: { id: 'a'.repeat(26), kind: 'tool', toolName: 'Bash', requiresOwner: false, expiresAt: null } }), t)).toBe('Waiting for approval · Bash');
    expect(itemDetail(item('approval', { approval: { id: 'a'.repeat(26), kind: 'tool', toolName: null, requiresOwner: true, expiresAt: null } }), t)).toBe('Waiting for you to approve a tool action · only an owner can decide');
    expect(itemDetail(item('approval', { approval: { id: 'a'.repeat(26), kind: 'question', toolName: null, requiresOwner: false, expiresAt: null } }), t)).toBe('Waiting for your answer');
    expect(itemDetail(item('approval', { approval: { id: 'a'.repeat(26), kind: 'plan', toolName: null, requiresOwner: false, expiresAt: null } }), t)).toBe('Waiting for you to confirm the plan');
    expect(itemDetail(item('needs-handling', { interruptedByRestart: true, runStatus: 'interrupted' }), t)).toBe('Interrupted by a restart of the server');
    expect(itemDetail(item('needs-handling', { error: 'The agent is not signed in.' }), t)).toBe('Failed · The agent is not signed in.');
    expect(itemDetail(item('running', { runStatus: 'accepted' }), t)).toBe('Waiting to start');
    expect(itemDetail(item('result', { preview: '' }), t)).toBe('Finished');
    expect(itemTitle(item('result', { title: '', preview: 'Line one\nline two' }), t)).toBe('Line one');
  });

  it('keeps a row that was put away off the screen, even when an older read still has it', () => {
    const result = item('result');
    const failed = item('needs-handling');
    const approval = item('approval');
    const before = inbox({ results: [result], needsHandling: [failed], approvals: [approval] });
    const after = withoutAcknowledged(before, new Set([result.runId, failed.runId, approval.runId]));
    expect(after.groups.results).toEqual([]);
    expect(after.groups.needsHandling).toEqual([]);
    // An approval can never be put away from here: it stays until it is decided in its session.
    expect(after.groups.approvals).toEqual([approval]);
    expect(after.counts).toMatchObject({ results: 0, needsHandling: 0, approvals: 1 });
    expect(withoutAcknowledged(before, new Set())).toBe(before);
    expect(isEmpty(inbox({}))).toBe(true);
  });

  it('explains the two refusals, both saying that nothing was approved or started', () => {
    expect(acknowledgeRefusal('queue_waiting', t)).toMatch(/would send them, so nothing was changed/);
    expect(acknowledgeRefusal('task_in_progress', t)).toMatch(/Nothing was changed/);
    expect(acknowledgeRefusal('something_else', t)).toBeNull();
  });
});
