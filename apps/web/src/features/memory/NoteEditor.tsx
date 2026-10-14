import { MEMORY_ERRORS, MEMORY_LIMITS, type MemoryChangedEvent, type MemoryFolder, type MemoryNote } from '@agent-studio/protocol';
import { useQueryClient } from '@tanstack/react-query';
import { TriangleAlert } from 'lucide-react';
import { useEffect, useReducer, useRef, useState } from 'react';
import { isApiError } from '@/data/api';
import { describeError } from '@/data/errors';
import { type Translator, useT } from '@/i18n';
import { useUnsavedWork } from '@/pwa/update';
import { Banner, Button, Form, SegmentedControl, Select, Sheet, TextArea, TextField, confirm, toast } from '@/ui';
import { Markdown } from '@/ui/markdown';
import { memoryApi, memoryKeys } from './api';
import { type EditorState, draftProblem, editNoteEditor, editorReducer, isDirty, newNoteEditor, saveRequest } from './editor';
import { credentialKind, folderLabel } from './text';
import { noteLeaving, noteStayed, useMemoryEvents } from './useMemoryEvents';

export type EditorTarget = { kind: 'new'; folder: string } | { kind: 'edit'; note: MemoryNote };

/** A conflict or refusal appears above a text that may be scrolled down: bring it into view (a stable ref, so once each time it appears). */
const reveal = (element: HTMLElement | null) => element?.scrollIntoView?.({ block: 'nearest' });

function initialState(target: EditorTarget | null): EditorState {
  if (!target) return newNoteEditor('');
  return target.kind === 'new' ? newNoteEditor(target.folder) : editNoteEditor(target.note);
}

/** A refused save in words. The value that looked like a credential is never repeated: the server does not send it. */
function problemText(problem: NonNullable<EditorState['problem']>, t: Translator): string {
  switch (problem.code) {
    case MEMORY_ERRORS.credential:
      return t('memory.editor.credential', { kind: credentialKind(problem.details, t) });
    case MEMORY_ERRORS.noteExists:
      return t('memory.editor.exists');
    case MEMORY_ERRORS.folderFull:
      return t('memory.editor.folderFull', { max: t.number(MEMORY_LIMITS.notesPerFolder) });
    case MEMORY_ERRORS.noteTooLong:
      return t('memory.editor.tooLong');
    case MEMORY_ERRORS.readOnly:
      return t('memory.editor.readOnly');
    default:
      return problem.message;
  }
}

export interface NoteEditorProps {
  target: EditorTarget | null;
  writable: readonly MemoryFolder[];
  onClose: () => void;
  onSaved: (note: MemoryNote) => void;
}

/**
 * Writing a note, new or existing: title, folder, tags, keywords and the
 * Markdown text with a preview. A save carries the version it started from;
 * if the note changed meanwhile, both versions are shown and the person
 * chooses — never a silent overwrite.
 *
 * Every opening starts a fresh draft; the last one stays on screen while the
 * sheet plays its exit.
 */
export function NoteEditor({ target, ...rest }: NoteEditorProps) {
  const [shown, setShown] = useState<{ target: EditorTarget; generation: number } | null>(null);
  if (target !== null && target !== shown?.target) setShown({ target, generation: (shown?.generation ?? 0) + 1 });
  if (!shown) return null;
  return <EditorSheet key={shown.generation} target={shown.target} open={target !== null} {...rest} />;
}

