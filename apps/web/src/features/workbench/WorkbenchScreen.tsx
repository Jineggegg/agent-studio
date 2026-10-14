import { PROVIDERS_CHANGED_EVENT, PROVIDERS_TOPIC, type Project, type Session } from '@agent-studio/protocol';
import { useQueryClient } from '@tanstack/react-query';
import { FolderPlus, MessagesSquare } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { errorKind } from '@/data/errors';
import { useProjects, useProjectsLiveUpdates } from '@/data/projects';
import { useRealtimeTopic } from '@/data/realtime';
import { useIsOwner, useUser } from '@/data/session';
import { NewProjectSheet } from '@/features/home/NewProjectSheet';
import { useT } from '@/i18n';
import { useLayoutClass } from '@/platform/layout';
import { isApplePlatform, useCanHover } from '@/platform/media';
import { useScreen, useScreenActive } from '@/shell/ScreenStack';
import { useBack } from '@/shell/back';
import { announceFirstPaint } from '@/shell/launch';
import { useDocumentTitle } from '@/shell/title';
import { Button, DelayedSkeleton, EmptyState, ErrorState, Skeleton, SkeletonText } from '@/ui';
import { OverlayPortal, focusableWithin, isAnyOverlayOpen, useOverlayLayer } from '@/ui/overlay';
import { useAgents } from './agents';
import { workbenchApi } from './api';
import { ChatColumn } from './chat/ChatColumn';
import { arrangeColumns, listPresentation } from './columns';
import { moveNewAttachments } from './composer/attachmentStore';
import { moveNewDraft, newChatDraftKey, useDrafts } from './composer/drafts';
import { restoreOutbox } from './composer/outbox';
import { type ListScope, forgetConversation, remember, useDeviceMemory } from './device';
import { Inspector, presentationFor, useInspectorPanels } from './inspector/Inspector';
import { type InspectorContext, toggleInspector, useInspectorState } from './inspector/registry';
import { InspectorScope } from './inspector/scope';
import { parseWorkbenchPath, workbenchPaths } from './routes';
import { ListColumn } from './sessions/ListColumn';
import { SessionList, type SessionListHandle } from './sessions/SessionList';
import { listMark } from './sessions/grouping';
import { flattenSessions, upsertSession, useSessionList, useSessionQuery, useWorkbenchLiveUpdates, workbenchKeys } from './sessions/queries';
import { onSessionAnnounced } from './transcript/channel';
import './workbench.css';

/** The conversation list as a sheet from the leading edge (phone): modal, focus kept inside, Escape and the backdrop close it. */
function ListDrawer({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  const t = useT();
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);
  if (open && (!mounted || closing)) {
    if (!mounted) setMounted(true);
    if (closing) setClosing(false);
  } else if (!open && mounted && !closing) {
    setClosing(true);
  }
  const active = mounted && !closing;

  useLayoutEffect(() => {
    if (active) opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }, [active]);
  useOverlayLayer(active, onClose);
  useLayoutEffect(() => {
    if (!active) {
      const previous = opener.current;
      opener.current = null;
      if (previous && document.contains(previous)) previous.focus({ preventScroll: true });
      return;
    }
    const element = panel.current;
    if (element) (element.querySelector<HTMLElement>('[data-autofocus]') ?? focusableWithin(element)[0] ?? element).focus({ preventScroll: true });
  }, [active]);
  useEffect(() => {
    if (!closing) return;
    const timer = window.setTimeout(() => {
      setMounted(false);
      setClosing(false);
    }, 240);
    return () => window.clearTimeout(timer);
  }, [closing]);

  if (!mounted) return null;
  return (
    <OverlayPortal>
      <div className="wb-drawer-layer" data-overlay="" data-state={closing ? 'closing' : 'open'} inert={closing}>
        <div className="wb-drawer__scrim" onClick={onClose} aria-hidden="true" />
        <div
          ref={panel}
          className="wb-drawer"
          role="dialog"
          aria-modal="true"
          aria-label={t('workbench.list.title')}
          tabIndex={-1}
          onKeyDown={(event) => {
            if (event.key !== 'Tab') return;
            const element = panel.current;
            if (!element) return;
            const items = focusableWithin(element);
            if (items.length === 0) return;
            const first = items[0]!;
            const last = items[items.length - 1]!;
            if (event.shiftKey && (document.activeElement === first || document.activeElement === element)) {
              event.preventDefault();
              last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first.focus();
            }
          }}
        >
          {children}
        </div>
      </div>
    </OverlayPortal>
  );
}

