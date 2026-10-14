import type { QueuedMessage } from '@agent-studio/protocol';
import { CornerDownRight, Paperclip, Pencil, Send, X } from 'lucide-react';
import { useState } from 'react';
import { isApiError } from '@/data/api';
import { describeError } from '@/data/errors';
import { useT } from '@/i18n';
import { Button, Spinner, isImeConfirm, toast } from '@/ui';
import { workbenchApi } from '../api';
import type { Outgoing } from './delivery';

export interface QueueProps {
  sessionId: string;
  queue: readonly QueuedMessage[];
  /** Messages on their way to the queue that the server has not listed yet. */
  arriving: readonly Outgoing[];
  /** A turn is in progress. */
  busy: boolean;
  /** …and the agent can take a message into it. */
  canSteer: boolean;
  /** This user may change the queue (it is their session). */
  editable: boolean;
  /** Called after a change, to read the queue again if the live connection is not there to bring it. */
  onChanged: () => void;
}

function QueueItem({ item, index, total, sessionId, busy, canSteer, editable, onChanged }: { item: QueuedMessage; index: number; total: number } & Omit<QueueProps, 'queue' | 'arriving'>) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(item.text);
  const [working, setWorking] = useState<'save' | 'send' | 'remove' | null>(null);

  const fail = (error: unknown) => {
    // Too late: the server already took it. That is news, not a failure.
    if (isApiError(error) && error.code === 'not_queued') toast.info(t('workbench.queue.alreadySent'));
    else toast.error(describeError(error, t));
  };
  const run = async (kind: 'save' | 'send' | 'remove', action: () => Promise<unknown>, after?: () => void) => {
    if (working) return;
    setWorking(kind);
    try {
      await action();
      after?.();
    } catch (error) {
      fail(error);
    } finally {
      setWorking(null);
      onChanged();
    }
  };
  const save = () => {
    const next = text.trim();
    if (next === '' || next === item.text) return setEditing(false);
    void run('save', () => workbenchApi.editQueued(sessionId, item.id, next), () => setEditing(false));
  };
  // What "send now" will actually do depends on what the agent is doing.
  const sendLabel = !busy ? t('workbench.queue.sendNow') : canSteer ? t('workbench.queue.steerNow') : t('workbench.queue.interruptAndSend');

  return (
    <li className="wb-queue__item" data-editing={editing || undefined}>
      <span className="wb-queue__index u-tabular" aria-hidden="true">
        {total > 1 ? index + 1 : ''}
      </span>
      {editing ? (
        <div className="wb-queue__edit">
          <textarea
            className="wb-queue__field"
            value={text}
            rows={2}
            autoFocus
            aria-label={t('workbench.queue.editLabel')}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                setText(item.text);
                setEditing(false);
              } else if (event.key === 'Enter' && !event.shiftKey && !isImeConfirm(event)) {
                event.preventDefault();
                save();
              }
            }}
          />
          <div className="wb-queue__edit-actions">
            <Button size="sm" variant="plain" onClick={() => (setText(item.text), setEditing(false))} disabled={working !== null}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" variant="tinted" onClick={save} loading={working === 'save'} disabled={text.trim() === ''}>
              {t('common.save')}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <p className="wb-queue__text">
            {item.text}
            {item.attachments.length > 0 && (
              <span className="wb-queue__files">
                <Paperclip size={13} aria-hidden="true" />
                {t.plural('workbench.queue.files', item.attachments.length)}
              </span>
            )}
          </p>
          {editable && (
            <div className="wb-queue__actions">
              <button type="button" className="wb-bar-button" disabled={working !== null} onClick={() => void run('send', () => workbenchApi.sendQueuedNow(sessionId, item.id))} aria-label={sendLabel} title={sendLabel}>
                {working === 'send' ? <Spinner size={16} /> : busy && canSteer ? <CornerDownRight size={18} aria-hidden="true" /> : <Send size={17} aria-hidden="true" />}
              </button>
              <button type="button" className="wb-bar-button" disabled={working !== null} onClick={() => (setText(item.text), setEditing(true))} aria-label={t('workbench.queue.edit')} title={t('workbench.queue.edit')}>
                <Pencil size={17} aria-hidden="true" />
              </button>
              <button type="button" className="wb-bar-button" disabled={working !== null} onClick={() => void run('remove', () => workbenchApi.removeQueued(sessionId, item.id))} aria-label={t('workbench.queue.remove')} title={t('workbench.queue.remove')}>
                {working === 'remove' ? <Spinner size={16} /> : <X size={18} aria-hidden="true" />}
              </button>
            </div>
          )}
        </>
      )}
    </li>
  );
}

/**
 * Messages waiting for their turn. The list is the server's: it is the same
 * on every device, and it is sent from there one turn at a time whether or
 * not a browser is open.
 */
export function Queue({ sessionId, queue, arriving, busy, canSteer, editable, onChanged }: QueueProps) {
  const t = useT();
  const listed = new Set(queue.map((item) => item.requestId));
  const ghosts = arriving.filter((entry) => !listed.has(entry.payload.requestId));
  if (queue.length === 0 && ghosts.length === 0) return null;
  const total = queue.length + ghosts.length;
  return (
    <section className="wb-queue" aria-label={t('workbench.queue.title')}>
      <h3 className="wb-queue__title">{t.plural('workbench.queue.count', total)}</h3>
      <ol className="wb-queue__list">
        {queue.map((item, index) => (
          <QueueItem key={item.id} item={item} index={index} total={total} sessionId={sessionId} busy={busy} canSteer={canSteer} editable={editable} onChanged={onChanged} />
        ))}
        {ghosts.map((entry, index) => (
          <li key={entry.payload.requestId} className="wb-queue__item" data-arriving="">
            <span className="wb-queue__index u-tabular" aria-hidden="true">
              {total > 1 ? queue.length + index + 1 : ''}
            </span>
            <p className="wb-queue__text">{entry.payload.text}</p>
            <span className="wb-queue__arriving" role="status">
              <Spinner size={14} />
              {t('workbench.delivery.sending')}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
