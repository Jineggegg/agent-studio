import { Plus, Users } from 'lucide-react';
import { lazy, Suspense, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useStaleness } from '@/data/connection';
import { describeError } from '@/data/errors';
import { useProjects } from '@/data/projects';
import { useT } from '@/i18n';
import { Screen } from '@/shell/Screen';
import { Button, DelayedSkeleton, EmptyState, ErrorState, List, ListRow, SegmentedControl, Select, Skeleton, StaleNotice } from '@/ui';
import type { TaskListParams } from '../api';
import { useCollabLiveUpdates } from '../live';
import { TaskRow } from './TaskRow';
import { flattenTasks, useTaskList } from './queries';
import '../collab.css';

const TaskSheet = lazy(() => import('./TaskSheet'));
const ALL = 'all';
/**
 * Multi-agent tasks across every project the person can see — or one
 * project's, from `?project=<id>` — the open ones or all of them.
 */
export default function TasksScreen() {
  const t = useT();
  const [search, setSearch] = useSearchParams();
  const projectFilter = search.get('project');
  const [state, setState] = useState<'open' | 'all'>('all');
  const [asking, setAsking] = useState(false);
  const [askLoaded, setAskLoaded] = useState(false);
  const projects = useProjects();
  useCollabLiveUpdates();
  const projectId = projectFilter && projects.data?.some((project) => project.id === projectFilter) ? projectFilter : null;
  const params = useMemo<TaskListParams>(() => ({ projectId, state }), [projectId, state]);
  const list = useTaskList(params);
  const staleness = useStaleness(list);
  const tasks = useMemo(() => flattenTasks(list.data?.pages), [list.data]);
  const names = useMemo(() => new Map((projects.data ?? []).map((project) => [project.id, project.name])), [projects.data]);
  const fixedProject = projectId ? (projects.data?.find((project) => project.id === projectId) ?? null) : null;

  return (
    <Screen
      title={t('collab.tasks.title')}
      caption={t('collab.tasks.caption')}
      actions={
        <Button
          size="sm"
          variant="tinted"
          icon={<Plus size={16} />}
          onClick={() => {
            setAskLoaded(true);
            setAsking(true);
          }}
        >
          {t('collab.task.ask')}
        </Button>
      }
    >
      <div className="cl-filters">
        <SegmentedControl
          label={t('collab.tasks.which')}
          value={state}
          onChange={setState}
          options={[
            { value: 'all', label: t('collab.tasks.all') },
            { value: 'open', label: t('collab.tasks.open') },
          ]}
        />
        <Select
          label={t('collab.tasks.project')}
          value={projectId ?? ALL}
          onChange={(value) => setSearch(value === ALL ? {} : { project: value }, { replace: true })}
          options={[{ value: ALL, label: t('collab.tasks.allProjects') }, ...(projects.data ?? []).map((project) => ({ value: project.id, label: project.name }))]}
        />
      </div>
      {staleness.stale && <StaleNotice since={staleness.since} />}
      {list.isPending ? (
        <DelayedSkeleton label={t('common.loading')}>
          <List>
            {[0, 1, 2].map((index) => (
              <ListRow key={index} leading={<Skeleton width={30} height={30} radius={9} />} title={<Skeleton width="55%" height={12} />} subtitle={<Skeleton width="35%" height={10} />} />
            ))}
          </List>
        </DelayedSkeleton>
      ) : !list.data ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />
      ) : tasks.length === 0 ? (
        <EmptyState icon={<Users size={28} />} title={state === 'open' ? t('collab.tasks.noneOpen') : t('collab.tasks.none')} description={t('collab.tasks.noneText')} />
      ) : (
        <>
          <List aria-label={t('collab.tasks.title')}>
            {tasks.map((task) => (
              <TaskRow key={task.id} task={task} projectName={projectId ? null : (names.get(task.projectId) ?? null)} />
            ))}
          </List>
          {list.hasNextPage && (
            <div className="cl-more">
              {list.isFetchNextPageError && <p role="alert">{describeError(list.error, t)}</p>}
              <Button variant="plain" block onClick={() => void list.fetchNextPage()} loading={list.isFetchingNextPage}>
                {list.isFetchNextPageError ? t('common.retry') : t('collab.tasks.older')}
              </Button>
            </div>
          )}
        </>
      )}
      {askLoaded && (
        <Suspense fallback={null}>
          <TaskSheet open={asking} onClose={() => setAsking(false)} project={fixedProject} />
        </Suspense>
      )}
    </Screen>
  );
}
