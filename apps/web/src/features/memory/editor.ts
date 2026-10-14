import { type CreateMemoryNoteRequest, MEMORY_ERRORS, MEMORY_LIMITS, type MemoryNote, type UpdateMemoryNoteRequest } from '@agent-studio/protocol';

/**
 * The note editor as a state machine, kept apart from the screen so that the
 * one thing it must never get wrong — a save that would silently replace a
 * newer version — can be tested on its own.
 *
 * A save carries the version the draft was based on. When the note changed
 * since (another device, an assistant, a hand edit) the server refuses with
 * `memory_note_changed` and nothing is written; the editor then holds both
 * versions and offers exactly two honest ways on: keep mine and replace
 * theirs, or take theirs and drop mine.
 */

export interface NoteDraft {
  title: string;
  /** Where a new note goes (a folder, optionally with sub-folders). Fixed once the note exists: moving is its own action. */
  folder: string;
  /** As typed: separated by spaces or commas. */
  tags: string;
  keywords: string;
  body: string;
}

export type EditorPhase = 'editing' | 'saving' | 'conflict' | 'saved';

export interface EditorProblem {
  code: string;
  message: string;
  details?: unknown;
}

export interface EditorState {
  phase: EditorPhase;
  /** Null until the note exists. */
  noteId: string | null;
  /** The version the draft is based on: sent back as `baseVersion`. */
  baseVersion: string | null;
  /** The note as it was when this draft started, to tell what changed. */
  original: NoteDraft;
  draft: NoteDraft;
  /** The text could not be loaded in full, so only the title, tags and keywords may be saved. */
  bodyLocked: boolean;
  /** In `conflict`: the newer version, as far as it is known yet. */
  conflict: { currentVersion: string | null; theirs: MemoryNote | null } | null;
  /** A refusal that is not a conflict (a credential, a title already taken…). Cleared by the next change. */
  problem: EditorProblem | null;
  /** In `saving`: this save replaces a newer version on purpose. */
  overwriting: boolean;
  saved: MemoryNote | null;
}

export type EditorEvent =
  | { type: 'change'; patch: Partial<NoteDraft> }
  | { type: 'save' }
  | { type: 'saved'; note: MemoryNote }
  | { type: 'refused'; problem: EditorProblem }
  | { type: 'theirs'; note: MemoryNote }
  | { type: 'overwrite' }
  | { type: 'take-theirs' }
  /** The note is gone from where it was (moved or deleted elsewhere): keep the text as a new note in the same place. */
  | { type: 'save-as-new' };

export const EMPTY_DRAFT: NoteDraft = { title: '', folder: '', tags: '', keywords: '', body: '' };

export function draftFromNote(note: MemoryNote): NoteDraft {
  return { title: note.title, folder: note.path, tags: note.tags.join(' '), keywords: note.keywords.join(' '), body: note.body };
}

export function newNoteEditor(folder: string): EditorState {
  const draft = { ...EMPTY_DRAFT, folder };
  return { phase: 'editing', noteId: null, baseVersion: null, original: draft, draft, bodyLocked: false, conflict: null, problem: null, overwriting: false, saved: null };
}

export function editNoteEditor(note: MemoryNote): EditorState {
  const draft = draftFromNote(note);
  return { phase: 'editing', noteId: note.id, baseVersion: note.version, original: draft, draft, bodyLocked: note.truncated, conflict: null, problem: null, overwriting: false, saved: null };
}

