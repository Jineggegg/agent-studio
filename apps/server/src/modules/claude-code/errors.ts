import { redactSecrets } from '../../kernel/redact.js';
import { AgentRunError } from '../agents/adapter.js';
import type { ApiErrorMessage, CliResult } from './translate.js';

/**
 * Turns the ways Claude Code can fail into errors a person can act on.
 *
 * Stable codes (the client may map them to an action):
 *
 * - `not_installed`      no `claude` command on the service's PATH
 * - `cli_incompatible`   the installed CLI does not understand an option the Studio passes
 * - `not_signed_in`      fix: the terminal launcher `claude-login`
 * - `rate_limited`       the account's usage limit is reached
 * - `model_unavailable`  the chosen model does not exist for this account
 * - `billing`            the account cannot be charged
 * - `overloaded`         the model service is overloaded or down
 * - `bridge_unavailable` the CLI could not reach the Studio's own tools
 * - `agent_protocol`     the CLI printed something that is not its machine-readable format
 * - `agent_crashed`      the CLI died before it finished
 * - `agent_error`        anything else the CLI reported
 *
 * Every message is redacted and bounded: the CLI's own sentences and the tail
 * of its error output may be shown, a credential that slipped into them may not.
 */

/** The launcher of the terminal module that signs Claude Code in. */
export const SIGN_IN_LAUNCHER = 'claude-login';

export const NOT_INSTALLED_MESSAGE =
  'Claude Code is not installed on this computer: there is no "claude" command on the service\'s PATH. Install Claude Code, then sign in from the terminal ("Claude Code sign-in").';
export const NOT_SIGNED_IN_MESSAGE = `Claude Code is not signed in on this computer. Open the terminal and start "Claude Code sign-in" (launcher ${SIGN_IN_LAUNCHER}), then send the message again.`;

const DETAIL_CHARS = 600;

/** Text from the CLI made fit to show: credentials masked, control characters and colour codes removed, bounded. */
export function presentable(raw: string, max = DETAIL_CHARS): string {
  const plain = redactSecrets(raw)
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, ' · ')
    .trim();
  return plain.length <= max ? plain : `${plain.slice(0, max - 1)}…`;
}

/** The end of the CLI's error output, where the reason usually is. */
export function stderrTail(stderr: string): string {
  return presentable(stderr.trim().split('\n').slice(-6).join('\n'));
}

const RESUME_NOT_FOUND = /no conversation found with session id|--resume requires a valid session id/i;
const SIGNED_OUT = /not logged in|please run \/login|claude auth login|invalid api key|invalid bearer token|oauth token (has )?(expired|been revoked)|authentication[_ ]error/i;
const LIMIT_REACHED = /usage limit|hit your limit|limit reached|rate limit/i;
const BILLING = /credit balance|billing/i;
const OVERLOADED = /overloaded/i;
const UNKNOWN_OPTION = /unknown option|error: option .* (argument|is invalid)|unknown command/i;
const BRIDGE = /permission-prompt-tool|mcp tool .* not found|mcp server .*studio/i;

/** True when the CLI says the conversation it was asked to resume does not exist. */
export function isResumeNotFound(result: CliResult | null, stderr: string): boolean {
  if (result && result.isError && result.errors.some((entry) => RESUME_NOT_FOUND.test(entry))) return true;
  return result === null && RESUME_NOT_FOUND.test(stderr);
}

export interface FailureContext {
  readonly model: string | null;
}

/** A turn the CLI finished with `is_error`. */
export function errorFromResult(result: CliResult, apiError: ApiErrorMessage | null, context: FailureContext): AgentRunError {
  const said = (apiError?.text || result.text || result.errors.join(' · ')).trim();
  const kind = apiError?.kind ?? null;
  const status = result.apiErrorStatus;

  if (kind === 'authentication_failed' || status === 401 || SIGNED_OUT.test(said)) {
    return new AgentRunError('not_signed_in', NOT_SIGNED_IN_MESSAGE);
  }
  if (kind === 'model_not_found' || (status === 404 && /model/i.test(said)) || /issue with the selected model/i.test(said)) {
    const named = context.model ? `"${presentable(context.model, 120)}"` : 'chosen for this session';
    return new AgentRunError('model_unavailable', `The model ${named} is not available to this Claude Code account. Choose another model and send the message again.`);
  }
  if (kind === 'rate_limit' || status === 429 || LIMIT_REACHED.test(said)) {
    return new AgentRunError('rate_limited', `Claude's usage limit has been reached${said ? ` — Claude Code says: ${presentable(said, 300)}` : '.'}`);
  }
  if (kind === 'billing_error' || BILLING.test(said)) {
    return new AgentRunError('billing', `Claude Code could not use the account's plan or credit${said ? `: ${presentable(said, 300)}` : '.'}`);
  }
  if (kind === 'server_error' || status === 529 || (status !== null && status >= 500) || OVERLOADED.test(said)) {
    return new AgentRunError('overloaded', `The model service is not answering right now${said ? `: ${presentable(said, 300)}` : '.'} Try again in a moment.`);
  }
  if (result.subtype === 'error_max_turns') {
    return new AgentRunError('agent_error', 'Claude Code stopped because it reached its limit of steps for one turn. Send "continue" to let it carry on.');
  }
  return new AgentRunError('agent_error', said ? `Claude Code reported a problem: ${presentable(said)}` : 'Claude Code reported a problem and gave no detail.');
}

export interface ExitFacts {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  /** The end of the error output, redacted as a whole before it was cut to length. */
  readonly stderr: string;
  /** The first line of standard output that was not JSON, if any. */
  readonly strayLine: string | null;
  /** Starting the program itself failed (`ENOENT`, `EACCES`, …). */
  readonly spawnError: string | null;
}

/** The CLI ended without ever printing a result. */
export function errorFromExit(facts: ExitFacts): AgentRunError {
  const tail = stderrTail(facts.stderr);
  if (facts.spawnError !== null) {
    if (/ENOENT/.test(facts.spawnError)) return new AgentRunError('not_installed', NOT_INSTALLED_MESSAGE);
    return new AgentRunError('agent_error', `Claude Code could not be started: ${presentable(facts.spawnError, 200)}`);
  }
  if (UNKNOWN_OPTION.test(facts.stderr)) {
    return new AgentRunError('cli_incompatible', `The installed Claude Code does not understand how the Studio starts it (${tail}). Update Claude Code and try again.`);
  }
  if (SIGNED_OUT.test(facts.stderr)) return new AgentRunError('not_signed_in', NOT_SIGNED_IN_MESSAGE);
  if (BRIDGE.test(facts.stderr)) {
    return new AgentRunError('bridge_unavailable', `Claude Code could not connect to the Studio's own tools, so no permission could have been asked: ${tail}`);
  }
  if (facts.strayLine !== null) {
    return new AgentRunError('agent_protocol', `Claude Code printed something the Studio could not read and then stopped: "${presentable(facts.strayLine, 200)}"${tail ? ` (${tail})` : ''}`);
  }
  if (facts.signal !== null) {
    return new AgentRunError('agent_crashed', `Claude Code was stopped by the system (${facts.signal}) before it finished${tail ? `: ${tail}` : '.'}`);
  }
  if (facts.code !== 0) {
    return new AgentRunError('agent_crashed', `Claude Code ended with an error (exit code ${facts.code ?? 'unknown'})${tail ? `: ${tail}` : ' and said nothing about why.'}`);
  }
  return new AgentRunError('agent_crashed', 'Claude Code ended without finishing its answer.');
}
