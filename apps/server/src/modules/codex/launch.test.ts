import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProcessSupervisor, Sandbox } from '../../kernel/process.js';
import { AgentRunError } from '../agents/adapter.js';
import { ProcessEnded, ProtocolError, RequestTimeout, RpcError } from './client.js';
import { isThreadNotFound, readErrorInfo, runFailure, stderrSummary, tidy, turnFailure } from './errors.js';
import { CodexLauncher, appServerArguments, hiddenCredentialPaths, isModelCredentialVariable, savedRuleFiles } from './launch.js';
import { accountLabel, modelOption } from './status.js';
import { configOverride, tomlArray, tomlInlineTable, tomlString } from './toml.js';

describe('TOML values for -c overrides', () => {
  it('writes every string as a basic string with what is awkward escaped', () => {
    expect(tomlString('plain')).toBe('"plain"');
    expect(tomlString('')).toBe('""');
    expect(tomlString('say "hi"')).toBe('"say \\"hi\\""');
    expect(tomlString('C:\\dir\\')).toBe('"C:\\\\dir\\\\"');
    expect(tomlString("it's = ] [ # , { }")).toBe('"it\'s = ] [ # , { }"');
    expect(tomlString('a\tb\nc\u0000d\u007f')).toBe('"a\\u0009b\\u000ac\\u0000d\\u007f"');
    expect(tomlString('文件 ✓ 🎉')).toBe('"文件 ✓ 🎉"');
    expect(tomlString('lone \ud800 surrogate')).toBe('"lone \\ufffd surrogate"');
    expect(tomlArray(['a b', 'c"d'])).toBe('["a b", "c\\"d"]');
    expect(tomlArray([])).toBe('[]');
    expect(tomlInlineTable([['/a path/with.dots', 'true']])).toBe('{"/a path/with.dots" = true}');
  });

  it('refuses a key the CLI would not read as written', () => {
    expect(configOverride('mcp_servers.studio.command', '"x"')).toEqual(['-c', 'mcp_servers.studio.command="x"']);
    // The CLI does not unquote key segments, so a path or a name with a dot must go into an inline table instead.
    expect(() => configOverride('projects."/a/b".trust_level', '"untrusted"')).toThrow();
    expect(() => configOverride('mcp_servers.my server.enabled', 'false')).toThrow();
    expect(() => configOverride('a=b', '1')).toThrow();
  });
});

describe('the app-server command line', () => {
  const bridge = { command: '/usr/bin/node', args: ['/srv/studio/mcp-bridge.js'], env: { STUDIO_BRIDGE_URL: 'http://127.0.0.1:7420', STUDIO_BRIDGE_TOKEN: 'tok-secret' }, serverName: 'studio', permissionPromptTool: 'permission_prompt' };

  it('sets, for this one process, what keeps the Studio in charge', () => {
    expect(appServerArguments({ bridge, cwd: '/work/app' })).toEqual([
      'app-server',
      '-c', 'features.hooks=false',
      '-c', 'features.apps=false',
      '-c', 'features.plugins=false',
      '-c', 'shell_environment_policy.ignore_default_excludes=false',
      '-c', 'projects={"/work/app" = {"trust_level" = "untrusted"}, "/work" = {"trust_level" = "untrusted"}, "/" = {"trust_level" = "untrusted"}}',
      '-c', 'mcp_servers.studio.command="/usr/bin/node"',
      '-c', 'mcp_servers.studio.args=["/srv/studio/mcp-bridge.js"]',
      '-c', 'mcp_servers.studio.env_vars=["STUDIO_BRIDGE_URL", "STUDIO_BRIDGE_TOKEN"]',
      '-c', 'mcp_servers.studio.default_tools_approval_mode="approve"',
      '-c', 'mcp_servers.studio.disabled_tools=["permission_prompt"]',
    ]);
  });

  it('never puts a value of the bridge environment on the command line', () => {
    const args = appServerArguments({ bridge, cwd: '/work/app', disableMcpServers: ['other'] }).join('\n');
    expect(args).not.toContain('tok-secret');
    expect(args).not.toContain('7420');
  });

  it("switches the user's MCP servers off before it adds the bridge, because a later table would replace the earlier keys", () => {
    const args = appServerArguments({ bridge, cwd: null, disableMcpServers: ['evil', 'odd "name"', 'studio'] });
    const table = args.indexOf('mcp_servers={"evil" = {"enabled" = false}, "odd \\"name\\"" = {"enabled" = false}}');
    expect(table).toBeGreaterThan(0);
    expect(table).toBeLessThan(args.indexOf('mcp_servers.studio.command="/usr/bin/node"'));
    // No project, no trust table.
    expect(args.some((argument) => argument.startsWith('projects='))).toBe(false);
  });

  it('needs no bridge to ask about the account, and refuses a bridge name that is not a plain key', () => {
    expect(appServerArguments({ bridge: null, cwd: null })).toEqual(['app-server', '-c', 'features.hooks=false', '-c', 'features.apps=false', '-c', 'features.plugins=false', '-c', 'shell_environment_policy.ignore_default_excludes=false']);
    expect(() => appServerArguments({ bridge: { ...bridge, serverName: 'stu.dio' }, cwd: null })).toThrow();
  });
});

