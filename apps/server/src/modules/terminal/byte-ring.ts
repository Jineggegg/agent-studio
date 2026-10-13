/**
 * The replay buffer of a terminal session: the most recent output bytes, with
 * every byte addressed by its position in the whole stream ("sequence
 * number"). Memory is bounded by `capacity`; storage starts small and grows
 * only as output arrives, so an idle shell costs a few kilobytes.
 *
 * Bytes are copied in, so the buffer never keeps a caller's chunk alive.
 */
export class ByteRing {
  readonly #capacity: number;
  #buffer: Buffer;
  /** Index in `#buffer` of the oldest kept byte. */
  #head = 0;
  #length = 0;
  /** Sequence number just past the newest byte: the total ever written. */
  #end = 0;

  constructor(capacity: number, initialSize = 16 * 1024) {
    if (!Number.isInteger(capacity) || capacity <= 0) throw new Error('A replay buffer needs a positive capacity.');
    this.#capacity = capacity;
    this.#buffer = Buffer.allocUnsafe(Math.min(capacity, Math.max(1, initialSize)));
  }

  get capacity(): number {
    return this.#capacity;
  }

  /** Sequence number of the oldest byte still kept. */
  get start(): number {
    return this.#end - this.#length;
  }

  /** Sequence number the next written byte will get. */
  get end(): number {
    return this.#end;
  }

  get length(): number {
    return this.#length;
  }

  write(chunk: Uint8Array): void {
    if (chunk.length === 0) return;

    if (chunk.length >= this.#capacity) {
      // Only the tail of a huge chunk can be kept.
      if (this.#buffer.length < this.#capacity) this.#buffer = Buffer.allocUnsafe(this.#capacity);
      this.#buffer.set(chunk.subarray(chunk.length - this.#capacity), 0);
      this.#head = 0;
      this.#length = this.#capacity;
      this.#end += chunk.length;
      return;
    }

    const wanted = Math.min(this.#capacity, this.#length + chunk.length);
    if (wanted > this.#buffer.length) this.#grow(wanted);

    const size = this.#buffer.length;
    const overflow = this.#length + chunk.length - size;
    if (overflow > 0) {
      this.#head = (this.#head + overflow) % size;
      this.#length -= overflow;
    }
    const tail = (this.#head + this.#length) % size;
    const first = Math.min(chunk.length, size - tail);
    this.#buffer.set(chunk.subarray(0, first), tail);
    if (first < chunk.length) this.#buffer.set(chunk.subarray(first), 0);
    this.#length += chunk.length;
    this.#end += chunk.length;
  }

  /**
   * A copy of the bytes from sequence number `from` to the end. `from` is
   * clamped into what is still kept.
   */
  read(from: number = this.start): Buffer {
    const begin = Math.min(Math.max(from, this.start), this.#end);
    const count = this.#end - begin;
    const out = Buffer.allocUnsafe(count);
    if (count === 0) return out;
    const size = this.#buffer.length;
    const index = (this.#head + (begin - this.start)) % size;
    const first = Math.min(count, size - index);
    this.#buffer.copy(out, 0, index, index + first);
    if (first < count) this.#buffer.copy(out, first, 0, count - first);
    return out;
  }

  #grow(wanted: number): void {
    const size = Math.min(this.#capacity, Math.max(wanted, this.#buffer.length * 2));
    const next = Buffer.allocUnsafe(size);
    const kept = this.read();
    next.set(kept, 0);
    this.#buffer = next;
    this.#head = 0;
  }
}

/**
 * Where to begin replaying a buffer whose beginning was cut off at an
 * arbitrary byte. Starting in the middle of a character or of an escape
 * sequence would print garbage, so the replay starts after the first line
 * break when there is one nearby, and otherwise at least on a character
 * boundary. Returns the number of leading bytes to skip.
 */
export function alignReplayStart(bytes: Uint8Array, searchLimit = 4096): number {
  const limit = Math.min(bytes.length, searchLimit);
  for (let index = 0; index < limit; index += 1) {
    if (bytes[index] === 0x0a) return index + 1;
  }
  // No line break in reach: skip the continuation bytes of a split UTF-8 character.
  let skip = 0;
  while (skip < Math.min(3, bytes.length) && (bytes[skip]! & 0xc0) === 0x80) skip += 1;
  return skip;
}
