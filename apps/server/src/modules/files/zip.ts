import type { Readable } from 'node:stream';
import { Transform, pipeline } from 'node:stream';
import { crc32, createDeflateRaw } from 'node:zlib';

/**
 * A small streaming ZIP writer.
 *
 * Entries are written one after another as they are read, so an archive of
 * any size needs only a little memory: each file is deflated on the fly, and
 * its checksum and sizes — unknown until its last byte — follow it in a "data
 * descriptor". The central directory at the end repeats them.
 *
 * The classic format is used on purpose (no ZIP64): every unzip tool reads
 * it. That caps an archive at 65,535 entries and at 4 GiB per file and in
 * total; the writer refuses, with a {@link ZipLimitError}, anything that
 * would cross those lines rather than produce a file that some tools misread.
 *
 * Format reference: PKWARE's APPNOTE.TXT, sections 4.3 and 4.4.
 */

export interface ZipEntry {
  /** Path inside the archive, forward slashes, no leading slash. Directories need no trailing slash. */
  readonly name: string;
  readonly directory?: boolean;
  readonly modifiedAt?: Date;
  /** Unix permission bits. */
  readonly mode?: number;
  /**
   * Opens the content of a file entry. Returning null skips the entry (the
   * file vanished or may not be read) without spoiling the archive.
   */
  readonly open?: () => Promise<Readable | null>;
}

export class ZipLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipLimitError';
  }
}

export const ZIP_MAX_ENTRIES = 0xffff;
export const ZIP_MAX_BYTES = 0xffffffff;

const SIG_LOCAL = 0x04034b50;
const SIG_DESCRIPTOR = 0x08074b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;

const VERSION_NEEDED = 20; // 2.0: deflate and directories
const VERSION_MADE_BY = (3 << 8) | 30; // "Unix", so that permission bits are honoured
const FLAG_DESCRIPTOR = 0x0008;
const FLAG_UTF8 = 0x0800;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

interface Recorded {
  readonly name: Buffer;
  readonly method: number;
  readonly flags: number;
  readonly time: number;
  readonly date: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly offset: number;
  readonly externalAttributes: number;
}

/** MS-DOS date and time, the only kind the classic format knows: two-second resolution, years 1980–2107, local time. */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** Rejects names that an extractor could be tricked by, and normalises the directory form. */
export function zipEntryName(name: string, directory: boolean): string {
  const cleaned = name.replace(/\/+$/, '');
  const parts = cleaned.split('/');
  if (cleaned.length === 0 || cleaned.includes('\0') || cleaned.includes('\\') || cleaned.startsWith('/') || parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`"${name}" cannot be a name inside an archive.`);
  }
  return directory ? `${cleaned}/` : cleaned;
}

/** Produces the bytes of a ZIP archive for the given entries, in order. */
export async function* zipStream(entries: Iterable<ZipEntry> | AsyncIterable<ZipEntry>): AsyncGenerator<Buffer, void, void> {
  const recorded: Recorded[] = [];
  let offset = 0;

  for await (const entry of entries) {
    const directory = entry.directory === true;
    const name = Buffer.from(zipEntryName(entry.name, directory), 'utf8');
    if (name.length > 0xffff) throw new ZipLimitError('A file name is too long for a ZIP archive.');
    const source = directory ? null : ((await entry.open?.()) ?? null);
    if (!directory && source === null) continue;
    if (recorded.length >= ZIP_MAX_ENTRIES) {
      source?.destroy();
      throw new ZipLimitError('Too many entries for a ZIP archive.');
    }

    const stamp = dosDateTime(entry.modifiedAt ?? new Date());
    const flags = FLAG_UTF8 | (directory ? 0 : FLAG_DESCRIPTOR);
    const method = directory ? METHOD_STORED : METHOD_DEFLATE;
    const start = offset;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(VERSION_NEEDED, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    // Checksum and sizes stay zero here; they follow the data.
    local.writeUInt16LE(name.length, 26);
    yield local;
    yield name;
    offset += local.length + name.length;

    let crc = 0;
    let size = 0;
    let compressedSize = 0;
    if (source) {
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          crc = crc32(chunk, crc);
          size += chunk.length;
          done(null, chunk);
        },
      });
      const deflate = createDeflateRaw();
      // A failure anywhere tears the whole chain down and surfaces from the loop below.
      pipeline(source, counter, deflate, () => {});
      for await (const chunk of deflate as AsyncIterable<Buffer>) {
        compressedSize += chunk.length;
        if (size > ZIP_MAX_BYTES || compressedSize > ZIP_MAX_BYTES) {
          source.destroy();
          throw new ZipLimitError('A file is too large for a ZIP archive.');
        }
        yield chunk;
      }
      offset += compressedSize;

      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(SIG_DESCRIPTOR, 0);
      descriptor.writeUInt32LE(crc >>> 0, 4);
      descriptor.writeUInt32LE(compressedSize, 8);
      descriptor.writeUInt32LE(size, 12);
      yield descriptor;
      offset += descriptor.length;
    }
    if (offset > ZIP_MAX_BYTES) throw new ZipLimitError('The archive would be too large for the ZIP format.');

    const mode = entry.mode ?? (directory ? 0o755 : 0o644);
    recorded.push({
      name,
      method,
      flags,
      time: stamp.time,
      date: stamp.date,
      crc: crc >>> 0,
      compressedSize,
      size,
      offset: start,
      // High half: Unix type and permissions. Low byte: the MS-DOS "directory" attribute.
      externalAttributes: ((((directory ? 0o040000 : 0o100000) | (mode & 0o7777)) << 16) | (directory ? 0x10 : 0)) >>> 0,
    });
  }

  const directoryStart = offset;
  for (const entry of recorded) {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(SIG_CENTRAL, 0);
    header.writeUInt16LE(VERSION_MADE_BY, 4);
    header.writeUInt16LE(VERSION_NEEDED, 6);
    header.writeUInt16LE(entry.flags, 8);
    header.writeUInt16LE(entry.method, 10);
    header.writeUInt16LE(entry.time, 12);
    header.writeUInt16LE(entry.date, 14);
    header.writeUInt32LE(entry.crc, 16);
    header.writeUInt32LE(entry.compressedSize, 20);
    header.writeUInt32LE(entry.size, 24);
    header.writeUInt16LE(entry.name.length, 28);
    // extra length, comment length, disk number, internal attributes: all zero
    header.writeUInt32LE(entry.externalAttributes, 38);
    header.writeUInt32LE(entry.offset, 42);
    yield header;
    yield entry.name;
    offset += header.length + entry.name.length;
  }
  if (offset > ZIP_MAX_BYTES) throw new ZipLimitError('The archive would be too large for the ZIP format.');

  const end = Buffer.alloc(22);
  end.writeUInt32LE(SIG_END, 0);
  end.writeUInt16LE(recorded.length, 8);
  end.writeUInt16LE(recorded.length, 10);
  end.writeUInt32LE(offset - directoryStart, 12);
  end.writeUInt32LE(directoryStart, 16);
  yield end;
}
