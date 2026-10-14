import type { Agent, MessageSearchHit, Project, Session } from '@agent-studio/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, ChevronLeft, ChevronsUpDown, MessagesSquare, PanelLeftClose, Pencil, Pin, PinOff, Search, SquarePen, Trash2, X } from 'lucide-react';
import { type ReactNode, type Ref, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { useStaleness } from '@/data/connection';
import { describeError } from '@/data/errors';
import { useUser } from '@/data/session';
import { type MessageKey, useT } from '@/i18n';
import { useCanHover, usePageVisible } from '@/platform/media';
import type { BackAction } from '@/shell/back';
import { ActivityMark, Badge, Button, DelayedSkeleton, EmptyState, ErrorState, Glyph, List, ListRow, Menu, type RowAction, SegmentedControl, Skeleton, Spinner, StaleNotice, confirm, isImeConfirm, toTint, toast } from '@/ui';
import { projectSymbol } from '@/features/home/icons';
import { workbenchApi } from '../api';
import { AgentMark, ShortcutHint, shortcutText } from '../chat/parts';
import type { ListScope } from '../device';
import { type SectionKind, groupSessions, projectMark, projectMarks, rowTimeStyle, sessionMark, sortTime } from './grouping';
import { type SessionListParams, flattenSessions, removeSession, upsertSession, useActivity, useSessionList, workbenchKeys } from './queries';

export interface SessionListHandle {
  focusSearch(): void;
}

export interface SessionListProps {
  scope: ListScope;
  onScopeChange: (scope: ListScope) => void;
  project: Project | null;
  projects: readonly Project[];
  agents: readonly Agent[];
  /** The conversation on screen (its row is marked, and its own marks are not shown). */
  openSessionId: string | null;
  /** The open conversation is one that has not been sent yet. */
  newChatOpen: boolean;
  /** The unsent conversation holds text. */
  newChatHasDraft: boolean;
  onOpenSession: (session: Pick<Session, 'id' | 'projectId'>, seq?: number) => void;
  onNewChat: () => void;
  onChooseProject: (projectId: string) => void;
  /** Hide the docked column, or close the sheet on a phone. */
  onHide: () => void;
  presentation: 'docked' | 'sheet';
  back: BackAction | null;
  ref?: Ref<SessionListHandle>;
}

const SECTION_TITLES: Record<SectionKind, MessageKey> = {
  running: 'workbench.list.running',
  pinned: 'workbench.list.pinned',
  today: 'workbench.list.today',
  yesterday: 'workbench.list.yesterday',
  week: 'workbench.list.week',
  earlier: 'workbench.list.earlier',
};

/** Re-renders now and then so that "today" turns into "yesterday" without a reload. */
function useNow(intervalMs: number): number {
  const visible = usePageVisible();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!visible) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [visible, intervalMs]);
  return now;
}

function RenameField({ initial, onDone }: { initial: string; onDone: (title: string | null) => void }) {
  const t = useT();
  const [value, setValue] = useState(initial);
  const field = useRef<HTMLInputElement>(null);
  const settled = useRef(false);
  useEffect(() => field.current?.select(), []);
  const finish = (title: string | null) => {
    if (settled.current) return;
    settled.current = true;
    onDone(title);
  };
  return (
    <input
      ref={field}
      className="wb-list__rename"
      value={value}
      maxLength={200}
      aria-label={t('workbench.session.renameLabel')}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => finish(value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !isImeConfirm(event)) {
          event.preventDefault();
          finish(value);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          finish(null);
        }
      }}
    />
  );
}

interface RowProps {
  session: Session;
  open: boolean;
  now: number;
  agents: readonly Agent[];
  /** The project's name, where the list spans projects. */
  projectName: string | null;
  archivedView: boolean;
  onOpen: () => void;
}

