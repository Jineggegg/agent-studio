import os from 'node:os';
import type { GithubErrorCode } from '@agent-studio/protocol';
import { StudioError } from '../../kernel/errors.js';
import type { ProcessSupervisor, RunResult } from '../../kernel/process.js';
import { redactSecrets } from '../../kernel/redact.js';

/**
 * The only place that runs the GitHub command-line tool.
 *
 * The Studio has no GitHub credentials of its own. It runs `gh`, which is
 * signed in on the server, and reads what `gh` prints. It never asks `gh` for
 * the token, never looks at where `gh` keeps it, and never passes one in.
 *
 * Every call is fixed to github.com, has a time limit, cannot prompt, and
 * carries its request as JSON on standard input — so nothing that came from a
 * client is ever a command-line option or a "@file" field for `gh` to expand.
 * The few path segments that do appear in arguments are built only from values
 * that were validated against strict patterns first.
 */

export const GITHUB_HOST = 'github.com';

export interface GhTimeouts {
  read: number;
  merge: number;
  fix: number;
}

export const DEFAULT_GH_TIMEOUTS: Readonly<GhTimeouts> = { read: 20_000, merge: 60_000, fix: 30_000 };

export interface GhResponse {
  /** HTTP status GitHub answered with. */
  readonly status: number;
  /** Lower-cased header names. */
  readonly headers: Readonly<Record<string, string>>;
  /** The parsed body; null when there was none. */
  readonly body: unknown;
}

export function githubError(status: number, code: GithubErrorCode, message: string, details?: unknown): StudioError {
  return new StudioError(status, code, message, details);
}

/** One line of what a tool printed, safe to show: no control characters, nothing token-shaped, never a way round a refusal. */
export function cleanToolText(text: string, maxLength = 160): string {
  const line = redactSecrets(
    text
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]+/g, ' ')
      .replace(/\s+/g, ' ')
      // Where a tool keeps its files — its credentials above all — is nobody's business outside the server.
      .replace(/(?<![\w:/.])~?\/(?:[\w.@+-]+\/)+[\w.@+-]*/g, '[path]')
      .replace(/\b[A-Za-z]:\\[^\s"']+/g, '[path]')
      .trim(),
  )
    // Advice to override protection or to queue an automatic merge is never passed on.
    .replace(/[^.]*(--admin|--auto\b|administrator privileges|bypass)[^.]*\.?/gi, '')
    .trim();
  return line.length > maxLength ? `${line.slice(0, maxLength - 1)}…` : line;
}

const MAX_RUNNING = 3;
const MAX_WAITING = 24;

const ENV = {
  // Never open a browser, a pager, a prompt or an update notice.
  GH_PROMPT_DISABLED: '1',
  GH_NO_UPDATE_NOTIFIER: '1',
  GH_NO_EXTENSION_UPDATE_NOTIFIER: '1',
  GH_PAGER: 'cat',
  PAGER: 'cat',
  GH_BROWSER: 'false',
  BROWSER: 'false',
  NO_COLOR: '1',
  CLICOLOR: '0',
  GH_SPINNER_DISABLED: '1',
  LC_ALL: 'C.UTF-8',
} as const;

