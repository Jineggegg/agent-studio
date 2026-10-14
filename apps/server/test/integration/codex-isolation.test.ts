import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Agent, Project, Session } from '@agent-studio/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProcessSupervisor, Sandbox, terminate } from '../../src/kernel/process.js';
import type { BridgeConnection } from '../../src/modules/agents/adapter.js';
import { PERMISSIONS_GUIDE } from '../../src/modules/codex/adapter.js';
import { AppServerClient } from '../../src/modules/codex/client.js';
import { appServerArguments } from '../../src/modules/codex/launch.js';
import { agentCredentialsAllowed } from '../../src/modules/codex/codex.module.js';
import { type CodexKit, FIXTURE_BIN, WITHOUT_SANDBOX_NOTICE, assistantTexts, createCodexKit, eventsOf, inspection } from '../../src/modules/codex/testing/kit.js';
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

describe("without the Studio's sandbox, where the operator allows Codex to run anyway", () => {
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

    // The conversation begins by saying what running without the sandbox means — and, here, that the
    // account's own Codex settings apply as well. It says so once, not with every turn.
    const notices = eventsOf(await kit.allEvents(owner, created.id), 'notice').map((event) => event.data);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ level: 'warning', code: WITHOUT_SANDBOX_NOTICE });
    expect(notices[0]!.text).toBe(
      "This Studio runs Codex without its sandbox. The commands Codex runs without asking can read any file the Studio's account can read — files outside the project, credentials and the Studio's own data included. Anything that changes something still needs approval. That account's own Codex settings and instructions also apply here; approvals, the sandbox, MCP servers, hooks and project trust are still set by the Studio.",
    );
    const all = await kit.allEvents(owner, created.id);
    expect(all.findIndex((event) => event.type === 'notice')).toBeLessThan(all.findIndex((event) => event.type === 'message.assistant'));
    await kit.turn(owner, created.id, 'again');
    expect(eventsOf(await kit.allEvents(owner, created.id), 'notice')).toHaveLength(1);
    // The next conversation says it again.
    const next = await session();
    await kit.turn(owner, next.id, 'hello');
    expect(eventsOf(await kit.allEvents(owner, next.id), 'notice').map((event) => event.data.code)).toEqual([WITHOUT_SANDBOX_NOTICE]);
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

