import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Agent, Project, Session } from '@agent-studio/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProcessSupervisor, Sandbox, terminate } from '../../src/kernel/process.js';
import type { BridgeConnection } from '../../src/modules/agents/adapter.js';
import { PERMISSIONS_GUIDE } from '../../src/modules/codex/adapter.js';
import { AppServerClient } from '../../src/modules/codex/client.js';
import { appServerArguments } from '../../src/modules/codex/launch.js';
import { type CodexKit, FIXTURE_BIN, assistantTexts, createCodexKit, eventsOf, inspection } from '../../src/modules/codex/testing/kit.js';
import { until } from '../../src/testing/agents-kit.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/** A Codex configuration a user might really have — every line of which would undo the Studio's control. */
const personalConfig = (projectDir: string, marker: string): string => `
approval_policy = "never"
sandbox_mode = "danger-full-access"
approvals_reviewer = "auto_review"
developer_instructions = "the user's own instructions"

[sandbox_workspace_write]
writable_roots = ["/"]
network_access = true

[mcp_servers.evil]
command = "/bin/sh"
args = ["-c", "touch ${marker}"]

[mcp_servers."odd name"]
command = "/bin/true"

[projects.${JSON.stringify(projectDir)}]
trust_level = "trusted"
`;

const ALLOW_TOUCH = '# what "always allow" in the Codex terminal writes\nprefix_rule(pattern=["touch"], decision="allow")\n';

