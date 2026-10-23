import { ReadAloud } from '../media/ReadAloud';
import { MessageBranchActions } from '../sessions/MessageBranchActions';
import type { Agent, AttachmentRef } from '@agent-studio/protocol';
import {
  Check,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleSlash,
  Clock,
  File as FileIcon,
  Info,
  ListChecks,
  MessageSquare,
  Square,
  TriangleAlert,
} from 'lucide-react';
import { Component, type ErrorInfo, type ReactNode, memo, useMemo, useState } from 'react';
import { HandoffNotice, isHandoffNotice } from '@/features/collab/handoff/HandoffNotice';
import { type MessageKey, useT } from '@/i18n';
import { Spinner } from '@/ui';
import { AgentMark, CopyButton } from '../chat/parts';
import { formatBytes } from '../composer/attachments';
import type { Outgoing } from '../composer/delivery';
import { modelLabel } from '../agents';
import { describeOutcome } from '../run/status';
import type {
  ApprovalItem,
  AssistantItem,
  LabelItem,
  NoticeItem,
  RunEndItem,
  TodosItem,
  TranscriptItem,
  UserItem,
} from './model';
import { StackView } from './ToolRows';
import { Prose } from './Prose';
import { splitStreamingMarkdown } from './streaming';

/** A message of the user's that is not in the log yet: being sent, or of unknown fate. */
export interface PendingUserRow {
  kind: 'pending';
  key: string;
  requestId: string;
  text: string;
  quote: string | null;
  attachments: AttachmentRef[];
  /** `creating` and `uploading` are the steps before a first message can be sent at all. */
  phase: Outgoing['phase'] | 'creating' | 'uploading';
  steer: boolean;
  createdAt: number;
}

export type TranscriptRow = TranscriptItem | PendingUserRow;

export interface RowContext {
  agents: readonly Agent[];
  /** The session's agent, for runs whose start is not loaded. */
  sessionAgentId: string | null;
  onReviewApproval: (approvalId: string) => void;
  onOpenImage: (attachments: AttachmentRef[], index: number) => void;
  /** The user's own id, to say "you" instead of naming who decided. */
  userId: string | null;
  /** The whole of a reply that came in several blocks, given the key of its last block. */
  proseOf: (key: string) => string;
  /** The conversation on show (a handoff's notice looks up its record by it). */
  sessionId?: string | null;
}

// ---- a failure in one row stays in that row -------------------------------------------

class RowBoundaryInner extends Component<
  { children: ReactNode; fallback: ReactNode; resetKey: string },
  { failed: boolean; resetKey: string }
