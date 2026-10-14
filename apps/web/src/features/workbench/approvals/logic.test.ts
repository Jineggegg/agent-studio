import { describe, expect, it } from 'vitest';
import { ApiError } from '@/data/api';
import { ME, OTHER, makeApproval } from './testing';
import { approvalChoices, collectAnswers, decisionFailure, describeRule, emptyAnswer, formatCountdown, isAnswered, secondsLeft, toggleOption, toggleOther, usableQuestions } from './logic';

describe('what an approval may be answered with', () => {
  it('offers allow, deny and all three ways to remember for an ordinary request of your own', () => {
    expect(approvalChoices(makeApproval(), { userId: ME, role: 'member' })).toEqual({
      canAnswer: true,
      canAllow: true,
      canDeny: true,
      waitingForOwner: false,
      remember: ['session', 'project', 'always'],
    });
  });

  it.each([
    ['the server suggests no rule', makeApproval({ suggestedRule: null }), ME, 'owner', []],
    ['the session is in no project', makeApproval({ projectId: null }), ME, 'owner', ['session', 'always']],
    ['it is a plan', makeApproval({ kind: 'plan', suggestedRule: null }), ME, 'owner', []],
    ['it is a question', makeApproval({ kind: 'question', suggestedRule: null }), ME, 'owner', []],
    ['it is dangerous, even for the owner', makeApproval({ risk: 'dangerous', requiresOwner: true }), ME, 'owner', []],
    ["it is someone else's run, even for the owner", makeApproval({ userId: OTHER }), ME, 'owner', []],
  ] as const)('offers the remember choices the request allows when %s', (_name, approval, userId, role, expected) => {
    expect(approvalChoices(approval, { userId, role }).remember).toEqual(expected);
  });

  it('lets only the owner allow a dangerous request; a member sees that it waits for the owner and may still deny', () => {
    const dangerous = makeApproval({ risk: 'dangerous', requiresOwner: true, suggestedRule: null });
    expect(approvalChoices(dangerous, { userId: ME, role: 'member' })).toMatchObject({ canAnswer: true, canAllow: false, canDeny: true, waitingForOwner: true, remember: [] });
    expect(approvalChoices(dangerous, { userId: ME, role: 'owner' })).toMatchObject({ canAllow: true, waitingForOwner: false });
    expect(approvalChoices(makeApproval({ userId: OTHER, risk: 'dangerous', requiresOwner: true }), { userId: ME, role: 'owner' })).toMatchObject({ canAllow: true, canDeny: true });
  });

  it('offers nothing to someone who may not answer, or once it is answered', () => {
    expect(approvalChoices(makeApproval({ userId: OTHER }), { userId: ME, role: 'member' })).toMatchObject({ canAnswer: false, canAllow: false, canDeny: false, remember: [] });
    expect(approvalChoices(makeApproval({ status: 'allowed' }), { userId: ME, role: 'owner' })).toMatchObject({ canAnswer: false, canAllow: false, canDeny: false, waitingForOwner: false, remember: [] });
  });

  it('shows the rule the way it will be saved', () => {
    expect(describeRule({ tool: 'Bash', pattern: 'npm test *' })).toBe('Bash(npm test *)');
    expect(describeRule({ tool: 'Edit', pattern: null })).toBe('Edit');
  });
});

describe('a decision the server refused', () => {
  it('reads a lost race as "already answered", not as an error', () => {
    expect(decisionFailure(new ApiError(409, 'approval_resolved', 'That request has already been answered.', { status: 'denied' }))).toEqual({ kind: 'already-answered', status: 'denied' });
    expect(decisionFailure(new ApiError(409, 'approval_resolved', 'x'))).toEqual({ kind: 'already-answered', status: null });
  });

  it.each([
    [new ApiError(403, 'owner_required', 'x'), 'owner-required'],
    [new ApiError(403, 'remember_not_allowed', 'x'), 'remember-refused'],
    [new ApiError(422, 'remember_not_allowed', 'x'), 'remember-refused'],
    [new ApiError(404, 'approval_not_found', 'x'), 'gone'],
    [new ApiError(0, 'network_error', 'x'), 'error'],
    [new Error('boom'), 'error'],
  ])('%o → %s', (error, kind) => {
    expect(decisionFailure(error).kind).toBe(kind);
  });
});

describe('the expiry countdown', () => {
  it('counts down to the moment the server resolves it, and stops at zero', () => {
    expect(secondsLeft({ expiresAt: 61_000 }, 0)).toBe(61);
    expect(secondsLeft({ expiresAt: 61_000 }, 60_500)).toBe(1);
    expect(secondsLeft({ expiresAt: 61_000 }, 99_000)).toBe(0);
    expect(secondsLeft({ expiresAt: null }, 0)).toBeNull();
  });

  it.each([
    [0, '0:00'],
    [9, '0:09'],
    [245, '4:05'],
    [3750, '1:02:30'],
  ])('%i s → %s', (seconds, text) => {
    expect(formatCountdown(seconds)).toBe(text);
  });
});

describe('answering questions', () => {
  const single = { id: 'runner', question: 'Which runner?', options: [{ label: 'Vitest' }, { label: 'Jest' }], multiSelect: false };
  const multi = { id: 'targets', question: 'Which platforms?', options: [{ label: 'Linux' }, { label: 'macOS' }], multiSelect: true };

  it('keeps one choice for a single-choice question and several for a multi-choice one', () => {
    let answer = toggleOption(single, emptyAnswer(), 'Vitest');
    answer = toggleOption(single, answer, 'Jest');
    expect(answer.selected).toEqual(['Jest']);
    expect(toggleOption(single, answer, 'Jest').selected).toEqual([]);

    let many = toggleOption(multi, emptyAnswer(), 'Linux');
    many = toggleOption(multi, many, 'macOS');
    expect(many.selected).toEqual(['Linux', 'macOS']);
    expect(toggleOption(multi, many, 'Linux').selected).toEqual(['macOS']);
  });

  it('treats "Other" as one more choice: exclusive when single, additional when multi', () => {
    const picked = toggleOption(single, emptyAnswer(), 'Vitest');
    expect(toggleOther(single, picked)).toEqual({ selected: [], other: '', otherOpen: true });
    const many = toggleOption(multi, emptyAnswer(), 'Linux');
    expect(toggleOther(multi, many)).toEqual({ selected: ['Linux'], other: '', otherOpen: true });
    // Picking an option again closes "Other" for a single-choice question.
    expect(toggleOption(single, { selected: [], other: 'bun', otherOpen: true }, 'Jest')).toEqual({ selected: ['Jest'], other: '', otherOpen: false });
  });

  it('sends only the questions that were answered', () => {
    const drafts = { runner: { selected: ['Vitest'], other: '', otherOpen: false }, targets: emptyAnswer() };
    expect(collectAnswers([single, multi], drafts)).toEqual([{ questionId: 'runner', selected: ['Vitest'] }]);
    const withOther = { runner: emptyAnswer(), targets: { selected: ['Linux', 'macOS'], other: '  FreeBSD ', otherOpen: true } };
    expect(collectAnswers([single, multi], withOther)).toEqual([{ questionId: 'targets', selected: ['Linux', 'macOS'], other: 'FreeBSD' }]);
    expect(isAnswered({ selected: [], other: '   ', otherOpen: true })).toBe(false);
  });

  it('drops questions with neither text nor options, so a malformed request can still be dismissed', () => {
    expect(usableQuestions({ questions: [{ id: 'x', question: ' ', options: [], multiSelect: false }, single] })).toEqual([single]);
    expect(usableQuestions({ questions: null })).toEqual([]);
  });
});
