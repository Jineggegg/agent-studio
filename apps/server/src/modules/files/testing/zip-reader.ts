import { crc32, inflateRawSync } from 'node:zlib';

/**
 * A minimal ZIP *reader*, kept apart from the writer on purpose: tests use it
 * to check archives the way an unzip tool would — from the central directory
 * at the end, back to each entry's local header and data — instead of
 * trusting the writer's own bookkeeping. Production code never reads archives.
 */
export interface ZipReadEntry {
  readonly name: string;
  readonly directory: boolean;
  readonly method: number;
  readonly flags: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly size: number;
  /** Unix permission bits. */
  readonly mode: number;
  readonly data: Buffer;
}

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Not a valid ZIP archive: ${message}`);
}

export function readZip(archive: Buffer): ZipReadEntry[] {
  const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  check(end >= 0, 'no end-of-central-directory record');
  check(end + 22 === archive.length, 'bytes after the end record');
  const count = archive.readUInt16LE(end + 10);
  check(archive.readUInt16LE(end + 8) === count, 'entry counts disagree');
  const directorySize = archive.readUInt32LE(end + 12);
  let offset = archive.readUInt32LE(end + 16);
  check(offset + directorySize === end, 'the central directory does not end at the end record');

  const entries: ZipReadEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    check(archive.readUInt32LE(offset) === 0x02014b50, `central header ${i} has the wrong signature`);
    const flags = archive.readUInt16LE(offset + 8);
    const method = archive.readUInt16LE(offset + 10);
    const crc = archive.readUInt32LE(offset + 16);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const size = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const external = archive.readUInt32LE(offset + 38);
    const localOffset = archive.readUInt32LE(offset + 42);
    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');

    check(archive.readUInt32LE(localOffset) === 0x04034b50, `${name}: local header has the wrong signature`);
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    check(archive.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString('utf8') === name, `${name}: local and central names differ`);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = archive.subarray(dataStart, dataStart + compressedSize);
    check(method === 0 || method === 8, `${name}: unknown compression method ${method}`);
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    if (flags & 0x0008) {
      // The data descriptor after the data must repeat what the central directory says.
      const descriptor = dataStart + compressedSize;
      check(archive.readUInt32LE(descriptor) === 0x08074b50, `${name}: data descriptor missing`);
      check(archive.readUInt32LE(descriptor + 4) === crc, `${name}: descriptor checksum differs`);
      check(archive.readUInt32LE(descriptor + 8) === compressedSize, `${name}: descriptor compressed size differs`);
      check(archive.readUInt32LE(descriptor + 12) === size, `${name}: descriptor size differs`);
    }
    check(data.length === size, `${name}: size differs from its data`);
    check(crc32(data) >>> 0 === crc, `${name}: checksum differs from its data`);
    entries.push({ name, directory: name.endsWith('/'), method, flags, crc, compressedSize, size, mode: (external >>> 16) & 0o7777, data });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  check(offset === end, 'the central directory has stray bytes');
  return entries;
}
