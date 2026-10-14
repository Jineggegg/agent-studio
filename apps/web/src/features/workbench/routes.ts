/**
 * Addresses of the workbench. One conversation, one address:
 *
 *   /workbench                         where you were last (decided once, then replaced)
 *   /workbench/p/<project>             a project: its last conversation, or a new one
 *   /workbench/p/<project>/new         a new conversation in a project
 *   /workbench/p/<project>/s/<id>      a conversation
 *   /workbench/s/<id>                  a conversation by id alone — corrected to the form above
 *                                      (also the home of a conversation that has no project)
 *
 * Which list is beside the chat (this project / all) is remembered on the
 * device, not in the address, so a link never changes how the reader has
 * arranged the screen. Moving between conversations replaces the history
 * entry: Back leaves the workbench instead of walking through what was read.
 */
export const WORKBENCH_BASE = '/workbench';

export type WorkbenchTarget =
  | { kind: 'landing' }
  | { kind: 'project'; projectId: string }
  | { kind: 'new'; projectId: string }
  | { kind: 'session'; projectId: string; sessionId: string }
  /** A conversation named without its project (or by the agent's own id): look it up, then correct the address. */
  | { kind: 'lookup'; sessionId: string }
  | { kind: 'unknown' };

function decode(segment: string): string | null {
  try {
    const value = decodeURIComponent(segment);
    return value === '' || value.length > 400 ? null : value;
  } catch {
    return null;
  }
}

/** What an address inside the workbench points at. Accepts the full pathname or what follows `/workbench`. */
export function parseWorkbenchPath(pathname: string): WorkbenchTarget {
  const rest = pathname.startsWith(WORKBENCH_BASE) ? pathname.slice(WORKBENCH_BASE.length) : pathname;
  const segments = rest.split('/').filter((segment) => segment !== '');
  if (segments.length === 0) return { kind: 'landing' };
  const [first, second, third, fourth, ...extra] = segments;
  if (extra.length > 0) return { kind: 'unknown' };

  if (first === 's') {
    const sessionId = second === undefined || third !== undefined ? null : decode(second);
    return sessionId === null ? { kind: 'unknown' } : { kind: 'lookup', sessionId };
  }
  if (first === 'p') {
    const projectId = second === undefined ? null : decode(second);
    if (projectId === null) return { kind: 'unknown' };
    if (third === undefined) return { kind: 'project', projectId };
    if (third === 'new' && fourth === undefined) return { kind: 'new', projectId };
    if (third === 's') {
      const sessionId = fourth === undefined ? null : decode(fourth);
      return sessionId === null ? { kind: 'unknown' } : { kind: 'session', projectId, sessionId };
    }
  }
  return { kind: 'unknown' };
}

export const workbenchPaths = {
  root: (): string => WORKBENCH_BASE,
  project: (projectId: string): string => `${WORKBENCH_BASE}/p/${encodeURIComponent(projectId)}`,
  newChat: (projectId: string): string => `${WORKBENCH_BASE}/p/${encodeURIComponent(projectId)}/new`,
  /** The one address a conversation has. `projectId` is null only for a conversation outside any project. */
  session: (projectId: string | null, sessionId: string): string =>
    projectId === null ? `${WORKBENCH_BASE}/s/${encodeURIComponent(sessionId)}` : `${WORKBENCH_BASE}/p/${encodeURIComponent(projectId)}/s/${encodeURIComponent(sessionId)}`,
  lookup: (sessionId: string): string => `${WORKBENCH_BASE}/s/${encodeURIComponent(sessionId)}`,
};

/** The address a target should have, or null when it already has it / has none. */
export function canonicalPath(target: WorkbenchTarget, actualProjectId: string | null): string | null {
  if (target.kind === 'session') return target.projectId === actualProjectId ? null : workbenchPaths.session(actualProjectId, target.sessionId);
  if (target.kind === 'lookup') return actualProjectId === null ? null : workbenchPaths.session(actualProjectId, target.sessionId);
  return null;
}
