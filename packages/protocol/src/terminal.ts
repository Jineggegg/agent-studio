import { z } from 'zod';
import { idSchema, timestampSchema } from './common.js';
import { remoteDirectorySchema, remoteHostIdSchema } from './remotes.js';

/**
 * Terminal protocol.
 *
 * A terminal session is a shell (or one fixed, server-defined program) that
 * runs on the server inside a pseudo-terminal. It belongs to the user who
 * created it and it outlives connections: a browser attaches to it over a
 * WebSocket, may disappear (locked phone, lost network) and attaches again
 * later. While nobody is attached the session keeps running for an idle
 * window and its output keeps collecting in a bounded replay buffer.
 *
 * Only the owner may use terminals, only from a signed-in browser (never with
 * an API token), and only when the operator has not turned the feature off.
 *
 * ── Management (JSON over HTTP) ─────────────────────────────────────────────
 *
 *   GET    /api/terminal/capability                 → TerminalCapability (any signed-in user; never an error)
 *   GET    /api/terminal/sessions[?projectId=]      → { sessions: TerminalSession[] }   (the caller's own)
 *   POST   /api/terminal/sessions                   → 201 TerminalSession               (CreateTerminalSessionRequest)
 *   GET    /api/terminal/sessions/:id               → TerminalSession
 *   PATCH  /api/terminal/sessions/:id               → TerminalSession                   ({ title })
 *   DELETE /api/terminal/sessions/:id               → CloseTerminalSessionResponse
 *   POST   /api/terminal/sessions/:id/input         → TypeTextResponse                  ({ text })
 *
 * Creating a session needs a recent proof of identity (`reauth_required`, the
 * same code every step-up uses) unless this browser already holds a live
 * terminal. Attaching to a session this browser created never asks again;
 * attaching from another browser of the same user asks once.
 * `TerminalSession.attachable` and `TerminalCapability.needsReauth` say in
 * advance whether a step-up is due.
 *
 * `POST …/input` types text into the session as if it came from the keyboard,
 * for "run this command" buttons. The server removes every control character
 * except tab and never sends Enter: the user presses it. Text that spans
 * several lines is refused (`multiline_text`) rather than glued together.
 *
 * ── Attaching (WebSocket) ───────────────────────────────────────────────────
 *
 *   GET /api/terminal/sessions/:id/socket      (cookie session + same Origin)
 *
 * A handshake without a valid owner session, or from another origin, is
 * refused with an HTTP status before the upgrade (401/403) — a browser sees
 * that only as a failed connection, so ask `GET /api/terminal/sessions/:id`
 * when it matters why. Everything the terminal itself decides is reported
 * after the upgrade with one of {@link TERMINAL_CLOSE_CODES}.
 *
 * Text frames carry small JSON control messages; binary frames carry terminal
 * bytes and nothing else:
 *
 *   client → server   binary   keyboard input, at most `limits.maxInputFrameBytes` per frame
 *   server → client   binary   terminal output, in order, without gaps
 *
 * Bytes are never decoded on the way: a multi-byte character may be split
 * across two frames in either direction. Feed output to the terminal widget
 * as bytes (`Uint8Array`), not as text.
 *
 * The exchange:
 *
 *   1. The client sends {@link TerminalAttachFrame} as its first frame:
 *      its size and, when it has seen this session before, `after` — the
 *      sequence number it has reached.
 *   2. The server answers {@link TerminalAttachedFrame}: the session, and a
 *      replay marker `{ mode, from, to, truncated }`, followed by the bytes
 *      `[from, to)` as binary frames and then `{ type: 'live', seq: to }`.
 *      - `mode: 'delta'` — exactly what the client missed. Append it.
 *      - `mode: 'full'`  — the client's position is unknown or too old. Reset
 *        the terminal widget, then write the replay. `truncated` says that
 *        older output was dropped from the buffer.
 *   3. From then on output arrives live.
 *
 * Sequence numbers count output bytes since the session started. A client
 * keeps one number: set it to `replay.from` when `attached` arrives and add
 * the length of every binary frame. That number is what it sends as `after`
 * next time.
 *
 * Several clients may be attached to one session (two devices). Input from
 * any of them reaches the program, output goes to all of them, and the
 * terminal takes the size of the client that was active most recently; every
 * client is told the size in a `resize` frame.
 *
 * Other server frames: `session` (title or attached-client count changed),
 * `url` (the program printed the address of a local development server —
 * each address once per session; the ones seen so far are in
 * `session.urls`), `pong`, `error` (sent just before the server closes the
 * socket for a reason), and `exit` (the program ended, or the session was
 * closed, expired or shut down). After `exit` the socket is closed with
 * `ended`.
 *
 * The server pings every `limits.heartbeatMs`; browsers answer by themselves.
 * A client that stops reading is first throttled (the program is paused) and
 * then dropped with `slowConsumer`; it can attach again with `after`.
 */

