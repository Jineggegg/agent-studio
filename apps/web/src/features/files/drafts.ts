import { onSessionEnd } from '@/data/auth';

/**
 * Unsaved text that outlives the editor it was typed in. Leaving the
 * workbench, or moving to another project, takes the files panel off the
 * screen; whatever was not saved is kept here — per project, in this page
 * only — and put back in an editor the next time that project's files are
 * shown. Nothing is ever dropped without the person having said so.
 */
export interface UnsavedDraft {
  path: string;
  /** The text as it was being edited (without byte-order mark, lines broken with "\n"). */
  text: string;
  /** The version the text started from. */
  baseVersion: string | null;
}

const drafts = new Map<string, UnsavedDraft>();

export function stashDraft(projectId: string, draft: UnsavedDraft): void {
  drafts.set(projectId, draft);
}

/** The draft kept for a project, handed over once. */
export function takeDraft(projectId: string): UnsavedDraft | null {
  const draft = drafts.get(projectId) ?? null;
  drafts.delete(projectId);
  return draft;
}

export const hasDraft = (projectId: string): boolean => drafts.has(projectId);

onSessionEnd(() => drafts.clear());

/** For tests. */
export function __resetDraftsForTests(): void {
  drafts.clear();
}