> {
  override state = { failed: false, resetKey: this.props.resetKey };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  static getDerivedStateFromProps(
    props: { resetKey: string },
    state: { failed: boolean; resetKey: string },
  ) {
    // New content for the row is a new chance to draw it.
    return props.resetKey === state.resetKey ? null : { failed: false, resetKey: props.resetKey };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('A transcript row could not be drawn.', error, info.componentStack);
  }

  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** One row failing to render must not take the conversation with it. */
export function RowBoundary({ children, resetKey }: { children: ReactNode; resetKey: string }) {
  const t = useT();
  return (
    <RowBoundaryInner
      resetKey={resetKey}
      fallback={
        <div className="wb-row wb-row--broken" role="note">
          <CircleAlert size={16} aria-hidden="true" />
          <span>{t('workbench.row.broken')}</span>
        </div>
      }
    >
      {children}
    </RowBoundaryInner>
  );
}

// ---- pieces -----------------------------------------------------------------------------

function Attachments({
  attachments,
  onOpenImage,
}: {
  attachments: AttachmentRef[];
  onOpenImage: (attachments: AttachmentRef[], index: number) => void;
}) {
  const t = useT();
  if (attachments.length === 0) return null;
  const images = attachments.filter((attachment) => attachment.isImage);
  const files = attachments.filter((attachment) => !attachment.isImage);
  return (
    <div className="wb-attached">
      {images.length > 0 && (
        <div className="wb-attached__images">
          {images.map((image, index) => (
            <button
              key={image.id}
              type="button"
              className="wb-attached__image"
              onClick={() => onOpenImage(images, index)}
              aria-label={t('workbench.attachment.open', { name: image.name })}
            >
              <img src={image.url} alt="" loading="lazy" decoding="async" draggable={false} />
            </button>
          ))}
        </div>
      )}
      {files.map((file) => (
        <a key={file.id} className="wb-attached__file" href={file.url} download={file.name}>
          <FileIcon size={16} aria-hidden="true" />
          <span className="u-truncate">{file.name}</span>
          <span className="wb-attached__size">{formatBytes(file.size, t.number)}</span>
        </a>
      ))}
    </div>
  );
}

const ORIGIN_KEYS = {
  queued: 'workbench.message.origin.queued',
  steer: 'workbench.message.origin.steer',
  continue: 'workbench.message.origin.continue',
  scheduled: 'workbench.message.origin.scheduled',
  automation: 'workbench.message.origin.automation',
} as const;

const UserRow = memo(function UserRow({ item, context }: { item: UserItem; context: RowContext }) {
  const t = useT();
  const origin = item.origin === 'interactive' ? null : ORIGIN_KEYS[item.origin];
  return (
    <div className="wb-row wb-row--user">
      <Attachments attachments={item.attachments} onOpenImage={context.onOpenImage} />
      <div className="wb-bubble">
        {item.quote && <blockquote className="wb-bubble__quote">{item.quote}</blockquote>}
        {item.text !== '' && (
          <p className="wb-bubble__text" data-quotable="">
            {item.text}
          </p>
        )}
      </div>
      <div className="wb-row__meta">
        {origin && <span className="wb-row__tag">{t(origin)}</span>}
        <time dateTime={new Date(item.at).toISOString()}>{t.date(item.at, 'time')}</time>
        {item.text !== '' && <CopyButton text={item.text} label={t('workbench.message.copy')} />}
        {context.sessionId && (
          <MessageBranchActions
            sessionId={context.sessionId}
            seq={item.seq}
            text={item.text}
            role="user"
          />
        )}
      </div>
    </div>
  );
});

const PENDING_KEYS = {
  creating: 'workbench.delivery.creating',
  uploading: 'workbench.delivery.uploading',
  sending: 'workbench.delivery.sending',
  accepted: 'workbench.delivery.sending',
  unconfirmed: 'workbench.delivery.unconfirmed',
  checking: 'workbench.delivery.checking',
  failed: 'workbench.delivery.failed',
} as const;

const PendingRow = memo(function PendingRow({
  row,
  context,
}: {
  row: PendingUserRow;
  context: RowContext;
}) {
  const t = useT();
  const settled = row.phase === 'unconfirmed' || row.phase === 'failed';
  return (
    <div className="wb-row wb-row--user" data-pending={row.phase}>
      <Attachments attachments={row.attachments} onOpenImage={context.onOpenImage} />
      <div className="wb-bubble">
        {row.quote && <blockquote className="wb-bubble__quote">{row.quote}</blockquote>}
        {row.text !== '' && <p className="wb-bubble__text">{row.text}</p>}
      </div>
      <div className="wb-row__meta" role="status">
        {settled ? (
          <TriangleAlert size={14} aria-hidden="true" />
        ) : row.phase === 'accepted' ? null : (
          <Spinner size={14} />
        )}
        <span
          className="wb-row__pending"
          data-tone={
            row.phase === 'failed' ? 'danger' : row.phase === 'unconfirmed' ? 'warning' : undefined
          }
        >
          {row.steer && (row.phase === 'sending' || row.phase === 'accepted')
            ? t('workbench.delivery.steering')
            : t(PENDING_KEYS[row.phase])}
        </span>
      </div>
    </div>
  );
});

const LabelRow = memo(function LabelRow({
  item,
  context,
}: {
  item: LabelItem;
  context: RowContext;
}) {
  const agentId = item.agentId ?? context.sessionAgentId;
  const agent = context.agents.find((entry) => entry.id === agentId);
  const model = modelLabel(agent, item.model);
  return (
    <div className="wb-row wb-row--label">
      {agentId && <AgentMark agentId={agentId} size={22} />}
      <span className="wb-label__name">{agent?.displayName ?? agentId ?? ''}</span>
      {model && <span className="wb-label__model">{model}</span>}
    </div>
  );
});

/**
 * Prose that may still be arriving. While it streams, the blocks that are
 * complete are parsed once and kept; only the block being written is parsed
 * again, so an update costs the same however long the reply has become.
 */
function StreamingProse({ text, streaming }: { text: string; streaming: boolean }) {
  const parts = useMemo(() => (streaming ? splitStreamingMarkdown(text) : null), [streaming, text]);
  if (!parts) return <Prose>{text}</Prose>;
  return (
    <>
      {parts.settled.map((block, index) => (
        <Prose key={index}>{block}</Prose>
      ))}
      {parts.tail.trim() !== '' && <Prose>{parts.tail}</Prose>}
    </>
  );
}

const AssistantRow = memo(function AssistantRow({
  item,
  continues,
  proseOf,
  sessionId,
}: {
  sessionId?: string | null | undefined;
  item: AssistantItem;
  continues: boolean;
  proseOf: (key: string) => string;
}) {
  const t = useT();
  return (
    <div
      className="wb-row wb-row--assistant"
      data-streaming={item.streaming || undefined}
      data-continues={continues || undefined}
    >
      <div className="wb-prose" data-quotable="">
        <StreamingProse text={item.text} streaming={item.streaming} />
      </div>
      {/* A reply written in several blocks is one reply: the time and the copy control come once, at its end. */}
      {!item.streaming && (!continues || item.partial) && (
        <div className="wb-row__meta">
          {item.partial && (
            <span className="wb-row__tag" data-tone="warning">
              {t('workbench.message.partial')}
            </span>
          )}
          <time dateTime={new Date(item.at).toISOString()}>{t.date(item.at, 'time')}</time>
          <CopyButton text={() => proseOf(item.key)} label={t('workbench.message.copy')} />
          <ReadAloud text={proseOf(item.key)} />
          {sessionId && (
            <MessageBranchActions
              sessionId={sessionId}
              seq={item.seq}
              text={item.text}
              role="assistant"
            />
          )}
        </div>
      )}
    </div>
  );
});

const TodosRow = memo(function TodosRow({ item }: { item: TodosItem }) {
  const t = useT();
  const done = item.items.filter((entry) => entry.status === 'completed').length;
  return (
    <div className="wb-row wb-row--card">
      <div className="wb-card">
        <p className="wb-card__title">
          <ListChecks size={17} aria-hidden="true" />
          <span>{t('workbench.todos.title')}</span>
          <span className="wb-card__count u-tabular">
            {t('workbench.todos.progress', {
              done: t.number(done),
              total: t.number(item.items.length),
            })}
          </span>
        </p>
        <ul className="wb-todos">
          {item.items.map((entry, index) => (
            <li key={index} data-status={entry.status}>
              {entry.status === 'completed' ? (
                <CircleCheck size={17} aria-hidden="true" />
              ) : entry.status === 'in_progress' ? (
                <CircleDot size={17} aria-hidden="true" />
              ) : (
                <CircleDashed size={17} aria-hidden="true" />
              )}
              <span className="visually-hidden">
                {entry.status === 'completed'
                  ? t('workbench.todos.completed')
                  : entry.status === 'in_progress'
                    ? t('workbench.todos.inProgress')
                    : t('workbench.todos.pending')}
              </span>
              <span className="wb-todos__text">{entry.text}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
});

const NOTICE_TITLES: Record<string, MessageKey> = {
  compaction: 'workbench.notice.compaction',
  rate_limit: 'workbench.notice.rate_limit',
  approval_skipped: 'workbench.notice.approval_skipped',
  question_skipped: 'workbench.notice.question_skipped',
};

const NoticeRow = memo(function NoticeRow({
  item,
  sessionId,
}: {
  item: NoticeItem;
  sessionId: string | null;
}) {
  const t = useT();
  const Icon =
    item.level === 'error' ? CircleAlert : item.level === 'warning' ? TriangleAlert : Info;
  const title = NOTICE_TITLES[item.code];
  // A handoff to or from another agent: folded to one line, with its brief and the other conversation (features/collab).
  if (isHandoffNotice(item.code)) {
    return (
      <div className="wb-row wb-row--notice">
        <HandoffNotice code={item.code} text={item.text} seq={item.seq} sessionId={sessionId} />
      </div>
    );
  }
  return (
    <div className="wb-row wb-row--notice">
      <div className="wb-notice" data-level={item.level} role="note">
        <Icon size={16} aria-hidden="true" />
        <p>
          <strong>
            {title
              ? t(title)
              : item.level === 'error'
                ? t('workbench.notice.error')
                : item.level === 'warning'
                  ? t('workbench.notice.warning')
                  : t('workbench.notice.info')}
          </strong>
          <span>{item.text}</span>
        </p>
      </div>
    </div>
  );
});

/** A plan can run to pages; past this it starts folded. */
const PLAN_FOLD_CHARS = 1400;

const ApprovalRow = memo(function ApprovalRow({
  item,
  context,
}: {
  item: ApprovalItem;
  context: RowContext;
}) {
  const t = useT();
  const { approval } = item;
  const [unfolded, setUnfolded] = useState(false);
  const byYou = item.decidedBy !== null && item.decidedBy === context.userId;
  const pending = item.status === 'pending';

  const statusText = (() => {
    if (approval.kind === 'plan') {
      if (pending) return t('workbench.plan.waiting');
      if (item.status === 'allowed') return t('workbench.plan.approved');
      if (item.status === 'denied')
        return item.note
          ? t('workbench.plan.sentBackWithNote', { note: item.note })
          : t('workbench.plan.sentBack');
      return item.status === 'expired'
        ? t('workbench.approval.record.expired')
        : t('workbench.approval.record.cancelled');
    }
    if (approval.kind === 'question') {
      if (pending) return t('workbench.question.waiting');
      if (item.status === 'allowed') return t('workbench.question.answered');
      if (item.status === 'denied') return t('workbench.question.skipped');
      return item.status === 'expired'
        ? t('workbench.question.expired')
        : t('workbench.approval.record.cancelled');
    }
    if (pending) return t('workbench.approval.record.pending');
    if (item.status === 'allowed')
      return byYou
        ? t('workbench.approval.record.allowedByYou')
        : t('workbench.approval.record.allowed');
    if (item.status === 'denied')
      return item.note
        ? t('workbench.approval.record.deniedWithNote', { note: item.note })
        : t('workbench.approval.record.denied');
    return item.status === 'expired'
      ? t('workbench.approval.record.expired')
      : t('workbench.approval.record.cancelled');
  })();

  const StatusIcon = pending
    ? Clock
    : item.status === 'allowed'
      ? Check
      : item.status === 'denied'
        ? CircleSlash
        : CircleDashed;
  const plan = approval.plan ?? '';
  const long = plan.length > PLAN_FOLD_CHARS;

  return (
    <div className="wb-row wb-row--card">
      <div className="wb-card" data-pending={pending || undefined}>
        <p className="wb-card__title">
          {approval.kind === 'question' ? (
            <MessageSquare size={17} aria-hidden="true" />
          ) : (
            <ListChecks size={17} aria-hidden="true" />
          )}
          <span>
            {approval.kind === 'plan'
              ? t('workbench.plan.title')
              : approval.kind === 'question'
                ? t('workbench.question.title')
                : approval.title}
          </span>
        </p>
        {approval.kind === 'plan' && plan !== '' && (
          <div className="wb-plan" data-folded={(long && !unfolded) || undefined} data-quotable="">
            <Prose>{long && !unfolded ? `${plan.slice(0, PLAN_FOLD_CHARS)}…` : plan}</Prose>
          </div>
        )}
        {approval.kind === 'plan' && long && (
          <button type="button" className="wb-inline-button" onClick={() => setUnfolded(!unfolded)}>
            {unfolded ? t('workbench.plan.showLess') : t('workbench.plan.showAll')}
          </button>
        )}
        {approval.kind === 'question' && (
          <dl className="wb-answers">
            {(approval.questions ?? []).map((question) => {
              const answer = item.answers?.find((entry) => entry.questionId === question.id);
              const parts = answer
                ? [...answer.selected, ...(answer.other ? [answer.other] : [])]
                : [];
              return (
                <div key={question.id}>
                  <dt>{question.question}</dt>
                  <dd data-empty={parts.length === 0 || undefined}>
                    {parts.length > 0
                      ? t.list(parts)
                      : pending
                        ? t('workbench.question.waitingShort')
                        : t('workbench.question.notAnswered')}
                  </dd>
                </div>
              );
            })}
          </dl>
        )}
        {approval.kind === 'tool' && approval.command && (
          <pre className="wb-card__command">{approval.command}</pre>
        )}
        <p className="wb-card__status" data-status={item.status}>
          <StatusIcon size={15} aria-hidden="true" />
          <span>{statusText}</span>
          {pending && (
            <button
              type="button"
              className="wb-inline-button"
              onClick={() => context.onReviewApproval(approval.id)}
            >
              {t('workbench.approval.review')}
            </button>
          )}
        </p>
      </div>
    </div>
  );
});

const RunEndRow = memo(function RunEndRow({ item }: { item: RunEndItem }) {
  const t = useT();
  const outcome = describeOutcome(item.status, item.error, item.interruptedByRestart);
  const Icon =
    item.status === 'completed'
      ? Check
      : item.status === 'stopped'
        ? Square
        : item.status === 'interrupted'
          ? TriangleAlert
          : CircleAlert;
  const tokens = item.usage ? item.usage.inputTokens + item.usage.outputTokens : 0;
  const details = [
    item.durationMs >= 1000 ? t.duration(item.durationMs / 1000) : null,
    item.steps > 0 ? t.plural('workbench.run.steps', item.steps) : null,
    tokens > 0
      ? t('workbench.run.tokens', {
          count: t.number(tokens, { notation: 'compact', maximumFractionDigits: 1 }),
        })
      : null,
    item.usage?.costUsd != null && item.usage.costUsd > 0
      ? t.number(item.usage.costUsd, {
          style: 'currency',
          currency: 'USD',
          maximumFractionDigits: 4,
        })
      : null,
  ].filter((entry): entry is string => entry !== null);
  return (
    <div className="wb-row wb-row--end" data-tone={outcome.tone} role="note">
      <p className="wb-end__line">
        <Icon size={14} aria-hidden="true" />
        <span className="wb-end__title">{t(outcome.title)}</span>
        {details.map((detail) => (
          <span key={detail} className="wb-end__detail u-tabular">
            {detail}
          </span>
        ))}
      </p>
      {outcome.detail && <p className="wb-end__reason">{outcome.detail}</p>}
    </div>
  );
});

/**
 * Draws one row of the transcript. Rows are memoised: an unchanged item is not drawn again.
 * `next` is the row after it, which decides whether a block of prose is the end of a reply.
 */
export function renderRow(
  row: TranscriptRow,
  context: RowContext,
  next?: TranscriptRow,
): ReactNode {
  switch (row.kind) {
    case 'pending':
      return <PendingRow row={row} context={context} />;
    case 'user':
      return <UserRow item={row} context={context} />;
    case 'label':
      return <LabelRow item={row} context={context} />;
    case 'assistant':
      return (
        <AssistantRow
          sessionId={context.sessionId}
          item={row}
          continues={next?.kind === 'assistant' && next.runId === row.runId}
          proseOf={context.proseOf}
        />
      );
    case 'stack':
      return (
        <div className="wb-row wb-row--stack">
          <StackView item={row} onReview={context.onReviewApproval} />
        </div>
      );
    case 'todos':
      return <TodosRow item={row} />;
    case 'notice':
      return <NoticeRow item={row} sessionId={context.sessionId ?? null} />;
    case 'approval':
      return <ApprovalRow item={row} context={context} />;
    case 'run-end':
      return <RunEndRow item={row} />;
  }
}

/** A guess at a row's height before it is measured, so the scroll bar is roughly right from the start. */
export function estimateRow(row: TranscriptRow): number {
  switch (row.kind) {
    case 'pending':
    case 'user':
      return (
        64 +
        Math.min(12, Math.ceil(row.text.length / 60)) * 23 +
        (row.attachments.length > 0 ? 96 : 0)
      );
    case 'label':
      return 40;
    case 'assistant':
      return 48 + Math.min(60, Math.ceil(row.text.length / 70)) * 25;
    case 'stack':
      return 16 + Math.min(6, row.entries.length) * 44;
    case 'todos':
      return 60 + row.items.length * 30;
    case 'notice':
      return 52;
    case 'approval':
      return 140;
    case 'run-end':
      return 40;
  }
}
