import type { Inbox, InboxItem } from '@agent-studio/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleAlert, CircleCheck, Hand, Inbox as InboxIcon, LoaderCircle } from 'lucide-react';
import { type ReactNode, useCallback, useId, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { isApiError } from '@/data/api';
import { useConnectionState, useStaleness } from '@/data/connection';
import { describeError } from '@/data/errors';
import { workbenchPaths } from '@/features/workbench/routes';
import { useT } from '@/i18n';
import { useScreenActive } from '@/shell/ScreenStack';
import { Banner, Button, DelayedSkeleton, EmptyState, ErrorState, Glyph, Skeleton, Spinner, type Tint, toast } from '@/ui';
import { inboxApi, inboxKeys } from './api';
import { INBOX_GROUPS, acknowledgeRefusal, isEmpty, itemDetail, itemTitle, withoutAcknowledged } from './model';
import { useNow } from './useNow';

const KIND_MARK: Record<InboxItem['kind'], { icon: ReactNode; tint: Tint }> = {
  approval: { icon: <Hand size={17} />, tint: 'amber' },
  'needs-handling': { icon: <CircleAlert size={17} />, tint: 'red' },
  result: { icon: <CircleCheck size={17} />, tint: 'green' },
  running: { icon: <LoaderCircle size={17} />, tint: 'sky' },
};

/** Rows put away are remembered this long, so a read that was already on its way cannot bring them back. */
const GONE_FOR_MS = 60_000;

function TaskRow({
  item,
  stale,
  busy,
  blocked,
  onOpen,
  onAcknowledge,
}: {
  item: InboxItem;
  stale: boolean;
  busy: boolean;
  blocked: boolean;
  onOpen: () => void;
  onAcknowledge: () => void;
}) {
  const t = useT();
  const detailId = useId();
  const title = itemTitle(item, t);
  const mark = KIND_MARK[item.kind];
  const meta = [item.projectName ?? t('inbox.noProject'), item.agentName].filter(Boolean).join(' · ');
  return (
    <li className="ibx-row" data-kind={item.kind}>
      <button
        type="button"
        className="ibx-row__main"
        onClick={onOpen}
        aria-label={item.kind === 'approval' ? t('inbox.row.viewApproval', { title }) : t('inbox.row.open', { title })}
        aria-describedby={detailId}
      >
        <Glyph icon={mark.icon} tint={mark.tint} size={32} />
        <span className="ibx-row__text">
          <span className="ibx-row__line">
            <span className="ibx-row__title">{title}</span>
            <span className="ibx-row__time">{t.relative(item.updatedAt)}</span>
          </span>
          <span className="ibx-row__detail" id={detailId} data-kind={item.kind}>
            {itemDetail(item, t)}
          </span>
          <span className="ibx-row__meta">{meta}</span>
        </span>
      </button>
      {item.acknowledgeable && (
        <div className="ibx-row__ack">
          <Button
            size="sm"
            variant="neutral"
            loading={busy}
            loadingLabel={t('inbox.ack.busy')}
            disabled={stale || blocked}
            onClick={onAcknowledge}
            title={stale ? t('inbox.ack.unavailable') : undefined}
          >
            {item.kind === 'result' ? t('inbox.ack.read') : t('inbox.ack.handled')}
          </Button>
        </div>
      )}
    </li>
  );
}

function TasksSkeleton() {
  const t = useT();
  return (
    <DelayedSkeleton label={t('common.loading')}>
      <div className="ibx-group">
        <ul className="ibx-card">
          {[0, 1, 2, 3].map((index) => (
            <li key={index} className="ibx-row ibx-row--skeleton">
              <Skeleton width={32} height={32} radius={10} />
              <span className="ibx-row__text">
                <Skeleton width="55%" height={14} />
                <Skeleton width="80%" height={12} />
              </span>
            </li>
          ))}
        </ul>
      </div>
    </DelayedSkeleton>
  );
}

/**
 * The four groups — awaiting approval, needs handling, results to view, in
 * progress — each row leading to its conversation. Marking only puts a row
 * away: nothing here approves, retries, continues or stops anything.
 */
export function TasksPane() {
  const t = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const active = useScreenActive();
  const connection = useConnectionState();
  const offline = connection === 'offline';
  const now = useNow(15_000, active);
  const [gone, setGone] = useState<ReadonlyMap<string, number>>(new Map());
  const [busy, setBusy] = useState<string | null>(null);
  const [markingAll, setMarkingAll] = useState(false);
  const [problem, setProblem] = useState<{ text: string; tone: 'warning' | 'danger' } | null>(null);
  const actionLock = useRef(false);

  const inbox = useQuery({
    queryKey: inboxKeys.list,
    queryFn: ({ signal }) => inboxApi.read(signal),
    enabled: active,
    staleTime: 5_000,
    refetchInterval: active ? 15_000 : false,
    meta: { live: true },
  });
  const { stale } = useStaleness(inbox);

  const goneIds = useMemo(() => new Set([...gone].filter(([, at]) => now - at < GONE_FOR_MS).map(([id]) => id)), [gone, now]);
  const data: Inbox | undefined = useMemo(() => (inbox.data ? withoutAcknowledged(inbox.data, goneIds) : undefined), [inbox.data, goneIds]);

  const putAway = useCallback(
    (runIds: readonly string[]) => {
      setGone((current) => {
        const next = new Map(current);
        for (const id of runIds) next.set(id, Date.now());
        return next;
      });
      queryClient.setQueryData<Inbox>(inboxKeys.list, (current) => (current ? withoutAcknowledged(current, new Set(runIds)) : current));
      // Any read already on its way is dropped; the next one starts after the acknowledgement.
      void queryClient.invalidateQueries({ queryKey: inboxKeys.all });
    },
    [queryClient],
  );

  const acknowledge = async (item: InboxItem) => {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusy(item.id);
    setProblem(null);
    try {
      const answer = await inboxApi.acknowledge(item.runId);
      putAway([item.runId]);
      if (answer.alreadyHandled) toast.info(t('inbox.ack.already'));
    } catch (error) {
      const refusal = isApiError(error) ? acknowledgeRefusal(error.code, t) : null;
      if (isApiError(error) && error.code === 'task_not_found') putAway([item.runId]);
      // A refusal the inbox can explain is news about the run, not a failure of the app.
      setProblem(refusal ? { text: refusal, tone: 'warning' } : { text: describeError(error, t), tone: 'danger' });
      void queryClient.invalidateQueries({ queryKey: inboxKeys.all });
    } finally {
      actionLock.current = false;
      setBusy(null);
    }
  };

  const markAllRead = async () => {
    if (!data || actionLock.current) return;
    const ids = data.groups.results.map((item) => item.runId).slice(0, 100);
    if (ids.length === 0) return;
    actionLock.current = true;
    setMarkingAll(true);
    setProblem(null);
    try {
      const answer = await inboxApi.acknowledgeResults(ids);
      putAway(ids);
      toast.success(t.plural('inbox.ack.allDone', answer.acknowledged));
    } catch (error) {
      setProblem({ text: describeError(error, t), tone: 'danger' });
    } finally {
      actionLock.current = false;
      setMarkingAll(false);
    }
  };

  const open = (item: InboxItem) => void navigate(workbenchPaths.session(item.projectId, item.sessionId));

  if (!data) {
    if (inbox.isError) return <ErrorState error={inbox.error} onRetry={() => void inbox.refetch()} retrying={inbox.isFetching} />;
    return <TasksSkeleton />;
  }

  const checkedLine = offline
    ? t('inbox.strip.offline', { when: t.relative(inbox.dataUpdatedAt, now) })
    : inbox.isFetching && stale
      ? t('inbox.strip.checking')
      : t('inbox.strip.checked', { when: t.relative(inbox.dataUpdatedAt, now) });

  return (
    <div className="ibx-tasks">
      <p className="ibx-strip" data-stale={stale || undefined} role="status">
        {inbox.isFetching && stale ? <Spinner size={13} /> : <span className="ibx-strip__dot" aria-hidden="true" />}
        {checkedLine}
      </p>
      {stale && (
        <Banner
          tone="warning"
          title={t('inbox.stale.title')}
          action={
            offline ? undefined : (
              <Button size="sm" variant="tinted" loading={inbox.isFetching} onClick={() => void inbox.refetch()}>
                {t('common.retry')}
              </Button>
            )
          }
        >
          <p>
            {offline
              ? t('inbox.stale.offline', { when: t.date(inbox.dataUpdatedAt, 'time') })
              : inbox.isError
                ? t('inbox.stale.failed', { reason: describeError(inbox.error, t), when: t.date(inbox.dataUpdatedAt, 'time') })
                : t('inbox.stale.reconnecting', { when: t.date(inbox.dataUpdatedAt, 'time') })}
          </p>
        </Banner>
      )}
      {problem && (
        <Banner tone={problem.tone} role="alert">
          <p>{problem.text}</p>
        </Banner>
      )}

      {isEmpty(data) ? (
        <EmptyState
          icon={<InboxIcon size={28} />}
          title={stale ? t('inbox.empty.stale') : t('inbox.empty.title')}
          description={t('inbox.empty.text')}
        />
      ) : (
        INBOX_GROUPS.map((group) => {
          const items = data.groups[group.key];
          if (items.length === 0) return null;
          const count = data.counts[group.key];
          return (
            <section key={group.key} className="ibx-group" aria-labelledby={`ibx-${group.key}`}>
              <div className="ibx-group__head">
                <h2 id={`ibx-${group.key}`}>
                  {t(group.title)} <span className="ibx-group__count">{t.number(count)}</span>
                </h2>
                {group.key === 'results' && items.length > 1 && (
                  <Button size="sm" variant="plain" loading={markingAll} disabled={stale || busy !== null} onClick={() => void markAllRead()}>
                    {t('inbox.ack.all')}
                  </Button>
                )}
              </div>
              <ul className="ibx-card">
                {items.map((item) => (
                  <TaskRow
                    key={item.id}
                    item={item}
                    stale={stale}
                    busy={busy === item.id}
                    blocked={markingAll || (busy !== null && busy !== item.id)}
                    onOpen={() => open(item)}
                    onAcknowledge={() => void acknowledge(item)}
                  />
                ))}
              </ul>
              <p className="ibx-group__footer">{t(group.footer)}</p>
            </section>
          );
        })
      )}
      {(data.truncated || !isEmpty(data)) && (
        <p className="ibx-footnote">
          {data.truncated ? `${t('inbox.truncated')} ` : ''}
          {t('inbox.scope')}
        </p>
      )}
    </div>
  );
}