function SessionRow({ session, open, now, agents, projectName, archivedView, onOpen }: RowProps) {
  const t = useT();
  const user = useUser();
  const queryClient = useQueryClient();
  const [renaming, setRenaming] = useState(false);
  const mine = session.userId === user?.id;
  const mark = sessionMark(session, { onScreen: open });
  const agent = agents.find((entry) => entry.id === session.agentId);
  const when = sortTime(session);

  const change = async (changes: Parameters<typeof workbenchApi.updateSession>[1]): Promise<Session | null> => {
    try {
      const updated = await workbenchApi.updateSession(session.id, changes);
      upsertSession(queryClient, updated);
      return updated;
    } catch (error) {
      toast.error(describeError(error, t));
      return null;
    }
  };

  const archive = async () => {
    if (!(await change({ archived: true }))) return;
    toast.show({
      title: t('workbench.session.archived', { title: session.title }),
      action: { label: t('common.undo'), onSelect: () => void change({ archived: false }) },
    });
  };

  const remove = async () => {
    const confirmed = await confirm({
      title: t('workbench.session.delete.title', { title: session.title }),
      message: archivedView ? t('workbench.session.delete.message') : t('workbench.session.delete.messageWithArchive'),
      confirmLabel: t('workbench.session.delete'),
      tone: 'danger',
    });
    if (!confirmed) return;
    try {
      await workbenchApi.deleteSession(session.id);
      removeSession(queryClient, session.id);
    } catch (error) {
      toast.error(describeError(error, t));
    }
  };

  const actions: RowAction[] = [];
  if (mine && !archivedView) {
    actions.push(
      session.pinned
        ? { id: 'unpin', label: t('workbench.session.unpin'), icon: <PinOff size={18} />, onSelect: () => void change({ pinned: false }) }
        : { id: 'pin', label: t('workbench.session.pin'), icon: <Pin size={18} />, tone: 'accent', onSelect: () => void change({ pinned: true }) },
      { id: 'rename', label: t('workbench.session.rename'), icon: <Pencil size={18} />, onSelect: () => setRenaming(true) },
    );
    // A session with a run in progress cannot be archived: the server would refuse, so it is not offered.
    if (session.activeRunId === null) actions.push({ id: 'archive', label: t('workbench.session.archive'), icon: <Archive size={18} />, tone: 'warning', onSelect: () => void archive() });
  }
  if (mine && archivedView) actions.push({ id: 'restore', label: t('workbench.session.restore'), icon: <ArchiveRestore size={18} />, tone: 'accent', onSelect: () => void change({ archived: false }) });
  actions.push({ id: 'delete', label: t('workbench.session.delete'), icon: <Trash2 size={18} />, tone: 'danger', onSelect: () => void remove() });

  const leading = (
    <span className="wb-list__agent">
      <AgentMark agentId={session.agentId} size={30} />
      {mark && mark !== 'running' && <ActivityMark kind={mark} className="wb-list__mark" />}
    </span>
  );
  // Second line: where it is (or who answers), what is unsent, and when the user last spoke in it.
  const subtitle = (
    <span className="wb-list__subtitle">
      <span className="u-truncate">{projectName ?? agent?.displayName ?? session.agentId}</span>
      {session.hasDraft && !open && <Badge tone="accent">{t('workbench.session.draft')}</Badge>}
      {session.pinned && (session.activeRunId !== null || archivedView) && <Pin size={12} aria-label={t('workbench.list.pinned')} />}
      {mark !== 'running' && <time className="wb-list__time u-tabular">{t.date(when, rowTimeStyle(when, now))}</time>}
    </span>
  );

  if (renaming) {
    return (
      <ListRow
        className="wb-list__row"
        leading={leading}
        title={
          <RenameField
            initial={session.title}
            onDone={(next) => {
              setRenaming(false);
              const trimmed = next?.trim() ?? '';
              if (trimmed !== '' && trimmed !== session.title) void change({ title: trimmed });
            }}
          />
        }
      />
    );
  }

  return (
    <ListRow
      className="wb-list__row"
      leading={leading}
      title={<span className="wb-list__title">{session.title}</span>}
      subtitle={subtitle}
      trailing={mark === 'running' ? <ActivityMark kind="running" /> : undefined}
      selected={open || undefined}
      onPress={onOpen}
      actions={actions}
      actionsLabel={t('workbench.session.actions', { title: session.title })}
    />
  );
}

