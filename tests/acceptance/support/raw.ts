import { connect } from 'node:net';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';

/**
 * Lower-level HTTP helpers for the perimeter tests. `fetch` normalises things
 * the tests want to control: a forged `Host` header, a request target that is
 * percent-encoded or in absolute-form, a body that arrives a byte at a time.
 * These send exactly what they are told over a raw socket or `node:http`.
 */

export interface RawResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

/** Sends a request whose path is used verbatim (not re-encoded) and whose Host can be overridden. */
export function rawRequest(opts: {
  port: number;
  method: string;
  path: string;
  host?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.host !== undefined) headers.host = opts.host;
    if (opts.body !== undefined && headers['content-length'] === undefined) {
      headers['content-length'] = String(Buffer.byteLength(opts.body));
    }
    let responded = false;
    const req = httpRequest(
      { host: '127.0.0.1', port: opts.port, method: opts.method, path: opts.path, headers },
      (res) => {
        responded = true;
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    // When the server rejects a large body it may reset the socket before we
    // finish writing (EPIPE/ECONNRESET). If the status line already arrived,
    // that write error is expected and harmless; only a pre-response error fails.
    req.on('error', (error) => {
      if (!responded) reject(error);
    });
    if (opts.body !== undefined) req.write(opts.body, () => {});
    req.end();
  });
}

/**
 * Opens a raw socket, sends `prelude`, then drips `rest` one byte at a time with
 * a gap between each, and resolves with how long the server kept the connection
 * open and whatever it sent back. Used to observe slow-request deadlines.
 */
export function trickle(opts: {
  port: number;
  prelude: string;
  rest: string;
  gapMs: number;
  giveUpMs: number;
}): Promise<{ closedAfterMs: number; response: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const socket = connect(opts.port, '127.0.0.1');
    const started = Date.now();
    let response = '';
    let index = 0;
    let timer: NodeJS.Timeout | null = null;
    const giveUp = setTimeout(() => {
      socket.destroy();
      resolve({ closedAfterMs: Date.now() - started, response, timedOut: true });
    }, opts.giveUpMs);
    const done = (timedOut: boolean) => {
      if (timer) clearTimeout(timer);
      clearTimeout(giveUp);
      resolve({ closedAfterMs: Date.now() - started, response, timedOut });
    };
    socket.on('connect', () => {
      socket.write(opts.prelude);
      const pump = () => {
        if (index >= opts.rest.length) return;
        socket.write(opts.rest[index]!);
        index += 1;
        timer = setTimeout(pump, opts.gapMs);
      };
      pump();
    });
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => (response += chunk));
    socket.on('close', () => done(false));
    socket.on('error', () => done(false));
    socket.on('end', () => done(false));
    socket.on('timeout', () => reject(new Error('socket timeout')));
  });
}
