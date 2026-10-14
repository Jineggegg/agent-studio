import type { Approval, ApprovalDecisionRequest, PermissionMode, Question, QuestionAnswer, Role } from '@agent-studio/protocol';
import { isApiError } from '@/data/api';

/**
 * What an approval may be answered with, and by whom — worked out from what
 * the server put on the request, never assumed. The server enforces the same
 * rules; this exists so that no button is offered that would only be refused.
 */
export type RememberScope = NonNullable<ApprovalDecisionRequest['remember']>;

export interface ApprovalChoices {
  /** This person may answer at all (it is their run, or they are the owner). */
  canAnswer: boolean;
  /** May allow it (approve the plan, submit answers). */
  canAllow: boolean;
  /** May deny it (send the plan back, skip the question). */
  canDeny: boolean;
  /** It is waiting for someone else: only the owner may allow a dangerous request. */
  waitingForOwner: boolean;
  /** Where "allow and remember" may save its rule; empty when remembering is not offered. */
  remember: RememberScope[];
}

export function approvalChoices(approval: Approval, viewer: { userId: string; role: Role }): ApprovalChoices {
  const isOwner = viewer.role === 'owner';
  const isRunUser = viewer.userId === approval.userId;
  const canAnswer = approval.status === 'pending' && (isRunUser || isOwner);
  const dangerous = approval.requiresOwner || approval.risk === 'dangerous';
  const canAllow = canAnswer && (!dangerous || isOwner);

  const remember: RememberScope[] = [];
  // A rule belongs to the person whose runs it will govern; a dangerous request is allowed once, never remembered.
  if (canAllow && approval.kind === 'tool' && approval.suggestedRule !== null && isRunUser && !dangerous) {
    remember.push('session');
    if (approval.projectId !== null) remember.push('project');
    remember.push('always');
  }
  return { canAnswer, canAllow, canDeny: canAnswer, waitingForOwner: approval.status === 'pending' && dangerous && !isOwner, remember };
}

export type ContinuationMode = NonNullable<ApprovalDecisionRequest['permissionMode']>;

const CONTINUATION_ORDER: readonly ContinuationMode[] = ['ask', 'accept-edits', 'auto'];

/**
 * The permission modes an approved plan may continue in: those the agent has,
 * and `auto` only where the project's owner allows it. The server refuses
 * anything else, so nothing else is offered.
 */
export function planContinuationModes(agentModes: readonly PermissionMode[], autoEnabled: boolean): ContinuationMode[] {
  return CONTINUATION_ORDER.filter((mode) => agentModes.includes(mode) && (mode !== 'auto' || autoEnabled));
}

/** The rule "allow and remember" would save, as the user will read it: `Bash(npm test *)`, `Edit`. */
export function describeRule(rule: { tool: string; pattern: string | null }): string {
  return rule.pattern === null ? rule.tool : `${rule.tool}(${rule.pattern})`;
}

export type DecisionFailure =
  /** Someone else (another device, the owner, the clock) answered first. */
  | { kind: 'already-answered'; status: string | null }
  | { kind: 'owner-required' }
  | { kind: 'remember-refused' }
  /** The mode chosen for after the plan cannot be used here (not allowed in this project, or the agent lacks it). */
  | { kind: 'mode-refused'; error: unknown }
  | { kind: 'gone' }
  | { kind: 'error'; error: unknown };

/** Reads the server's refusal of a decision. Losing the race is not an error: the request is simply answered. */
export function decisionFailure(error: unknown): DecisionFailure {
  if (!isApiError(error)) return { kind: 'error', error };
  if (error.status === 409 && error.code === 'approval_resolved') {
    const status = (error.details as { status?: unknown } | null | undefined)?.status;
    return { kind: 'already-answered', status: typeof status === 'string' ? status : null };
  }
  if (error.code === 'owner_required') return { kind: 'owner-required' };
  if (error.code === 'remember_not_allowed') return { kind: 'remember-refused' };
  if (error.code === 'auto_mode_not_enabled' || error.code === 'unsupported_permission_mode' || error.code === 'mode_not_applicable') return { kind: 'mode-refused', error };
  if (error.status === 404) return { kind: 'gone' };
  return { kind: 'error', error };
}

/** Seconds until the server resolves the request by itself; null when it waits for ever. */
export function secondsLeft(approval: Pick<Approval, 'expiresAt'>, now: number): number | null {
  if (approval.expiresAt === null) return null;
  return Math.max(0, Math.ceil((approval.expiresAt - now) / 1000));
}

/** "4:05", "0:09", "1:02:30" — a countdown that reads the same in every language. */
export function formatCountdown(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = String(whole % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

// ---- questions --------------------------------------------------------------------

export interface DraftAnswer {
  selected: string[];
  other: string;
  /** "Other" is open, whether or not anything has been typed. */
  otherOpen: boolean;
}

export const emptyAnswer = (): DraftAnswer => ({ selected: [], other: '', otherOpen: false });

export function toggleOption(question: Pick<Question, 'multiSelect'>, answer: DraftAnswer, label: string): DraftAnswer {
  if (question.multiSelect) {
    const selected = answer.selected.includes(label) ? answer.selected.filter((entry) => entry !== label) : [...answer.selected, label];
    return { ...answer, selected };
  }
  // One choice: picking an option closes "Other".
  return { selected: answer.selected[0] === label ? [] : [label], other: '', otherOpen: false };
}

export function toggleOther(question: Pick<Question, 'multiSelect'>, answer: DraftAnswer): DraftAnswer {
  if (answer.otherOpen) return { ...answer, otherOpen: false, other: '' };
  return question.multiSelect ? { ...answer, otherOpen: true } : { selected: [], other: '', otherOpen: true };
}

export const isAnswered = (answer: DraftAnswer | undefined): boolean => !!answer && (answer.selected.length > 0 || answer.other.trim() !== '');

/** What goes to the server: only the questions that got an answer. A question left alone is the agent's to decide. */
export function collectAnswers(questions: readonly Question[], drafts: Readonly<Record<string, DraftAnswer>>): QuestionAnswer[] {
  const answers: QuestionAnswer[] = [];
  for (const question of questions) {
    const draft = drafts[question.id];
    if (!isAnswered(draft)) continue;
    const other = draft!.other.trim();
    answers.push({ questionId: question.id, selected: draft!.selected, ...(other === '' ? {} : { other }) });
  }
  return answers;
}

/** A question the agent sent without usable text or options still has to be answerable — or at least dismissable. */
export function usableQuestions(approval: Pick<Approval, 'questions'>): Question[] {
  return (approval.questions ?? []).filter((question) => question.question.trim() !== '' || question.options.length > 0);
}
