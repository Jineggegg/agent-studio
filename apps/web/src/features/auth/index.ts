import { registerSignInMethod } from '@/registry';
import { PasskeySignIn } from './PasskeySignIn';

/** Passkeys are one more way to sign in; the button shows itself only where they can work. */
registerSignInMethod({ id: 'passkey', order: 10, Component: PasskeySignIn });
