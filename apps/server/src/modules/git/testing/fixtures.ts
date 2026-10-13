import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProcessSupervisor, type RunResult } from '../../../kernel/process.js';

/**
 * Test support for everything that runs `git`, `ssh` or `gh`.
 *
 * A sandbox gives the test process a throw-away HOME (so the machine's own git
 * configuration, SSH keys and GitHub login are out of reach) and a directory
 * that comes first on PATH, where a test can drop stand-ins for `ssh` and
 * `gh`. The server under test builds its child environments from the test
 * process's HOME and PATH, so it sees exactly the same world.
 *
 * Fixture commands go through the kernel's own process runner, like
 * everything else in the server: no shell, no inherited secrets.
 */
export interface GitSandbox {
  readonly dir: string;
  readonly home: string;
  /** First on PATH. */
  readonly bin: string;
  /** Runs git and returns its standard output; throws when it fails. */
  git(cwd: string, ...args: string[]): Promise<string>;
  /** Runs git and returns whatever happened. */
  tryGit(cwd: string, ...args: string[]): Promise<RunResult>;
  /** Creates a repository with one commit on `main`. */
  repo(dir: string, files?: Record<string, string>): Promise<string>;
  /** Creates a bare repository to act as a remote. */
  bare(name: string): Promise<string>;
  /** Writes files (creating folders) relative to `dir`. */
  write(dir: string, files: Record<string, string | Buffer>): Promise<void>;
  /** Puts an executable called `name` first on PATH. */
  fake(name: string, script: string): Promise<string>;
  /** A stand-in `ssh` that runs the remote command locally. Its behaviour can be switched with {@link sshMode}. */
  fakeSsh(): Promise<void>;
  sshMode(mode: 'ok' | 'hang' | 'deny' | 'refuse'): Promise<void>;
  /** The argument lists the stand-in `ssh` was called with. */
  sshCalls(): Promise<string[]>;
  /**
   * Replaces the answers of the stand-in `gh`. Each call is answered by the
   * first rule all of whose `args` occur in its arguments and all of whose
   * `stdin` strings occur in what it was sent; a call no rule matches fails.
   */
  ghRules(rules: readonly GhRule[]): Promise<void>;
  /** Every call the stand-in `gh` received so far. */
  ghCalls(): Promise<GhCall[]>;
  /** Forgets the recorded calls. */
  ghForget(): Promise<void>;
  restore(): Promise<void>;
}

export interface GhRule {
  readonly args?: readonly string[];
  readonly stdin?: readonly string[];
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number;
  readonly sleepMs?: number;
}

export interface GhCall {
  readonly args: string[];
  readonly stdin: string;
}

/**
 * Stand-in for the GitHub command-line tool. It never talks to anyone: it
 * records how it was called and prints whatever the test told it to. Every
 * sandbox has one first on PATH, so that no test can reach the real GitHub.
 */
const FAKE_GH = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
let stdin = '';
try { stdin = fs.readFileSync(0, 'utf8'); } catch { /* nothing was sent */ }
fs.appendFileSync(path.join(__dirname, 'gh-calls.jsonl'), JSON.stringify({ args, stdin }) + '\\n');
let rules = [];
try { rules = JSON.parse(fs.readFileSync(path.join(__dirname, 'gh-rules.json'), 'utf8')); } catch { /* no rules yet */ }
const joined = args.join(' ');
const rule = rules.find((r) => (r.args || []).every((a) => joined.includes(a)) && (r.stdin || []).every((s) => stdin.includes(s)));
if (!rule) {
  process.stderr.write('fake gh: no rule for: ' + joined + '\\n');
  process.exit(97);
}
if (rule.sleepMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, rule.sleepMs);
if (rule.stdout) process.stdout.write(rule.stdout);
if (rule.stderr) process.stderr.write(rule.stderr);
process.exitCode = rule.code || 0;
`;

const GIT_CONFIG = `[user]
	name = Fixture Author
	email = fixture@example.test
[init]
	defaultBranch = main
[commit]
	gpgsign = false
[core]
	autocrlf = false
`;

const FAKE_SSH = `#!/bin/sh
# Stand-in for ssh in tests: ignores the host, runs the requested command on this machine.
here=$(dirname "$0")
printf '%s\\n' "$*" >> "$here/ssh-calls.log"
mode=$(cat "$here/ssh-mode" 2>/dev/null || echo ok)
case "$mode" in
  hang) exec sleep 120 ;;
  deny) echo "git@example.test: Permission denied (publickey)." >&2; exit 255 ;;
  refuse) echo "ssh: connect to host example.test port 22: Connection refused" >&2; exit 255 ;;
esac
while [ $# -gt 1 ]; do shift; done
exec sh -c "$1"
`;

export async function createGitSandbox(): Promise<GitSandbox> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-studio-git-'));
  const home = path.join(dir, 'home');
  const bin = path.join(dir, 'bin');
  await mkdir(home, { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(home, '.gitconfig'), GIT_CONFIG);

  const saved = { HOME: process.env.HOME, PATH: process.env.PATH, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = path.join(home, '.config');
  process.env.PATH = `${bin}${path.delimiter}${saved.PATH ?? ''}`;

  const processes = new ProcessSupervisor();
  const tryGit = (cwd: string, ...args: string[]) =>
    processes.run('git', args, {
      cwd,
      timeoutMs: 30_000,
      env: processes.env({ GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1' }),
      maxOutputBytes: 16 * 1024 * 1024,
    });
  const git = async (cwd: string, ...args: string[]) => {
    const result = await tryGit(cwd, ...args);
    if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}:\n${result.stderr}${result.stdout}`);
    return result.stdout;
  };
  const write = async (target: string, files: Record<string, string | Buffer>) => {
    for (const [name, content] of Object.entries(files)) {
      const file = path.join(target, name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
    }
  };

  const fake = async (name: string, script: string) => {
    const file = path.join(bin, name);
    await writeFile(file, script);
    await chmod(file, 0o755);
    return file;
  };

  await fake('gh', FAKE_GH);

  return {
    dir,
    home,
    bin,
    git,
    tryGit,
    write,
    fake,
    async ghRules(rules) {
      await writeFile(path.join(bin, 'gh-rules.json'), JSON.stringify(rules));
    },
    async ghCalls() {
      const log = await readFile(path.join(bin, 'gh-calls.jsonl'), 'utf8').catch(() => '');
      return log
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as GhCall);
    },
    async ghForget() {
      await rm(path.join(bin, 'gh-calls.jsonl'), { force: true });
    },
    async repo(target, files = { 'README.md': '# fixture\n' }) {
      await mkdir(target, { recursive: true });
      await git(target, 'init', '--quiet');
      await write(target, files);
      await git(target, 'add', '--all');
      await git(target, 'commit', '--quiet', '-m', 'first commit');
      return target;
    },
    async bare(name) {
      const target = path.join(dir, name);
      await mkdir(target, { recursive: true });
      await git(target, 'init', '--quiet', '--bare');
      return target;
    },
    async fakeSsh() {
      await fake('ssh', FAKE_SSH);
      await writeFile(path.join(bin, 'ssh-mode'), 'ok');
    },
    async sshMode(mode) {
      await writeFile(path.join(bin, 'ssh-mode'), mode);
    },
    async sshCalls() {
      const log = await readFile(path.join(bin, 'ssh-calls.log'), 'utf8').catch(() => '');
      return log.split('\n').filter((line) => line.length > 0);
    },
    async restore() {
      await processes.shutdown(500);
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(dir, { recursive: true, force: true });
    },
  };
}
