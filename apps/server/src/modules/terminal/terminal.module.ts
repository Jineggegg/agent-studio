import {
  createTerminalSessionRequestSchema,
  idSchema,
  renameTerminalSessionRequestSchema,
  TERMINAL_CLOSE_CODES,
  typeTextRequestSchema,
} from '@agent-studio/protocol';
import { z } from 'zod';
import type { ModuleContext, StudioModule } from '../../kernel/module.js';
import { type TerminalLimits, resolveLimits } from './limits.js';
import { type PtyLoader, cachedPtyLoader } from './pty.js';
import { type ShellCommand, TerminalService } from './terminal.service.js';

/**
 * The terminal.
 *
 * ## What a terminal is here — the trust model
 *
 * A terminal is the signed-in **owner's own shell on the host**. It runs with
 * the operating-system permissions of the account the server runs as, and it
 * is **not sandboxed**: whatever that account can read, change or start, the
 * shell can. Removing the server's own settings from its environment prevents
 * accidents; it is not a barrier, because the shell can still read the files
 * the account can read.
 *
 * Because the terminal is deliberately this powerful, nothing here tries to
 * police what is typed. The controls are about **who can open one and what it
 * can be pointed at**:
 *
 * - **Owner only.** Members never get a shell. Every route is `access: 'owner'`.
 * - **Browser sessions only.** An API token cannot open, attach to, type into
 *   or list terminals (`sessionOnly`).
 * - **Off when the operator says so** (`AGENT_STUDIO_TERMINAL=off`).
 * - **Recent proof of identity.** The first terminal of a browser session
 *   needs a password or passkey check within the last few minutes. Attaching
 *   again to a terminal that browser created does not ask again — a phone
 *   reconnects many times an hour — and a browser that holds a live terminal
 *   may open another. A different browser of the same user is asked once per
 *   terminal it joins. A stale, stolen cookie alone therefore never reaches a
 *   shell.
 * - **Always in a project's folder.** The folder comes from the project
 *   record after the project access check; a client cannot send a path.
 * - **Never an arbitrary program.** A terminal starts the account's login
 *   shell, or one of the fixed launchers defined on the server and chosen by
 *   key (`launchers.ts`): the agent CLIs' own sign-in commands and, from the
 *   remotes module, SSH sessions to operator-configured hosts. Text that the
 *   product types on the user's behalf ("run" on a chat code block) can
 *   neither press Enter nor carry a control sequence (`typed-text.ts`).
 * - **Private to its user.** A session is visible to, and addressable by,
 *   only the account that created it — another owner included.
 * - **Bounded and accountable.** Counts, sizes, rates and lifetimes are
 *   capped (`limits.ts`); creating a session is written to the audit log
 *   (project, launcher, remote host) — never keystrokes or output.
 *
 * ## Shape
 *
 * Sessions live on the server and outlive connections (`terminal.session.ts`).
 * Management is JSON over HTTP; a browser attaches over a dedicated WebSocket
 * whose protocol is documented in `packages/protocol/src/terminal.ts`.
 */

declare module '../../kernel/module.js' {
  interface Services {
    terminal: TerminalService;
  }
}

export interface TerminalModuleOptions {
  /** Overrides of the defaults in `limits.ts`. Tests shrink the timings. */
  readonly limits?: Partial<TerminalLimits>;
  /** Replaces the account's login shell. For tests. */
  readonly shell?: ShellCommand;
  /** Replaces the loader of the pseudo-terminal library. For tests. */
  readonly loadPty?: PtyLoader;
}

const sessionParams = z.object({ sessionId: idSchema });
const listQuery = z.object({ projectId: idSchema.optional() });

