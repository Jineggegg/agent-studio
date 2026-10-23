import { Dictation } from '../voice/Dictation';
import { AGENT_LIMITS } from '@agent-studio/protocol';
import {
  ArrowUp,
  ChevronDown,
  CornerDownRight,
  File as FileIcon,
  Folder,
  ListPlus,
  Paperclip,
  RotateCw,
  Square,
  TextQuote,
  TriangleAlert,
  X,
} from 'lucide-react';
import {
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useT } from '@/i18n';
import { useCanHover } from '@/platform/media';
import { useUnsavedWork } from '@/pwa/update';
import { Menu, Spinner, isImeConfirm } from '@/ui';
import { type PendingAttachment, type Rejection, formatBytes } from './attachments';
import { addFiles, removeAttachment, retryUpload, useAttachments } from './attachmentStore';
import { type DraftKey, sessionOfDraft, setDraft, useDrafts } from './drafts';
import {
  type MentionMatch,
  type MentionSource,
  type MentionToken,
  insertMention,
  mentionAt,
} from './mentions';

export interface ComposerHandle {
  focus(): void;
}

export interface ComposerSubmission {
  text: string;
  quote: string | null;
  whenBusy: 'queue' | 'steer';
}

export interface ComposerProps {
  draftKey: DraftKey;
  placeholder: string;
  /** A run is in progress: sending queues or steers, and an empty field offers Stop. */
  busy: boolean;
  /** The running agent can take a message into the turn in progress. */
  canSteer: boolean;
  /** An earlier message is still unsettled: nothing may be sent until it is. */
  blocked: boolean;
  /** Stop was asked for and has not taken effect yet. */
  stopping: boolean;
  /** Files may be attached here (the agent, and this user, allow it). */
  attachmentsEnabled: boolean;
  /**
   * Send what was written. Resolve true when it was taken (the field is then
   * emptied by whoever took it), false to leave everything where it is.
   */
  onSubmit: (submission: ComposerSubmission) => Promise<boolean> | boolean;
  onStop: () => void;
  /** Shift+Tab in the field: step to the next permission mode. */
  onCycleMode?: (() => void) | undefined;
  /** Text picked in the transcript, waiting to go out above the next message. */
  quote: string | null;
  onClearQuote: () => void;
  /** Agent, model and effort controls. */
  controls?: ReactNode;
  /** The project's files, for "@": typing `@name` offers them and inserts the chosen path. Absent outside a project. */
  mentions?: MentionSource | undefined;
  /** Whether the field holds anything (text, a file, a quote): lets the caller decide where Stop lives. */
  onContentChange?: (hasContent: boolean) => void;
  autoFocus?: boolean;
  /** A control drawn just before Send — "send later", from the automation feature. */
  accessory?: ReactNode;
  ref?: Ref<ComposerHandle>;
}

const EMPTY: PendingAttachment[] = [];

function rejectionText(rejections: readonly Rejection[], t: ReturnType<typeof useT>): string[] {
  const megabytes = Math.round(AGENT_LIMITS.attachmentBytes / (1024 * 1024));
  const lines: string[] = [];
  for (const rejection of rejections) {
    if (rejection.reason === 'too-large')
      lines.push(t('workbench.attach.tooLarge', { name: rejection.name, size: megabytes }));
    else if (rejection.reason === 'empty')
      lines.push(t('workbench.attach.empty', { name: rejection.name }));
  }
  const overflow = rejections.filter((rejection) => rejection.reason === 'too-many').length;
  if (overflow > 0)
    lines.push(
      t.plural('workbench.attach.tooMany', overflow, { max: AGENT_LIMITS.attachmentsPerMessage }),
    );
  return lines;
}