export const TERMINAL_PROTOCOL_VERSION = 1;

/** WebSocket close codes used by the terminal endpoint. */
export const TERMINAL_CLOSE_CODES = {
  /** The client broke the protocol (malformed, unexpected or oversized frame). */
  protocol: 4400,
  /** The browser session ended or was revoked: sign in again. */
  authEnded: 4401,
  /** Confirm your identity (step-up), then attach again. */
  reauthRequired: 4403,
  /** No such session — also used for a session that belongs to someone else. */
  notFound: 4404,
  /** The client was not reading fast enough: attach again with `after`. */
  slowConsumer: 4408,
  /** The session is over; an `exit` frame preceded this. */
  ended: 4410,
  /** Too many clients are attached to this session. */
  tooManyClients: 4429,
  /** Terminals are turned off or cannot run on this server. */
  unavailable: 4503,
  /** The server is shutting down (standard code). */
  goingAway: 1001,
} as const;

export const TERMINAL_COLS = { min: 2, max: 1000, default: 80 } as const;
export const TERMINAL_ROWS = { min: 1, max: 500, default: 24 } as const;
export const terminalColsSchema = z.number().int().min(TERMINAL_COLS.min).max(TERMINAL_COLS.max);
export const terminalRowsSchema = z.number().int().min(TERMINAL_ROWS.min).max(TERMINAL_ROWS.max);

/** One line, no control characters. */
export const terminalTitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\u0000-\u001f\u007f-\u009f]*$/, 'A title cannot contain control characters.');

/** Launchers are chosen by key from the server's fixed list (see `TerminalCapability.launchers`). */
export const terminalLauncherKeySchema = z.string().regex(/^[a-z][a-z0-9-]{1,39}$/, 'Not a launcher key.');

/** Launchers the server always knows: the sign-in commands of the supported agent CLIs. */
export const TERMINAL_LAUNCHERS = {
  claudeLogin: 'claude-login',
  codexLogin: 'codex-login',
  /** Codex sign-in with a code typed on another device — the one that works from a phone. */
  codexLoginDevice: 'codex-login-device',
} as const;

export const terminalRemoteTargetSchema = z.strictObject({
  hostId: remoteHostIdSchema,
  /** Where to start on the host. Defaults to the host's configured directory, else the remote home. */
  directory: remoteDirectorySchema.optional(),
});
export type TerminalRemoteTarget = z.infer<typeof terminalRemoteTargetSchema>;

/**
 * What a client may say when it opens a terminal. Note what is absent: there
 * is no path, no program, no arguments and no environment. Unknown keys are
 * refused.
 */
export const createTerminalSessionRequestSchema = z.strictObject({
  /** The session starts in this project's folder. Required unless the launcher says otherwise. */
  projectId: idSchema.optional(),
  /** Omit for the login shell. */
  launcher: terminalLauncherKeySchema.optional(),
  /** Required by remote launchers, refused by all others. */
  remote: terminalRemoteTargetSchema.optional(),
  cols: terminalColsSchema.default(TERMINAL_COLS.default),
  rows: terminalRowsSchema.default(TERMINAL_ROWS.default),
  title: terminalTitleSchema.optional(),
});
export type CreateTerminalSessionRequest = z.infer<typeof createTerminalSessionRequestSchema>;

export const renameTerminalSessionRequestSchema = z.strictObject({ title: terminalTitleSchema });
export type RenameTerminalSessionRequest = z.infer<typeof renameTerminalSessionRequestSchema>;

/** The address of a development server that a program printed. */
export const terminalLocalUrlSchema = z.object({
  /** As printed, without trailing punctuation. */
  url: z.string(),
  scheme: z.enum(['http', 'https']),
  /** `localhost`, a `127.x.x.x` address, `0.0.0.0`, `[::1]` or `[::]`. */
  host: z.string(),
  port: z.number().int().min(1).max(65535),
});
export type TerminalLocalUrl = z.infer<typeof terminalLocalUrlSchema>;

