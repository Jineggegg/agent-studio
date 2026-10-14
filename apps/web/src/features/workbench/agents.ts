import type { Agent, AgentModelOption, PermissionMode, Project } from '@agent-studio/protocol';
import { useQuery } from '@tanstack/react-query';
import { workbenchApi } from './api';
import type { DeviceMemory } from './device';
import { workbenchKeys } from './sessions/queries';

/**
 * The agents this Studio offers, and the choices a conversation starts from.
 * Everything about what is selectable is derived from what the server
 * reports — an agent that cannot be used is shown with the reason, never as
 * a choice that fails when taken.
 */
export function useAgents(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: workbenchKeys.agents,
    queryFn: ({ signal }) => workbenchApi.agents(signal).then((result) => result.agents),
    enabled: options.enabled ?? true,
    staleTime: 60_000,
    meta: { live: true },
  });
}

/** What the owner allows agents to do in a project (whether `auto` really applies there). */
export function useProjectAgentSettings(projectId: string | null) {
  return useQuery({
    queryKey: workbenchKeys.projectSettings(projectId ?? ''),
    queryFn: ({ signal }) => workbenchApi.projectSettings(projectId!, signal),
    enabled: projectId !== null,
    staleTime: 60_000,
  });
}

export type Unavailable = 'not-installed' | 'not-signed-in' | 'not-offered' | 'read-only' | null;

/** Why an agent cannot be used for a new conversation in this project; null when it can. */
export function agentUnavailable(agent: Agent, project: Pick<Project, 'agents' | 'access'> | null): Unavailable {
  if (project && project.agents !== null && !project.agents.includes(agent.id)) return 'not-offered';
  if (!agent.status.installed) return 'not-installed';
  if (!agent.status.signedIn) return 'not-signed-in';
  if (project && project.access !== 'write') return 'read-only';
  return null;
}

/** Agents a project offers, usable ones first, each group in the server's order. */
export function agentsFor(agents: readonly Agent[], project: Pick<Project, 'agents' | 'access'> | null): Agent[] {
  // An agent the project does not offer is not listed at all; one that is merely unavailable is, with the reason.
  const offered = agents.filter((agent) => agentUnavailable(agent, project) !== 'not-offered').filter((agent) => project !== null || agent.kind === 'api');
  return [...offered.filter((agent) => agentUnavailable(agent, project) === null), ...offered.filter((agent) => agentUnavailable(agent, project) !== null)];
}

export interface AgentChoice {
  agentId: string;
  model: string | null;
  effort: string | null;
  mode: PermissionMode;
}

export function findModel(agent: Agent | undefined, modelId: string | null): AgentModelOption | undefined {
  if (!agent) return undefined;
  return agent.capabilities.models.find((model) => model.id === modelId) ?? undefined;
}

/** The effort a model runs at when the user has not chosen one it supports: their last choice if it fits, else the model's default. */
export function resolveEffort(model: AgentModelOption | undefined, wanted: string | null): string | null {
  const efforts = model?.efforts ?? [];
  if (efforts.length === 0) return null;
  if (wanted !== null && efforts.includes(wanted)) return wanted;
  return model?.defaultEffort && efforts.includes(model.defaultEffort) ? model.defaultEffort : (efforts[Math.floor((efforts.length - 1) / 2)] ?? null);
}

/** The mode a new conversation starts in: the last one used with this agent, never `auto` by default, else `ask`. */
export function resolveMode(agent: Agent, wanted: PermissionMode | undefined): PermissionMode {
  const modes = agent.capabilities.permissionModes;
  if (wanted && wanted !== 'auto' && modes.includes(wanted)) return wanted;
  if (modes.includes('ask')) return 'ask';
  return modes[0] ?? 'ask';
}

/**
 * What a new conversation starts with: the agent used last on this device if
 * the project offers it and it can run, otherwise the first one that can;
 * its remembered model, effort and mode where they still exist.
 */
export function defaultChoice(agents: readonly Agent[], project: Pick<Project, 'agents' | 'access'> | null, memory: Pick<DeviceMemory, 'lastAgentId' | 'lastModel' | 'lastEffort' | 'lastMode'>, preferred?: string | null): AgentChoice | null {
  const offered = agentsFor(agents, project);
  const usable = offered.filter((agent) => agentUnavailable(agent, project) === null);
  const pool = usable.length > 0 ? usable : offered;
  const agent = pool.find((entry) => entry.id === preferred) ?? pool.find((entry) => entry.id === memory.lastAgentId) ?? pool[0];
  if (!agent) return null;
  return choiceFor(agent, memory);
}

export function choiceFor(agent: Agent, memory: Pick<DeviceMemory, 'lastModel' | 'lastEffort' | 'lastMode'>, modelId?: string | null): AgentChoice {
  const remembered = modelId ?? memory.lastModel[agent.id] ?? null;
  const model =
    findModel(agent, remembered) ??
    findModel(agent, agent.capabilities.defaultModel) ??
    agent.capabilities.models.find((entry) => entry.recommended) ??
    agent.capabilities.models[0];
  const modelKey = model ? `${agent.id}:${model.id}` : '';
  return {
    agentId: agent.id,
    model: model?.id ?? null,
    effort: resolveEffort(model, memory.lastEffort[modelKey] ?? null),
    mode: resolveMode(agent, memory.lastMode[agent.id]),
  };
}

/** The modes Shift+Tab walks through: every one the agent has except `auto`, which is only ever chosen deliberately. */
export function nextMode(agent: Agent | undefined, current: PermissionMode): PermissionMode {
  const cycle: PermissionMode[] = (agent?.capabilities.permissionModes ?? []).filter((mode) => mode !== 'auto');
  if (cycle.length === 0) return current;
  const index = cycle.indexOf(current);
  return cycle[(index + 1) % cycle.length]!;
}

export const modelLabel = (agent: Agent | undefined, modelId: string | null): string | null => {
  if (modelId === null) return null;
  return findModel(agent, modelId)?.label ?? modelId;
};
