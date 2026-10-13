/**
 * Every bound the terminal feature enforces, in one place. The defaults suit
 * a personal server; tests inject smaller values so that an idle window or a
 * heartbeat takes milliseconds.
 */
export interface TerminalLimits {
  /** Live terminals one user may have. */
  readonly maxSessionsPerUser: number;
  /** Live terminals on the whole server. */
  readonly maxSessions: number;
  /** Devices attached to one terminal at the same time. */
  readonly maxClientsPerSession: number;
  /** Ended terminals kept per user so that a late client can still read how they ended. */
  readonly maxEndedSessionsPerUser: number;

  /** Output kept for replay, per terminal. */
  readonly replayBufferBytes: number;
  /** A terminal nobody is attached to is ended after this long. */
  readonly idleTimeoutMs: number;
  /** A terminal is ended at this age no matter what. */
  readonly maxLifetimeMs: number;
  /** How long an ended terminal stays listed. */
  readonly endedRetentionMs: number;

  /** Server pings; a client that has not answered by the next one is dropped. */
  readonly heartbeatMs: number;
  /** A connection must send its attach frame within this time. */
  readonly attachTimeoutMs: number;

  /** Largest keyboard-input frame. */
  readonly maxInputFrameBytes: number;
  /** Largest JSON control frame. */
  readonly maxControlFrameBytes: number;
  /** Input a client may send at once before it is slowed down … */
  readonly inputBurstBytes: number;
  /** … and the sustained rate it is slowed down to. */
  readonly inputBytesPerSecond: number;

  /** Unsent output per client above which the program is paused … */
  readonly clientBufferHighBytes: number;
  /** … and below which it is resumed. */
  readonly clientBufferLowBytes: number;
  /** Unsent output per client above which the client is dropped at once. */
  readonly clientBufferHardBytes: number;
  /** A client that stays above the low mark this long after exceeding the high mark is dropped. */
  readonly slowClientGraceMs: number;

  /** After the hang-up signal, how long processes get before they are killed. */
  readonly terminateGraceMs: number;
  /** After the kill, how long to wait before reporting what is left. */
  readonly killWaitMs: number;
  /** Quiet time after which an address at the very end of the output counts as complete. */
  readonly urlFlushMs: number;
  /** Distinct development-server addresses remembered per terminal. */
  readonly maxUrlsPerSession: number;
}

const KIB = 1024;
const MIB = 1024 * KIB;
const MINUTE = 60_000;

export const DEFAULT_TERMINAL_LIMITS: TerminalLimits = {
  maxSessionsPerUser: 16,
  maxSessions: 32,
  maxClientsPerSession: 4,
  maxEndedSessionsPerUser: 16,

  replayBufferBytes: 1 * MIB,
  idleTimeoutMs: 30 * MINUTE,
  maxLifetimeMs: 7 * 24 * 60 * MINUTE,
  endedRetentionMs: 10 * MINUTE,

  heartbeatMs: 30_000,
  attachTimeoutMs: 10_000,

  maxInputFrameBytes: 64 * KIB,
  maxControlFrameBytes: 4 * KIB,
  inputBurstBytes: 512 * KIB,
  inputBytesPerSecond: 128 * KIB,

  clientBufferHighBytes: 2 * MIB,
  clientBufferLowBytes: 512 * KIB,
  clientBufferHardBytes: 8 * MIB,
  slowClientGraceMs: 15_000,

  terminateGraceMs: 1500,
  killWaitMs: 1500,
  urlFlushMs: 250,
  maxUrlsPerSession: 64,
};

/** The longest delay a timer accepts. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

export function resolveLimits(overrides: Partial<TerminalLimits> = {}): TerminalLimits {
  const limits = { ...DEFAULT_TERMINAL_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Terminal limit "${name}" must be a positive number.`);
  }
  if (limits.clientBufferLowBytes >= limits.clientBufferHighBytes || limits.clientBufferHighBytes > limits.clientBufferHardBytes) {
    throw new Error('Terminal client buffer marks must rise: low < high <= hard.');
  }
  return limits;
}
