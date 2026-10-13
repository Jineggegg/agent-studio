import type { ComponentType } from 'react';

/**
 * Other ways to sign in, shown under the password form.
 *
 * A method registers a component; the sign-in screen renders it only when the
 * component itself decides it can work here (it returns null otherwise), so
 * there is never a dead button.
 */
export interface SignInMethodProps {
  /** Another sign-in attempt is in flight: disable yourself. */
  disabled: boolean;
  /** Tell the screen you are working (it disables the password form) or done. */
  onBusyChange: (busy: boolean) => void;
  /** Show a message in the screen's single error region; null clears it. */
  onMessage: (message: { tone: 'danger' | 'neutral'; text: string } | null) => void;
}

export interface SignInMethod {
  id: string;
  order?: number;
  Component: ComponentType<SignInMethodProps>;
}

const methods: SignInMethod[] = [];

export function registerSignInMethod(method: SignInMethod): void {
  if (methods.some((existing) => existing.id === method.id)) throw new Error(`The sign-in method "${method.id}" is registered twice.`);
  methods.push(method);
}

export function signInMethods(): SignInMethod[] {
  return [...methods].sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
}
