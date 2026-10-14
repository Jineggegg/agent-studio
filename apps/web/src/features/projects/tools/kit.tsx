import { FILES_CHANGED, GIT_CHANGED, type FilesChangedEvent, type GitChangedEvent, filesChangedEventSchema, gitChangedEventSchema, projectTopic } from '@agent-studio/protocol';
import { ChevronDown, X } from 'lucide-react';
import {
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { isApiError } from '@/data/api';
import { describeError } from '@/data/errors';
import { useOnReconnect, useRealtimeTopic } from '@/data/realtime';
import { type Translator, useT } from '@/i18n';
import { Banner, IconButton, isImeConfirm } from '@/ui';
import './tools.css';

/**
 * What every project tool shares: how a panel is laid out, how a row gives up
 * its actions to a sideways swipe, how a failure is told (a sentence, with
 * the tool's own wording folded away underneath), and how a tool hears that
 * the project changed.
 */

// ---- live changes ------------------------------------------------------------------

export interface ProjectEventHandlers {
  onFiles?: (event: FilesChangedEvent) => void;
  onGit?: (event: GitChangedEvent) => void;
  /** The live connection was down for a while: whatever is on screen may have missed something. */
  onReconnect?: () => void;
}

/** Hear what changes in a project instead of asking over and over. Pass null to stay unsubscribed. */
export function useProjectEvents(projectId: string | null, handlers: ProjectEventHandlers): void {
  const ref = useRef(handlers);
  useEffect(() => {
    ref.current = handlers;
  });
  useRealtimeTopic(projectId ? projectTopic(projectId) : null, (event) => {
    if (event.type === FILES_CHANGED) {
      const parsed = filesChangedEventSchema.safeParse(event.data);
      if (parsed.success) ref.current.onFiles?.(parsed.data);
    } else if (event.type === GIT_CHANGED) {
      const parsed = gitChangedEventSchema.safeParse(event.data);
      if (parsed.success) ref.current.onGit?.(parsed.data);
    }
  });
  useOnReconnect(() => ref.current.onReconnect?.());
}

// ---- failures ----------------------------------------------------------------------

export interface Problem {
  /** One sentence in the reader's language. */
  text: string;
  /** What the tool on the server said, already cleaned of anything secret. */
  detail?: string | undefined;
  /** The server's stable code, for deciding what to offer next. */
  code?: string | undefined;
}

function detailOf(error: unknown): string | undefined {
  if (!isApiError(error)) return undefined;
  const details = error.details as { output?: unknown; detail?: unknown; files?: unknown } | null | undefined;
  const parts: string[] = [];
  if (typeof details?.output === 'string' && details.output.trim() !== '') parts.push(details.output.trim());
  if (typeof details?.detail === 'string' && details.detail.trim() !== '') parts.push(details.detail.trim());
  if (Array.isArray(details?.files)) parts.push(details.files.filter((file): file is string => typeof file === 'string').join('\n'));
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

/** A failure as the tools show it: the translated sentence, and the server's own wording kept for the curious. */
export function problemOf(error: unknown, t: Translator): Problem {
  const text = describeError(error, t);
  const detail = detailOf(error);
  // When the sentence is our translation, the server's own (often more specific) sentence is worth keeping too.
  const said = isApiError(error) && error.status > 0 && error.message && error.message !== text ? error.message : undefined;
  const combined = [said, detail].filter(Boolean).join('\n\n');
  return { text, ...(combined ? { detail: combined } : {}), ...(isApiError(error) ? { code: error.code } : {}) };
}

/** True for "the person cancelled the password prompt": nothing happened and nothing needs saying. */
export const wasCancelled = (error: unknown): boolean => isApiError(error) && (error.code === 'reauth_cancelled' || error.code === 'aborted');

/** Technical wording, folded away. */
export function Details({ children, label }: { children: string; label?: string }) {
  const t = useT();
  return (
    <details className="pt-details">
      <summary>
        <ChevronDown size={14} aria-hidden="true" />
        {label ?? t('tools.details')}
      </summary>
      <pre tabIndex={0}>{children}</pre>
    </details>
  );
}

export interface ProblemNoteProps {
  problem: Problem;
  title?: string;
  tone?: 'danger' | 'warning';
  onDismiss?: (() => void) | undefined;
  action?: ReactNode;
}

/** A refusal or failure, said once in words. Never a bare "failed". */
export function ProblemNote({ problem, title, tone = 'danger', onDismiss, action }: ProblemNoteProps) {
  const t = useT();
  return (
    <div className="pt-problem">
      <Banner
        tone={tone}
        role="alert"
        {...(title ? { title } : {})}
        {...(onDismiss ? { action: <IconButton label={t('common.dismiss')} icon={<X size={18} />} tone="secondary" onClick={onDismiss} /> } : {})}
      >
        {problem.text}
        {problem.detail && <Details>{problem.detail}</Details>}
        {/* The way out goes under the sentence, so a long label never squeezes the sentence into a column. */}
        {action && <div className="pt-problem__actions">{action}</div>}
      </Banner>
    </div>
  );
}

// ---- a row that gives up its actions to a swipe ----------------------------------------

export interface SwipeAction {
  id: string;
  label: string;
  icon?: ReactNode;
  tone?: 'neutral' | 'accent' | 'warning' | 'danger';
  onSelect: () => void;
}

const ACTION_WIDTH = 76;
let closeOpenSwipe: (() => void) | null = null;

export interface SwipeRowProps {
  /** Revealed by sliding the row towards the leading edge with a finger. The same actions must also be in the row's menu. */
  actions: readonly SwipeAction[];
  children: ReactNode;
  className?: string;
  role?: string;
}

/**
 * Touch only: sliding a row sideways uncovers its two or three most used
 * actions. A mouse never triggers it, a vertical scroll never does, and the
 * tap that ends a swipe does not also activate the row.
 */
export function SwipeRow({ actions, children, className, role }: SwipeRowProps) {
  const row = useRef<HTMLDivElement>(null);
  const slider = useRef<HTMLDivElement>(null);
  const [revealed, setRevealed] = useState(false);
  const width = actions.length * ACTION_WIDTH;
  const gesture = useRef<{ id: number; x: number; y: number; origin: number; decided: 'none' | 'swipe' | 'scroll'; lastX: number; lastTime: number; velocity: number } | null>(null);
  /** Until when a click is the end of a swipe rather than a tap (a browser sends none after a finger that moved, so the window is short). */
  const swallowClick = useRef(0);

  const settle = useCallback(
    (open: boolean) => {
      const element = slider.current;
      if (element) {
        row.current?.removeAttribute('data-swiping');
        row.current?.setAttribute('data-settling', '');
        element.style.transform = open ? `translateX(${-width}px)` : '';
        window.setTimeout(() => row.current?.removeAttribute('data-settling'), 260);
      }
      setRevealed(open);
    },
    [width],
  );
  const close = useCallback(() => settle(false), [settle]);

  useEffect(() => {
    if (!revealed) return;
    closeOpenSwipe?.();
    closeOpenSwipe = close;
    const onPointerDown = (event: PointerEvent) => {
      if (row.current && event.target instanceof Node && !row.current.contains(event.target)) close();
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      if (closeOpenSwipe === close) closeOpenSwipe = null;
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [revealed, close]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (actions.length === 0 || event.pointerType === 'mouse') return;
    swallowClick.current = 0;
    gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY, origin: revealed ? -width : 0, decided: 'none', lastX: event.clientX, lastTime: event.timeStamp, velocity: 0 };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = gesture.current;
    const element = slider.current;
    if (!state || state.id !== event.pointerId || !element) return;
    const dx = event.clientX - state.x;
    const dy = event.clientY - state.y;
    if (state.decided === 'none') {
      if (Math.abs(dy) > 8 && Math.abs(dy) >= Math.abs(dx)) {
        state.decided = 'scroll';
        return;
      }
      if (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(dy) * 1.4) return;
      state.decided = 'swipe';
      swallowClick.current = Number.POSITIVE_INFINITY;
      row.current?.removeAttribute('data-settling');
      row.current?.setAttribute('data-swiping', '');
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
    if (state.decided !== 'swipe') return;
    state.velocity = (event.clientX - state.lastX) / Math.max(1, event.timeStamp - state.lastTime);
    state.lastX = event.clientX;
    state.lastTime = event.timeStamp;
    let offset = state.origin + dx;
    if (offset > 0) offset = offset / 5;
    else if (offset < -width) offset = -width + (offset + width) / 4;
    element.style.transform = `translateX(${offset}px)`;
  };
  const onPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = gesture.current;
    if (!state || state.id !== event.pointerId) return;
    gesture.current = null;
    if (state.decided !== 'swipe') return;
    swallowClick.current = performance.now() + 400;
    const offset = state.origin + (event.clientX - state.x);
    settle(event.type === 'pointercancel' ? revealed : state.velocity < -0.35 ? true : state.velocity > 0.35 ? false : offset < -width / 2);
  };
  const onClickCapture = (event: ReactMouseEvent) => {
    if (performance.now() < swallowClick.current) {
      swallowClick.current = 0;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (revealed && !(event.target as Element).closest('.pt-swipe__actions')) {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };

  return (
    <div ref={row} className={className ? `pt-swipe ${className}` : 'pt-swipe'} role={role} data-revealed={revealed || undefined} onClickCapture={onClickCapture}>
      {actions.length > 0 && (
        <div className="pt-swipe__actions" inert={!revealed} aria-hidden={!revealed}>
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              className="ui-row__action"
              data-tone={action.tone ?? 'neutral'}
              onClick={() => {
                close();
                action.onSelect();
              }}
            >
              {action.icon}
              <span>{action.label}</span>
            </button>
          ))}
        </div>
      )}
      <div ref={slider} className="pt-swipe__slider" style={actions.length > 0 ? { touchAction: 'pan-y' } : undefined} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd}>
        {children}
      </div>
    </div>
  );
}

// ---- a name typed in place -----------------------------------------------------------

export interface InlineNameFieldProps {
  label: string;
  initial: string;
  /** Select the name without its extension, so typing replaces the part people mean to change. */
  selectStem?: boolean;
  busy?: boolean;
  /** Why the last attempt was refused; the field stays open under it. */
  problem?: string | null;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}

/** A name edited where it will appear. Enter confirms, Escape gives up; a refusal keeps the field open and says why. */
export function InlineNameField({ label, initial, selectStem, busy, problem, onSubmit, onCancel }: InlineNameFieldProps) {
  const [value, setValue] = useState(initial);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const element = field.current;
    if (!element) return;
    element.focus({ preventScroll: true });
    const dot = selectStem ? initial.lastIndexOf('.') : -1;
    element.setSelectionRange(0, dot > 0 ? dot : initial.length);
    element.scrollIntoView({ block: 'nearest' });
    // On arrival only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && !isImeConfirm(event)) {
      event.preventDefault();
      if (!busy) onSubmit(value);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    }
  };
  return (
    <div className="pt-name">
      <input
        ref={field}
        className="pt-name__field"
        value={value}
        aria-label={label}
        aria-invalid={problem ? true : undefined}
        disabled={busy}
        autoCapitalize="none"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="done"
        maxLength={255}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {problem && (
        <p className="pt-name__problem" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}

/** A panel's centred message: nothing here, not available, not allowed. */
export function Stage({ children }: { children: ReactNode }) {
  return <div className="pt-stage">{children}</div>;
}

/** "main.ts" from "src/app/main.ts", and the folder it lives in. */
export function splitPath(path: string): { name: string; folder: string } {
  const index = path.lastIndexOf('/');
  return index === -1 ? { name: path, folder: '' } : { name: path.slice(index + 1), folder: path.slice(0, index) };
}

/** A path as two parts, so a long folder can shrink while the file's own name stays readable. */
export function PathLabel({ path }: { path: string }) {
  const { name, folder } = splitPath(path);
  return (
    <span className="pt-path">
      <span className="pt-path__name">{name}</span>
      {folder && <span className="pt-path__folder">{folder}</span>}
    </span>
  );
}

/** Starts a download the browser handles itself: same-origin address, cookie session, no script in between. */
export function startDownload(url: string, filename?: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.download = filename ?? '';
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

/**
 * One file's patch without git's own preamble (`diff --git`, `index`, `---`,
 * `+++`): the row or title above it already names the file. A patch with no
 * hunk — a rename, a mode change — is left as it is, since the preamble is
 * then all there is to read.
 */
export function hunksOnly(patch: string): string {
  const at = patch.search(/^@@ /m);
  return at <= 0 ? patch : patch.slice(at);
}
