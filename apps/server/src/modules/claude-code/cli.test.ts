import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { findExecutable, parseAuthStatus, parseHelp, parseVersion } from './cli.js';

/** The relevant part of what `claude --help` printed for version 2.1.283 (the CLI's public help text). */
const HELP = `Usage: claude [options] [command] [prompt]

Claude Code - starts an interactive session by default, use -p/--print for
non-interactive output

Options:
  --add-dir <directories...>            Additional directories to allow tool
                                        access to
  --allowedTools, --allowed-tools <tools...>
      Comma or space-separated list of tool names to allow (e.g. "Bash(git *)
      Edit")
  --append-system-prompt <prompt>       Append a system prompt to the default
                                        system prompt
  --effort <level>                      Effort level for the current session
                                        (low, medium, high, xhigh, max)
  --forward-subagent-text               Forward subagent text and thinking
                                        blocks as assistant/user messages with
                                        parent_tool_use_id set (only works with
                                        --print and --output-format=stream-json)
  --include-partial-messages            Include partial message chunks as they
                                        arrive (only works with --print and
                                        --output-format=stream-json)
  --input-format <format>               Input format (only works with --print):
                                        "text" (default), or "stream-json"
                                        (realtime streaming input) (choices:
                                        "text", "stream-json")
  --mcp-config <configs...>             Load MCP servers from JSON files or
                                        strings (space-separated)
  --model <model>                       Model for the current session. Provide
                                        an alias for the latest model (e.g.
                                        'fable', 'opus', or 'sonnet') or a
                                        model's full name (e.g.
                                        'claude-fable-5').
  --output-format <format>              Output format (only works with --print):
                                        "text" (default), "json" (single
                                        result), or "stream-json" (realtime
                                        streaming) (choices: "text", "json",
                                        "stream-json")
  --permission-mode <mode>              Permission mode to use for the session
                                        (choices: "acceptEdits", "auto",
                                        "bypassPermissions", "manual",
                                        "dontAsk", "plan")
  -p, --print                           Print response and exit (useful for
                                        pipes).
  --replay-user-messages                Re-emit user messages from stdin back on
                                        stdout for acknowledgment (only works
                                        with --input-format=stream-json and
                                        --output-format=stream-json)
  -r, --resume [value]                  Resume a conversation by session ID, or
                                        open interactive picker with optional
                                        search term
  --setting-sources <sources>           Comma-separated list of setting sources
                                        to load (user, project, local).
  --strict-mcp-config                   Only use MCP servers from --mcp-config,
                                        ignoring all other MCP configurations
  --verbose                             Override verbose mode setting from
                                        config
  -v, --version                         Output the version number

Commands:
  auth                                  Manage authentication
`;

