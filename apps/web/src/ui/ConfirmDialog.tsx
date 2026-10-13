import { type ReactNode, useState } from 'react';
import { create } from 'zustand';
import { useT } from '@/i18n';
import { Button } from './Button';
import { Sheet } from './Sheet';

export interface ConfirmDialogProps {
  open: boolean;
  /** Phrased as a question: "Remove this project?" */
  title: string;
  /** One sentence saying exactly what will and will not be affected. */
  message?: ReactNode;
  /** Names the action: "Remove", "Sign out" — never "OK". */
  confirmLabel: string;
  cancelLabel?: string;
  /** `danger` for anything destructive or hard to undo. */
  tone?: 'default' | 'danger';
  /** May return a promise: the dialog shows it is working and cannot be dismissed until it settles. */
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
  /** Extra content under the message (a field, a list of consequences). */
  children?: ReactNode;
}

/** Asks before anything destructive or irreversible. Escape and the backdrop cancel. */
export function ConfirmDialog({ open, title, message, confirmLabel, cancelLabel, tone = 'default', onConfirm, onCancel, children }: ConfirmDialogProps) {
  const t = useT();
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    if (busy) return;
    const result = onConfirm();
    if (!(result instanceof Promise)) return;
    setBusy(true);
    try {
      await result;
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={onCancel} title={title} hideTitle size="sm" flush role="alertdialog" dismissible={!busy}>
      <div className="ui-confirm">
        <p className="ui-confirm__title" aria-hidden="true">
          {title}
        </p>
        {message && <p className="ui-confirm__message">{message}</p>}
        {children && <div className="ui-confirm__extra">{children}</div>}
      </div>
      <div className="ui-confirm__actions">
        <Button variant="neutral" onClick={onCancel} disabled={busy} data-autofocus={tone === 'danger' ? '' : undefined}>
          {cancelLabel ?? t('common.cancel')}
        </Button>
        <Button variant={tone === 'danger' ? 'danger' : 'primary'} onClick={() => void confirm()} loading={busy} data-autofocus={tone === 'danger' ? undefined : ''}>
          {confirmLabel}
        </Button>
      </div>
    </Sheet>
  );
}

// ---- imperative form ---------------------------------------------------------

export interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: 'default' | 'danger';
}

interface ConfirmRequest extends ConfirmOptions {
  resolve: (confirmed: boolean) => void;
}

const useConfirmStore = create<{ request: ConfirmRequest | null; open: boolean }>(() => ({ request: null, open: false }));

/**
 * Ask from anywhere, without keeping dialog state:
 *
 *   if (await confirm({ title: t('…'), message: t('…'), confirmLabel: t('common.remove'), tone: 'danger' })) { … }
 *
 * Needs `<ConfirmHost />` mounted once (the app shell does that).
 */
export function confirm(options: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    useConfirmStore.getState().request?.resolve(false);
    useConfirmStore.setState({ request: { ...options, resolve }, open: true });
  });
}

export function ConfirmHost() {
  const { request, open } = useConfirmStore();
  if (!request) return null;
  const settle = (confirmed: boolean) => {
    request.resolve(confirmed);
    useConfirmStore.setState({ open: false });
  };
  return (
    <ConfirmDialog
      open={open}
      title={request.title}
      message={request.message}
      confirmLabel={request.confirmLabel}
      {...(request.cancelLabel ? { cancelLabel: request.cancelLabel } : {})}
      tone={request.tone ?? 'default'}
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    />
  );
}