describe("without the Studio's sandbox, and without the operator's word", () => {
  let kit: CodexKit;
  beforeAll(async () => {
    // The harness has no sandbox; the kit's usual "the operator allows it" is taken back.
    kit = await createCodexKit({ config: { sandbox: 'off', codexWithoutSandbox: false } });
  });
  afterAll(async () => {
    await kit.close();
  });

  const REFUSAL =
    "Codex is switched off here because the Studio's sandbox is not available (Turned off by configuration). Codex runs read-only commands without asking, and without the sandbox those could read the Studio's own data and every credential of the account it runs as. Install bubblewrap and leave AGENT_STUDIO_SANDBOX on auto; or, accepting that risk, set AGENT_STUDIO_CODEX_WITHOUT_SANDBOX=on. Then restart the Studio.";

  it('says in its status that Codex is switched off, why, and what to do', async () => {
    const agent = (await kit.owner.get<Agent>('/api/agents/codex')).body;
    expect(agent.status).toEqual({ installed: true, version: '0.160.0-standin', signedIn: true, account: null, problem: REFUSAL });
    // Nothing was started to ask a CLI that may not run for its models.
    expect(agent.capabilities.models).toEqual([]);
    expect((await kit.records()).filter((record) => record.event === 'app-server')).toHaveLength(0);
  });

  it('does not run: no process, no conversation, the same words as the failure', async () => {
    const session = await kit.codexSession();
    const run = await kit.turn(kit.owner, session.id, '[[scenario:read-command cat /etc/hostname]]');
    expect(run).toMatchObject({ status: 'failed', error: { code: 'sandbox_required', message: REFUSAL } });
    expect(await kit.records()).toEqual([]);
    const events = await kit.allEvents(kit.owner, session.id);
    expect(events.map((event) => event.type)).toEqual(['message.user', 'run.started', 'run.finished']);
  });
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
      // The personal instructions of the account the Studio runs as: not for other people's sessions.
      'AGENTS.md': 'Always sign commits as the owner.\n',
      'AGENTS.override.md': 'And push straight to main.\n',
    });
    // The project's own instruction file is the project's, and stays.
    await writeFile(path.join(project.rootDir, 'AGENTS.md'), 'Run the tests before you say you are done.\n');
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
    // …and empty for Codex: as with --ignore-user-config --ignore-rules, and without the account's instructions.
    expect(seen.home).toEqual({ configBytes: 0, hooksBytes: 0, agentsBytes: 0, overrideBytes: 0, rules: [] });
    expect(seen.instructionSources).toEqual([path.join(project.rootDir, 'AGENTS.md')]);
    expect(Object.keys(seen.mcpServers)).toEqual(['studio']);
    // The only instructions are the Studio's own, not the user's "developer_instructions".
    expect(seen).toMatchObject({ approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'read-only', developerInstructions: `${PERMISSIONS_GUIDE}\n\n${kit.t.studio.context.services.memory.agentGuide()}` });
    expect(existsSync(marker)).toBe(false);
    // Nothing to warn about: this is the sandbox.
    expect(eventsOf(await kit.allEvents(owner, session.id), 'notice')).toHaveLength(0);
    expect((await kit.records()).filter((record) => record.event === 'app-server' && record.argv!.includes('app-server')).length).toBeGreaterThanOrEqual(1);

    // The data directory is hidden — the attachment that goes with this message is not — and the rest of
    // the Codex home (where the sign-in and the conversations are) is as it was.
    expect(seen.readable).toEqual({ [path.join(kit.t.dataDir, 'secret-probe.txt')]: false, [path.join(kit.codexHome, 'standin.json')]: true });
    expect(seen.images).toEqual([{ path: expect.stringContaining(kit.t.dataDir), bytes: PNG.length }]);
    expect(assistantTexts(events).at(-1)).toBe('The command finished. Process exited with code 0.');
  }, 60_000);

  it('refuses to run with a CLI that says it loaded the personal instructions anyway', async (context) => {
    if (!usable || !kit) {
      context.skip('bubblewrap is not usable on this machine, so there is no sandbox to test.');
      return;
    }
    await kit.writeHome({ 'AGENTS.md': 'Always sign commits as the owner.\n' });
    await kit.control({ claimPersonalInstructions: true });
    const turns = async (): Promise<number> => (await kit!.records()).filter((record) => record.event === 'turn/start').length;
    const turnsBefore = await turns();
    try {
      const session = await kit.codexSession();
      const run = await kit.turn(kit.owner, session.id, 'hello');
      expect(run).toMatchObject({ status: 'failed', error: { code: 'codex_not_isolated', message: expect.stringContaining('personal instruction file') } });
      // The thread was opened, the answer was read, and no turn was started.
      expect(await turns()).toBe(turnsBefore);
    } finally {
      await kit.control({});
    }
  }, 60_000);
});

/**
 * Codex runs read-only commands without asking anybody, so what such a command
 * can read is decided by the sandbox: the credentials of the account the
 * Studio runs as are not there unless the project's owner says agents may use
 * them.
 */
