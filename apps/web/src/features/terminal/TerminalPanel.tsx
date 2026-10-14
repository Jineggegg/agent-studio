import { type Project, TERMINAL_EVENTS, type TerminalSession, userTopic } from '@agent-studio/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AArrowDown, AArrowUp, Ellipsis, Pencil, Plus, SquareTerminal, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isApiError } from '@/data/api';
import { onSessionEnd } from '@/data/auth';
import { useRealtimeTopic } from '@/data/realtime';
import { useUser } from '@/data/session';
import { type Problem, ProblemNote, Stage, problemOf, wasCancelled } from '@/features/projects/tools/kit';
import type { InspectorPanelProps } from '@/features/workbench/inspector/registry';
import { useT } from '@/i18n';
import { useLayoutClass } from '@/platform/layout';
import { useCanHover } from '@/platform/media';
import { Button, EmptyState, ErrorState, Form, IconButton, LoadingRow, MenuButton, Sheet, TextField, confirm, toast } from '@/ui';
import { terminalApi, terminalKeys } from './api';
import { TerminalView, type TerminalViewHandle } from './TerminalView';
import { FONT_SIZE, clampFontSize, readFontSize, saveFontSize } from './keys';
import { noteTerminalCapability } from './usable';

const ACTIVE_PREFIX = 'studio.terminal.active.';
const readActive = (projectId: string): string | null => {
  try {
    return window.localStorage.getItem(ACTIVE_PREFIX + projectId);
  } catch {
    return null;
  }
};
const saveActive = (projectId: string, sessionId: string | null): void => {
  try {
    if (sessionId) window.localStorage.setItem(ACTIVE_PREFIX + projectId, sessionId);
    else window.localStorage.removeItem(ACTIVE_PREFIX + projectId);
  } catch {
    /* this device will not remember which terminal was on show */
  }
};
onSessionEnd(() => {
  try {
    for (const key of Object.keys(window.localStorage)) if (key.startsWith(ACTIVE_PREFIX)) window.localStorage.removeItem(key);
  } catch {
    /* nothing to erase */
  }
});

