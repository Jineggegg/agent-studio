// @ts-check
import { Buffer } from 'node:buffer';

/**
 * Framing of the channel between the Studio and a plugin process: one JSON
 * object per line (UTF-8, terminated by "\n"), JSON-RPC 2.0 inside.
 *
 * The decoder never trusts its input: a line longer than the limit is dropped
 * without being buffered, and text that is not a JSON object is reported
 * instead of thrown.
 */

export const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;

/**
 * @param {{
 *   maxBytes?: number,
 *   onMessage: (message: Record<string, unknown>) => void,
 *   onProblem: (problem: import('./types.js').FramingProblem) => void,
 * }} options
 * @returns {import('./types.js').Decoder}
 */
export function createDecoder(options) {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
  /** @type {Buffer[]} */
  let parts = [];
  let size = 0;
  /** True while the rest of an over-long line is being thrown away. */
  let discarding = false;

  /** @param {Buffer} line */
  const emit = (line) => {
    let end = line.length;
    if (end > 0 && line[end - 1] === 0x0d) end -= 1;
    const text = line.toString('utf8', 0, end).trim();
    if (text === '') return;
    /** @type {unknown} */
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      options.onProblem({ kind: 'invalid-json' });
      return;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      options.onProblem({ kind: 'not-an-object' });
      return;
    }
    options.onMessage(/** @type {Record<string, unknown>} */ (value));
  };

  return {
    push(chunk) {
      let rest = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      while (rest.length > 0) {
        const newline = rest.indexOf(0x0a);
        if (newline === -1) {
          if (discarding) return;
          if (size + rest.length > maxBytes) {
            parts = [];
            size = 0;
            discarding = true;
            options.onProblem({ kind: 'oversized' });
            return;
          }
          // Copy: the caller may reuse the chunk's memory once this returns.
          parts.push(Buffer.from(rest));
          size += rest.length;
          return;
        }
        const head = rest.subarray(0, newline);
        rest = rest.subarray(newline + 1);
        if (discarding) {
          discarding = false;
          continue;
        }
        if (size + head.length > maxBytes) {
          parts = [];
          size = 0;
          options.onProblem({ kind: 'oversized' });
          continue;
        }
        const line = parts.length === 0 ? head : Buffer.concat([...parts, head]);
        parts = [];
        size = 0;
        emit(line);
      }
    },
  };
}

/**
 * One message as a line of text.
 * @param {unknown} message
 * @returns {string}
 */
export function encodeMessage(message) {
  return JSON.stringify(message) + '\n';
}
