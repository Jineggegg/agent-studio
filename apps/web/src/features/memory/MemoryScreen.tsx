import { MEMORY_LIMITS, type MemoryFolder, type MemoryNoteSummary, type MemorySearchHit } from '@agent-studio/protocol';
import { keepPreviousData, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookMarked, FileWarning, KeyRound, Plus, RefreshCw, Search, SearchX, X } from 'lucide-react';
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import { isApiError } from '@/data/api';
import { useStaleness } from '@/data/connection';
import { useUser } from '@/data/session';
import { useAgents } from '@/features/workbench/agents';
import { useT } from '@/i18n';
import { useLayoutClass } from '@/platform/layout';
import { Screen } from '@/shell/Screen';
import { useScreenActive } from '@/shell/ScreenStack';
import { Badge, Button, DelayedSkeleton, EmptyState, ErrorState, IconButton, Skeleton, Spinner, StaleNotice, isImeConfirm, progress, toTint } from '@/ui';
import { memoryApi, memoryKeys } from './api';
import { FolderMark } from './FolderMark';
import { NoteEditor, type EditorTarget } from './NoteEditor';
import { NoteReader } from './NoteReader';
import { StatusCard } from './StatusCard';
import { authorLabel, folderLabel, highlightSegments } from './text';
import { useMemoryEvents } from './useMemoryEvents';
import './memory.css';

/** Typing pauses this long before a search goes out. */
export const SEARCH_DELAY_MS = 250;
const PAGE = MEMORY_LIMITS.listDefault;

/**
 * The search box: what is typed is searched a moment after typing pauses,
 * never while an input method is still composing, and each newer search
 * cancels the one before (see the query below — an abandoned request is
 * aborted, and its answer is never shown).
 */
