import { create } from 'zustand';

/**
 * The step-up prompt: "confirm it's you".
 *
 * The HTTP client calls `requestReauth()` when the server answers
 * `403 reauth_required`; the dialog (features/auth/ReauthDialog) shows while
 * `pending` is true and settles the promise. Requests that arrive while the
 * dialog is already open share its outcome, so two refused requests produce
 * one prompt.
 */
interface ReauthState {
  pending: boolean;
}

export const useReauth = create<ReauthState>(() => ({ pending: false }));

let waiters: ((confirmed: boolean) => void)[] = [];

export function requestReauth(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    waiters.push(resolve);
    if (!useReauth.getState().pending) useReauth.setState({ pending: true });
  });
}

export function settleReauth(confirmed: boolean): void {
  const settled = waiters;
  waiters = [];
  useReauth.setState({ pending: false });
  for (const resolve of settled) resolve(confirmed);
}
