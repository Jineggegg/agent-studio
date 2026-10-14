import { isApiError } from '@/data/api';
import { describeError } from '@/data/errors';
import type { MessageKey, Translator } from '@/i18n';

/**
 * What went wrong with a handoff or a task, as a sentence — plus, where the
 * server points somewhere better, where that is. `not_latest_in_chain` says
 * which conversation is the newest of its chain; the sheet offers to open it.
 */
export interface CollabProblem {
  text: string;
  /** The newest conversation of the chain, when the server named it. */
  latestSessionId: string | null;
  /** Retrying the same request may work (the server could not be reached, or was busy). */
  retryable: boolean;
}

const ID = /^[0-9a-z]{26}$/;

/**
 * Codes the server shares with other features, whose general sentence would
 * mislead here (a "task" in the inbox is a run; a "request" there is a message).
 */
const COLLAB_WORDS: Record<string, MessageKey> = {
  task_not_found: 'collab.errors.taskNotFound',
  request_conflict: 'collab.errors.requestConflict',
  request_in_progress: 'collab.errors.requestInProgress',
  project_required: 'collab.errors.projectRequired',
};

/** Any failure of this feature as a sentence in the user's language. */
export function describeCollabError(error: unknown, t: Translator): string {
  if (isApiError(error)) {
    const key = COLLAB_WORDS[error.code];
    if (key) return t(key);
  }
  return describeError(error, t);
}

export function collabProblem(error: unknown, t: Translator): CollabProblem {
  const text = describeCollabError(error, t);
  if (!isApiError(error)) return { text, latestSessionId: null, retryable: false };
  const details = error.details as { latestSessionId?: unknown } | null | undefined;
  const latest = error.code === 'not_latest_in_chain' && typeof details?.latestSessionId === 'string' && ID.test(details.latestSessionId) ? details.latestSessionId : null;
  return { text, latestSessionId: latest, retryable: error.unreachable || error.code === 'request_in_progress' || error.code === 'handoff_in_progress' };
}
