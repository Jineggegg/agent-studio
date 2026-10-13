/**
 * The hard limits of one turn of an API-model agent. A model decides how many
 * tools it calls and how much they print; these bounds decide how far that
 * can go before the Studio ends the turn, with a notice in the transcript.
 *
 * Defaults are for real use. `createProvidersModule({ limits })` overrides
 * them (tests use small numbers).
 */
export interface ApiAgentLimits {
  /** Model requests in one turn that came back asking for tools. */
  readonly maxToolRounds: number;
  /** Tool calls carried out in one turn. */
  readonly maxToolCalls: number;
  /**
   * Working time of one turn: talking to the model and running tools. Time
   * spent waiting for a person to answer an approval does not count.
   */
  readonly maxTurnMs: number;
  /** Bytes of one tool result handed back to the model; the middle of a longer result is cut out. */
  readonly maxResultBytes: number;
  /** Bytes of all tool results handed back in one turn. */
  readonly maxTurnResultBytes: number;
  /** How long a command may run when the model names no timeout. */
  readonly commandTimeoutMs: number;
  /** The longest timeout a model may ask for. */
  readonly maxCommandTimeoutMs: number;
  /** Bytes of standard output, and of standard error, kept from one command. */
  readonly commandOutputBytes: number;
  /** How long the provider may take to start answering a request. */
  readonly responseStartMs: number;
  /** How long a started answer may stay silent before it is given up. */
  readonly streamIdleMs: number;
  /** Files larger than this are not read or edited by the file tools. */
  readonly maxFileBytes: number;
  /** The largest file `write_file` creates. */
  readonly maxWriteBytes: number;
  /** Entries a directory walk (`find_files`, `search_text`) looks at. */
  readonly maxWalkEntries: number;
  /** How long a directory walk may take. */
  readonly maxWalkMs: number;
  /** Tools declared to the model in one request (project tools first, then the Studio's). */
  readonly maxDeclaredTools: number;
}

export const DEFAULT_LIMITS: ApiAgentLimits = {
  maxToolRounds: 30,
  maxToolCalls: 80,
  maxTurnMs: 20 * 60_000,
  maxResultBytes: 24 * 1024,
  maxTurnResultBytes: 384 * 1024,
  commandTimeoutMs: 120_000,
  maxCommandTimeoutMs: 600_000,
  commandOutputBytes: 256 * 1024,
  responseStartMs: 60_000,
  streamIdleMs: 120_000,
  maxFileBytes: 2 * 1024 * 1024,
  maxWriteBytes: 1024 * 1024,
  maxWalkEntries: 50_000,
  maxWalkMs: 10_000,
  maxDeclaredTools: 64,
};

/** The window assumed for a model whose catalogue entry names none: small enough to be safe for a local model. */
export const FALLBACK_CONTEXT_WINDOW = 32_000;
/** Tokens kept free for the model's answer when history is trimmed. */
export const ANSWER_RESERVE_TOKENS = 8_192;
/** What an attached image is counted as when history is trimmed. An estimate: providers count images differently. */
export const IMAGE_TOKENS = 1_200;
/** The largest image handed to a model, and the most image bytes in one message. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGES_BYTES = 20 * 1024 * 1024;
/** The largest text attachment placed into the prompt. */
export const MAX_TEXT_ATTACHMENT_BYTES = 100 * 1024;
