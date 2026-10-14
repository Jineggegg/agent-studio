import type { Task, TaskParticipant, TaskSynthesis } from '@agent-studio/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, FileDiff, GitBranch, Scale, Square, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { isApiError } from '@/data/api';
import { useStaleness } from '@/data/connection';
import { useProjects } from '@/data/projects';
import { AgentMark } from '@/features/workbench/chat/parts';
import { workbenchPaths } from '@/features/workbench/routes';
import { useT } from '@/i18n';
import { usePageVisible } from '@/platform/media';
import { Screen } from '@/shell/Screen';
import { useScreenActive } from '@/shell/ScreenStack';
import { Badge, Banner, Button, DelayedSkeleton, ErrorState, MenuButton, Skeleton, SkeletonText, StaleNotice, confirm, toast } from '@/ui';
import { Markdown } from '@/ui/markdown';
import { collabApi, collabKeys } from '../api';
import { describeCollabError } from '../problems';
import { useCollabLiveUpdates } from '../live';
import { ANSWER_FOLD_CHARS, TASK_STATE, participantState, synthesisState, taskActive, taskProgress, usageTotals } from './words';
import '../collab.css';

/** Re-renders now and then while something runs, so elapsed times move. */
function useTicking(enabled: boolean, intervalMs = 15_000): number {
  const visible = usePageVisible();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled || !visible) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [enabled, visible, intervalMs]);
  return now;
}

function Answer({ text, truncated, partial }: { text: string; truncated: boolean; partial: boolean }) {
  const t = useT();
  const long = text.length > ANSWER_FOLD_CHARS;
  const [unfolded, setUnfolded] = useState(false);
  return (
    <div className="cl-answer">
      <div className="cl-answer__body wb-prose" data-folded={(long && !unfolded) || undefined}>
        <Markdown>{text}</Markdown>
      </div>
      {long && (
        <button type="button" className="wb-inline-button" aria-expanded={unfolded} onClick={() => setUnfolded(!unfolded)}>
          {unfolded ? t('collab.answer.less') : t('collab.answer.more')}
        </button>
      )}
      {(truncated || partial) && <p className="cl-card__note">{[truncated ? t('collab.answer.truncated') : null, partial ? t('collab.answer.partial') : null].filter(Boolean).join(' ')}</p>}
    </div>
  );
}

function Duration({ startedAt, finishedAt, durationMs, now }: { startedAt: number | null; finishedAt: number | null; durationMs: number | null; now: number }) {
  const t = useT();
  if (durationMs !== null) return <span>{t('collab.duration.took', { duration: t.duration(durationMs / 1000) })}</span>;
  if (startedAt !== null && finishedAt === null) return <span>{t('collab.duration.for', { duration: t.duration(Math.max(1, (now - startedAt) / 1000)) })}</span>;
  return null;
}

