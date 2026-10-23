import { useEffect, useMemo, useState } from 'react';
import { useT } from '@/i18n';
import type { TranscriptState } from '../transcript/model';
import { conversationTasks } from './model';
import '../media/media.css';
export function BackgroundTasks({ transcript }: { transcript: TranscriptState }) {
  const t = useT();
  const tasks = useMemo(() => conversationTasks(transcript), [transcript]);
  const [now, setNow] = useState(Date.now);
  const running = tasks.filter(
    (task) => task.status === 'running' || task.status === 'accepted' || task.status === 'waiting',
  ).length;
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  if (!tasks.length) return null;
  return (
    <details className="wb-task-panel" key={transcript.sessionId}>
      <summary>
        {t('tasks.title')}
        {running > 0
          ? ` · ${t('tasks.active')} ${t.number(running)}`
          : ` · ${t.number(tasks.length)}`}
      </summary>
      <ul>
        {tasks.map((task) => (
          <li key={task.id} data-status={task.status}>
            <span>{t(`tasks.${task.type}`)}</span>
            <strong>{task.title}</strong>
            <span>{t(`tasks.${task.status}`)}</span>
            {task.startedAt !== null &&
              (task.finishedAt !== null ||
                task.status === 'running' ||
                task.status === 'waiting') && (
                <time className="u-tabular">
                  {t('tasks.elapsed', {
                    seconds: Math.max(
                      0,
                      Math.floor(((task.finishedAt ?? now) - task.startedAt) / 1000),
                    ),
                  })}
                </time>
              )}
          </li>
        ))}
      </ul>
      <p>{t('tasks.loaded')}</p>
    </details>
  );
}