function parseHttp(stdout: string): GhResponse | null {
  const match = /^HTTP\/[\d.]+ (\d{3})[^\n]*\r?\n/.exec(stdout);
  if (!match) return null;
  const separator = /\r?\n\r?\n/.exec(stdout);
  const head = separator ? stdout.slice(match[0].length, separator.index) : stdout.slice(match[0].length);
  const rest = separator ? stdout.slice(separator.index + separator[0].length) : '';
  const headers: Record<string, string> = {};
  for (const line of head.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  let body: unknown = null;
  if (rest.trim().length > 0) {
    try {
      body = JSON.parse(rest);
    } catch {
      body = null;
    }
  }
  return { status: Number(match[1]), headers, body };
}

const messageOf = (body: unknown): string => (typeof (body as { message?: unknown } | null)?.message === 'string' ? (body as { message: string }).message : '');

export class GhRunner {
  readonly timeouts: GhTimeouts = { ...DEFAULT_GH_TIMEOUTS };
  readonly #processes: ProcessSupervisor;
  #running = 0;
  readonly #waiting: Array<() => void> = [];

  constructor(processes: ProcessSupervisor) {
    this.#processes = processes;
  }

  async #slot<T>(work: () => Promise<T>): Promise<T> {
    if (this.#running >= MAX_RUNNING) {
      if (this.#waiting.length >= MAX_WAITING) {
        throw githubError(503, 'github_busy', 'Too many GitHub requests are in progress. Try again in a moment.');
      }
      await new Promise<void>((resolve) => this.#waiting.push(resolve));
    }
    this.#running += 1;
    try {
      return await work();
    } finally {
      this.#running -= 1;
      this.#waiting.shift()?.();
    }
  }

  /** Runs `gh` with fixed arguments. Rejects only when the tool is not installed. */
  async run(args: readonly string[], options: { input?: string; timeoutMs: number }): Promise<RunResult> {
    return this.#slot(async () => {
      const env = this.#processes.env(ENV);
      // Should an operator have let these through to child processes: debugging output would print request
      // headers, and the others would send the request to another host or repository.
      for (const name of ['GH_DEBUG', 'DEBUG', 'GH_HOST', 'GH_REPO', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_FORCE_TTY', 'GH_CONFIG_DIR_OVERRIDE']) delete env[name];
      try {
        return await this.#processes.run('gh', args, {
          // A neutral directory: gh must never pick up a repository from wherever the server happens to stand.
          cwd: os.tmpdir(),
          env,
          timeoutMs: options.timeoutMs,
          maxOutputBytes: 8 * 1024 * 1024,
          ...(options.input === undefined ? {} : { input: options.input }),
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw githubError(503, 'github_tool_missing', 'The GitHub command-line tool (gh) is not installed on the server.');
        }
        throw error;
      }
    });
  }

  /** Turns a failed call into the fitting refusal. `write` calls that time out have an unknown outcome. */
  #failure(result: RunResult, response: GhResponse | null, write: boolean): StudioError {
    const stderr = result.stderr;
    const detail = cleanToolText(messageOf(response?.body) || stderr.replace(/^gh: /, ''));
    if (result.timedOut) {
      return write
        ? githubError(504, 'github_outcome_unknown', 'GitHub did not answer in time. The action may or may not have happened: reload before trying again.')
        : githubError(504, 'github_timeout', 'GitHub did not answer in time.');
    }
    const status = response?.status ?? Number(/\(HTTP (\d{3})\)/.exec(stderr)?.[1] ?? 0);
    if (result.code === 4 || /gh auth login|not logged in|no oauth token|authentication required|GH_TOKEN/i.test(stderr)) {
      return githubError(409, 'github_signed_out', 'The server is not signed in to GitHub.');
    }
    if (status === 401 || /bad credentials/i.test(stderr)) {
      return githubError(409, 'github_expired', "The server's GitHub login is no longer accepted. Sign in again on the server.");
    }
    if (status === 403 || status === 429) {
      if (response?.headers['x-github-sso'] !== undefined || /SAML|single sign-on|SSO/i.test(detail)) {
        return githubError(403, 'github_sso_required', "The organisation requires single sign-on, which the server's GitHub login has not been authorised for.");
      }
      if (response?.headers['x-ratelimit-remaining'] === '0' || response?.headers['retry-after'] !== undefined || /rate limit|abuse detection/i.test(detail)) {
        const retryAfter = Number(response?.headers['retry-after'] ?? 60);
        return githubError(429, 'github_rate_limited', 'GitHub is limiting requests from this account for the moment. Try again shortly.', {
          retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 3600) : 60,
        });
      }
      return githubError(403, 'github_forbidden', "The server's GitHub login is not allowed to do that.", { detail });
    }
    if (status === 404) return githubError(404, 'github_not_found', 'GitHub has no such repository or pull request, or the login may not see it.');
    if (status === 0 && /dial tcp|no such host|connection refused|connection reset|i\/o timeout|tls handshake|network is unreachable|could not resolve|EOF$|error connecting/i.test(stderr)) {
      return githubError(502, 'github_unreachable', 'The server cannot reach GitHub right now.');
    }
    return githubError(502, 'github_failed', 'GitHub could not complete that.', { status: status || null, detail });
  }

  /**
   * Calls the GitHub API through `gh api`. The endpoint must be built from
   * validated values only. The body, when there is one, travels as JSON on
   * standard input. Resolves with the response for any 2xx answer and throws
   * the fitting refusal otherwise — or returns the response for the statuses
   * listed in `accept`, for callers that want to interpret them.
   */
  async api(
    endpoint: string,
    options: { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: unknown; timeoutMs?: number; write?: boolean; accept?: readonly number[] } = {},
  ): Promise<GhResponse> {
    const method = options.method ?? (options.body === undefined ? 'GET' : 'POST');
    if (!/^[A-Za-z0-9._~/?&=%:+-]+$/.test(endpoint) || endpoint.startsWith('-') || endpoint.includes('..')) {
      throw new Error('Refusing to call GitHub with an endpoint that was not built from validated parts.');
    }
    const args = ['api', '--hostname', GITHUB_HOST, '--include', '--method', method, '-H', 'Accept: application/vnd.github+json'];
    if (options.body !== undefined) args.push('--input', '-');
    args.push(endpoint);
    const write = options.write ?? method !== 'GET';
    const result = await this.run(args, {
      timeoutMs: options.timeoutMs ?? this.timeouts.read,
      ...(options.body === undefined ? {} : { input: JSON.stringify(options.body) }),
    });
    const response = parseHttp(result.stdout);
    if (response && !result.timedOut && (options.accept ?? []).includes(response.status)) return response;
    if (result.code !== 0 || result.timedOut || !response || response.status >= 400) throw this.#failure(result, response, write);
    return response;
  }

  /**
   * Runs a GraphQL query or mutation. Returns the data together with any
   * errors GitHub attached, so that the caller can decide whether a partial
   * answer is good enough for what it is about to do.
   */
  async graphql<T>(query: string, variables: Record<string, unknown>, options: { timeoutMs?: number; write?: boolean } = {}): Promise<{ data: T | null; errors: string[]; partial: boolean }> {
    const write = options.write ?? false;
    const response = await this.api('graphql', { method: 'POST', body: { query, variables }, write, accept: [200], ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) });
    const body = response.body as { data?: T | null; errors?: Array<{ type?: string; message?: string }> } | null;
    const errors = body?.errors ?? [];
    const data = body?.data ?? null;
    if (errors.length > 0) {
      const types = errors.map((error) => error.type ?? '');
      const text = errors.map((error) => error.message ?? '').join(' ');
      if (types.includes('RATE_LIMITED') || /rate limit/i.test(text)) {
        throw githubError(429, 'github_rate_limited', 'GitHub is limiting requests from this account for the moment. Try again shortly.', { retryAfterSeconds: 60 });
      }
      const nothingUsable = data === null || Object.values(data as Record<string, unknown>).every((value) => value === null);
      if (nothingUsable) {
        if (types.includes('NOT_FOUND')) throw githubError(404, 'github_not_found', 'GitHub has no such repository or pull request, or the login may not see it.');
        if (/SAML|single sign-on/i.test(text)) throw githubError(403, 'github_sso_required', "The organisation requires single sign-on, which the server's GitHub login has not been authorised for.");
        if (types.includes('FORBIDDEN') || types.includes('INSUFFICIENT_SCOPES')) {
          throw githubError(403, 'github_forbidden', "The server's GitHub login is not allowed to do that.", { detail: cleanToolText(text) });
        }
        throw githubError(502, 'github_failed', 'GitHub could not complete that.', { status: response.status, detail: cleanToolText(text) });
      }
    }
    if (data === null) throw githubError(502, 'github_failed', 'GitHub sent an answer that could not be read.', { status: response.status, detail: '' });
    return { data, errors: errors.map((error) => cleanToolText(error.message ?? '')), partial: errors.length > 0 };
  }
}