function ParticipantCard({ participant, now }: { participant: TaskParticipant; now: number }) {
  const t = useT();
  const navigate = useNavigate();
  const state = participantState(participant);
  const usage = usageTotals(participant.usage);
  const worktree = participant.worktree;
  const [filesOpen, setFilesOpen] = useState(false);
  const sessionId = participant.sessionId;
  return (
    <article className="cl-card" aria-labelledby={`cl-participant-${participant.position}`}>
      <header className="cl-card__head">
        <AgentMark agentId={participant.agentId} size={30} />
        <div className="cl-card__titles">
          <h3 id={`cl-participant-${participant.position}`} className="cl-card__title">
            {participant.agentName}
          </h3>
          <p className="cl-card__meta">{[participant.model, participant.effort].filter(Boolean).join(' · ') || t('workbench.agent.defaultModel')}</p>
        </div>
        <Badge tone={state.tone}>{t(state.label)}</Badge>
      </header>
      <p className="cl-card__facts u-tabular">
        <Duration startedAt={participant.startedAt} finishedAt={participant.finishedAt} durationMs={participant.durationMs} now={now} />
        {usage && <span>{t('collab.usage.tokens', { count: t.number(usage.tokens, { notation: 'compact', maximumFractionDigits: 1 }) })}</span>}
        {usage?.costUsd != null && usage.costUsd > 0 && <span>{t.number(usage.costUsd, { style: 'currency', currency: 'USD', maximumFractionDigits: 4 })}</span>}
      </p>
      {participant.state === 'waiting-approval' && <p className="cl-card__note" data-tone="warning">{t('collab.participant.waitingText')}</p>}
      {participant.error && (
        <p className="cl-card__note" data-tone="danger">
          {participant.error.message}
        </p>
      )}
      {worktree && (
        <div className="cl-worktree">
          <p className="cl-worktree__branch">
            <GitBranch size={15} aria-hidden="true" />
            <span className="u-mono u-truncate">{worktree.branch}</span>
          </p>
          {worktree.changes ? (
            worktree.changes.total === 0 ? (
              <p className="cl-card__meta">{t('collab.worktree.noChanges')}</p>
            ) : (
              <>
                <button type="button" className="wb-inline-button" aria-expanded={filesOpen} onClick={() => setFilesOpen(!filesOpen)}>
                  <FileDiff size={15} aria-hidden="true" />
                  {t.plural('collab.worktree.files', worktree.changes.total)} · +{t.number(worktree.changes.additions)} −{t.number(worktree.changes.deletions)}
                </button>
                {filesOpen && (
                  <ul className="cl-files">
                    {worktree.changes.files.map((file) => (
                      <li key={file.path}>
                        <span className="cl-files__status" data-status={file.status}>
                          {file.status}
                        </span>
                        <span className="u-mono u-truncate">{file.path}</span>
                        {file.additions !== null && <span className="cl-files__count u-tabular">+{file.additions}</span>}
                        {file.deletions !== null && <span className="cl-files__count u-tabular">−{file.deletions}</span>}
                      </li>
                    ))}
                    {worktree.changes.truncated && <li className="cl-card__meta">{t('collab.worktree.more', { count: t.number(worktree.changes.total - worktree.changes.files.length) })}</li>}
                  </ul>
                )}
              </>
            )
          ) : worktree.changesError ? (
            <p className="cl-card__meta">{t('collab.worktree.unreadable', { reason: worktree.changesError })}</p>
          ) : null}
        </div>
      )}
      {participant.answer ? (
        <Answer text={participant.answer.text} truncated={participant.answer.truncated} partial={participant.answer.partial} />
      ) : participant.state === 'completed' ? (
        <p className="cl-card__meta">{t('collab.answer.none')}</p>
      ) : null}
      {sessionId && participant.sessionProjectId && (
        <div className="cl-card__actions">
          <Button size="sm" variant="tinted" icon={<ArrowUpRight size={16} />} onClick={() => void navigate(workbenchPaths.session(participant.sessionProjectId, sessionId))}>
            {t('collab.participant.open')}
          </Button>
        </div>
      )}
      {!sessionId && <p className="cl-card__meta">{t('collab.participant.sessionGone')}</p>}
    </article>
  );
}

function SynthesisCard({ synthesis, now }: { synthesis: TaskSynthesis; now: number }) {
  const t = useT();
  const navigate = useNavigate();
  const state = synthesisState(synthesis.state);
  return (
    <article className="cl-card cl-card--synthesis" aria-labelledby="cl-synthesis">
      <header className="cl-card__head">
        <span className="cl-card__glyph" aria-hidden="true">
          <Scale size={18} />
        </span>
        <div className="cl-card__titles">
          <h3 id="cl-synthesis" className="cl-card__title">
            {t('collab.synthesis.title')}
          </h3>
          <p className="cl-card__meta">{t('collab.synthesis.by', { agent: synthesis.agentName })}</p>
        </div>
        <Badge tone={state.tone}>{t(state.label)}</Badge>
      </header>
      <p className="cl-card__facts u-tabular">
        <Duration startedAt={synthesis.startedAt} finishedAt={synthesis.finishedAt} durationMs={synthesis.startedAt && synthesis.finishedAt ? synthesis.finishedAt - synthesis.startedAt : null} now={now} />
      </p>
      {synthesis.state === 'pending' && <p className="cl-card__meta">{t('collab.synthesis.pendingText')}</p>}
      {synthesis.note && <p className="cl-card__meta">{t('collab.synthesis.note', { note: synthesis.note })}</p>}
      {synthesis.error && (
        <p className="cl-card__note" data-tone="danger">
          {synthesis.error.message}
        </p>
      )}
      {synthesis.answer && <Answer text={synthesis.answer.text} truncated={synthesis.answer.truncated} partial={synthesis.answer.partial} />}
      {synthesis.sessionId && (
        <div className="cl-card__actions">
          <Button size="sm" variant="tinted" icon={<ArrowUpRight size={16} />} onClick={() => void navigate(workbenchPaths.lookup(synthesis.sessionId!))}>
            {t('collab.participant.open')}
          </Button>
        </div>
      )}
    </article>
  );
}

/**
 * One multi-agent task: each participant's state, answer, usage and time,
 * for worktrees its branch and changed files, the comparison when it is in —
 * and stopping or deleting the whole of it.
 */
