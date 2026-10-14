import { FILE_LIMITS, type FileEntry, type Project } from '@agent-studio/protocol';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  ChevronRight,
  ChevronsDownUp,
  Copy,
  Download,
  Ellipsis,
  File as FileIcon,
  FileCode,
  FilePlus,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Image as ImageIcon,
  Link2,
  Pencil,
  RefreshCw,
  Search,
  TextSearch,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { type DragEvent, type KeyboardEvent, memo, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { isApiError } from '@/data/api';
import { describeError } from '@/data/errors';
import { formatBytes } from '@/features/workbench/composer/attachments';
import type { InspectorPanelProps } from '@/features/workbench/inspector/registry';
import { type Translator, useLanguage, useT } from '@/i18n';
import { copyText } from '@/platform/clipboard';
import { useLongPress } from '@/platform/long-press';
import { Banner, Button, EmptyState, ErrorState, IconButton, LoadingRow, Menu, type MenuEntry, ProgressLine, Spinner, confirm, toast } from '@/ui';
import { InlineNameField, ProblemNote, Stage, SwipeRow, problemOf, splitPath, startDownload, useProjectEvents, wasCancelled } from '../projects/tools/kit';
import { type UploadItem, filesApi, filesKeys } from './api';
import { type UnsavedDraft, takeDraft } from './drafts';
import { FileEditor, type FileEditorHandle } from './editor/FileEditor';
import { languageIdFor } from './editor/languages';
import { type UploadOutcome, type UploadRefusal, brokenNameRule, checkUpload, collectDropped, matchRuns, nameRuleKey, summarizeUpload, toProjectPath } from './rules';
import { ROOT, type TreeRow, emptyTree, filterRows, folderFor, foldersOnShow, foldersToLoad, foldersTouchedBy, joinPath, parentOf, treeReducer, visibleRows } from './tree';
import './files.css';

const INDENT = 14;
const IMAGE = /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp)$/i;

function EntryIcon({ entry, expanded }: { entry: Pick<FileEntry, 'kind' | 'name'>; expanded?: boolean }) {
  if (entry.kind === 'directory') return expanded ? <FolderOpen size={17} aria-hidden="true" /> : <Folder size={17} aria-hidden="true" />;
  if (entry.kind === 'symlink') return <Link2 size={17} aria-hidden="true" />;
  if (IMAGE.test(entry.name)) return <ImageIcon size={17} aria-hidden="true" />;
  const language = languageIdFor(entry.name);
  if (language === 'markdown') return <FileText size={17} aria-hidden="true" />;
  if (language) return <FileCode size={17} aria-hidden="true" />;
  return <FileIcon size={17} aria-hidden="true" />;
}

interface Opened {
  path: string;
  line?: number | undefined;
  id: number;
  restored: UnsavedDraft | null;
  view: 'edit' | 'changes';
}

interface NameDraft {
  /** `create` in a folder, or `rename` of an entry. */
  mode: 'create' | 'rename';
  kind: 'file' | 'directory';
  /** The folder a new item goes into, or the path being renamed. */
  target: string;
  initial: string;
  problem: string | null;
  busy: boolean;
}

type UploadState =
  | { phase: 'sending'; fraction: number; count: number; name: string }
  | { phase: 'done'; outcome: UploadOutcome; target: string; items: readonly UploadItem[] }
  | { phase: 'refused'; refusal: UploadRefusal }
  | { phase: 'failed'; text: string };

interface RowHandlers {
  activate: (entry: FileEntry) => void;
  openMenu: (entry: FileEntry, anchor: HTMLElement) => void;
  rename: (entry: FileEntry) => void;
  remove: (entry: FileEntry) => void;
  download: (entry: FileEntry) => void;
}

