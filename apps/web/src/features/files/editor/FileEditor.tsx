import type { FileContent, Project } from '@agent-studio/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, Copy, Download, Ellipsis, FolderSearch, RotateCw, WrapText } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, type Ref, useCallback, useEffect, useImperativeHandle, useReducer, useRef, useState } from 'react';
import { isApiError } from '@/data/api';
import { gitApi, gitKeys } from '@/features/git/api';
import { type Problem, ProblemNote, Stage, hunksOnly, problemOf, splitPath, startDownload, useProjectEvents, wasCancelled } from '@/features/projects/tools/kit';
import { DiffView } from '@/features/workbench/transcript/DiffView';
import { formatBytes } from '@/features/workbench/composer/attachments';
import { useT } from '@/i18n';
import { copyText } from '@/platform/clipboard';
import { useLayoutClass } from '@/platform/layout';
import { useCanHover } from '@/platform/media';
import { useUnsavedWork } from '@/pwa/update';
import { Badge, Banner, Button, ErrorState, IconButton, LoadingRow, MenuButton, SegmentedControl, confirm, toast } from '@/ui';
import { isAnyOverlayOpen } from '@/ui/overlay';
import { Markdown } from '@/ui/markdown';
import { filesApi } from '../api';
import { type UnsavedDraft, stashDraft } from '../drafts';
import { normalizePath, parentOf } from '../tree';
import { CodeEditor, type CodeEditorHandle } from './CodeEditor';
import { MediaPreview } from './MediaPreview';
import { isMarkdown } from './languages';
import { type TextShape, canSave, conflictFrom, documentReducer, leaveGuard, mustReload, openedDocument, readShape, saveRequest, writeShape } from './machine';

export interface FileEditorHandle {
  /** Asked before anything takes the editor away. */
  guard(): 'free' | 'confirm';
  /** The person agreed to lose what is unsaved: do not keep it when the editor goes. */
  discard(): void;
}

export interface FileEditorProps {
  project: Project;
  path: string;
  /** Where to put the caret; a new `id` jumps again even to the same line. */
  target: { line?: number | undefined; id: number };
  /** Unsaved text from an editor that had to leave the screen. */
  restored: UnsavedDraft | null;
  initialView: 'edit' | 'changes';
  /** Wants to go back to the tree. The parent asks `guard()` first. */
  onClose: () => void;
  onReveal: (path: string) => void;
  /** The path did not exist but exactly one file of that name does. */
  onRedirect: (path: string) => void;
  ref?: Ref<FileEditorHandle>;
}

type Loaded =
  | { kind: 'loading' }
  | { kind: 'failed'; error: unknown }
  | { kind: 'text'; text: string; savedText: string | undefined; shape: TextShape; size: number; nonce: number }
  | { kind: 'binary'; content: Extract<FileContent, { kind: 'binary' }> }
  | { kind: 'too_large'; content: Extract<FileContent, { kind: 'too_large' }> };

type View = 'edit' | 'preview' | 'changes';

const WRAP_KEY = 'studio.files.wrap';
function readWrap(phone: boolean): boolean {
  try {
    const stored = window.localStorage.getItem(WRAP_KEY);
    return stored === null ? phone : stored === '1';
  } catch {
    return phone;
  }
}

