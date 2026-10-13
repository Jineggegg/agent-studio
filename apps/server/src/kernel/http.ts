import { readFileSync } from 'node:fs';
import path from 'node:path';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { ZodError, type ZodType } from 'zod';
import { isLoopbackHostname, type StudioConfig } from './config.js';
import { safeEqual } from './crypto.js';
import { StudioError, badRequest, describeError, forbidden, isStudioError, unauthorized } from './errors.js';
import type { Authenticator, Principal, TokenScope } from './principal.js';
import { redactSecrets } from './redact.js';

/**
 * `public`  — no credentials needed (sign-in, health).
 * `user`    — any signed-in user.
 * `owner`   — the instance owner only.
 * `self`    — the handler authenticates the caller itself (for example with a
 *             token that is scoped to a single agent run). Use sparingly.
 */
export type Access = 'public' | 'user' | 'owner' | 'self';

export interface RouteConfig {
  access: Access;
  scope: TokenScope;
  /** Only a browser session may call this — never an API token. */
  sessionOnly: boolean;
  /** The user must have proved their identity within the last few minutes. */
  recentAuth: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
  }
  interface FastifyContextConfig {
    studio?: RouteConfig;
  }
}

export interface RouteContext<B, Q, P> {
  readonly body: B;
  readonly query: Q;
  readonly params: P;
  /** The signed-in caller. Throws 401 when there is none (possible only on `public`/`self` routes). */
  readonly user: Principal;
  readonly principal: Principal | null;
  readonly request: FastifyRequest;
  readonly reply: FastifyReply;
}

export interface RouteSpec<B = unknown, Q = unknown, P = unknown> {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly url: string;
  readonly access: Access;
  /** Defaults to `read` for GET, `write` otherwise, and `admin` for owner routes. */
  readonly scope?: TokenScope;
  readonly sessionOnly?: boolean;
  readonly recentAuth?: boolean;
  readonly body?: ZodType<B>;
  readonly query?: ZodType<Q>;
  readonly params?: ZodType<P>;
  readonly bodyLimit?: number;
  readonly rateLimit?: { readonly max: number; readonly windowMs: number };
  /** Return a value to send it as JSON; return undefined for 204. */
  readonly handler: (context: RouteContext<B, Q, P>) => unknown;
}

export const RECENT_AUTH_WINDOW_MS = 15 * 60 * 1000;
export const CSRF_HEADER = 'x-studio-csrf';
export const SESSION_COOKIE = 'studio_session';
export const SECURE_SESSION_COOKIE = '__Host-studio_session';

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function hostnameOf(hostHeader: string): string {
  if (hostHeader.startsWith('[')) return hostHeader.slice(0, hostHeader.indexOf(']') + 1);
  const colon = hostHeader.lastIndexOf(':');
  return colon === -1 ? hostHeader : hostHeader.slice(0, colon);
}

export class HttpKernel {
  readonly app: FastifyInstance;
  readonly #config: StudioConfig;
  readonly #publicHosts: Map<string, string>;
  #authenticator: Authenticator | null = null;

  constructor(config: StudioConfig) {
    this.#config = config;
    this.#publicHosts = new Map(config.publicOrigins.map((origin) => [new URL(origin).host.toLowerCase(), origin]));
    this.app = Fastify({
      logger:
        config.logLevel === 'silent'
          ? false
          : {
              level: config.logLevel,
              redact: {
                paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
                censor: '[redacted]',
              },
              serializers: {
                req: (request: FastifyRequest) => ({
                  method: request.method,
                  // Query strings are dropped: they are the likeliest place for something sensitive.
                  path: request.url.split('?')[0],
                  ip: request.ip,
                }),
              },
            },
      trustProxy: config.trustProxy ? 'loopback' : false,
      bodyLimit: 1024 * 1024,
      // Slow-request protection: a client gets a bounded time to send its request.
      connectionTimeout: 120_000,
      requestTimeout: 120_000,
      keepAliveTimeout: 65_000,
      maxRequestsPerSocket: 1000,
      ...(config.tls
        ? { https: { cert: readFileSync(config.tls.certFile), key: readFileSync(config.tls.keyFile) } }
        : {}),
    }) as unknown as FastifyInstance;
    this.app.decorateRequest('principal', null);
    this.app.server.headersTimeout = 15_000;
  }

