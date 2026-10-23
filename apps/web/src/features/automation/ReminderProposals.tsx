import { reminderProposalsSchema, automationSchema } from '@agent-studio/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/data/api';
import { describeError } from '@/data/errors';
import { useT } from '@/i18n';
import { Banner, Button, ErrorState, List, ListRow, confirm, toast } from '@/ui';
import { automationKeys } from './api';
import { triggerText } from './words';
export function ReminderProposals({ projectId }: { projectId: string }) {
  const t = useT(),
    cache = useQueryClient(),
    [busy, setBusy] = useState(false);
  const path = `/api/projects/${encodeURIComponent(projectId)}/reminder-proposals`;
  const query = useQuery({
    queryKey: ['reminder-proposals', projectId],
    queryFn: ({ signal }) => api.get(path, { schema: reminderProposalsSchema, signal }),
    refetchInterval: 15000,
  });
  const apply = async (id: string, approve: boolean, detail: string) => {
    if (busy) return;
    if (
      approve &&
      !(await confirm({
        title: t('reminder.confirm'),
        message: detail,
        confirmLabel: t('reminder.approve'),
      }))
    )
      return;
    setBusy(true);
    try {
      if (approve) {
        await api.post(
          `${path}/${encodeURIComponent(id)}/approve`,
          { confirmed: true },
          { schema: automationSchema },
        );
        toast.success(t('reminder.applied'));
      } else await api.delete(`${path}/${encodeURIComponent(id)}`);
      await query.refetch();
      await cache.invalidateQueries({ queryKey: automationKeys.project(projectId) });
    } catch (e) {
      toast.error(describeError(e, t));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section>
      <Banner>{t('reminder.help')}</Banner>
      {query.isError && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}
      {Boolean(query.data?.proposals.length) && (
        <List header={t('reminder.proposals')}>
          {query.data?.proposals.map((item) => {
            const p = item.proposal;
            const title = t(`reminder.${p.operation}`),
              details =
                p.operation === 'create'
                  ? `${p.name}: ${p.message}\n${triggerText(p.trigger, t, p.timeZone)}\n${item.nextRuns.map((at) => t.date(at, 'dateTime')).join(' · ')}`
                  : `${title}: ${p.automationId}`;
            return (
              <ListRow
                key={item.id}
                title={title}
                subtitle={details}
                trailing={
                  <div className="aut-proposal-actions">
                    <Button disabled={busy} onClick={() => void apply(item.id, true, details)}>
                      {t('reminder.approve')}
                    </Button>
                    <Button
                      disabled={busy}
                      variant="plain"
                      onClick={() => void apply(item.id, false, details)}
                    >
                      {t('reminder.dismiss')}
                    </Button>
                  </div>
                }
              />
            );
          })}
        </List>
      )}
    </section>
  );
}
