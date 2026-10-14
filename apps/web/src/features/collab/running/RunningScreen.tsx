import type { RunningRun, RunningWork, Task } from '@agent-studio/protocol';
import { useQueryClient } from '@tanstack/react-query';
import { Activity, Eye, EyeOff, RefreshCw, Square, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useStaleness } from '@/data/connection';
import { AgentMark } from '@/features/workbench/chat/parts';
import { workbenchPaths } from '@/features/workbench/routes';
import { useT } from '@/i18n';
import { usePageVisible } from '@/platform/media';
import { Screen } from '@/shell/Screen';
import { ActivityMark, DelayedSkeleton, EmptyState, ErrorState, Glyph, IconButton, List, ListRow, Skeleton, StaleNotice, confirm, progress, toast } from '@/ui';
import { collabApi, collabKeys } from '../api';
import { describeCollabError } from '../problems';
import { useCollabLiveUpdates } from '../live';
import { useRunningWork } from './status';
import { taskPath } from '../tasks/TaskRow';
import { ORIGIN_WORDS, TASK_STATE, taskProgress } from '../tasks/words';
import '../collab.css';

function useNow(enabled: boolean): number {
  const visible = usePageVisible();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled || !visible) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [enabled, visible]);
  return now;
}

function RunRow({ run, now, onStop, stopping }: { run: RunningRun; now: number; onStop: (run: RunningRun) => void; stopping: boolean }) {
  const t = useT();
  const navigate = useNavigate();
  const since = run.startedAt ?? run.createdAt;
  const details = [
    run.projectName,
    t(ORIGIN_WORDS[run.origin]),
    run.state === 'starting' ? t('collab.running.starting') : t('collab.running.for', { duration: t.duration(Math.max(1, (now - since) / 1000)) }),
    run.pendingApprovals > 1 ? t.plural('collab.running.approvals', run.pendingApprovals) : null,
  ].filter(Boolean);
  return (
    <ListRow
      leading={
        <span className="cl-task-leading">
          <AgentMark agentId={run.agentId} size={30} />
          {run.state === 'waiting' && <ActivityMark kind="attention" className="cl-task-leading__mark" />}
        </span>
      }
      title={<span className="cl-row-title">{run.title}</span>}
      subtitle={
        <span className="cl-run-subtitle">
          <span className="u-truncate">{details.join(' · ')}</span>
          <span className="cl-watch" data-watching={run.watching || undefined}>
            {run.watching ? <Eye size={13} aria-hidden="true" /> : <EyeOff size={13} aria-hidden="true" />}
            {run.watching ? t('collab.running.watching') : run.unattended ? t('collab.running.unattended') : t('collab.running.notWatching')}
          </span>
        </span>
      }
      trailing={
        <span className="cl-row-actions">
          <IconButton label={t('collab.running.stop', { title: run.title })} icon={<Square size={16} />} tone="danger" busy={stopping} onClick={() => onStop(run)} />
        </span>
      }
      onPress={() => void navigate(run.projectId ? workbenchPaths.session(run.projectId, run.sessionId) : workbenchPaths.lookup(run.sessionId))}
    />
  );
}

function TaskEntry({ task, watching, onStop, stopping }: { task: Task; watching: boolean; onStop: (task: Task) => void; stopping: boolean }) {
  const t = useT();
  const navigate = useNavigate();
  const progressNow = taskProgress(task);
  const state = TASK_STATE[task.state];
  return (
    <ListRow
      leading={
        <span className="cl-task-leading">
          <Glyph icon={<Users size={17} />} tint="teal" size={30} />
          {task.state === 'needs-attention' && <ActivityMark kind="attention" className="cl-task-leading__mark" />}
        </span>
      }
      title={<span className="cl-row-title">{task.title}</span>}
      subtitle={
        <span className="cl-run-subtitle">
          <span className="u-truncate">{[t(state.label), t('collab.task.progress', { ended: t.number(progressNow.ended), total: t.number(progressNow.total) })].join(' · ')}</span>
          <span className="cl-watch" data-watching={watching || undefined}>
            {watching ? <Eye size={13} aria-hidden="true" /> : <EyeOff size={13} aria-hidden="true" />}
            {watching ? t('collab.running.watching') : t('collab.running.notWatching')}
          </span>
        </span>
      }
      trailing={
        <span className="cl-row-actions">
          <IconButton label={t('collab.running.stopTask', { title: task.title })} icon={<Square size={16} />} tone="danger" busy={stopping} onClick={() => onStop(task)} />
        </span>
      }
      onPress={() => void navigate(taskPath(task.id))}
    />
  );
}