/** `../img/a.png` seen from `docs/guide.md` → `img/a.png`; null when it would leave the project or is not a file reference. */
export function resolveRelative(fromFile: string, reference: string): string | null {
  const clean = reference.split('#')[0]!.split('?')[0]!;
  if (clean === '' || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(clean) || clean.startsWith('//')) return null;
  let decoded = clean;
  try {
    decoded = decodeURIComponent(clean);
  } catch {
    /* as written */
  }
  const parts = decoded.startsWith('/') ? [] : parentOf(fromFile).split('/').filter(Boolean);
  for (const part of decoded.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.length > 0 ? parts.join('/') : null;
}

/**
 * One file: read, edited, saved — with the file's uncommitted changes and,
 * for Markdown, a rendered preview one tap away. Whatever happens to the file
 * underneath, the text in hand is never dropped without the person saying so.
 */
export function FileEditor({ project, path, target, restored, initialView, onClose, onReveal, onRedirect, ref }: FileEditorProps) {
  const t = useT();
  const layout = useLayoutClass();
  const canHover = useCanHover();
  const queryClient = useQueryClient();
  const writable = project.access === 'write';
  const { name } = splitPath(path);

  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  const [doc, dispatch] = useReducer(documentReducer, null, () => openedDocument(null));
  const [view, setView] = useState<View>(initialView);
  const [wrap, setWrap] = useState(() => readWrap(layout === 'phone'));
  const [previewText, setPreviewText] = useState('');
  const [justSaved, setJustSaved] = useState(false);
  const [busyChoice, setBusyChoice] = useState(false);
  const code = useRef<CodeEditorHandle>(null);
  const live = useRef(doc);
  const discarded = useRef(false);
  const requests = useRef(0);
  const pendingJump = useRef<number | null>(target.line ?? null);
  /** The version the text in hand started from, known the instant a read or a save answers — before the next render. */
  const version = useRef<string | null>(null);
  /** A save is in the air: the change it causes is not someone else's. */
  const savingNow = useRef(false);
  const redirect = useRef(onRedirect);
  useEffect(() => {
    live.current = doc;
    redirect.current = onRedirect;
  });

  useUnsavedWork(doc.dirty || doc.saving);

  // ---- reading the file ------------------------------------------------------------

  const read = useCallback(
    async (draft: UnsavedDraft | null) => {
      const request = (requests.current += 1);
      const current = () => request === requests.current;
      try {
        const content = await filesApi.content(project.id, path);
        if (!current()) return;
        if (content.kind === 'text') {
          const { text, shape } = readShape(content.content, content.lineEnding);
          if (draft) {
            // Text that was being edited comes back as it was, measured against what is on the server now.
            setLoaded({ kind: 'text', text: draft.text, savedText: text, shape, size: content.size, nonce: request });
            version.current = draft.baseVersion;
            dispatch({ type: 'reloaded', version: draft.baseVersion });
            if (draft.baseVersion !== content.version) {
              dispatch({ type: 'edited', dirty: true });
              dispatch({ type: 'changed-elsewhere' });
            }
          } else {
            setLoaded({ kind: 'text', text, savedText: undefined, shape, size: content.size, nonce: request });
            version.current = content.version;
            dispatch({ type: 'reloaded', version: content.version });
          }
        } else {
          setLoaded(content.kind === 'binary' ? { kind: 'binary', content } : { kind: 'too_large', content });
          version.current = content.version;
          dispatch({ type: 'reloaded', version: content.version });
        }
      } catch (error) {
        if (!current()) return;
        if (draft) {
          // The file is gone, but the text is not: it is shown, and saving it puts the file back.
          setLoaded({ kind: 'text', text: draft.text, savedText: '', shape: { bom: false, lineBreak: '\n' }, size: draft.text.length, nonce: request });
          version.current = draft.baseVersion;
          dispatch({ type: 'reloaded', version: draft.baseVersion });
          dispatch({ type: 'edited', dirty: true });
          return;
        }
        // "app.ts" for "src/app.ts": a bare name that exists exactly once is what was meant.
        if (isApiError(error) && error.code === 'file_not_found' && !path.includes('/')) {
          try {
            const found = await filesApi.searchNames(project.id, path, 20);
            const exact = found.results.filter((match) => match.kind === 'file' && match.name === path);
            if (current() && exact.length === 1) return redirect.current(exact[0]!.path);
          } catch {
            /* the first failure is the one worth showing */
          }
        }
        if (current()) setLoaded({ kind: 'failed', error });
      }
    },
    [project.id, path],
  );

  useEffect(() => {
    setLoaded({ kind: 'loading' });
    void read(restored);
    return () => {
      requests.current += 1;
    };
    // A restored draft is consumed once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [read]);

  // Leaving with unsaved text — the project changed, the workbench was left — keeps the text for the way back.
  useEffect(
    () => () => {
      const editor = code.current;
      if (discarded.current || !editor || !editor.isDirty()) return;
      stashDraft(project.id, { path, text: writeShape(editor.snapshot().lines, { bom: false, lineBreak: '\n' }), baseVersion: live.current.baseVersion });
    },
    [project.id, path],
  );

  useImperativeHandle(
    ref,
    (): FileEditorHandle => ({
      guard: () => leaveGuard(code.current?.isDirty() ? { ...live.current, dirty: true } : live.current),
      discard: () => {
        discarded.current = true;
      },
    }),
    [],
  );

  // The browser's own "leave this page?" for a reload or a closed tab.
  useEffect(() => {
    if (!doc.dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [doc.dirty]);

  // ---- jumping to a line -----------------------------------------------------------

  useEffect(() => {
    pendingJump.current = target.line ?? null;
    if (target.line !== undefined && loaded.kind === 'text') {
      setView('edit');
      // The editor exists one frame after the view does.
      const frame = window.requestAnimationFrame(() => {
        if (pendingJump.current !== null) code.current?.jumpToLine(pendingJump.current);
        pendingJump.current = null;
      });
      return () => window.cancelAnimationFrame(frame);
    }
    return undefined;
    // `target.id` is what says "again".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.id, loaded.kind === 'text' ? loaded.nonce : 0]);

  // ---- saving ----------------------------------------------------------------------

  const save = useCallback(
    async (overwrite = false) => {
      const editor = code.current;
      const state = live.current;
      if (!editor || loaded.kind !== 'text' || !writable || state.saving) return;
      if (!overwrite && !canSave({ ...state, dirty: editor.isDirty() })) return;
      const snapshot = editor.snapshot();
      savingNow.current = true;
      dispatch({ type: 'save-started' });
      try {
        const result = await filesApi.save(project.id, saveRequest(state, path, writeShape(snapshot.lines, loaded.shape), overwrite));
        editor.markSaved(snapshot.token);
        version.current = result.version;
        dispatch({ type: 'saved', version: result.version, at: Date.now() });
        dispatch({ type: 'edited', dirty: editor.isDirty() });
        setJustSaved(true);
        void queryClient.invalidateQueries({ queryKey: gitKeys.all(project.id) });
      } catch (error) {
        const conflict = isApiError(error) ? conflictFrom(error.code, error.details) : null;
        if (conflict) dispatch({ type: 'save-refused', conflict });
        else dispatch({ type: 'save-failed', problem: wasCancelled(error) ? ({ text: t('files.editor.saveCancelled') } satisfies Problem) : problemOf(error, t) });
      } finally {
        savingNow.current = false;
      }
    },
    [loaded, writable, project.id, path, queryClient, t],
  );

  /** After a choice made in a banner or a dialog the caret goes back to the text — with a keyboard; a touch keyboard is not raised uninvited. */
  const backToText = useCallback(() => {
    if (canHover) window.requestAnimationFrame(() => code.current?.focus());
  }, [canHover]);

  useEffect(() => {
    if (!justSaved) return;
    const timer = window.setTimeout(() => setJustSaved(false), 2000);
    return () => window.clearTimeout(timer);
  }, [justSaved]);

  const loadTheirs = useCallback(async () => {
    if (code.current?.isDirty()) {
      const agreed = await confirm({
        title: t('files.conflict.loadTheirs.title', { name }),
        message: t('files.conflict.loadTheirs.message'),
        confirmLabel: t('files.conflict.loadTheirs.confirm'),
        tone: 'danger',
      });
      if (!agreed) return;
    }
    setBusyChoice(true);
    try {
      const content = await filesApi.content(project.id, path);
      if (content.kind === 'text') {
        const { text, shape } = readShape(content.content, content.lineEnding);
        if (loaded.kind === 'text' && code.current) {
          code.current.load(text);
          setLoaded({ ...loaded, shape, size: content.size });
        } else setLoaded({ kind: 'text', text, savedText: undefined, shape, size: content.size, nonce: (requests.current += 1) });
      } else setLoaded(content.kind === 'binary' ? { kind: 'binary', content } : { kind: 'too_large', content });
      version.current = content.version;
      dispatch({ type: 'reloaded', version: content.version });
      backToText();
    } catch (error) {
      dispatch({ type: 'save-failed', problem: problemOf(error, t) });
    } finally {
      setBusyChoice(false);
    }
  }, [project.id, path, name, loaded, backToText, t]);

  const overwrite = useCallback(async () => {
    const reason = live.current.conflict?.reason;
    if (reason !== 'gone') {
      const agreed = await confirm({
        title: t('files.conflict.overwrite.title', { name }),
        message: t('files.conflict.overwrite.message'),
        confirmLabel: t('files.conflict.overwrite.confirm'),
        tone: 'danger',
      });
      if (!agreed) return;
    }
    await save(true);
    backToText();
  }, [name, save, backToText, t]);

  // ---- the file changing underneath --------------------------------------------------

  const checkServer = useCallback(async () => {
    const state = live.current;
    if (state.saving || savingNow.current || loaded.kind === 'loading' || loaded.kind === 'failed') return;
    try {
      const content = await filesApi.content(project.id, path);
      // A save of this editor's own announces itself the same way: by then the version in hand is already the new one.
      if (content.version === version.current || savingNow.current) return;
      if (!mustReload({ ...live.current, dirty: code.current?.isDirty() ?? false })) return dispatch({ type: 'changed-elsewhere' });
      if (content.kind === 'text' && loaded.kind === 'text' && code.current) {
        const { text, shape } = readShape(content.content, content.lineEnding);
        code.current.load(text);
        setLoaded({ ...loaded, shape, size: content.size });
        version.current = content.version;
        dispatch({ type: 'reloaded', version: content.version });
      } else void read(null);
    } catch (error) {
      // Gone while nothing was unsaved: say so where the file was. With unsaved text the next save will ask.
      if (isApiError(error) && error.gone && !code.current?.isDirty()) setLoaded({ kind: 'failed', error });
    }
  }, [project.id, path, loaded, read]);

  useProjectEvents(project.id, {
    onFiles: (event) => {
      if (event.kind === 'tree' || event.paths.some((changed) => normalizePath(changed) === path || path.startsWith(`${normalizePath(changed)}/`))) void checkServer();
      void queryClient.invalidateQueries({ queryKey: ['git', project.id, 'file-changes', path] });
    },
    onGit: () => {
      void queryClient.invalidateQueries({ queryKey: ['git', project.id, 'file-changes', path] });
      void checkServer();
    },
    onReconnect: () => void checkServer(),
  });

  // ---- changes -----------------------------------------------------------------------

  const status = useQuery({ queryKey: gitKeys.status(project.id), queryFn: ({ signal }) => gitApi.status(project.id, signal), staleTime: 15_000, retry: false });
  const repository = status.data?.state === 'ready';
  const changed = status.data?.state === 'ready' && status.data.files.some((file) => file.path === path);
  const changes = useQuery({
    queryKey: ['git', project.id, 'file-changes', path],
    queryFn: async ({ signal }) => {
      const unstaged = await gitApi.diff(project.id, path, false, signal);
      if (unstaged.diff !== '' || unstaged.binary) return { ...unstaged, staged: false };
      return { ...(await gitApi.diff(project.id, path, true, signal)), staged: true };
    },
    enabled: view === 'changes' && repository,
    retry: false,
  });

  // ---- what to draw ------------------------------------------------------------------

  const isText = loaded.kind === 'text';
  const markdown = isText && isMarkdown(path);
  const views: { value: View; label: string; icon?: ReactNode }[] = [{ value: 'edit', label: writable ? t('files.editor.view.edit') : t('files.editor.view.read') }];
  if (markdown) views.push({ value: 'preview', label: t('files.editor.view.preview') });
  if (repository && isText) {
    // The mark sits on the segment it is about: this file differs from the last commit.
    views.push({ value: 'changes', label: t('files.editor.view.changes'), ...(changed ? { icon: <span className="pt-dot" data-tone="warning" title={t('files.editor.hasChanges')} /> } : {}) });
  }
  const shown: View = views.some((entry) => entry.value === view) ? view : 'edit';

  const chooseView = (next: View) => {
    if (next === 'preview' && code.current) setPreviewText(writeShape(code.current.snapshot().lines, { bom: false, lineBreak: '\n' }));
    setView(next);
  };
  const toggleWrap = () => {
    const next = !wrap;
    setWrap(next);
    try {
      window.localStorage.setItem(WRAP_KEY, next ? '1' : '0');
    } catch {
      /* this device will not remember; the editor still wraps */
    }
  };
  const copyPath = () => void copyText(path).then((copied) => copied && toast.success(t('files.pathCopied')));

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const chord = (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 's';
    if (chord) {
      // The save shortcut works wherever the focus is in the panel, and never reaches the browser's "save page".
      event.preventDefault();
      void save();
      return;
    }
    if (event.key === 'Escape' && !event.defaultPrevented && !isAnyOverlayOpen()) {
      // Inside the text, Escape first belongs to the editor (a search panel, a completion list).
      if (event.target instanceof Element && event.target.closest('.cm-panels, .cm-tooltip')) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };

  const saveLabel = doc.saving ? t('files.editor.saving') : justSaved && !doc.dirty ? t('files.editor.saved') : t('common.save');
  const conflict = doc.conflict;

  return (
    <div className="pt-panel files-editor" data-keys="own" onKeyDown={onKeyDown}>
      <header className="pt-toolbar">
        <IconButton label={t('files.editor.back')} icon={<ArrowLeft size={21} />} tone="secondary" onClick={onClose} />
        <h2 className="pt-toolbar__title files-editor__name" title={path}>
          <span className="u-truncate">{name}</span>
          {doc.dirty && <span className="files-editor__unsaved" role="img" aria-label={t('files.editor.unsaved')} />}
        </h2>
        {!writable && <Badge>{t('files.readOnly')}</Badge>}
        {isText && writable && (
          <Button
            size="sm"
            variant={doc.dirty && !conflict ? 'primary' : 'neutral'}
            disabled={!doc.dirty || doc.saving || conflict !== null}
            loading={doc.saving}
            loadingLabel={t('files.editor.saving')}
            icon={justSaved && !doc.dirty ? <Check size={16} /> : undefined}
            onClick={() => void save()}
          >
            {saveLabel}
          </Button>
        )}
        <MenuButton
          label={t('files.editor.more', { name })}
          icon={<Ellipsis size={21} />}
          items={[
            ...(isText ? [{ id: 'wrap', label: t('files.editor.wrap'), icon: <WrapText size={18} />, checked: wrap, onSelect: toggleWrap }] : []),
            { id: 'copy', label: t('files.copyPath'), icon: <Copy size={18} />, onSelect: copyPath },
            { id: 'download', label: t('files.download'), icon: <Download size={18} />, onSelect: () => startDownload(filesApi.rawUrl(project.id, path), name) },
            { id: 'reveal', label: t('files.revealInTree'), icon: <FolderSearch size={18} />, onSelect: () => onReveal(path) },
            ...(loaded.kind !== 'loading' ? [{ id: 'reload', label: t('files.editor.reload'), icon: <RotateCw size={18} />, onSelect: () => void loadTheirs() }] : []),
          ]}
        />
      </header>

      {views.length > 1 && (
        <div className="files-editor__views">
          <SegmentedControl label={t('files.editor.view.label')} value={shown} onChange={chooseView} options={views} />
        </div>
      )}

      {conflict && (
        <div className="pt-problem">
          <Banner tone="warning" role="alert" title={t(`files.conflict.${conflict.reason}.title`)}>
            <p>{t(`files.conflict.${conflict.reason}.text`)}</p>
            <div className="files-editor__choices">
              {conflict.reason !== 'gone' && (
                <Button size="sm" variant="neutral" onClick={() => void loadTheirs()} disabled={busyChoice || doc.saving}>
                  {t('files.conflict.loadTheirs')}
                </Button>
              )}
              <Button size="sm" variant="neutral" onClick={() => void overwrite()} loading={doc.saving} disabled={busyChoice}>
                {conflict.reason === 'gone' ? t('files.conflict.recreate') : t('files.conflict.overwrite')}
              </Button>
            </div>
          </Banner>
        </div>
      )}
      {!conflict && doc.changedElsewhere && (
        <div className="pt-problem">
          <Banner
            tone="warning"
            role="status"
            action={
              <Button size="sm" variant="plain" onClick={() => dispatch({ type: 'dismissed' })}>
                {t('common.dismiss')}
              </Button>
            }
          >
            {t('files.editor.changedElsewhere')}
          </Banner>
        </div>
      )}
      {doc.problem && <ProblemNote problem={doc.problem} title={t('files.editor.notSaved')} onDismiss={() => dispatch({ type: 'dismissed' })} />}

      <div className="files-editor__body">
        {loaded.kind === 'loading' && <LoadingRow label={t('files.editor.loading', { name })} />}
        {loaded.kind === 'failed' && (
          <Stage>
            <ErrorState
              error={loaded.error}
              {...(isApiError(loaded.error) && loaded.error.gone ? { title: t('files.editor.gone'), description: path } : {})}
              onRetry={() => {
                setLoaded({ kind: 'loading' });
                void read(null);
              }}
              actions={
                <Button variant="plain" onClick={onClose}>
                  {t('files.editor.back')}
                </Button>
              }
            />
          </Stage>
        )}
        {loaded.kind === 'text' && (
          <>
            <div className="files-editor__pane" hidden={shown !== 'edit'}>
              <CodeEditor
                key={loaded.nonce}
                ref={code}
                text={loaded.text}
                savedText={loaded.savedText}
                path={path}
                wrap={wrap}
                readOnly={!writable}
                label={t('files.editor.label', { name })}
                onDirtyChange={(dirty) => dispatch({ type: 'edited', dirty })}
                onSave={() => void save()}
              />
            </div>
            {shown === 'preview' && (
              <div className="files-editor__pane files-editor__preview pt-scroll">
                <Markdown
                  resolveImage={(source) => {
                    const resolved = resolveRelative(path, source);
                    return resolved ? filesApi.rawUrl(project.id, resolved, 'inline') : null;
                  }}
                >
                  {previewText}
                </Markdown>
              </div>
            )}
            {shown === 'changes' && (
              <div className="files-editor__pane files-editor__changes pt-scroll">
                {doc.dirty && <p className="pt-note">{t('files.changes.unsavedNote')}</p>}
                {changes.isPending ? (
                  <LoadingRow label={t('common.loading')} />
                ) : changes.isError ? (
                  <ProblemNote problem={problemOf(changes.error, t)} action={<Button size="sm" variant="plain" onClick={() => void changes.refetch()}>{t('common.retry')}</Button>} />
                ) : changes.data.binary ? (
                  <p className="pt-note">{t('files.changes.binary')}</p>
                ) : changes.data.diff === '' ? (
                  <p className="pt-note">{t('files.changes.none')}</p>
                ) : (
                  <>
                    <p className="pt-note">{changes.data.staged ? t('files.changes.staged') : t('files.changes.unstaged')}</p>
                    <DiffView patch={hunksOnly(changes.data.diff)} limit={1500} label={t('files.changes.label', { name })} />
                    {changes.data.truncated && <p className="pt-note">{t('files.changes.truncated')}</p>}
                  </>
                )}
              </div>
            )}
          </>
        )}
        {loaded.kind === 'binary' && <MediaPreview project={project} path={path} content={loaded.content} />}
        {loaded.kind === 'too_large' && (
          <Stage>
            <ErrorState
              kind="failed"
              title={t('files.tooLarge.title')}
              description={t('files.tooLarge.description', { size: formatBytes(loaded.content.size, t.number), limit: formatBytes(loaded.content.limit, t.number) })}
              actions={
                <Button variant="tinted" icon={<Download size={18} />} onClick={() => startDownload(filesApi.rawUrl(project.id, path), name)}>
                  {t('files.download')}
                </Button>
              }
            />
          </Stage>
        )}
      </div>
    </div>
  );
}
