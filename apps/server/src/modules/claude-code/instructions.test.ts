import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PROJECT_INSTRUCTIONS_BYTES, readProjectInstructions } from './instructions.js';

const root = mkdtempSync(path.join(os.tmpdir(), 'agent-studio-claude-instructions-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let counter = 0;
/** A fresh project folder, with the given files in it. */
function project(files: Record<string, string | Buffer> = {}): string {
  const directory = path.join(root, `project-${(counter += 1)}`);
  mkdirSync(directory, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
    writeFileSync(path.join(directory, name), content);
  }
  return directory;
}

describe("reading a project's CLAUDE.md", () => {
  it('takes the file from the root of the project, as text', async () => {
    expect(await readProjectInstructions(project({ 'CLAUDE.md': '# Rules\n\nAlways run the tests.\n' }))).toEqual({ kind: 'loaded', text: '# Rules\n\nAlways run the tests.', truncated: false });
    // A byte-order mark and Windows line ends are not part of the instructions.
    expect(await readProjectInstructions(project({ 'CLAUDE.md': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('one\r\ntwo\r\n')]) }))).toEqual({ kind: 'loaded', text: 'one\ntwo', truncated: false });
    expect(await readProjectInstructions(project({ 'CLAUDE.md': '规则：先跑测试。' }))).toEqual({ kind: 'loaded', text: '规则：先跑测试。', truncated: false });
  });

  it('is nothing when there is no such file, or an empty one — and no other name or place counts', async () => {
    expect(await readProjectInstructions(project())).toEqual({ kind: 'none' });
    expect(await readProjectInstructions(project({ 'CLAUDE.md': ' \n\n' }))).toEqual({ kind: 'none' });
    expect(await readProjectInstructions(path.join(root, 'no-such-project'))).toEqual({ kind: 'none' });
    const elsewhere = project({ 'docs/CLAUDE.md': 'nested', '.claude/CLAUDE.md': 'configuration folder', 'CLAUDE.local.md': 'local', 'AGENTS.md': 'another tool', '.claude/settings.json': '{"permissions":{"allow":["Bash"]}}' });
    expect(await readProjectInstructions(elsewhere)).toEqual({ kind: 'none' });
  });

  it('uses only the beginning of a file that is too large, cut between characters', async () => {
    const line = 'Keep the public API stable.\n';
    const large = await readProjectInstructions(project({ 'CLAUDE.md': `${line.repeat(3000)}THE END` }));
    expect(large).toMatchObject({ kind: 'loaded', truncated: true });
    const text = (large as { text: string }).text;
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(PROJECT_INSTRUCTIONS_BYTES);
    expect(Buffer.byteLength(text)).toBeGreaterThan(PROJECT_INSTRUCTIONS_BYTES - line.length);
    expect(text).not.toContain('THE END');
    // Exactly at the limit is not too large.
    expect(await readProjectInstructions(project({ 'CLAUDE.md': 'x'.repeat(PROJECT_INSTRUCTIONS_BYTES) }))).toMatchObject({ kind: 'loaded', truncated: false });
    expect(await readProjectInstructions(project({ 'CLAUDE.md': 'x'.repeat(PROJECT_INSTRUCTIONS_BYTES + 1) }))).toMatchObject({ kind: 'loaded', truncated: true });
    // A three-byte character straddling the limit is left out whole rather than cut in half.
    const straddling = await readProjectInstructions(project({ 'CLAUDE.md': `${'a'.repeat(9)}规则` }), 10);
    expect(straddling).toEqual({ kind: 'loaded', text: 'a'.repeat(9), truncated: true });
    expect(await readProjectInstructions(project({ 'CLAUDE.md': `${'a'.repeat(7)}规则` }), 10)).toEqual({ kind: 'loaded', text: `${'a'.repeat(7)}规`, truncated: true });
  });

  it('follows a link that stays inside the project and refuses one that leaves it', async () => {
    const inside = project({ 'docs/instructions.md': 'kept with the docs' });
    symlinkSync('docs/instructions.md', path.join(inside, 'CLAUDE.md'));
    expect(await readProjectInstructions(inside)).toEqual({ kind: 'loaded', text: 'kept with the docs', truncated: false });

    const secret = path.join(root, 'outside-secret.md');
    writeFileSync(secret, 'the private key is …');
    const refused = { kind: 'unreadable', reason: 'it is a link that leads outside the project folder' };
    for (const target of [secret, '../outside-secret.md', '/etc/hostname', path.join(root, 'does-not-exist.md')]) {
      const outside = project();
      symlinkSync(target, path.join(outside, 'CLAUDE.md'));
      expect(await readProjectInstructions(outside), target).toEqual(refused);
    }
    // A link to a link to the outside is no better.
    const chained = project();
    symlinkSync(secret, path.join(chained, 'hop.md'));
    symlinkSync('hop.md', path.join(chained, 'CLAUDE.md'));
    expect(await readProjectInstructions(chained)).toEqual(refused);
  });

  it('refuses what is not a regular text file, without waiting on it', async () => {
    const folder = project({ 'CLAUDE.md/readme.txt': 'a folder by that name' });
    expect(await readProjectInstructions(folder)).toEqual({ kind: 'unreadable', reason: 'it is not a regular file' });
    expect(await readProjectInstructions(project({ 'CLAUDE.md': Buffer.from([0x43, 0xff, 0xfe, 0x41]) }))).toEqual({ kind: 'unreadable', reason: 'it is not UTF-8 text' });
    expect(await readProjectInstructions(project({ 'CLAUDE.md': Buffer.from('text\0with a zero byte') }))).toEqual({ kind: 'unreadable', reason: 'it is not a text file' });

    const piped = project();
    let hasPipe = true;
    try {
      execFileSync('mkfifo', [path.join(piped, 'CLAUDE.md')]);
    } catch {
      hasPipe = false;
    }
    if (hasPipe) {
      // Nobody writes to the pipe: opening it must not hang the turn.
      const startedAt = Date.now();
      expect(await readProjectInstructions(piped)).toEqual({ kind: 'unreadable', reason: 'it is not a regular file' });
      expect(Date.now() - startedAt).toBeLessThan(2000);
    }
  });

  it('says so when the Studio may not read the file', async ({ skip }) => {
    skip(typeof process.getuid === 'function' && process.getuid() === 0, 'the superuser can read everything');
    const locked = project({ 'CLAUDE.md': 'not for the service account' });
    chmodSync(path.join(locked, 'CLAUDE.md'), 0o000);
    expect(await readProjectInstructions(locked)).toEqual({ kind: 'unreadable', reason: 'the Studio is not allowed to read it' });
  });
});
