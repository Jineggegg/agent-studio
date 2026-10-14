import { NOTIFICATION_EVENTS, type NotificationEvent, type NotificationPreferences, type NotificationSettings, type UpdateNotificationPreferencesRequest } from '@agent-studio/protocol';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';
import { describeError } from '@/data/errors';
import { type MessageKey, useT } from '@/i18n';
import { Banner, List, ListRow, Switch } from '@/ui';
import { notificationKeys, notificationsApi } from './api';

/** One switch of the account's notification preferences. */
export type SwitchKey = `events.${NotificationEvent}` | 'channels.inApp' | 'channels.webPush' | 'showDetails';

export function readSwitch(preferences: NotificationPreferences, key: SwitchKey): boolean {
  if (key === 'showDetails') return preferences.showDetails;
  const [group, name] = key.split('.') as ['events' | 'channels', string];
  return group === 'events' ? preferences.events[name as NotificationEvent] : preferences.channels[name as 'inApp' | 'webPush'];
}

/** The patch for one switch, naming nothing else. */
export function patchFor(key: SwitchKey, on: boolean): UpdateNotificationPreferencesRequest {
  if (key === 'showDetails') return { showDetails: on };
  const [group, name] = key.split('.') as ['events' | 'channels', string];
  return group === 'events' ? { events: { [name]: on } } : { channels: { [name]: on } };
}

/**
 * The switches as the person sees them: each one moves the moment it is
 * flipped and is saved on its own. Saves go out one after another, so an
 * older answer never overtakes a newer choice; a save that fails puts back
 * that one switch — and only that one — and says so.
 */
export function usePreferenceSwitches(settings: NotificationSettings | undefined, device: string | null) {
  const t = useT();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<Partial<Record<SwitchKey, boolean>>>({});
  const [problem, setProblem] = useState<{ key: SwitchKey; text: string } | null>(null);
  const chain = useRef<Promise<unknown>>(Promise.resolve());

  const value = useCallback(
    (key: SwitchKey): boolean => {
      const waiting = pending[key];
      if (waiting !== undefined) return waiting;
      return settings ? readSwitch(settings.preferences, key) : false;
    },
    [pending, settings],
  );

  const toggle = useCallback(
    (key: SwitchKey, on: boolean) => {
      setProblem(null);
      setPending((current) => ({ ...current, [key]: on }));
      chain.current = chain.current.then(async () => {
        try {
          const answer = await notificationsApi.updatePreferences(patchFor(key, on), device);
          queryClient.setQueryData(notificationKeys.settings(device), answer);
        } catch (error) {
          setProblem({ key, text: describeError(error, t) });
        } finally {
          // A newer flip of the same switch keeps its own overlay until its own answer.
          setPending((current) => {
            if (current[key] !== on) return current;
            const next = { ...current };
            delete next[key];
            return next;
          });
        }
      });
    },
    [device, queryClient, t],
  );

  return { value, toggle, pending, problem };
}

const EVENT_COPY: Record<NotificationEvent, { title: MessageKey; text: MessageKey }> = {
  needsYou: { title: 'notify.event.needsYou', text: 'notify.event.needsYou.text' },
  replyFinished: { title: 'notify.event.replyFinished', text: 'notify.event.replyFinished.text' },
  backgroundFinished: { title: 'notify.event.backgroundFinished', text: 'notify.event.backgroundFinished.text' },
  failure: { title: 'notify.event.failure', text: 'notify.event.failure.text' },
  automation: { title: 'notify.event.automation', text: 'notify.event.automation.text' },
  plugin: { title: 'notify.event.plugin', text: 'notify.event.plugin.text' },
};

export type PreferenceSwitches = ReturnType<typeof usePreferenceSwitches>;

export function switchTitle(key: SwitchKey): MessageKey {
  if (key === 'showDetails') return 'notify.details.title';
  if (key === 'channels.inApp') return 'notify.inApp.title';
  if (key === 'channels.webPush') return 'notify.webPush.title';
  return EVENT_COPY[key.slice(7) as NotificationEvent].title;
}

/** A failed save of one switch: which one, and why. */
export function SwitchProblem({ switches }: { switches: PreferenceSwitches }) {
  const t = useT();
  if (!switches.problem) return null;
  return (
    <Banner tone="danger" title={t('notify.saveFailed', { name: t(switchTitle(switches.problem.key)) })}>
      {switches.problem.text}
    </Banner>
  );
}

export interface NotificationSwitchesProps {
  switches: PreferenceSwitches;
  /** The account cannot be changed right now (offline). */
  disabled?: boolean;
}

/** "Notify me about", "Show details on the lock screen" and the in-app list: each switch independent of the others. */
export function NotificationSwitches({ switches, disabled }: NotificationSwitchesProps) {
  const t = useT();
  return (
    <>
      <List header={t('notify.events.header')} footer={t('notify.events.footer')}>
        {NOTIFICATION_EVENTS.map((event) => (
          <ListRow
            key={event}
            title={t(EVENT_COPY[event].title)}
            subtitle={t(EVENT_COPY[event].text)}
            control={<Switch checked={switches.value(`events.${event}`)} disabled={disabled} onChange={(on) => switches.toggle(`events.${event}`, on)} />}
          />
        ))}
      </List>
      <List header={t('notify.privacy.header')} footer={t('notify.details.footer')}>
        <ListRow
          title={t('notify.details.title')}
          subtitle={switches.value('showDetails') ? t('notify.details.on') : t('notify.details.off')}
          control={<Switch checked={switches.value('showDetails')} disabled={disabled} onChange={(on) => switches.toggle('showDetails', on)} />}
        />
      </List>
      <List header={t('notify.inApp.header')} footer={t('notify.inApp.footer')}>
        <ListRow
          title={t('notify.inApp.title')}
          subtitle={t('notify.inApp.text')}
          control={<Switch checked={switches.value('channels.inApp')} disabled={disabled} onChange={(on) => switches.toggle('channels.inApp', on)} />}
        />
      </List>
    </>
  );
}
