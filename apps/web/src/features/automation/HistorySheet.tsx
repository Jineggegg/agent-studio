import { AUTOMATION_LIMITS, type Automation, type AutomationExecution } from '@agent-studio/protocol';
import { useInfiniteQuery } from '@tanstack/react-query';
import { ExternalLink, History } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { workbenchPaths } from '@/features/workbench/routes';
import { type MessageKey, useT } from '@/i18n';
import { Badge, Button, EmptyState, ErrorState, LoadingRow, Sheet } from '@/ui';
import { automationApi, automationKeys } from './api';
import { OUTCOME, REASON, executionTime } from './words';

const TRIGGER: Record<AutomationExecution['trigger'], MessageKey> = {
  schedule: 'automation.history.schedule',
  manual: 'automation.history.manual',
  event: 'automation.history.event',
};

export interface HistorySheetProps {
  projectId: string;
  automation: Automation | null;
  onClose: () => void;
}

/** Every recorded execution of one automation, newest first, a page at a time. */
export function HistorySheet({ projectId, automation, onClose }: HistorySheetProps) {
  const t = useT();
  const navigate = useNavigate();
  // The last one stays on screen while the sheet plays its exit.
  const [shown, setShown] = useState(automation);
  if (automation !== null && automation !== shown) setShown(automation);
  const id = shown?.id ?? '';
  const history = useInfiniteQuery({
    queryKey: automationKeys.history(projectId, id),
    queryFn: ({ pageParam, signal }) => automationApi.history(projectId, id, pageParam, AUTOMATION_LIMITS.historyDefault, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.hasMore ? last.runs[last.runs.length - 1]?.id : undefined),
    enabled: shown !== null,
  });
  const runs = history.data?.pages.flatMap((page) => page.runs) ?? [];

  return (
    <Sheet open={automation !== null} onClose={onClose} title={shown ? t('automation.history.title', { name: shown.name }) : t('automation.history.label')} size="lg" fill>
      {!history.data ? (
        history.isError ? (
          <ErrorState error={history.error} onRetry={() => void history.refetch()} retrying={history.isFetching} compact />
        ) : (
          <LoadingRow label={t('common.loading')} />
        )
      ) : runs.length === 0 ? (
        <EmptyState icon={<History size={28} />} title={t('automation.history.empty')} description={t('automation.history.emptyText')} compact />
      ) : (
        <>
          <ol className="aut-history">
            {runs.map((run) => {
              const outcome = OUTCOME[run.outcome];
              return (
                <li key={run.id} className="aut-history__item" data-tone={outcome.tone}>
                  <div className="aut-history__head">
                    <Badge tone={outcome.tone}>{t(outcome.label)}</Badge>
                    <span className="aut-history__when">{t.date(executionTime(run), 'dateTime')}</span>
                    <span className="aut-history__trigger">{t(TRIGGER[run.trigger])}</span>
                  </div>
                  {run.summary !== '' && <p className="aut-history__summary">{run.summary}</p>}
                  {run.reason && <p className="aut-history__reason">{t(REASON[run.reason])}</p>}
                  {run.endedAt !== null && run.endedAt - run.startedAt >= 1000 && (
                    <p className="aut-history__reason">{t('automation.history.took', { duration: t.duration((run.endedAt - run.startedAt) / 1000) })}</p>
                  )}
                  {run.sessionId && (
                    <Button
                      size="sm"
                      variant="plain"
                      icon={<ExternalLink size={15} />}
                      onClick={() => {
                        onClose();
                        void navigate(workbenchPaths.session(projectId, run.sessionId!));
                      }}
                    >
                      {t('automation.history.open')}
                    </Button>
                  )}
                </li>
              );
            })}
          </ol>
          {history.hasNextPage && (
            <div className="aut-more">
              <Button variant="neutral" loading={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>
                {t('automation.history.more')}
              </Button>
            </div>
          )}
        </>
      )}
    </Sheet>
  );
}
