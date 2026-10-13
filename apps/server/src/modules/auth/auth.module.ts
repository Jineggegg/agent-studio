import {
  type AuthState,
  type LockStatus,
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
import { setupPasskeys } from './passkeys.js';
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

    const audit = context.services.audit;
    const DAY_MS = 24 * 60 * 60_000;
    // Per account: a handful of free guesses, then exponential waits that survive a restart.
    // Per address: more headroom, because a tunnel can make every client share one address.
    const perAccount = new AttemptThrottle({ freeAttempts: 5 }, context.db);
    const perAddress = new AttemptThrottle({ freeAttempts: 20 });
    const setupAttempts = new AttemptThrottle({ freeAttempts: 5 });
    // Confirming identity inside a session has its own budget per session, so a stolen
    // session can lock only itself — and a daily cap per account across all sessions.
    const stepUpPerSession = new AttemptThrottle({ freeAttempts: 5 }, context.db);
    const stepUpPerDay = new AttemptThrottle({ freeAttempts: 20, baseDelayMs: DAY_MS, maxDelayMs: DAY_MS, forgetAfterMs: DAY_MS }, context.db);
    throttles.set(context, perAccount);

    const accountKey = (username: string) => `account:${username.toLowerCase()}`;
    const sessionKey = (sessionId: string) => `stepup:${sessionId}`;
    const dailyKey = (userId: string) => `stepup-day:${userId}`;

    /** Checks the password of an already signed-in user, within the step-up budgets. */
    const confirmPassword = async (user: { userId: string; username: string; credentialId: string }, password: string, ip: string): Promise<void> => {
      const wait = Math.max(stepUpPerSession.retryAfter(sessionKey(user.credentialId)), stepUpPerDay.retryAfter(dailyKey(user.userId)));
      if (wait > 0) throw rateLimited(wait, 'Too many wrong passwords. Try again later.');
      if (!(await auth.verifyCredentials(user.username, password))) {
        stepUpPerSession.recordFailure(sessionKey(user.credentialId));
        stepUpPerDay.recordFailure(dailyKey(user.userId));
        audit.record({ category: 'failure', action: 'identity.confirmation-refused', userId: user.userId, address: ip });
        throw unauthorized('That password is not correct.', 'invalid_credentials');
      }
      stepUpPerSession.recordSuccess(sessionKey(user.credentialId));
    };

    const passkeys = setupPasskeys(context, auth, {
      signedIn: (request, userId, session) => {
        // The reply for the current request is reachable through the request's own context.
        pendingCookies.set(request, session);
        return stateAfterSignIn(request, userId, session, 'passkey');
      },
      clearSignInLock: (username) => perAccount.recordSuccess(accountKey(username)),
    });
    // Sets the cookie for sign-ins completed by a sub-feature (passkeys).
    http.app.addHook('onSend', async (request, reply) => {
      const session = pendingCookies.get(request);
      if (session) setSessionCookie(http, request, reply, session);
    });

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
        passkeysAvailable: passkeys.availableFor(request),
        serverTime: Date.now(),
        version: VERSION,
      };
    };

    /** Builds the state a client sees right after signing in, before its next request. */
    const stateAfterSignIn = (request: FastifyRequest, userId: string, session: StartedSession, method: 'password' | 'setup' | 'passkey'): AuthState => ({
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
      passkeysAvailable: passkeys.availableFor(request),
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
          audit.record({ category: 'failure', action: 'setup.refused', address: request.ip });
          throw error;
        }
        audit.record({ category: 'change', action: 'owner.created', userId: user.id, subject: user.username, address: request.ip });
        const session = auth.startSession(user.id, 'setup', { ip: request.ip, userAgent: request.headers['user-agent'] ?? null });
        setSessionCookie(http, request, reply, session);
        return stateAfterSignIn(request, user.id, session, 'setup');
      },
    });

    http.route({
      method: 'POST',
      url: '/api/auth/login',
      access: 'public',
      body: loginRequestSchema,
      rateLimit: { max: config.env === 'test' ? 10_000 : 30, windowMs: 60_000 },
      handler: async ({ body, request, reply }) => {
        const account = accountKey(body.username);
        const addressKey = `address:${request.ip}`;
        // The lock is checked before the password is: a locked account costs an attacker nothing to learn.
        const wait = Math.max(perAccount.retryAfter(account), perAddress.retryAfter(addressKey));
        if (wait > 0) throw rateLimited(wait, 'Too many sign-in attempts. Try again later.');

        const user = await auth.verifyCredentials(body.username, body.password);
        if (!user) {
          perAccount.recordFailure(account);
          perAddress.recordFailure(addressKey);
          audit.record({ category: 'failure', action: 'sign-in.refused', address: request.ip });
          // One message for every failure: wrong password, unknown account, disabled account.
          throw unauthorized('That username or password is not correct.', 'invalid_credentials');
        }
        perAccount.recordSuccess(account);
        audit.record({ category: 'sign-in', action: 'sign-in.password', userId: user.id, address: request.ip });
        const session = auth.startSession(user.id, 'password', { ip: request.ip, userAgent: request.headers['user-agent'] ?? null });
        setSessionCookie(http, request, reply, session);
        return stateAfterSignIn(request, user.id, session, 'password');
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

    // Ends every session and API token of the account, on every device, including this one.
    http.route({
      method: 'POST',
      url: '/api/auth/logout-everywhere',
      access: 'user',
      sessionOnly: true,
      handler: ({ user, request, reply }) => {
        auth.revokeAllCredentials(user.userId);
        stepUpPerDay.recordSuccess(dailyKey(user.userId));
        audit.record({ category: 'change', action: 'sessions.revoked-all', userId: user.userId, address: request.ip });
        clearSessionCookies(reply);
      },
    });

    http.route({
      method: 'GET',
      url: '/api/auth/locks',
      access: 'user',
      sessionOnly: true,
      handler: ({ user }): LockStatus => ({
        signInLockedUntil: perAccount.lockedUntil(accountKey(user.username)),
        stepUpLockedUntil:
          stepUpPerSession.lockedUntil(sessionKey(user.credentialId)) ?? stepUpPerDay.lockedUntil(dailyKey(user.userId)),
      }),
    });

    http.route({
      method: 'POST',
      url: '/api/auth/reauth',
      access: 'user',
      sessionOnly: true,
      body: reauthRequestSchema,
      rateLimit: { max: config.env === 'test' ? 10_000 : 20, windowMs: 60_000 },
      handler: async ({ user, body, request }) => {
        await confirmPassword(user, body.password, request.ip);
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
      handler: async ({ user, body, request }) => {
        await confirmPassword(user, body.currentPassword, request.ip);
        await auth.changePassword(user.userId, body.currentPassword, body.newPassword, user.credentialId);
        auth.markReauthenticated(user.credentialId);
        perAccount.recordSuccess(accountKey(user.username));
        audit.record({ category: 'change', action: 'password.changed', userId: user.userId, address: request.ip });
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
      handler: ({ user, params, request, reply }) => {
        if (!auth.endSession(user.userId, params.id)) throw notFound('No such session.');
        audit.record({ category: 'change', action: 'session.revoked', userId: user.userId, address: request.ip });
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
      handler: ({ user, body, request }) => {
        const created = auth.createApiToken(user, body);
        audit.record({ category: 'change', action: 'api-token.created', userId: user.userId, subject: body.name, detail: `scopes: ${created.record.scopes.join(', ')}`, address: request.ip });
        return created;
      },
    });
    http.route({
      method: 'DELETE',
      url: '/api/auth/tokens/:id',
      access: 'user',
      sessionOnly: true,
      params: idParams,
      handler: ({ user, params, request }) => {
        if (!auth.revokeApiToken(user.userId, params.id)) throw notFound('No such token.');
        audit.record({ category: 'change', action: 'api-token.revoked', userId: user.userId, address: request.ip });
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
      handler: async ({ user: actor, body, request, reply }) => {
        const user = await auth.createUser(body);
        audit.record({ category: 'change', action: 'user.created', userId: actor.userId, subject: user.username, detail: `role: ${user.role}`, address: request.ip });
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
      handler: async ({ user, params, body, request }) => {
        const updated = await auth.updateUser(params.id, body, user);
        const changed = Object.keys(body).map((key) => (key === 'password' ? 'password reset' : key)).join(', ');
        audit.record({ category: 'change', action: 'user.updated', userId: user.userId, subject: updated.username, detail: changed, address: request.ip });
        if (body.password !== undefined) perAccount.recordSuccess(accountKey(updated.username));
        return updated;
      },
    });
    http.route({
      method: 'DELETE',
      url: '/api/users/:id',
      access: 'owner',
      sessionOnly: true,
      recentAuth: true,
      params: idParams,
      handler: ({ user, params, request }) => {
        const target = auth.getUser(params.id);
        auth.deleteUser(params.id, user);
        audit.record({ category: 'change', action: 'user.deleted', userId: user.userId, subject: target.username, address: request.ip });
      },
    });
  },

  start(context) {
    const auth = context.services.auth;
    auth.purgeExpired();
    const timer = setInterval(() => {
      auth.purgeExpired();
      throttles.get(context)?.prune();
    }, 60 * 60 * 1000);
    timer.unref();
    housekeeping.set(context, timer);
  },

  stop(context) {
    const timer = housekeeping.get(context);
    if (timer) clearInterval(timer);
  },
};

const pendingCookies = new WeakMap<FastifyRequest, StartedSession>();
const housekeeping = new WeakMap<ModuleContext, NodeJS.Timeout>();
const throttles = new WeakMap<ModuleContext, AttemptThrottle>();
