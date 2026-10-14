import type { Task } from '@agent-studio/protocol';
import { Users } from 'lucide-react';
import { useT } from '@/i18n';
import { ActivityMark, Badge, Glyph, ListRow } from '@/ui';
import { TASK_STATE, taskProgress } from './words';

export const taskPath = (taskId: string): string => `/tasks/${encodeURIComponent(taskId)}`;

/** One task in a list: its name, how far it has got, and its state in words. */
export function TaskRow({ task, projectName }: { task: Task; projectName?: string | null }) {
  const t = useT();
  const state = TASK_STATE[task.state];
  const progress = taskProgress(task);
  const details = [
    projectName ?? null,
    t('collab.task.progress', { ended: t.number(progress.ended), total: t.number(progress.total) }),
    task.isolation === 'worktrees' ? t('collab.task.worktreesShort') : null,
    t.relative(task.updatedAt),
  ].filter(Boolean);
  return (
    <ListRow
      leading={
        <span className="cl-task-leading">
          <Glyph icon={<Users size={17} />} tint="teal" size={30} />
          {task.state === 'needs-attention' && <ActivityMark kind="attention" className="cl-task-leading__mark" />}
        </span>
      }
      title={<span className="cl-row-title">{task.title}</span>}
      subtitle={details.join(' · ')}
      trailing={<Badge tone={state.tone}>{t(state.label)}</Badge>}
      to={taskPath(task.id)}
    />
  );
}
