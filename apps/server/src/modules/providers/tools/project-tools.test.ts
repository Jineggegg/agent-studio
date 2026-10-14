import { execFileSync } from 'node:child_process';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProcessSupervisor, Sandbox } from '../../../kernel/process.js';
import { DEFAULT_LIMITS } from '../limits.js';
import { type ProjectToolsOptions, projectTools } from './project-tools.js';
import { type ModelTool, type PreparedCall, ToolRefusal } from './tool.js';

let base: string;
let root: string;
let dataDir: string;
const processes = new ProcessSupervisor();

const options = (overrides: Partial<ProjectToolsOptions> = {}): ProjectToolsOptions => ({
  root,
  dataDir,
  write: true,
  limits: DEFAULT_LIMITS,
  processes,
  sandbox: Sandbox.none('test'),
  ...overrides,
});
const tool = (name: string, overrides: Partial<ProjectToolsOptions> = {}): ModelTool => projectTools(options(overrides)).find((entry) => entry.declaration.name === name)!;
const io = { signal: new AbortController().signal, output: () => {}, notice: () => {} };

beforeAll(() => {
  base = mkdtempSync(path.join(os.tmpdir(), 'studio-project-tools-'));
  root = path.join(base, 'project');
  dataDir = path.join(base, 'data');
  mkdirSync(path.join(root, 'src', 'deep'), { recursive: true });
  mkdirSync(path.join(root, 'node_modules', 'left-pad'), { recursive: true });
  mkdirSync(path.join(root, '.git'), { recursive: true });
  mkdirSync(dataDir);
  writeFileSync(path.join(root, 'README.md'), '# Demo\n\nneedle in the readme\n');
  writeFileSync(path.join(root, 'src', 'deep', 'module.ts'), 'export const needle = 1;\n');
  writeFileSync(path.join(root, 'node_modules', 'left-pad', 'index.js'), 'module.exports = "needle";\n');
  writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/needle\n');
  writeFileSync(path.join(dataDir, 'master.key'), 'not-for-agents\n');
  symlinkSync(dataDir, path.join(root, 'link-to-data'));
});
afterAll(async () => {
  await processes.shutdown();
  rmSync(base, { recursive: true, force: true });
});

