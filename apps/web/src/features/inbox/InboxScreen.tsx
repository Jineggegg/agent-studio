import { useIsFetching, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Settings2 } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useT } from '@/i18n';
import { useLayoutClass } from '@/platform/layout';
import { settingsPath } from '@/registry';
import { Screen } from '@/shell/Screen';
import { useScreenActive } from '@/shell/ScreenStack';
import { CountBadge, IconButton, Tabs, progress, tabPanelProps } from '@/ui';
import { inboxApi, inboxKeys } from './api';
import { NotificationsPane, notificationListKey } from './NotificationsPane';
import { useInboxLiveUpdates } from './status';
import { TasksPane } from './TasksPane';
import './inbox.css';

type Tab = 'tasks' | 'notifications';
const TAB_KEY = 'studio.inbox.tab';

function rememberedTab(): Tab {
  try {
    return window.localStorage.getItem(TAB_KEY) === 'notifications' ? 'notifications' : 'tasks';
  } catch {
    return 'tasks';
  }
}

/**
 * The inbox: what waits for the user across every conversation (to do), and
 * what happened (notifications). On a wide screen the two sit side by side;
 * elsewhere they are two tabs. Nothing in it decides anything for the user —
 * every row leads to the conversation where that happens.
 */
export default function InboxScreen() {
  const t = useT();
  const navigate = useNavigate();
  const layout = useLayoutClass();
  const queryClient = useQueryClient();
  const active = useScreenActive();
  const [tab, setTab] = useState<Tab>(rememberedTab);
  const fetching = useIsFetching({ queryKey: inboxKeys.all }) + useIsFetching({ queryKey: notificationListKey }) > 0;
  useInboxLiveUpdates();

  const summary = useQuery({ queryKey: inboxKeys.summary, queryFn: ({ signal }) => inboxApi.summary(signal), enabled: active, staleTime: 10_000, meta: { live: true } });
  const unread = summary.data?.unreadNotifications ?? 0;
  const waiting = summary.data?.waiting ?? 0;

  const choose = (next: Tab) => {
    setTab(next);
    try {
      window.localStorage.setItem(TAB_KEY, next);
    } catch {
      /* not remembered on this device */
    }
  };

  const refresh = () =>
    void progress.track(
      Promise.all([
        queryClient.refetchQueries({ queryKey: inboxKeys.all, type: 'active' }),
        queryClient.refetchQueries({ queryKey: notificationListKey, type: 'active' }),
      ]),
    );

  const actions = (
    <>
      <IconButton label={t('inbox.settings')} icon={<Settings2 size={21} />} onClick={() => void navigate(settingsPath('notifications'))} />
      <IconButton label={t('inbox.refresh')} icon={<RefreshCw size={21} />} busy={fetching} onClick={refresh} />
    </>
  );

  if (layout === 'wide') {
    return (
      <Screen title={t('inbox.title')} actions={actions} width="wide" className="ibx-screen">
        <div className="ibx-columns">
          <section aria-labelledby="ibx-col-tasks">
            <h2 id="ibx-col-tasks" className="ibx-column__title">
              {t('inbox.tab.tasks')}
            </h2>
            <TasksPane />
          </section>
          <section aria-labelledby="ibx-col-notes">
            <h2 id="ibx-col-notes" className="ibx-column__title">
              {t('inbox.tab.notifications')}
            </h2>
            <NotificationsPane />
          </section>
        </div>
      </Screen>
    );
  }

  return (
    <Screen
      title={t('inbox.title')}
      actions={actions}
      className="ibx-screen"
      scrollId={`inbox:${tab}`}
      toolbar={
        <Tabs
          label={t('inbox.title')}
          idBase="inbox"
          value={tab}
          onChange={choose}
          stretch
          tabs={[
            { value: 'tasks', label: t('inbox.tab.tasks'), accessory: <CountBadge count={waiting} label={t.plural('inbox.tile.waiting', waiting)} /> },
            { value: 'notifications', label: t('inbox.tab.notifications'), accessory: <CountBadge count={unread} label={t.plural('inbox.notes.unread', unread)} /> },
          ]}
        />
      }
    >
      <div {...tabPanelProps('inbox', tab)} className="ibx-panel">
        {tab === 'tasks' ? <TasksPane /> : <NotificationsPane />}
      </div>
    </Screen>
  );
}
