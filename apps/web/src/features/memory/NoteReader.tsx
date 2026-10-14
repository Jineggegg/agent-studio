import type { MemoryFolder, MemoryNote } from '@agent-studio/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileWarning, FolderInput, KeyRound, Pencil, ShieldCheck, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { isApiError } from '@/data/api';
import { describeError } from '@/data/errors';
import { useT } from '@/i18n';
import { Badge, Banner, Button, ErrorState, Sheet, SkeletonText, confirm, toTint, toast } from '@/ui';
import { Markdown } from '@/ui/markdown';
import { memoryApi, memoryKeys } from './api';
import { FolderMark } from './FolderMark';
import { MoveSheet } from './MoveSheet';
import { CREDENTIAL_KEYS, PROBLEM_KEYS, folderLabel, withoutRepeatedTitle } from './text';
import { noteLeaving, noteStayed } from './useMemoryEvents';

export interface NoteReaderProps {
  noteId: string | null;
  folders: ReadonlyMap<string, MemoryFolder>;
  writable: readonly MemoryFolder[];
  author: (value: string | null) => string | null;
  onClose: () => void;
  /** A keyword was tapped: close and search for it. */
  onKeyword: (keyword: string) => void;
  onEdit: (note: MemoryNote) => void;
  /** Moved or renamed: the note has a new id. */
  onMoved: (note: MemoryNote) => void;
}

/**
 * One note, read. The text is rendered as untrusted Markdown — no raw HTML,
 * no image fetched, only web links (opened without referrer or opener) — and
 * a standing line says what memory is: reference material written by
 * assistants, never instructions.
 */