describe('projectTools', () => {
  it('offers only the reading tools to someone who may not change the project', () => {
    expect(projectTools(options()).map((entry) => entry.declaration.name)).toEqual(['read_file', 'list_directory', 'find_files', 'search_text', 'write_file', 'edit_file', 'run_command']);
    expect(projectTools(options({ write: false })).map((entry) => entry.declaration.name)).toEqual(['read_file', 'list_directory', 'find_files', 'search_text']);
  });

  it('declares every tool with a schema a model can be given, and an honest kind', () => {
    const kinds: Record<string, string> = {};
    for (const entry of projectTools(options())) {
      const { name, description, parameters } = entry.declaration;
      expect(name).toMatch(/^[a-z_]{3,40}$/);
      expect(description.length).toBeGreaterThan(40);
      expect(parameters).toMatchObject({ type: 'object', additionalProperties: false });
      kinds[name] = entry.kind;
    }
    expect(kinds).toEqual({ read_file: 'read', list_directory: 'read', find_files: 'search', search_text: 'search', write_file: 'edit', edit_file: 'edit', run_command: 'execute' });
  });

  it('tells the permission engine the real path, the diff and the command', async () => {
    const read = await tool('read_file').prepare({ path: 'src/../README.md' });
    expect(read).toMatchObject({ kind: 'read', title: 'Read README.md', permissions: [{ toolName: 'read_file', kind: 'read', paths: [path.join(root, 'README.md')] }] });
    const write = await tool('write_file').prepare({ path: 'README.md', content: '# Demo\n\nchanged\n' });
    expect(write.permissions).toEqual([
      { toolName: 'write_file', kind: 'edit', title: 'Replace README.md', paths: [path.join(root, 'README.md')], diff: expect.stringContaining('-needle in the readme\n+changed') },
    ]);
    const simple = await tool('run_command').prepare({ command: 'npm test' });
    expect(simple.permissions).toEqual([{ toolName: 'run_command', kind: 'execute', title: 'Run npm test', command: 'npm test' }]);
  });

  it('asks about the network separately, and demands a person for a shell line only where there is no sandbox', async () => {
    const piped = await tool('run_command').prepare({ command: 'cat README.md | wc -l', network: true });
    expect(piped.permissions).toEqual([
      { toolName: 'run_command', kind: 'execute', title: 'Run cat README.md | wc -l', command: 'cat README.md | wc -l', requireHuman: true },
      { toolName: 'run_command_network', kind: 'fetch', title: 'Give network access to: cat README.md | wc -l', command: 'cat README.md | wc -l' },
    ]);
    expect((await tool('run_command').prepare({ command: 'bash build.sh' })).permissions[0]).toMatchObject({ requireHuman: true });
    expect((await tool('run_command').prepare({ command: 'node build.js' })).permissions[0]).not.toHaveProperty('requireHuman');

    // With a sandbox the same line is an ordinary request.
    const sandbox = await Sandbox.detect('auto', [dataDir]);
    if (sandbox.status.mode === 'bwrap') {
      const confined = await tool('run_command', { sandbox }).prepare({ command: 'cat README.md | wc -l' });
      expect(confined.permissions[0]).not.toHaveProperty('requireHuman');
    }
  });

  it('refuses what leaves the project, Git\'s own files and the Studio\'s data, in every tool that takes a path', async () => {
    const hostile = ['../outside', '/etc/passwd', '.git/HEAD', 'src/../.git/HEAD', 'link-to-data/master.key', path.join(dataDir, 'master.key'), 'a\u0000b'];
    const attempts: Array<[string, (target: string) => Record<string, unknown>]> = [
      ['read_file', (target) => ({ path: target })],
      ['list_directory', (target) => ({ path: target })],
      ['find_files', (target) => ({ pattern: '*', path: target })],
      ['search_text', (target) => ({ query: 'x', path: target })],
      ['write_file', (target) => ({ path: target, content: 'x' })],
      ['edit_file', (target) => ({ path: target, old_string: 'a', new_string: 'b' })],
    ];
    for (const [name, args] of attempts) {
      for (const target of hostile) {
        await expect(tool(name).prepare(args(target)), `${name} ${JSON.stringify(target)}`).rejects.toBeInstanceOf(ToolRefusal);
      }
    }
  });

  it('searches without following links, without .git, and without node_modules unless pointed there', async () => {
    const run = async (prepared: PreparedCall): Promise<string> => (await prepared.run(io)).text;
    const everywhere = await run(await tool('search_text').prepare({ query: 'needle' }));
    expect(everywhere).toContain('2 matches in 2 files.');
    expect(everywhere).toContain('README.md:3: needle in the readme');
    expect(everywhere).toContain('src/deep/module.ts:1: export const needle = 1;');
    expect(everywhere).not.toContain('node_modules');
    expect(everywhere).not.toContain('HEAD');
    const dependencies = await run(await tool('search_text').prepare({ query: 'needle', path: 'node_modules' }));
    expect(dependencies).toContain('node_modules/left-pad/index.js:1:');
    const found = await run(await tool('find_files').prepare({ pattern: '**/*.ts' }));
    expect(found).toBe('1 file match "**/*.ts".\nsrc/deep/module.ts');
    expect(await run(await tool('find_files').prepare({ pattern: 'master.key' }))).toBe('No file matches "master.key".');
    expect(await run(await tool('find_files').prepare({ pattern: 'index.js' }))).toBe('No file matches "index.js".');
  });

  it('creates folders on the way, and touches only regular files with one name — never waiting on a pipe', async () => {
    const run = async (prepared: PreparedCall): Promise<string> => (await prepared.run(io)).text;
    expect(await run(await tool('write_file').prepare({ path: 'made/on/the-way.txt', content: 'hello\n' }))).toContain('Created "made/on/the-way.txt"');
    expect(readFileSync(path.join(root, 'made', 'on', 'the-way.txt'), 'utf8')).toBe('hello\n');

    // A file approved for reading that became a named pipe by the time the call runs.
    writeFileSync(path.join(root, 'piped.txt'), 'text\n');
    const reading = await tool('read_file').prepare({ path: 'piped.txt' });
    unlinkSync(path.join(root, 'piped.txt'));
    execFileSync('mkfifo', [path.join(root, 'piped.txt')]);
    await expect(reading.run(io)).rejects.toThrow('not a regular file');
    await expect((await tool('write_file').prepare({ path: 'other.txt', content: 'x' })).run(io)).resolves.toBeTruthy();
    rmSync(path.join(root, 'piped.txt'));

    // A second name outside the project would carry the change out of it.
    writeFileSync(path.join(root, 'linked.txt'), 'original\n');
    linkSync(path.join(root, 'linked.txt'), path.join(base, 'outside-name.txt'));
    const writing = await tool('write_file').prepare({ path: 'linked.txt', content: 'changed\n' });
    await expect(writing.run(io)).rejects.toThrow('more than one name');
    expect(readFileSync(path.join(base, 'outside-name.txt'), 'utf8')).toBe('original\n');
  });

  it('gives up on a tree that is too large instead of walking it for ever', async () => {
    const limits = { ...DEFAULT_LIMITS, maxWalkEntries: 3 };
    const result = await (await tool('find_files', { limits }).prepare({ pattern: '*.nothing' })).run(io);
    expect(result.text).toContain('The search stopped early');
  });
});
