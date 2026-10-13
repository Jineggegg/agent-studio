import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { useT } from '@/i18n';

export type ToastKind = 'info' | 'success' | 'warning' | 'error';

export interface ToastOptions {
  title: string;
  /** A second line. */
  detail?: string;
  kind?: ToastKind;
  /** An action inside the toast: Undo, Retry, Refresh. Choosing it dismisses the toast. */
  action?: { label: string; onSelect: () => void };
  /**
   * Milliseconds on screen, or `'persistent'` to stay until acted on.
   * Default by kind: a plain note 3 s; with an action or a detail line 6 s; warnings and errors 7 s.
   */
  duration?: number | 'persistent';
  /** A toast with the same id replaces the one showing — use it for "one instance" notices. */
  id?: string;
}

interface ToastRecord extends ToastOptions {
  id: string;
  kind: ToastKind;
  closing: boolean;
  createdAt: number;
}

const useToasts = create<{ toasts: ToastRecord[] }>(() => ({ toasts: [] }));
const MAX_VISIBLE = 3;
let counter = 0;

export function toastDuration(options: ToastOptions): number | null {
  if (options.duration === 'persistent') return null;
  if (typeof options.duration === 'number') return options.duration;
  const kind = options.kind ?? 'info';
  if (kind === 'error' || kind === 'warning') return 7_000;
  if (options.action || options.detail) return 6_000;
  return 3_000;
}

function show(options: ToastOptions): string {
  const id = options.id ?? `toast-${(counter += 1)}`;
  const record: ToastRecord = { ...options, id, kind: options.kind ?? 'info', closing: false, createdAt: Date.now() };
  useToasts.setState(({ toasts }) => {
    const others = toasts.filter((toast) => toast.id !== id);
    // Oldest non-persistent ones make room.
    while (others.filter((toast) => !toast.closing).length >= MAX_VISIBLE) {
      const victim = others.find((toast) => !toast.closing && toast.duration !== 'persistent') ?? others.find((toast) => !toast.closing);
      if (!victim) break;
      others.splice(others.indexOf(victim), 1);
    }
    return { toasts: [...others, record] };
  });
  return id;
}

function dismiss(id: string): void {
  useToasts.setState(({ toasts }) => ({ toasts: toasts.map((toast) => (toast.id === id ? { ...toast, closing: true } : toast)) }));
  window.setTimeout(() => {
    useToasts.setState(({ toasts }) => ({ toasts: toasts.filter((toast) => !(toast.id === id && toast.closing)) }));
  }, 200);
}

type Extra = Omit<ToastOptions, 'title' | 'kind'>;

/**
 * Brief confirmations and notices.
 *
 *   toast.success(t('home.project.created'));
 *   toast.show({ title: t('sessions.archived'), action: { label: t('common.undo'), onSelect: restore } });
 *   toast.error(describeError(error, t));
 */
export const toast = {
  show,
  dismiss,
  info: (title: string, extra?: Extra) => show({ ...extra, title, kind: 'info' }),
  success: (title: string, extra?: Extra) => show({ ...extra, title, kind: 'success' }),
  warning: (title: string, extra?: Extra) => show({ ...extra, title, kind: 'warning' }),
  error: (title: string, extra?: Extra) => show({ ...extra, title, kind: 'error' }),
  /** For tests. */
  clear: () => useToasts.setState({ toasts: [] }),
};

const ICONS = { info: Info, success: CircleCheck, warning: TriangleAlert, error: CircleAlert } as const;

function ToastItem({ record }: { record: ToastRecord }) {
  const t = useT();
  const [paused, setPaused] = useState(false);
  const remaining = useRef(toastDuration(record));
  const Icon = ICONS[record.kind];

  useEffect(() => {
    if (record.closing || paused || remaining.current === null) return;
    const started = Date.now();
    const timer = window.setTimeout(() => dismiss(record.id), remaining.current);
    return () => {
      window.clearTimeout(timer);
      if (remaining.current !== null) remaining.current = Math.max(800, remaining.current - (Date.now() - started));
    };
  }, [paused, record.closing, record.id]);

  return (
    <div
      className="ui-toast"
      data-kind={record.kind}
      data-state={record.closing ? 'closing' : 'open'}
      role={record.kind === 'error' ? 'alert' : 'status'}
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <span className="ui-toast__icon">
        <Icon size={20} aria-hidden="true" />
      </span>
      <div className="ui-toast__text">
        <p className="ui-toast__title">{record.title}</p>
        {record.detail && <p className="ui-toast__detail">{record.detail}</p>}
      </div>
      {record.action && (
        <button
          type="button"
          className="ui-toast__action"
          onClick={() => {
            const action = record.action;
            dismiss(record.id);
            action?.onSelect();
          }}
        >
          {record.action.label}
        </button>
      )}
      {record.duration === 'persistent' && (
        <button type="button" className="ui-toast__close" aria-label={t('common.dismiss')} onClick={() => dismiss(record.id)}>
          <X size={18} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

/** Where toasts appear. Mounted once by the app shell. */
export function ToastViewport() {
  const t = useT();
  const toasts = useToasts((state) => state.toasts);
  return (
    <div className="ui-toasts" role="region" aria-label={t('common.notices')}>
      {toasts.map((record) => (
        <ToastItem key={`${record.id}:${record.createdAt}`} record={record} />
      ))}
    </div>
  );
}
