import { AUTOMATION_EVENT, type Automation, automationChangedSchema, projectTopic } from '@agent-studio/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, Bot, CalendarClock, History, Pencil, Play, Plus, RefreshCw, Trash2, Zap } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { isApiError } from '@/data/api';
import { useConnectionState, useStaleness } from '@/data/connection';
import { describeError } from '@/data/errors';
import { useProjects, useUpdateProject } from '@/data/projects';
import { useOnReconnect, useRealtimeTopic } from '@/data/realtime';
import { useIsOwner } from '@/data/session';
import { useNow } from '@/features/inbox/useNow';
import { PushStatus } from '@/features/notifications/PushStatus';
import { usePushSetup } from '@/features/notifications/state';
import { useAgents } from '@/features/workbench/agents';
import { workbenchPaths } from '@/features/workbench/routes';
import { useT } from '@/i18n';
import { Screen } from '@/shell/Screen';
import { useScreenActive } from '@/shell/ScreenStack';
import { Badge, Banner, Button, DelayedSkeleton, EmptyState, ErrorState, Glyph, IconButton, MenuButton, Skeleton, Spinner, StaleNotice, Switch, type Tint, confirm, progress, toast } from '@/ui';
import { automationApi, automationKeys } from './api';
import { AutomationSheet } from './AutomationSheet';
import { HistorySheet } from './HistorySheet';
import { deviceTimeZone } from './time';
import { MODE, OUTCOME, REASON, actionText, executionTime, triggerText, whenText } from './words';
import './automation.css';

function kindMark(automation: Automation): { icon: ReactNode; tint: Tint } {
  if (automation.trigger.type === 'event') return { icon: <Zap size={17} />, tint: 'orange' };
  if (automation.action.type === 'agent-run') return { icon: <Bot size={17} />, tint: 'purple' };
  return { icon: <BellRing size={17} />, tint: 'blue' };
}

