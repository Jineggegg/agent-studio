import { describe, expect, it } from 'vitest';
import { admitFiles, fingerprintFile, formatBytes, isRasterImage } from './attachments';

const MB = 1024 * 1024;
const file = (name: string, size: number, fingerprint = name) => ({ name, size, fingerprint });

describe('what may be attached', () => {
  it('keeps at most ten files and says which were left out', () => {
    const offered = Array.from({ length: 12 }, (_, index) => file(`f${index}.txt`, 100));
    const result = admitFiles([], offered);
    expect(result.accepted.map((entry) => entry.name)).toEqual(offered.slice(0, 10).map((entry) => entry.name));
    expect(result.rejected).toEqual([
      { name: 'f10.txt', reason: 'too-many' },
      { name: 'f11.txt', reason: 'too-many' },
    ]);
  });

  it('counts what is already attached against the limit', () => {
    const held = Array.from({ length: 9 }, (_, index) => ({ fingerprint: `held-${index}` }));
    const result = admitFiles(held, [file('a', 1), file('b', 1)]);
    expect(result.accepted.map((entry) => entry.name)).toEqual(['a']);
    expect(result.rejected).toEqual([{ name: 'b', reason: 'too-many' }]);
  });

  it('refuses a file over 10 MB by name and keeps the rest', () => {
    const result = admitFiles([], [file('ok.png', 10 * MB), file('huge.mov', 11 * MB), file('also-ok.txt', 5)]);
    expect(result.accepted.map((entry) => entry.name)).toEqual(['ok.png', 'also-ok.txt']);
    expect(result.rejected).toEqual([{ name: 'huge.mov', reason: 'too-large' }]);
  });

  it('twelve dropped files, one of them 11 MB: the big one is refused and ten of the others go in', () => {
    const offered = [file('big.bin', 11 * MB), ...Array.from({ length: 11 }, (_, index) => file(`f${index}`, 100))];
    const result = admitFiles([], offered);
    expect(result.accepted).toHaveLength(10);
    expect(result.rejected.map((entry) => entry.reason)).toEqual(['too-large', 'too-many']);
  });

  it('refuses an empty file', () => {
    expect(admitFiles([], [file('empty', 0)]).rejected).toEqual([{ name: 'empty', reason: 'empty' }]);
  });

  it('attaches the same picture once, however often the platform delivers it', () => {
    const twice = admitFiles([], [file('image.png', 500, 'same'), file('image (1).png', 500, 'same')]);
    expect(twice.accepted).toHaveLength(1);
    expect(twice.duplicates).toBe(1);
    expect(twice.rejected).toEqual([]);
    // A second paste of the same picture adds nothing; a different one is a second attachment.
    expect(admitFiles([{ fingerprint: 'same' }], [file('again.png', 500, 'same')]).accepted).toEqual([]);
    expect(admitFiles([{ fingerprint: 'same' }], [file('other.png', 500, 'different')]).accepted).toHaveLength(1);
  });

  it('honours other limits when the server has them', () => {
    const result = admitFiles([], [file('a', 50), file('b', 500), file('c', 50)], { maxFiles: 1, maxBytes: 100 });
    expect(result.accepted.map((entry) => entry.name)).toEqual(['a']);
    expect(result.rejected).toEqual([
      { name: 'b', reason: 'too-large' },
      { name: 'c', reason: 'too-many' },
    ]);
  });
});

describe('fingerprints', () => {
  const blob = (text: string, type = 'image/png') => new Blob([text], { type });

  it('are the same for the same content under different names, and differ with the content', async () => {
    const a = await fingerprintFile(Object.assign(blob('screenshot bytes'), { name: 'image.png' }));
    const b = await fingerprintFile(Object.assign(blob('screenshot bytes'), { name: 'image (1).png' }));
    const c = await fingerprintFile(Object.assign(blob('another picture'), { name: 'image.png' }));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('differ when only the end of a large file differs', async () => {
    const body = 'x'.repeat(200_000);
    expect(await fingerprintFile(blob(`${body}A`))).not.toBe(await fingerprintFile(blob(`${body}B`)));
  });
});

describe('presentation', () => {
  it('names sizes the way people do', () => {
    const number = (value: number, options?: Intl.NumberFormatOptions) => new Intl.NumberFormat('en', options).format(value);
    expect(formatBytes(96, number)).toBe('96 B');
    expect(formatBytes(812_400, number)).toBe('812 kB');
    expect(formatBytes(3_420_000, number)).toBe('3.4 MB');
  });

  it('shows only raster images inline', () => {
    expect(isRasterImage('image/png')).toBe(true);
    expect(isRasterImage('IMAGE/JPEG')).toBe(true);
    expect(isRasterImage('image/svg+xml')).toBe(false);
    expect(isRasterImage('application/pdf')).toBe(false);
  });
});
