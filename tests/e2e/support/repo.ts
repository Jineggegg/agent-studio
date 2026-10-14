import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * A small git repository with one commit, made directly in the server's
 * workspace (the runner and the server share the machine). Git runs with no
 * global or system configuration, so the outcome does not depend on whose
 * machine — or which CI runner — runs the suite.
 */

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
};

export function git(directory: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=Sample Author',
      '-c',
      'user.email=sample@example.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    {
      cwd: directory,
      env: GIT_ENV,
      encoding: 'utf8',
    },
  );
}

export function makeSampleRepository(directory: string): void {
  mkdirSync(path.join(directory, 'src'), { recursive: true });
  writeFileSync(
    path.join(directory, 'README.md'),
    '# Sample project\n\nA small project for the browser tests.\n',
  );
  writeFileSync(
    path.join(directory, 'src/app.ts'),
    'export function greet(name: string): string {\n  return `Hello, ${name}`;\n}\n',
  );
  git(directory, 'init', '--quiet', '--initial-branch=main');
  git(directory, 'add', '--all');
  git(directory, 'commit', '--quiet', '--message', 'Start the sample project');
}
