import { inflateRawSync } from 'node:zlib';

/**
 * Just enough of a ZIP reader to check what an archive download contains:
 * it walks the central directory and inflates each entry. Stored and deflated
 * entries only; no encryption, no ZIP64 — a test archive needs neither.
 */
export interface ZipEntry {
  readonly name: string;
  readonly isDirectory: boolean;
  readonly data: Buffer;
}

export function readZip(archive: Buffer): ZipEntry[] {
  // The end-of-central-directory record is at the very end, after an optional comment.
  let end = -1;
  for (let at = archive.length - 22; at >= 0 && at >= archive.length - 22 - 0xffff; at -= 1) {
    if (archive.readUInt32LE(at) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new Error('Not a ZIP archive: no end-of-central-directory record.');
  const count = archive.readUInt16LE(end + 10);
  let at = archive.readUInt32LE(end + 16);
  const entries: ZipEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    if (archive.readUInt32LE(at) !== 0x02014b50) throw new Error('Broken ZIP central directory.');
    const method = archive.readUInt16LE(at + 10);
    const compressedSize = archive.readUInt32LE(at + 20);
    const nameLength = archive.readUInt16LE(at + 28);
    const extraLength = archive.readUInt16LE(at + 30);
    const commentLength = archive.readUInt16LE(at + 32);
    const localOffset = archive.readUInt32LE(at + 42);
    const name = archive.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    // The local header repeats the name and has its own extra field.
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = archive.subarray(start, start + compressedSize);
    const data = method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw) : null;
    if (data === null)
      throw new Error(
        `ZIP entry ${name} uses compression method ${method}, which this reader does not know.`,
      );
    entries.push({ name, isDirectory: name.endsWith('/'), data });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