const EntryRow = memo(function EntryRow({
  row,
  writable,
  dropTarget,
  highlighted,
  handlers,
  t,
}: {
  row: Extract<TreeRow, { kind: 'entry' }>;
  writable: boolean;
  dropTarget: boolean;
  highlighted: boolean;
  handlers: RowHandlers;
  t: Translator;
}) {
  const { entry, depth, expandable, expanded, busy } = row;
  const more = useRef<HTMLButtonElement>(null);
  const press = useLongPress(() => {
    if (more.current) handlers.openMenu(entry, more.current);
  });
  const label = entry.kind === 'directory' ? t('files.row.folder', { name: entry.name }) : entry.kind === 'symlink' ? t('files.row.link', { name: entry.name }) : entry.name;
  return (
    <SwipeRow
      className="files-row"
      role="none"
      actions={
        writable
          ? [
              { id: 'rename', label: t('files.rename'), icon: <Pencil size={18} />, tone: 'accent', onSelect: () => handlers.rename(entry) },
              { id: 'delete', label: t('files.delete'), icon: <Trash2 size={18} />, tone: 'danger', onSelect: () => handlers.remove(entry) },
            ]
          : [{ id: 'download', label: t('files.download'), icon: <Download size={18} />, onSelect: () => handlers.download(entry) }]
      }
    >
      <div className="files-row__line" data-drop={dropTarget || undefined} data-highlight={highlighted || undefined} data-ignored={entry.ignored || undefined}>
        <button
          type="button"
          role="treeitem"
          className="files-row__main u-no-callout"
          data-tree-item=""
          data-path={entry.path}
          data-folder={expandable ? '' : undefined}
          aria-level={depth + 1}
          aria-expanded={expandable ? expanded : undefined}
          aria-label={entry.ignored ? t('files.row.ignored', { name: label }) : label}
          style={{ paddingLeft: 8 + depth * INDENT }}
          onClick={() => handlers.activate(entry)}
          {...press}
        >
          <span className="files-row__chevron" data-open={expanded || undefined} aria-hidden="true">
            {expandable && (busy ? <Spinner size={13} /> : <ChevronRight size={15} />)}
          </span>
          <span className="files-row__icon" data-kind={entry.kind}>
            <EntryIcon entry={entry} expanded={expanded} />
          </span>
          <span className="files-row__name u-truncate">{entry.name}</span>
          {entry.kind === 'symlink' && entry.linkTarget && entry.linkTarget !== 'file' && entry.linkTarget !== 'directory' && (
            <span className="pt-pill" data-tone="warning">
              {entry.linkTarget === 'outside' ? t('files.link.outside') : t('files.link.missing')}
            </span>
          )}
        </button>
        <button
          ref={more}
          type="button"
          className="files-row__more"
          aria-label={t('files.row.actions', { name: entry.name })}
          aria-haspopup="menu"
          onClick={(event) => handlers.openMenu(entry, event.currentTarget)}
        >
          <Ellipsis size={18} aria-hidden="true" />
        </button>
      </div>
    </SwipeRow>
  );
});

function refusalText(refusal: UploadRefusal, t: Translator): string {
  switch (refusal.reason) {
    case 'tooMany':
      return t('files.upload.tooMany', { count: t.number(refusal.count), limit: t.number(refusal.limit) });
    case 'fileTooLarge':
      return t('files.upload.fileTooLarge', { name: refusal.name, limit: formatBytes(refusal.limit, t.number) });
    case 'totalTooLarge':
      return t('files.upload.totalTooLarge', { limit: formatBytes(refusal.limit, t.number) });
    case 'empty':
      return t('files.upload.nothing');
  }
}

