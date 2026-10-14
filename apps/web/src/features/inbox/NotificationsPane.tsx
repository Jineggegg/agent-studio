import { NOTIFICATION_LIMITS, type Notification, type NotificationKind, safeAppLink } from '@agent-studio/protocol';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, BellRing, CheckCheck, CircleCheck, CircleX, Hand, Moon, Puzzle, RotateCcw, Timer, Trash2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useNavigate } from 'react-router';
import { useConnectionState, useStaleness } from '@/data/connection';
import { describeError } from '@/data/errors';
import { notificationsApi } from '@/features/notifications/api';
import { useT } from '@/i18n';
import { useScreenActive } from '@/shell/ScreenStack';
import { Button, DelayedSkeleton, EmptyState, ErrorState, Glyph, List, ListRow, MenuButton, Skeleton, StaleNotice, type Tint, confirm, toast } from '@/ui';

const KIND_MARK: Record<NotificationKind, { icon: ReactNode; tint: Tint }> = {
  'needs-you': { icon: <Hand size={17} />, tint: 'amber' },
  'reply-finished': { icon: <CircleCheck size={17} />, tint: 'green' },
  'background-finished': { icon: <Moon size={17} />, tint: 'teal' },
  'run-failed': { icon: <CircleX size={17} />, tint: 'red' },
  'run-interrupted': { icon: <RotateCcw size={17} />, tint: 'orange' },
  automation: { icon: <Timer size={17} />, tint: 'purple' },
  plugin: { icon: <Puzzle size={17} />, tint: 'pink' },
  system: { icon: <BellRing size={17} />, tint: 'slate' },
};

const PAGE = NOTIFICATION_LIMITS.listDefault;
export const notificationListKey = ['notifications', 'list'] as const;

/**
 * What happened, as the server stored it for this person: newest unread
 * first, each leading to the conversation or page it is about. Changes arrive
 * over the live connection (see `useInboxLiveUpdates`).
 */
export function NotificationsPane() {
  const t = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const active = useScreenActive();
  const connection = useConnectionState();
  const [working, setWorking] = useState(false);

  const list = useInfiniteQuery({
    queryKey: notificationListKey,
    queryFn: ({ pageParam, signal }) => notificationsApi.list(pageParam, PAGE, signal),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => (last.hasMore ? pages.reduce((sum, page) => sum + page.notifications.length, 0) : undefined),
    enabled: active,
    meta: { live: true },
  });
  const { stale, since } = useStaleness(list);
  const items = list.data?.pages.flatMap((page) => page.notifications) ?? [];
  const unread = list.data?.pages[0]?.unread ?? 0;

  const refresh = () => void queryClient.invalidateQueries({ queryKey: notificationListKey });

  const markRead = async (item: Notification) => {
    try {
      await notificationsApi.markRead(item.id);
    } catch {
      /* the next read shows the truth */
    }
    refresh();
  };

  const open = (item: Notification) => {
    if (item.readAt === null) void markRead(item);
    const link = safeAppLink(item.link);
    if (!item.targetAvailable || link === '/') {
      toast.info(t('inbox.notes.gone'));
      return;
    }
    void navigate(link);
  };

  const remove = async (item: Notification) => {
    try {
      await notificationsApi.remove(item.id);
    } catch (error) {
      toast.error(describeError(error, t));
    }
    refresh();
  };

  const bulk = async (kind: 'read-all' | 'clear-read' | 'clear-all') => {
    if (kind === 'clear-all') {
      const confirmed = await confirm({ title: t('inbox.notes.clearAllTitle'), message: t('inbox.notes.clearAllText'), confirmLabel: t('inbox.notes.clearAll'), tone: 'danger' });
      if (!confirmed) return;
    }
    setWorking(true);
    try {
      const answer = kind === 'read-all' ? await notificationsApi.markAllRead() : await notificationsApi.clear(kind === 'clear-read' ? 'read' : 'all');
      if (kind !== 'read-all') toast.success(t.plural('inbox.notes.cleared', answer.changed));
    } catch (error) {
      toast.error(describeError(error, t));
    } finally {
      setWorking(false);
      refresh();
    }
  };

  if (!list.data) {
    if (list.isError) return <ErrorState error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />;
    return (
      <DelayedSkeleton label={t('common.loading')}>
        <List>
          {[0, 1, 2].map((index) => (
            <ListRow key={index} leading={<Skeleton width={30} height={30} radius={10} />} title={<Skeleton width="60%" height={14} />} subtitle={<Skeleton width="85%" height={12} />} />
          ))}
        </List>
      </DelayedSkeleton>
    );
  }

  const offline = connection === 'offline';
  return (
    <div className="ibx-notes">
      <div className="ibx-notes__bar">
        {/* With nothing in the list, the empty state below says it all. */}
        <p className="ibx-notes__count" role="status">
          {unread > 0 ? t.plural('inbox.notes.unread', unread) : items.length > 0 ? t('inbox.notes.allRead') : ''}
        </p>
        {stale && <StaleNotice since={since} />}
        {unread > 0 && (
          <Button size="sm" variant="plain" icon={<CheckCheck size={17} />} loading={working} disabled={offline} onClick={() => void bulk('read-all')}>
            {t('inbox.notes.markAllRead')}
          </Button>
        )}
        {items.length > 0 && (
          <MenuButton
            label={t('inbox.notes.more')}
            items={[
              { id: 'clear-read', label: t('inbox.notes.clearRead'), icon: <Trash2 size={18} />, disabled: offline, onSelect: () => void bulk('clear-read') },
              { id: 'clear-all', label: t('inbox.notes.clearAll'), icon: <Trash2 size={18} />, tone: 'danger', disabled: offline, onSelect: () => void bulk('clear-all') },
            ]}
          />
        )}
      </div>
      {items.length === 0 ? (
        <EmptyState icon={<Bell size={28} />} title={t('inbox.notes.empty')} description={t('inbox.notes.emptyText')} />
      ) : (
        <List aria-label={t('inbox.tab.notifications')}>
          {items.map((item) => {
            const mark = KIND_MARK[item.kind];
            const isUnread = item.readAt === null;
            return (
              <ListRow
                key={item.id}
                className="ibx-note"
                leading={<Glyph icon={mark.icon} tint={mark.tint} size={30} />}
                title={
                  <span className="ibx-note__title" data-unread={isUnread || undefined}>
                    {isUnread && <span className="ibx-note__dot" role="img" aria-label={t('inbox.notes.unreadMark')} />}
                    <span className="u-truncate">{item.title}</span>
                  </span>
                }
                subtitle={
                  <>
                    <span className="ibx-note__body">{item.body}</span>
                    {item.detail && <span className="ibx-note__detail">{item.detail}</span>}
                    <span className="ibx-note__time">
                      {t.relative(item.createdAt)}
                      {!item.targetAvailable ? ` · ${t('inbox.notes.unavailable')}` : ''}
                    </span>
                  </>
                }
                onPress={() => open(item)}
                chevron={item.targetAvailable}
                actionsLabel={t('inbox.notes.actions')}
                actions={[
                  ...(isUnread ? [{ id: 'read', label: t('inbox.notes.markRead'), icon: <CheckCheck size={18} />, onSelect: () => void markRead(item) }] : []),
                  { id: 'remove', label: t('common.remove'), icon: <Trash2 size={18} />, tone: 'danger' as const, onSelect: () => void remove(item) },
                ]}
              />
            );
          })}
        </List>
      )}
      {list.hasNextPage && (
        <div className="ibx-more">
          <Button variant="neutral" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
            {t('inbox.notes.more.load')}
          </Button>
        </div>
      )}
    </div>
  );
}
