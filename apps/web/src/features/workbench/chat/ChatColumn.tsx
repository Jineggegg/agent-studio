import type { Approval, PermissionMode, Project, Session } from '@agent-studio/protocol';
import { useQueryClient } from '@tanstack/react-query';
import { Component, type ComponentType, type ErrorInfo, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type TouchEvent as ReactTouchEvent, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { isApiError } from '@/data/api';
import { useConnectionState } from '@/data/connection';
import { describeError, errorKind } from '@/data/errors';
import { useIsOwner, useUser } from '@/data/session';
import { DeferredList } from '@/features/automation/DeferredList';
import { SendLater } from '@/features/automation/SendLater';
import { useT } from '@/i18n';
import { useLayoutClass } from '@/platform/layout';
import { isApplePlatform, useCanHover } from '@/platform/media';
import { useKeyboardDock } from '@/platform/viewport';
import type { BackAction } from '@/shell/back';
import { useDocumentTitle } from '@/shell/title';
import { type ActivityKind, Banner, Button, ErrorState, toast } from '@/ui';
import { isAnyOverlayOpen } from '@/ui/overlay';
import { type AgentChoice, agentUnavailable, choiceFor, defaultChoice, findModel, modelLabel, nextMode, resolveEffort, useAgents, useProjectAgentSettings } from '../agents';
import { workbenchApi } from '../api';
import { ApprovalDock, ApprovalSheet } from '../approvals/ApprovalSurface';
import { approvalChoices, planContinuationModes } from '../approvals/logic';
import { Composer, type ComposerHandle, type ComposerSubmission } from '../composer/Composer';
import type { MentionSource } from '../composer/mentions';
import { DeliveryBanner } from '../composer/DeliveryBanner';
import { Queue } from '../composer/Queue';
import { adoptAttachments, clearSentAttachments, loadPendingAttachments, readyAttachments, restoreAttachments, uploadsSettled } from '../composer/attachmentStore';
import { blocksSending, newRequestId } from '../composer/delivery';
import { clearDraftAfterSend, flushDraft, getDraft, loadDraft, newChatDraftKey, restoreNewDraft, sessionDraftKey, setDraft } from '../composer/drafts';
import { checkDelivery, dismissFailed, retryOriginal, sendMessage, useOutbox } from '../composer/outbox';
import { type ListScope, rememberAgentChoice, rememberConversation, useDeviceMemory } from '../device';
import { usePresence } from '../presence';
import { RecoveryCard, RunStatusRow } from '../run/RunStatus';
import { runProgress } from '../run/status';
import { upsertSession, useSessionQuery } from '../sessions/queries';
import type { PendingUserRow } from '../transcript/Rows';
import { Transcript } from '../transcript/Transcript';
import type { WindowedListHandle } from '../transcript/WindowedList';
import { seedEmptyChannel, useChannel } from '../transcript/channel';
import { ContextRing } from '../usage/ContextRing';
import { AgentModelChip, EffortChip, ModeSwitcher, modeLabel, unavailableText } from './Pickers';
import { TitleBar } from './TitleBar';
import { type TitleBarItem, type TitleBarItemProps, subscribeTitleBarItems, titleBarItems, titleBarItemsVersion } from './slots';
import { AgentMark } from './parts';

export interface ChatColumnProps {
  /** The project the conversation is in; null only for a conversation outside any project. */
  project: Project | null;
  /** Null for a conversation that has not been sent yet. */
  sessionId: string | null;
  scope: ListScope;
  projects: readonly Project[];
  listHidden: boolean;
  listMark: Extract<ActivityKind, 'attention' | 'unseen'> | null;
  onShowList: () => void;
  back: BackAction | null;
  /** The first message created the session: the address should follow, without this column being re-created. */
  onSessionCreated: (session: Session) => void;
  onNewChat: () => void;
  onChooseProject: (projectId: string) => void;
  onNewProject?: (() => void) | undefined;
  /** The session turned out not to exist (any more). */
  onForget: (sessionId: string) => void;
  /** A search hit to bring into view. */
  focusSeq: number | null;
  /** Put the caret in the message field on arrival. */
  focusComposer: boolean;
  inspector: { available: boolean; open: boolean; toggle: () => void };
}

const slotComponents = new Map<string, ComponentType<TitleBarItemProps>>();

/** Downloads an item's code the first time the title bar needs it. Until then — and if that fails — nothing is drawn. */
function LazySlot({ item, ...props }: TitleBarItemProps & { item: TitleBarItem }) {
  const [Loaded, setLoaded] = useState<ComponentType<TitleBarItemProps> | null>(() => slotComponents.get(item.id) ?? null);
  useEffect(() => {
    if (Loaded) return;
    let cancelled = false;
    item.load().then(
      (module) => {
        slotComponents.set(item.id, module.default);
        if (!cancelled) setLoaded(() => module.default);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [item, Loaded]);
  return Loaded ? <Loaded {...props} /> : null;
}

/** What other features put in the title bar (see `./slots`). Each is its own small island: one that fails to load is simply absent. */
function TitleBarSlot({ project, sessionId, busy }: { project: Project; sessionId: string | null; busy: boolean }) {
  const user = useUser();
  const layout = useLayoutClass();
  const version = useSyncExternalStore(subscribeTitleBarItems, titleBarItemsVersion, titleBarItemsVersion);
  // `version` is what changes when a feature registers an item.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const items = useMemo(() => titleBarItems({ project, role: user?.role ?? 'member' }), [project, user?.role, version]);
  return (
    <>
      {items.map((item) => (
        <SlotBoundary key={item.id}>
          <LazySlot item={item} project={project} sessionId={sessionId} busy={busy} compact={layout === 'phone'} />
        </SlotBoundary>
      ))}
    </>
  );
}

class SlotBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** One empty list for "nothing yet", so selectors and memos keep their identity. */
const NONE: never[] = [];

/** If drawing the conversation fails, the list and the tools beside it keep working, and the session itself is intact. */
class ChatBoundary extends Component<{ children: ReactNode; fallback: (reset: () => void) => ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('The conversation could not be drawn.', error, info.componentStack);
  }

  override render() {
    return this.state.failed ? this.props.fallback(() => this.setState({ failed: false })) : this.props.children;
  }
}

function scrollsSideways(target: EventTarget | null, stop: Element): boolean {
  for (let element = target instanceof Element ? target : null; element && element !== stop; element = element.parentElement) {
    if (element.scrollWidth > element.clientWidth + 1) {
      const overflow = window.getComputedStyle(element).overflowX;
      if (overflow === 'auto' || overflow === 'scroll') return true;
    }
  }
  return false;
}

/**
 * One conversation: its title bar, its transcript, and the dock at the bottom
 * where the user answers — approvals and questions, a run that needs
 * recovering, a message whose delivery is in doubt, the queue, the composer.
 */
export function ChatColumn(props: ChatColumnProps) {
  const t = useT();
  return (
    <ChatBoundary
      fallback={(reset) => (
        <div className="wb-chat wb-chat--stage">
          <ErrorState
            kind="failed"
            title={t('workbench.chat.crashed')}
            description={t('workbench.chat.crashedDetail')}
            actions={
              <>
                <Button variant="tinted" onClick={reset}>
                  {t('workbench.chat.reload')}
                </Button>
                <Button variant="plain" onClick={props.onNewChat}>
                  {t('workbench.new')}
                </Button>
              </>
            }
          />
        </div>
      )}
    >
      <Chat {...props} />
    </ChatBoundary>
  );
}

function Chat({ project, sessionId, scope, projects, listHidden, listMark, onShowList, back, onSessionCreated, onNewChat, onChooseProject, onNewProject, onForget, focusSeq, focusComposer, inspector }: ChatColumnProps) {
  const t = useT();
  const user = useUser();
  const isOwner = useIsOwner();
  const canHover = useCanHover();
  const queryClient = useQueryClient();
  const connection = useConnectionState();
  const agentsQuery = useAgents();
  const agents = agentsQuery.data ?? NONE;
  const sessionQuery = useSessionQuery(sessionId);
  const session = sessionId ? (sessionQuery.data ?? null) : null;
  const { channel, state } = useChannel(sessionId);
  const { transcript } = state;
  const outgoing = useOutbox((store) => (sessionId ? (store.bySession[sessionId] ?? NONE) : NONE));
  const memory = useDeviceMemory();

  const column = useRef<HTMLDivElement>(null);
  const dock = useRef<HTMLDivElement>(null);
  const composer = useRef<ComposerHandle>(null);
  const list = useRef<WindowedListHandle>(null);
  useKeyboardDock(dock);

  const [choice, setChoice] = useState<AgentChoice | null>(null);
  const [starting, setStarting] = useState<PendingUserRow | null>(null);
  const [quote, setQuote] = useState<string | null>(null);
  const [stopRequested, setStopRequested] = useState<string | null>(null);
  const [sheetApproval, setSheetApproval] = useState<string | null>(null);
  const [composerHasContent, setComposerHasContent] = useState(false);
  const [announcement, setAnnouncement] = useState('');

  // ---- who and what ----------------------------------------------------------

  // A new conversation starts from what was used last on this device, as soon as the agents are known.
  useEffect(() => {
    if (sessionId !== null || choice !== null || agents.length === 0) return;
    setChoice(defaultChoice(agents, project, memory));
    // The device's memory is read once, when the choice is first made.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, choice, agents, project]);

  const agentId = session?.agentId ?? choice?.agentId ?? null;
  const agent = agents.find((entry) => entry.id === agentId);
  const model = session ? session.model : (choice?.model ?? null);
  const effort = session ? session.effort : (choice?.effort ?? null);
  const mode: PermissionMode = session?.permissionMode ?? choice?.mode ?? 'ask';
  const effectiveMode: PermissionMode = session?.effectivePermissionMode ?? mode;
  // An agent that is no longer offered here is still named by its id; one that is merely not read yet is not.
  const agentName = agent?.displayName ?? (agents.length > 0 ? agentId : null) ?? t('workbench.agent.generic');

  const draftKey = sessionId ? sessionDraftKey(sessionId) : newChatDraftKey(project?.id ?? null);
  const mine = session ? session.userId === user?.id : true;
  const writable = project ? project.access === 'write' : true;
  const unavailable = agent ? agentUnavailable(agent, sessionId ? null : project) : null;
  /** Why nothing can be written here, or null when it can. */
  const readOnly: string | null = !mine
    ? t('workbench.readOnly.notYours')
    : !writable
      ? t('workbench.readOnly.project')
      : sessionId !== null && agentsQuery.data !== undefined && !agent
        ? t('workbench.readOnly.agentGone')
        : sessionId === null && agentsQuery.data !== undefined && !agent
          ? t('workbench.readOnly.noAgent')
          : null;

  const activeRun = transcript.activeRun;
  const busy = activeRun !== null;
  const stopping = busy && stopRequested === activeRun.id;
  const canControl = mine || isOwner;
  const progress = useMemo(() => runProgress(transcript), [transcript]);
  const pendingApprovals = transcript.pendingApprovals;
  const currentApproval: Approval | null = pendingApprovals[0] ?? null;
  const viewer = useMemo(() => ({ userId: user?.id ?? '', role: user?.role ?? ('member' as const) }), [user]);
  const blocked = starting !== null || outgoing.some(blocksSending);
  // A plan can be approved "and continued in" another mode: which ones depends on the agent and on the project.
  const planWaiting = pendingApprovals.some((approval) => approval.kind === 'plan');
  const projectSettings = useProjectAgentSettings(planWaiting && project ? project.id : null);
  const continuation = useMemo(
    () => planContinuationModes(agent?.capabilities.permissionModes ?? [], projectSettings.data?.autoMode === true),
    [agent, projectSettings.data],
  );
  const unsettled = outgoing.find((entry) => entry.phase === 'unconfirmed' || entry.phase === 'checking') ?? outgoing.find((entry) => entry.phase === 'failed') ?? null;

  const projectId = project?.id ?? null;
  const mentions = useMemo<MentionSource | undefined>(() => (projectId ? { search: (query, signal) => workbenchApi.searchFiles(projectId, query, signal) } : undefined), [projectId]);

  const title = session?.title ?? t('workbench.newConversation');
  useDocumentTitle(project ? `${title} · ${project.name}` : title);
  usePresence(sessionId !== null && state.status === 'ready' ? sessionId : null);

  useEffect(() => {
    if (project) rememberConversation(project.id, sessionId ?? 'new');
  }, [project, sessionId]);

  // ---- drafts and waiting files ------------------------------------------------

  useEffect(() => {
    if (sessionId === null) {
      restoreNewDraft(project?.id ?? null);
      return;
    }
    if (!mine || !writable) return;
    void loadDraft(sessionId);
    void loadPendingAttachments(sessionId);
    const key = sessionDraftKey(sessionId);
    return () => void flushDraft(key);
  }, [sessionId, project?.id, mine, writable]);

  // ---- what cannot be had from the live connection alone -------------------------

  useEffect(() => {
    if (sessionQuery.error && isApiError(sessionQuery.error) && sessionQuery.error.gone && sessionId) onForget(sessionId);
  }, [sessionQuery.error, sessionId, onForget]);

  // A message that got no acknowledgement is checked by itself once the server can be reached again.
  useEffect(() => {
    if (!sessionId || connection !== 'online') return;
    const waiting = outgoing.filter((entry) => entry.phase === 'unconfirmed' && entry.verdict === 'unknown');
    if (waiting.length === 0) return;
    const timer = window.setTimeout(() => {
      for (const entry of waiting) void checkDelivery(sessionId, entry.payload.requestId);
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [sessionId, connection, outgoing]);

  // Accepted but not showing: the live connection may be down. Read what was missed.
  useEffect(() => {
    if (!channel || !outgoing.some((entry) => entry.phase === 'accepted')) return;
    const timer = window.setTimeout(() => void channel.resync(), 1500);
    return () => window.clearTimeout(timer);
  }, [channel, outgoing]);

  // ---- announcements for people who cannot see the transcript move -----------------

  const previousRun = useRef<string | null>(null);
  useEffect(() => {
    const before = previousRun.current;
    previousRun.current = activeRun?.id ?? null;
    if (before && !activeRun) {
      const run = transcript.runs[before];
      setAnnouncement(run?.status === 'failed' ? t('workbench.run.failed') : run?.status === 'stopped' ? t('workbench.run.stopped') : run?.status === 'interrupted' ? t('workbench.run.interrupted') : t('workbench.run.completed'));
      setStopRequested(null);
    }
  }, [activeRun, transcript.runs, t]);
  const announcedApproval = useRef<string | null>(null);
  useEffect(() => {
    if (!currentApproval || announcedApproval.current === currentApproval.id) return;
    announcedApproval.current = currentApproval.id;
    setAnnouncement(t('workbench.approval.announce', { title: currentApproval.title }));
  }, [currentApproval, t]);

  // ---- actions ---------------------------------------------------------------------

  const resync = useCallback(() => void channel?.resync(), [channel]);

  const stop = useCallback(() => {
    if (!sessionId || !activeRun || !canControl || stopRequested === activeRun.id) return;
    setStopRequested(activeRun.id);
    workbenchApi.stop(sessionId).catch((error: unknown) => {
      // Already over by the time the request arrived: that is what was wanted.
      if (isApiError(error) && error.code === 'no_active_run') return void channel?.resync();
      setStopRequested(null);
      toast.error(describeError(error, t));
    });
  }, [sessionId, activeRun, canControl, stopRequested, channel, t]);

  const updateSession = useCallback(
    async (changes: Parameters<typeof workbenchApi.updateSession>[1]) => {
      if (!sessionId) return;
      try {
        upsertSession(queryClient, await workbenchApi.updateSession(sessionId, changes));
      } catch (error) {
        toast.error(describeError(error, t));
      }
    },
    [sessionId, queryClient, t],
  );

  const chooseMode = useCallback(
    (next: PermissionMode) => {
      if (agentId) rememberAgentChoice({ agentId, mode: next });
      if (sessionId) void updateSession({ permissionMode: next });
      else setChoice((current) => (current ? { ...current, mode: next } : current));
      setAnnouncement(t('workbench.mode.announce', { mode: modeLabel(next, t) }));
    },
    [agentId, sessionId, updateSession, t],
  );

  const chooseModel = useCallback(
    (nextAgentId: string, nextModel: string | null) => {
      const nextAgent = agents.find((entry) => entry.id === nextAgentId);
      if (!nextAgent) return;
      if (sessionId) {
        const nextEffort = resolveEffort(findModel(nextAgent, nextModel), effort);
        rememberAgentChoice({ agentId: nextAgentId, model: nextModel, effort: nextEffort });
        void updateSession({ model: nextModel, effort: nextEffort });
        return;
      }
      const next = choiceFor(nextAgent, useDeviceMemory.getState(), nextModel);
      // Switching agent keeps the mode when the new one has it.
      const keptMode = choice && nextAgent.capabilities.permissionModes.includes(choice.mode) && choice.mode !== 'auto' ? choice.mode : next.mode;
      setChoice({ ...next, mode: keptMode });
      rememberAgentChoice({ agentId: nextAgentId, model: next.model, effort: next.effort });
    },
    [agents, sessionId, effort, updateSession, choice],
  );

  const chooseEffort = useCallback(
    (nextEffort: string) => {
      if (agentId) rememberAgentChoice({ agentId, model, effort: nextEffort });
      if (sessionId) void updateSession({ effort: nextEffort });
      else setChoice((current) => (current ? { ...current, effort: nextEffort } : current));
    },
    [agentId, model, sessionId, updateSession],
  );

  /** Sends into a conversation that exists. */
  const sendToSession = useCallback(
    async (target: string, key: string, submission: ComposerSubmission, requestId = newRequestId()): Promise<boolean> => {
      await uploadsSettled(key);
      const ready = readyAttachments(key);
      if (ready.failed.length > 0) {
        toast.error(t('workbench.attach.failedBlocksSend'));
        return false;
      }
      const text = submission.text.trim() === '' ? '' : submission.text;
      if (text === '' && ready.ids.length === 0) return false;
      const running = channel?.getState().transcript.activeRun ?? null;
      const expected = running ? (submission.whenBusy === 'steer' ? 'steered' : 'queued') : 'run';
      const accepted = sendMessage(
        target,
        { requestId, text, attachmentIds: ready.ids, quote: submission.quote, whenBusy: submission.whenBusy },
        {
          attachments: ready.refs,
          expected,
          onRefused: (refused) => {
            // Nothing was sent. What was written goes back where it came from, unless something new is there already.
            if (getDraft(key).trim() === '') setDraft(key, refused.payload.text);
            restoreAttachments(key, refused.attachments, target);
            if (refused.payload.quote) setQuote((current) => current ?? refused.payload.quote);
          },
        },
      );
      if (!accepted) return false;
      clearDraftAfterSend(key);
      clearSentAttachments(key, ready.ids);
      setQuote(null);
      return true;
    },
    [channel, t],
  );

  /** The first message of a conversation: create the session, upload what was waiting, then send. */
  const sendFirst = useCallback(
    async (submission: ComposerSubmission): Promise<boolean> => {
      if (!choice || !agent) return false;
      const newKey = newChatDraftKey(project?.id ?? null);
      const requestId = newRequestId();
      const row: PendingUserRow = { kind: 'pending', key: `u:${requestId}`, requestId, text: submission.text, quote: submission.quote, attachments: [], phase: 'creating', steer: false, createdAt: Date.now() };
      setStarting(row);
      let created: Session;
      try {
        created = await workbenchApi.createSession({
          projectId: project?.id ?? null,
          agentId: choice.agentId,
          ...(choice.model ? { model: choice.model } : {}),
          ...(choice.effort ? { effort: choice.effort } : {}),
          permissionMode: choice.mode,
        });
      } catch (error) {
        // Nothing exists and nothing was sent: the text and the files stay in the composer.
        setStarting(null);
        toast.error(t('workbench.send.notCreated', { reason: describeError(error, t) }));
        return false;
      }
      upsertSession(queryClient, created);
      seedEmptyChannel(created.id);
      rememberAgentChoice({ agentId: choice.agentId, model: choice.model, effort: choice.effort, mode: choice.mode });
      const key = sessionDraftKey(created.id);
      clearDraftAfterSend(newKey);
      onSessionCreated(created);
      setStarting({ ...row, phase: 'uploading' });
      await adoptAttachments(newKey, created.id, { failed: t('workbench.attach.failed') });
      const sent = await sendToSession(created.id, key, submission, requestId);
      if (!sent) setDraft(key, submission.text);
      setStarting(null);
      return sent;
    },
    [choice, agent, project, queryClient, onSessionCreated, sendToSession, t],
  );

  const submit = useCallback(
    async (submission: ComposerSubmission): Promise<boolean> => {
      if (connection === 'offline') {
        toast.warning(t('workbench.send.offline'), { id: 'workbench-offline' });
        return false;
      }
      const sent = sessionId ? await sendToSession(sessionId, sessionDraftKey(sessionId), submission) : await sendFirst(submission);
      if (sent) list.current?.scrollToEnd();
      return sent;
    },
    [connection, sessionId, sendToSession, sendFirst, t],
  );

  const denyCurrent = useCallback(() => {
    if (!currentApproval) return false;
    if (currentApproval.kind !== 'tool' || !approvalChoices(currentApproval, viewer).canDeny) return false;
    workbenchApi.decide(currentApproval.id, { decision: 'deny' }).catch(() => resync());
    return true;
  }, [currentApproval, viewer, resync]);

  // ---- keys ------------------------------------------------------------------------

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing || isAnyOverlayOpen()) return;
    // Escape answers the request that is showing; failing that it stops the run; failing that it is "back".
    if (denyCurrent()) return event.preventDefault();
    if (busy && canControl) {
      event.preventDefault();
      stop();
    }
  };
  useEffect(() => {
    // ⌘. (Ctrl+. elsewhere) stops the run from anywhere in the workbench — for keyboards without Escape, and for when Escape is taken.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '.' || event.defaultPrevented || event.shiftKey || event.altKey) return;
      if (!(isApplePlatform() ? event.metaKey : event.ctrlKey)) return;
      if (event.target instanceof Element && event.target.closest('.cm-editor, .xterm, [data-keys="own"]') && !event.metaKey) return;
      event.preventDefault();
      stop();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [stop]);

  // ---- a rightward swipe over the conversation brings the list up -------------------

  const swipe = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (event: ReactTouchEvent<HTMLDivElement>) => {
    swipe.current = null;
    const touch = event.touches[0];
    if (!listHidden || !touch || event.touches.length !== 1 || isAnyOverlayOpen()) return;
    // The very edge is the system's own "back"; a field, or anything that scrolls sideways, keeps its gesture.
    if (touch.clientX < 28) return;
    const target = event.target;
    if (target instanceof HTMLElement && (target.closest('input, textarea, select, [contenteditable="true"]') || scrollsSideways(target, event.currentTarget))) return;
    swipe.current = { x: touch.clientX, y: touch.clientY };
  };
  const onTouchMove = (event: ReactTouchEvent<HTMLDivElement>) => {
    const start = swipe.current;
    const touch = event.touches[0];
    if (!start || !touch) return;
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (Math.abs(dy) > 28 || dx < -12 || (window.getSelection()?.toString() ?? '') !== '') {
      swipe.current = null;
      return;
    }
    if (dx >= 56 && Math.abs(dx) > Math.abs(dy) * 1.8) {
      swipe.current = null;
      onShowList();
    }
  };

  // ---- what to draw ----------------------------------------------------------------

  const titleBar = (
    <TitleBar
      title={title}
      session={session}
      canRename={mine && writable}
      onRename={(next) => void updateSession({ title: next })}
      agentId={agentId}
      agentLabel={agent ? [agent.displayName, modelLabel(agent, model)].filter(Boolean).join(' · ') : null}
      project={project}
      projectChoices={sessionId === null && scope === 'all' ? projects : null}
      onChooseProject={onChooseProject}
      onNewProject={onNewProject}
      listHidden={listHidden}
      listMark={listMark}
      onShowList={onShowList}
      back={back}
      inspector={inspector}
      trailing={
        <>
          {project && <TitleBarSlot project={project} sessionId={sessionId} busy={busy} />}
          <ContextRing context={transcript.context} totals={transcript.totals} agent={agent} />
          {agent && <ModeSwitcher mode={mode} effective={effectiveMode} agent={agent} project={project} disabled={!mine || !writable} onChange={chooseMode} />}
        </>
      }
    />
  );

  if (sessionId !== null && (sessionQuery.isError || state.status === 'gone' || state.status === 'error')) {
    const error = sessionQuery.error ?? state.error;
    const gone = state.status === 'gone' || errorKind(error) === 'gone';
    return (
      <div className="wb-chat" ref={column}>
        {titleBar}
        <div className="wb-chat__stage">
          <ErrorState
            kind={gone ? 'gone' : 'unreachable'}
            {...(gone ? {} : { error })}
            title={gone ? t('workbench.session.gone') : t('workbench.session.unreachable')}
            {...(gone ? { description: t('workbench.session.goneDetail') } : {})}
            onRetry={() => {
              void sessionQuery.refetch();
              void channel?.open();
            }}
            retrying={sessionQuery.isFetching}
            actions={
              <Button variant={gone ? 'tinted' : 'plain'} onClick={onNewChat}>
                {t('workbench.new')}
              </Button>
            }
          />
        </div>
      </div>
    );
  }

  const question = currentApproval?.kind === 'question' && approvalChoices(currentApproval, viewer).canAnswer ? currentApproval : null;
  const queued = outgoing.filter((entry) => entry.expected === 'queued' && entry.phase !== 'failed' && entry.phase !== 'unconfirmed' && entry.phase !== 'checking');
  const unresolved = transcript.unresolvedRuns;
  const sheetTarget = pendingApprovals.find((approval) => approval.id === sheetApproval) ?? null;

  const empty = (
    <div className="wb-hero">
      {agentId ? <AgentMark agentId={agentId} size={56} /> : null}
      <p className="wb-hero__title">{project?.name ?? t('workbench.newConversation')}</p>
      <p className="wb-hero__caption">{agent ? [agent.displayName, modelLabel(agent, model)].filter(Boolean).join(' · ') : agentsQuery.isPending ? t('common.loading') : t('workbench.readOnly.noAgent')}</p>
      {agent && unavailable && unavailable !== 'not-offered' && <Banner tone="warning">{unavailableText(agent, unavailable, t)}</Banner>}
      {agentsQuery.isError && !agentsQuery.data && <ErrorState compact error={agentsQuery.error} onRetry={() => void agentsQuery.refetch()} />}
    </div>
  );

  return (
    <div className="wb-chat" ref={column} onKeyDown={onKeyDown} onTouchStart={onTouchStart} onTouchMove={onTouchMove}>
      {titleBar}
      <Transcript
        state={state}
        channel={channel}
        outgoing={outgoing}
        starting={starting}
        agents={agents}
        sessionAgentId={agentId}
        userId={user?.id ?? null}
        empty={empty}
        listRef={list}
        focusSeq={focusSeq}
        onReviewApproval={setSheetApproval}
        onQuote={readOnly === null ? setQuote : undefined}
        footer={
          progress ? (
            <RunStatusRow progress={progress} agentName={agentName} showStop={canControl && (composerHasContent || readOnly !== null || question !== null)} stopping={stopping} onStop={stop} />
          ) : undefined
        }
      />
      <div className="wb-dock" ref={dock}>
        {currentApproval && !question && (
          <ApprovalDock approval={currentApproval} agentName={agentName} more={pendingApprovals.length - 1} onStale={resync} onDetails={() => setSheetApproval(currentApproval.id)} continuation={continuation} />
        )}
        {unresolved.length > 0 && (
          <RecoveryCard
            key={unresolved[0]!.id}
            run={unresolved[0]!}
            more={unresolved.length - 1}
            blocked={busy || blocked}
            canContinue={mine && writable}
            onChanged={resync}
            onView={() => {
              const item = transcript.items.find((entry) => entry.kind === 'run-end' && entry.runId === unresolved[0]!.id);
              if (item) list.current?.scrollToKey(item.key);
            }}
          />
        )}
        {sessionId && unsettled && (
          <DeliveryBanner
            outgoing={unsettled}
            offline={connection === 'offline'}
            onCheck={() => void checkDelivery(sessionId, unsettled.payload.requestId)}
            onRetry={() => void retryOriginal(sessionId, unsettled.payload.requestId)}
            onDismiss={() => dismissFailed(sessionId, unsettled.payload.requestId)}
          />
        )}
        {sessionId && <Queue sessionId={sessionId} queue={transcript.queue} arriving={queued} busy={busy} canSteer={agent?.capabilities.steering === true} editable={mine && writable} onChanged={resync} />}
        {sessionId && <DeferredList sessionId={sessionId} editable={mine && writable} />}
        {question ? (
          <ApprovalDock approval={question} agentName={agentName} more={pendingApprovals.length - 1} onStale={resync} onDetails={() => setSheetApproval(question.id)} />
        ) : readOnly !== null ? (
          <p className="wb-dock__note" role="note">
            {readOnly}
          </p>
        ) : (
          <Composer
            ref={composer}
            draftKey={draftKey}
            placeholder={t('workbench.composer.placeholder', { agent: agentName })}
            busy={busy}
            canSteer={agent?.capabilities.steering === true}
            blocked={blocked || (sessionId === null && (choice === null || unavailable !== null))}
            stopping={stopping}
            attachmentsEnabled
            onSubmit={submit}
            onStop={stop}
            onCycleMode={agent ? () => chooseMode(nextMode(agent, mode)) : undefined}
            quote={quote}
            onClearQuote={() => setQuote(null)}
            mentions={mentions}
            onContentChange={setComposerHasContent}
            autoFocus={focusComposer && (canHover || sessionId === null)}
            accessory={
              sessionId ? (
                <SendLater sessionId={sessionId} draftKey={draftKey} project={project} options={{ model, effort, permissionMode: mode }} hasQuote={quote !== null} blocked={blocked} />
              ) : undefined
            }
            controls={
              <>
                <AgentModelChip agents={agents} project={project} agentId={agentId} model={model} locked={sessionId !== null} disabled={busy && sessionId !== null} onChoose={chooseModel} />
                <EffortChip agent={agent} model={model} effort={effort} disabled={busy && sessionId !== null} onChoose={chooseEffort} />
              </>
            }
          />
        )}
      </div>
      <ApprovalSheet approval={sheetTarget} agentName={agentName} open={sheetTarget !== null} onClose={() => setSheetApproval(null)} onStale={resync} continuation={continuation} />
      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>
    </div>
  );
}