  setAuthenticator(authenticator: Authenticator): void {
    this.#authenticator = authenticator;
  }

  get authenticator(): Authenticator {
    if (!this.#authenticator) throw new Error('No authenticator registered.');
    return this.#authenticator;
  }

  /** True when the request arrived over TLS, directly or at a known public https origin. */
  isSecure(request: FastifyRequest): boolean {
    if (request.protocol === 'https') return true;
    const origin = this.#publicHosts.get((request.headers.host ?? '').toLowerCase());
    return origin !== undefined && origin.startsWith('https://');
  }

  /** The origin this request was addressed to, as the browser sees it. */
  originOf(request: FastifyRequest): string {
    const host = (request.headers.host ?? '').toLowerCase();
    return this.#publicHosts.get(host) ?? `${this.isSecure(request) ? 'https' : 'http'}://${host}`;
  }

  sessionCookieName(request: FastifyRequest): string {
    return this.isSecure(request) ? SECURE_SESSION_COOKIE : SESSION_COOKIE;
  }

  #hostAllowed(hostHeader: string | undefined): boolean {
    if (!hostHeader) return false;
    const host = hostHeader.toLowerCase();
    if (this.#publicHosts.has(host)) return true;
    const hostname = hostnameOf(host);
    if (isLoopbackHostname(hostname)) return true;
    // Bound to one specific non-loopback address: that literal address is acceptable.
    return this.#config.host !== '0.0.0.0' && this.#config.host !== '::' && hostname === this.#config.host;
  }

  /**
   * An Origin is acceptable when it is the very origin the request was sent
   * to (same-origin), and that origin is loopback or explicitly configured.
   */
  originAllowed(origin: string, hostHeader: string | undefined): boolean {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      return false;
    }
    if (!hostHeader || url.host.toLowerCase() !== hostHeader.toLowerCase()) return false;
    if (this.#config.publicOrigins.includes(url.origin)) return true;
    if (isLoopbackHostname(url.hostname)) return true;
    return this.#config.host !== '0.0.0.0' && this.#config.host !== '::' && url.hostname === this.#config.host;
  }

  async init(): Promise<void> {
    const app = this.app;
    const config = this.#config;

    await app.register(cookie);
    await app.register(helmet, {
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'"],
          // Editor and terminal widgets inject style elements at runtime.
          'style-src': ["'self'", "'unsafe-inline'"],
          'img-src': ["'self'", 'data:', 'blob:'],
          'font-src': ["'self'", 'data:'],
          'connect-src': ["'self'"],
          'worker-src': ["'self'"],
          'manifest-src': ["'self'"],
          'frame-src': ["'self'"],
          'frame-ancestors': ["'none'"],
          'object-src': ["'none'"],
          'base-uri': ["'none'"],
          'form-action': ["'self'"],
        },
      },
      crossOriginEmbedderPolicy: false,
      crossOriginOpenerPolicy: { policy: 'same-origin' },
      crossOriginResourcePolicy: { policy: 'same-origin' },
      referrerPolicy: { policy: 'no-referrer' },
      // Sent only over https by browsers; harmless otherwise.
      strictTransportSecurity: { maxAge: 15552000, includeSubDomains: false },
      xFrameOptions: { action: 'deny' },
    });
    await app.register(rateLimit, {
      global: true,
      max: config.env === 'test' ? 100_000 : 1200,
      timeWindow: 60_000,
      keyGenerator: (request) => request.principal?.userId ?? request.ip,
      errorResponseBuilder: (_request, context) => ({
        statusCode: 429,
        error: { code: 'rate_limited', message: 'Too many requests. Slow down.', details: { retryAfterSeconds: Math.ceil(context.ttl / 1000) } },
      }),
    });
    await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });

    // A route without an explicit access level is a bug, not a public endpoint.
    app.addHook('onRoute', (route) => {
      const isApi = route.url.startsWith('/api/');
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      if (isApi && !route.config?.studio && !methods.every((method) => method === 'HEAD' || method === 'OPTIONS')) {
        throw new Error(`Route ${String(route.method)} ${route.url} does not declare who may call it.`);
      }
    });

    app.addHook('onRequest', async (request, reply) => {
      reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
      if (!this.#hostAllowed(request.headers.host)) {
        throw forbidden(
          'This address is not one this server answers to. Add it to AGENT_STUDIO_PUBLIC_ORIGINS.',
          'host_not_allowed',
        );
      }
      if (!request.url.startsWith('/api/')) return;
      reply.header('cache-control', 'no-store');

      const meta = { ip: request.ip, userAgent: request.headers['user-agent'] ?? null };
      const authorization = request.headers.authorization;
      let principal: Principal | null = null;
      if (authorization?.startsWith('Bearer ')) {
        principal = this.authenticator.fromBearerToken(authorization.slice(7).trim(), meta);
        // A bearer token that does not resolve is an error rather than "anonymous",
        // unless the route does its own token handling.
        if (!principal && request.routeOptions.config.studio?.access !== 'self') {
          throw unauthorized('That API token is not valid.', 'invalid_token');
        }
      } else {
        const token = request.cookies[SECURE_SESSION_COOKIE] ?? request.cookies[SESSION_COOKIE];
        if (token) principal = this.authenticator.fromSessionCookie(token, meta);
      }
      request.principal = principal;

      const origin = request.headers.origin;
      const unsafe = UNSAFE_METHODS.has(request.method);
      const upgrade = request.headers.upgrade?.toLowerCase() === 'websocket';
      if (unsafe || upgrade) {
        // Browsers attach Origin to every state-changing request and every
        // WebSocket handshake; a mismatch means another site is driving this one.
        if (origin !== undefined && !this.originAllowed(origin, request.headers.host)) {
          throw forbidden('Requests from that origin are not accepted.', 'origin_not_allowed');
        }
        if (request.headers['sec-fetch-site'] === 'cross-site') {
          throw forbidden('Cross-site requests are not accepted.', 'origin_not_allowed');
        }
        if (principal?.via === 'session') {
          if (origin === undefined) throw forbidden('This request is missing its Origin.', 'origin_required');
          if (unsafe) {
            const sent = request.headers[CSRF_HEADER];
            if (typeof sent !== 'string' || !principal.csrfToken || !safeEqual(sent, principal.csrfToken)) {
              throw forbidden('This request is missing its anti-forgery token.', 'csrf_failed');
            }
          }
        }
      }

      const route = request.routeOptions.config.studio;
      if (!route) return; // unknown URL: the not-found handler answers
      if (route.access === 'public' || route.access === 'self') return;
      if (!principal) throw unauthorized();
      if (route.access === 'owner' && principal.role !== 'owner') {
        throw forbidden('Only the owner of this Studio can do that.', 'owner_required');
      }
      if (route.sessionOnly && principal.via !== 'session') {
        throw forbidden('This can only be done from a signed-in browser, not with an API token.', 'session_required');
      }
      if (!principal.scopes.includes(route.scope)) {
        throw forbidden(`This API token lacks the "${route.scope}" scope.`, 'insufficient_scope');
      }
      if (route.recentAuth && Date.now() - principal.authenticatedAt > RECENT_AUTH_WINDOW_MS) {
        throw forbidden('Confirm your identity to continue.', 'reauth_required');
      }
    });

    app.setErrorHandler((error, request, reply) => {
      if (isStudioError(error)) {
        if (error.status === 429 && typeof (error.details as { retryAfterSeconds?: number })?.retryAfterSeconds === 'number') {
          void reply.header('retry-after', String((error.details as { retryAfterSeconds: number }).retryAfterSeconds));
        }
        return reply.status(error.status).send({ error: { code: error.code, message: error.message, details: error.details } });
      }
      if (error instanceof ZodError) {
        return reply.status(400).send({
          error: {
            code: 'invalid_request',
            message: 'The request is not valid.',
            details: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
          },
        });
      }
      const fastifyError = error as { statusCode?: number; code?: string; message?: string; error?: unknown };
      if (fastifyError.statusCode === 429 && fastifyError.error) {
        return reply.status(429).send({ error: fastifyError.error });
      }
      if (typeof fastifyError.statusCode === 'number' && fastifyError.statusCode >= 400 && fastifyError.statusCode < 500) {
        const code =
          fastifyError.statusCode === 413 ? 'too_large' : fastifyError.statusCode === 415 ? 'unsupported_media_type' : 'bad_request';
        return reply.status(fastifyError.statusCode).send({
          error: { code, message: fastifyError.statusCode === 413 ? 'That is too large.' : 'The request could not be read.' },
        });
      }
      request.log.error({ err: { message: redactSecrets(describeError(error)), stack: error instanceof Error ? error.stack : undefined } }, 'request failed');
      return reply.status(500).send({ error: { code: 'internal_error', message: 'Something went wrong on the server.' } });
    });

    app.setNotFoundHandler((request, reply) => {
      const wantsPage =
        request.method === 'GET' && !request.url.startsWith('/api/') && !path.extname(request.url.split('?')[0] ?? '');
      if (wantsPage && config.webDir) {
        return reply.header('cache-control', 'no-cache').type('text/html').sendFile('index.html');
      }
      return reply.status(404).send({ error: { code: 'not_found', message: 'Not found.' } });
    });

    if (config.webDir) {
      await app.register(fastifyStatic, {
        root: config.webDir,
        wildcard: false,
        index: ['index.html'],
        setHeaders: (response, filePath) => {
          const name = path.basename(filePath);
          if (filePath.includes(`${path.sep}assets${path.sep}`)) {
            void response.header('cache-control', 'public, max-age=31536000, immutable');
          } else if (name === 'index.html' || name === 'sw.js' || name.endsWith('.webmanifest')) {
            void response.header('cache-control', 'no-cache');
          }
        },
      });
    }
  }

  /** Registers a JSON route. Input is validated before the handler sees it. */
  route<B = unknown, Q = unknown, P = unknown>(spec: RouteSpec<B, Q, P>): void {
    const studio: RouteConfig = {
      access: spec.access,
      scope: spec.scope ?? (spec.access === 'owner' ? 'admin' : spec.method === 'GET' ? 'read' : 'write'),
      sessionOnly: spec.sessionOnly ?? false,
      recentAuth: spec.recentAuth ?? false,
    };
    this.app.route({
      method: spec.method,
      url: spec.url,
      ...(spec.bodyLimit === undefined ? {} : { bodyLimit: spec.bodyLimit }),
      config: {
        studio,
        ...(spec.rateLimit ? { rateLimit: { max: spec.rateLimit.max, timeWindow: spec.rateLimit.windowMs } } : {}),
      },
      handler: async (request, reply) => {
        const context: RouteContext<B, Q, P> = {
          body: (spec.body ? spec.body.parse(request.body ?? {}) : (request.body as B)) as B,
          query: (spec.query ? spec.query.parse(request.query ?? {}) : (request.query as Q)) as Q,
          params: (spec.params ? spec.params.parse(request.params ?? {}) : (request.params as P)) as P,
          principal: request.principal,
          get user(): Principal {
            if (!request.principal) throw unauthorized();
            return request.principal;
          },
          request,
          reply,
        };
        const result = await spec.handler(context);
        if (reply.sent) return reply;
        if (result === undefined) return reply.status(204).send();
        return reply.send(result);
      },
    });
  }
}

export { StudioError, badRequest };