function AttachmentTile({
  attachment,
  held,
  onRemove,
  onRetry,
}: {
  attachment: PendingAttachment;
  held: boolean;
  onRemove: () => void;
  onRetry: () => void;
}) {
  const t = useT();
  const percent = Math.round(attachment.progress * 100);
  // In a conversation that does not exist yet a file is simply kept until the first message creates it:
  // nothing is in progress, so nothing is drawn as if it were.
  const status = held && attachment.status === 'waiting' ? 'held' : attachment.status;
  return (
    <li
      className="wb-tile"
      data-status={status}
      data-image={attachment.isImage && attachment.previewUrl ? '' : undefined}
    >
      {attachment.isImage && attachment.previewUrl ? (
        <img src={attachment.previewUrl} alt={attachment.name} draggable={false} />
      ) : (
        <span className="wb-tile__file">
          <FileIcon size={18} aria-hidden="true" />
          <span className="wb-tile__name u-truncate">{attachment.name}</span>
          <span className="wb-tile__size">{formatBytes(attachment.size, t.number)}</span>
        </span>
      )}
      {(status === 'uploading' || status === 'waiting') && (
        <span
          className="wb-tile__progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-label={t('workbench.attach.uploading', { name: attachment.name })}
        >
          <span
            style={{
              transform: `scaleX(${status === 'waiting' ? 0 : Math.max(0.04, attachment.progress)})`,
            }}
          />
        </span>
      )}
      {attachment.status === 'failed' && (
        <button
          type="button"
          className="wb-tile__retry"
          onClick={onRetry}
          disabled={!attachment.file}
          title={attachment.error ?? undefined}
          aria-label={t('workbench.attach.retry', { name: attachment.name })}
        >
          <RotateCw size={16} aria-hidden="true" />
        </button>
      )}
      <button
        type="button"
        className="wb-tile__remove"
        onClick={onRemove}
        aria-label={t('workbench.attach.remove', { name: attachment.name })}
      >
        <X size={14} aria-hidden="true" />
      </button>
    </li>
  );
}

/**
 * Where a message is written: a field that grows with its text, the files and
 * the quotation that will go with it, and one button that sends, queues,
 * steers or stops depending on what the agent is doing.
 */