/**
 * `exited` — the program ended by itself; `closed` — a user closed the
 * session; `idle` — nobody was attached for the idle window; `lifetime` — it
 * reached the maximum age; `shutdown` — the server stopped; `revoked` — its
 * user lost the right to a terminal; `project_removed` — its project was
 * removed; `failed` — the program could not be kept running.
 */
export const terminalEndReasonSchema = z.enum(['exited', 'closed', 'idle', 'lifetime', 'shutdown', 'revoked', 'project_removed', 'failed']);
export type TerminalEndReason = z.infer<typeof terminalEndReasonSchema>;

export const terminalSessionSchema = z.object({
  id: idSchema,
  projectId: idSchema.nullable(),
  title: z.string(),
  /** Null for the login shell. */
  launcher: z.string().nullable(),
  /** Set when the session runs on a remote host. */
  remoteHostId: z.string().nullable(),
  /** Where it started: the project folder, or the directory on the remote host. Null when neither applies. */
  directory: z.string().nullable(),
  createdAt: timestampSchema,
  /** Last time something was typed or printed, or a client came or went. */
  lastActivityAt: timestampSchema,
  attachedClients: z.number().int().nonnegative(),
  alive: z.boolean(),
  /** Set once the program has ended. Null while it runs, and when it was ended by a signal. */
  exitCode: z.number().int().nullable(),
  signal: z.number().int().nullable(),
  endReason: terminalEndReasonSchema.nullable(),
  cols: z.number().int(),
  rows: z.number().int(),
  /** Output bytes produced so far. */
  seq: z.number().int().nonnegative(),
  urls: z.array(terminalLocalUrlSchema),
  /** False when this browser must confirm the user's identity before it may attach. */
  attachable: z.boolean(),
  /** When the session will be ended for being unattended; null while a client is attached or after it ended. */
  idleExpiresAt: timestampSchema.nullable(),
  /** When the session reaches its maximum age. */
  expiresAt: timestampSchema,
});
export type TerminalSession = z.infer<typeof terminalSessionSchema>;

export const terminalSessionListSchema = z.object({ sessions: z.array(terminalSessionSchema) });
export type TerminalSessionList = z.infer<typeof terminalSessionListSchema>;

export const closeTerminalSessionResponseSchema = z.object({
  closed: z.literal(true),
  /** Processes of the session that could not be ended. Zero unless something is badly wrong on the host. */
  remainingProcesses: z.number().int().nonnegative(),
});
export type CloseTerminalSessionResponse = z.infer<typeof closeTerminalSessionResponseSchema>;

export const TYPED_TEXT_MAX_CHARS = 4000;
export const typeTextRequestSchema = z.strictObject({ text: z.string().min(1).max(TYPED_TEXT_MAX_CHARS) });
export type TypeTextRequest = z.infer<typeof typeTextRequestSchema>;

export const typeTextResponseSchema = z.object({
  /** Exactly what was typed, after control characters were removed. Enter was not pressed. */
  typed: z.string(),
  /** How many characters were removed. */
  removed: z.number().int().nonnegative(),
});
export type TypeTextResponse = z.infer<typeof typeTextResponseSchema>;

export const terminalLauncherInfoSchema = z.object({
  key: z.string(),
  /** English label; clients translate the keys they know. */
  title: z.string(),
  kind: z.enum(['agent-sign-in', 'remote', 'other']),
  requiresProject: z.boolean(),
  /** Whether `remote: { hostId, directory? }` must accompany it. */
  requiresRemote: z.boolean(),
  available: z.boolean(),
  /** Why it cannot be started here (for example: the program is not installed). */
  unavailableReason: z.string().nullable(),
});
export type TerminalLauncherInfo = z.infer<typeof terminalLauncherInfoSchema>;

export const terminalUnavailableCodeSchema = z.enum(['disabled', 'owner_only', 'session_required', 'pty_unavailable']);