function ProjectSwitcher({ project, projects, openSessionId, onChoose }: { project: Project | null; projects: readonly Project[]; openSessionId: string | null; onChoose: (projectId: string) => void }) {
  const t = useT();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const activity = useActivity();
  const marks = useMemo(() => projectMarks(activity.data, openSessionId), [activity.data, openSessionId]);
  if (!project) return null;
  // Closed, the switcher only says that something is going on *elsewhere*.
  const elsewhere = (() => {
    let attention = false;
    let unseen = false;
    for (const [projectId, entry] of marks) {
      if (projectId === project.id) continue;
      if (entry.attention > 0) attention = true;
      if (entry.unseen > 0) unseen = true;
    }
    return attention ? ('attention' as const) : unseen ? ('unseen' as const) : null;
  })();
  const Icon = projectSymbol(project.icon.symbol);
  return (
    <>
      <button ref={anchor} type="button" className="wb-switcher" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} aria-label={t('workbench.project.switch', { project: project.name })}>
        <Glyph icon={<Icon size={17} />} tint={toTint(project.icon.color)} size={28} />
        <span className="wb-switcher__name u-truncate">{project.name}</span>
        {elsewhere && <ActivityMark kind={elsewhere} label={elsewhere === 'attention' ? t('workbench.project.elsewhereAttention') : t('workbench.project.elsewhereUnseen')} />}
        <ChevronsUpDown size={16} aria-hidden="true" />
      </button>
      <Menu
        open={open}
        onClose={() => setOpen(false)}
        anchor={anchor}
        label={t('workbench.project.choose')}
        items={projects.map((entry) => {
          const EntryIcon = projectSymbol(entry.icon.symbol);
          const mark = projectMark(marks.get(entry.id));
          return {
            id: entry.id,
            label: entry.name,
            ...(mark ? { hint: mark === 'attention' ? t('activity.attention') : mark === 'running' ? t('activity.running') : t('activity.unseen') } : {}),
            icon: <EntryIcon size={18} />,
            checked: entry.id === project.id,
            onSelect: () => entry.id !== project.id && onChoose(entry.id),
          };
        })}
      />
    </>
  );
}

function Highlighted({ hit }: { hit: MessageSearchHit }) {
  if (hit.matchStart < 0 || hit.matchLength === 0) return <>{hit.snippet}</>;
  return (
    <>
      {hit.snippet.slice(0, hit.matchStart)}
      <mark>{hit.snippet.slice(hit.matchStart, hit.matchStart + hit.matchLength)}</mark>
      {hit.snippet.slice(hit.matchStart + hit.matchLength)}
    </>
  );
}

/**
 * The conversations beside the chat: this project's, or everyone's. Running
 * ones first, then pinned, then by the day the user last spoke in them; kept
 * current from the live connection, so two devices show the same list.
 */
