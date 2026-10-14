import { redactSecrets } from './redact.js';

/**
 * The end of what a program printed, kept to explain a failure, with
 * credentials removed.
 *
 * Output arrives in chunks that may split a secret anywhere, and only the end
 * of it is kept. Redacting a chunk at a time would miss a secret split between
 * two chunks; cutting first and redacting afterwards would leave the part of a
 * secret behind the cut, which no pattern recognises any more. So the raw text
 * is kept with as much again in reserve, redacted as a whole, and only then cut
 * to the length asked for: a secret that straddles the cut is redacted while it
 * is still whole, and what is cut off is the reserve.
 */
export class OutputTail {
  readonly #max: number;
  #raw = '';

  constructor(maxChars: number) {
    this.#max = maxChars;
  }

  append(text: string): void {
    this.#raw = (this.#raw + text).slice(-2 * this.#max);
  }

  /** At most `maxChars` characters, redacted. */
  text(): string {
    return redactSecrets(this.#raw).slice(-this.#max);
  }
}