export function createTerminalModule(options: TerminalModuleOptions = {}): StudioModule {
  const limits = resolveLimits(options.limits);

  return {
    name: 'terminal',

    setup(context: ModuleContext) {
      const { http, config } = context;
      const terminal = new TerminalService(context, {
        limits,
        loadPty: cachedPtyLoader(options.loadPty),
        shell: options.shell ?? null,
      });
      context.services.terminal = terminal;
      const relaxed = config.env === 'test';

      // Whether the caller can have a terminal, and if not, why. Never an error,
      // so a client can decide what to show with one request.
      http.route({
        method: 'GET',
        url: '/api/terminal/capability',
        access: 'user',
        handler: ({ user }) => terminal.capability(user),
      });

      http.route({
        method: 'GET',
        url: '/api/terminal/sessions',
        access: 'owner',
        sessionOnly: true,
        query: listQuery,
        handler: ({ user, query }) => ({ sessions: terminal.list(user, query.projectId) }),
      });

      // The step-up rule depends on what the browser already holds, so it is
      // checked by the service rather than declared with `recentAuth`.
      http.route({
        method: 'POST',
        url: '/api/terminal/sessions',
        access: 'owner',
        sessionOnly: true,
        body: createTerminalSessionRequestSchema,
        bodyLimit: 4096,
        rateLimit: { max: relaxed ? 10_000 : 30, windowMs: 60_000 },
        handler: async ({ user, body, request, reply }) => {
          const session = await terminal.create(user, body, { ip: request.ip });
          void reply.status(201);
          return session;
        },
      });

      http.route({
        method: 'GET',
        url: '/api/terminal/sessions/:sessionId',
        access: 'owner',
        sessionOnly: true,
        params: sessionParams,
        handler: ({ user, params }) => terminal.get(user, params.sessionId),
      });

      http.route({
        method: 'PATCH',
        url: '/api/terminal/sessions/:sessionId',
        access: 'owner',
        sessionOnly: true,
        params: sessionParams,
        body: renameTerminalSessionRequestSchema,
        bodyLimit: 4096,
        handler: ({ user, params, body }) => terminal.rename(user, params.sessionId, body.title),
      });

      http.route({
        method: 'DELETE',
        url: '/api/terminal/sessions/:sessionId',
        access: 'owner',
        sessionOnly: true,
        params: sessionParams,
        handler: ({ user, params }) => terminal.close(user, params.sessionId),
      });

      // "Type this command into the terminal": typed, never run.
      http.route({
        method: 'POST',
        url: '/api/terminal/sessions/:sessionId/input',
        access: 'owner',
        sessionOnly: true,
        params: sessionParams,
        body: typeTextRequestSchema,
        bodyLimit: 32 * 1024,
        rateLimit: { max: relaxed ? 10_000 : 120, windowMs: 60_000 },
        handler: ({ user, params, body }) => terminal.typeText(user, params.sessionId, body.text),
      });

      // The kernel has already checked the session cookie, the Origin and the
      // owner role before the upgrade. What is decided here is answered on the
      // open socket with a close code, which a browser can read.
      http.app.get(
        '/api/terminal/sessions/:sessionId/socket',
        {
          websocket: true,
          config: {
            studio: { access: 'owner', scope: 'admin', sessionOnly: true, recentAuth: false },
            rateLimit: { max: relaxed ? 10_000 : 120, timeWindow: 60_000 },
          },
        },
        (socket, request) => {
          const principal = request.principal;
          if (!principal || principal.role !== 'owner' || principal.via !== 'session') {
            socket.close(TERMINAL_CLOSE_CODES.authEnded, 'unauthenticated');
            return;
          }
          const params = sessionParams.safeParse(request.params);
          // A malformed id is simply an id that does not exist.
          terminal.connect(socket, principal, params.success ? params.data.sessionId : '');
        },
      );

      // Not every way of stopping the server runs module `stop` hooks; closing
      // the HTTP server always happens, so terminals are ended there as well.
      http.app.addHook('onClose', async () => {
        await terminal.shutdown();
      });
    },

    async stop(context: ModuleContext) {
      await context.services.terminal.shutdown();
    },
  };
}

export const terminalModule: StudioModule = createTerminalModule();