export function Composer({
  draftKey,
  placeholder,
  busy,
  canSteer,
  blocked,
  stopping,
  attachmentsEnabled,
  onSubmit,
  onStop,
  onCycleMode,
  quote,
  onClearQuote,
  controls,
  mentions,
  onContentChange,
  autoFocus,
  accessory,
  ref,
}: ComposerProps) {
  const t = useT();
  const canHover = useCanHover();
  const field = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const modeAnchor = useRef<HTMLButtonElement>(null);
  const text = useDrafts((state) => state.texts[draftKey] ?? '');
  const attachments = useAttachments((state) => state.byKey[draftKey] ?? EMPTY);
  const [whenBusy, setWhenBusy] = useState<'queue' | 'steer'>('queue');
  const [modeMenu, setModeMenu] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [notices, setNotices] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  /** Set the instant a submission starts, before React has rendered anything: a second tap finds it taken. */
  const lock = useRef(false);
  const composing = useRef(false);
  const compositionEndedAt = useRef(-1000);
  const dragDepth = useRef(0);
  /** The "@name" being typed at the caret, and what the project has by that name. */
  const [mention, setMention] = useState<MentionToken | null>(null);
  const [matches, setMatches] = useState<readonly MentionMatch[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionState, setMentionState] = useState<'idle' | 'searching' | 'failed'>('idle');
  /** A mention put away with Escape stays away until its "@" is typed again. */
  const dismissedAt = useRef<number | null>(null);

  const failedText = t('workbench.attach.failed');
  const hasText = text.trim() !== '';
  const hasContent = hasText || attachments.length > 0;
  /** No conversation yet: files are kept here and go up with the first message. */
  const held = sessionOfDraft(draftKey) === null;
  const uploading = attachments.some(
    (attachment) => attachment.status === 'uploading' || (attachment.status === 'waiting' && !held),
  );
  const failed = attachments.filter((attachment) => attachment.status === 'failed');
  const tooLong = text.length > AGENT_LIMITS.messageChars;
  const steerable = busy && canSteer;
  const mode: 'queue' | 'steer' = steerable ? whenBusy : 'queue';

  useImperativeHandle(
    ref,
    () => ({ focus: () => field.current?.focus({ preventScroll: true }) }),
    [],
  );
  useUnsavedWork(hasContent);

  useEffect(() => {
    onContentChange?.(hasContent || quote !== null);
    // Only the fact matters, not the callback's identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasContent, quote !== null]);

  useEffect(() => {
    if (autoFocus) field.current?.focus({ preventScroll: true });
    // On arrival only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey]);

  // Grows with the text up to a share of the screen, then scrolls inside itself.
  useLayoutEffect(() => {
    const element = field.current;
    if (!element) return;
    element.style.height = 'auto';
    const limit = Math.max(120, Math.min(280, Math.round(window.innerHeight * 0.34)));
    element.style.height = `${Math.min(element.scrollHeight, limit)}px`;
    element.style.overflowY = element.scrollHeight > limit ? 'auto' : 'hidden';
  }, [text]);

  // ---- "@" ----------------------------------------------------------------------

  const syncMention = useCallback(
    (value: string, caret: number | null, selectionEnd: number | null) => {
      if (!mentions || caret === null || caret !== selectionEnd || composing.current)
        return setMention(null);
      const found = mentionAt(value, caret);
      if (!found) dismissedAt.current = null;
      setMention(found && dismissedAt.current !== found.start ? found : null);
    },
    [mentions],
  );

  const mentionQuery = mention?.query ?? null;
  useEffect(() => {
    setMentionIndex(0);
    if (!mentions || mentionQuery === null || mentionQuery.trim() === '') {
      setMatches([]);
      setMentionState('idle');
      return;
    }
    // Only the newest answer counts: an earlier, slower one is cancelled, not shown late.
    const controller = new AbortController();
    setMentionState('searching');
    const timer = window.setTimeout(() => {
      mentions.search(mentionQuery, controller.signal).then(
        (found) => {
          if (controller.signal.aborted) return;
          setMatches(found.slice(0, 10));
          setMentionState('idle');
        },
        () => {
          if (controller.signal.aborted) return;
          setMatches([]);
          setMentionState('failed');
        },
      );
    }, 140);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [mentions, mentionQuery]);

  const chooseMention = useCallback(
    (match: MentionMatch) => {
      if (!mention) return;
      const current = useDrafts.getState().texts[draftKey] ?? '';
      const next = insertMention(
        current,
        mention,
        match.kind === 'directory' ? `${match.path}/` : match.path,
      );
      setDraft(draftKey, next.text);
      setMention(null);
      window.requestAnimationFrame(() => {
        const element = field.current;
        if (!element) return;
        element.focus({ preventScroll: true });
        element.setSelectionRange(next.caret, next.caret);
      });
    },
    [mention, draftKey],
  );

  const submit = useCallback(async () => {
    if (lock.current || blocked) return;
    const current = useDrafts.getState().texts[draftKey] ?? '';
    const files = useAttachments.getState().byKey[draftKey] ?? EMPTY;
    if (current.trim() === '' && files.length === 0) return;
    if (current.length > AGENT_LIMITS.messageChars) return;
    lock.current = true;
    setSubmitting(true);
    try {
      const taken = await onSubmit({ text: current, quote, whenBusy: mode });
      if (taken) {
        setNotices([]);
        // Steering is chosen for one message at a time: the next one waits its turn again unless told otherwise.
        setWhenBusy('queue');
      }
    } finally {
      lock.current = false;
      setSubmitting(false);
    }
  }, [blocked, draftKey, mode, onSubmit, quote]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention && !composing.current && !isImeConfirm(event)) {
      // While files are on offer the arrows, Enter and Tab belong to the list; Escape puts it away and nothing else.
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        dismissedAt.current = mention.start;
        return setMention(null);
      }
      if (matches.length > 0) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          return setMentionIndex(
            (index) =>
              (index + (event.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length,
          );
        }
        if (
          (event.key === 'Enter' || event.key === 'Tab') &&
          !event.shiftKey &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey
        ) {
          event.preventDefault();
          return chooseMention(matches[Math.min(mentionIndex, matches.length - 1)]!);
        }
      }
    }
    if (event.key === 'Tab' && event.shiftKey && onCycleMode && !composing.current) {
      event.preventDefault();
      onCycleMode();
      return;
    }
    if (event.key !== 'Enter') return;
    // Enter that confirms an input-method candidate is never a send — including the browsers that end
    // the composition a few milliseconds before they deliver the key.
    if (
      composing.current ||
      isImeConfirm(event) ||
      event.timeStamp - compositionEndedAt.current < 80
    ) {
      if (!composing.current && !isImeConfirm(event)) event.preventDefault();
      return;
    }
    const chord = event.metaKey || event.ctrlKey;
    if (event.shiftKey || event.altKey) return;
    // With a keyboard, Enter sends. On a touch keyboard Enter is a new line and the button sends.
    if (!chord && !canHover) return;
    event.preventDefault();
    void submit();
  };

  const offer = useCallback(
    async (files: readonly File[]) => {
      if (files.length === 0) return;
      const result = await addFiles(draftKey, files, { failed: failedText });
      setNotices(rejectionText(result.rejected, t));
    },
    [draftKey, failedText, t],
  );

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!attachmentsEnabled) return;
    const files = [...event.clipboardData.files];
    if (files.length === 0) return;
    // A paste that carries both puts the text in the field and attaches the picture.
    if (event.clipboardData.getData('text/plain') === '') event.preventDefault();
    void offer(files);
  };

  const onPick = (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])];
    event.target.value = '';
    void offer(files);
    field.current?.focus({ preventScroll: true });
  };

  const hasFiles = (event: DragEvent) => [...event.dataTransfer.types].includes('Files');
  const dragHandlers = attachmentsEnabled
    ? {
        onDragEnter: (event: DragEvent) => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          dragDepth.current += 1;
          setDragging(true);
        },
        onDragOver: (event: DragEvent) => {
          if (hasFiles(event)) event.preventDefault();
        },
        onDragLeave: (event: DragEvent) => {
          if (!hasFiles(event)) return;
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragging(false);
        },
        onDrop: (event: DragEvent) => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          void offer([...event.dataTransfer.files]);
        },
      }
    : {};

  // Pressing a control must not take the focus — and with it the keyboard — away from the field.
  const keepFocus = {
    onPointerDown: (event: { preventDefault: () => void }) => event.preventDefault(),
  };

  const showStop = busy && !hasContent;
  const sendDisabled = !showStop && (!hasContent || blocked || tooLong || failed.length > 0);
  const sendLabel = showStop
    ? stopping
      ? t('workbench.composer.stopping')
      : t('workbench.composer.stop')
    : busy
      ? mode === 'steer'
        ? t('workbench.composer.steer')
        : t('workbench.composer.queue')
      : t('workbench.composer.send');

  return (
    <div className="wb-composer" data-dragging={dragging || undefined} {...dragHandlers}>
      {quote !== null && (
        <div className="wb-composer__quote">
          <TextQuote size={16} aria-hidden="true" />
          <p>{quote}</p>
          <button
            type="button"
            className="wb-chip-close"
            onClick={onClearQuote}
            aria-label={t('workbench.quote.remove')}
            {...keepFocus}
          >
            <X size={15} aria-hidden="true" />
          </button>
        </div>
      )}
      {mention && mentions && (
        <div
          className="wb-mentions"
          id={`mentions-${draftKey}`}
          role="listbox"
          aria-label={t('workbench.mention.label')}
        >
          {matches.length > 0 ? (
            matches.map((match, index) => {
              const folder = match.path.includes('/')
                ? match.path.slice(0, match.path.lastIndexOf('/'))
                : '';
              return (
                <button
                  key={match.path}
                  type="button"
                  role="option"
                  id={`mentions-${draftKey}-${index}`}
                  className="wb-mentions__item"
                  aria-selected={index === Math.min(mentionIndex, matches.length - 1)}
                  onClick={() => chooseMention(match)}
                  onPointerMove={() => setMentionIndex(index)}
                  {...keepFocus}
                >
                  {match.kind === 'directory' ? (
                    <Folder size={16} aria-hidden="true" />
                  ) : (
                    <FileIcon size={16} aria-hidden="true" />
                  )}
                  <span className="wb-mentions__name u-truncate">{match.name}</span>
                  {folder && <span className="wb-mentions__folder u-truncate">{folder}</span>}
                </button>
              );
            })
          ) : (
            <p className="wb-mentions__note">
              {mention.query.trim() === ''
                ? t('workbench.mention.hint')
                : mentionState === 'searching'
                  ? t('workbench.mention.searching')
                  : mentionState === 'failed'
                    ? t('workbench.mention.failed')
                    : t('workbench.mention.none', { query: mention.query })}
            </p>
          )}
        </div>
      )}
      <label className="visually-hidden" htmlFor={`composer-${draftKey}`}>
        {placeholder}
      </label>
      <textarea
        ref={field}
        id={`composer-${draftKey}`}
        className="wb-composer__field"
        rows={1}
        value={text}
        placeholder={placeholder}
        enterKeyHint={canHover ? 'send' : 'enter'}
        autoCapitalize="sentences"
        spellCheck
        aria-invalid={tooLong || undefined}
        aria-autocomplete={mentions ? 'list' : undefined}
        aria-controls={mention ? `mentions-${draftKey}` : undefined}
        aria-activedescendant={
          mention && matches.length > 0
            ? `mentions-${draftKey}-${Math.min(mentionIndex, matches.length - 1)}`
            : undefined
        }
        onChange={(event) => {
          setDraft(draftKey, event.target.value);
          syncMention(event.target.value, event.target.selectionStart, event.target.selectionEnd);
        }}
        onSelect={(event) =>
          syncMention(
            event.currentTarget.value,
            event.currentTarget.selectionStart,
            event.currentTarget.selectionEnd,
          )
        }
        onBlur={() => setMention(null)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onCompositionStart={() => {
          composing.current = true;
          setMention(null);
        }}
        onCompositionEnd={(event) => {
          composing.current = false;
          compositionEndedAt.current = event.timeStamp;
          syncMention(
            event.currentTarget.value,
            event.currentTarget.selectionStart,
            event.currentTarget.selectionEnd,
          );
        }}
      />
      {attachments.length > 0 && (
        <ul className="wb-composer__tiles" aria-label={t('workbench.attach.list')}>
          {attachments.map((attachment) => (
            <AttachmentTile
              key={attachment.localId}
              attachment={attachment}
              held={held}
              onRemove={() => removeAttachment(draftKey, attachment.localId)}
              onRetry={() => retryUpload(draftKey, attachment.localId, { failed: failedText })}
            />
          ))}
        </ul>
      )}
      {(notices.length > 0 || failed.length > 0 || tooLong) && (
        <div className="wb-composer__notices" role="alert">
          {tooLong && (
            <p>
              <TriangleAlert size={15} aria-hidden="true" />
              {t('workbench.composer.tooLong', { max: t.number(AGENT_LIMITS.messageChars) })}
            </p>
          )}
          {failed.map((attachment) => (
            <p key={attachment.localId}>
              <TriangleAlert size={15} aria-hidden="true" />
              {t('workbench.attach.failedNamed', {
                name: attachment.name,
                reason: attachment.error ?? failedText,
              })}
            </p>
          ))}
          {notices.map((notice) => (
            <p key={notice}>
              <TriangleAlert size={15} aria-hidden="true" />
              {notice}
            </p>
          ))}
        </div>
      )}
      <div className="wb-composer__bar">
        {attachmentsEnabled && (
          <>
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              tabIndex={-1}
              aria-hidden="true"
              onChange={onPick}
            />
            <button
              type="button"
              className="wb-bar-button"
              onClick={() => picker.current?.click()}
              aria-label={t('workbench.attach.add')}
              title={t('workbench.attach.add')}
              {...keepFocus}
            >
              <Paperclip size={20} aria-hidden="true" />
            </button>
          </>
        )}
        <Dictation key={draftKey} draftKey={draftKey} disabled={blocked || submitting} />
        <div className="wb-composer__controls">{controls}</div>
        {steerable && hasContent && (
          <>
            <button
              ref={modeAnchor}
              type="button"
              className="wb-chip"
              aria-haspopup="menu"
              aria-expanded={modeMenu}
              onClick={() => setModeMenu(!modeMenu)}
              {...keepFocus}
            >
              <span>
                {mode === 'steer' ? t('workbench.composer.steer') : t('workbench.composer.queue')}
              </span>
              <ChevronDown size={14} aria-hidden="true" />
            </button>
            <Menu
              open={modeMenu}
              onClose={() => setModeMenu(false)}
              anchor={modeAnchor}
              label={t('workbench.composer.whileRunning')}
              align="end"
              items={[
                {
                  id: 'queue',
                  label: t('workbench.composer.queue'),
                  hint: t('workbench.composer.queueHint'),
                  icon: <ListPlus size={18} />,
                  checked: mode === 'queue',
                  onSelect: () => setWhenBusy('queue'),
                },
                {
                  id: 'steer',
                  label: t('workbench.composer.steer'),
                  hint: t('workbench.composer.steerHint'),
                  icon: <CornerDownRight size={18} />,
                  checked: mode === 'steer',
                  onSelect: () => setWhenBusy('steer'),
                },
              ]}
            />
          </>
        )}
        {accessory}
        <button
          type="button"
          className="wb-send"
          data-kind={showStop ? 'stop' : busy ? mode : 'send'}
          disabled={showStop ? stopping : sendDisabled}
          aria-label={sendLabel}
          title={showStop && canHover ? t('workbench.composer.stopHint') : sendLabel}
          onClick={() => (showStop ? onStop() : void submit())}
          {...keepFocus}
        >
          {showStop ? (
            stopping ? (
              <Spinner size={18} />
            ) : (
              <Square size={16} fill="currentColor" aria-hidden="true" />
            )
          ) : submitting || uploading ? (
            <Spinner size={18} />
          ) : busy ? (
            mode === 'steer' ? (
              <CornerDownRight size={20} aria-hidden="true" />
            ) : (
              <ListPlus size={20} aria-hidden="true" />
            )
          ) : (
            <ArrowUp size={21} strokeWidth={2.4} aria-hidden="true" />
          )}
        </button>
      </div>
      {dragging && (
        <div className="wb-composer__drop" aria-hidden="true">
          <Paperclip size={20} />
          {t('workbench.attach.drop')}
        </div>
      )}
    </div>
  );
}