describe("the account's credentials, inside the Studio's sandbox", () => {
  let kit: CodexKit | null = null;
  let usable = false;
  let files: { key: string; ssh: string; gh: string; claude: string; netrc: string; own: string };

  beforeAll(async () => {
    usable = (await Sandbox.detect('auto', [])).status.mode === 'bwrap';
    if (!usable) return;
    kit = await createCodexKit({ config: { sandbox: 'auto' } });
    const home = kit.home;
    files = {
      ssh: path.join(home, '.ssh'),
      key: path.join(home, '.ssh', 'id_ed25519'),
      gh: path.join(home, '.config', 'gh', 'hosts.yml'),
      claude: path.join(home, '.claude', '.credentials.json'),
      netrc: path.join(home, '.netrc'),
      own: path.join(kit.codexHome, 'auth.json'),
    };
    for (const [name, file] of Object.entries(files)) {
      if (name === 'ssh') continue;
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, `secret of ${name}`);
    }
  });
  afterAll(async () => {
    await kit?.close();
  });

  /** What a command of the agent can read of each file: its size, or null. */
  const visible = async (sessionId: string): Promise<Record<string, number | null>> => {
    const run = await kit!.turn(kit!.owner, sessionId, `[[scenario:inspect ${files.key} ${files.gh} ${files.claude} ${files.netrc} ${files.own}]] [[scenario:read-command cat ${files.key}]]`);
    expect(run.status).toBe('completed');
    const seen = inspection(await kit!.events(kit!.owner, sessionId));
    return { key: seen.bytes[files.key]!, gh: seen.bytes[files.gh]!, claude: seen.bytes[files.claude]!, netrc: seen.bytes[files.netrc]!, own: seen.bytes[files.own]! };
  };
  const catOutput = async (sessionId: string): Promise<string> => eventsOf(await kit!.events(kit!.owner, sessionId), 'tool.finished').at(-1)!.data.output;

  it('are not there for a run by default — all but Codex\'s own sign-in', async (context) => {
    if (!usable || !kit) return context.skip('bubblewrap is not usable on this machine, so hiding credentials could not be tested here.');
    expect(kit.t.studio.context.sandbox.status.mode).toBe('bwrap');
    expect(agentCredentialsAllowed(kit.t.studio.context, kit.project.id)).toBe(false);
    const session = await kit.codexSession();
    // A hidden folder is empty; a hidden file is an empty file.
    expect(await visible(session.id)).toEqual({ key: null, gh: null, claude: null, netrc: 0, own: 'secret of own'.length });
    // The command Codex ran without asking — the case the permission engine never sees — found nothing either.
    expect(await catOutput(session.id)).toMatch(/No such file or directory/);
    // Outside the run nothing changed.
    expect(await readFile(files.key, 'utf8')).toBe('secret of key');
  }, 60_000);

  it('are there once the owner of the project allows agents to use them', async (context) => {
    if (!usable || !kit) return context.skip('bubblewrap is not usable on this machine, so hiding credentials could not be tested here.');
    const { owner, project } = kit;
    expect((await owner.patch<Project>(`/api/projects/${project.id}`, { features: { agentCredentials: true } })).body.features.agentCredentials).toBe(true);
    try {
      expect(agentCredentialsAllowed(kit.t.studio.context, project.id)).toBe(true);
      const session = await kit.codexSession();
      const size = 'secret of '.length;
      expect(await visible(session.id)).toEqual({ key: size + 3, gh: size + 2, claude: size + 6, netrc: size + 5, own: size + 3 });
      expect(await catOutput(session.id)).toBe('secret of key');
      // The Studio's own data stays hidden whatever the project allows.
      const again = await kit.turn(owner, session.id, `[[scenario:inspect ${path.join(kit.t.dataDir, 'studio.db')}]]`);
      expect(again.status).toBe('completed');
      expect(inspection((await kit.events(owner, session.id)).slice(-4)).readable).toEqual({ [path.join(kit.t.dataDir, 'studio.db')]: false });
    } finally {
      await owner.patch(`/api/projects/${project.id}`, { features: { agentCredentials: false } });
    }
  }, 60_000);

  it('are not there for a run outside any project, whatever a project allows', async (context) => {
    if (!usable || !kit) return context.skip('bubblewrap is not usable on this machine, so hiding credentials could not be tested here.');
    const { owner, project } = kit;
    expect(agentCredentialsAllowed(kit.t.studio.context, null)).toBe(false);
    expect(agentCredentialsAllowed(kit.t.studio.context, 'no-such-project')).toBe(false);

    // The runtime gives a coding agent no session without a project, so the request is made to look like one:
    // the project allows credentials, and the run reaches the adapter with no project named.
    await owner.patch(`/api/projects/${project.id}`, { features: { agentCredentials: true } });
    const adapter = kit.t.studio.context.services.agents.adapter('codex')!;
    const run = adapter.run.bind(adapter);
    adapter.run = (request, host) => run({ ...request, projectId: null }, host);
    try {
      const session = await kit.codexSession();
      expect(await visible(session.id)).toEqual({ key: null, gh: null, claude: null, netrc: 0, own: 'secret of own'.length });
    } finally {
      adapter.run = run;
      await owner.patch(`/api/projects/${project.id}`, { features: { agentCredentials: false } });
    }
  }, 60_000);
});
