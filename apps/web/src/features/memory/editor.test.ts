import type { MemoryNote } from '@agent-studio/protocol';
import { describe, expect, it } from 'vitest';
import { type EditorEvent, type EditorState, draftProblem, editNoteEditor, editorReducer, isDirty, newNoteEditor, parseList, saveRequest } from './editor';
import { highlightSegments, withoutRepeatedTitle } from './text';

function note(overrides: Partial<MemoryNote> = {}): MemoryNote {
  return {
    id: 'my-app/decisions/deploy-rules',
    folder: 'my-app',
    path: 'my-app/decisions',
    title: 'Deploy rules',
    author: 'claude-code',
    tags: ['deploy'],
    createdAt: 1_000,
    updatedAt: 2_000,
    credential: null,
    problem: null,
    body: 'Deploy on Fridays only after the checks pass.',
    truncated: false,
    keywords: ['部署', 'release'],
    version: 'version-one-0000',
    access: 'write',
    ...overrides,
  };
}

const run = (state: EditorState, ...events: EditorEvent[]): EditorState => events.reduce(editorReducer, state);
const changed = { type: 'refused', problem: { code: 'memory_note_changed', message: 'changed', details: { currentVersion: 'version-two-0000' } } } as const;

describe('the note editor', () => {
  it('saves only what changed, with the version the draft was based on', () => {
    const state = run(editNoteEditor(note()), { type: 'change', patch: { body: 'Deploy any day after the checks pass.' } }, { type: 'save' });
    expect(state.phase).toBe('saving');
    expect(saveRequest(state)).toEqual({ kind: 'update', body: { id: 'my-app/decisions/deploy-rules', baseVersion: 'version-one-0000', body: 'Deploy any day after the checks pass.' } });
  });

  it('sends nothing when nothing changed — tags and keywords compare as lists, not as typed', () => {
    const state = run(editNoteEditor(note()), { type: 'change', patch: { tags: '#deploy,', keywords: '部署，release ' } });
    expect(isDirty(state)).toBe(false);
    expect(saveRequest(run(state, { type: 'save' }))).toBeNull();
  });

  it('turns a refusal because the note changed into a conflict that keeps the draft and names the newer version', () => {
    const state = run(editNoteEditor(note()), { type: 'change', patch: { body: 'Mine.' } }, { type: 'save' }, changed);
    expect(state.phase).toBe('conflict');
    expect(state.conflict).toEqual({ currentVersion: 'version-two-0000', theirs: null });
    expect(state.draft.body).toBe('Mine.');
    // While both versions are on the table, a plain save is not possible: a choice must be made.
    expect(run(state, { type: 'save' }).phase).toBe('conflict');
  });

  it('"keep mine" saves everything on screen against the newer version, never against the old one', () => {
    const theirs = note({ version: 'version-two-0000', body: 'Theirs.', title: 'Deploy rules (team)' });
    const state = run(editNoteEditor(note()), { type: 'change', patch: { body: 'Mine.' } }, { type: 'save' }, changed, { type: 'theirs', note: theirs }, { type: 'overwrite' });
    expect(state.phase).toBe('saving');
    expect(state.overwriting).toBe(true);
    expect(saveRequest(state)).toEqual({
      kind: 'update',
      body: { id: 'my-app/decisions/deploy-rules', baseVersion: 'version-two-0000', title: 'Deploy rules', body: 'Mine.', tags: ['deploy'], keywords: ['部署', 'release'] },
    });
    const saved = run(state, { type: 'saved', note: note({ version: 'version-three-00', body: 'Mine.' }) });
    expect(saved.phase).toBe('saved');
    expect(saved.baseVersion).toBe('version-three-00');
    expect(isDirty(saved)).toBe(false);
  });

  it('"use theirs" drops my changes and continues from their version', () => {
    const theirs = note({ version: 'version-two-0000', body: 'Theirs.' });
    const state = run(editNoteEditor(note()), { type: 'change', patch: { body: 'Mine.' } }, { type: 'save' }, changed, { type: 'theirs', note: theirs }, { type: 'take-theirs' });
    expect(state.phase).toBe('editing');
    expect(state.draft.body).toBe('Theirs.');
    expect(state.baseVersion).toBe('version-two-0000');
    expect(isDirty(state)).toBe(false);
  });

  it('cannot take their version before it has been read, nor overwrite without knowing it', () => {
    const conflict = run(editNoteEditor(note()), { type: 'change', patch: { body: 'Mine.' } }, { type: 'save' }, { type: 'refused', problem: { code: 'memory_note_changed', message: 'changed' } });
    expect(conflict.conflict).toEqual({ currentVersion: null, theirs: null });
    expect(run(conflict, { type: 'take-theirs' }).phase).toBe('conflict');
    expect(run(conflict, { type: 'overwrite' }).phase).toBe('conflict');
    // Once read, their version supplies the version to overwrite.
    const known = run(conflict, { type: 'theirs', note: note({ version: 'version-two-0000' }) }, { type: 'overwrite' });
    expect(known.baseVersion).toBe('version-two-0000');
  });

  it('keeps the text as a new note when the old one is gone', () => {
    const state = run(editNoteEditor(note()), { type: 'change', patch: { body: 'Mine.' } }, { type: 'save' }, changed, { type: 'save-as-new' });
    expect(state.phase).toBe('editing');
    expect(state.noteId).toBeNull();
    expect(saveRequest(run(state, { type: 'save' }))).toEqual({
      kind: 'create',
      body: { folder: 'my-app/decisions', title: 'Deploy rules', body: 'Mine.', tags: ['deploy'], keywords: ['部署', 'release'] },
    });
  });

  it('reports other refusals without losing the draft, and a second conflict replaces the first', () => {
    const credential = run(newNoteEditor('global'), { type: 'change', patch: { title: 'Keys', body: 'password = Xy7!abcd' } }, { type: 'save' }, { type: 'refused', problem: { code: 'memory_credential', message: 'no', details: { kind: 'password' } } });
    expect(credential.phase).toBe('editing');
    expect(credential.problem?.code).toBe('memory_credential');
    expect(credential.draft.body).toBe('password = Xy7!abcd');
    // Typing clears the problem.
    expect(run(credential, { type: 'change', patch: { body: 'Ask the owner.' } }).problem).toBeNull();

    const twice = run(editNoteEditor(note()), { type: 'change', patch: { body: 'Mine.' } }, { type: 'save' }, changed, { type: 'theirs', note: note({ version: 'version-two-0000' }) }, { type: 'overwrite' }, {
      type: 'refused',
      problem: { code: 'memory_note_changed', message: 'again', details: { currentVersion: 'version-four-000' } },
    });
    expect(twice.phase).toBe('conflict');
    expect(twice.conflict?.currentVersion).toBe('version-four-000');
  });

  it('never sends the text of a note too long to be shown whole', () => {
    const state = run(editNoteEditor(note({ truncated: true })), { type: 'change', patch: { title: 'Deploy rules v2', body: 'cut' } }, { type: 'save' });
    expect(saveRequest(state)).toEqual({ kind: 'update', body: { id: 'my-app/decisions/deploy-rules', baseVersion: 'version-one-0000', title: 'Deploy rules v2' } });
    const refused = run(editNoteEditor(note()), { type: 'change', patch: { body: 'x' } }, { type: 'save' }, { type: 'refused', problem: { code: 'memory_note_too_long_to_edit', message: 'long' } });
    expect(refused.bodyLocked).toBe(true);
  });

  it('checks a draft before sending it', () => {
    const empty = newNoteEditor('global');
    expect(draftProblem(empty)).toBe('title');
    expect(draftProblem(run(empty, { type: 'change', patch: { title: 'a/b', body: 'x' } }))).toBe('title-slash');
    expect(draftProblem(run(empty, { type: 'change', patch: { title: 'Fine' } }))).toBe('body');
    expect(draftProblem(run(empty, { type: 'change', patch: { title: 'Fine', body: 'x', folder: '' } }))).toBe('folder');
    expect(draftProblem(run(empty, { type: 'change', patch: { title: 'Fine', body: 'x' } }))).toBeNull();
  });

  it('reads tags and keywords split by spaces or commas, Chinese ones included, without repeats', () => {
    expect(parseList('#deploy, release，部署、部署 Release;  ')).toEqual(['deploy', 'release', '部署']);
    expect(parseList('')).toEqual([]);
  });
});

describe('note text', () => {
  it('marks highlight ranges, tidying ranges that overlap or run past the end', () => {
    expect(highlightSegments('部署规则：周五发布', [[0, 2]])).toEqual([
      { text: '部署', marked: true },
      { text: '规则：周五发布', marked: false },
    ]);
    expect(highlightSegments('deploy rules', [[7, 12], [0, 3], [2, 6], [11, 99]])).toEqual([
      { text: 'deploy', marked: true },
      { text: ' ', marked: false },
      { text: 'rules', marked: true },
    ]);
    expect(highlightSegments('plain', [])).toEqual([{ text: 'plain', marked: false }]);
  });

  it('drops a first heading that only repeats the title', () => {
    expect(withoutRepeatedTitle('# Deploy rules\n\nBody.', 'Deploy rules')).toBe('Body.');
    expect(withoutRepeatedTitle('# Something else\n\nBody.', 'Deploy rules')).toBe('# Something else\n\nBody.');
    expect(withoutRepeatedTitle('Body only.', 'Deploy rules')).toBe('Body only.');
  });
});