function RenameSheet({ session, onClose, onRenamed }: { session: TerminalSession | null; onClose: () => void; onRenamed: (session: TerminalSession) => void }) {
  const t = useT();
  const [title, setTitle] = useState('');
  const [problem, setProblem] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  const sessionId = session?.id;
  useEffect(() => {
    if (session) setTitle(session.title);
    setProblem(undefined);
    // When the sheet opens for another terminal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);
  const save = async () => {
    if (!session || saving) return;
    const wanted = title.trim();
    if (wanted === '') return setProblem(t('terminal.rename.missing'));
    setSaving(true);
    try {
      onRenamed(await terminalApi.rename(session.id, wanted));
      onClose();
    } catch (error) {
      if (!wasCancelled(error)) setProblem(problemOf(error, t).text);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Sheet
      open={session !== null}
      onClose={onClose}
      title={t('terminal.rename.title')}
      size="sm"
      dismissible={!saving}
      leading={
        <Button variant="plain" onClick={onClose} disabled={saving}>
          {t('common.cancel')}
        </Button>
      }
      trailing={
        <Button variant="plain" onClick={() => void save()} loading={saving}>
          {t('common.save')}
        </Button>
      }
    >
      <Form onSubmit={() => void save()}>
        <TextField label={t('terminal.rename.label')} value={title} onChange={setTitle} error={problem} maxLength={80} data-autofocus="" enterKeyHint="done" autoComplete="off" />
        <button type="submit" hidden />
      </Form>
    </Sheet>
  );
}

/** One project's terminals: shells on the server that outlive this page, each in its own tab. */
function ProjectTerminals({ project, active, request, onRequestHandled }: InspectorPanelProps & { project: Project }) {
  const t = useT();
  const user = useUser();
  const layout = useLayoutClass();
  const canHover = useCanHover();
  const queryClient = useQueryClient();
  const capability = useQuery({ queryKey: terminalKeys.capability, queryFn: ({ signal }) => terminalApi.capability(signal), staleTime: 20_000 });
  useEffect(() => {
    if (capability.data) noteTerminalCapability(capability.data);
  }, [capability.data]);
  const available = capability.data?.available === true;
  const sessions = useQuery({ queryKey: terminalKeys.sessions(project.id), queryFn: ({ signal }) => terminalApi.sessions(project.id, signal), enabled: available, staleTime: 5_000 });

  const [activeId, setActiveId] = useState<string | null>(() => readActive(project.id));
  /** Sessions whose view has been shown: they stay mounted, and connected, behind the one on show. */
  const [opened, setOpened] = useState<readonly string[]>([]);
  const [creating, setCreating] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [renaming, setRenaming] = useState<TerminalSession | null>(null);
  const [fontSize, setFontSize] = useState(() => readFontSize(layout === 'phone'));
  const views = useRef(new Map<string, TerminalViewHandle>());
  const pendingCommand = useRef<{ sessionId: string; text: string } | null>(null);
  const autoStarted = useRef(false);

  const list = useMemo(() => sessions.data ?? [], [sessions.data]);
  // An ended terminal stays on show only for as long as it is the one being looked at.
  const tabs = useMemo(() => list.filter((session) => session.alive || session.id === activeId).sort((a, b) => a.createdAt - b.createdAt), [list, activeId]);
  const current = tabs.find((session) => session.id === activeId) ?? null;

  const invalidate = useCallback(() => void queryClient.invalidateQueries({ queryKey: terminalKeys.sessions(project.id) }), [queryClient, project.id]);
  useRealtimeTopic(user ? userTopic(user.id) : null, (event) => {
    if ((Object.values(TERMINAL_EVENTS) as string[]).includes(event.type)) invalidate();
  });

  const patch = useCallback(
    (session: TerminalSession) => {
      queryClient.setQueryData<TerminalSession[]>(terminalKeys.sessions(project.id), (existing) => {
        if (!existing) return [session];
        return existing.some((entry) => entry.id === session.id) ? existing.map((entry) => (entry.id === session.id ? session : entry)) : [...existing, session];
      });
    },
    [queryClient, project.id],
  );

  const show = useCallback(
    (sessionId: string | null) => {
      setActiveId(sessionId);
      saveActive(project.id, sessionId);
      if (sessionId) setOpened((ids) => (ids.includes(sessionId) ? ids : [...ids, sessionId]));
    },
    [project.id],
  );

  // What is on show follows what exists: the remembered one, else the newest that is running.
  useEffect(() => {
    if (!sessions.data) return;
    const alive = sessions.data.filter((session) => session.alive);
    if (activeId && sessions.data.some((session) => session.id === activeId)) {
      if (!opened.includes(activeId)) setOpened((ids) => [...ids, activeId]);
      return;
    }
    const newest = alive.sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0];
    show(newest ? newest.id : null);
  }, [sessions.data, activeId, opened, show]);

  const create = useCallback(async (): Promise<TerminalSession | null> => {
    if (creating) return null;
    setCreating(true);
    setProblem(null);
    try {
      const session = await terminalApi.create({ projectId: project.id });
      patch(session);
      show(session.id);
      void queryClient.invalidateQueries({ queryKey: terminalKeys.capability });
      return session;
    } catch (error) {
      if (!wasCancelled(error)) setProblem(problemOf(error, t));
      // Refused for being turned off or not allowed: the capability report is out of date.
      if (isApiError(error) && error.status === 403) void queryClient.invalidateQueries({ queryKey: terminalKeys.capability });
      return null;
    } finally {
      setCreating(false);
    }
  }, [creating, project.id, patch, show, queryClient, t]);

  // The first visit starts a shell by itself — unless that would put a password prompt in front of someone who only looked.
  useEffect(() => {
    if (!active || !available || !sessions.data || autoStarted.current) return;
    if (sessions.data.some((session) => session.alive)) {
      autoStarted.current = true;
      return;
    }
    if (capability.data?.needsReauth) return;
    autoStarted.current = true;
    void create();
  }, [active, available, sessions.data, capability.data?.needsReauth, create]);

  const close = useCallback(
    async (session: TerminalSession) => {
      if (session.alive) {
        const agreed = await confirm({
          title: t('terminal.close.title', { title: session.title }),
          message: t('terminal.close.message'),
          confirmLabel: t('terminal.close.confirm'),
          tone: 'danger',
        });
        if (!agreed) return;
      }
      try {
        await terminalApi.close(session.id);
      } catch (error) {
        // Already gone is what was wanted.
        if (!(isApiError(error) && error.gone) && !wasCancelled(error)) return setProblem(problemOf(error, t));
      }
      views.current.delete(session.id);
      setOpened((ids) => ids.filter((id) => id !== session.id));
      queryClient.setQueryData<TerminalSession[]>(terminalKeys.sessions(project.id), (existing) => existing?.filter((entry) => entry.id !== session.id));
      if (activeId === session.id) {
        const others = tabs.filter((entry) => entry.id !== session.id && entry.alive);
        show(others[others.length - 1]?.id ?? null);
      }
      invalidate();
    },
    [activeId, tabs, show, invalidate, queryClient, project.id, t],
  );

  // ---- a command sent over from the conversation ----------------------------------------------

  const deliver = useCallback(async () => {
    const pending = pendingCommand.current;
    if (!pending) return;
    const view = views.current.get(pending.sessionId);
    if (!view) return;
    pendingCommand.current = null;
    // A brand-new shell is still starting: typing before its prompt would be lost in its start-up.
    if (!(await view.whenReady(12_000))) return void toast.error(t('terminal.type.notReady'));
    try {
      const typed = await terminalApi.type(pending.sessionId, pending.text);
      view.focus();
      toast.info(t('terminal.type.done'), { ...(typed.removed > 0 ? { detail: t('terminal.type.removed', { count: typed.removed }) } : {}), id: 'terminal-typed' });
    } catch (error) {
      if (!wasCancelled(error)) setProblem(problemOf(error, t));
    }
  }, [t]);

  useEffect(() => {
    if (!request) return;
    if (request.type === 'run-command') {
      const text = request.text;
      void (async () => {
        const target = current?.alive ? current : (tabs.find((session) => session.alive) ?? (await create()));
        if (!target) return;
        show(target.id);
        pendingCommand.current = { sessionId: target.id, text };
        void deliver();
      })();
    }
    onRequestHandled();
    // Each request is handled once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  const changeFont = useCallback((size: number) => {
    const next = clampFontSize(size);
    setFontSize(next);
    saveFontSize(next);
  }, []);

  // ---- what to draw ----------------------------------------------------------------------------

  if (capability.isPending) {
    return (
      <div className="pt-panel">
        <LoadingRow label={t('common.loading')} />
      </div>
    );
  }
  if (!capability.data) {
    return (
      <div className="pt-panel">
        <Stage>
          <ErrorState error={capability.error} onRetry={() => void capability.refetch()} retrying={capability.isFetching} />
        </Stage>
      </div>
    );
  }
  if (!capability.data.available) {
    const code = capability.data.reason?.code ?? 'disabled';
    return (
      <div className="pt-panel">
        <Stage>
          <EmptyState
            icon={<SquareTerminal size={28} />}
            title={t(`terminal.unavailable.${code}.title`)}
            description={t(`terminal.unavailable.${code}.text`)}
            action={
              <Button variant="plain" onClick={() => void capability.refetch()} loading={capability.isFetching}>
                {t('terminal.unavailable.recheck')}
              </Button>
            }
          />
        </Stage>
      </div>
    );
  }

  const keyBar = layout === 'phone' || (layout === 'tablet' && !canHover);
  const shell = capability.data.shell ?? t('terminal.shell');

  return (
    <div className="pt-panel term-panel">
      <header className="pt-toolbar term-panel__bar">
        <div className="term-tabs" role="tablist" aria-label={t('terminal.tabs.label')}>
          {tabs.map((session) => (
            <button
              key={session.id}
              type="button"
              role="tab"
              className="term-tab"
              aria-selected={session.id === activeId}
              data-ended={!session.alive || undefined}
              onClick={() => show(session.id)}
              title={session.directory ?? undefined}
            >
              <span className="u-truncate">{session.title}</span>
              {!session.alive && <span className="term-tab__ended">{t('terminal.tab.ended')}</span>}
            </button>
          ))}
        </div>
        <IconButton label={t('terminal.new')} icon={<Plus size={20} />} tone="secondary" busy={creating} disabled={creating} onClick={() => void create()} />
        <MenuButton
          label={t('terminal.more')}
          icon={<Ellipsis size={20} />}
          items={[
            ...(current
              ? [
                  ...(current.alive ? [{ id: 'rename', label: t('terminal.rename'), icon: <Pencil size={18} />, onSelect: () => setRenaming(current) }] : []),
                  { id: 'close', label: current.alive ? t('terminal.close') : t('terminal.remove'), icon: <X size={18} />, tone: 'danger' as const, onSelect: () => void close(current) },
                  { separator: true as const, id: 'separator' },
                ]
              : []),
            { id: 'larger', label: t('terminal.font.larger'), icon: <AArrowUp size={18} />, disabled: fontSize >= FONT_SIZE.max, onSelect: () => changeFont(fontSize + 1) },
            { id: 'smaller', label: t('terminal.font.smaller'), icon: <AArrowDown size={18} />, disabled: fontSize <= FONT_SIZE.min, onSelect: () => changeFont(fontSize - 1) },
          ]}
        />
      </header>

      {problem && <ProblemNote problem={problem} onDismiss={() => setProblem(null)} />}

      <div className="term-panel__body">
        {sessions.isPending ? (
          <LoadingRow label={t('terminal.loading')} />
        ) : sessions.isError && !sessions.data ? (
          <Stage>
            <ErrorState error={sessions.error} onRetry={() => void sessions.refetch()} retrying={sessions.isFetching} />
          </Stage>
        ) : tabs.length === 0 ? (
          <Stage>
            <EmptyState
              icon={<SquareTerminal size={28} />}
              title={t('terminal.empty.title')}
              description={
                <>
                  {t('terminal.empty.text', { shell, project: project.name })}
                  {capability.data.needsReauth && (
                    <>
                      <br />
                      {t('terminal.empty.reauth')}
                    </>
                  )}
                </>
              }
              action={
                <Button variant="primary" icon={<SquareTerminal size={18} />} loading={creating} onClick={() => void create()}>
                  {t('terminal.empty.action')}
                </Button>
              }
            />
          </Stage>
        ) : (
          opened
            .filter((id) => tabs.some((session) => session.id === id))
            .map((id) => (
              <div key={id} className="term-panel__view" hidden={id !== activeId} role="tabpanel">
                <TerminalView
                  ref={(handle) => {
                    if (handle) {
                      views.current.set(id, handle);
                      void deliver();
                    } else views.current.delete(id);
                  }}
                  sessionId={id}
                  visible={active && id === activeId}
                  keyBar={keyBar}
                  fontSize={fontSize}
                  onFontSize={changeFont}
                  onSession={patch}
                  onReplace={() => void create()}
                  onUnavailable={() => void capability.refetch()}
                />
              </div>
            ))
        )}
      </div>
      <RenameSheet session={renaming} onClose={() => setRenaming(null)} onRenamed={patch} />
    </div>
  );
}

/** The inspector's Terminal panel. It stays mounted once opened, so a shell keeps its screen while another tool is on show. */
export default function TerminalPanel(props: InspectorPanelProps) {
  if (!props.project) return null;
  return <ProjectTerminals key={props.project.id} {...props} project={props.project} />;
}