function EditorSheet({ target, open, writable, onClose, onSaved }: Omit<NoteEditorProps, 'target'> & { target: EditorTarget; open: boolean }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [state, dispatch] = useReducer(editorReducer, target, initialState);
  const [view, setView] = useState<'write' | 'preview'>('write');
  const [changedElsewhere, setChangedElsewhere] = useState<MemoryChangedEvent['action'] | null>(null);
  const [theirsMissing, setTheirsMissing] = useState(false);
  const [showTheirs, setShowTheirs] = useState(false);
  const ownSaveUntil = useRef(0);

  const dirty = open && isDirty(state);
  useUnsavedWork(dirty);

  const folderOfNote = state.noteId ? state.noteId.split('/', 1)[0]! : null;
  useMemoryEvents(folderOfNote && open ? [folderOfNote] : [], (event) => {
    if (!state.noteId || Date.now() < ownSaveUntil.current || state.phase === 'saving') return;
    if (event.id === state.noteId || event.previousId === state.noteId) setChangedElsewhere(event.action);
  });

  // The newer version is fetched as soon as a conflict is known, so both can be shown.
  const conflictVersion = state.phase === 'conflict' ? (state.conflict?.currentVersion ?? 'unknown') : null;
  useEffect(() => {
    if (conflictVersion === null || !state.noteId) return;
    let cancelled = false;
    setTheirsMissing(false);
    memoryApi.note(state.noteId).then(
      (note) => {
        if (!cancelled) dispatch({ type: 'theirs', note });
      },
      (error: unknown) => {
        if (!cancelled && isApiError(error) && error.gone) setTheirsMissing(true);
      },
    );
    return () => {
      cancelled = true;
    };
    // Fetched once per conflict.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conflictVersion]);

  const save = async (overwrite: boolean) => {
    if (state.phase === 'saving') return;
    const next = editorReducer(state, overwrite ? { type: 'overwrite' } : { type: 'save' });
    if (next.phase !== 'saving') return;
    const request = saveRequest(next);
    if (!request) {
      onClose();
      return;
    }
    dispatch(overwrite ? { type: 'overwrite' } : { type: 'save' });
    // A new title can give the note a new name (its id): the old one may be gone when the news of it arrives.
    const renaming = request.kind === 'update' && request.body.title !== undefined ? request.body.id : null;
    if (renaming) noteLeaving(renaming);
    try {
      const note = request.kind === 'create' ? await memoryApi.create(request.body) : await memoryApi.update(request.body);
      if (renaming && note.id === renaming) noteStayed(renaming);
      ownSaveUntil.current = Date.now() + 3000;
      dispatch({ type: 'saved', note });
      setChangedElsewhere(null);
      queryClient.setQueryData(memoryKeys.note(note.id), note);
      if (state.noteId && note.id !== state.noteId) queryClient.removeQueries({ queryKey: memoryKeys.note(state.noteId) });
      void queryClient.invalidateQueries({ queryKey: memoryKeys.all, predicate: (query) => query.queryKey[1] !== 'note' });
      toast.success(request.kind === 'create' ? t('memory.editor.created') : t('memory.editor.saved'));
      onSaved(note);
    } catch (error) {
      if (renaming) noteStayed(renaming);
      dispatch({
        type: 'refused',
        problem: isApiError(error) ? { code: error.code, message: describeError(error, t), details: error.details } : { code: 'unknown', message: describeError(error, t) },
      });
    }
  };

  const close = async () => {
    if (state.phase === 'saving') return;
    if (dirty && !(await confirm({ title: t('memory.editor.discardTitle'), message: t('memory.editor.discardText'), confirmLabel: t('memory.editor.discard'), tone: 'danger' }))) return;
    onClose();
  };

  const saving = state.phase === 'saving';
  const isNew = state.noteId === null;
  const local = draftProblem(state);
  const titleError = state.draft.title !== '' && (local === 'title-slash' || local === 'title-long') ? t(local === 'title-slash' ? 'memory.editor.titleSlash' : 'memory.editor.titleLong', { max: MEMORY_LIMITS.titleChars }) : null;
  const folderOptions = writable.map((entry) => ({ value: entry.name, label: folderLabel(entry, entry.name, t) }));
  const topFolder = state.draft.folder.split('/', 1)[0] ?? '';
  const subFolder = state.draft.folder.slice(topFolder.length + 1);
  const theirs = state.conflict?.theirs ?? null;

  return (
    <Sheet
      open={open}
      onClose={() => void close()}
      title={isNew ? t('memory.editor.newTitle') : t('memory.editor.editTitle')}
      size="lg"
      fill
      dismissible={!saving}
      leading={
        <Button variant="plain" disabled={saving} onClick={() => void close()}>
          {t('common.cancel')}
        </Button>
      }
      trailing={
        <Button variant="plain" loading={saving && !state.overwriting} disabled={local !== null || state.phase === 'conflict' || saving} onClick={() => void save(false)}>
          {t('common.save')}
        </Button>
      }
    >
      <Form className="mem-form" onSubmit={() => void save(false)}>
        {state.phase === 'conflict' && (
          <section className="mem-conflict" role="alert" aria-labelledby="mem-conflict-title" ref={reveal}>
            <p className="mem-conflict__title" id="mem-conflict-title">
              <TriangleAlert size={18} aria-hidden="true" />
              {t('memory.conflict.title')}
            </p>
            <p>{theirsMissing ? t('memory.conflict.gone') : t('memory.conflict.text')}</p>
            {theirs && (
              <>
                <p className="mem-conflict__meta">{t('memory.conflict.theirs', { when: t.relative(theirs.updatedAt), title: theirs.title })}</p>
                <Button size="sm" variant="plain" onClick={() => setShowTheirs(!showTheirs)} aria-expanded={showTheirs}>
                  {showTheirs ? t('memory.conflict.hideTheirs') : t('memory.conflict.showTheirs')}
                </Button>
                {showTheirs && (
                  <div className="mem-conflict__theirs">
                    <Markdown compact>{theirs.body}</Markdown>
                  </div>
                )}
              </>
            )}
            <div className="mem-conflict__choices">
              {!theirsMissing && (
                <div className="mem-conflict__choice">
                  <Button variant="primary" loading={saving && state.overwriting} disabled={saving || (!theirs && !state.conflict?.currentVersion)} onClick={() => void save(true)}>
                    {t('memory.conflict.keepMine')}
                  </Button>
                  <p>{t('memory.conflict.keepMineText')}</p>
                </div>
              )}
              {!theirsMissing && (
                <div className="mem-conflict__choice">
                  <Button variant="neutral" disabled={saving || !theirs} onClick={() => dispatch({ type: 'take-theirs' })}>
                    {t('memory.conflict.takeTheirs')}
                  </Button>
                  <p>{t('memory.conflict.takeTheirsText')}</p>
                </div>
              )}
              {theirsMissing && !state.bodyLocked && (
                <div className="mem-conflict__choice">
                  <Button variant="primary" disabled={saving} onClick={() => dispatch({ type: 'save-as-new' })}>
                    {t('memory.conflict.saveAsNew')}
                  </Button>
                  <p>{t('memory.conflict.saveAsNewText')}</p>
                </div>
              )}
            </div>
          </section>
        )}
        {changedElsewhere && state.phase !== 'conflict' && (
          <Banner tone="warning">
            <p>{changedElsewhere === 'deleted' ? t('memory.editor.deletedElsewhere') : t('memory.editor.changedElsewhere')}</p>
          </Banner>
        )}
        {state.problem && (
          <div key={`${state.problem.code}:${state.problem.message}`} ref={reveal}>
            <Banner tone="danger" role="alert">
              <p>{problemText(state.problem, t)}</p>
            </Banner>
          </div>
        )}
        <TextField
          label={t('memory.editor.title')}
          value={state.draft.title}
          onChange={(title) => dispatch({ type: 'change', patch: { title } })}
          maxLength={400}
          disabled={saving}
          error={titleError}
          data-autofocus=""
          autoComplete="off"
        />
        {isNew && (
          <div className="mem-form__row">
            <div className="ui-field">
              <span className="ui-field__label">{t('memory.editor.folder')}</span>
              <Select
                label={t('memory.editor.folder')}
                value={topFolder}
                onChange={(folder) => dispatch({ type: 'change', patch: { folder: subFolder ? `${folder}/${subFolder}` : folder } })}
                options={folderOptions}
                block
                disabled={saving}
              />
            </div>
            <TextField
              label={t('memory.editor.subfolder')}
              optional
              mono
              value={subFolder}
              onChange={(sub) => dispatch({ type: 'change', patch: { folder: sub.trim() === '' ? topFolder : `${topFolder}/${sub}` } })}
              hint={t('memory.editor.subfolderHint')}
              disabled={saving}
              autoCapitalize="none"
              spellCheck={false}
            />
          </div>
        )}
        <TextField
          label={t('memory.editor.tags')}
          optional
          value={state.draft.tags}
          onChange={(tags) => dispatch({ type: 'change', patch: { tags } })}
          hint={t('memory.editor.tagsHint')}
          disabled={saving}
          autoCapitalize="none"
          autoComplete="off"
        />
        <TextField
          label={t('memory.editor.keywords')}
          optional
          value={state.draft.keywords}
          onChange={(keywords) => dispatch({ type: 'change', patch: { keywords } })}
          hint={t('memory.editor.keywordsHint')}
          disabled={saving}
          autoComplete="off"
        />
        <div className="mem-form__body">
          <div className="mem-form__body-head">
            <span className="ui-field__label" id="mem-body-label">
              {t('memory.editor.body')}
            </span>
            <SegmentedControl
              label={t('memory.editor.view')}
              value={view}
              onChange={setView}
              options={[
                { value: 'write', label: t('memory.editor.write') },
                { value: 'preview', label: t('memory.editor.preview') },
              ]}
            />
          </div>
          {state.bodyLocked ? (
            <Banner tone="info">
              <p>{t('memory.editor.bodyLocked')}</p>
            </Banner>
          ) : view === 'write' ? (
            <TextArea
              label={t('memory.editor.body')}
              hideLabel
              value={state.draft.body}
              onChange={(body) => dispatch({ type: 'change', patch: { body } })}
              rows={12}
              autoGrow
              maxRows={24}
              mono
              disabled={saving}
              error={state.draft.body.length > MEMORY_LIMITS.bodyChars ? t('memory.editor.bodyLong', { max: t.number(MEMORY_LIMITS.bodyChars) }) : null}
              hint={t('memory.editor.bodyHint')}
            />
          ) : (
            <div className="mem-preview" aria-labelledby="mem-body-label">
              {state.draft.body.trim() === '' ? <p className="mem-preview__empty">{t('memory.editor.previewEmpty')}</p> : <Markdown>{state.draft.body}</Markdown>}
            </div>
          )}
        </div>
        <p className="mem-form__note">{t('memory.editor.noSecrets')}</p>
        <button type="submit" hidden />
      </Form>
    </Sheet>
  );
}
