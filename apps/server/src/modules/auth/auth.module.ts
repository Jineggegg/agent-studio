import {
  type AuthState,
  changePasswordRequestSchema,
  createApiTokenRequestSchema,
  createUserRequestSchema,
  idSchema,
  loginRequestSchema,
  reauthRequestSchema,
  setupRequestSchema,
  updateUserRequestSchema,
} from '@agent-studio/protocol';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { notFound, rateLimited, unauthorized } from '../../kernel/errors.js';
import { RECENT_AUTH_WINDOW_MS, SECURE_SESSION_COOKIE, SESSION_COOKIE, type HttpKernel } from '../../kernel/http.js';
import type { ModuleContext, StudioModule } from '../../kernel/module.js';
import { VERSION } from '../../kernel/version.js';
import { AUTH_MIGRATIONS, AuthService, type StartedSession } from './auth.service.js';
import { AttemptThrottle } from './throttle.js';

declare module '../../kernel/module.js' {
  interface Services {
    auth: AuthService;
    /** Sets the session cookie for a freshly authenticated user. Used by every sign-in method. */
    signIn: (request: FastifyRequest, reply: FastifyReply, session: StartedSession) => void;
  }
}

const idParams = z.object({ id: idSchema });

function setSessionCookie(http: HttpKernel, request: FastifyRequest, reply: FastifyReply, session: StartedSession): void {
  void reply.setCookie(http.sessionCookieName(request), session.token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: http.isSecure(request),
    path: '/',
    maxAge: Math.floor((session.expiresAt - Date.now()) / 1000),
  });
}

function clearSessionCookies(reply: FastifyReply): void {
  void reply.clearCookie(SESSION_COOKIE, { path: '/' });
  void reply.clearCookie(SECURE_SESSION_COOKIE, { path: '/', secure: true });
}