/** The files of one project: a tree read folder by folder, two ways of searching, and the editor a file opens in. */
function ProjectFiles({ project, request, onRequestHandled, active }: InspectorPanelProps & { project: Project }) {
  const t = useT();
  const language = useLanguage();
  const writable = project.access === 'write';
  const [tree, dispatch] = useReducer(treeReducer, undefined, emptyTree);
  const [opened, setOpened] = useState<Opened | null>(() => {
    const draft = takeDraft(project.id);
    return draft ? { path: draft.path, id: 1, restored: draft, view: 'edit' } : null;
  });
  const [query, setQuery] = useState('');
  const [settledQuery, setSettledQuery] = useState('');
  const [inContents, setInContents] = useState(false);
  const [naming, setNaming] = useState<NameDraft | null>(null);
  const [upload, setUpload] = useState<UploadState | null>(null);
  const [dropFolder, setDropFolder] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  /** The item whose menu is (or was last) showing; it stays named while the menu closes. */
  const [menu, setMenu] = useState<FileEntry | 'root' | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const editor = useRef<FileEditorHandle>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const pickerTarget = useRef(ROOT);
  const menuAnchor = useRef<HTMLElement | null>(null);
  const tickets = useRef<Record<string, number>>({});
  const jumpCounter = useRef(1);
  const dragDepth = useRef(0);
  const live = useRef(tree);
  useEffect(() => {
    live.current = tree;
  });

  const limits = useQuery({ queryKey: filesKeys.limits, queryFn: ({ signal }) => filesApi.limits(signal), staleTime: 10 * 60_000 }).data ?? FILE_LIMITS;

  // ---- reading folders ---------------------------------------------------------------

  const load = useCallback(
    (path: string): Promise<void> => {
      const ticket = (tickets.current[path] = (tickets.current[path] ?? 0) + 1);
      const current = () => tickets.current[path] === ticket;
      dispatch({ type: 'requested', path });
      return filesApi.list(project.id, path).then(
        (listing) => {
          if (current()) dispatch({ type: 'loaded', path, listing });
        },
        (error: unknown) => {
          if (!current()) return;
          // A folder that is gone is dropped from the tree, and the folder above is read again to say so.
          if (path !== ROOT && isApiError(error) && error.gone) {
            dispatch({ type: 'forget', path });
            void load(parentOf(path));
          } else dispatch({ type: 'failed', path, error });
        },
      );
    },
    [project.id],
  );

  useEffect(() => {
    for (const path of foldersToLoad(tree)) void load(path);
  }, [tree, load]);

  const refresh = useCallback(
    async (paths?: readonly string[]) => {
      setRefreshing(true);
      try {
        await Promise.all((paths ?? foldersOnShow(live.current)).map((path) => load(path)));
      } finally {
        setRefreshing(false);
      }
    },
    [load],
  );

  // Changes made elsewhere — an agent, the terminal's git, another device — arrive as events; several at once are read once.
  const pending = useRef<{ all: boolean; paths: Set<string>; timer: number | null }>({ all: false, paths: new Set(), timer: null });
  const schedule = useCallback(
    (paths: readonly string[] | 'all') => {
      const state = pending.current;
      if (paths === 'all') state.all = true;
      else for (const path of paths) state.paths.add(path);
      if (state.timer !== null) return;
      state.timer = window.setTimeout(() => {
        const touched = state.all ? foldersOnShow(live.current) : foldersTouchedBy(live.current, [...state.paths]);
        state.all = false;
        state.paths.clear();
        state.timer = null;
        for (const path of touched) void load(path);
      }, 180);
    },
    [load],
  );
  useEffect(
    () => () => {
      if (pending.current.timer !== null) window.clearTimeout(pending.current.timer);
    },
    [],
  );
  useProjectEvents(project.id, {
    onFiles: (event) => schedule(event.kind === 'tree' ? 'all' : event.paths),
    onGit: () => schedule('all'),
    onReconnect: () => schedule('all'),
  });
  // Coming back to the panel after it was hidden: what an agent wrote meanwhile is not announced, so look again.
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current) schedule('all');
    wasActive.current = active;
  }, [active, schedule]);

  // ---- opening, revealing ---------------------------------------------------------------

  const mayLeave = useCallback(async (): Promise<boolean> => {
    const current = editor.current;
    if (!current || current.guard() === 'free') return true;
    const agreed = await confirm({
      title: t('files.editor.discard.title', { name: splitPath(opened?.path ?? '').name }),
      message: t('files.editor.discard.message'),
      confirmLabel: t('files.editor.discard.confirm'),
      cancelLabel: t('files.editor.discard.keep'),
      tone: 'danger',
    });
    if (agreed) current.discard();
    return agreed;
  }, [opened?.path, t]);

  const openFile = useCallback(
    async (path: string, line?: number, view: 'edit' | 'changes' = 'edit') => {
      const id = (jumpCounter.current += 1);
      if (opened && opened.path === path) return setOpened({ ...opened, line, id });
      if (!(await mayLeave())) return;
      setOpened({ path, line, id, restored: null, view });
    },
    [opened, mayLeave],
  );

  const closeEditor = useCallback(async () => {
    if (!(await mayLeave())) return;
    setOpened(null);
  }, [mayLeave]);

  const reveal = useCallback((path: string, includeSelf: boolean) => {
    setQuery('');
    setSettledQuery('');
    dispatch({ type: 'reveal', path, includeSelf });
    setHighlight(path);
  }, []);

  // The revealed row exists only once every folder above it has been read.
  useEffect(() => {
    if (highlight === null || opened) return;
    const rowElement = [...(scroller.current?.querySelectorAll<HTMLElement>('[data-path]') ?? [])].find((element) => element.dataset.path === highlight);
    if (!rowElement) return;
    rowElement.scrollIntoView({ block: 'center' });
    rowElement.focus({ preventScroll: true });
    const timer = window.setTimeout(() => setHighlight(null), 2400);
    return () => window.clearTimeout(timer);
  }, [highlight, tree, opened]);

  useEffect(() => {
    if (!request) return;
    if (request.type === 'open-file' || request.type === 'reveal-folder') {
      const target = toProjectPath(project.rootDir, request.path);
      if ('outside' in target) toast.error(t('files.outside', { path: request.path }));
      else if (request.type === 'reveal-folder' || target.path === ROOT) {
        void mayLeave().then((free) => {
          if (!free) return;
          setOpened(null);
          reveal(target.path, true);
        });
      } else void openFile(target.path, request.line, request.view === 'changes' ? 'changes' : 'edit');
    }
    onRequestHandled();
    // Each request is handled once, when it arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  // ---- searching -------------------------------------------------------------------------

  useEffect(() => {
    const timer = window.setTimeout(() => setSettledQuery(query.trim()), 220);
    return () => window.clearTimeout(timer);
  }, [query]);
  const searching = settledQuery !== '';
  const names = useQuery({
    queryKey: filesKeys.names(project.id, settledQuery),
    queryFn: ({ signal }) => filesApi.searchNames(project.id, settledQuery, 200, signal),
    enabled: searching && !inContents,
    placeholderData: keepPreviousData,
    staleTime: 5_000,
  });
  const contents = useQuery({
    queryKey: filesKeys.content(project.id, settledQuery),
    queryFn: ({ signal }) => filesApi.searchContent(project.id, settledQuery, signal),
    enabled: searching && inContents,
    placeholderData: keepPreviousData,
    staleTime: 5_000,
    retry: false,
  });
  const nameRows = useMemo(() => (names.data ? filterRows(names.data.results, language) : []), [names.data, language]);
  const contentGroups = useMemo(() => {
    const groups = new Map<string, { line: number; text: string }[]>();
    for (const match of contents.data?.matches ?? []) {
      const list = groups.get(match.path) ?? [];
      list.push({ line: match.line, text: match.text });
      groups.set(match.path, list);
    }
    return [...groups.entries()];
  }, [contents.data]);

  // ---- creating, renaming, deleting ----------------------------------------------------------

  const startCreate = useCallback(
    (folder: string, kind: 'file' | 'directory') => {
      setQuery('');
      setSettledQuery('');
      if (folder !== ROOT) dispatch({ type: 'reveal', path: folder, includeSelf: true });
      setNaming({ mode: 'create', kind, target: folder, initial: kind === 'file' ? t('files.new.fileName') : t('files.new.folderName'), problem: null, busy: false });
    },
    [t],
  );

  const submitName = useCallback(
    async (draft: NameDraft, name: string) => {
      const current = draft.mode === 'rename' ? splitPath(draft.target).name : null;
      if (current !== null && name === current) return setNaming(null);
      const rule = brokenNameRule(name);
      if (rule) return setNaming({ ...draft, problem: t(nameRuleKey(rule)), busy: false });
      setNaming({ ...draft, problem: null, busy: true });
      try {
        if (draft.mode === 'create') {
          await filesApi.create(project.id, { parent: draft.target, name, kind: draft.kind });
          setNaming(null);
          await load(draft.target);
          const path = joinPath(draft.target, name);
          toast.success(draft.kind === 'file' ? t('files.created.file', { name }) : t('files.created.folder', { name }));
          if (draft.kind === 'file') void openFile(path);
          else setHighlight(path);
        } else {
          const destination = joinPath(parentOf(draft.target), name);
          await filesApi.move(project.id, draft.target, destination);
          setNaming(null);
          dispatch({ type: 'forget', path: draft.target });
          await load(parentOf(draft.target));
          setHighlight(destination);
          toast.success(t('files.renamed', { name }));
        }
      } catch (error) {
        if (wasCancelled(error)) return setNaming({ ...draft, busy: false });
        setNaming({ ...draft, problem: describeError(error, t), busy: false });
      }
    },
    [project.id, load, openFile, t],
  );

  const remove = useCallback(
    async (entry: FileEntry) => {
      const folder = entry.kind === 'directory';
      const agreed = await confirm({
        title: folder ? t('files.delete.folderTitle', { name: entry.name }) : t('files.delete.fileTitle', { name: entry.name }),
        message: folder ? t('files.delete.folderMessage') : entry.kind === 'symlink' ? t('files.delete.linkMessage') : t('files.delete.fileMessage'),
        confirmLabel: t('files.delete'),
        tone: 'danger',
      });
      if (!agreed) return;
      try {
        await filesApi.remove(project.id, entry.path, folder);
        dispatch({ type: 'forget', path: entry.path });
        await load(parentOf(entry.path));
        toast.success(t('files.deleted', { name: entry.name }));
      } catch (error) {
        if (!wasCancelled(error)) toast.error(describeError(error, t));
      }
    },
    [project.id, load, t],
  );

  const download = useCallback(
    (entry: Pick<FileEntry, 'path' | 'name' | 'kind'> | 'root') => {
      if (entry === 'root') return startDownload(filesApi.archiveUrl(project.id, ROOT), `${project.name}.zip`);
      if (entry.kind === 'directory') startDownload(filesApi.archiveUrl(project.id, entry.path), `${entry.name}.zip`);
      else startDownload(filesApi.rawUrl(project.id, entry.path), entry.name);
    },
    [project.id, project.name],
  );

  const copyPath = useCallback((path: string) => void copyText(path).then((copied) => copied && toast.success(t('files.pathCopied'))), [t]);

  // ---- uploading ---------------------------------------------------------------------------

  const sendUpload = useCallback(
    async (target: string, items: readonly UploadItem[], overwrite = false) => {
      const refusal = checkUpload(items, limits);
      if (refusal) return setUpload({ phase: 'refused', refusal });
      const first = items[0]!.file.name;
      setUpload({ phase: 'sending', fraction: 0, count: items.length, name: first });
      try {
        const result = await filesApi.upload(project.id, target, items, {
          overwrite,
          onProgress: (fraction) => setUpload((current) => (current?.phase === 'sending' ? { ...current, fraction } : current)),
        });
        setUpload({ phase: 'done', outcome: summarizeUpload(result), target, items });
        if (target !== ROOT) dispatch({ type: 'reveal', path: target, includeSelf: true });
        schedule('all');
      } catch (error) {
        if (wasCancelled(error)) return setUpload(null);
        setUpload({ phase: 'failed', text: describeError(error, t) });
      }
    },
    [project.id, limits, schedule, t],
  );

  const pickFiles = useCallback((folder: string) => {
    pickerTarget.current = folder;
    picker.current?.click();
  }, []);

  const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer.types).includes('Files');
  const folderUnder = (event: DragEvent): string => {
    const element = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-path]') : null;
    const path = element?.dataset.path;
    if (path === undefined) return ROOT;
    return element?.dataset.folder !== undefined ? path : parentOf(path);
  };
  const dragHandlers = writable
    ? {
        onDragEnter: (event: DragEvent) => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          dragDepth.current += 1;
          setDropFolder(folderUnder(event));
        },
        onDragOver: (event: DragEvent) => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
          const folder = folderUnder(event);
          setDropFolder((current) => (current === folder ? current : folder));
        },
        onDragLeave: (event: DragEvent) => {
          if (!hasFiles(event)) return;
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDropFolder(null);
        },
        onDrop: (event: DragEvent) => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          dragDepth.current = 0;
          const folder = folderUnder(event);
          setDropFolder(null);
          void collectDropped(event.dataTransfer, limits.maxUploadFiles).then(
            (items) => void sendUpload(folder, items),
            () => setUpload({ phase: 'failed', text: t('files.upload.unreadable') }),
          );
        },
      }
    : {};

  // ---- the tree's own keys ------------------------------------------------------------------

  const activate = useCallback(
    (entry: FileEntry) => {
      if (entry.kind === 'directory') return dispatch({ type: live.current.expanded.has(entry.path) ? 'collapse' : 'expand', path: entry.path });
      if (entry.kind === 'symlink' && entry.linkTarget !== 'file') {
        return void toast.info(entry.linkTarget === 'directory' ? t('files.link.folderNote') : entry.linkTarget === 'outside' ? t('files.link.outsideNote') : t('files.link.missingNote'));
      }
      void openFile(entry.path);
    },
    [openFile, t],
  );

  const onTreeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(event.target instanceof HTMLElement) || event.target.dataset.treeItem === undefined) return;
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-tree-item]')];
    const index = items.indexOf(event.target);
    const focusAt = (next: number) => {
      event.preventDefault();
      items[Math.min(items.length - 1, Math.max(0, next))]?.focus();
    };
    const path = event.target.dataset.path ?? '';
    const isFolder = event.target.dataset.folder !== undefined;
    if (event.key === 'ArrowDown') focusAt(index + 1);
    else if (event.key === 'ArrowUp') focusAt(index - 1);
    else if (event.key === 'Home') focusAt(0);
    else if (event.key === 'End') focusAt(items.length - 1);
    else if (event.key === 'ArrowRight' && isFolder && !tree.expanded.has(path)) {
      event.preventDefault();
      dispatch({ type: 'expand', path });
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      if (isFolder && tree.expanded.has(path)) dispatch({ type: 'collapse', path });
      else items.find((item) => item.dataset.path === parentOf(path))?.focus();
    }
  };

  const handlers = useRef<RowHandlers>({ activate, openMenu: () => {}, rename: () => {}, remove: () => {}, download: () => {} });
  handlers.current.activate = activate;
  handlers.current.openMenu = (entry, anchor) => {
    menuAnchor.current = anchor;
    setMenu(entry);
    setMenuOpen(true);
  };
  handlers.current.rename = (entry) => setNaming({ mode: 'rename', kind: entry.kind === 'directory' ? 'directory' : 'file', target: entry.path, initial: entry.name, problem: null, busy: false });
  handlers.current.remove = (entry) => void remove(entry);
  handlers.current.download = (entry) => download(entry);
  const stableHandlers = useMemo<RowHandlers>(
    () => ({
      activate: (entry) => handlers.current.activate(entry),
      openMenu: (entry, anchor) => handlers.current.openMenu(entry, anchor),
      rename: (entry) => handlers.current.rename(entry),
      remove: (entry) => handlers.current.remove(entry),
      download: (entry) => handlers.current.download(entry),
    }),
    [],
  );

  const menuItems = useMemo((): MenuEntry[] => {
    if (menu === null) return [];
    const folder = menu === 'root' ? ROOT : folderFor(menu);
    const isFolder = menu === 'root' || menu.kind === 'directory';
    const items: MenuEntry[] = [];
    if (writable && isFolder) {
      items.push(
        { id: 'new-file', label: t('files.newFile'), icon: <FilePlus size={18} />, onSelect: () => startCreate(folder, 'file') },
        { id: 'new-folder', label: t('files.newFolder'), icon: <FolderPlus size={18} />, onSelect: () => startCreate(folder, 'directory') },
        { id: 'upload', label: t('files.uploadHere'), icon: <Upload size={18} />, onSelect: () => pickFiles(folder) },
        { separator: true, id: 'separator-1' },
      );
    }
    if (menu !== 'root') {
      if (writable) items.push({ id: 'rename', label: t('files.rename'), icon: <Pencil size={18} />, onSelect: () => handlers.current.rename(menu) });
      items.push({ id: 'copy', label: t('files.copyPath'), icon: <Copy size={18} />, onSelect: () => copyPath(menu.path) });
    }
    items.push({ id: 'download', label: isFolder ? t('files.downloadZip') : t('files.download'), icon: <Download size={18} />, onSelect: () => download(menu) });
    if (menu !== 'root' && writable) items.push({ separator: true, id: 'separator-2' }, { id: 'delete', label: t('files.delete'), icon: <Trash2 size={18} />, tone: 'danger', onSelect: () => void remove(menu) });
    return items;
  }, [menu, writable, t, startCreate, pickFiles, copyPath, download, remove]);

  // ---- what is drawn ------------------------------------------------------------------------

  const rows = useMemo(() => visibleRows(tree), [tree]);
  const root = tree.folders[ROOT];
  const firstRead = !root || (root.status === 'loading' && root.entries.length === 0);
  const rootFailed = root?.status === 'failed' && root.entries.length === 0;
  const emptyProject = root?.status === 'ready' && root.entries.length === 0;

  const nameField = (depth: number) =>
    naming && (
      <div className="files-row__line files-row__line--naming" style={{ paddingLeft: 8 + depth * INDENT }}>
        <span className="files-row__chevron" aria-hidden="true" />
        <span className="files-row__icon" data-kind={naming.kind === 'directory' ? 'directory' : 'file'}>
          {naming.kind === 'directory' ? <Folder size={17} aria-hidden="true" /> : <FileIcon size={17} aria-hidden="true" />}
        </span>
        <InlineNameField
          key={`${naming.mode}:${naming.target}`}
          label={naming.mode === 'rename' ? t('files.rename.label', { name: naming.initial }) : naming.kind === 'file' ? t('files.new.fileLabel') : t('files.new.folderLabel')}
          initial={naming.initial}
          selectStem={naming.kind === 'file'}
          busy={naming.busy}
          problem={naming.problem}
          onSubmit={(value) => void submitName(naming, value)}
          onCancel={() => setNaming(null)}
        />
        <IconButton label={t('common.cancel')} icon={<X size={18} />} tone="secondary" onClick={() => setNaming(null)} />
      </div>
    );

  const treeBody = (
    <div className="files-tree" role="tree" aria-label={t('files.tree.label', { project: project.name })} onKeyDown={onTreeKeyDown}>
      {naming?.mode === 'create' && naming.target === ROOT && nameField(0)}
      {rows.map((row) => {
        if (row.kind === 'entry') {
          if (naming?.mode === 'rename' && naming.target === row.entry.path) return <div key={row.key}>{nameField(row.depth)}</div>;
          return (
            <div key={row.key} role="none">
              <EntryRow row={row} writable={writable} dropTarget={dropFolder === row.entry.path} highlighted={highlight === row.entry.path} handlers={stableHandlers} t={t} />
              {naming?.mode === 'create' && naming.target === row.entry.path && nameField(row.depth + 1)}
            </div>
          );
        }
        const style = { paddingLeft: 30 + row.depth * INDENT };
        if (row.kind === 'loading') {
          return (
            <p key={row.key} className="files-tree__note" style={style} role="status">
              <Spinner size={14} /> {t('common.loading')}
            </p>
          );
        }
        if (row.kind === 'empty') {
          return (
            <p key={row.key} className="files-tree__note" style={style}>
              {t('files.folder.empty')}
            </p>
          );
        }
        if (row.kind === 'truncated') {
          return (
            <p key={row.key} className="files-tree__note" style={style}>
              {t('files.folder.truncated', { shown: t.number(row.shown) })}
            </p>
          );
        }
        return (
          <p key={row.key} className="files-tree__note" data-tone="danger" style={style} role="alert">
            <span>{describeError(row.error, t)}</span>
            <button type="button" className="files-tree__retry" onClick={() => void load(row.path)}>
              {t('common.retry')}
            </button>
          </p>
        );
      })}
    </div>
  );

  const results = inContents ? (
    contents.isPending ? (
      <LoadingRow label={t('files.search.searching')} />
    ) : contents.isError ? (
      <ProblemNote problem={problemOf(contents.error, t)} action={<Button size="sm" variant="plain" onClick={() => void contents.refetch()}>{t('common.retry')}</Button>} />
    ) : contentGroups.length === 0 ? (
      <Stage>
        <EmptyState compact icon={<TextSearch size={26} />} title={t('files.search.noContent', { query: settledQuery })} description={t('files.search.noContentHint')} />
      </Stage>
    ) : (
      <div className="files-matches" data-stale={contents.isPlaceholderData || undefined}>
        {contentGroups.map(([path, lines]) => (
          <section key={path} className="files-matches__file" aria-label={path}>
            <button type="button" className="files-matches__path" onClick={() => void openFile(path)}>
              <FileCode size={16} aria-hidden="true" />
              <span className="u-truncate">{path}</span>
              <span className="files-matches__count">{t.number(lines.length)}</span>
            </button>
            {lines.map((line) => (
              <button key={line.line} type="button" className="files-matches__line" onClick={() => void openFile(path, line.line)} aria-label={t('files.search.lineLabel', { path, line: line.line })}>
                <span className="files-matches__number">{line.line}</span>
                <span className="files-matches__text">
                  {line.text.trim() === ''
                    ? ' '
                    : matchRuns(line.text.trimStart(), settledQuery).map((run, index) =>
                        run.match ? (
                          <mark key={index} className="files-matches__hit">
                            {run.text}
                          </mark>
                        ) : (
                          run.text
                        ),
                      )}
                </span>
              </button>
            ))}
          </section>
        ))}
        {contents.data.truncated && <p className="pt-note">{t('files.search.contentTruncated', { count: t.number(contents.data.matches.length) })}</p>}
      </div>
    )
  ) : names.isPending ? (
    <LoadingRow label={t('files.search.searching')} />
  ) : names.isError ? (
    <ProblemNote problem={problemOf(names.error, t)} action={<Button size="sm" variant="plain" onClick={() => void names.refetch()}>{t('common.retry')}</Button>} />
  ) : nameRows.length === 0 ? (
    <Stage>
      <EmptyState compact icon={<Search size={26} />} title={t('files.search.noNames', { query: settledQuery })} description={t('files.search.noNamesHint')} />
    </Stage>
  ) : (
    <div className="files-tree" data-stale={names.isPlaceholderData || undefined} aria-label={t('files.search.results')}>
      {nameRows.map((row) => (
        <div key={row.key} className="files-row__line" data-way={!row.matched || undefined}>
          <button
            type="button"
            className="files-row__main"
            style={{ paddingLeft: 8 + row.depth * INDENT }}
            onClick={() => (row.isFolder ? reveal(row.path, true) : void openFile(row.path))}
            aria-label={row.isFolder ? t('files.row.folder', { name: row.name }) : row.name}
          >
            <span className="files-row__chevron" data-open={row.isFolder || undefined} aria-hidden="true">
              {row.isFolder && <ChevronRight size={15} />}
            </span>
            <span className="files-row__icon" data-kind={row.isFolder ? 'directory' : 'file'}>
              <EntryIcon entry={{ kind: row.isFolder ? 'directory' : 'file', name: row.name }} expanded={row.isFolder} />
            </span>
            <span className="files-row__name u-truncate">{row.name}</span>
          </button>
        </div>
      ))}
      {names.data.truncated && <p className="pt-note">{t('files.search.namesTruncated', { count: t.number(names.data.results.length) })}</p>}
    </div>
  );

  return (
    <>
      <div className="pt-panel files" hidden={opened !== null} {...dragHandlers}>
        <header className="pt-toolbar">
          {writable && (
            <>
              <IconButton label={t('files.newFile')} icon={<FilePlus size={20} />} tone="secondary" onClick={() => startCreate(ROOT, 'file')} />
              <IconButton label={t('files.newFolder')} icon={<FolderPlus size={20} />} tone="secondary" onClick={() => startCreate(ROOT, 'directory')} />
              <IconButton
                label={t('files.upload.label', { limit: formatBytes(limits.maxUploadFileBytes, t.number) })}
                icon={<Upload size={20} />}
                tone="secondary"
                disabled={upload?.phase === 'sending'}
                onClick={() => pickFiles(ROOT)}
              />
              <input
                ref={picker}
                type="file"
                multiple
                hidden
                tabIndex={-1}
                aria-hidden="true"
                onChange={(event) => {
                  const files = Array.from(event.target.files ?? []);
                  event.target.value = '';
                  if (files.length > 0) void sendUpload(pickerTarget.current, files.map((file) => ({ file })));
                }}
              />
            </>
          )}
          <span className="pt-toolbar__spacer" />
          <IconButton label={t('files.collapseAll')} icon={<ChevronsDownUp size={20} />} tone="secondary" disabled={tree.expanded.size === 0} onClick={() => dispatch({ type: 'collapse-all' })} />
          <IconButton label={t('files.refresh')} icon={<RefreshCw size={19} />} tone="secondary" busy={refreshing} onClick={() => void refresh()} />
          <IconButton
            label={t('files.moreActions')}
            icon={<Ellipsis size={20} />}
            tone="secondary"
            aria-haspopup="menu"
            onClick={(event) => {
              menuAnchor.current = event.currentTarget;
              setMenu('root');
              setMenuOpen(true);
            }}
          />
        </header>

        <div className="files-search">
          <label className="pt-search">
            <Search size={17} aria-hidden="true" />
            <input
              type="search"
              value={query}
              placeholder={inContents ? t('files.search.contentPlaceholder') : t('files.search.namePlaceholder')}
              aria-label={inContents ? t('files.search.contentPlaceholder') : t('files.search.namePlaceholder')}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="search"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && query !== '') {
                  event.preventDefault();
                  event.stopPropagation();
                  setQuery('');
                }
              }}
            />
            {query !== '' && (
              <button type="button" className="pt-search__clear" onClick={() => setQuery('')} aria-label={t('files.search.clear')}>
                <X size={16} aria-hidden="true" />
              </button>
            )}
          </label>
          <IconButton
            label={inContents ? t('files.search.inContentsOn') : t('files.search.inContentsOff')}
            icon={<TextSearch size={20} />}
            tone={inContents ? 'accent' : 'secondary'}
            variant={inContents ? 'filled' : 'plain'}
            aria-pressed={inContents}
            onClick={() => setInContents(!inContents)}
          />
        </div>

        {upload && (
          <div className="files-upload" role={upload.phase === 'sending' ? 'status' : 'alert'}>
            {upload.phase === 'sending' ? (
              <>
                <p>{upload.count === 1 ? t('files.upload.sendingOne', { name: upload.name, percent: Math.min(99, Math.round(upload.fraction * 100)) }) : t('files.upload.sendingMany', { count: t.number(upload.count), percent: Math.min(99, Math.round(upload.fraction * 100)) })}</p>
                <ProgressLine inline active value={Math.min(0.99, upload.fraction)} label={t('files.upload.progress')} />
              </>
            ) : upload.phase === 'done' ? (
              <Banner
                tone={upload.outcome.refused.length > 0 || upload.outcome.existing.length > 0 ? 'warning' : 'success'}
                action={<IconButton label={t('common.dismiss')} icon={<X size={18} />} tone="secondary" onClick={() => setUpload(null)} />}
              >
                <p>{t('files.upload.stored', { stored: t.number(upload.outcome.stored), requested: t.number(upload.outcome.requested) })}</p>
                {upload.outcome.existing.length > 0 && (
                  <>
                    <p>{t.plural('files.upload.existing', upload.outcome.existing.length, { names: t.list(upload.outcome.existing.slice(0, 3)) })}</p>
                    <Button
                      size="sm"
                      variant="neutral"
                      onClick={() => {
                        const again = upload.items.filter((item) => upload.outcome.existing.includes(item.file.name));
                        void confirm({
                          title: t.plural('files.upload.replace.title', again.length),
                          message: t('files.upload.replace.message'),
                          confirmLabel: t('files.upload.replace.confirm'),
                          tone: 'danger',
                        }).then((agreed) => agreed && void sendUpload(upload.target, again, true));
                      }}
                    >
                      {t.plural('files.upload.replace', upload.outcome.existing.length)}
                    </Button>
                  </>
                )}
                {upload.outcome.refused.map((entry) => (
                  <p key={entry.name}>{t(`files.upload.skipped.${entry.reason}`, { name: entry.name })}</p>
                ))}
              </Banner>
            ) : (
              <Banner tone="danger" action={<IconButton label={t('common.dismiss')} icon={<X size={18} />} tone="secondary" onClick={() => setUpload(null)} />}>
                {upload.phase === 'refused' ? refusalText(upload.refusal, t) : upload.text}
              </Banner>
            )}
          </div>
        )}

        <div ref={scroller} className="pt-scroll files__scroll" data-drop-root={dropFolder === ROOT || undefined}>
          {searching ? (
            results
          ) : firstRead ? (
            <LoadingRow label={t('files.loading')} />
          ) : rootFailed ? (
            <Stage>
              <ErrorState error={root.error} onRetry={() => void load(ROOT)} retrying={refreshing} />
            </Stage>
          ) : emptyProject && !naming ? (
            <Stage>
              <EmptyState
                icon={<Folder size={28} />}
                title={t('files.empty.title')}
                description={writable ? t('files.empty.description') : t('files.empty.readOnly')}
                action={
                  writable ? (
                    <>
                      <Button variant="tinted" icon={<FilePlus size={18} />} onClick={() => startCreate(ROOT, 'file')}>
                        {t('files.newFile')}
                      </Button>
                      <Button variant="plain" icon={<Upload size={18} />} onClick={() => pickFiles(ROOT)}>
                        {t('files.upload')}
                      </Button>
                    </>
                  ) : undefined
                }
              />
            </Stage>
          ) : (
            treeBody
          )}
        </div>
        {dropFolder !== null && (
          <div className="files__drop" aria-hidden="true">
            <Upload size={18} />
            {dropFolder === ROOT ? t('files.drop.root', { project: project.name }) : t('files.drop.folder', { folder: splitPath(dropFolder).name })}
          </div>
        )}
      </div>

      {opened && (
        <FileEditor
          key={opened.path}
          ref={editor}
          project={project}
          path={opened.path}
          target={{ line: opened.line, id: opened.id }}
          restored={opened.restored}
          initialView={opened.view}
          onClose={() => void closeEditor()}
          onReveal={(path) => {
            void mayLeave().then((free) => {
              if (!free) return;
              setOpened(null);
              reveal(path, false);
            });
          }}
          onRedirect={(path) => setOpened((current) => (current ? { ...current, path } : current))}
        />
      )}

      <Menu
        open={menuOpen && menu !== null}
        onClose={() => setMenuOpen(false)}
        anchor={menuAnchor}
        label={menu === null ? '' : menu === 'root' ? t('files.moreActions') : t('files.row.actions', { name: menu.name })}
        align="end"
        items={menuItems}
      />
    </>
  );
}

/** The inspector's Files panel. Each project gets its own tree, search and editor. */
export default function FilesPanel(props: InspectorPanelProps) {
  if (!props.project) return null;
  return <ProjectFiles key={props.project.id} {...props} project={props.project} />;
}