/** Tags or keywords as typed → a clean list: split on spaces and commas (also the Chinese ones), "#" dropped, no repeats. */
export function parseList(text: string): string[] {
  const seen = new Set<string>();
  const list: string[] = [];
  for (const raw of text.split(/[\s,，、;；]+/)) {
    const word = raw.replace(/^#+/, '').trim();
    if (word === '' || seen.has(word.toLowerCase())) continue;
    seen.add(word.toLowerCase());
    list.push(word);
  }
  return list;
}

const sameList = (a: string, b: string): boolean => parseList(a).join('\n') === parseList(b).join('\n');

export function isDirty(state: EditorState): boolean {
  const { draft, original } = state;
  return (
    draft.title.trim() !== original.title.trim() ||
    draft.body !== original.body ||
    !sameList(draft.tags, original.tags) ||
    !sameList(draft.keywords, original.keywords) ||
    (state.noteId === null && draft.folder !== original.folder)
  );
}

/** What is wrong with the draft before anything is sent, or null. The server checks again. */
export function draftProblem(state: EditorState): 'title' | 'title-slash' | 'title-long' | 'body' | 'body-long' | 'folder' | null {
  const title = state.draft.title.replace(/\s+/g, ' ').trim();
  if (title === '') return 'title';
  if (/[/\\]/.test(title)) return 'title-slash';
  if (title.length > MEMORY_LIMITS.titleChars) return 'title-long';
  if (!state.bodyLocked) {
    if (state.draft.body.trim() === '') return 'body';
    if (state.draft.body.length > MEMORY_LIMITS.bodyChars) return 'body-long';
  }
  if (state.noteId === null && state.draft.folder.trim() === '') return 'folder';
  return null;
}

export type SaveRequest = { kind: 'create'; body: CreateMemoryNoteRequest } | { kind: 'update'; body: UpdateMemoryNoteRequest };

/**
 * The request a save sends: a new note, or the changed fields of an existing
 * one with the version they were based on. Replacing a newer version sends
 * everything, so what is saved is exactly what is on screen. Null when there
 * is nothing to send.
 */
export function saveRequest(state: EditorState): SaveRequest | null {
  const { draft, original } = state;
  const title = draft.title.replace(/\s+/g, ' ').trim();
  if (state.noteId === null) {
    return { kind: 'create', body: { folder: draft.folder.trim().replace(/^\/+|\/+$/g, ''), title, body: draft.body, tags: parseList(draft.tags), keywords: parseList(draft.keywords) } };
  }
  if (state.baseVersion === null) return null;
  const everything = state.overwriting;
  const body: UpdateMemoryNoteRequest = { id: state.noteId, baseVersion: state.baseVersion };
  if (everything || title !== original.title.trim()) body.title = title;
  if (!state.bodyLocked && (everything || draft.body !== original.body)) body.body = draft.body;
  if (everything || !sameList(draft.tags, original.tags)) body.tags = parseList(draft.tags);
  if (everything || !sameList(draft.keywords, original.keywords)) body.keywords = parseList(draft.keywords);
  const changes = Object.keys(body).length - 2;
  return changes > 0 ? { kind: 'update', body } : null;
}

export function editorReducer(state: EditorState, event: EditorEvent): EditorState {
  switch (event.type) {
    case 'change':
      if (state.phase === 'saving') return state;
      return { ...state, draft: { ...state.draft, ...event.patch }, problem: null, phase: state.phase === 'saved' ? 'editing' : state.phase };
    case 'save':
      if (state.phase !== 'editing' && state.phase !== 'saved') return state;
      return { ...state, phase: 'saving', overwriting: false, problem: null };
    case 'overwrite': {
      if (state.phase !== 'conflict' || !state.conflict) return state;
      const version = state.conflict.currentVersion ?? state.conflict.theirs?.version ?? null;
      if (version === null) return state;
      return { ...state, phase: 'saving', baseVersion: version, overwriting: true, problem: null };
    }
    case 'saved': {
      const draft = draftFromNote(event.note);
      return { ...state, phase: 'saved', noteId: event.note.id, baseVersion: event.note.version, original: draft, draft, bodyLocked: event.note.truncated, conflict: null, problem: null, overwriting: false, saved: event.note };
    }
    case 'refused':
      if (state.phase !== 'saving') return state;
      if (event.problem.code === MEMORY_ERRORS.noteChanged && state.noteId !== null) {
        const details = event.problem.details as { currentVersion?: unknown } | null | undefined;
        const currentVersion = typeof details?.currentVersion === 'string' ? details.currentVersion : null;
        return { ...state, phase: 'conflict', overwriting: false, conflict: { currentVersion, theirs: null } };
      }
      if (event.problem.code === MEMORY_ERRORS.noteTooLong) return { ...state, phase: 'editing', overwriting: false, bodyLocked: true, problem: event.problem };
      return { ...state, phase: state.conflict ? 'conflict' : 'editing', overwriting: false, problem: event.problem };
    case 'theirs':
      if (state.phase !== 'conflict' || !state.conflict) return state;
      return { ...state, conflict: { currentVersion: state.conflict.currentVersion ?? event.note.version, theirs: event.note } };
    case 'take-theirs': {
      const theirs = state.conflict?.theirs;
      if (state.phase !== 'conflict' || !theirs) return state;
      const draft = draftFromNote(theirs);
      return { ...state, phase: 'editing', noteId: theirs.id, baseVersion: theirs.version, original: draft, draft, bodyLocked: theirs.truncated, conflict: null, problem: null };
    }
    case 'save-as-new': {
      if (state.phase !== 'conflict' || state.bodyLocked) return state;
      const original = { ...EMPTY_DRAFT, folder: state.original.folder };
      return { ...state, phase: 'editing', noteId: null, baseVersion: null, original, conflict: null, problem: null };
    }
  }
}
