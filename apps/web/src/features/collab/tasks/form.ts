import { type Agent, COLLAB_LIMITS, type CreateTaskInput, type GitStatus, type PermissionMode, type Project, type TaskIsolation } from '@agent-studio/protocol';
import type { MessageKey } from '@/i18n';

/**
 * "Ask several agents" as a pure model: which agents can take part (and why
 * the others cannot), the rules a task must meet before it is sent, and the
 * request it becomes.
 */

export type ParticipantBlock = 'not-offered' | 'not-installed' | 'not-signed-in';

export const PARTICIPANT_BLOCK_WORDS: Record<ParticipantBlock, MessageKey> = {
  'not-offered': 'collab.handoff.block.notOffered',
  'not-installed': 'collab.handoff.block.notInstalled',
  'not-signed-in': 'collab.handoff.block.notSignedIn',
};

export function participantBlock(agent: Agent, project: Pick<Project, 'agents'> | null): ParticipantBlock | null {
  if (project && project.agents !== null && !project.agents.includes(agent.id)) return 'not-offered';
  if (!agent.status.installed) return 'not-installed';
  if (!agent.status.signedIn) return 'not-signed-in';
  return null;
}

/** The agents that can take part here, in the server's order. An agent may take part more than once. */
export function usableAgents(agents: readonly Agent[], project: Pick<Project, 'agents'> | null): Agent[] {
  return agents.filter((agent) => participantBlock(agent, project) === null);
}

export interface ParticipantDraft {
  /** Stable while the row exists, for React. */
  key: string;
  agentId: string;
  model: string | null;
  /** Used with `worktrees` only; with `shared` every participant plans. */
  permissionMode: PermissionMode | null;
}

export interface TaskDraft {
  projectId: string | null;
  title: string;
  prompt: string;
  participants: ParticipantDraft[];
  isolation: TaskIsolation;
  synthesis: boolean;
  synthesisAgentId: string | null;
  synthesisModel: string | null;
}

let keyCounter = 0;
export const newParticipantKey = (): string => `p${(keyCounter += 1)}`;

/** A participant's default: the agent's default model, and in a worktree the mode it starts in (never Auto by itself). */
export function participantFor(agent: Agent): ParticipantDraft {
  const models = agent.capabilities.models;
  const model = models.find((entry) => entry.id === agent.capabilities.defaultModel)?.id ?? models.find((entry) => entry.recommended)?.id ?? models[0]?.id ?? null;
  const modes = agent.capabilities.permissionModes;
  return { key: newParticipantKey(), agentId: agent.id, model, permissionMode: modes.includes('ask') ? 'ask' : (modes.find((mode) => mode !== 'auto') ?? null) };
}

/** Two participants to begin with: the first two agents that can take part, or the one there is, twice. */
export function initialTaskDraft(usable: readonly Agent[], projectId: string | null): TaskDraft {
  const first = usable[0];
  const second = usable[1] ?? usable[0];
  return {
    projectId,
    title: '',
    prompt: '',
    participants: first && second ? [participantFor(first), participantFor(second)] : [],
    isolation: 'shared',
    synthesis: false,
    synthesisAgentId: usable.find((agent) => agent.capabilities.permissionModes.includes('plan'))?.id ?? null,
    synthesisModel: null,
  };
}

/**
 * The draft moved to another project: what was written and chosen stays; the
 * participants are replaced only when the new project does not offer one of
 * them, and the comparing agent only when it cannot compare there.
 */
export function moveDraft(draft: TaskDraft, usable: readonly Agent[], projectId: string): TaskDraft {
  const usableIds = new Set(usable.map((agent) => agent.id));
  const fresh = initialTaskDraft(usable, projectId);
  const keepParticipants = draft.participants.length > 0 && draft.participants.every((participant) => usableIds.has(participant.agentId));
  const keepWriter = usable.some((agent) => agent.id === draft.synthesisAgentId && agent.capabilities.permissionModes.includes('plan'));
  return {
    ...draft,
    projectId,
    participants: keepParticipants ? draft.participants : fresh.participants,
    synthesisAgentId: keepWriter ? draft.synthesisAgentId : fresh.synthesisAgentId,
    synthesisModel: keepWriter ? draft.synthesisModel : null,
  };
}

