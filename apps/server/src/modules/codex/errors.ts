import { redactSecrets } from '../../kernel/redact.js';
import { AgentRunError } from '../agents/adapter.js';
import { ProcessEnded, ProtocolError, RequestTimeout, RpcError } from './client.js';
import type { TurnError } from './protocol.js';

/**
 * Turning what can go wrong with a Codex run into one sentence a person can
 * act on. Only these texts reach the user; raw upstream bodies, request ids
 * and paths of the service account stay in the server log.
 */

export const SIGN_IN_HINT = 'Open a terminal with the "Codex sign-in" launcher (it runs `codex login`) and sign in.';

// eslint-disable-next-line no-control-regex -- terminal escape sequences are control characters by definition
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/** Text from the CLI made fit to show: no escape codes, no credentials, one bounded line. */
export function tidy(text: string, limit = 400): string {
  const clean = redactSecrets(text.replace(ANSI, '').replace(CONTROL, ' '))
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

/** The last lines of the error stream that say something, redacted. Empty when there is nothing worth showing. */
export function stderrSummary(stderr: string, limit = 400): string {
  const lines = stderr
    .replace(ANSI, '')
    .split('\n')
    .map((line) => line.trim())
    // A start-up remark of the CLI that is not about the failure.
    .filter((line) => line !== '' && !/could not create PATH aliases/i.test(line));
  return tidy(lines.slice(-4).join(' '), limit);
}

interface ErrorInfo {
  readonly kind: string | null;
  readonly httpStatus: number | null;
}

/** `codexErrorInfo` is a name, or an object with the name as its only key and details inside. */
export function readErrorInfo(info: unknown): ErrorInfo {
  if (typeof info === 'string') return { kind: info, httpStatus: null };
  if (info !== null && typeof info === 'object') {
    const [kind, detail] = Object.entries(info as Record<string, unknown>)[0] ?? [];
    const status = (detail as { httpStatusCode?: unknown } | null | undefined)?.httpStatusCode;
    return { kind: kind ?? null, httpStatus: typeof status === 'number' ? status : null };
  }
  return { kind: null, httpStatus: null };
}

const looksLikeJson = (text: string): boolean => /^\s*[{[]/.test(text);

/** A turn the CLI reported as failed. */
export function turnFailure(error: TurnError | null | undefined, context: { model: string | null }): AgentRunError {
  const message = error?.message ?? '';
  const { kind, httpStatus } = readErrorInfo(error?.codexErrorInfo);
  const all = `${message} ${error?.additionalDetails ?? ''}`;

  if (kind === 'unauthorized' || httpStatus === 401 || /\b401\b.*unauthorized|not (logged|signed) in|sign(ing)? in again/i.test(all)) {
    return new AgentRunError('not_signed_in', `Codex is not signed in, or its sign-in has expired. ${SIGN_IN_HINT}`);
  }
  if (kind === 'usageLimitExceeded' || /usage limit/i.test(message)) {
    const detail = looksLikeJson(message) ? '' : ` Codex says: ${tidy(message, 300)}`;
    return new AgentRunError('usage_limit', `The usage limit of the Codex account has been reached.${detail}`);
  }
  if (/model_not_found|does not exist or you do not have access|model .* (is )?not (supported|available)/i.test(all)) {
    const which = context.model ? `the model "${context.model}"` : 'the chosen model';
    return new AgentRunError('model_unavailable', `Codex cannot use ${which}: it does not exist, or this account has no access to it. Choose another model for this session.`);
  }
  if (kind === 'rateLimitExceeded' || httpStatus === 429) {
    return new AgentRunError('rate_limited', 'Codex is being rate limited by its service. Wait a moment and send the message again.');
  }
  if (kind === 'contextWindowExceeded' || /context (window|length)/i.test(message)) {
    return new AgentRunError('context_too_long', 'The conversation no longer fits in the model\'s context window. Start a new session, or ask Codex to compact the conversation.');
  }
  if (kind === 'serverOverloaded' || kind === 'internalServerError' || (httpStatus !== null && httpStatus >= 500)) {
    return new AgentRunError('service_unavailable', 'The service behind Codex is having trouble right now. Try again in a little while.');
  }
  if (kind === 'sandboxError') {
    return new AgentRunError('sandbox_error', `Codex could not set up its sandbox for a command.${message && !looksLikeJson(message) ? ` It says: ${tidy(message, 300)}` : ''}`);
  }
  if (kind === 'responseStreamDisconnected' || kind === 'httpConnectionFailed' || kind === 'responseStreamConnectionFailed' || kind === 'responseTooManyFailedAttempts' || /stream disconnected|connection (failed|closed|reset)|network error/i.test(message)) {
    return new AgentRunError('connection_lost', 'Codex lost its connection to the model and gave up after several attempts. Check the network and send the message again.');
  }
  if (message.trim() !== '' && !looksLikeJson(message)) return new AgentRunError('agent_error', `Codex stopped with an error: ${tidy(message, 300)}`);
  return new AgentRunError('agent_error', 'Codex stopped with an error it did not explain.');
}

/** True when a request to reopen a conversation failed because Codex no longer has it. */
export function isThreadNotFound(error: unknown): boolean {
  return error instanceof RpcError && /no rollout found|thread not found|not found for thread|invalid (session|thread) id|no such thread/i.test(error.message);
}

/** Anything else that ended a run: the process went away, wrote nonsense, refused a request, or went quiet. */
export function runFailure(error: unknown, context: { stderr: string; during: string }): AgentRunError {
  if (error instanceof AgentRunError) return error;
  if (error instanceof ProcessEnded) {
    if (error.spawnCode === 'ENOENT') {
      return new AgentRunError('not_installed', 'The Codex command-line tool is not installed for the account this Studio runs as. Install it (`npm install -g @openai/codex`) and sign in.');
    }
    if (error.spawnCode !== null) return new AgentRunError('agent_error', `Codex could not be started (${error.spawnCode}).`);
    const said = stderrSummary(context.stderr);
    if (/not (logged|signed) in|401 unauthorized|please (log|sign) in/i.test(said)) {
      return new AgentRunError('not_signed_in', `Codex is not signed in. ${SIGN_IN_HINT}`);
    }
    const how = error.signal ? `was stopped by ${error.signal}` : `exited with code ${error.code ?? 'unknown'}`;
    return new AgentRunError('agent_error', `Codex ${how} ${context.during}.${said ? ` Its last words: ${said}` : ''}`);
  }
  if (error instanceof ProtocolError) {
    return new AgentRunError('protocol_error', 'Codex sent something the Studio could not read, so the run was stopped. The installed Codex version may be newer than this Studio knows.');
  }
  if (error instanceof RequestTimeout) {
    return new AgentRunError('agent_timeout', `Codex did not answer in time ${context.during}.`);
  }
  if (error instanceof RpcError) {
    if (/not (logged|signed) in|authentication required|unauthorized/i.test(error.message)) {
      return new AgentRunError('not_signed_in', `Codex is not signed in. ${SIGN_IN_HINT}`);
    }
    return new AgentRunError('agent_error', `Codex refused a request ${context.during}: ${tidy(error.message, 300)}`);
  }
  // Not something this module produced: let the runtime log it and show its generic failure.
  throw error;
}
