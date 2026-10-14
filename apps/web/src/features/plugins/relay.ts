import {
  type HostToPanelMessage,
  PANEL_CHANNEL,
  PANEL_PROTOCOL_VERSION,
  PLUGIN_LIMITS,
  type PanelContext,
  type PanelError,
  type PluginPanelRpcResponse,
  panelToHostMessageSchema,
} from '@agent-studio/protocol';

/**
 * The page's half of the panel protocol (`packages/protocol/src/plugins.ts`):
 * one relay per panel frame. It is the only thing a panel can talk to, so it
 * is written to be suspicious:
 *
 *  - a message is looked at only when it comes from this frame's window
 *    (`event.source`) **and** from an opaque origin (`event.origin === 'null'`),
 *    and parses with the protocol's schema; anything else is dropped without
 *    an answer;
 *  - a request whose JSON text is larger than the limit, or one beyond the
 *    number allowed in flight, is refused without calling the server;
 *  - every answer echoes the request's own id, once;
 *  - what is posted to the frame is only ever the panel's context (theme,
 *    language, project, the user's display name) and answers — never the
 *    grant, a token or anything else of the session. The frame's origin is
 *    opaque and cannot be named, so posts go to `'*'`, which is exactly why.
 *  - when the server says the panel's grant has expired (410), the request is
 *    answered with that code and the host is asked once to open the panel again.
 */

/** What the relay needs from the page around it. Injected, so the relay is a pure unit. */
export interface RelayDeps {
  /** The frame's window; null until the frame exists. */
  frameWindow: () => MessageEventSource | null;
  /** The panel's context as of now. */
  context: () => PanelContext;
  /**
   * Calls the plugin through the API (the host closes over the grant). Resolves with the
   * server's answer; rejects with the API error when the call itself failed.
   */
  call: (method: string, params: unknown) => Promise<PluginPanelRpcResponse>;
  /** The grant is no longer valid: open the panel again. Called at most once per relay. */
  onExpired: () => void;
  /** The panel asked for a height (already clamped to 0…20 000). */
  onResize?: (height: number) => void;
  /** The panel sent its first `ready`. */
  onReady?: () => void;
  /** How a message reaches the frame. Default: `target.postMessage(message, '*')`. */
  post?: (target: MessageEventSource, message: HostToPanelMessage) => void;
}

/** The parts of a `MessageEvent` the relay reads. */
export interface IncomingMessage {
  source: MessageEventSource | null;
  origin: string;
  data: unknown;
}

const MAX_ERROR_CODE = 64;
const MAX_ERROR_MESSAGE = 500;

/** The number of UTF-8 bytes of a value's JSON text, or null when it has none (a cycle, a BigInt, a function). */
export function jsonBytes(value: unknown): number | null {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    return null;
  }
  if (text === undefined) return null;
  return new TextEncoder().encode(text).length;
}

/** An error in the shape a panel accepts: bounded, plain strings. */
export function panelError(code: string, message: string): PanelError {
  return { code: code.slice(0, MAX_ERROR_CODE) || 'failed', message: message.slice(0, MAX_ERROR_MESSAGE) || 'The request failed.' };
}

function errorOf(error: unknown): PanelError {
  if (error && typeof error === 'object') {
    const { code, message } = error as { code?: unknown; message?: unknown };
    if (typeof code === 'string') return panelError(code, typeof message === 'string' ? message : '');
  }
  return panelError('failed', 'The request failed.');
}

const defaultPost = (target: MessageEventSource, message: HostToPanelMessage): void => {
  // An opaque origin cannot be named; nothing in `message` is a secret (see above).
  (target as Window).postMessage(message, '*');
};

export class PanelRelay {
  readonly #deps: RelayDeps;
  readonly #inFlight = new Set<string>();
  #disposed = false;
  #expired = false;
  #greeted = false;

  constructor(deps: RelayDeps) {
    this.#deps = deps;
  }