export default function TaskScreen() {
  const t = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const active = useScreenActive();
  const { taskId = '' } = useParams();
  useCollabLiveUpdates();
  const task = useQuery({
    queryKey: collabKeys.task(taskId),
    queryFn: ({ signal }) => collabApi.task(taskId, signal),
    enabled: taskId !== '',
    meta: { live: true },
    // The live topic says when something changes; this is only the safety net.
    refetchInterval: (query) => (active && query.state.data && taskActive(query.state.data) ? 20_000 : false),
  });
  const projects = useProjects();
  const staleness = useStaleness(task);
  const data = task.data;
  const now = useTicking(data !== undefined && taskActive(data));
  const [stopping, setStopping] = useState(false);
  const projectName = data ? (projects.data?.find((project) => project.id === data.projectId)?.name ?? null) : null;

  const stop = async (current: Task) => {
    if (!(await confirm({ title: t('collab.task.stopTitle'), message: t('collab.task.stopText'), confirmLabel: t('collab.task.stop'), tone: 'danger' }))) return;
    setStopping(true);
    try {
      queryClient.setQueryData(collabKeys.task(current.id), await collabApi.stopTask(current.id));
      void queryClient.invalidateQueries({ queryKey: collabKeys.task(current.id) });
      toast.success(t('collab.task.stopped'));
    } catch (error) {
      toast.error(describeCollabError(error, t));
    } finally {
      setStopping(false);
    }
  };

  const remove = async (current: Task) => {
    const kept = current.participants.filter((participant) => participant.sessionId !== null).length + (current.synthesis?.sessionId ? 1 : 0);
    if (!(await confirm({ title: t('collab.task.deleteTitle', { title: current.title }), message: t.plural('collab.task.deleteText', kept), confirmLabel: t('collab.task.delete'), tone: 'danger' }))) return;
    try {
      const result = await collabApi.deleteTask(current.id);
      queryClient.removeQueries({ queryKey: collabKeys.task(current.id) });
      void queryClient.invalidateQueries({ queryKey: collabKeys.tasks });
      toast.success(t.plural('collab.task.deleted', result.sessionsKept.length));
      void navigate('/tasks', { replace: true });
    } catch (error) {
      toast.error(describeCollabError(error, t));
    }
  };

  const title = data?.title ?? t('collab.task.title');
  return (
    <Screen
      title={title}
      caption={data ? [projectName, t('collab.task.startedAt', { when: t.relative(data.createdAt) }), data.isolation === 'worktrees' ? t('collab.task.worktreesShort') : t('collab.task.sharedShort')].filter(Boolean).join(' · ') : undefined}
      parent={{ to: '/tasks', label: t('collab.tasks.title') }}
      width="wide"
      actions={
        data && !taskActive(data) ? (
          <MenuButton label={t('common.moreActions')} items={[{ id: 'delete', label: t('collab.task.delete'), icon: <Trash2 size={18} />, tone: 'danger', onSelect: () => void remove(data) }]} />
        ) : undefined
      }
    >
      {!data ? (
        task.isPending ? (
          <DelayedSkeleton label={t('common.loading')}>
            <Skeleton width="100%" height={72} radius={14} />
            <SkeletonText lines={4} />
          </DelayedSkeleton>
        ) : (
          <ErrorState
            error={task.error}
            onRetry={() => void task.refetch()}
            retrying={task.isFetching}
            {...(isApiError(task.error) && task.error.gone ? { title: t('collab.task.gone'), description: t('collab.task.goneText'), actions: <Button variant="tinted" onClick={() => void navigate('/tasks', { replace: true })}>{t('collab.tasks.title')}</Button> } : {})}
          />
        )
      ) : (
        <>
          {staleness.stale && <StaleNotice since={staleness.since} />}
          <section className="cl-summary" aria-label={t('collab.task.status')}>
            <div className="cl-summary__state">
              <Badge tone={TASK_STATE[data.state].tone}>{t(TASK_STATE[data.state].label)}</Badge>
              <span className="u-tabular">{t('collab.task.progress', { ended: t.number(taskProgress(data).ended), total: t.number(taskProgress(data).total) })}</span>
            </div>
            {taskActive(data) && (
              <Button variant="danger" size="sm" icon={<Square size={15} />} loading={stopping} onClick={() => void stop(data)}>
                {t('collab.task.stopAll')}
              </Button>
            )}
          </section>
          {data.state === 'needs-attention' && <Banner tone="warning">{t('collab.task.attentionText')}</Banner>}
          <section className="cl-prompt" aria-labelledby="cl-prompt-title">
            <h2 id="cl-prompt-title" className="cl-section-title">
              {t('collab.task.asked')}
            </h2>
            <p className="cl-prompt__text">{data.prompt}</p>
          </section>
          <section aria-labelledby="cl-participants-title">
            <h2 id="cl-participants-title" className="cl-section-title">
              {t('collab.task.answers')}
            </h2>
            <div className="cl-cards">
              {data.participants.map((participant) => (
                <ParticipantCard key={participant.position} participant={participant} now={now} />
              ))}
            </div>
          </section>
          {data.synthesis && <SynthesisCard synthesis={data.synthesis} now={now} />}
          <p className="cl-footnote">{t('collab.task.keptNote')}</p>
        </>
      )}
    </Screen>
  );
}
