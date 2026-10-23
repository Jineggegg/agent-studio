import { badRequest, unavailable } from '../../kernel/errors.js';
import { checkUrl, guardedRequest, readBody } from '../../kernel/net.js';

export const BROWSER_NETWORK_LIMITS = {
  requestBytes: 256 * 1024,
  responseBytes: 6 * 1024 * 1024,
  requests: 300,
  bytes: 40 * 1024 * 1024,
  concurrent: 8,
} as const;
export interface BrowserRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  postData?: string;
  hasPostData?: boolean;
}
export interface BrowserResponse {
  status: number;
  headers: { name: string; value: string }[];
  body: string;
}
const STRIP_REQUEST =
  /^(host|connection|proxy-.*|transfer-encoding|content-length|accept-encoding|upgrade|sec-websocket-.*)$/i;
const STRIP_RESPONSE =
  /^(connection|proxy-.*|transfer-encoding|content-length|upgrade|alt-svc|clear-site-data)$/i;
export function browserUrl(raw: string): URL {
  return checkUrl(raw, { allowPrivateNetwork: false, allowHttp: false });
}

/** No redirects are followed here: each hop returns to Chromium and must be intercepted again. */
export class BrowserNetwork {
  #requests = 0;
  #bytes = 0;
  #active = 0;
  readonly #request: typeof guardedRequest;
  readonly #abort = new AbortController();
  constructor(request: typeof guardedRequest = guardedRequest) {
    this.#request = request;
  }
  close() {
    this.#abort.abort();
  }
  async fetch(input: BrowserRequest): Promise<BrowserResponse> {
    browserUrl(input.url);
    if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(input.method))
      throw badRequest('Unsupported browser request method.');
    if (input.hasPostData && input.postData === undefined)
      throw badRequest('Binary uploads are not supported.');
    if (Buffer.byteLength(input.postData ?? '') > BROWSER_NETWORK_LIMITS.requestBytes)
      throw badRequest('Browser request body is too large.');
    if (
      ++this.#requests > BROWSER_NETWORK_LIMITS.requests ||
      this.#bytes >= BROWSER_NETWORK_LIMITS.bytes ||
      this.#active >= BROWSER_NETWORK_LIMITS.concurrent
    )
      throw unavailable('Browser network budget exhausted.', 'browser_budget');
    this.#active += 1;
    try {
      const headers = Object.fromEntries(
        Object.entries(input.headers).filter(
          ([key, value]) => !STRIP_REQUEST.test(key) && !/[\r\n]/.test(value),
        ),
      );
      headers['accept-encoding'] = 'identity';
      const response = await this.#request(input.url, {
        method: input.method,
        headers,
        ...(input.postData !== undefined ? { body: input.postData } : {}),
        signal: AbortSignal.any([this.#abort.signal, AbortSignal.timeout(20_000)]),
        timeoutMs: 15_000,
      });
      if (
        response.status === 101 ||
        /attachment/i.test(String(response.headers['content-disposition'] ?? ''))
      ) {
        response.body.destroy();
        throw badRequest('Browser downloads and protocol upgrades are disabled.');
      }
      const body = await readBody(
        response.body,
        Math.min(BROWSER_NETWORK_LIMITS.responseBytes, BROWSER_NETWORK_LIMITS.bytes - this.#bytes),
      );
      this.#bytes += body.length;
      const returned: BrowserResponse['headers'] = [];
      for (const [name, values] of Object.entries(response.headers)) {
        if (STRIP_RESPONSE.test(name) || values === undefined) continue;
        for (const value of Array.isArray(values) ? values : [String(values)])
          returned.push({ name, value });
      }
      // No service worker can be installed in the isolated renderer.
      returned.push({
        name: 'Permissions-Policy',
        value: 'camera=(), microphone=(), geolocation=(), usb=(), payment=()',
      });
      return { status: response.status, headers: returned, body: body.toString('base64') };
    } finally {
      this.#active -= 1;
    }
  }
}