describe('the environment and the Codex home', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'agent-studio-codex-launch-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('knows which variables would sign Codex in with a key, or point it elsewhere', () => {
    for (const name of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'AZURE_OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'openai_api_key']) expect(isModelCredentialVariable(name)).toBe(true);
    for (const name of ['PATH', 'HOME', 'CODEX_HOME', 'CODEX_SQLITE_HOME', 'CODEX_CA_CERTIFICATE', 'HTTPS_PROXY', 'STUDIO_BRIDGE_TOKEN']) expect(isModelCredentialVariable(name)).toBe(false);
  });

  it('drops such variables even when the owner lets them through to other children, and takes what the caller adds', () => {
    const saved = { ...process.env };
    process.env.OPENAI_API_KEY = 'sk-from-the-server-environment';
    process.env.CODEX_HOME = '/srv/codex-home';
    process.env.MY_TOOL_SETTING = 'kept';
    try {
      const launcher = new CodexLauncher({ processes: new ProcessSupervisor(['OPENAI_API_KEY', 'CODEX_HOME', 'MY_TOOL_SETTING']), sandbox: Sandbox.none('test'), allowWithoutSandbox: true });
      const env = launcher.environment({ STUDIO_BRIDGE_TOKEN: 't' });
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env).toMatchObject({ CODEX_HOME: '/srv/codex-home', MY_TOOL_SETTING: 'kept', STUDIO_BRIDGE_TOKEN: 't', NO_COLOR: '1' });
      expect(launcher.codexHome).toBe('/srv/codex-home');
      expect(() => launcher.environment({ AGENT_STUDIO_MASTER_KEY: 'x' })).toThrow();
    } finally {
      for (const name of ['OPENAI_API_KEY', 'CODEX_HOME', 'MY_TOOL_SETTING']) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
    }
    expect(CodexLauncher.codexHome({ HOME: '/home/someone' })).toBe('/home/someone/.codex');
    expect(CodexLauncher.codexHome({ HOME: '/home/someone', CODEX_HOME: '  ' })).toBe('/home/someone/.codex');
  });

  it('without a sandbox runs codex as it is, and says the isolation is only pinned', () => {
    const launcher = new CodexLauncher({ processes: new ProcessSupervisor(), sandbox: Sandbox.none('test'), allowWithoutSandbox: true });
    expect(launcher.isolation).toBe('pinned');
    expect(launcher.command(['--version'])).toMatchObject({ file: 'codex', args: ['--version'], isolation: 'pinned' });
  });

  it('may not run without a sandbox unless the operator said so, and says what to do about it', () => {
    const refused = new CodexLauncher({ processes: new ProcessSupervisor(), sandbox: Sandbox.none('Turned off by configuration.'), allowWithoutSandbox: false });
    expect(refused.unavailable).toBe(
      "Codex is switched off here because the Studio's sandbox is not available (Turned off by configuration). Codex runs read-only commands without asking, and without the sandbox those could read the Studio's own data and every credential of the account it runs as. Install bubblewrap and leave AGENT_STUDIO_SANDBOX on auto; or, accepting that risk, set AGENT_STUDIO_CODEX_WITHOUT_SANDBOX=on. Then restart the Studio.",
    );
    const allowed = new CodexLauncher({ processes: new ProcessSupervisor(), sandbox: Sandbox.none('Turned off by configuration.'), allowWithoutSandbox: true });
    expect(allowed.unavailable).toBeNull();
  });

  it("hides the account's Codex settings and instructions always, and its credentials unless they are allowed", () => {
    const env = { HOME: '/home/someone' };
    const personal = ['config.toml', 'hooks.json', 'rules', 'AGENTS.md', 'AGENTS.override.md'].map((name) => `/home/someone/.codex/${name}`);
    const withCredentials = CodexLauncher.hidden(env, true);
    expect(withCredentials).toEqual(personal);

    const without = CodexLauncher.hidden(env, false);
    expect(without.slice(0, personal.length)).toEqual(personal);
    expect(without).toEqual(expect.arrayContaining(['/home/someone/.ssh', '/home/someone/.gnupg', '/home/someone/.aws', '/home/someone/.config/gh', '/home/someone/.netrc', '/home/someone/.git-credentials', '/home/someone/.claude', '/home/someone/.claude.json']));
    // Never its own home: the sign-in is in there.
    expect(without).not.toContain('/home/someone/.codex');
    expect(without.some((entry) => entry.startsWith('/home/someone/.codex/') && !personal.includes(entry))).toBe(false);
  });

  it('leaves out of the credential list only what would take its own home away', () => {
    // A Codex home somewhere else: the default one is somebody's sign-in like any other.
    expect(hiddenCredentialPaths('/home/someone', '/srv/codex-home')).toContain('/home/someone/.codex');
    expect(CodexLauncher.hidden({ HOME: '/home/someone', CODEX_HOME: '/srv/codex-home' }, false)).toEqual(expect.arrayContaining(['/srv/codex-home/config.toml', '/srv/codex-home/AGENTS.md', '/home/someone/.codex', '/home/someone/.ssh']));
    // A Codex home inside a credential folder: that folder stays, the others go.
    const nested = hiddenCredentialPaths('/home/someone', '/home/someone/.config/gh/codex');
    expect(nested).not.toContain('/home/someone/.config/gh');
    expect(nested).toContain('/home/someone/.ssh');
  });

  it('finds the rule files that hold rules, and only those', async () => {
    const home = path.join(dir, 'home');
    expect(savedRuleFiles(home)).toEqual([]);
    await mkdir(path.join(home, 'rules'), { recursive: true });
    await writeFile(path.join(home, 'rules', 'default.rules'), '# only a comment\n\n   \n');
    await writeFile(path.join(home, 'rules', 'notes.txt'), 'prefix_rule(pattern=["rm"], decision="allow")\n');
    expect(savedRuleFiles(home)).toEqual([]);
    await writeFile(path.join(home, 'rules', 'mine.rules'), '# mine\nprefix_rule(pattern=["git", "push"], decision="allow")\n');
    expect(savedRuleFiles(home)).toEqual([path.join(home, 'rules', 'mine.rules')]);
  });
});

