import { AUTOMATION_EVENT, type DeferredMessage, deferredChangedSchema, userTopic } from '@agent-studio/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, CircleAlert, X } from 'lucide-react';
import { useState } from 'react';
import { isApiError } from '@/data/api';
import { describeError } from '@/data/errors';
import { useOnReconnect, useRealtimeTopic } from '@/data/realtime';
import { useUser } from '@/data/session';
import { useT } from '@/i18n';
import { usePageVisible } from '@/platform/media';
import { Spinner, confirm, toast } from '@/ui';
import { automationKeys, deferredApi } from './api';
import { whenText } from './words';
import './later.css';

/** Which of a conversation's scheduled messages are worth a row: waiting, under way, or failed and not put away. */
export function visibleDeferred(messages: readonly DeferredMessage[]): DeferredMessage[] {
  return messages
    .filter((message) => !message.dismissed && (message.state === 'pending' || message.state === 'in-progress' || message.state === 'failed'))
    .sort((a, b) => a.sendAt - b.sendAt);
}

/**
 * The messages of this conversation that are scheduled to be sent later:
 * when each goes, cancel while it waits, and the reason when one could not be
 * sent (dismiss puts it away). Above the message field, like the queue.
 */
export function DeferredList({ sessionId, editable }: { sessionId: string; editable: boolean }) {
  const t = useT();
  const user = useUser();
  const visible = usePageVisible();
  const queryClient = useQueryClient();
  const [working, setWorking] = useState<string | null>(null);
  const key = automationKeys.deferred(sessionId);
  const list = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => deferredApi.list(sessionId, signal),
    staleTime: 15_000,
    // The live connection says when one changes; a slow look now and then covers a gap in it.
    refetchInterval: (query) => (visible && query.state.data?.messages.some((message) => message.state === 'pending' || message.state === 'in-progress') ? 30_000 : false),
  });

  useRealtimeTopic(user ? userTopic(user.id) : null, (event) => {
    if (event.type !== AUTOMATION_EVENT.deferredChanged) return;
    const parsed = deferredChangedSchema.safeParse(event.data);
    if (parsed.success && parsed.data.sessionId === sessionId) void queryClient.invalidateQueries({ queryKey: key });
  });
  useOnReconnect(() => void queryClient.invalidateQueries({ queryKey: key }));

  // Rows of another conversation never flash here: the list belongs to this session's key only.
  const rows = visibleDeferred(list.data?.messages ?? []);
  if (rows.length === 0) return null;

  const act = async (message: DeferredMessage, kind: 'cancel' | 'dismiss') => {
    if (working) return;
    if (kind === 'cancel') {
      const confirmed = await confirm({ title: t('automation.later.cancelTitle'), message: t('automation.later.cancelText', { when: whenText(message.sendAt, Date.now(), t) }), confirmLabel: t('automation.later.cancelConfirm'), tone: 'danger' });
      if (!confirmed) return;
    }
    setWorking(message.id);
    try {
      if (kind === 'cancel') await deferredApi.cancel(message.id);
      else await deferredApi.dismiss(message.id);
    } catch (error) {
      // Already sent (or already put away): that is news, not a failure.
      if (isApiError(error) && (error.code === 'deferred_not_pending' || error.code === 'deferred_not_failed')) toast.info(t('automation.later.changedMeanwhile'));
      else toast.error(describeError(error, t));
    } finally {
      setWorking(null);
      void queryClient.invalidateQueries({ queryKey: key });
    }
  };

  return (
    <section className="aut-deferred" aria-label={t('automation.later.listLabel')}>
      <h3 className="aut-deferred__title">{t.plural('automation.later.count', rows.length)}</h3>
      <ol className="aut-deferred__list">
        {rows.map((message) => {
          const firstLine = message.text.split('\n', 1)[0] ?? '';
          return (
            <li key={message.id} className="aut-deferred__item" data-state={message.state}>
              <span className="aut-deferred__icon" aria-hidden="true">
                {message.state === 'failed' ? <CircleAlert size={16} /> : message.state === 'in-progress' ? <Spinner size={15} /> : <CalendarClock size={16} />}
              </span>
              <div className="aut-deferred__text">
                <p className="aut-deferred__status">
                  {message.state === 'pending'
                    ? t('automation.later.willSend', { when: whenText(message.sendAt, Date.now(), t) })
                    : message.state === 'in-progress'
                      ? message.queued
                        ? t('automation.later.queued')
                        : t('automation.later.running')
                      : t('automation.later.failed', { reason: message.detail ?? t('automation.later.failedUnknown') })}
                </p>
                <p className="aut-deferred__message">{firstLine}</p>
              </div>
              {editable && message.state === 'pending' && (
                <button type="button" className="wb-bar-button" disabled={working !== null} onClick={() => void act(message, 'cancel')} aria-label={t('automation.later.cancel')} title={t('automation.later.cancel')}>
                  {working === message.id ? <Spinner size={16} /> : <X size={18} aria-hidden="true" />}
                </button>
              )}
              {editable && message.state === 'failed' && (
                <button type="button" className="aut-deferred__dismiss" disabled={working !== null} onClick={() => void act(message, 'dismiss')}>
                  {working === message.id ? <Spinner size={14} /> : t('common.dismiss')}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