function AutomationCard({
  automation,
  busy,
  disabled,
  agentName,
  now,
  onToggle,
  onRun,
  onEdit,
  onHistory,
  onDelete,
}: {
  automation: Automation;
  busy: 'toggle' | 'run' | 'delete' | null;
  disabled: boolean;
  agentName: (id: string) => string;
  now: number;
  onToggle: (on: boolean) => void;
  onRun: () => void;
  onEdit: () => void;
  onHistory: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  const device = deviceTimeZone();
  const mark = kindMark(automation);
  const last = automation.lastRun;
  const outcome = last ? OUTCOME[last.outcome] : null;
  const locked = busy !== null || disabled;
  const next =
    automation.state === 'scheduled' && automation.nextRunAt !== null
      ? t('automation.next', { when: whenText(automation.nextRunAt, now, t) })
      : automation.state === 'waiting'
        ? t('automation.waiting')
        : automation.disabledReason === 'ran-once'
          ? t('automation.ranOnce')
          : automation.disabledReason === 'access-lost'
            ? t('automation.accessLost')
            : t('automation.off');

  return (
    <li className="aut-card" data-state={automation.state}>
      <div className="aut-card__head">
        <Glyph icon={mark.icon} tint={mark.tint} size={34} />
        <div className="aut-card__title">
          <h3>{automation.name}</h3>
          <p className="aut-card__trigger">{triggerText(automation.trigger, t, automation.timeZone === device ? null : automation.timeZone)}</p>
        </div>
        {automation.canManage ? (
          <Switch checked={automation.enabled} disabled={locked} onChange={onToggle} label={t('automation.toggle', { name: automation.name })} />
        ) : (
          <Badge tone={automation.enabled ? 'positive' : 'neutral'}>{automation.enabled ? t('automation.on') : t('automation.offShort')}</Badge>
        )}
      </div>
      <p className="aut-card__action">{actionText(automation.action, t, agentName)}</p>
      <p className="aut-card__next" data-state={automation.state}>
        {automation.running ? (
          <span className="aut-card__running">
            <Spinner size={13} />
            {t('automation.runningNow')}
          </span>
        ) : null}
        <span>{next}</span>
      </p>
      {last && outcome && (
        <div className="aut-card__last" data-tone={outcome.tone}>
          <p className="aut-card__last-line">
            <Badge tone={outcome.tone}>{t(outcome.label)}</Badge>
            <span>{t('automation.last', { when: whenText(executionTime(last), now, t) })}</span>
          </p>
          {last.summary !== '' && <p className="aut-card__summary">{last.summary}</p>}
          {last.reason && last.summary === '' && <p className="aut-card__summary">{t(REASON[last.reason])}</p>}
        </div>
      )}
      {automation.guard && (
        <p className="aut-card__guard" data-allowed={automation.guard.allowed || undefined}>
          {automation.guard.allowed
            ? t('automation.guard.short', { name: automation.guard.actsAs.displayName, mode: t(MODE[automation.guard.permissionMode]) })
            : t('automation.guard.wouldRefuse', { reason: t(REASON[automation.guard.refusal ?? 'error']) })}
        </p>
      )}
      <div className="aut-card__actions">
        {automation.canManage && (
          <Button size="sm" variant="tinted" icon={<Play size={15} />} loading={busy === 'run'} disabled={locked || automation.running} onClick={onRun}>
            {t('automation.runNow')}
          </Button>
        )}
        <Button size="sm" variant="neutral" icon={<History size={15} />} onClick={onHistory}>
          {t('automation.history.label')}
        </Button>
        {automation.canManage && (
          <MenuButton
            label={t('automation.more', { name: automation.name })}
            items={[
              { id: 'edit', label: t('automation.edit'), icon: <Pencil size={18} />, disabled: locked, onSelect: onEdit },
              { id: 'delete', label: t('automation.delete'), icon: <Trash2 size={18} />, tone: 'danger', disabled: locked, onSelect: onDelete },
            ]}
          />
        )}
      </div>
    </li>
  );
}

/**
 * A project's automations: the project's switch for unattended work (off by
 * default) with what it allows in plain words, whether reminders can reach
 * this device, and each automation — when it runs, what it does, how it
 * last went — with run now, history, edit and delete.
 */
export default function AutomationsScreen() {
  const t = useT();
  const navigate = useNavigate();
  const { projectId = '' } = useParams();
  const isOwner = useIsOwner();
  const active = useScreenActive();
  const connection = useConnectionState();
  const queryClient = useQueryClient();
  const projects = useProjects();
  const updateProject = useUpdateProject();
  const project = projects.data?.find((entry) => entry.id === projectId) ?? null;
  const agents = useAgents();
  const push = usePushSetup();
  const now = useNow(30_000, active);
  const [editing, setEditing] = useState<{ automation: Automation | null } | null>(null);
  const [history, setHistory] = useState<Automation | null>(null);
  const [busy, setBusy] = useState<{ id: string; kind: 'toggle' | 'run' | 'delete' } | null>(null);
  const [switching, setSwitching] = useState(false);

  const list = useQuery({
    queryKey: automationKeys.list(projectId),
    queryFn: ({ signal }) => automationApi.list(projectId, signal),
    enabled: active && projectId !== '',
    meta: { live: true },
    refetchInterval: (query) => (query.state.data?.automations.some((entry) => entry.running) ? 10_000 : false),
  });
  const options = useQuery({ queryKey: automationKeys.options(projectId), queryFn: ({ signal }) => automationApi.options(projectId, signal), enabled: active && projectId !== '', staleTime: 30_000 });
  const { stale, since } = useStaleness(list);

  useRealtimeTopic(projectId ? projectTopic(projectId) : null, (event) => {
    if (event.type !== AUTOMATION_EVENT.changed) return;
    const parsed = automationChangedSchema.safeParse(event.data);
    if (!parsed.success) return;
    void queryClient.invalidateQueries({ queryKey: automationKeys.list(projectId) });
    void queryClient.invalidateQueries({ queryKey: automationKeys.history(projectId, parsed.data.automationId) });
  });
  useOnReconnect(() => void queryClient.invalidateQueries({ queryKey: automationKeys.project(projectId) }));

  const agentName = (id: string) => options.data?.agents.find((agent) => agent.id === id)?.displayName ?? agents.data?.find((agent) => agent.id === id)?.displayName ?? id;
  const enabled = list.data?.enabled ?? project?.features.automation ?? false;
  const canCreate = (options.data?.canCreate ?? false) && enabled;
  const automations = list.data?.automations ?? [];
  const atLimit = list.data ? automations.length >= list.data.limit : false;
  const offline = connection === 'offline';

  const act = async (automation: Automation, kind: 'toggle' | 'run' | 'delete', work: () => Promise<void>) => {
    if (busy) return;
    setBusy({ id: automation.id, kind });
    try {
      await work();
    } catch (error) {
      toast.error(describeError(error, t));
    } finally {
      setBusy(null);
      void queryClient.invalidateQueries({ queryKey: automationKeys.list(projectId) });
    }
  };

  const toggle = (automation: Automation, on: boolean) =>
    act(automation, 'toggle', async () => {
      const updated = await automationApi.update(projectId, automation.id, { enabled: on });
      queryClient.setQueryData(automationKeys.list(projectId), (current: typeof list.data) => (current ? { ...current, automations: current.automations.map((entry) => (entry.id === updated.id ? updated : entry)) } : current));
    });

  const runNow = (automation: Automation) =>
    act(automation, 'run', async () => {
      const answer = await automationApi.run(projectId, automation.id);
      if (!answer.execution) {
        toast.info(t('automation.alreadyRunning', { name: automation.name }));
        return;
      }
      const outcome = OUTCOME[answer.execution.outcome];
      const summary = answer.execution.summary.length > 120 ? `${answer.execution.summary.slice(0, 119)}…` : answer.execution.summary;
      const show = outcome.tone === 'danger' ? toast.error : outcome.tone === 'warning' ? toast.warning : toast.success;
      show(t('automation.ranNow', { name: automation.name, outcome: t(outcome.label) }), summary ? { detail: summary } : undefined);
    });

  const remove = async (automation: Automation) => {
    const confirmed = await confirm({ title: t('automation.deleteTitle', { name: automation.name }), message: t('automation.deleteText'), confirmLabel: t('automation.delete'), tone: 'danger' });
    if (!confirmed) return;
    await act(automation, 'delete', async () => {
      await automationApi.remove(projectId, automation.id);
      toast.success(t('automation.deleted', { name: automation.name }));
    });
  };

  const setProjectSwitch = async (on: boolean) => {
    if (!project) return;
    if (on) {
      const confirmed = await confirm({ title: t('automation.project.onTitle', { project: project.name }), message: t('automation.project.onText'), confirmLabel: t('automation.project.onConfirm') });
      if (!confirmed) return;
    }
    setSwitching(true);
    try {
      await updateProject.mutateAsync({ id: project.id, changes: { features: { automation: on } } });
      await queryClient.invalidateQueries({ queryKey: automationKeys.project(projectId) });
      toast.success(on ? t('automation.project.turnedOn') : t('automation.project.turnedOff'));
    } catch (error) {
      if (!(isApiError(error) && error.code === 'reauth_cancelled')) toast.error(describeError(error, t));
    } finally {
      setSwitching(false);
    }
  };

  const refresh = () => void progress.track(queryClient.refetchQueries({ queryKey: automationKeys.project(projectId), type: 'active' }));
  const title = t('automation.title');
  const parent = project ? { to: workbenchPaths.project(project.id), label: project.name } : undefined;

  if (!project && projects.data) {
    return (
      <Screen title={title} largeTitle={false}>
        <ErrorState
          kind="gone"
          title={t('automation.project.gone')}
          description={t('automation.project.goneText')}
          actions={
            <Button variant="tinted" onClick={() => void navigate('/', { replace: true })}>
              {t('nav.home')}
            </Button>
          }
        />
      </Screen>
    );
  }

  return (
    <Screen
      title={title}
      caption={project?.name}
      subtitle={project?.name}
      {...(parent ? { parent } : {})}
      className="aut-screen"
      actions={<IconButton label={t('automation.refresh')} icon={<RefreshCw size={21} />} busy={list.isFetching && list.data !== undefined} onClick={refresh} />}
    >
      <div className="aut-page">
        <section className="aut-project" data-on={enabled || undefined} aria-labelledby="aut-project-title">
          <div className="aut-project__head">
            <Glyph icon={<CalendarClock size={18} />} tint={enabled ? 'green' : 'slate'} size={36} />
            <h2 id="aut-project-title" className="aut-project__title">
              {t('automation.project.title')}
            </h2>
            {isOwner ? (
              <Switch checked={enabled} disabled={switching || !project || offline} onChange={(on) => void setProjectSwitch(on)} label={t('automation.project.title')} />
            ) : (
              <Badge tone={enabled ? 'positive' : 'neutral'}>{enabled ? t('automation.on') : t('automation.offShort')}</Badge>
            )}
          </div>
          <p className="aut-project__state">{enabled ? t('automation.project.on') : t('automation.project.off')}</p>
          <p className="aut-project__detail">{t('automation.project.detail')}</p>
          {!isOwner && <p className="aut-project__detail">{t('automation.project.ownerOnly')}</p>}
        </section>

        {enabled && <PushStatus setup={push} variant="banner" origin="automations" />}

        <section className="aut-list-section" aria-labelledby="aut-list-title">
          <div className="aut-list-head">
            <h2 id="aut-list-title">
              {t('automation.list.title')}
              {list.data && <span className="aut-list-head__count">{t('automation.list.count', { count: t.number(automations.length), limit: t.number(list.data.limit) })}</span>}
            </h2>
            {stale && <StaleNotice since={since} />}
            {/* With none yet, the empty state below offers the same. */}
            {canCreate && automations.length > 0 && (
              <Button size="sm" variant="tinted" icon={<Plus size={16} />} disabled={atLimit || offline} onClick={() => setEditing({ automation: null })}>
                {t('automation.new')}
              </Button>
            )}
          </div>
          {atLimit && canCreate && <p className="aut-note">{t('automation.list.limit', { limit: t.number(list.data?.limit ?? 20) })}</p>}
          {!list.data ? (
            list.isError ? (
              <ErrorState error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />
            ) : (
              <DelayedSkeleton label={t('common.loading')}>
                <ul className="aut-cards">
                  {[0, 1].map((index) => (
                    <li key={index} className="aut-card">
                      <Skeleton width="45%" height={16} />
                      <Skeleton width="70%" height={12} />
                      <Skeleton width="55%" height={12} />
                    </li>
                  ))}
                </ul>
              </DelayedSkeleton>
            )
          ) : automations.length === 0 ? (
            <EmptyState
              icon={<CalendarClock size={28} />}
              title={t('automation.empty.title')}
              description={enabled ? t('automation.empty.text') : t('automation.empty.off')}
              action={
                canCreate ? (
                  <Button variant="tinted" icon={<Plus size={18} />} onClick={() => setEditing({ automation: null })}>
                    {t('automation.new')}
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <>
              {!enabled && (
                <Banner tone="warning">
                  <p>{t('automation.list.offNotice')}</p>
                </Banner>
              )}
              <ul className="aut-cards">
                {automations.map((automation) => (
                  <AutomationCard
                    key={automation.id}
                    automation={automation}
                    busy={busy?.id === automation.id ? busy.kind : null}
                    disabled={offline || (busy !== null && busy.id !== automation.id)}
                    agentName={agentName}
                    now={now}
                    onToggle={(on) => void toggle(automation, on)}
                    onRun={() => void runNow(automation)}
                    onEdit={() => setEditing({ automation })}
                    onHistory={() => setHistory(automation)}
                    onDelete={() => void remove(automation)}
                  />
                ))}
              </ul>
            </>
          )}
        </section>
      </div>
      <AutomationSheet open={editing !== null} projectId={projectId} automation={editing?.automation ?? null} options={options.data} onClose={() => setEditing(null)} />
      <HistorySheet projectId={projectId} automation={history} onClose={() => setHistory(null)} />
    </Screen>
  );
}
