import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { Readable } from 'node:stream';
import { badRequest, forbidden, payloadTooLarge, unavailable } from './errors.js';

/**
 * Outbound HTTP for addresses that come from configuration or users (model
 * provider endpoints, push services, plugin requests). The destination is
 * vetted after DNS resolution and the connection is made to the vetted
 * address, which closes both plain SSRF and DNS-rebinding variants. Redirects
 * are never followed.
 */

export interface NetPolicy {
  /** Allow loopback and private-range addresses (a model server on the same machine or LAN). */
  readonly allowPrivateNetwork?: boolean;
  /** Allow plain http. Off by default except for loopback when private networks are allowed. */
  readonly allowHttp?: boolean;
}

const linkLocal = new net.BlockList();
linkLocal.addSubnet('169.254.0.0', 16, 'ipv4'); // includes cloud metadata endpoints
linkLocal.addSubnet('fe80::', 10, 'ipv6');

const nonPublic = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  nonPublic.addSubnet(address, prefix, 'ipv4');
}
for (const [address, prefix] of [
  ['::', 127], // unspecified and loopback
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32],
  ['64:ff9b::', 96],
] as const) {
  nonPublic.addSubnet(address, prefix, 'ipv6');
}

function unwrapMapped(address: string): string {
  const match = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  return match ? match[1]! : address;
}

export type AddressClass = 'public' | 'link-local' | 'non-public' | 'invalid';

export function classifyAddress(raw: string): AddressClass {
  const address = unwrapMapped(raw.replace(/^\[|\]$/g, ''));
  const family = net.isIP(address);
  if (family === 0) return 'invalid';
  const kind = family === 4 ? 'ipv4' : 'ipv6';
  if (linkLocal.check(address, kind)) return 'link-local';
  if (nonPublic.check(address, kind)) return 'non-public';
  return 'public';
}

export function isAddressAllowed(address: string, policy: NetPolicy): boolean {
  const kind = classifyAddress(address);
  if (kind === 'public') return true;
  if (kind === 'non-public') return policy.allowPrivateNetwork === true;
  return false; // link-local and unparsable addresses are never allowed
}

/** Validates the parts of a URL that can be judged without resolving it. */
export function checkUrl(raw: string, policy: NetPolicy = {}): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw badRequest('That is not a valid URL.', undefined, 'invalid_url');
  }
  if (url.username || url.password) {
    throw badRequest('URLs with embedded credentials are not accepted.', undefined, 'invalid_url');
  }
  if (url.protocol === 'http:') {
    if (!policy.allowHttp) throw badRequest('Only https:// addresses are accepted here.', undefined, 'insecure_url');
  } else if (url.protocol !== 'https:') {
    throw badRequest('Only https:// addresses are accepted here.', undefined, 'invalid_url');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) !== 0 && !isAddressAllowed(host, policy)) {
    throw forbidden('That address is not reachable from this server by policy.', 'address_not_allowed');
  }
  return url;
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | dns.LookupAddress[],
  family?: number,
) => void;

function guardedLookup(policy: NetPolicy) {
  return (hostname: string, options: dns.LookupOptions, callback: LookupCallback): void => {
    dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error, []);
      const list = addresses as dns.LookupAddress[];
      const rejected = list.find((entry) => !isAddressAllowed(entry.address, policy));
      if (list.length === 0 || rejected) {
        const failure: NodeJS.ErrnoException = new Error(
          `"${hostname}" resolves to an address this server may not contact.`,
        );
        failure.code = 'EADDRNOTALLOWED';
        return callback(failure, []);
      }
      if (options.all) return callback(null, list);
      return callback(null, list[0]!.address, list[0]!.family);
    });
  };
}

export interface GuardedRequest {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Buffer;
  readonly signal?: AbortSignal;
  /** Time allowed until response headers arrive. */
  readonly timeoutMs?: number;
  readonly policy?: NetPolicy;
}

export interface GuardedResponse {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: Readable;
}

export function guardedRequest(rawUrl: string, options: GuardedRequest = {}): Promise<GuardedResponse> {
  const policy = options.policy ?? {};
  const url = checkUrl(rawUrl, policy);
  const transport = url.protocol === 'https:' ? https : http;

  return new Promise<GuardedResponse>((resolve, reject) => {
    const request = transport.request(
      url,
      {
        method: options.method ?? 'GET',
        headers: options.headers,
        lookup: guardedLookup(policy) as net.LookupFunction,
        // A fresh connection each time: a pooled one was checked under another request's policy, or none.
        agent: false,
        signal: options.signal,
      },
      (response) => {
        clearTimeout(timer);
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body: response });
      },
    );
    const timer = setTimeout(() => {
      request.destroy(new Error('The remote server took too long to answer.'));
    }, options.timeoutMs ?? 30_000);
    request.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === 'EADDRNOTALLOWED') {
        reject(forbidden(error.message, 'address_not_allowed'));
      } else if (error.name === 'AbortError') {
        reject(error);
      } else {
        reject(unavailable(`Could not reach ${url.host}: ${error.message}`, 'upstream_unreachable'));
      }
    });
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
}

/** Reads a response body, refusing to buffer more than `maxBytes`. */
export async function readBody(stream: Readable, maxBytes = 4 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > maxBytes) {
      stream.destroy();
      throw payloadTooLarge('The remote server sent more data than this server accepts.');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}
