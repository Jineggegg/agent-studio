import type { Approval, User } from '@agent-studio/protocol';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/data/api';
import { resetSessionStore, useSession } from '@/data/session';
import { toast } from '@/ui';
import { __resetOverlaysForTests } from '@/ui/overlay';
import { ApprovalDock, ApprovalSheet } from './ApprovalSurface';
import { planContinuationModes } from './logic';
import { ME, makeApproval } from './testing';

const api = vi.hoisted(() => ({ decide: vi.fn() }));
vi.mock('../api', () => ({ workbenchApi: api, SEND_TIMEOUT_MS: 20_000 }));


function signIn(role: User['role']) {
  useSession.setState({
    status: 'ready',
    authenticated: true,
    user: { id: ME, username: 'me', displayName: 'Me', role, disabled: false, createdAt: 0 } as User,
  });
}

function dock(approval: Approval, extra: { more?: number; continuation?: ('ask' | 'accept-edits' | 'auto')[] } = {}) {
  const onStale = vi.fn();
  const onDetails = vi.fn();
  const view = render(<ApprovalDock approval={approval} agentName="Demo agent" more={extra.more ?? 0} onStale={onStale} onDetails={onDetails} {...(extra.continuation ? { continuation: extra.continuation } : {})} />);
  return { ...view, onStale, onDetails };
}

const button = (name: string | RegExp) => screen.getByRole('button', { name });
const queryButton = (name: string | RegExp) => screen.queryByRole('button', { name });
const answered = (approval: Approval, status: Approval['status'] = 'allowed') => ({ approval: { ...approval, status }, rule: null, alsoResolved: [] });

beforeEach(() => {
  signIn('member');
  api.decide.mockReset();
  toast.clear();
});
afterEach(() => {
  resetSessionStore();
  __resetOverlaysForTests();
  vi.restoreAllMocks();
});