export function NoteReader({ noteId, folders, writable, author, onClose, onKeyword, onEdit, onMoved }: NoteReaderProps) {
  const t = useT();
  const queryClient = useQueryClient();
  const [shownId, setShownId] = useState<string | null>(noteId);
  const [moving, setMoving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Keep the last note on screen while the sheet plays its exit.
  if (noteId !== null && noteId !== shownId) setShownId(noteId);
  const id = noteId ?? shownId;

  // Read only while open: a note kept on screen for the exit, or one just deleted, is never asked for again.
  const note = useQuery({ queryKey: memoryKeys.note(id ?? ''), queryFn: ({ signal }) => memoryApi.note(id!, signal), enabled: noteId !== null });
  const data = note.data;
  const folder = data ? folders.get(data.folder) : undefined;
  const canWrite = data?.access === 'write';
  const by = data ? author(data.author) : null;

  const remove = async () => {
    if (!id || deleting) return;
    const title = data?.title ?? id.slice(id.lastIndexOf('/') + 1);
    const confirmed = await confirm({
      title: t('memory.delete.title', { title }),
      message: t('memory.delete.text'),
      confirmLabel: t('memory.delete.confirm'),
      tone: 'danger',
    });
    if (!confirmed) return;
    setDeleting(true);
    noteLeaving(id);
    try {
      // Only the version that was read may be deleted; a note that could not be read is deleted as it is.
      await memoryApi.remove(id, data && !data.problem ? data.version : null);
      void queryClient.invalidateQueries({ queryKey: memoryKeys.all, predicate: (query) => query.queryKey[1] !== 'note' });
      toast.success(t('memory.delete.done', { title }));
      onClose();
    } catch (error) {
      noteStayed(id);
      if (isApiError(error) && error.code === 'memory_note_changed') {
        toast.warning(t('memory.delete.changed'));
        void note.refetch();
      } else toast.error(describeError(error, t));
    } finally {
      setDeleting(false);
    }
  };

  // A note that cannot be read can still be removed — unless it is simply gone.
  const failedToLoad = !data && note.isError && !(isApiError(note.error) && note.error.gone);
  return (
    <>
      <Sheet
        open={noteId !== null && !moving}
        onClose={onClose}
        title={data?.title ?? t('memory.reader.title')}
        hideTitle
        size="lg"
        fill
        leading={
          data ? (
            <span className="mem-reader__folder" data-tint={folder?.project ? toTint(folder.project.icon.color, 'blue') : data.folder === 'global' ? 'teal' : 'slate'}>
              <FolderMark folder={folder} name={data.folder} />
              <span className="u-truncate">{folderLabel(folder, data.folder, t)}</span>
            </span>
          ) : undefined
        }
        trailing={
          <Button variant="plain" data-autofocus onClick={onClose}>
            {t('common.done')}
          </Button>
        }
        footer={
          (data && canWrite) || failedToLoad ? (
            <div className="mem-reader__actions">
              {data && canWrite && !data.problem && (
                <Button variant="tinted" icon={<Pencil size={17} />} onClick={() => onEdit(data)}>
                  {t('memory.edit')}
                </Button>
              )}
              {data && canWrite && (
                <Button variant="neutral" icon={<FolderInput size={17} />} onClick={() => setMoving(true)}>
                  {t('memory.move')}
                </Button>
              )}
              {((data && canWrite) || failedToLoad) && (
                <Button variant="plain-danger" icon={<Trash2 size={17} />} loading={deleting} onClick={() => void remove()}>
                  {t('memory.delete')}
                </Button>
              )}
            </div>
          ) : undefined
        }
      >
        {!data ? (
          note.isError ? (
            <ErrorState error={note.error} onRetry={() => void note.refetch()} retrying={note.isFetching} compact />
          ) : (
            <div className="mem-reader" aria-busy="true">
              <SkeletonText lines={6} />
            </div>
          )
        ) : (
          <article className="mem-reader">
            <h3 className="mem-reader__title">{data.title}</h3>
            <p className="mem-reader__meta">
              {by && <Badge tone="neutral">{by}</Badge>}
              <span>{t('memory.reader.updated', { when: t.relative(data.updatedAt) })}</span>
              {data.path !== data.folder && <span className="u-mono mem-reader__path">{data.path.slice(data.folder.length + 1)}</span>}
            </p>
            {data.tags.length > 0 && (
              <ul className="mem-tags" aria-label={t('memory.reader.tags')}>
                {data.tags.map((tag) => (
                  <li key={tag}>#{tag}</li>
                ))}
              </ul>
            )}
            {data.credential && (
              <Banner tone="danger" title={t('memory.credential.title')}>
                <p>{t('memory.credential.text', { kind: t(CREDENTIAL_KEYS[data.credential]) })}</p>
              </Banner>
            )}
            {data.problem && (
              <Banner tone="warning" title={t('memory.problem.title')}>
                <p>{t(PROBLEM_KEYS[data.problem])}</p>
              </Banner>
            )}
            {data.truncated && (
              <Banner tone="info">
                <p>{t('memory.reader.truncated')}</p>
              </Banner>
            )}
            {!data.problem && (
              <div className="mem-reader__body">
                <Markdown>{withoutRepeatedTitle(data.body, data.title)}</Markdown>
              </div>
            )}
            {data.keywords.length > 0 && (
              <div className="mem-keywords">
                <p className="mem-keywords__label">{t('memory.reader.keywords')}</p>
                <div className="mem-keywords__list">
                  {data.keywords.map((keyword) => (
                    <button key={keyword} type="button" className="mem-chip" onClick={() => onKeyword(keyword)} aria-label={t('memory.reader.searchFor', { keyword })}>
                      {keyword}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <p className="mem-reminder">
              <ShieldCheck size={16} aria-hidden="true" />
              <span>{t('memory.reminder')}</span>
            </p>
            {!canWrite && (
              <p className="mem-reader__readonly">
                <KeyRound size={14} aria-hidden="true" />
                {t('memory.reader.readOnly')}
              </p>
            )}
          </article>
        )}
        {failedToLoad && id && (
          <p className="mem-reader__readonly">
            <FileWarning size={14} aria-hidden="true" />
            {t('memory.reader.loadFailed')}
          </p>
        )}
      </Sheet>
      {data && (
        <MoveSheet
          open={moving}
          note={data}
          writable={writable}
          onClose={() => setMoving(false)}
          onMoved={(moved) => {
            setMoving(false);
            onMoved(moved);
          }}
        />
      )}
    </>
  );
}
