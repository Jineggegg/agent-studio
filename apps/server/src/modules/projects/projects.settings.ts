import {
  DEFAULT_PROJECT_FEATURES,
  MAX_PROJECT_LINKS,
  type ProjectFeature,
  type ProjectFeatures,
  type ProjectLink,
  type ProjectLinkInput,
} from '@agent-studio/protocol';
import { newId } from '../../kernel/crypto.js';
import { badRequest, forbidden, isStudioError } from '../../kernel/errors.js';
import { checkUrl } from '../../kernel/net.js';

/**
 * The part of a project's settings bag that the projects module itself owns.
 * Other modules keep their own keys in the same bag and are not affected.
 */
export interface ProjectSettingsView {
  readonly links: readonly ProjectLink[];
  /** null: every agent the Studio offers. */
  readonly agents: readonly string[] | null;
  readonly features: ProjectFeatures;
  readonly scratch: boolean;
}

const AGENT_ID = /^[a-z][a-z0-9-]{0,39}$/;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Reads the typed settings out of the bag, tolerating anything a hand-edited database might hold. */
export function readProjectSettings(bag: Readonly<Record<string, unknown>>): ProjectSettingsView {
  const links: ProjectLink[] = [];
  if (Array.isArray(bag.links)) {
    for (const entry of bag.links.slice(0, MAX_PROJECT_LINKS)) {
      if (!isRecord(entry)) continue;
      const { id, label, url, local } = entry;
      if (typeof id !== 'string' || typeof label !== 'string' || typeof url !== 'string') continue;
      links.push({ id, label, url, local: local === true });
    }
  }

  let agents: string[] | null = null;
  if (Array.isArray(bag.agents)) {
    agents = [...new Set(bag.agents.filter((entry): entry is string => typeof entry === 'string' && AGENT_ID.test(entry)))];
  }

  const stored = isRecord(bag.features) ? bag.features : {};
  const features: ProjectFeatures = {
    assistant: typeof stored.assistant === 'boolean' ? stored.assistant : DEFAULT_PROJECT_FEATURES.assistant,
    automation: typeof stored.automation === 'boolean' ? stored.automation : DEFAULT_PROJECT_FEATURES.automation,
    instructions: typeof stored.instructions === 'boolean' ? stored.instructions : DEFAULT_PROJECT_FEATURES.instructions,
    agentCredentials: typeof stored.agentCredentials === 'boolean' ? stored.agentCredentials : DEFAULT_PROJECT_FEATURES.agentCredentials,
  };

  return { links, agents, features, scratch: bag.scratch === true };
}

export function isAgentEnabled(settings: ProjectSettingsView, agentId: string): boolean {
  return settings.agents === null || settings.agents.includes(agentId);
}

export function isFeatureEnabled(settings: ProjectSettingsView, feature: ProjectFeature): boolean {
  return settings.features[feature];
}

/**
 * Checks a link address without contacting it: http or https only, no
 * credentials inside, never a link-local address. Returns the normalised form.
 */
export function normaliseLinkUrl(raw: string): string {
  try {
    // The permissive policy is right here: whether a private address may be
    // *contacted* is decided per link when it is probed, not when it is saved.
    return checkUrl(raw, { allowHttp: true, allowPrivateNetwork: true }).href;
  } catch (error) {
    if (!isStudioError(error)) throw error;
    const message =
      error.code === 'address_not_allowed'
        ? 'A link cannot point at that address.'
        : 'A link must be an http:// or https:// address without a user name or password in it.';
    throw badRequest(message, undefined, 'invalid_link');
  }
}

/**
 * Turns the links a client sent into what is stored. Existing links keep
 * their id. Only the owner may mark a link as local; anyone else may keep a
 * mark the owner set, as long as the address is untouched.
 */
export function normaliseLinks(input: readonly ProjectLinkInput[], existing: readonly ProjectLink[], isOwner: boolean): ProjectLink[] {
  if (input.length > MAX_PROJECT_LINKS) {
    throw badRequest(`A project can have at most ${MAX_PROJECT_LINKS} links.`, undefined, 'too_many_links');
  }
  const byId = new Map(existing.map((link) => [link.id, link]));
  const used = new Set<string>();
  return input.map((entry) => {
    const url = normaliseLinkUrl(entry.url);
    const previous = entry.id !== undefined && !used.has(entry.id) ? byId.get(entry.id) : undefined;
    const id = previous?.id ?? newId();
    used.add(id);
    if (entry.local && !isOwner && !(previous?.local === true && previous.url === url)) {
      throw forbidden('Only the owner can mark a link as a local service.', 'owner_required');
    }
    return { id, label: entry.label, url, local: entry.local };
  });
}

/** An explicit agent list must be free of duplicates, and a project that offers the assistant needs at least one agent. */
export function checkAgentsAndFeatures(agents: readonly string[] | null, features: ProjectFeatures): void {
  if (agents !== null && new Set(agents).size !== agents.length) {
    throw badRequest('An agent is listed twice.', undefined, 'invalid_agents');
  }
  if (features.assistant && agents !== null && agents.length === 0) {
    throw badRequest('Enable at least one agent, or switch the assistant off.', undefined, 'agents_required');
  }
}