function ChatSkeleton() {
  const t = useT();
  return (
    <div className="wb-chat wb-chat--stage">
      <DelayedSkeleton label={t('workbench.transcript.loading')}>
        <div className="wb-transcript__skeleton">
          <Skeleton width="58%" height={44} radius={18} className="wb-transcript__skeleton-user" />
          <SkeletonText lines={4} />
          <Skeleton width="72%" height={84} radius={14} />
        </div>
      </DelayedSkeleton>
    </div>
  );
}

/** Two titles registered by the same screen would compete; this one exists only while the chat's does not. */
function StageTitle({ title }: { title: string }) {
  useDocumentTitle(title);
  return null;
}

/**
 * The workbench: the conversation list, one conversation, and — when a
 * project's tools are installed — the inspector beside it. The address says
 * which conversation; how the screen is arranged is this device's own affair.
 */
export default function WorkbenchScreen() {
  const t = useT();
  // The address this screen is on show for — not the router's, which already names the next place while this
  // screen animates away, and would otherwise be read here as "the workbench, nowhere in particular".
  const { location } = useScreen();
  const navigate = useNavigate();
  const layout = useLayoutClass();
  const canHover = useCanHover();
  const user = useUser();
  const isOwner = useIsOwner();
  const queryClient = useQueryClient();
  const screenActive = useScreenActive();
  const memory = useDeviceMemory();
  const back = useBack({ to: '/', label: t('nav.home') });
  const target = useMemo(() => parseWorkbenchPath(location.pathname), [location.pathname]);

  const projectsQuery = useProjects();
  useProjectsLiveUpdates();
  // Only projects that offer conversations with agents belong here.
  const projects = useMemo(() => (projectsQuery.data ?? []).filter((project) => project.features.assistant), [projectsQuery.data]);
  const agents = useAgents().data;
  // An API provider was added, changed or removed: the agents on offer may have changed with it.
  useRealtimeTopic(PROVIDERS_TOPIC, (event) => {
    if (event.type === PROVIDERS_CHANGED_EVENT) void queryClient.invalidateQueries({ queryKey: workbenchKeys.agents });
  });

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [focusComposer, setFocusComposer] = useState(false);
  const listRef = useRef<SessionListHandle>(null);
  const wantSearchFocus = useRef(false);
  /** Sessions that grew out of an unsent conversation in this page keep that conversation's identity, so the chat is not re-created. */
  const adopted = useRef(new Map<string, string>());

  useEffect(() => announceFirstPaint(), []);
  useEffect(() => restoreOutbox(), []);
  useEffect(() => onSessionAnnounced((session) => upsertSession(queryClient, session)), [queryClient]);

  // ---- which conversation ------------------------------------------------------

  const lookupId = target.kind === 'lookup' ? target.sessionId : target.kind === 'session' ? target.sessionId : null;
  const sessionQuery = useSessionQuery(lookupId);
  const session = sessionQuery.data ?? null;
  const isActive = useRef(screenActive);
  useEffect(() => {
    isActive.current = screenActive;
  }, [screenActive]);
  const go = useCallback(
    (to: string, state?: unknown) => {
      // A screen on its way out moves nobody: the reader has already left.
      if (!isActive.current) return;
      void navigate(to, { replace: true, ...(state === undefined ? {} : { state }) });
    },
    [navigate],
  );

  // "Where was I?" — decided once per arrival, then the address says it.
  const landed = useRef<string | null>(null);
  useEffect(() => {
    if (!projectsQuery.data || landed.current === location.key) return undefined;
    if (target.kind === 'project') {
      if (!projects.some((project) => project.id === target.projectId)) return undefined;
      landed.current = location.key;
      const last = memory.lastConversation[target.projectId];
      if (last && last !== 'new') go(workbenchPaths.session(target.projectId, last), { remembered: true });
      else go(workbenchPaths.newChat(target.projectId));
      return undefined;
    }
    if (target.kind !== 'landing' || projects.length === 0) return undefined;
    landed.current = location.key;
    const fallback = projects.find((project) => project.id === memory.lastProjectId) ?? projects.find((project) => !project.scratch) ?? projects[0]!;
    if (memory.scope !== 'all') {
      go(workbenchPaths.project(fallback.id));
      return undefined;
    }
    // The whole Studio: go to what is running now, if anything is; otherwise a new conversation.
    let cancelled = false;
    workbenchApi
      .activeRuns()
      .then(({ runs }) => {
        if (cancelled) return;
        const newest = [...runs].sort((a, b) => (b.startedAt ?? b.createdAt) - (a.startedAt ?? a.createdAt))[0];
        go(newest ? workbenchPaths.session(newest.projectId, newest.sessionId) : workbenchPaths.newChat(fallback.id));
      })
      .catch(() => {
        if (!cancelled) go(workbenchPaths.newChat(fallback.id));
      });
    return () => {
      cancelled = true;
    };
    // Memory is read at the moment of arrival; later changes to it must not move the reader.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, projectsQuery.data, projects, location.key, go]);

  // A link that names the wrong project — or the agent's own id — is corrected to the one address the session has.
  useEffect(() => {
    if (!session || (target.kind !== 'session' && target.kind !== 'lookup')) return;
    const canonical = workbenchPaths.session(session.projectId, session.id);
    if (canonical !== location.pathname) go(canonical, location.state);
  }, [session, target, location.pathname, location.state, go]);

  const projectId = target.kind === 'new' || target.kind === 'project' ? target.projectId : target.kind === 'session' ? (session?.projectId ?? target.projectId) : (session?.projectId ?? null);
  const project = projects.find((entry) => entry.id === projectId) ?? null;
  const sessionId = target.kind === 'session' ? target.sessionId : target.kind === 'lookup' && session ? session.id : null;
  const showsChat = target.kind === 'new' || target.kind === 'session' || (target.kind === 'lookup' && session !== null && session.projectId === null);
  const conversationKey = sessionId ? (adopted.current.get(sessionId) ?? `session:${sessionId}`) : `new:${projectId ?? ''}:${nonce}`;

  useEffect(() => {
    if (project && memory.lastProjectId !== project.id) remember({ lastProjectId: project.id });
  }, [project, memory.lastProjectId]);

  // ---- moving about ------------------------------------------------------------

  const openSession = useCallback(
    (entry: Pick<Session, 'id' | 'projectId'>, seq?: number) => {
      setDrawerOpen(false);
      setFocusComposer(false);
      go(workbenchPaths.session(entry.projectId, entry.id), seq === undefined ? undefined : { focusSeq: seq });
    },
    [go],
  );

  const newChat = useCallback(
    (inProject?: string) => {
      const destination = inProject ?? projectId ?? memory.lastProjectId ?? projects[0]?.id;
      if (!destination) return;
      setDrawerOpen(false);
      setFocusComposer(true);
      setNonce((value) => value + 1);
      go(workbenchPaths.newChat(destination));
    },
    [projectId, memory.lastProjectId, projects, go],
  );

  const chooseProject = useCallback(
    (nextProjectId: string) => {
      if (nextProjectId === projectId) return;
      if (target.kind === 'new' && projectId) {
        // An unsent conversation moves to the other project, and takes what was written with it.
        const moved = moveNewDraft(projectId, nextProjectId);
        if (moved) moveNewAttachments(projectId, nextProjectId);
        setFocusComposer(canHover);
        return go(workbenchPaths.newChat(nextProjectId));
      }
      setFocusComposer(false);
      go(workbenchPaths.project(nextProjectId));
    },
    [projectId, target.kind, canHover, go],
  );

  const onSessionCreated = useCallback(
    (created: Session) => {
      adopted.current.set(created.id, conversationKey);
      go(workbenchPaths.session(created.projectId, created.id));
    },
    [conversationKey, go],
  );

  const remembered = (location.state as { remembered?: boolean } | null)?.remembered === true;
  const forget = useCallback(
    (goneSessionId: string) => {
      if (projectId) forgetConversation(projectId, goneSessionId);
      // A conversation that was only remembered is forgotten without comment; one that was asked for by link says it is gone.
      if (remembered && projectId) go(workbenchPaths.newChat(projectId));
    },
    [projectId, remembered, go],
  );

  useWorkbenchLiveUpdates({
    onRemoved: (removed) => {
      if (removed === sessionId && projectId) go(workbenchPaths.newChat(projectId));
    },
  });

  // Archived while it was open (here or on another device): the chat falls back to a new conversation.
  const wasArchived = useRef<{ id: string; archived: boolean } | null>(null);
  useEffect(() => {
    if (!session) return;
    const before = wasArchived.current;
    wasArchived.current = { id: session.id, archived: session.archived };
    if (before && before.id === session.id && !before.archived && session.archived && session.projectId) go(workbenchPaths.newChat(session.projectId));
  }, [session, go]);

  // ---- arrangement ---------------------------------------------------------------

  const setScope = useCallback((scope: ListScope) => remember({ scope }), []);
  const listDocked = listPresentation(layout, memory.listCollapsed) === 'docked';
  const hideList = useCallback(() => (layout === 'phone' ? setDrawerOpen(false) : remember({ listCollapsed: true })), [layout]);
  const showList = useCallback(() => (layout === 'phone' ? setDrawerOpen(true) : remember({ listCollapsed: false })), [layout]);
  const toggleList = useCallback(() => {
    if (layout === 'phone') setDrawerOpen((open) => !open);
    else remember({ listCollapsed: !useDeviceMemory.getState().listCollapsed });
  }, [layout]);

  // The mark on the "show list" button comes from the list the button would show.
  const listParams = useMemo(() => ({ projectId: memory.scope === 'project' ? projectId : null, archived: 'exclude' as const, q: '' }), [memory.scope, projectId]);
  const marksQuery = useSessionList(listParams, { enabled: !listDocked && (memory.scope === 'all' || projectId !== null) });
  const hiddenListMark = useMemo(() => (listDocked ? null : listMark(flattenSessions(marksQuery.data), sessionId)), [listDocked, marksQuery.data, sessionId]);

  const inspectorContext = useMemo<InspectorContext>(() => ({ project, sessionId, role: user?.role ?? 'member' }), [project, sessionId, user?.role]);
  const panels = useInspectorPanels(inspectorContext);
  const inspectorState = useInspectorState();
  const frame = useRef<HTMLDivElement>(null);
  const [frameWidth, setFrameWidth] = useState(() => (typeof window === 'undefined' ? 1280 : window.innerWidth));
  useEffect(() => {
    const element = frame.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setFrameWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const newDraft = useDrafts((state) => state.texts[newChatDraftKey(projectId)] ?? '');
  const newChatHasDraft = newDraft.trim() !== '' || (projectId !== null && (memory.newDrafts[projectId] ?? '').trim() !== '');

  // ---- keys ----------------------------------------------------------------------

  useEffect(() => {
    if (!screenActive) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.repeat) return;
      const apple = isApplePlatform();
      if (!(apple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)) return;
      // Inside a terminal or an editor, Ctrl-chords belong to it; only ⌘-chords are the workbench's.
      if (event.target instanceof Element && event.target.closest('.cm-editor, .xterm, [data-keys="own"]') && !event.metaKey) return;
      if (isAnyOverlayOpen() && !drawerOpen) return;
      const key = event.key.toLowerCase();
      if (key === 'k' && !event.shiftKey) {
        event.preventDefault();
        wantSearchFocus.current = true;
        showList();
        listRef.current?.focusSearch();
      } else if ((key === 'n' && !event.shiftKey) || (key === 'o' && event.shiftKey)) {
        event.preventDefault();
        newChat();
      } else if (key === '\\' && !event.shiftKey) {
        event.preventDefault();
        toggleList();
      } else if (key === 'j' && !event.shiftKey && panels.length > 0) {
        event.preventDefault();
        toggleInspector();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [screenActive, drawerOpen, showList, newChat, toggleList, panels.length]);

  // ⌘K on a hidden list: the field exists one render later.
  useEffect(() => {
    if (!wantSearchFocus.current) return;
    if (!listDocked && !drawerOpen) return;
    wantSearchFocus.current = false;
    const timer = window.setTimeout(() => listRef.current?.focusSearch(), 60);
    return () => window.clearTimeout(timer);
  }, [listDocked, drawerOpen]);

  // ---- what to draw ----------------------------------------------------------------

  // The chat names the tab itself (conversation · project). Only when no chat is on show does the workbench.
  const stageTitle = t('workbench.title');

  const list = (presentation: 'docked' | 'sheet') => (
    <SessionList
      ref={listRef}
      scope={memory.scope}
      onScopeChange={setScope}
      project={project}
      projects={projects}
      agents={agents ?? []}
      openSessionId={sessionId}
      newChatOpen={target.kind === 'new'}
      newChatHasDraft={newChatHasDraft}
      onOpenSession={openSession}
      onNewChat={() => newChat()}
      onChooseProject={chooseProject}
      onHide={hideList}
      presentation={presentation}
      back={back}
    />
  );

  let main: ReactNode;
  if (projectsQuery.isPending) {
    main = <ChatSkeleton />;
  } else if (!projectsQuery.data) {
    main = (
      <div className="wb-chat wb-chat--stage">
        <ErrorState error={projectsQuery.error} title={t('workbench.stage.projectsFailed')} onRetry={() => void projectsQuery.refetch()} retrying={projectsQuery.isFetching} />
      </div>
    );
  } else if (target.kind === 'unknown') {
    main = (
      <div className="wb-chat wb-chat--stage">
        <ErrorState
          kind="gone"
          title={t('shell.notFound.title')}
          description={t('shell.notFound.description')}
          actions={
            <Button variant="tinted" onClick={() => go(workbenchPaths.root())}>
              {t('workbench.stage.openRecent')}
            </Button>
          }
        />
      </div>
    );
  } else if (target.kind === 'lookup' && !session) {
    // Looking a conversation up by id alone. A server that cannot be reached is not a conversation that is gone.
    const gone = sessionQuery.isError && errorKind(sessionQuery.error) === 'gone';
    main = sessionQuery.isError ? (
      <div className="wb-chat wb-chat--stage">
        <ErrorState
          kind={gone ? 'gone' : 'unreachable'}
          {...(gone ? {} : { error: sessionQuery.error })}
          title={gone ? t('workbench.session.gone') : t('workbench.session.unreachable')}
          {...(gone ? { description: t('workbench.session.goneDetail') } : {})}
          onRetry={() => void sessionQuery.refetch()}
          retrying={sessionQuery.isFetching}
          actions={
            projects.length > 0 ? (
              <Button variant={gone ? 'tinted' : 'plain'} onClick={() => newChat()}>
                {t('workbench.new')}
              </Button>
            ) : undefined
          }
        />
      </div>
    ) : (
      <ChatSkeleton />
    );
  } else if (projects.length === 0 && !showsChat) {
    main = (
      <div className="wb-chat wb-chat--stage">
        <EmptyState
          icon={<MessagesSquare size={28} />}
          title={t('workbench.stage.noProjects')}
          description={isOwner ? t('workbench.stage.noProjectsOwner') : t('workbench.stage.noProjectsMember')}
          action={
            <>
              {isOwner && (
                <Button variant="primary" icon={<FolderPlus size={18} />} onClick={() => setNewProjectOpen(true)}>
                  {t('workbench.project.new')}
                </Button>
              )}
              {back && (
                <Button variant="plain" onClick={back.go}>
                  {back.accessibleLabel}
                </Button>
              )}
            </>
          }
        />
      </div>
    );
  } else if ((target.kind === 'new' || target.kind === 'project') && !project) {
    main = (
      <div className="wb-chat wb-chat--stage">
        <ErrorState
          kind="gone"
          title={t('workbench.stage.unknownProject')}
          description={t('workbench.stage.unknownProjectDetail')}
          actions={
            <Button variant="tinted" onClick={() => go(workbenchPaths.root())}>
              {t('workbench.stage.openRecent')}
            </Button>
          }
        />
      </div>
    );
  } else if (!showsChat) {
    main = <ChatSkeleton />;
  } else {
    main = (
      <ChatColumn
        key={conversationKey}
        project={project}
        sessionId={sessionId}
        scope={memory.scope}
        projects={projects}
        listHidden={!listDocked}
        listMark={hiddenListMark}
        onShowList={showList}
        back={back}
        onSessionCreated={onSessionCreated}
        onNewChat={() => newChat()}
        onChooseProject={chooseProject}
        onNewProject={isOwner ? () => setNewProjectOpen(true) : undefined}
        onForget={forget}
        focusSeq={(location.state as { focusSeq?: number } | null)?.focusSeq ?? null}
        focusComposer={focusComposer || (canHover && target.kind === 'new')}
        inspector={{ available: panels.length > 0, open: inspectorState.open && panels.length > 0, toggle: toggleInspector }}
      />
    );
  }

  const inspectorOpen = inspectorState.open && panels.length > 0;
  // Fitted again whenever the frame changes size, so a window made narrower never leaves the chat too narrow to use.
  const columns = arrangeColumns({
    frameWidth,
    listDocked,
    listWidth: memory.listWidth,
    inspectorDocked: inspectorOpen && presentationFor(layout) === 'docked',
    inspectorWidth: inspectorState.width,
  });
  return (
    <div className="wb" ref={frame} data-list={listDocked ? 'docked' : 'hidden'} data-inspector={inspectorOpen ? 'open' : undefined}>
      {listDocked && (
        <ListColumn width={columns.list} maxWidth={columns.listMax}>
          {list('docked')}
        </ListColumn>
      )}
      <main className="wb__main" inert={layout === 'phone' && inspectorOpen}>
        {!showsChat && <StageTitle title={stageTitle} />}
        <InspectorScope value={inspectorContext}>{main}</InspectorScope>
      </main>
      {panels.length > 0 && <Inspector context={inspectorContext} panels={panels} layout={layout} maxWidth={columns.inspectorMax} />}
      {layout === 'phone' && (
        <ListDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)}>
          {list('sheet')}
        </ListDrawer>
      )}
      <NewProjectSheet
        open={newProjectOpen}
        onClose={() => setNewProjectOpen(false)}
        onCreated={(created: Project) => {
          setNewProjectOpen(false);
          newChat(created.id);
        }}
      />
    </div>
  );
}