  /** Requests waiting for the server, for tests and the host's status line. */
  get pending(): number {
    return this.#inFlight.size;
  }

  /** Feed every `message` event of the window here; the relay decides whether it is for it. */
  handle(event: IncomingMessage): void {
    if (this.#disposed) return;
    const frame = this.#deps.frameWindow();
    // Only this frame, and only as the opaque origin a sandboxed panel must have.
    if (!frame || event.source !== frame || event.origin !== 'null') return;
    const parsed = panelToHostMessageSchema.safeParse(event.data);
    if (!parsed.success) return;
    const message = parsed.data;

    switch (message.type) {
      case 'ready':
        // A panel repeats `ready` until it is answered: every one gets an `init`.
        this.#post({ channel: PANEL_CHANNEL, v: PANEL_PROTOCOL_VERSION, type: 'init', context: this.#deps.context() });
        if (!this.#greeted) {
          this.#greeted = true;
          this.#deps.onReady?.();
        }
        return;
      case 'resize':
        this.#deps.onResize?.(Math.max(0, Math.min(20_000, message.height)));
        return;
      case 'request':
        this.#request(message.id, message.method, message.params, event.data);
        return;
    }
  }

  /** Theme, language or the project's name changed: tell the panel. */
  sendContext(): void {
    if (this.#disposed || !this.#greeted) return;
    this.#post({ channel: PANEL_CHANNEL, v: PANEL_PROTOCOL_VERSION, type: 'context', context: this.#deps.context() });
  }

  /** The frame is going away: nothing more is answered or posted. */
  dispose(): void {
    this.#disposed = true;
    this.#inFlight.clear();
  }

  #request(id: string, method: string, params: unknown, raw: unknown): void {
    // An id already waiting would make two answers with one id; the second request is dropped.
    if (this.#inFlight.has(id)) return;
    const size = jsonBytes(raw);
    if (size === null) return this.#answer(id, { ok: false, error: panelError('invalid_params', 'The request cannot be read as JSON.') });
    if (size > PLUGIN_LIMITS.maxPanelMessageBytes) return this.#answer(id, { ok: false, error: panelError('too_large', 'That request is too large.') });
    if (this.#inFlight.size >= PLUGIN_LIMITS.maxPanelPendingRequests) {
      return this.#answer(id, { ok: false, error: panelError('too_many_requests', 'Too many requests are waiting for an answer.') });
    }
    if (this.#expired) return this.#answer(id, { ok: false, error: panelError('panel_expired', 'This panel is no longer open. Open it again.') });

    this.#inFlight.add(id);
    this.#deps.call(method, params).then(
      (response) => {
        if (!this.#inFlight.delete(id)) return;
        this.#answer(id, response.ok ? { ok: true, result: response.result } : { ok: false, error: panelError(response.error.code, response.error.message) });
      },
      (error: unknown) => {
        if (!this.#inFlight.delete(id)) return;
        const failure = errorOf(error);
        this.#answer(id, { ok: false, error: failure });
        if (failure.code === 'panel_expired' && !this.#expired) {
          this.#expired = true;
          this.#deps.onExpired();
        }
      },
    );
  }

  #answer(id: string, outcome: { ok: true; result: unknown } | { ok: false; error: PanelError }): void {
    const message: HostToPanelMessage = outcome.ok
      ? { channel: PANEL_CHANNEL, v: PANEL_PROTOCOL_VERSION, type: 'response', id, ok: true, ...(outcome.result === undefined ? {} : { result: outcome.result }) }
      : { channel: PANEL_CHANNEL, v: PANEL_PROTOCOL_VERSION, type: 'response', id, ok: false, error: outcome.error };
    this.#post(message);
  }

  #post(message: HostToPanelMessage): void {
    if (this.#disposed) return;
    const frame = this.#deps.frameWindow();
    if (!frame) return;
    try {
      (this.#deps.post ?? defaultPost)(frame, message);
    } catch {
      /* the frame is gone or its content cannot be cloned: the panel will time out by itself */
    }
  }
}