describe('failures in words', () => {
  const turn = (message: string, codexErrorInfo: unknown = 'other', additionalDetails: string | null = null) => turnFailure({ message, codexErrorInfo, additionalDetails }, { model: 'gpt-x' });

  it('recognises what the CLI reports (shapes captured from codex-cli 0.160.0)', () => {
    expect(turn('unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses, cf-ray: abc, request id: req_1', { httpConnectionFailed: { httpStatusCode: 401 } }).code).toBe('not_signed_in');
    expect(turn("You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro) or try again at Oct 14th, 2026 6:46 PM.", 'usageLimitExceeded')).toMatchObject({ code: 'usage_limit', message: expect.stringContaining('try again at Oct 14th') });
    expect(turn('{"error":{"message":"The model `nope` does not exist or you do not have access to it.","type":"invalid_request_error","param":"model","code":"model_not_found"}}')).toMatchObject({ code: 'model_unavailable', message: expect.stringContaining('"gpt-x"') });
    expect(turn('stream disconnected before completion: Transport error: network error: error decoding response body').code).toBe('connection_lost');
    expect(turn('Reconnecting... 5/5', { responseStreamDisconnected: { httpStatusCode: null } }).code).toBe('connection_lost');
    expect(turn('too many requests', { responseTooManyFailedAttempts: { httpStatusCode: 429 } }).code).toBe('rate_limited');
    expect(turn('whatever', 'contextWindowExceeded').code).toBe('context_too_long');
    expect(turn('upstream said no', { httpConnectionFailed: { httpStatusCode: 503 } }).code).toBe('service_unavailable');
    expect(turn('the linker exploded')).toMatchObject({ code: 'agent_error', message: 'Codex stopped with an error: the linker exploded' });
  });

  it('never shows a raw upstream body, and copes with a failure that says nothing', () => {
    expect(turn('{"error":{"message":"internal detail","secret":"x"}}').message).toBe('Codex stopped with an error it did not explain.');
    expect(turnFailure(null, { model: null })).toMatchObject({ code: 'agent_error' });
    expect(turnFailure({ message: 'model_not_found', codexErrorInfo: null }, { model: null }).message).toContain('the chosen model');
    expect(readErrorInfo({ responseStreamDisconnected: { httpStatusCode: 401 } })).toEqual({ kind: 'responseStreamDisconnected', httpStatus: 401 });
    expect(readErrorInfo('usageLimitExceeded')).toEqual({ kind: 'usageLimitExceeded', httpStatus: null });
    expect(readErrorInfo(undefined)).toEqual({ kind: null, httpStatus: null });
  });

  it('explains a process that could not start, died, went quiet or talked nonsense', () => {
    const context = { stderr: '', during: 'in the middle of the turn' };
    expect(runFailure(new ProcessEnded(null, null, 'ENOENT'), context)).toMatchObject({ code: 'not_installed' });
    expect(runFailure(new ProcessEnded(null, null, 'EACCES'), context)).toMatchObject({ code: 'agent_error', message: 'Codex could not be started (EACCES).' });
    expect(runFailure(new ProcessEnded(2, null), { ...context, stderr: 'WARNING: proceeding, even though we could not create PATH aliases: x\n\u001b[31mERROR\u001b[0m boom token=abcdef123456\n' })).toMatchObject({
      code: 'agent_error',
      message: 'Codex exited with code 2 in the middle of the turn. Its last words: ERROR boom token=[redacted]',
    });
    expect(runFailure(new ProcessEnded(null, 'SIGKILL'), context).message).toBe('Codex was stopped by SIGKILL in the middle of the turn.');
    expect(runFailure(new ProcessEnded(1, null), { ...context, stderr: 'Error: Not logged in\n' }).code).toBe('not_signed_in');
    expect(runFailure(new ProtocolError('x'), context).code).toBe('protocol_error');
    expect(runFailure(new RequestTimeout('turn/start'), context)).toMatchObject({ code: 'agent_timeout', message: 'Codex did not answer in time in the middle of the turn.' });
    expect(runFailure(new RpcError('turn/start', -32600, 'something specific'), context).message).toBe('Codex refused a request in the middle of the turn: something specific');
    const own = new AgentRunError('x', 'y');
    expect(runFailure(own, context)).toBe(own);
    // A bug is not dressed up as a message for the user.
    expect(() => runFailure(new TypeError('oops'), context)).toThrow(TypeError);
  });

  it('knows a conversation Codex no longer has (both answers of codex-cli 0.160.0)', () => {
    expect(isThreadNotFound(new RpcError('thread/resume', -32600, 'no rollout found for thread id 01a13000-0000-7000-8000-000000000000'))).toBe(true);
    expect(isThreadNotFound(new RpcError('thread/resume', -32600, 'invalid session id: invalid character: expected an optional prefix of `urn:uuid:` followed by [0-9a-fA-F-], found `n` at 1'))).toBe(true);
    expect(isThreadNotFound(new RpcError('thread/resume', -32600, 'failed to load configuration'))).toBe(false);
    expect(isThreadNotFound(new Error('no rollout found'))).toBe(false);
  });

  it('tidies text from the CLI: no colours, no credentials, bounded', () => {
    const tidied = tidy('\u001b[2m2026-10-13T21:55:48Z\u001b[0m \u001b[31mERROR\u001b[0m  failed:\n  Authorization: Bearer abcdefghijklmnop');
    expect(tidied).toMatch(/^2026-10-13T21:55:48Z ERROR failed: Authorization: .*\[redacted\]$/);
    expect(tidied).not.toContain('abcdefghijklmnop');
    expect(tidy('x'.repeat(500), 20)).toHaveLength(20);
    expect(stderrSummary('one\n\ntwo\nthree\nfour\nfive\n')).toBe('two three four five');
    expect(stderrSummary('WARNING: proceeding, even though we could not create PATH aliases: whatever\n')).toBe('');
  });
});

describe('what the CLI says about the account and its models', () => {
  it('labels the account without revealing more than the CLI does', () => {
    expect(accountLabel({ account: { type: 'chatgpt', email: 'me@example.test', planType: 'plus' } })).toBe('me@example.test');
    expect(accountLabel({ account: { type: 'chatgpt', email: null } })).toBe('ChatGPT account');
    expect(accountLabel({ account: { type: 'apiKey' } })).toBe('API key');
    expect(accountLabel({ account: null })).toBeNull();
  });

  it('offers a model as the CLI describes it', () => {
    expect(modelOption({ id: 'x', model: 'gpt-x', displayName: 'GPT-X', description: 'Fast.', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }], defaultReasoningEffort: 'low' })).toEqual({
      id: 'gpt-x',
      label: 'GPT-X',
      description: 'Fast.',
      recommended: true,
      efforts: ['low', 'high'],
      defaultEffort: 'low',
    });
    expect(modelOption({ id: 'y', model: 'gpt-y', defaultReasoningEffort: 'medium' })).toEqual({ id: 'gpt-y', label: 'gpt-y' });
  });
});
