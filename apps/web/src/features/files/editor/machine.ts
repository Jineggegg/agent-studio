import type { SaveFileRequest } from '@agent-studio/protocol';
import type { Problem } from '@/features/projects/tools/kit';

/**
 * What the editor knows about the file it holds, apart from the text itself
 * (which lives in the editor widget): whether there is anything unsaved,
 * whether a save is on its way, and — when the file changed underneath —
 * the two honest ways on. Pure: every transition is a function of the state
 * and an event, so the rules below can be tested without a browser.
 *
 * The rules:
 *  - nothing is ever saved over a version the person has not seen, unless
 *    they chose "overwrite" after being told;
 *  - a refused save changes nothing about the text in hand;
 *  - leaving with unsaved text always asks first.
 */
export type ConflictReason =
  /** Someone or something else wrote the file since it was opened. */
  | 'changed'
  /** The file was deleted or moved since it was opened. */
  | 'gone'
  /** A new file was to be created and something is already there. */
  | 'exists';

export interface Conflict {
  reason: ConflictReason;
  /** The version on the server now; null when the file is gone. What "overwrite" is told it is overwriting. */
  currentVersion: string | null;
}

export interface DocumentState {
  /** The version the text in hand started from; null for a file that does not exist yet. */
  baseVersion: string | null;
  /** The text differs from what was last read or saved. */
  dirty: boolean;
  saving: boolean;
  /** When the last save succeeded; cleared by the next edit. Drives the brief "Saved". */
  savedAt: number | null;
  conflict: Conflict | null;
  /** The file changed on the server while unsaved text is in hand: said at once, long before a save is refused. */
  changedElsewhere: boolean;
  /** Why the last save failed, when it was not a conflict. */
  problem: Problem | null;
}

export type DocumentEvent =
  /** The text now equals / differs from the last saved text. */
  | { type: 'edited'; dirty: boolean }
  | { type: 'save-started' }
  | { type: 'saved'; version: string; at: number }
  | { type: 'save-refused'; conflict: Conflict }
  | { type: 'save-failed'; problem: Problem }
  /** The server announced a change to this file that this editor did not make. */
  | { type: 'changed-elsewhere' }
  /** "Reload theirs" was chosen and the server's text is now in hand. */
  | { type: 'reloaded'; version: string | null }
  /** A notice was read and put away; the text and its base stay as they are. */
  | { type: 'dismissed' };

export const openedDocument = (version: string | null): DocumentState => ({
  baseVersion: version,
  dirty: false,
  saving: false,
  savedAt: null,
  conflict: null,
  changedElsewhere: false,
  problem: null,
});

export function documentReducer(state: DocumentState, event: DocumentEvent): DocumentState {
  switch (event.type) {
    case 'edited':
      if (state.dirty === event.dirty) return state;
      return { ...state, dirty: event.dirty, savedAt: event.dirty ? null : state.savedAt };
    case 'save-started':
      return state.saving ? state : { ...state, saving: true, problem: null };
    case 'saved':
      // Text typed while the request was in the air is still unsaved: `dirty` is recomputed by the next `edited`.
      return { ...state, baseVersion: event.version, saving: false, dirty: false, savedAt: event.at, conflict: null, changedElsewhere: false, problem: null };
    case 'save-refused':
      return { ...state, saving: false, conflict: event.conflict, changedElsewhere: false };
    case 'save-failed':
      return { ...state, saving: false, problem: event.problem };
    case 'changed-elsewhere':
      // With nothing unsaved the editor simply reads the file again (see `mustReload`); otherwise it says so and waits.
      return state.dirty && !state.conflict ? { ...state, changedElsewhere: true } : state;
    case 'reloaded':
      return openedDocument(event.version);
    case 'dismissed':
      return { ...state, changedElsewhere: false, problem: null };
  }
}

/** Whether Save has anything to do. A conflict must be answered first: saving again would only be refused again. */
export const canSave = (state: DocumentState): boolean => state.dirty && !state.saving && state.conflict === null;

/**
 * The request for a save. An ordinary save names the version the text started
 * from, so the server can refuse when the file moved on. "Overwrite" is the
 * explicit choice made after such a refusal — and only then is `force` sent.
 */
export function saveRequest(state: DocumentState, path: string, content: string, overwrite = false): SaveFileRequest {
  if (overwrite && state.conflict) return { path, content, baseVersion: state.conflict.currentVersion, force: true };
  return { path, content, baseVersion: state.baseVersion, force: false };
}

/** What a refusal from the server means, from its code and details. Null when the refusal is not a conflict. */
export function conflictFrom(code: string, details: unknown): Conflict | null {
  if (code !== 'file_changed' && code !== 'file_exists') return null;
  const current = (details as { currentVersion?: unknown } | null | undefined)?.currentVersion;
  const currentVersion = typeof current === 'string' ? current : null;
  if (code === 'file_exists') return { reason: 'exists', currentVersion };
  return { reason: currentVersion === null ? 'gone' : 'changed', currentVersion };
}

/** A change announced by the server concerns this editor only when it did not come from its own save. */
export const mustReload = (state: DocumentState): boolean => !state.dirty && !state.saving && state.conflict === null;

/** Every way out of the editor asks this first. `confirm` means: unsaved text would be lost, ask the person. */
export const leaveGuard = (state: DocumentState | null): 'free' | 'confirm' => (state !== null && (state.dirty || state.saving) ? 'confirm' : 'free');

// ---- text as it is stored ------------------------------------------------------------

export interface TextShape {
  /** The file starts with a byte-order mark, which is kept but never shown. */
  bom: boolean;
  /** The line break the file uses and is saved with. */
  lineBreak: '\n' | '\r\n';
}

const BOM = '﻿';

/** Splits a file's text into what is edited and what must be put back exactly on saving. */
export function readShape(content: string, lineEnding: 'lf' | 'crlf' | 'mixed' | 'none'): { text: string; shape: TextShape } {
  const bom = content.startsWith(BOM);
  return { text: bom ? content.slice(1) : content, shape: { bom, lineBreak: lineEnding === 'crlf' ? '\r\n' : '\n' } };
}

/** The editor's lines joined the way the file had them. */
export function writeShape(lines: Iterable<string>, shape: TextShape): string {
  let text = shape.bom ? BOM : '';
  let first = true;
  for (const line of lines) {
    if (!first) text += shape.lineBreak;
    text += line;
    first = false;
  }
  return text;
}