/**
 * Everything of yours that runs or waits right now: conversations you
 * started, automations and scheduled messages, the agents of your tasks —
 * where each came from, whether anyone has it open, and how to stop it.
 */
export default function RunningScreen() {
  const t = useT();
  const queryClient = useQueryClient();
  useCollabLiveUpdates({ running: true });
  const running = useRunningWork({ pollMs: 15_000 });
  const staleness = useStaleness(running);
  const data: RunningWork | undefined = running.data;
  const now = useNow((data?.runs.length ?? 0) > 0);
  const [stopping, setStopping] = useState<Set<string>>(new Set());

  const stopWith = async (key: string, action: RunningRun['stop'], question: { title: string; message: string }) => {
    if (!(await confirm({ ...question, confirmLabel: t('collab.running.stopConfirm'), tone: 'danger' }))) return;
    setStopping((current) => new Set(current).add(key));
    try {
      await collabApi.stop(action);
      toast.success(t('collab.running.stopped'));
      void queryClient.invalidateQueries({ queryKey: collabKeys.running });
      void queryClient.invalidateQueries({ queryKey: collabKeys.tasks });
    } catch (error) {
      toast.error(describeCollabError(error, t));
    } finally {
      setStopping((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  };

  const waiting = data?.runs.filter((run) => run.state === 'waiting') ?? [];
  const working = data?.runs.filter((run) => run.state !== 'waiting') ?? [];
  const caption = data
    ? [
        t.plural('collab.running.countRuns', data.counts.runs),
        data.counts.waiting > 0 ? t.plural('collab.running.countWaiting', data.counts.waiting) : null,
        data.counts.background > 0 ? t.plural('collab.running.countBackground', data.counts.background) : null,
        data.counts.tasks > 0 ? t.plural('collab.running.countTasks', data.counts.tasks) : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : undefined;

  return (
    <Screen
      title={t('collab.running.title')}
      caption={caption}
      actions={<IconButton label={t('collab.running.refresh')} icon={<RefreshCw size={20} />} busy={running.isFetching && !running.isPending} onClick={() => void progress.track(running.refetch())} />}
    >
      {staleness.stale && <StaleNotice since={staleness.since} />}
      {running.isPending ? (
        <DelayedSkeleton label={t('common.loading')}>
          <List>
            {[0, 1, 2].map((index) => (
              <ListRow key={index} leading={<Skeleton width={30} height={30} radius={9} />} title={<Skeleton width="50%" height={12} />} subtitle={<Skeleton width="70%" height={10} />} />
            ))}
          </List>
        </DelayedSkeleton>
      ) : !data ? (
        <ErrorState error={running.error} onRetry={() => void running.refetch()} retrying={running.isFetching} />
      ) : data.runs.length === 0 && data.tasks.length === 0 ? (
        <EmptyState icon={<Activity size={28} />} title={t('collab.running.empty')} description={t('collab.running.emptyText')} />
      ) : (
        <>
          {waiting.length > 0 && (
            <List header={t('collab.running.waiting')} footer={t('collab.running.waitingFooter')}>
              {waiting.map((run) => (
                <RunRow key={run.runId} run={run} now={now} stopping={stopping.has(run.runId)} onStop={(entry) => void stopWith(entry.runId, entry.stop, { title: t('collab.running.stopTitle', { title: entry.title }), message: t('collab.running.stopText') })} />
              ))}
            </List>
          )}
          {working.length > 0 && (
            <List header={t('collab.running.working')}>
              {working.map((run) => (
                <RunRow key={run.runId} run={run} now={now} stopping={stopping.has(run.runId)} onStop={(entry) => void stopWith(entry.runId, entry.stop, { title: t('collab.running.stopTitle', { title: entry.title }), message: t('collab.running.stopText') })} />
              ))}
            </List>
          )}
          {data.truncated && <p className="cl-footnote">{t('collab.running.truncated')}</p>}
          {data.tasks.length > 0 && (
            <List header={t('collab.running.tasks')}>
              {data.tasks.map((entry) => (
                <TaskEntry
                  key={entry.task.id}
                  task={entry.task}
                  watching={entry.watching}
                  stopping={stopping.has(entry.task.id)}
                  onStop={(task) => void stopWith(task.id, entry.stop, { title: t('collab.task.stopTitle'), message: t('collab.task.stopText') })}
                />
              ))}
            </List>
          )}
        </>
      )}
      <List>
        <ListRow leading={<Users size={20} />} title={t('collab.tasks.title')} subtitle={t('collab.running.tasksLink')} to="/tasks" />
      </List>
      {data && <p className="cl-footnote">{t('collab.running.checked', { when: t.relative(data.checkedAt) })}</p>}
    </Screen>
  );
}