describe('the command line the adapter builds', () => {
  it('quotes hostile paths so that the CLI reads back exactly what was meant', async () => {
    // Spaces, both kinds of quote, backslashes, `=`, `]`, `#`, a newline, a tab, shell syntax, other scripts, nothing at all.
    const hostile = ['/opt/my tools/node', `/srv/it's "quoted"/x`, 'C:\\back\\slash\\', '/a=b]c[d/e', '--flag=value', 'tab\there\nnewline', '#hash, comma, {brace}', '${HOME} $(id) `id`', 'unicode ✓ 文件 🎉', '', '"""', "'''"];
    const bridge: BridgeConnection = {
      command: `/weird dir/"node" = [x]\\bin`,
      args: hostile,
      env: { STUDIO_BRIDGE_URL: 'http://127.0.0.1:1', STUDIO_BRIDGE_TOKEN: 'secret-token-value-0123456789' },
      serverName: 'studio',
      permissionPromptTool: 'permission_prompt',
    };
    const cwd = `/work/odd "project" [1]=a\\b`;
    const args = appServerArguments({ bridge, cwd, disableMcpServers: ['odd "name"', 'plain'] });
    // Names of variables, never their values.
    expect(args.join('\n')).not.toContain('secret-token-value');
    expect(args.join('\n')).not.toContain('127.0.0.1');

    // The stand-in parses `-c` values as TOML, strictly, and applies them in order, like the real CLI;
    // ask it what it understood. The two servers that are switched off are defined in the user's
    // configuration, as they would be.
    const home = await mkdtemp(path.join(os.tmpdir(), 'agent-studio-codex-quoting-'));
    await mkdir(path.join(home, '.codex'));
    await writeFile(path.join(home, '.codex', 'standin.json'), '{}');
    await writeFile(path.join(home, '.codex', 'config.toml'), '[mcp_servers."odd \\"name\\""]\ncommand = "x"\n\n[mcp_servers.plain]\ncommand = "y"\n');
    const processes = new ProcessSupervisor();
    const env = { ...processes.env(), PATH: `${FIXTURE_BIN}${path.delimiter}${process.env.PATH ?? ''}`, HOME: home };
    const child = processes.spawn('codex', args, { env, stdin: 'pipe' });
    const quiet = { debug: () => {}, warn: () => {} } as unknown as ConstructorParameters<typeof AppServerClient>[2];
    const client = new AppServerClient(child, { notification: () => {}, request: () => Promise.reject(new Error('unexpected')), failed: () => {} }, quiet);
    try {
      await client.request('initialize', { clientInfo: { name: 'test', title: null, version: '0' }, capabilities: null }, { timeoutMs: 10_000 });
      const read = (await client.request('config/read', { includeLayers: false }, { timeoutMs: 10_000 })) as { config: { mcp_servers: Record<string, Record<string, unknown>>; projects: Record<string, unknown>; features: Record<string, unknown> } };
      const studio = read.config.mcp_servers.studio!;
      expect(studio.command).toBe(bridge.command);
      expect(studio.args).toEqual(hostile);
      expect(studio.env_vars).toEqual(['STUDIO_BRIDGE_URL', 'STUDIO_BRIDGE_TOKEN']);
      expect(studio.env).toBeUndefined();
      expect(studio.default_tools_approval_mode).toBe('approve');
      expect(studio.disabled_tools).toEqual(['permission_prompt']);
      // Switched off, and still the user's definitions underneath: the override was merged in, key by key.
      expect(read.config.mcp_servers['odd "name"']).toEqual({ command: 'x', enabled: false });
      expect(read.config.mcp_servers.plain).toEqual({ command: 'y', enabled: false });
      expect(Object.keys(read.config.mcp_servers).sort()).toEqual(['odd "name"', 'plain', 'studio']);
      // The project and every folder above it are marked untrusted, whatever is in their names.
      expect(Object.keys(read.config.projects)).toEqual([cwd, '/work', '/']);
      expect(Object.values(read.config.projects)).toEqual([{ trust_level: 'untrusted' }, { trust_level: 'untrusted' }, { trust_level: 'untrusted' }]);
      expect(read.config.features).toEqual({ hooks: false, apps: false, plugins: false });
    } finally {
      client.end();
      await Promise.race([client.exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
      terminate(child, 500);
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("the user's own Codex settings, without the Studio's sandbox", () => {
  let kit: CodexKit;
  let project: Project;
  let marker: string;
  const session = (overrides: Record<string, unknown> = {}): Promise<Session> => kit.session(kit.owner, { agentId: 'codex', projectId: project.id, ...overrides });

  beforeAll(async () => {
    kit = await createCodexKit();
    // A folder name that needs quoting everywhere it goes.
    const response = await kit.owner.post<Project>('/api/projects', { name: 'configured', rootDir: path.join(kit.t.workspace, `it's a "project" [1]=x`), createDirectory: true });
    if (response.status !== 201) throw new Error(`Could not create the project: ${JSON.stringify(response.body)}`);
    project = response.body;
    marker = path.join(kit.home, 'evil-mcp-started');
    await kit.writeHome({ 'config.toml': personalConfig(project.rootDir, marker) });
    // The project brings its own configuration and its own rule, and the user's configuration trusts it.
    await mkdir(path.join(project.rootDir, '.codex', 'rules'), { recursive: true });
    await writeFile(path.join(project.rootDir, '.codex', 'config.toml'), 'approval_policy = "never"\n\n[mcp_servers.fromproject]\ncommand = "/bin/true"\n');
    await writeFile(path.join(project.rootDir, '.codex', 'rules', 'project.rules'), ALLOW_TOUCH);
  });
  afterAll(async () => {
    await kit.close();
  });

  it('still asks: approval policy, sandbox, reviewer, MCP servers and project trust are the Studio\'s', async () => {
    const { owner } = kit;
    const created = await session();
    const sent = await kit.send(owner, created.id, '[[scenario:inspect]] [[scenario:run-command touch pinned.txt]]');
    // With the user's configuration alone this command would have run at once: policy "never", and an allow rule.
    const [approval] = await kit.pending(created.id);
    expect(approval).toMatchObject({ toolName: 'shell', command: 'touch pinned.txt' });
    expect(existsSync(path.join(project.rootDir, 'pinned.txt'))).toBe(false);
    await kit.decide(approval!.id, { decision: 'deny' });
    expect((await kit.runEnded(owner, sent.body.runId!)).status).toBe('completed');
    expect(existsSync(path.join(project.rootDir, 'pinned.txt'))).toBe(false);

    const events = await kit.events(owner, created.id);
    const seen = inspection(events);
    expect(seen.cwd).toBe(project.rootDir);
    expect(seen).toMatchObject({ approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'read-only' });
    expect(seen.features).toMatchObject({ hooks: false, apps: false, plugins: false });
    // The user's servers are switched off by name — the odd name included; the project's never loaded.
    expect(seen.mcpServers).toMatchObject({ studio: { enabled: true }, evil: { enabled: false }, 'odd name': { enabled: false } });
    expect(seen.mcpServers.fromproject).toBeUndefined();
    expect(existsSync(marker)).toBe(false);

    // The CLI was started twice: once to learn which servers the configuration defines, once without them.
    // (Starts without the bridge are the adapter asking for the account and the model list.)
    const starts = (await kit.records()).filter((record) => record.event === 'app-server' && record.argv!.some((argument) => argument.startsWith('mcp_servers.studio.command=')));
    expect(starts).toHaveLength(2);
    expect(starts[0]!.argv!.join(' ')).not.toContain('evil');
    expect(starts[1]!.argv).toContain('mcp_servers={"evil" = {"enabled" = false}, "odd name" = {"enabled" = false}}');

    // And the person is told, once per session, that the rest of their settings apply.
    const notices = eventsOf(events, 'notice').map((event) => event.data);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ level: 'info', code: 'codex_personal_settings' });
    await kit.turn(owner, created.id, 'again');
    expect(eventsOf(await kit.events(owner, created.id), 'notice')).toHaveLength(1);
  });

  it('refuses to run with a CLI that does not take the settings it is given', async () => {
    const { owner } = kit;
    await kit.control({ ignoreThreadSettings: true });
    try {
      const created = await session();
      const run = await kit.turn(owner, created.id, '[[scenario:run-command touch unasked.txt]]');
      expect(run).toMatchObject({ status: 'failed', error: { code: 'codex_not_isolated', message: 'Codex did not take the approval and sandbox settings the Studio asked for, so the run was not started.' } });
      expect(existsSync(path.join(project.rootDir, 'unasked.txt'))).toBe(false);
    } finally {
      await kit.control({});
    }
  });

  it('refuses to run when Codex has saved command rules it cannot keep out, and says so in the status', async () => {
    const { owner } = kit;
    await kit.writeHome({ 'rules/default.rules': ALLOW_TOUCH });
    try {
      const created = await session();
      const turnsBefore = (await kit.records()).filter((record) => record.event === 'turn/start').length;
      const run = await kit.turn(owner, created.id, '[[scenario:run-command touch by-rule.txt]]');
      expect(run).toMatchObject({ status: 'failed', error: { code: 'codex_not_isolated' } });
      expect(run.error!.message).toMatch(/^Codex has saved command rules .* Turn the Studio's sandbox on, or move those rule files away\.$/);
      expect(existsSync(path.join(project.rootDir, 'by-rule.txt'))).toBe(false);
      expect((await kit.records()).filter((record) => record.event === 'turn/start')).toHaveLength(turnsBefore);

      const status = await until(async () => {
        const agent = (await owner.get<Agent>('/api/agents/codex')).body;
        return agent.status.problem ? agent.status : null;
      }, { what: 'the status to mention the rules', timeoutMs: 40_000 });
      expect(status).toMatchObject({ installed: true, signedIn: true });
      expect(status.problem).toMatch(/^Codex has saved command rules/);
    } finally {
      await rm(path.join(kit.codexHome, 'rules'), { recursive: true, force: true });
    }
    // A rules file with nothing but comments pre-approves nothing.
    await kit.writeHome({ 'rules/default.rules': '# nothing here\n\n' });
    const created = await session();
    const sent = await kit.send(owner, created.id, '[[scenario:run-command touch after-rules.txt]]');
    const [approval] = await kit.pending(created.id);
    await kit.decide(approval!.id, { decision: 'allow' });
    expect((await kit.runEnded(owner, sent.body.runId!)).status).toBe('completed');
    expect(existsSync(path.join(project.rootDir, 'after-rules.txt'))).toBe(true);
  }, 60_000);
});

describe("the user's own Codex settings, inside the Studio's sandbox", () => {
  let kit: CodexKit | null = null;
  let usable = false;
  beforeAll(async () => {
    usable = (await Sandbox.detect('auto', [])).status.mode === 'bwrap';
    if (!usable) return;
    kit = await createCodexKit({ config: { sandbox: 'bwrap' } });
  });
  afterAll(async () => {
    await kit?.close();
  });

  it('are not there at all: no configuration, no rules, no hooks — and the Studio\'s data is out of reach', async (context) => {
    if (!usable || !kit) {
      context.skip('bubblewrap is not usable on this machine, so hiding the Codex configuration could not be tested here.');
      return;
    }
    const { owner, project } = kit;
    const marker = path.join(kit.home, 'evil-mcp-started');
    await kit.writeHome({
      'config.toml': personalConfig(project.rootDir, marker),
      'rules/default.rules': ALLOW_TOUCH,
      'hooks.json': '{"hooks":{"PermissionRequest":[{"matcher":"*","hooks":[{"type":"command","command":"echo allow"}]}]}}',
    });
    await writeFile(path.join(kit.t.dataDir, 'secret-probe.txt'), 'the Studio keeps this to itself');

    // With rules present the unsandboxed adapter refuses to run; here it runs, because the rules are not there.
    const status = (await owner.get<Agent>('/api/agents/codex')).body.status;
    expect(status).toMatchObject({ installed: true, version: '0.160.0-standin', signedIn: true, problem: null });

    const session = await kit.codexSession();
    const attachmentIds = await kit.upload(session.id, [{ name: 'screen.png', content: PNG, type: 'image/png' }]);
    const sent = await kit.send(owner, session.id, `[[scenario:inspect ${path.join(kit.t.dataDir, 'secret-probe.txt')} ${path.join(kit.codexHome, 'standin.json')}]] [[scenario:run-command touch hidden-level.txt]]`, { attachmentIds });
    const [approval] = await kit.pending(session.id);
    expect(approval).toMatchObject({ toolName: 'shell', command: 'touch hidden-level.txt' });
    expect(existsSync(path.join(project.rootDir, 'hidden-level.txt'))).toBe(false);
    await kit.decide(approval!.id, { decision: 'allow' });
    expect((await kit.runEnded(owner, sent.body.runId!)).status).toBe('completed');
    expect(existsSync(path.join(project.rootDir, 'hidden-level.txt'))).toBe(true);

    const events = await kit.events(owner, session.id);
    const seen = inspection(events);
    // The files are in place for everyone else…
    expect(existsSync(path.join(kit.codexHome, 'rules', 'default.rules'))).toBe(true);
    // …and empty for Codex: as with --ignore-user-config --ignore-rules.
    expect(seen.home).toEqual({ configBytes: 0, hooksBytes: 0, rules: [] });
    expect(Object.keys(seen.mcpServers)).toEqual(['studio']);
    // The only instructions are the Studio's own, not the user's "developer_instructions".
    expect(seen).toMatchObject({ approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'read-only', developerInstructions: `${PERMISSIONS_GUIDE}\n\n${kit.t.studio.context.services.memory.agentGuide()}` });
    expect(existsSync(marker)).toBe(false);
    expect(eventsOf(events, 'notice')).toHaveLength(0);
    expect((await kit.records()).filter((record) => record.event === 'app-server' && record.argv!.includes('app-server')).length).toBeGreaterThanOrEqual(1);

    // The data directory is hidden — the attachment that goes with this message is not — and the rest of
    // the Codex home (where the sign-in and the conversations are) is as it was.
    expect(seen.readable).toEqual({ [path.join(kit.t.dataDir, 'secret-probe.txt')]: false, [path.join(kit.codexHome, 'standin.json')]: true });
    expect(seen.images).toEqual([{ path: expect.stringContaining(kit.t.dataDir), bytes: PNG.length }]);
    expect(assistantTexts(events).at(-1)).toBe('The command finished. Process exited with code 0.');
  }, 60_000);
});