export const terminalCapabilitySchema = z.object({
  available: z.boolean(),
  /** Why not, when `available` is false. */
  reason: z.object({ code: terminalUnavailableCodeSchema, message: z.string() }).nullable(),
  /** True when creating a session right now would first ask for a proof of identity. */
  needsReauth: z.boolean(),
  /** Name of the shell a plain session starts, e.g. "bash". */
  shell: z.string().nullable(),
  launchers: z.array(terminalLauncherInfoSchema),
  limits: z.object({
    maxSessionsPerUser: z.number().int(),
    maxSessions: z.number().int(),
    maxClientsPerSession: z.number().int(),
    idleTimeoutMs: z.number().int(),
    maxLifetimeMs: z.number().int(),
    replayBufferBytes: z.number().int(),
    maxInputFrameBytes: z.number().int(),
    typedTextMaxChars: z.number().int(),
  }),
});
export type TerminalCapability = z.infer<typeof terminalCapabilitySchema>;

// ── WebSocket control frames ─────────────────────────────────────────────────

export const terminalAttachFrameSchema = z.strictObject({
  type: z.literal('attach'),
  /** The sequence number this client has reached, or null/absent for "from the start of what is kept". */
  after: z.number().int().nonnegative().nullable().optional(),
  cols: terminalColsSchema,
  rows: terminalRowsSchema,
});
export type TerminalAttachFrame = z.infer<typeof terminalAttachFrameSchema>;

export const terminalClientFrameSchema = z.discriminatedUnion('type', [
  terminalAttachFrameSchema,
  z.strictObject({ type: z.literal('resize'), cols: terminalColsSchema, rows: terminalRowsSchema }),
  z.strictObject({ type: z.literal('ping'), t: z.number().optional() }),
]);
export type TerminalClientFrame = z.infer<typeof terminalClientFrameSchema>;

export const terminalReplaySchema = z.object({
  mode: z.enum(['delta', 'full']),
  /** Sequence number of the first replayed byte. */
  from: z.number().int().nonnegative(),
  /** Sequence number after the last replayed byte; live output continues from here. */
  to: z.number().int().nonnegative(),
  /** Older output existed but is no longer kept. */
  truncated: z.boolean(),
});
export type TerminalReplay = z.infer<typeof terminalReplaySchema>;

export const terminalAttachedFrameSchema = z.object({
  type: z.literal('attached'),
  protocol: z.number().int(),
  clientId: z.string(),
  session: terminalSessionSchema,
  replay: terminalReplaySchema,
  limits: z.object({ maxInputFrameBytes: z.number().int(), heartbeatMs: z.number().int() }),
});
export type TerminalAttachedFrame = z.infer<typeof terminalAttachedFrameSchema>;

export const terminalExitFrameSchema = z.object({
  type: z.literal('exit'),
  exitCode: z.number().int().nullable(),
  signal: z.number().int().nullable(),
  reason: terminalEndReasonSchema,
  /** Total output bytes of the session. */
  seq: z.number().int().nonnegative(),
});
export type TerminalExitFrame = z.infer<typeof terminalExitFrameSchema>;

export const terminalErrorCodeSchema = z.enum([
  'malformed_frame',
  'attach_expected',
  'already_attached',
  'frame_too_large',
  'too_many_clients',
  'slow_consumer',
  'session_not_found',
  'reauth_required',
  'terminal_disabled',
  'terminal_unavailable',
  'session_ended',
]);
export type TerminalErrorCode = z.infer<typeof terminalErrorCodeSchema>;

export const terminalServerFrameSchema = z.discriminatedUnion('type', [
  terminalAttachedFrameSchema,
  z.object({ type: z.literal('live'), seq: z.number().int().nonnegative() }),
  z.object({ type: z.literal('resize'), cols: z.number().int(), rows: z.number().int() }),
  z.object({ type: z.literal('session'), session: terminalSessionSchema }),
  z.object({ type: z.literal('url'), url: terminalLocalUrlSchema }),
  terminalExitFrameSchema,
  z.object({ type: z.literal('pong'), t: z.number().optional() }),
  z.object({ type: z.literal('error'), code: terminalErrorCodeSchema, message: z.string() }),
]);
export type TerminalServerFrame = z.infer<typeof terminalServerFrameSchema>;

export const terminalSocketPath = (sessionId: string) => `/api/terminal/sessions/${sessionId}/socket`;

/**
 * Published on the creating user's realtime topic (`user:<id>`) so that other
 * tabs can refresh their list. They carry ids only — never output or input.
 */
export const TERMINAL_EVENTS = {
  created: 'terminal.session.created',
  updated: 'terminal.session.updated',
  ended: 'terminal.session.ended',
  removed: 'terminal.session.removed',
} as const;