describe('reading the CLI\'s own answers', () => {
  it('takes the version out of --version', () => {
    expect(parseVersion('2.1.283 (Claude Code)\n')).toBe('2.1.283');
    expect(parseVersion('2.1.283-standin (Claude Code)')).toBe('2.1.283-standin');
    expect(parseVersion('1.0.0-beta.2+build.5')).toBe('1.0.0-beta.2+build.5');
    expect(parseVersion('command not found')).toBeNull();
    expect(parseVersion('')).toBeNull();
  });

  it('learns from --help which efforts and model aliases exist and what the asking mode is called', () => {
    expect(parseHelp(HELP)).toEqual({
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      // Named in the help first, then the long-standing aliases; a full model id is not an alias.
      modelAliases: ['fable', 'opus', 'sonnet', 'haiku'],
      replayUserMessages: true,
      forwardSubagentText: true,
      askingMode: 'manual',
      missing: [],
    });
  });

  it('copes with an older CLI: no effort option, the mode still called "default", options missing', () => {
    const older = HELP.replace(/ {2}--effort[\s\S]*?(?= {2}--forward)/, '')
      .replace(/ {2}--forward-subagent-text[\s\S]*?(?= {2}--include)/, '')
      .replace(/ {2}--replay-user-messages[\s\S]*?(?= {2}-r, --resume)/, '')
      .replace('"bypassPermissions", "manual",', '"bypassPermissions", "default",')
      .replace(/'fable', 'opus', or 'sonnet'/, "'sonnet' or 'opus'");
    expect(parseHelp(older)).toEqual({ efforts: [], modelAliases: ['sonnet', 'opus', 'haiku'], replayUserMessages: false, forwardSubagentText: false, askingMode: 'default', missing: [] });
    const ancient = parseHelp('Usage: claude [options]\n\nOptions:\n  -p, --print       Print response and exit\n  --model <model>   Model to use\n');
    expect(ancient.missing).toEqual(['--input-format', '--output-format', '--include-partial-messages', '--permission-mode', '--mcp-config', '--strict-mcp-config', '--setting-sources', '--resume', '--append-system-prompt', '--add-dir']);
    // An option is not found inside another option's name or description.
    expect(parseHelp('  --mcp-config-file <f>  see --strict-mcp-config-like things\n').missing).toEqual(expect.arrayContaining(['--mcp-config', '--strict-mcp-config']));
  });

  it('takes only labels from the sign-in status, and nothing when it cannot be read', () => {
    const signedIn = { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'ada@example.test', orgId: 'b7f1', orgName: 'Analytical Engines', subscriptionType: 'max', configDirectory: '/home/ada/.claude' };
    expect(parseAuthStatus(JSON.stringify(signedIn))).toEqual({ signedIn: true, account: 'ada@example.test (max)' });
    expect(parseAuthStatus(JSON.stringify({ ...signedIn, email: undefined }))).toEqual({ signedIn: true, account: 'Analytical Engines (max)' });
    expect(parseAuthStatus(JSON.stringify({ loggedIn: true, authMethod: 'apiKey' }))).toEqual({ signedIn: true, account: null });
    expect(parseAuthStatus(JSON.stringify({ loggedIn: true, subscriptionType: 'pro' }))).toEqual({ signedIn: true, account: 'Claude pro' });
    expect(parseAuthStatus('{\n  "loggedIn": false,\n  "authMethod": "none"\n}\n')).toEqual({ signedIn: false, account: null });
    // Not an answer: unknown, never a guess.
    for (const text of ['', 'Not logged in. Run claude auth login to authenticate.', "error: unknown command 'auth'", '[]', 'null', '{"loggedIn":"yes"}', '{}']) {
      expect(parseAuthStatus(text), text).toEqual({ signedIn: null, account: null });
    }
    // Whatever the CLI prints, a label is one bounded line.
    const odd = parseAuthStatus(JSON.stringify({ loggedIn: true, email: `a\n${'b'.repeat(500)}` }));
    expect(odd.account!.length).toBeLessThanOrEqual(120);
    expect(odd.account).not.toContain('\n');
  });
});

describe('finding the program', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'agent-studio-claude-cli-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const make = (relative: string, mode: number): string => {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '#!/bin/sh\n');
    chmodSync(file, mode);
    return file;
  };

  it('looks along the given search path only, for a file that can be executed', () => {
    const first = make('one/claude', 0o755);
    make('two/claude', 0o755);
    make('plain/claude', 0o644);
    mkdirSync(path.join(root, 'folder/claude'), { recursive: true });
    const search = (...directories: string[]) => directories.map((directory) => path.join(root, directory)).join(path.delimiter);
    expect(findExecutable('claude', search('one', 'two'))).toBe(first);
    expect(findExecutable('claude', search('missing', 'plain', 'folder', 'two'))).toBe(path.join(root, 'two/claude'));
    expect(findExecutable('claude', search('plain', 'folder'))).toBeNull();
    expect(findExecutable('claude', undefined)).toBeNull();
    expect(findExecutable('claude', '')).toBeNull();
    // A relative entry on PATH would mean "wherever the server happens to be": ignored.
    expect(findExecutable('claude', `one${path.delimiter}.`)).toBeNull();
    expect(findExecutable(first, '')).toBe(first);
    expect(findExecutable('one/claude', search('.'))).toBeNull();
    expect(findExecutable('', search('one'))).toBeNull();
    expect(findExecutable('cla\0ude', search('one'))).toBeNull();
  });
});
