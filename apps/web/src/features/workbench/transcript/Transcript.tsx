import type { Agent, AttachmentRef } from '@agent-studio/protocol';
import { ArrowDown, TextQuote } from 'lucide-react';
import { type ReactNode, type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { describeError } from '@/data/errors';
import { useT } from '@/i18n';
import { useCanHover } from '@/platform/media';
import { Button, DelayedSkeleton, Skeleton, SkeletonText, Spinner } from '@/ui';
import type { Outgoing } from '../composer/delivery';
import { ImageViewer } from './ImageViewer';
import { type PendingUserRow, type RowContext, RowBoundary, type TranscriptRow, estimateRow, renderRow } from './Rows';
import { WindowedList, type WindowedListHandle } from './WindowedList';
import type { ChannelState, SessionChannel } from './channel';
import type { TranscriptItem } from './model';

export interface TranscriptProps {
  state: ChannelState;
  channel: SessionChannel | null;
  /** Messages that are on their way and not in the log yet. */
  outgoing: readonly Outgoing[];
  /** The first message of a conversation that is still being created. */
  starting: PendingUserRow | null;
  agents: readonly Agent[];
  sessionAgentId: string | null;
  userId: string | null;
  /** Shown instead of the list when there is nothing to list. */
  empty: ReactNode;
  /** The run status line, drawn after the last row. */
  footer?: ReactNode;
  onReviewApproval: (approvalId: string) => void;
  /** Offered for selected text; absent where nothing can be sent. */
  onQuote?: ((text: string) => void) | undefined;
  /** A row to bring into view once it is loaded (a search hit). */
  focusSeq?: number | null;
  listRef?: RefObject<WindowedListHandle | null>;
}

const getKey = (row: TranscriptRow): string => row.key;

/** The item that holds the event with `seq`: the last row that starts at or before it. */
function keyForSeq(items: readonly TranscriptItem[], seq: number): string | null {
  let found: string | null = null;
  for (const item of items) {
    if (item.seq > seq) break;
    found = item.key;
  }
  return found;
}

function TranscriptSkeleton() {
  const t = useT();
  return (
    <DelayedSkeleton label={t('workbench.transcript.loading')}>
      <div className="wb-transcript__skeleton">
        <Skeleton width="58%" height={44} radius={18} className="wb-transcript__skeleton-user" />
        <SkeletonText lines={4} />
        <Skeleton width="72%" height={84} radius={14} />
        <Skeleton width="44%" height={44} radius={18} className="wb-transcript__skeleton-user" />
        <SkeletonText lines={3} />
      </div>
    </DelayedSkeleton>
  );
}

/**
 * A "Quote" control beside a text selection that lies inside one message.
 * It appears below a finger selection — clear of the system's own menu, and
 * only once the handles have rested — and above a mouse selection.
 */
function useQuoteSelection(container: RefObject<HTMLElement | null>, enabled: boolean) {
  const canHover = useCanHover();
  const [selection, setSelection] = useState<{ text: string; top: number; left: number } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let timer = 0;
    const read = () => {
      const root = container.current;
      const current = window.getSelection();
      if (!root || !current || current.isCollapsed || current.rangeCount === 0) return setSelection(null);
      const text = current.toString().trim();
      const closest = (node: Node | null): Element | null => (node instanceof Element ? node : (node?.parentElement ?? null))?.closest('[data-quotable]') ?? null;
      const start = closest(current.anchorNode);
      const end = closest(current.focusNode);
      // Only a selection inside one message can be quoted.
      if (text === '' || !start || start !== end || !root.contains(start)) return setSelection(null);
      const rect = current.getRangeAt(0).getBoundingClientRect();
      const frame = root.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return setSelection(null);
      const left = Math.min(Math.max(rect.left + rect.width / 2 - frame.left, 60), frame.width - 60);
      const top = canHover ? rect.top - frame.top - 46 : rect.bottom - frame.top + 34;
      setSelection({ text, left, top: Math.min(Math.max(top, 6), frame.height - 50) });
    };
    const onChange = () => {
      window.clearTimeout(timer);
      // A finger selection is still being dragged while this fires; wait for it to rest.
      timer = window.setTimeout(read, canHover ? 60 : 260);
    };
    document.addEventListener('selectionchange', onChange);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('selectionchange', onChange);
    };
  }, [container, enabled, canHover]);

  return { selection: enabled ? selection : null, clear: () => setSelection(null) };
}

/**
 * The conversation: the session's log folded into rows, the user's own
 * messages that are still on their way, and the run status line at the end.
 */