export const authModule: StudioModule = {
  name: 'auth',
  migrations: AUTH_MIGRATIONS,

  setup(context: ModuleContext) {
    const { http, config } = context;
    const auth = new AuthService(context);
    context.services.auth = auth;
    context.services.signIn = (request, reply, session) => setSessionCookie(http, request, reply, session);
    http.setAuthenticator(auth);

    // Per account: a handful of free guesses, then exponential waits.
    // Per address: more headroom, because a tunnel can make every client share one address.
    const perAccount = new AttemptThrottle({ freeAttempts: 5 });
    const perAddress = new AttemptThrottle({ freeAttempts: 20 });
    const setupAttempts = new AttemptThrottle({ freeAttempts: 5 });

    const stateFor = (request: FastifyRequest): AuthState => {
      const principal = request.principal;
      const session = principal?.via === 'session' ? auth.describeSession(principal.credentialId) : null;
      return {
        needsSetup: auth.needsSetup(),
        authenticated: principal !== null,
        user: principal ? auth.findUser(principal.userId) : null,
        csrfToken: principal?.csrfToken ?? null,
        session: session
          ? {
              id: session.id,
              method: session.method,
              authenticatedAt: session.authenticated_at,
              expiresAt: session.expires_at,
              recentlyAuthenticated: Date.now() - session.authenticated_at <= RECENT_AUTH_WINDOW_MS,
            }
          : null,
        serverTime: Date.now(),
        version: VERSION,
      };
    };

    /** Builds the state a client sees right after signing in, before its next request. */
    const stateAfterSignIn = (userId: string, session: StartedSession, method: 'password' | 'setup'): AuthState => ({
      needsSetup: false,
      authenticated: true,
      user: auth.getUser(userId),
      csrfToken: auth.csrfTokenFor(session.sessionId),
      session: {
        id: session.sessionId,
        method,
        authenticatedAt: Date.now(),
        expiresAt: session.expiresAt,
        recentlyAuthenticated: true,
      },
      serverTime: Date.now(),
      version: VERSION,
    });

    http.route({
      method: 'GET',
      url: '/api/auth/state',
      access: 'public',
      handler: ({ request }) => stateFor(request),
    });

    http.route({
      method: 'POST',
      url: '/api/auth/setup',
      access: 'public',
      body: setupRequestSchema,
      rateLimit: { max: config.env === 'test' ? 10_000 : 20, windowMs: 60_000 },
      handler: async ({ body, request, reply }) => {
        const key = `setup:${request.ip}`;
        const wait = setupAttempts.retryAfter(key);
        if (wait > 0) throw rateLimited(wait);
        let user;
        try {
          user = await auth.setup(body);
        } catch (error) {
          setupAttempts.recordFailure(key);
          throw error;
        }
        const session = auth.startSession(user.id, 'setup', { ip: request.ip, userAgent: request.headers['user-agent'] ?? null });
        setSessionCookie(http, request, reply, session);
        return stateAfterSignIn(user.id, session, 'setup');
      },
    });

    http.route({
      method: 'POST',
      url: '/api/auth/login',
      access: 'public',
      body: loginRequestSchema,
      rateLimit: { max: config.env === 'test' ? 10_000 : 30, windowMs: 60_000 },
      handler: async ({ body, request, reply }) => {
        const accountKey = `account:${body.username.toLowerCase()}`;
        const addressKey = `address:${request.ip}`;
        const wait = Math.max(perAccount.retryAfter(accountKey), perAddress.retryAfter(addressKey));
        if (wait > 0) throw rateLimited(wait, 'Too many sign-in attempts. Try again later.');

        const user = await auth.verifyCredentials(body.username, body.password);
        if (!user) {
          perAccount.recordFailure(accountKey);
          perAddress.recordFailure(addressKey);
          // One message for every failure: wrong password, unknown account, disabled account.
          throw unauthorized('That username or password is not correct.', 'invalid_credentials');
        }
        perAccount.recordSuccess(accountKey);
        const session = auth.startSession(user.id, 'password', { ip: request.ip, userAgent: request.headers['user-agent'] ?? null });
        setSessionCookie(http, request, reply, session);
        return stateAfterSignIn(user.id, session, 'password');
      },
    });

    http.route({
      method: 'POST',
      url: '/api/auth/logout',
      access: 'user',
      sessionOnly: true,
      handler: ({ user, reply }) => {
        auth.endSession(user.userId, user.credentialId);
        clearSessionCookies(reply);
      },
    });

    http.route({
      method: 'POST',
      url: '/api/auth/reauth',
      access: 'user',
      sessionOnly: true,
      body: reauthRequestSchema,
      rateLimit: { max: config.env === 'test' ? 10_000 : 20, windowMs: 60_000 },
      handler: async ({ user, body }) => {
        const accountKey = `account:${user.username.toLowerCase()}`;
        const wait = perAccount.retryAfter(accountKey);
        if (wait > 0) throw rateLimited(wait);
        if (!(await auth.verifyCredentials(user.username, body.password))) {
          perAccount.recordFailure(accountKey);
          throw unauthorized('That password is not correct.', 'invalid_credentials');
        }
        perAccount.recordSuccess(accountKey);
        auth.markReauthenticated(user.credentialId);
        return { recentlyAuthenticated: true };
      },
    });

    http.route({
      method: 'POST',
      url: '/api/auth/password',
      access: 'user',
      sessionOnly: true,
      body: changePasswordRequestSchema,
      rateLimit: { max: config.env === 'test' ? 10_000 : 10, windowMs: 60_000 },
      handler: async ({ user, body }) => {
        await auth.changePassword(user.userId, body.currentPassword, body.newPassword, user.credentialId);
        auth.markReauthenticated(user.credentialId);
      },
    });

    // ---- signed-in devices ----
    http.route({
      method: 'GET',
      url: '/api/auth/sessions',
      access: 'user',
      sessionOnly: true,
      handler: ({ user }) => ({ sessions: auth.listSessions(user.userId, user.credentialId) }),
    });
    http.route({
      method: 'DELETE',
      url: '/api/auth/sessions/:id',
      access: 'user',
      sessionOnly: true,
      params: idParams,
      handler: ({ user, params, reply }) => {
        if (!auth.endSession(user.userId, params.id)) throw notFound('No such session.');
        if (params.id === user.credentialId) clearSessionCookies(reply);
      },
    });

    // ---- API tokens ----
    http.route({
      method: 'GET',
      url: '/api/auth/tokens',
      access: 'user',
      sessionOnly: true,
      handler: ({ user }) => ({ tokens: auth.listApiTokens(user.userId) }),
    });
    http.route({
      method: 'POST',
      url: '/api/auth/tokens',
      access: 'user',
      sessionOnly: true,
      recentAuth: true,
      body: createApiTokenRequestSchema,
      handler: ({ user, body }) => auth.createApiToken(user, body),
    });
    http.route({
      method: 'DELETE',
      url: '/api/auth/tokens/:id',
      access: 'user',
      sessionOnly: true,
      params: idParams,
      handler: ({ user, params }) => {
        if (!auth.revokeApiToken(user.userId, params.id)) throw notFound('No such token.');
      },
    });

    // ---- people (owner only) ----
    http.route({
      method: 'GET',
      url: '/api/users',
      access: 'owner',
      handler: () => ({ users: auth.listUsers() }),
    });
    http.route({
      method: 'POST',
      url: '/api/users',
      access: 'owner',
      sessionOnly: true,
      recentAuth: true,
      body: createUserRequestSchema,
      handler: async ({ body, reply }) => {
        const user = await auth.createUser(body);
        void reply.status(201);
        return user;
      },
    });
    http.route({
      method: 'PATCH',
      url: '/api/users/:id',
      access: 'owner',
      sessionOnly: true,
      recentAuth: true,
      params: idParams,
      body: updateUserRequestSchema,
      handler: ({ user, params, body }) => auth.updateUser(params.id, body, user),
    });
    http.route({
      method: 'DELETE',
      url: '/api/users/:id',
      access: 'owner',
      sessionOnly: true,
      recentAuth: true,
      params: idParams,
      handler: ({ user, params }) => auth.deleteUser(params.id, user),
    });
  },

  start(context) {
    const auth = context.services.auth;
    auth.purgeExpired();
    const timer = setInterval(() => auth.purgeExpired(), 60 * 60 * 1000);
    timer.unref();
    housekeeping.set(context, timer);
  },

  stop(context) {
    const timer = housekeeping.get(context);
    if (timer) clearInterval(timer);
  },
};

const housekeeping = new WeakMap<ModuleContext, NodeJS.Timeout>();
