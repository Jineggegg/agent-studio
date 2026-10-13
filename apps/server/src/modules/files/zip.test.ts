import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { ZIP_MAX_ENTRIES, ZipLimitError, zipEntryName, zipStream, type ZipEntry } from './zip.js';
import { readZip } from './testing/zip-reader.js';

async function collect(entries: Iterable<ZipEntry> | AsyncIterable<ZipEntry>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of zipStream(entries)) chunks.push(chunk);
  return Buffer.concat(chunks);
}

const file = (name: string, content: Buffer | string, extra: Partial<ZipEntry> = {}): ZipEntry => ({
  name,
  open: async () => Readable.from([Buffer.isBuffer(content) ? content : Buffer.from(content)]),
  ...extra,
});

const has = (tool: string, args: string[]): boolean => spawnSync(tool, args, { stdio: 'ignore' }).status === 0;

describe('zip writer', () => {
  const big = Buffer.from('all work and no play makes a dull archive\n'.repeat(20_000));
  const noise = randomBytes(70_000);
  const entries = (): ZipEntry[] => [
    { name: 'project', directory: true },
    file('project/readme.md', '# hello\n', { mode: 0o644, modifiedAt: new Date(2024, 4, 17, 13, 45, 30) }),
    { name: 'project/empty-folder/', directory: true },
    file('project/src/big.txt', big),
    file('project/src/noise.bin', noise),
    file('project/empty.txt', ''),
    file('project/文件 名.txt', '内容'),
    file('project/run.sh', '#!/bin/sh\n', { mode: 0o755 }),
  ];

  it('writes an archive whose every entry reads back exactly', async () => {
    const archive = await collect(entries());
    const parsed = readZip(archive);
    expect(parsed.map((entry) => entry.name)).toEqual([
      'project/',
      'project/readme.md',
      'project/empty-folder/',
      'project/src/big.txt',
      'project/src/noise.bin',
      'project/empty.txt',
      'project/文件 名.txt',
      'project/run.sh',
    ]);
    const byName = new Map(parsed.map((entry) => [entry.name, entry]));
    expect(byName.get('project/src/big.txt')!.data.equals(big)).toBe(true);
    expect(byName.get('project/src/noise.bin')!.data.equals(noise)).toBe(true);
    expect(byName.get('project/文件 名.txt')!.data.toString('utf8')).toBe('内容');
    expect(byName.get('project/empty.txt')!.size).toBe(0);
    // Text compresses; the archive is far smaller than its content.
    expect(byName.get('project/src/big.txt')!.compressedSize).toBeLessThan(big.length / 20);
    expect(byName.get('project/run.sh')!.mode).toBe(0o755);
    expect(byName.get('project/')!.method).toBe(0);
    // UTF-8 names are flagged as such; files carry a data descriptor.
    for (const entry of parsed) expect(entry.flags & 0x0800).toBe(0x0800);
    expect(byName.get('project/readme.md')!.flags & 0x0008).toBe(0x0008);
  });

  it('is accepted by the tools people unzip with, when they are installed', async () => {
    const archive = await collect(entries());
    const folder = mkdtempSync(path.join(os.tmpdir(), 'zip-test-'));
    try {
      const zipFile = path.join(folder, 'out.zip');
      writeFileSync(zipFile, archive);
      if (has('unzip', ['-v'])) {
        execFileSync('unzip', ['-t', zipFile], { stdio: 'pipe' });
        execFileSync('unzip', ['-q', zipFile, '-d', path.join(folder, 'unzipped')], { stdio: 'pipe' });
        expect(readFileSync(path.join(folder, 'unzipped/project/src/big.txt')).equals(big)).toBe(true);
        expect(readFileSync(path.join(folder, 'unzipped/project/src/noise.bin')).equals(noise)).toBe(true);
        expect(statSync(path.join(folder, 'unzipped/project/empty-folder')).isDirectory()).toBe(true);
      }
      if (has('python3', ['-c', 'import zipfile'])) {
        const script = [
          'import sys, zipfile, json',
          'z = zipfile.ZipFile(sys.argv[1])',
          'assert z.testzip() is None',
          'print(json.dumps({i.filename: i.file_size for i in z.infolist()}, ensure_ascii=False))',
        ].join('\n');
        const listed = JSON.parse(execFileSync('python3', ['-c', script, zipFile], { encoding: 'utf8' })) as Record<string, number>;
        expect(listed['project/src/big.txt']).toBe(big.length);
        expect(listed['project/文件 名.txt']).toBe(Buffer.byteLength('内容'));
        expect(Object.keys(listed)).toHaveLength(8);
      }
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it('skips an entry whose content cannot be opened, and stays a valid archive', async () => {
    const archive = await collect([file('a.txt', 'a'), { name: 'gone.txt', open: async () => null }, file('b.txt', 'b')]);
    expect(readZip(archive).map((entry) => entry.name)).toEqual(['a.txt', 'b.txt']);
  });

  it('writes a valid empty archive', async () => {
    const archive = await collect([]);
    expect(archive.length).toBe(22);
    expect(readZip(archive)).toEqual([]);
  });

  it('fails rather than emit a broken archive when a file cannot be read to its end', async () => {
    const broken: ZipEntry = {
      name: 'broken.txt',
      open: async () =>
        new Readable({
          read() {
            this.destroy(new Error('disk went away'));
          },
        }),
    };
    await expect(collect([file('ok.txt', 'ok'), broken])).rejects.toThrow('disk went away');
  });

  it('refuses what would need ZIP64 instead of writing something tools misread', async () => {
    function* many(): Generator<ZipEntry> {
      for (let i = 0; i <= ZIP_MAX_ENTRIES; i += 1) yield { name: `d${i}`, directory: true };
    }
    await expect(collect(many())).rejects.toBeInstanceOf(ZipLimitError);
  });

  it.each(['../evil.txt', '/etc/passwd', 'a/../../b', 'a\\b', 'a//b', '', 'a/./b', 'nul\0byte'])('refuses the entry name %j', (name) => {
    expect(() => zipEntryName(name, false)).toThrow();
  });

  it('normalises directory names to end in a slash', () => {
    expect(zipEntryName('a/b', true)).toBe('a/b/');
    expect(zipEntryName('a/b/', true)).toBe('a/b/');
    expect(zipEntryName('a/b', false)).toBe('a/b');
  });
});