describe('a tool approval', () => {
  it('says what is asked, in words, with the exact command and the reason', () => {
    dock(makeApproval(), { more: 2 });
    expect(screen.getByText('Demo agent wants to run a command')).toBeInTheDocument();
    expect(screen.getByText('npm test')).toBeInTheDocument();
    expect(screen.getByText('This changes something, so it needs your approval.')).toBeInTheDocument();
    expect(screen.getByText(/2 more waiting/)).toBeInTheDocument();
  });

  it('allows and denies with one press each', async () => {
    const approval = makeApproval();
    api.decide.mockResolvedValue(answered(approval));
    dock(approval);
    fireEvent.click(button('Allow'));
    await waitFor(() => expect(api.decide).toHaveBeenCalledWith(approval.id, { decision: 'allow' }));
    fireEvent.click(button('Deny'));
    await waitFor(() => expect(api.decide).toHaveBeenLastCalledWith(approval.id, { decision: 'deny' }));
  });

  it('offers to remember exactly where the server allows it, showing the rule that would be saved', async () => {
    const approval = makeApproval();
    api.decide.mockResolvedValue({ ...answered(approval), rule: { id: 'r', scope: 'project', projectId: approval.projectId, sessionId: null, effect: 'allow', tool: 'Bash', pattern: 'npm test *', shared: false, createdBy: ME, createdAt: 0 } });
    const success = vi.spyOn(toast, 'success');
    dock(approval);
    fireEvent.click(button(/Allow and remember/));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['For this conversationBash(npm test *)', 'For this projectBash(npm test *)', 'AlwaysBash(npm test *)']);
    fireEvent.click(within(menu).getByRole('menuitem', { name: /For this project/ }));
    await waitFor(() => expect(api.decide).toHaveBeenCalledWith(approval.id, { decision: 'allow', remember: 'project' }));
    await waitFor(() => expect(success).toHaveBeenCalledWith('Saved the rule Bash(npm test *)'));
  });

  it.each([
    ['the server suggests no rule (a request that must be approved each time)', makeApproval({ suggestedRule: null })],
    ['the request is dangerous', makeApproval({ risk: 'dangerous', requiresOwner: true, riskCategories: ['download-exec'] })],
  ])('does not offer to remember when %s', (_name, approval) => {
    signIn('owner');
    dock(approval);
    expect(queryButton(/Allow and remember/)).not.toBeInTheDocument();
  });

  it('leaves out the project when the session is in none', async () => {
    dock(makeApproval({ projectId: null }));
    fireEvent.click(button(/Allow and remember/));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(2);
    expect(within(menu).queryByRole('menuitem', { name: /For this project/ })).not.toBeInTheDocument();
  });

  it('shows a member that a dangerous request waits for the owner: they may deny it, not allow it', () => {
    dock(makeApproval({ risk: 'dangerous', requiresOwner: true, suggestedRule: null, riskCategories: ['download-exec'] }));
    expect(screen.getByText(/Only the owner of this Studio can allow a dangerous request/)).toBeInTheDocument();
    expect(screen.getByText('Downloads something and runs it')).toBeInTheDocument();
    expect(queryButton('Allow')).not.toBeInTheDocument();
    expect(queryButton('Allow once')).not.toBeInTheDocument();
    expect(button('Deny')).toBeEnabled();
  });

  it('lets the owner allow a dangerous request once', async () => {
    signIn('owner');
    const approval = makeApproval({ risk: 'dangerous', requiresOwner: true, suggestedRule: null });
    api.decide.mockResolvedValue(answered(approval));
    dock(approval);
    fireEvent.click(button('Allow once'));
    await waitFor(() => expect(api.decide).toHaveBeenCalledWith(approval.id, { decision: 'allow' }));
  });

  it('treats a lost race as "already answered": no error, and the stale request is cleared', async () => {
    const approval = makeApproval();
    api.decide.mockRejectedValue(new ApiError(409, 'approval_resolved', 'That request has already been answered.', { status: 'denied' }));
    const info = vi.spyOn(toast, 'info');
    const error = vi.spyOn(toast, 'error');
    const { onStale } = dock(approval);
    fireEvent.click(button('Allow'));
    await waitFor(() => expect(info).toHaveBeenCalledWith('That request had already been answered.'));
    expect(error).not.toHaveBeenCalled();
    expect(onStale).toHaveBeenCalledTimes(1);
  });

  it('reports a real failure and keeps the request answerable', async () => {
    api.decide.mockRejectedValue(new ApiError(0, 'network_error', 'offline'));
    const error = vi.spyOn(toast, 'error');
    const { onStale } = dock(makeApproval());
    fireEvent.click(button('Deny'));
    await waitFor(() => expect(error).toHaveBeenCalled());
    expect(onStale).not.toHaveBeenCalled();
    await waitFor(() => expect(button('Deny')).toBeEnabled());
  });

  it('counts down to the moment the server answers by itself', () => {
    dock(makeApproval({ expiresAt: Date.now() + 245_000 }));
    expect(screen.getByRole('timer')).toHaveTextContent(/^4:0[45]$/);
  });

  it('in full: the whole diff, the rule, and a note that goes to the agent with a denial', async () => {
    const approval = makeApproval({ toolName: 'Edit', toolKind: 'edit', command: null, paths: ['src/app.ts'], diff: '@@ -1 +1 @@\n-old\n+new\n', suggestedRule: { tool: 'Edit', pattern: null } });
    api.decide.mockResolvedValue(answered(approval, 'denied'));
    render(<ApprovalSheet approval={approval} agentName="Demo agent" open onClose={() => {}} onStale={() => {}} />);
    expect(screen.getByText('Demo agent wants to change a file')).toBeInTheDocument();
    expect(screen.getByText('old')).toBeInTheDocument();
    expect(screen.getByText('new')).toBeInTheDocument();
    expect(screen.getByText('Edit', { selector: 'code' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Note for the agent/), { target: { value: 'not this file' } });
    fireEvent.click(button('Deny with this note'));
    await waitFor(() => expect(api.decide).toHaveBeenCalledWith(approval.id, { decision: 'deny', note: 'not this file' }));
  });
});

