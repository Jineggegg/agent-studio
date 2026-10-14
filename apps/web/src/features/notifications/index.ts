import { Bell } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useSession } from '@/data/session';
import { useT } from '@/i18n';
import { registerFeatureRoutes, registerSettingsPage } from '@/registry';
import { notificationKeys, notificationsApi } from './api';

/**
 * Notifications: the settings page where this device is set up for Web Push,
 * the account's devices are listed and tested, and each event is switched on
 * or off. Registration only — the page downloads when it is first opened.
 *
 * One thing runs by itself: after a sign-in, a browser that still holds the
 * subscription it made for this same account registers it again, silently
 * (see `reRegisterThisBrowser`). It touches nothing in a development build,
 * which has no service worker.
 */
function useNotificationSummary(): string | undefined {
  const t = useT();
  const settings = useQuery({ queryKey: notificationKeys.settings(null), queryFn: ({ signal }) => notificationsApi.settings(null, signal), staleTime: 60_000 });
  if (!settings.data) return undefined;
  const { active, devices } = settings.data.push;
  return active ? t.plural('notify.summary.devices', devices.length) : t('notify.summary.off');
}

// Where a notification's link leads: the conversation it is about, in the workbench.
registerFeatureRoutes(
  { path: 'sessions/:sessionId', name: 'workbench.title', load: () => import('./SessionLink') },
  { path: 'projects/:projectId/sessions/:sessionId', name: 'workbench.title', load: () => import('./SessionLink') },
);

registerSettingsPage({
  id: 'notifications',
  title: 'notify.title',
  icon: Bell,
  tint: 'red',
  group: 'general',
  order: 30,
  load: () => import('./NotificationSettings'),
  useSummary: useNotificationSummary,
});

if (import.meta.env.PROD && typeof window !== 'undefined') {
  let lastUser: string | null = null;
  const check = (userId: string | null) => {
    if (userId === lastUser) return;
    lastUser = userId;
    if (!userId) return;
    // Late, and only once per sign-in: start-up has better things to do first.
    window.setTimeout(() => {
      void import('./state')
        .then(async ({ reRegisterThisBrowser }) => {
          const { pushOwner } = await import('./push');
          await reRegisterThisBrowser(userId, pushOwner());
        })
        .catch(() => undefined);
    }, 4000);
  };
  useSession.subscribe((state) => check(state.authenticated ? (state.user?.id ?? null) : null));
}