export function useSearchText(onCommit: (query: string) => void) {
  const [text, setText] = useState('');
  const [isComposing, setComposing] = useState(false);
  const composing = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commit = useRef(onCommit);
  useEffect(() => {
    commit.current = onCommit;
  });
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const schedule = (value: string) => {
    if (timer.current) clearTimeout(timer.current);
    const trimmed = value.trim();
    // Clearing the box is answered at once; anything else waits for the pause.
    if (trimmed === '') {
      timer.current = null;
      commit.current('');
      return;
    }
    timer.current = setTimeout(() => {
      timer.current = null;
      commit.current(trimmed);
    }, SEARCH_DELAY_MS);
  };

  return {
    text,
    composing: isComposing,
    change(value: string, isComposing: boolean) {
      setText(value);
      if (!isComposing && !composing.current) schedule(value);
    },
    compositionStart() {
      composing.current = true;
      setComposing(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    },
    compositionEnd(value: string) {
      composing.current = false;
      setComposing(false);
      setText(value);
      schedule(value);
    },
    set(value: string) {
      setText(value);
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      commit.current(value.trim());
    },
  };
}

function Marked({ text, highlights }: { text: string; highlights: MemorySearchHit['titleHighlights'] }) {
  return (
    <>
      {highlightSegments(text, highlights).map((segment, index) => (segment.marked ? <mark key={index}>{segment.text}</mark> : <span key={index}>{segment.text}</span>))}
    </>
  );
}

function NoteRow({
  note,
  hit,
  folder,
  author,
  onOpen,
}: {
  note: MemoryNoteSummary;
  hit: MemorySearchHit | null;
  folder: MemoryFolder | undefined;
  author: string | null;
  onOpen: () => void;
}) {
  const t = useT();
  const tint = folder?.project ? toTint(folder.project.icon.color, 'blue') : folder?.kind === 'global' ? 'teal' : 'slate';
  return (
    <li className="mem-row">
      <button type="button" className="mem-row__main" onClick={onOpen} aria-haspopup="dialog">
        <span className="mem-row__line">
          <span className="mem-row__title">{hit ? <Marked text={hit.title} highlights={hit.titleHighlights} /> : note.title}</span>
          {author && <Badge tone="neutral">{author}</Badge>}
        </span>
        {hit && hit.snippet.text !== '' && (
          <span className="mem-row__snippet">
            <Marked text={hit.snippet.text} highlights={hit.snippet.highlights} />
          </span>
        )}
        <span className="mem-row__meta">
          <span className="mem-row__folder" data-tint={tint}>
            <FolderMark folder={folder} name={note.folder} />
            <span className="u-truncate">{folderLabel(folder, note.folder, t)}</span>
          </span>
          <span aria-hidden="true">·</span>
          <span>{t.relative(note.updatedAt)}</span>
          {note.credential && (
            <span className="mem-row__flag" data-tone="danger">
              <KeyRound size={13} aria-hidden="true" />
              {t('memory.flag.withheld')}
            </span>
          )}
          {note.problem && (
            <span className="mem-row__flag" data-tone="warning">
              <FileWarning size={13} aria-hidden="true" />
              {t('memory.flag.unreadable')}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}

function RowsSkeleton() {
  const t = useT();
  return (
    <DelayedSkeleton label={t('common.loading')}>
      <ul className="mem-list">
        {[0, 1, 2, 3].map((index) => (
          <li key={index} className="mem-row mem-row--skeleton">
            <Skeleton width="58%" height={15} />
            <Skeleton width="34%" height={12} />
          </li>
        ))}
      </ul>
    </DelayedSkeleton>
  );
}

/**
 * Memory: the notes every assistant reads and writes, for the person. Search
 * them (also in Chinese), browse what changed lately by folder, read one
 * safely rendered, write and edit — and, for the owner, decide whether
 * assistants may use memory at all.
 */
export default function MemoryScreen() {
  const t = useT();
  const user = useUser();
  const layout = useLayoutClass();
  const active = useScreenActive();
  const queryClient = useQueryClient();
  const headingId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const [folder, setFolder] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const search = useSearchText(setQuery);
  const [reading, setReading] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditorTarget | null>(null);
  const agents = useAgents();

  const folders = useQuery({ queryKey: memoryKeys.folders, queryFn: ({ signal }) => memoryApi.folders(signal), enabled: active, meta: { live: true } });
  const recent = useInfiniteQuery({
    queryKey: memoryKeys.recent(folder),
    queryFn: ({ pageParam, signal }) => memoryApi.recent(folder, PAGE, pageParam, signal),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((sum, page) => sum + page.notes.length, 0);
      return loaded < last.total && last.notes.length > 0 ? loaded : undefined;
    },
    enabled: active && query === '',
    meta: { live: true },
  });
  const results = useQuery({
    queryKey: memoryKeys.search(query, folder),
    queryFn: ({ signal }) => memoryApi.search(query, folder, signal),
    enabled: active && query !== '',
    placeholderData: keepPreviousData,
    staleTime: 10_000,
  });
  const searching = query !== '';
  const listQuery = searching ? results : recent;
  const { stale, since } = useStaleness(listQuery);

  const folderList = useMemo(() => folders.data?.folders ?? [], [folders.data]);
  const folderByName = useMemo(() => new Map(folderList.map((entry) => [entry.name, entry])), [folderList]);
  const writable = folderList.filter((entry) => entry.access === 'write' && !(entry.project?.archived ?? false));
  useMemoryEvents(folder ? [folder] : folderList.map((entry) => entry.name));

  const agentName = (id: string) => agents.data?.find((agent) => agent.id === id)?.displayName ?? null;
  const author = (value: string | null) => authorLabel(value, t, user?.username ?? null, agentName);

  // A chip stays while it is chosen, even when its last note was just deleted.
  const chips = useMemo(() => {
    const list = [...folderList];
    if (folder && !list.some((entry) => entry.name === folder)) list.push({ name: folder, kind: 'unassigned', project: null, access: 'read', count: 0 });
    return list;
  }, [folderList, folder]);

  const notes: MemoryNoteSummary[] = searching ? (results.data?.hits ?? []) : (recent.data?.pages.flatMap((page) => page.notes) ?? []);
  // Snippets belong to a search: once the box is cleared, the recent list shows none.
  const hits = new Map((searching ? (results.data?.hits ?? []) : []).map((hit) => [hit.id, hit]));
  const total = searching ? (results.data?.total ?? 0) : (recent.data?.pages[0]?.total ?? 0);
  // Text still being composed is not searched, so it is not "pending" either.
  const pendingSearch = (searching && results.isFetching) || (!search.composing && search.text.trim() !== query && search.text.trim() !== '');

  const refresh = () => void progress.track(queryClient.refetchQueries({ queryKey: memoryKeys.all, type: 'active' }));

  const newNoteFolder = (folder && writable.some((entry) => entry.name === folder) ? folder : null) ?? writable.find((entry) => entry.kind === 'global')?.name ?? writable[0]?.name ?? null;

  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape' && search.text !== '' && !isImeConfirm(event)) {
      event.preventDefault();
      event.stopPropagation();
      search.set('');
    } else if (event.key === 'Enter' && !isImeConfirm(event) && !event.nativeEvent.isComposing) {
      event.preventDefault();
      search.set(event.currentTarget.value);
      if (layout === 'phone') event.currentTarget.blur();
    }
  };

  const searchField = (
    <div className="mem-search" data-pending={pendingSearch || undefined}>
      <Search size={18} aria-hidden="true" className="mem-search__icon" />
      <label htmlFor="memory-search" className="visually-hidden">
        {t('memory.search.label')}
      </label>
      <input
        ref={searchRef}
        id="memory-search"
        type="search"
        className="mem-search__input"
        placeholder={t('memory.search.placeholder')}
        value={search.text}
        maxLength={MEMORY_LIMITS.queryChars}
        enterKeyHint="search"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="none"
        spellCheck={false}
        onChange={(event) => search.change(event.target.value, (event.nativeEvent as InputEvent).isComposing === true)}
        onCompositionStart={search.compositionStart}
        onCompositionEnd={(event) => search.compositionEnd(event.currentTarget.value)}
        onKeyDown={onSearchKey}
      />
      {pendingSearch && <Spinner size={16} label={t('memory.search.pending')} />}
      {search.text !== '' && (
        <IconButton
          label={t('memory.search.clear')}
          icon={<X size={18} />}
          tone="secondary"
          className="mem-search__clear"
          onClick={() => {
            search.set('');
            searchRef.current?.focus();
          }}
        />
      )}
    </div>
  );

  const chipsRow =
    chips.length > 1 ? (
      <div className="mem-chips" role="group" aria-label={t('memory.folders.label')}>
        <button type="button" className="mem-chip" aria-pressed={folder === null} onClick={() => setFolder(null)}>
          {t('memory.folders.all')}
        </button>
        {chips.map((entry) => (
          <button
            key={entry.name}
            type="button"
            className="mem-chip"
            aria-pressed={folder === entry.name}
            data-tint={entry.project ? toTint(entry.project.icon.color, 'blue') : entry.kind === 'global' ? 'teal' : 'slate'}
            onClick={() => setFolder(folder === entry.name ? null : entry.name)}
          >
            <FolderMark folder={entry} name={entry.name} />
            <span>{folderLabel(entry, entry.name, t)}</span>
            <span className="mem-chip__count">{t.number(entry.count)}</span>
          </button>
        ))}
      </div>
    ) : null;

  const failure = listQuery.error;
  const unavailable = isApiError(failure) && failure.code === 'memory_unavailable';
  const timedOut = isApiError(failure) && failure.code === 'timeout';
  const hasData = searching ? results.data !== undefined : recent.data !== undefined;

  let body;
  if (!hasData) {
    if (listQuery.isError) {
      body = (
        <ErrorState
          error={failure}
          {...(unavailable ? { title: t('memory.unavailable.title'), description: t('memory.unavailable.text') } : timedOut ? { title: t('memory.timeout.title'), description: t('memory.timeout.text') } : {})}
          onRetry={() => void listQuery.refetch()}
          retrying={listQuery.isFetching}
        />
      );
    } else body = <RowsSkeleton />;
  } else if (notes.length === 0) {
    body = searching ? (
      <EmptyState icon={<SearchX size={28} />} title={t('memory.search.none', { query })} description={t('memory.search.noneHint')} compact />
    ) : folder ? (
      <EmptyState icon={<BookMarked size={28} />} title={t('memory.empty.folder')} description={t('memory.empty.folderText')} compact />
    ) : (
      <EmptyState
        icon={<BookMarked size={28} />}
        title={t('memory.empty.title')}
        description={t('memory.empty.text')}
        action={
          newNoteFolder ? (
            <Button variant="tinted" icon={<Plus size={18} />} onClick={() => setEditing({ kind: 'new', folder: newNoteFolder })}>
              {t('memory.new')}
            </Button>
          ) : undefined
        }
      />
    );
  } else {
    body = (
      <>
        <ul className="mem-list" data-pending={(searching && results.isPlaceholderData) || undefined} aria-busy={pendingSearch || undefined}>
          {notes.map((note) => (
            <NoteRow key={note.id} note={note} hit={hits.get(note.id) ?? null} folder={folderByName.get(note.folder)} author={author(note.author)} onOpen={() => setReading(note.id)} />
          ))}
        </ul>
        {searching && results.data?.capped && <p className="mem-footnote">{t('memory.search.capped')}</p>}
        {!searching && recent.hasNextPage && (
          <div className="mem-more">
            <Button variant="neutral" loading={recent.isFetchingNextPage} onClick={() => void recent.fetchNextPage()}>
              {t('memory.more')}
            </Button>
          </div>
        )}
      </>
    );
  }

  const listSection = (
    <section className="mem-section" aria-labelledby={headingId}>
      <div className="mem-section__head">
        <h2 id={headingId}>{searching ? t('memory.list.results') : t('memory.list.recent')}</h2>
        {hasData && (
          <span className="mem-section__count" aria-live="polite">
            {searching ? t.plural('memory.list.found', total) : folder ? t.plural('memory.list.inFolder', total) : t.plural('memory.list.total', total)}
          </span>
        )}
        {stale && <StaleNotice since={since} reason={failure ? t('memory.staleReason') : undefined} />}
      </div>
      {hasData && listQuery.isError && (
        <p className="mem-stale" role="status">
          {unavailable ? t('memory.unavailable.cached') : timedOut ? t('memory.timeout.cached') : t('memory.cached')}
        </p>
      )}
      {body}
    </section>
  );

  const side = (
    <StatusCard
      onRebuilt={() => void queryClient.invalidateQueries({ queryKey: memoryKeys.all })}
      listShowsUnavailable={!hasData && unavailable}
    />
  );

  return (
    <Screen
      title={t('memory.title')}
      width={layout === 'phone' ? 'reading' : 'wide'}
      className="mem-screen"
      toolbar={searchField}
      actions={
        <>
          {newNoteFolder && <IconButton label={t('memory.new')} icon={<Plus size={22} />} onClick={() => setEditing({ kind: 'new', folder: newNoteFolder })} />}
          <IconButton label={t('memory.refresh')} icon={<RefreshCw size={21} />} busy={folders.isFetching && folders.data !== undefined} onClick={refresh} />
        </>
      }
    >
      <div className="mem-layout">
        <div className="mem-main">
          {chipsRow}
          {listSection}
        </div>
        <aside className="mem-side" aria-label={t('memory.status.label')}>
          {side}
        </aside>
      </div>
      <NoteReader
        noteId={reading}
        folders={folderByName}
        writable={writable}
        author={author}
        onClose={() => setReading(null)}
        onKeyword={(keyword) => {
          setReading(null);
          search.set(keyword);
        }}
        onEdit={(note) => {
          setReading(null);
          setEditing({ kind: 'edit', note });
        }}
        onMoved={(note) => setReading(note.id)}
      />
      <NoteEditor
        target={editing}
        writable={writable}
        onClose={() => setEditing(null)}
        onSaved={(note) => {
          setEditing(null);
          setReading(note.id);
        }}
      />
    </Screen>
  );
}