describe('a plan', () => {
  const plan = makeApproval({ kind: 'plan', toolName: 'ExitPlanMode', toolKind: 'other', command: null, plan: '1. Add the route', suggestedRule: null, title: 'Approve the plan' });

  it('is approved, or sent back with what should change', async () => {
    api.decide.mockResolvedValue(answered(plan));
    dock(plan);
    fireEvent.click(button('Approve and run'));
    await waitFor(() => expect(api.decide).toHaveBeenCalledWith(plan.id, { decision: 'allow' }));

    fireEvent.click(button('Keep revising'));
    fireEvent.change(screen.getByLabelText('What should change?'), { target: { value: 'only touch the frontend' } });
    fireEvent.click(button('Send back'));
    await waitFor(() => expect(api.decide).toHaveBeenLastCalledWith(plan.id, { decision: 'deny', note: 'only touch the frontend' }));
  });

  it('can be approved to continue in another mode — only the ones the agent has and the project allows', async () => {
    api.decide.mockResolvedValue(answered(plan));
    dock(plan, { continuation: planContinuationModes(['plan', 'ask', 'accept-edits', 'auto'], false) });
    fireEvent.click(button(/Approve and continue in/));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(2);
    expect(within(menu).queryByRole('menuitem', { name: /^Auto/ })).not.toBeInTheDocument();
    fireEvent.click(within(menu).getByRole('menuitem', { name: /^Accept edits/ }));
    await waitFor(() => expect(api.decide).toHaveBeenCalledWith(plan.id, { decision: 'allow', permissionMode: 'accept-edits' }));
  });

  it('offers no other mode when there is none to offer', () => {
    dock(plan, { continuation: [] });
    expect(queryButton(/Approve and continue in/)).not.toBeInTheDocument();
    expect(planContinuationModes(['plan', 'ask', 'auto'], true)).toEqual(['ask', 'auto']);
    expect(planContinuationModes(['plan'], true)).toEqual([]);
  });
});

describe('questions from the agent', () => {
  const questions = makeApproval({
    kind: 'question',
    toolName: null,
    toolKind: null,
    command: null,
    suggestedRule: null,
    questions: [
      { id: 'runner', header: 'Test runner', question: 'Which test runner?', options: [{ label: 'Vitest', recommended: true }, { label: 'Jest' }], multiSelect: false },
      { id: 'targets', question: 'Which platforms?', options: [{ label: 'Linux' }, { label: 'macOS' }], multiSelect: true },
    ],
  });

  it('walks through them one at a time and submits what was chosen', async () => {
    api.decide.mockResolvedValue(answered(questions));
    dock(questions);
    expect(screen.getByText('Question 1 of 2')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /Vitest/ }));
    fireEvent.click(button('Next'));
    expect(screen.getByText('Question 2 of 2')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Linux' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'macOS' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Other' }));
    fireEvent.change(screen.getByLabelText('Your own answer'), { target: { value: 'FreeBSD' } });
    fireEvent.click(button('Submit'));
    await waitFor(() =>
      expect(api.decide).toHaveBeenCalledWith(questions.id, {
        decision: 'allow',
        answers: [
          { questionId: 'runner', selected: ['Vitest'] },
          { questionId: 'targets', selected: ['Linux', 'macOS'], other: 'FreeBSD' },
        ],
      }),
    );
  });

  it('can be skipped, leaving the decision to the agent', async () => {
    api.decide.mockResolvedValue(answered(questions, 'denied'));
    dock(questions);
    fireEvent.click(button('Skip all'));
    await waitFor(() => expect(api.decide).toHaveBeenCalledWith(questions.id, { decision: 'deny' }));
  });

  it('needs an answer before a single question can be submitted', () => {
    dock({ ...questions, questions: [questions.questions![0]!] });
    expect(button('Submit')).toBeDisabled();
    fireEvent.click(screen.getByRole('radio', { name: /Jest/ }));
    expect(button('Submit')).toBeEnabled();
  });

  it('still lets the user out when the question is malformed', async () => {
    api.decide.mockResolvedValue(answered(questions, 'denied'));
    dock({ ...questions, questions: [] });
    fireEvent.click(button('Skip'));
    await waitFor(() => expect(api.decide).toHaveBeenCalledWith(questions.id, { decision: 'deny' }));
  });
});
