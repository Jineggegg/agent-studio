import { MEMORY_ERRORS, type MemoryFolder, type MemoryNote, isSafeMemoryPath } from '@agent-studio/protocol';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { isApiError } from '@/data/api';
import { describeError } from '@/data/errors';
import { useT } from '@/i18n';
import { Banner, Button, Form, Select, Sheet, TextField, toast } from '@/ui';
import { memoryApi, memoryKeys } from './api';
import { folderLabel } from './text';
import { noteLeaving, noteStayed } from './useMemoryEvents';

export interface MoveSheetProps {
  open: boolean;
  note: MemoryNote;
  writable: readonly MemoryFolder[];
  onClose: () => void;
  onMoved: (note: MemoryNote) => void;
}

/** The sub-folders of a note's directory below its top-level folder ("decisions" in "my-app/decisions"). */
export function subPath(note: Pick<MemoryNote, 'folder' | 'path'>): string {
  return note.path === note.folder ? '' : note.path.slice(note.folder.length + 1);
}

/**
 * Moves a note to another folder and/or gives it another title. A move only
 * happens to the version that was read: if the note changed meanwhile, the
 * server refuses and nothing moves.
 */
export function MoveSheet({ open, note, writable, onClose, onMoved }: MoveSheetProps) {
  const t = useT();
  const queryClient = useQueryClient();
  const [folder, setFolder] = useState(note.folder);
  const [sub, setSub] = useState(subPath(note));
  const [title, setTitle] = useState(note.title);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // A different note, or the sheet opened again: start from what the note is now.
  const [shown, setShown] = useState(`${note.id}@${note.version}`);
  if (open && shown !== `${note.id}@${note.version}`) {
    setShown(`${note.id}@${note.version}`);
    setFolder(note.folder);
    setSub(subPath(note));
    setTitle(note.title);
    setProblem(null);
  }

  const options = writable.some((entry) => entry.name === note.folder) ? writable : [{ name: note.folder, kind: 'unassigned' as const, project: null, access: 'write' as const, count: 0 }, ...writable];
  const cleanSub = sub.trim().replace(/^\/+|\/+$/g, '');
  const target = cleanSub === '' ? folder : `${folder}/${cleanSub}`;
  const cleanTitle = title.replace(/\s+/g, ' ').trim();
  const subProblem = cleanSub !== '' && !isSafeMemoryPath(cleanSub) ? t('memory.move.subInvalid') : null;
  const titleProblem = cleanTitle === '' ? t('memory.editor.titleMissing') : /[/\\]/.test(cleanTitle) ? t('memory.editor.titleSlash') : null;
  const changed = target !== note.path || cleanTitle !== note.title;

  const submit = async () => {
    if (busy || !changed || subProblem || titleProblem) return;
    setBusy(true);
    setProblem(null);
    noteLeaving(note.id);
    try {
      const moved = await memoryApi.move({
        id: note.id,
        ...(target !== note.path ? { folder: target } : {}),
        ...(cleanTitle !== note.title ? { title: cleanTitle } : {}),
        ...(note.problem ? {} : { baseVersion: note.version }),
      });
      if (moved.id === note.id) noteStayed(note.id);
      queryClient.setQueryData(memoryKeys.note(moved.id), moved);
      void queryClient.invalidateQueries({ queryKey: memoryKeys.all, predicate: (query) => query.queryKey[1] !== 'note' });
      toast.success(t('memory.move.done', { title: moved.title }));
      onMoved(moved);
    } catch (error) {
      noteStayed(note.id);
      if (isApiError(error) && error.code === MEMORY_ERRORS.noteChanged) setProblem(t('memory.move.changed'));
      else if (isApiError(error) && error.code === MEMORY_ERRORS.noteExists) setProblem(t('memory.move.exists'));
      else setProblem(describeError(error, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t('memory.move.title')}
      dismissible={!busy}
      footer={
        <>
          <Button variant="primary" block loading={busy} disabled={!changed || subProblem !== null || titleProblem !== null} onClick={() => void submit()}>
            {t('memory.move.submit')}
          </Button>
          <Button variant="plain" block disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </Button>
        </>
      }
    >
      <Form className="mem-form" onSubmit={() => void submit()}>
        {problem && (
          <Banner tone="danger" role="alert">
            <p>{problem}</p>
          </Banner>
        )}
        <TextField label={t('memory.editor.title')} value={title} onChange={setTitle} maxLength={400} error={title !== note.title ? titleProblem : null} />
        <div className="ui-field">
          <span className="ui-field__label">{t('memory.editor.folder')}</span>
          <Select
            label={t('memory.editor.folder')}
            value={folder}
            onChange={setFolder}
            block
            options={options.map((entry) => ({ value: entry.name, label: folderLabel(entry, entry.name, t) }))}
          />
        </div>
        <TextField label={t('memory.editor.subfolder')} optional value={sub} onChange={setSub} mono hint={t('memory.editor.subfolderHint')} error={subProblem} autoCapitalize="none" spellCheck={false} />
        <p className="mem-form__note">{t('memory.move.note')}</p>
      </Form>
    </Sheet>
  );
}
