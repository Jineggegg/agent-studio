import type { PermissionMode } from '@agent-studio/protocol';
import { requireBrowser } from '../../kernel/http.js';
import type { Principal } from '../../kernel/principal.js';

/** The modes an API token may choose: those that ask a person at least as often as `ask`. */
const TOKEN_PERMISSION_MODES: ReadonlySet<PermissionMode> = new Set(['ask', 'plan']);

/**
 * A token may make an agent ask more, never less: choosing `accept-edits` or
 * `auto` — for a new session, a message, a scheduled message, an automation,
 * a task or a handoff — is for the person who answers the questions, in a
 * signed-in browser. Modes left out are not checked.
 */
export function requireBrowserToLoosen(
  principal: Pick<Principal, 'via'>,
  ...modes: readonly (PermissionMode | undefined)[]
): void {
  if (modes.some((mode) => mode !== undefined && !TOKEN_PERMISSION_MODES.has(mode))) requireBrowser(principal);
}
