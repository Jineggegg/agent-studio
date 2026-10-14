import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * A stand-in for the GitHub command-line tool (`gh`), for the black-box tests.
 *
 * It answers the two things the Studio asks of `gh` in these tests — who is
 * signed in (`gh auth status --json hosts`) and one read (`gh api … graphql`
 * for the account's repositories) — from canned data, and records every
 * invocation so a test can prove that something was NOT asked. It never
 * contacts anything.
 *
 * The directory it lives in is handed to the harness to put first on the
 * server's PATH; the test changes `mode` to play "signed out", "signed in" or
 * "the tool fails and prints something secret".
 */
export type GhMode = 'signed-in' | 'signed-out' | 'broken';

export interface GhStandIn {
  /** Put this directory first on the server's PATH. */
  readonly dir: string;
  setMode(mode: GhMode, options?: { scopes?: string }): void;
  /** Every invocation so far: the arguments and what was sent on standard input. */
  calls(): Array<{ args: string[]; stdin: string }>;
  remove(): Promise<void>;
}

/** A token-shaped string and a credential-file location the "broken" mode prints, so tests can check neither is passed on. */
export const GH_LEAK = {
  token: 'ghp_0123456789abcdefghijABCDEFGHIJ456789',
  path: '/home/someone/.config/gh/hosts.yml',
};

const SCRIPT = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(path.join(__dirname, 'state.json'), 'utf8'));
const wantsInput = args.includes('--input');
let stdin = '';
function finish() {
  fs.appendFileSync(path.join(__dirname, 'calls.jsonl'), JSON.stringify({ args, stdin }) + '\\n');
  const out = (text) => process.stdout.write(text);
  const http = (status, reason, body) => out('HTTP/2.0 ' + status + ' ' + reason + '\\r\\nContent-Type: application/json; charset=utf-8\\r\\nX-Oauth-Scopes: ' + state.scopes + '\\r\\n\\r\\n' + JSON.stringify(body));
  if (args[0] === '--version') { out('gh version 2.99.0 (stand-in)\\n'); return; }
  if (state.mode === 'broken') {
    process.stderr.write('failed to read configuration: token ${GH_LEAK.token} in ${GH_LEAK.path} was rejected\\n');
    process.exitCode = 1;
    return;
  }
  if (args[0] === 'auth' && args[1] === 'status') {
    if (state.mode === 'signed-out') {
      process.stderr.write('You are not logged into any GitHub hosts. To log in, run: gh auth login\\n');
      process.exitCode = 1;
      return;
    }
    out(JSON.stringify({ hosts: { 'github.com': [{ state: 'success', active: true, host: 'github.com', login: 'octo-standin', tokenSource: 'keyring', scopes: state.scopes, gitProtocol: 'https' }] } }));
    return;
  }
  if (args[0] === 'api') {
    if (state.mode === 'signed-out') {
      process.stderr.write('To get started with GitHub CLI, please run:  gh auth login\\n');
      process.exitCode = 4;
      return;
    }
    const endpoint = args[args.length - 1];
    if (endpoint === 'graphql') {
      let request = {};
      try { request = JSON.parse(stdin); } catch {}
      const query = String(request.query || '');
      if (/viewer/.test(query) && /repositories/.test(query) && !/mutation/.test(query)) {
        http(200, 'OK', { data: { viewer: { repositories: { totalCount: 2, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
          { name: 'studio-notes', owner: { login: 'octo-standin' }, description: 'Notes', isPrivate: true, isFork: false, isArchived: false, defaultBranchRef: { name: 'main' }, pushedAt: '2026-05-02T10:00:00Z', url: 'https://github.com/octo-standin/studio-notes', primaryLanguage: { name: 'TypeScript' }, pullRequests: { totalCount: 1 }, issues: { totalCount: 0 } },
          { name: 'old-thing', owner: { login: 'octo-standin' }, description: null, isPrivate: false, isFork: false, isArchived: true, defaultBranchRef: { name: 'master' }, pushedAt: '2024-01-01T00:00:00Z', url: 'https://github.com/octo-standin/old-thing', primaryLanguage: null, pullRequests: { totalCount: 0 }, issues: { totalCount: 3 } },
        ] } } } });
        return;
      }
      http(200, 'OK', { data: null, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a node (stand-in has no such data).' }] });
      return;
    }
    http(404, 'Not Found', { message: 'Not Found (stand-in)' });
    process.exitCode = 1;
    return;
  }
  process.stderr.write('unknown command for the gh stand-in: ' + args.join(' ') + '\\n');
  process.exitCode = 1;
}
if (wantsInput) {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => (stdin += chunk));
  process.stdin.on('end', finish);
} else {
  finish();
}
`;

export async function createGhStandIn(): Promise<GhStandIn> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-studio-acceptance-gh-'));
  await writeFile(path.join(dir, 'gh'), SCRIPT);
  await chmod(path.join(dir, 'gh'), 0o755);
  const setMode = (mode: GhMode, options: { scopes?: string } = {}) =>
    writeFileSync(
      path.join(dir, 'state.json'),
      JSON.stringify({ mode, scopes: options.scopes ?? 'gist, read:org, repo, workflow' }),
    );
  setMode('signed-out');
  return {
    dir,
    setMode,
    calls() {
      const file = path.join(dir, 'calls.jsonl');
      if (!existsSync(file)) return [];
      return readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as { args: string[]; stdin: string });
    },
    remove: () => rm(dir, { recursive: true, force: true }),
  };
}

/**
 * A PATH for the server that holds nothing but the system's own folders (and
 * `extra` first), so that no real `gh` — or real agent CLI — installed for
 * the person running the tests can be found. Returns null when a system
 * folder itself has the tool, in which case the test must skip.
 */
export function pathWithout(tool: string, ...extra: string[]): string | null {
  const system = ['/usr/bin', '/bin'];
  if (system.some((folder) => existsSync(path.join(folder, tool)))) return null;
  return [...extra, ...system].join(path.delimiter);
}
