import type { Project } from '@agent-studio/protocol';
import { Users } from 'lucide-react';
import { lazy, Suspense, useMemo, useState } from 'react';
import { useT } from '@/i18n';
import { Button, ErrorState, List, ListRow, LoadingRow } from '@/ui';
import { useCollabLiveUpdates } from '../live';
import { TaskRow } from './TaskRow';
import { flattenTasks, useTaskList } from './queries';
import '../collab.css';

const TaskSheet = lazy(() => import('./TaskSheet'));
const SHOWN = 5;

/**
 * A project's multi-agent tasks on its own page: the newest few, "Ask
 * several agents", and the way to all of them.
 */
export function ProjectTasksSection({ project }: { project: Project }) {
  const t = useT();
  const [asking, setAsking] = useState(false);
  const [askLoaded, setAskLoaded] = useState(false);
  useCollabLiveUpdates();
  const list = useTaskList({ projectId: project.id, state: 'all' }, { limit: SHOWN });
  const tasks = useMemo(() => flattenTasks(list.data?.pages.slice(0, 1)), [list.data]);
  const canAsk = project.access === 'write' && !project.archived && project.features.assistant;
  const more = list.data?.pages[0]?.hasMore ?? false;

  return (
    <>
      <List
        header={t('collab.tasks.title')}
        headerAction={
          canAsk ? (
            <Button
              size="sm"
              variant="plain"
              icon={<Users size={16} />}
              onClick={() => {
                setAskLoaded(true);
                setAsking(true);
              }}
            >
              {t('collab.task.ask')}
            </Button>
          ) : undefined
        }
        footer={tasks.length === 0 && list.data ? (canAsk ? t('collab.tasks.projectEmpty') : t('collab.tasks.projectEmptyReadOnly')) : undefined}
      >
        {list.isPending ? (
          <LoadingRow label={t('common.loading')} />
        ) : !list.data ? (
          <ErrorState compact error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />
        ) : (
          <>
            {tasks.map((task) => (
              <TaskRow key={task.id} task={task} />
            ))}
            {(more || tasks.length > 0) && <ListRow title={t('collab.tasks.allOfProject')} to={`/tasks?project=${encodeURIComponent(project.id)}`} />}
          </>
        )}
      </List>
      {askLoaded && (
        <Suspense fallback={null}>
          <TaskSheet open={asking} onClose={() => setAsking(false)} project={project} />
        </Suspense>
      )}
    </>
  );
}