export function Transcript({ state, channel, outgoing, starting, agents, sessionAgentId, userId, empty, footer, onReviewApproval, onQuote, focusSeq, listRef }: TranscriptProps) {
  const t = useT();
  const ownList = useRef<WindowedListHandle>(null);
  const list = listRef ?? ownList;
  const frame = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const [viewer, setViewer] = useState<{ images: AttachmentRef[]; index: number } | null>(null);
  const { transcript } = state;

  const rows = useMemo<TranscriptRow[]>(() => {
    const pending: PendingUserRow[] = [];
    for (const entry of outgoing) {
      // A message meant for the queue shows there; one already in the log is no longer pending.
      if (entry.expected === 'queued' || transcript.requestIds.has(entry.payload.requestId)) continue;
      if (entry.phase === 'accepted' && entry.disposition === 'queued') continue;
      pending.push({
        kind: 'pending',
        key: `u:${entry.payload.requestId}`,
        requestId: entry.payload.requestId,
        text: entry.payload.text,
        quote: entry.payload.quote,
        attachments: entry.attachments,
        phase: entry.phase,
        steer: entry.expected === 'steered',
        createdAt: entry.createdAt,
      });
    }
    if (starting && !transcript.requestIds.has(starting.requestId) && !pending.some((row) => row.requestId === starting.requestId)) pending.push(starting);
    return pending.length === 0 ? transcript.items : [...transcript.items, ...pending];
  }, [transcript.items, transcript.requestIds, outgoing, starting]);

  const onOpenImage = useCallback((images: AttachmentRef[], index: number) => setViewer({ images, index }), []);
  const current = useRef(rows);
  current.current = rows;
  // The text of a whole reply: the block with `key` and the blocks of prose directly before it in the same run.
  const proseOf = useCallback((key: string): string => {
    const all = current.current;
    const end = all.findIndex((row) => row.key === key);
    const last = all[end];
    if (!last || last.kind !== 'assistant') return '';
    const parts: string[] = [];
    for (let index = end; index >= 0; index -= 1) {
      const row = all[index]!;
      if (row.kind !== 'assistant' || row.runId !== last.runId) break;
      parts.unshift(row.text);
    }
    return parts.join('\n\n');
  }, []);
  const sessionId = transcript.sessionId || null;
  const context = useMemo<RowContext>(
    () => ({ agents, sessionAgentId, onReviewApproval, onOpenImage, userId, proseOf, sessionId }),
    [agents, sessionAgentId, onReviewApproval, onOpenImage, userId, proseOf, sessionId],
  );
  const renderItem = useCallback(
    (row: TranscriptRow, index: number) => <RowBoundary resetKey={row.kind === 'pending' ? row.phase : row.rev}>{renderRow(row, context, current.current[index + 1])}</RowBoundary>,
    [context],
  );

  // Rows that arrived while the reader was looking further up.
  const lastKey = rows.length > 0 ? rows[rows.length - 1]!.key : null;
  const seenLastKey = useRef(lastKey);
  const [unread, setUnread] = useState(false);
  if (following && seenLastKey.current !== lastKey) seenLastKey.current = lastKey;
  if (following && unread) setUnread(false);
  if (!following && lastKey !== seenLastKey.current && !unread) setUnread(true);

  // The user's own message always brings the view back to the end.
  const pendingCount = rows.length - transcript.items.length;
  const previousPending = useRef(pendingCount);
  useEffect(() => {
    if (pendingCount > previousPending.current) list.current?.scrollToEnd();
    previousPending.current = pendingCount;
  }, [pendingCount, list]);

  // A search hit: read back to it if need be, then bring it into view. Once per hit.
  const focused = useRef<number | null>(null);
  useEffect(() => {
    if (focusSeq == null || focused.current === focusSeq || !channel || state.status !== 'ready') return;
    focused.current = focusSeq;
    void channel.loadBackTo(focusSeq).then((reached) => {
      if (!reached) return;
      const key = keyForSeq(channel.getState().transcript.items, focusSeq);
      // The rows read just now are on screen one frame from here.
      if (key) window.setTimeout(() => list.current?.scrollToKey(key), 60);
    });
  }, [focusSeq, channel, state.status, list]);

  const loadOlder = useCallback(() => {
    if (channel && !state.loadingOlder && transcript.hasOlder && !state.olderError) void channel.loadOlder();
  }, [channel, state.loadingOlder, state.olderError, transcript.hasOlder]);

  const quote = useQuoteSelection(frame, onQuote !== undefined);

  if (state.status === 'loading') return <TranscriptSkeleton />;

  const header =
    transcript.hasOlder || state.loadingOlder ? (
      <div className="wb-transcript__older" role="status">
        {state.olderError ? (
          <>
            <span>{t('workbench.transcript.olderFailed', { reason: describeError(state.olderError, t) })}</span>
            <Button size="sm" variant="tinted" onClick={() => void channel?.loadOlder()}>
              {t('common.retry')}
            </Button>
          </>
        ) : (
          <>
            <Spinner size={16} />
            <span>{t('workbench.transcript.loadingOlder')}</span>
          </>
        )}
      </div>
    ) : rows.length > 0 ? (
      <p className="wb-transcript__start">{t('workbench.transcript.start')}</p>
    ) : null;

  return (
    <div className="wb-transcript" ref={frame}>
      {rows.length === 0 && !footer ? (
        <div className="wb-transcript__empty">{empty}</div>
      ) : (
        <WindowedList
          ref={list}
          className="u-scroll"
          label={t('workbench.transcript.label')}
          items={rows}
          getKey={getKey}
          estimate={estimateRow}
          renderItem={renderItem}
          header={header}
          footer={footer}
          onNearStart={loadOlder}
          onFollowChange={setFollowing}
        />
      )}
      {!following && rows.length > 0 && (
        <button type="button" className="wb-jump" data-unread={unread || undefined} onClick={() => list.current?.scrollToEnd()} aria-label={unread ? t('workbench.transcript.jumpUnread') : t('workbench.transcript.jump')}>
          <ArrowDown size={20} aria-hidden="true" />
          {unread && <span className="wb-jump__label">{t('workbench.transcript.new')}</span>}
        </button>
      )}
      {quote.selection && onQuote && (
        <button
          type="button"
          className="wb-quote-pill"
          style={{ top: quote.selection.top, left: quote.selection.left }}
          // Keep the selection (and the keyboard, if it is up) while the pill is pressed.
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => {
            onQuote(quote.selection!.text);
            window.getSelection()?.removeAllRanges();
            quote.clear();
          }}
        >
          <TextQuote size={16} aria-hidden="true" />
          {t('workbench.quote.action')}
        </button>
      )}
      <ImageViewer images={viewer?.images ?? []} index={viewer?.index ?? 0} open={viewer !== null} onClose={() => setViewer(null)} onIndexChange={(index) => setViewer((current) => (current ? { ...current, index } : current))} />
    </div>
  );
}
