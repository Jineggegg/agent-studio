import { describe, expect, it } from 'vitest';
import { type DocumentEvent, type DocumentState, canSave, conflictFrom, documentReducer, leaveGuard, mustReload, openedDocument, readShape, saveRequest, writeShape } from './machine';

const run = (state: DocumentState, ...events: DocumentEvent[]): DocumentState => events.reduce(documentReducer, state);
const opened = () => openedDocument('v1');
const edited = () => run(opened(), { type: 'edited', dirty: true });

describe('saving', () => {
  it('has nothing to save until the text differs from what was read', () => {
    expect(canSave(opened())).toBe(false);
    expect(canSave(edited())).toBe(true);
    // Typing a character and deleting it again leaves nothing to save.
    expect(canSave(run(edited(), { type: 'edited', dirty: false }))).toBe(false);
  });

  it('names the version the text started from, and never forces', () => {
    expect(saveRequest(edited(), 'src/app.ts', 'new text')).toEqual({ path: 'src/app.ts', content: 'new text', baseVersion: 'v1', force: false });
  });

  it('does not start a second save while one is under way', () => {
    const saving = run(edited(), { type: 'save-started' });
    expect(saving.saving).toBe(true);
    expect(canSave(saving)).toBe(false);
  });

  it('after a save: the new version is the base, nothing is unsaved, and "saved" shows until the next edit', () => {
    const saved = run(edited(), { type: 'save-started' }, { type: 'saved', version: 'v2', at: 1000 });
    expect(saved).toMatchObject({ baseVersion: 'v2', dirty: false, saving: false, savedAt: 1000, conflict: null, problem: null });
    expect(saveRequest(run(saved, { type: 'edited', dirty: true }), 'a', 'x').baseVersion).toBe('v2');
    expect(run(saved, { type: 'edited', dirty: true }).savedAt).toBeNull();
  });

  it('keeps the text unsaved when a save fails for another reason, and says why', () => {
    const failed = run(edited(), { type: 'save-started' }, { type: 'save-failed', problem: { text: 'The server has no space left for that.' } });
    expect(failed).toMatchObject({ dirty: true, saving: false, baseVersion: 'v1' });
    expect(failed.problem?.text).toBe('The server has no space left for that.');
    expect(canSave(failed)).toBe(true);
    expect(run(failed, { type: 'dismissed' }).problem).toBeNull();
  });
});

describe('the file changing underneath', () => {
  it('reads a refusal as a conflict only when it is one', () => {
    expect(conflictFrom('file_changed', { currentVersion: 'v9' })).toEqual({ reason: 'changed', currentVersion: 'v9' });
    expect(conflictFrom('file_changed', { currentVersion: null })).toEqual({ reason: 'gone', currentVersion: null });
    expect(conflictFrom('file_exists', { currentVersion: 'v3' })).toEqual({ reason: 'exists', currentVersion: 'v3' });
    expect(conflictFrom('permission_denied', {})).toBeNull();
    expect(conflictFrom('file_changed', undefined)).toEqual({ reason: 'gone', currentVersion: null });
  });

  it('a refused save changes nothing about the text in hand and blocks plain saving until it is answered', () => {
    const refused = run(edited(), { type: 'save-started' }, { type: 'save-refused', conflict: { reason: 'changed', currentVersion: 'v9' } });
    expect(refused).toMatchObject({ dirty: true, saving: false, baseVersion: 'v1' });
    expect(refused.conflict).toEqual({ reason: 'changed', currentVersion: 'v9' });
    expect(canSave(refused)).toBe(false);
    // A plain save would still name the old version — and be refused again — rather than overwrite by accident.
    expect(saveRequest(refused, 'a', 'mine')).toEqual({ path: 'a', content: 'mine', baseVersion: 'v1', force: false });
  });

  it('"overwrite with mine" is the only thing that forces, and it names the version it overwrites', () => {
    const refused = run(edited(), { type: 'save-refused', conflict: { reason: 'changed', currentVersion: 'v9' } });
    expect(saveRequest(refused, 'a', 'mine', true)).toEqual({ path: 'a', content: 'mine', baseVersion: 'v9', force: true });
    const settled = run(refused, { type: 'save-started' }, { type: 'saved', version: 'v10', at: 5 });
    expect(settled).toMatchObject({ conflict: null, dirty: false, baseVersion: 'v10' });
  });

  it('without a conflict, "overwrite" is an ordinary save: force is never sent on a whim', () => {
    expect(saveRequest(edited(), 'a', 'mine', true)).toEqual({ path: 'a', content: 'mine', baseVersion: 'v1', force: false });
  });

  it('a file that was deleted is put back only by the explicit choice', () => {
    const refused = run(edited(), { type: 'save-refused', conflict: { reason: 'gone', currentVersion: null } });
    expect(saveRequest(refused, 'a', 'mine', true)).toEqual({ path: 'a', content: 'mine', baseVersion: null, force: true });
  });

  it('"reload theirs" starts over from the server\'s version', () => {
    const refused = run(edited(), { type: 'save-refused', conflict: { reason: 'changed', currentVersion: 'v9' } });
    expect(run(refused, { type: 'reloaded', version: 'v9' })).toEqual(openedDocument('v9'));
  });

  it('with nothing unsaved a change elsewhere is simply read; with unsaved text it is announced and the text is kept', () => {
    expect(mustReload(opened())).toBe(true);
    expect(run(opened(), { type: 'changed-elsewhere' }).changedElsewhere).toBe(false);

    expect(mustReload(edited())).toBe(false);
    const warned = run(edited(), { type: 'changed-elsewhere' });
    expect(warned).toMatchObject({ changedElsewhere: true, dirty: true, baseVersion: 'v1' });
    expect(run(warned, { type: 'dismissed' })).toMatchObject({ changedElsewhere: false, dirty: true });
    // While a save is in the air, the change it causes is not mistaken for someone else's.
    expect(mustReload(run(edited(), { type: 'save-started' }))).toBe(false);
  });
});

describe('leaving', () => {
  it('asks first whenever text would be lost — and only then', () => {
    expect(leaveGuard(null)).toBe('free');
    expect(leaveGuard(opened())).toBe('free');
    expect(leaveGuard(edited())).toBe('confirm');
    expect(leaveGuard(run(edited(), { type: 'save-started' }))).toBe('confirm');
    expect(leaveGuard(run(edited(), { type: 'save-started' }, { type: 'saved', version: 'v2', at: 1 }))).toBe('free');
    expect(leaveGuard(run(edited(), { type: 'save-refused', conflict: { reason: 'changed', currentVersion: 'v9' } }))).toBe('confirm');
    expect(leaveGuard(run(edited(), { type: 'edited', dirty: false }))).toBe('free');
  });
});

describe('text as it is stored', () => {
  it('keeps Windows line endings and a byte-order mark out of sight and puts them back exactly', () => {
    const original = '\uFEFFone\r\ntwo\r\n';
    const { text, shape } = readShape(original, 'crlf');
    expect(text).toBe('one\r\ntwo\r\n');
    expect(shape).toEqual({ bom: true, lineBreak: '\r\n' });
    // The editor holds lines; an unchanged file is written back byte for byte.
    expect(writeShape(['one', 'two', ''], shape)).toBe(original);
  });

  it('writes Unix files with Unix line endings and no mark', () => {
    const { text, shape } = readShape('a\nb', 'lf');
    expect(text).toBe('a\nb');
    expect(writeShape(['a', 'b'], shape)).toBe('a\nb');
    expect(writeShape([], shape)).toBe('');
  });
});
