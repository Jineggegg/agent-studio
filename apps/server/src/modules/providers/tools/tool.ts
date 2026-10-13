import type { FileDiff, ToolKind } from '@agent-studio/protocol';
import type { PermissionRequest } from '../../agents/adapter.js';
import type { ToolDeclaration } from '../openai-client.js';

/**
 * One tool an API model may call, and the two steps every call goes through:
 *
 * 1. `prepare` checks the arguments and works out — without changing
 *    anything — what exactly would happen: the real path, the diff, the
 *    command. Whatever is wrong at this point is a {@link ToolRefusal}.
 * 2. The turn puts each of `permissions` to the Studio's permission engine,
 *    in order, and only when all are allowed calls `run`.
 *
 * A tool never asks for permission itself and never runs before `run`.
 */
export interface ModelTool {
  readonly declaration: ToolDeclaration;
  /** What the tool does in general — used for the transcript when a call is refused before it could be prepared. */
  readonly kind: ToolKind;
  prepare(args: unknown): Promise<PreparedCall>;
}

/** What is put to the permission engine. The turn adds the call id and the input. */
export type PermissionAsk = Omit<PermissionRequest, 'toolCallId' | 'input' | 'approval' | 'plan'>;

export interface PreparedCall {
  /** What the tool really does: the transcript and the permission engine are told the same. */
  readonly kind: ToolKind;
  /** A few words for the transcript: "Read src/app.ts". */
  readonly title: string;
  /** The arguments as checked, with defaults filled in. */
  readonly input: unknown;
  /** Asked in order; every one has to be allowed. Empty for tools whose permission is handled elsewhere. */
  readonly permissions: readonly PermissionAsk[];
  /** `run` may itself wait for a person (the Studio's own write tools ask inside): its duration is not counted as working time. */
  readonly waitsForPeople?: boolean;
  run(io: ToolIo): Promise<ToolOutcome>;
}

export interface ToolIo {
  /** Aborts when the run is stopped or its time is up. */
  readonly signal: AbortSignal;
  /** Output for people watching, as it is produced. */
  output(text: string): void;
  /** Something the user should know. The same code is shown once per turn. */
  notice(level: 'info' | 'warning', code: string, text: string): void;
}

export interface ToolOutcome {
  readonly status: 'ok' | 'error' | 'denied';
  /** What the model is told (and the transcript keeps). */
  readonly text: string;
  readonly diffs?: readonly FileDiff[];
}

/** A call that cannot be carried out as asked. The message is written for the model and safe to show. */
export class ToolRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolRefusal';
  }
}

export const clipText = (text: string, limit: number): string => (text.length > limit ? `${text.slice(0, Math.max(0, limit - 1))}…` : text);

/** One line for a title: no line breaks, bounded. */
export const oneLine = (text: string, limit = 120): string => clipText(text.replace(/\s+/g, ' ').trim(), limit);

/**
 * Bounds a tool result to `maxBytes` of UTF-8 by cutting out the middle, so
 * the model keeps the start (what the output is) and the end (how it ended).
 */
export function boundResult(text: string, maxBytes: number): { text: string; omittedBytes: number } {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return { text, omittedBytes: 0 };
  const marker = (omitted: number): string => `\n[… ${omitted} bytes left out by the Studio: the result was too long …]\n`;
  const room = Math.max(0, maxBytes - Buffer.byteLength(marker(bytes.length)));
  const head = Math.ceil(room * 0.6);
  const tail = room - head;
  const omitted = bytes.length - head - tail;
  // Cutting inside a multi-byte character leaves replacement characters; strip them at the seams.
  const start = bytes.subarray(0, head).toString('utf8').replace(/�+$/, '');
  const end = tail > 0 ? bytes.subarray(bytes.length - tail).toString('utf8').replace(/^�+/, '') : '';
  return { text: `${start}${marker(omitted)}${end}`, omittedBytes: omitted };
}
