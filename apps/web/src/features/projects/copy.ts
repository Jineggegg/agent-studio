import { PROJECT_FEATURES, type ProjectFeature, type ProjectLinkStatus } from '@agent-studio/protocol';
import type { MessageKey, Translator } from '@/i18n';

/**
 * The words for a project's switches. Each says what turning it on lets
 * happen and what turning it off stops — never a bare name — and the one that
 * hands agents this machine's credentials says what that risks.
 */
export interface FeatureCopy {
  title: MessageKey;
  /** What it does while on, and what stops while off. */
  consequence: MessageKey;
  /** Shown in a confirmation before the switch is turned on, for the switches that deserve one. */
  risk?: { title: MessageKey; message: MessageKey; confirm: MessageKey };
}

export const FEATURE_COPY: Record<ProjectFeature, FeatureCopy> = {
  assistant: { title: 'projects.feature.assistant', consequence: 'projects.feature.assistant.text' },
  automation: { title: 'projects.feature.automation', consequence: 'projects.feature.automation.text' },
  instructions: { title: 'projects.feature.instructions', consequence: 'projects.feature.instructions.text' },
  agentCredentials: {
    title: 'projects.feature.agentCredentials',
    consequence: 'projects.feature.agentCredentials.text',
    risk: { title: 'projects.feature.agentCredentials.riskTitle', message: 'projects.feature.agentCredentials.riskMessage', confirm: 'projects.feature.agentCredentials.riskConfirm' },
  },
};

/** The switches in the order they are shown. Everything the protocol defines is here (a test holds this true). */
export const FEATURE_ORDER: readonly ProjectFeature[] = PROJECT_FEATURES;

/** The per-project "Auto" switch the agent runtime keeps beside the project's own. */
export const AUTO_MODE_COPY: FeatureCopy = {
  title: 'projects.feature.autoMode',
  consequence: 'projects.feature.autoMode.text',
  risk: { title: 'projects.feature.autoMode.riskTitle', message: 'projects.feature.autoMode.riskMessage', confirm: 'projects.feature.autoMode.riskConfirm' },
};

// ---- links ---------------------------------------------------------------------------

export type LinkTone = 'positive' | 'warning' | 'danger' | 'neutral';

/** What a reachability probe found, in a few words: "142 ms", "HTTP 503", "No answer", "Not checked". */
export function linkStatusText(status: ProjectLinkStatus | undefined, t: Translator): { text: string; tone: LinkTone } {
  if (!status) return { text: t('projects.links.checking'), tone: 'neutral' };
  switch (status.state) {
    case 'ok':
      return { text: status.latencyMs === null ? t('projects.links.ok') : t('projects.links.latency', { ms: t.number(status.latencyMs) }), tone: 'positive' };
    case 'http_error':
      return { text: status.status === null ? t('projects.links.httpError') : t('projects.links.http', { status: status.status }), tone: 'warning' };
    case 'unreachable':
      return { text: t('projects.links.unreachable'), tone: 'danger' };
    case 'blocked':
      return { text: t('projects.links.blocked'), tone: 'neutral' };
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Why a link cannot be saved as typed, or null when it can. The server checks again. */
export function linkProblem(label: string, url: string): 'label' | 'url' | 'scheme' | 'credentials' | null {
  if (label.trim() === '') return 'label';
  const address = url.trim();
  if (address === '') return 'url';
  let parsed: URL;
  try {
    parsed = new URL(address);
  } catch {
    return 'scheme';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'scheme';
  if (parsed.username !== '' || parsed.password !== '') return 'credentials';
  return null;
}

// ---- cloning ---------------------------------------------------------------------------

export type CloneAddressProblem = 'empty' | 'spaces' | 'scheme' | 'credentials';

/**
 * Why a repository address will be refused, said before it is sent: only
 * `https://…`, `ssh://…` and `user@host:path` are accepted, and never with a
 * password or token inside. The server is the judge; this only saves a round trip.
 */
export function cloneAddressProblem(raw: string): CloneAddressProblem | null {
  const value = raw.trim();
  if (value === '') return 'empty';
  if (/\s/.test(value)) return 'spaces';
  if (value.startsWith('-') || value.includes('::')) return 'scheme';
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(value);
  if (scheme) {
    const protocol = scheme[1]!.toLowerCase();
    if (protocol !== 'https' && protocol !== 'ssh') return 'scheme';
    try {
      const url = new URL(value);
      if (url.password !== '') return 'credentials';
      if (protocol === 'https' && url.username !== '') return 'credentials';
    } catch {
      return 'scheme';
    }
    return null;
  }
  // "user@host:path"
  return /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^:\s]+$/.test(value) ? null : 'scheme';
}

/** "repo" from ".../owner/repo.git": what the folder will be called unless another name is given. */
export function repositoryName(raw: string): string {
  const cleaned = raw.trim().replace(/[/\\]+$/, '').replace(/\.git$/i, '');
  const last = cleaned.split(/[/:]/).pop() ?? '';
  return /^[A-Za-z0-9._-]+$/.test(last) ? last : '';
}
