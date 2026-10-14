import { type Agent, COLLAB_LIMITS, type HandoffInput, type PermissionMode, type Project } from '@agent-studio/protocol';
import type { MessageKey } from '@/i18n';

/**
 * The "Continue with another agent" form as a pure model: who may take the
 * conversation over (and why the others may not), who may write the
 * summary, and the request it becomes.
 */

export type TargetBlock = 'same-agent' | 'not-offered' | 'not-installed' | 'not-signed-in';

export interface HandoffTarget {
  agent: Agent;
  /** Null when this agent can take the conversation over. */
  blocked: TargetBlock | null;
}

export const TARGET_BLOCK_WORDS: Record<TargetBlock, MessageKey> = {
  'same-agent': 'collab.handoff.block.sameAgent',
  'not-offered': 'collab.handoff.block.notOffered',
  'not-installed': 'collab.handoff.block.notInstalled',
  'not-signed-in': 'collab.handoff.block.notSignedIn',
};

const offered = (agent: Agent, project: Pick<Project, 'agents'> | null): boolean => project === null || project.agents === null || project.agents.includes(agent.id);

function blockOf(agent: Agent, project: Pick<Project, 'agents'> | null, sourceAgentId: string): TargetBlock | null {
  if (agent.id === sourceAgentId) return 'same-agent';
  if (!offered(agent, project)) return 'not-offered';
  if (!agent.status.installed) return 'not-installed';
  if (!agent.status.signedIn) return 'not-signed-in';
  return null;
}

/** Every agent, the ones that can continue first; each blocked one with its reason. A conversation in a project continues in it, so API models outside a project are not candidates. */
export function handoffTargets(agents: readonly Agent[], project: Pick<Project, 'agents'> | null, sourceAgentId: string): HandoffTarget[] {
  const all = agents.map((agent) => ({ agent, blocked: blockOf(agent, project, sourceAgentId) }));
  return [...all.filter((entry) => entry.blocked === null), ...all.filter((entry) => entry.blocked !== null)];
}

/** Agents that can write a summary: usable here and able to work read-only (the summary run is in `plan` mode). */
export function summaryWriters(agents: readonly Agent[], project: Pick<Project, 'agents'> | null): Agent[] {
  return agents.filter((agent) => offered(agent, project) && agent.status.installed && agent.status.signedIn && agent.capabilities.permissionModes.includes('plan'));
}

export interface HandoffDraft {
  agentId: string | null;
  model: string | null;
  permissionMode: PermissionMode | null;
  brief: 'digest' | 'summary';
  summaryAgentId: string | null;
  summaryModel: string | null;
  note: string;
  /** Send the first message (the note, or the default one) right away. */
  start: boolean;
}

export type DraftProblem = 'no-agent' | 'blocked-agent' | 'no-writer' | 'note-too-long';

export const DRAFT_PROBLEM_WORDS: Record<DraftProblem, MessageKey> = {
  'no-agent': 'collab.handoff.problem.noAgent',
  'blocked-agent': 'collab.handoff.problem.blockedAgent',
  'no-writer': 'collab.handoff.problem.noWriter',
  'note-too-long': 'collab.handoff.problem.noteTooLong',
};

/** The mode the new conversation starts in: the one this conversation uses, where the new agent has it. */
export function carriedMode(target: Agent | undefined, sourceMode: PermissionMode): PermissionMode | null {
  if (!target) return null;
  const modes = target.capabilities.permissionModes;
  if (modes.includes(sourceMode)) return sourceMode;
  if (modes.includes('ask')) return 'ask';
  return modes[0] ?? null;
}

/** A fresh draft: the first agent that can continue, its default model, the digest, nothing sent yet. */
export function initialDraft(targets: readonly HandoffTarget[], sourceMode: PermissionMode, writers: readonly Agent[]): HandoffDraft {
  const first = targets.find((entry) => entry.blocked === null)?.agent;
  return {
    agentId: first?.id ?? null,
    model: first ? defaultModel(first) : null,
    permissionMode: carriedMode(first, sourceMode),
    brief: 'digest',
    summaryAgentId: writers[0]?.id ?? null,
    summaryModel: null,
    note: '',
    start: false,
  };
}

export function defaultModel(agent: Agent): string | null {
  const models = agent.capabilities.models;
  return models.find((model) => model.id === agent.capabilities.defaultModel)?.id ?? models.find((model) => model.recommended)?.id ?? models[0]?.id ?? null;
}

export function draftProblem(draft: HandoffDraft, targets: readonly HandoffTarget[], writers: readonly Agent[]): DraftProblem | null {
  if (!draft.agentId) return 'no-agent';
  const target = targets.find((entry) => entry.agent.id === draft.agentId);
  if (!target || target.blocked !== null) return 'blocked-agent';
  if (draft.brief === 'summary' && !writers.some((writer) => writer.id === draft.summaryAgentId)) return 'no-writer';
  if (draft.note.length > COLLAB_LIMITS.noteChars) return 'note-too-long';
  return null;
}

/** The request a draft becomes. The same request id is sent again on a retry, so a handoff happens once. */
export function handoffRequest(draft: HandoffDraft, requestId: string): HandoffInput {
  if (!draft.agentId) throw new Error('A handoff needs an agent.');
  const note = draft.note.trim();
  return {
    requestId,
    agentId: draft.agentId,
    ...(draft.model ? { model: draft.model } : {}),
    ...(draft.permissionMode ? { permissionMode: draft.permissionMode } : {}),
    ...(note ? { note } : {}),
    start: draft.start,
    ...(draft.brief === 'summary' && draft.summaryAgentId ? { summary: { agentId: draft.summaryAgentId, ...(draft.summaryModel ? { model: draft.summaryModel } : {}) } } : {}),
  };
}