export type TaskProblem =
  | 'no-project'
  | 'no-prompt'
  | 'prompt-too-long'
  | 'title-too-long'
  | 'too-few'
  | 'too-many'
  | 'participant-unusable'
  | 'worktrees-owner-only'
  | 'needs-repository'
  | 'synthesis-unusable';

export const TASK_PROBLEM_WORDS: Record<TaskProblem, MessageKey> = {
  'no-project': 'collab.task.problem.noProject',
  'no-prompt': 'collab.task.problem.noPrompt',
  'prompt-too-long': 'collab.task.problem.promptTooLong',
  'title-too-long': 'collab.task.problem.titleTooLong',
  'too-few': 'collab.task.problem.tooFew',
  'too-many': 'collab.task.problem.tooMany',
  'participant-unusable': 'collab.task.problem.participantUnusable',
  'worktrees-owner-only': 'collab.task.problem.worktreesOwnerOnly',
  'needs-repository': 'collab.task.problem.needsRepository',
  'synthesis-unusable': 'collab.task.problem.synthesisUnusable',
};

/** Whether the project can give each participant a worktree: a Git repository that is ready and has a commit to start from. */
export const repositoryReady = (status: Pick<GitStatus, 'state' | 'hasCommits'>): boolean => status.state === 'ready' && status.hasCommits;

/**
 * Everything that stops the draft from being sent, in the order a person would fix it.
 * `repositoryIsReady` is what `repositoryReady` said of the project, or null while that
 * is not known (the server checks it again either way).
 */
export function taskProblems(draft: TaskDraft, usable: readonly Agent[], isOwner: boolean, repositoryIsReady: boolean | null = null): TaskProblem[] {
  const problems: TaskProblem[] = [];
  if (!draft.projectId) problems.push('no-project');
  if (draft.prompt.trim() === '') problems.push('no-prompt');
  if (draft.prompt.length > COLLAB_LIMITS.taskPromptChars) problems.push('prompt-too-long');
  if (draft.title.trim().length > COLLAB_LIMITS.taskTitleChars) problems.push('title-too-long');
  if (draft.participants.length < COLLAB_LIMITS.minParticipants) problems.push('too-few');
  if (draft.participants.length > COLLAB_LIMITS.maxParticipants) problems.push('too-many');
  const usableIds = new Set(usable.map((agent) => agent.id));
  if (draft.participants.some((participant) => !usableIds.has(participant.agentId))) problems.push('participant-unusable');
  if (draft.isolation === 'worktrees' && !isOwner) problems.push('worktrees-owner-only');
  else if (draft.isolation === 'worktrees' && repositoryIsReady === false) problems.push('needs-repository');
  if (draft.synthesis) {
    const writer = usable.find((agent) => agent.id === draft.synthesisAgentId);
    if (!writer || !writer.capabilities.permissionModes.includes('plan')) problems.push('synthesis-unusable');
  }
  return problems;
}

/**
 * The request a draft becomes. With `shared` isolation no mode is sent: the
 * server gives every participant `plan`, the only one that is safe when
 * several agents work in one folder. The request id makes a retry return the
 * task the first attempt made.
 */
export function taskRequest(draft: TaskDraft, requestId: string): CreateTaskInput {
  const title = draft.title.trim();
  return {
    requestId,
    ...(title ? { title } : {}),
    prompt: draft.prompt,
    isolation: draft.isolation,
    participants: draft.participants.map((participant) => ({
      agentId: participant.agentId,
      ...(participant.model ? { model: participant.model } : {}),
      ...(draft.isolation === 'worktrees' && participant.permissionMode ? { permissionMode: participant.permissionMode } : {}),
    })),
    ...(draft.synthesis && draft.synthesisAgentId ? { synthesis: { agentId: draft.synthesisAgentId, ...(draft.synthesisModel ? { model: draft.synthesisModel } : {}) } } : {}),
  };
}