export function SessionList({ scope, onScopeChange, project, projects, agents, openSessionId, newChatOpen, newChatHasDraft, onOpenSession, onNewChat, onChooseProject, onHide, presentation, back, ref }: SessionListProps) {
  const t = useT();
  const canHover = useCanHover();
  const searchField = useRef<HTMLInputElement>(null);
  const [typed, setTyped] = useState('');
  const [query, setQuery] = useState('');
  const [archivedView, setArchivedView] = useState(false);
  const now = useNow(30_000);

  useImperativeHandle(ref, () => ({ focusSearch: () => searchField.current?.focus() }), []);

  // The list is asked again a moment after the last key press, not on every one.
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(typed.trim()), 220);
    return () => window.clearTimeout(timer);
  }, [typed]);

  const projectId = scope === 'project' ? (project?.id ?? null) : null;
  const params: SessionListParams = useMemo(() => ({ projectId, archived: archivedView ? 'only' : 'exclude', q: query }), [projectId, archivedView, query]);
  const enabled = scope === 'all' || projectId !== null;
  const list = useSessionList(params, { enabled });
  const archived = useSessionList({ projectId, archived: 'only', q: '' }, { enabled: enabled && !archivedView });
  const staleness = useStaleness(list);
  const sessions = useMemo(() => flattenSessions(list.data), [list.data]);
  const sections = useMemo(() => (archivedView ? [] : groupSessions(sessions, now)), [archivedView, sessions, now]);
  const archivedCount = flattenSessions(archived.data).length;
  const projectNames = useMemo(() => new Map(projects.map((entry) => [entry.id, entry.name])), [projects]);

  const hits = useQuery({
    queryKey: workbenchKeys.search(query, projectId),
    queryFn: ({ signal }) => workbenchApi.search(query, projectId, signal).then((result) => result.hits),
    enabled: enabled && query.length >= 2 && !archivedView,
    staleTime: 15_000,
  });

  const open = useCallback((session: Pick<Session, 'id' | 'projectId'>, seq?: number) => onOpenSession(session, seq), [onOpenSession]);
  const row = (session: Session) => (
    <SessionRow
      key={session.id}
      session={session}
      open={session.id === openSessionId}
      now={now}
      agents={agents}
      projectName={scope === 'all' && session.projectId ? (projectNames.get(session.projectId) ?? null) : null}
      archivedView={archivedView}
      onOpen={() => open(session)}
    />
  );

  let body: ReactNode;
  if (!enabled) {
    body = null;
  } else if (list.isPending) {
    body = (
      <DelayedSkeleton label={t('workbench.list.loading')}>
        <div className="wb-list__skeleton">
          {[0, 1, 2, 3, 4].map((index) => (
            <div key={index}>
              <Skeleton width={30} height={30} radius={10} />
              <Skeleton width={`${72 - index * 9}%`} height={12} />
            </div>
          ))}
        </div>
      </DelayedSkeleton>
    );
  } else if (!list.data) {
    body = <ErrorState compact error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />;
  } else if (sessions.length === 0 && (hits.data?.length ?? 0) === 0) {
    body = query ? (
      <EmptyState
        compact
        icon={<Search size={26} />}
        title={t('workbench.list.noMatch', { query })}
        action={
          <>
            <Button variant="tinted" onClick={() => setTyped('')}>
              {t('workbench.list.clearSearch')}
            </Button>
            {list.hasNextPage && (
              <Button variant="plain" onClick={() => void list.fetchNextPage()} loading={list.isFetchingNextPage}>
                {t('workbench.list.loadEarlier')}
              </Button>
            )}
          </>
        }
      />
    ) : archivedView ? (
      <EmptyState compact icon={<Archive size={26} />} title={t('workbench.list.noArchived')} />
    ) : (
      <EmptyState compact icon={<MessagesSquare size={26} />} title={t('workbench.list.empty')} description={t('workbench.list.emptyHint')} />
    );
  } else {
    body = (
      <>
        {staleness.stale && <StaleNotice since={staleness.since} />}
        {archivedView ? <List aria-label={t('workbench.list.archived')}>{sessions.map(row)}</List> : sections.map((section) => (
          <List key={section.kind} header={section.kind === 'running' ? t('workbench.list.runningCount', { count: t.number(section.sessions.length) }) : t(SECTION_TITLES[section.kind])}>
            {section.sessions.map(row)}
          </List>
        ))}
        {hits.data && hits.data.length > 0 && (
          <List header={t('workbench.list.inMessages')}>
            {hits.data.map((hit) => (
              <ListRow
                key={`${hit.sessionId}:${hit.seq}`}
                className="wb-list__row wb-list__hit"
                title={<span className="wb-list__title">{hit.title}</span>}
                subtitle={
                  <span className="wb-list__snippet">
                    <Highlighted hit={hit} />
                  </span>
                }
                onPress={() => open({ id: hit.sessionId, projectId: hit.projectId }, hit.seq)}
              />
            ))}
          </List>
        )}
        {list.hasNextPage && (
          <div className="wb-list__more">
            {list.isFetchNextPageError && <p role="alert">{t('workbench.list.moreFailed', { reason: describeError(list.error, t) })}</p>}
            <Button variant="plain" block onClick={() => void list.fetchNextPage()} loading={list.isFetchingNextPage} loadingLabel={t('common.loading')}>
              {list.isFetchNextPageError ? t('common.retry') : t('workbench.list.loadEarlier')}
            </Button>
          </div>
        )}
      </>
    );
  }

  return (
    <div className="wb-list" data-presentation={presentation}>
      <div className="wb-list__head">
        {back ? (
          <button type="button" className="wb-list__back" onClick={back.go} aria-label={back.accessibleLabel}>
            <ChevronLeft size={22} strokeWidth={2.2} aria-hidden="true" />
            <span className="u-truncate">{back.label}</span>
          </button>
        ) : (
          <span />
        )}
        <button type="button" className="wb-bar-button" onClick={onHide} aria-label={presentation === 'sheet' ? t('common.close') : t('workbench.list.hide')} title={presentation === 'sheet' ? t('common.close') : t('workbench.list.hide')}>
          {presentation === 'sheet' ? <X size={21} aria-hidden="true" /> : <PanelLeftClose size={21} aria-hidden="true" />}
        </button>
      </div>
      <div className="wb-list__tools">
        <SegmentedControl
          label={t('workbench.scope.label')}
          value={scope}
          onChange={onScopeChange}
          options={[
            { value: 'project', label: t('workbench.scope.project') },
            { value: 'all', label: t('workbench.scope.all') },
          ]}
        />
        {scope === 'project' && <ProjectSwitcher project={project} projects={projects} openSessionId={openSessionId} onChoose={onChooseProject} />}
        {/* Its shortcut is too long to sit beside the words in a narrow column: it is in the tooltip instead. */}
        <button
          type="button"
          className="wb-list__new"
          onClick={onNewChat}
          aria-current={newChatOpen ? 'page' : undefined}
          aria-keyshortcuts="Control+Shift+O Meta+Shift+O"
          title={canHover ? `${t('workbench.new')} (${shortcutText(['mod', 'shift', 'o'])})` : undefined}
          data-autofocus=""
        >
          <SquarePen size={18} aria-hidden="true" />
          <span>{t('workbench.new')}</span>
          {newChatHasDraft && !newChatOpen && <Badge tone="accent">{t('workbench.session.draft')}</Badge>}
        </button>
        <div className="wb-list__search">
          <Search size={17} aria-hidden="true" />
          <input
            ref={searchField}
            type="search"
            value={typed}
            placeholder={archivedView ? t('workbench.list.searchArchived') : t('workbench.list.search')}
            aria-label={t('workbench.list.search')}
            enterKeyHint="search"
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return;
              // Escape clears the search first; only an empty field lets it through.
              if (typed !== '') {
                event.preventDefault();
                event.stopPropagation();
                setTyped('');
              }
            }}
          />
          {typed === '' ? <ShortcutHint keys={['mod', 'k']} /> : list.isFetching ? <Spinner size={15} /> : null}
          {typed !== '' && (
            <button type="button" className="wb-chip-close" onClick={() => setTyped('')} aria-label={t('workbench.list.clearSearch')}>
              <X size={15} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
      <div className="wb-list__scroll u-scroll">
        {archivedView && (
          <button type="button" className="wb-list__section-back" onClick={() => setArchivedView(false)}>
            <ChevronLeft size={18} aria-hidden="true" />
            {t('workbench.list.archivedBack')}
          </button>
        )}
        {body}
        {!archivedView && archivedCount > 0 && (
          <List>
            <ListRow leading={<Archive size={18} />} title={t('workbench.list.archived')} value={t.number(archivedCount)} chevron onPress={() => setArchivedView(true)} />
          </List>
        )}
      </div>
    </div>
  );
}
