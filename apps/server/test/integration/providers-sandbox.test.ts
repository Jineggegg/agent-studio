import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Provider, Session } from '@agent-studio/protocol';
import { type TestContext, afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FakeToolCall } from '../../src/modules/providers/testing/fake-openai.js';
import { type ProvidersKit, createProvidersKit, eventsOf } from '../../src/modules/providers/testing/providers-kit.js';
import { until } from '../../src/testing/agents-kit.js';

/**
 * Proofs that a command an API model asks for runs confined. They need
 * bubblewrap; where it is missing or unusable every test here is skipped
 * with the reason, and the behaviour without a sandbox is covered by
 * `providers-tools.test.ts`.
 */

let kit: ProvidersKit;
let provider: Provider;
let reason: string | null = null;

beforeAll(async () => {
  kit = await createProvidersKit({ config: { sandbox: 'auto' } });
  const status = kit.t.studio.context.sandbox.status;
  if (status.mode !== 'bwrap') reason = `bubblewrap is not usable here (${status.reason ?? 'unknown'}), so the sandbox proofs did not run`;
  provider = await kit.provider();
  // Auto mode: the permission engine lets everything through that is not on its hard-deny list,
  // so whatever these tests see refused is refused by the sandbox and by nothing else.
  expect((await kit.owner.put(`/api/agents/projects/${kit.project.id}/settings`, { autoMode: true })).status).toBe(200);
  writeFileSync(kit.file('notes.txt'), 'inside the project\n');
});
afterAll(async () => {
  await kit.close();
});
beforeEach(() => {
  kit.model.reset();
});

const needsSandbox = (context: TestContext): void => {
  if (reason !== null) context.skip(reason);
};
const command = (line: string, extra: Record<string, unknown> = {}): FakeToolCall => ({ name: 'run_command', arguments: { command: line, ...extra } });
const autoSession = (): Promise<Session> => kit.session(provider, kit.owner, { permissionMode: 'auto' });
const results = (): string[] =>
  (kit.model.lastChat.body.messages as Array<{ role: string; content: string }>).filter((message) => message.role === 'tool').map((message) => message.content);
const interfaces = (procNetDev: string): string[] =>
  procNetDev
    .split('\n')
    .map((line) => /^\s*([^\s:]+):/.exec(line)?.[1])
    .filter((name): name is string => name !== undefined);

/** Runs the commands in one turn of an auto-mode session and returns what the model was told about each. */
async function run(...lines: FakeToolCall[]): Promise<string[]> {
  const session = await autoSession();
  kit.model.script({ toolCalls: lines }, { text: 'done' });
  const finished = await kit.turn(kit.owner, session.id, 'run these');
  expect(finished.status).toBe('completed');
  const events = await kit.events(kit.owner, session.id);
  // Confined: no warning about a missing sandbox, and nobody had to be asked.
  expect(eventsOf(events, 'notice').map((notice) => notice.code)).not.toContain('sandbox_unavailable');
  expect(events.map((event) => event.type)).not.toContain('approval.requested');
  return results();
}

describe('commands of an API model, in the sandbox', () => {
  it('run in the project, directly or through a shell', async (context) => {
    needsSandbox(context);
    const [direct, shell, written] = await run(command('pwd'), command('cat notes.txt | tr a-z A-Z'), command('echo made by the model > made.txt && cat made.txt'));
    expect(direct).toBe(`Exit code 0.\n--- output ---\n${kit.project.rootDir}`);
    expect(shell).toBe('Exit code 0.\n--- output ---\nINSIDE THE PROJECT');
    expect(written).toBe('Exit code 0.\n--- output ---\nmade by the model');
    // The project itself is writable, and what is written there is really there.
    expect(readFileSync(kit.file('made.txt'), 'utf8')).toBe('made by the model\n');
  });

  it("cannot read the Studio's master key or anything else of its data", async (context) => {
    needsSandbox(context);
    const masterKey = path.join(kit.t.dataDir, 'master.key');
    const secret = readFileSync(masterKey, 'utf8').trim();
    expect(secret.length).toBeGreaterThan(20);
    // The path is computed while the command runs, so no static check of the command line can see it coming.
    const data = '"$(cd ../.. && pwd)/data"';
    const [key, listing, database, named] = await run(
      command(`cat ${data}/master.key`),
      command(`ls -A ${data}`),
      command(`cat ${data}/studio.db | head -c 200`),
      // Named outright, it does not even get as far as the sandbox: the permission engine refuses it in every mode.
      command(`cat ${masterKey}`),
    );
    expect(key).toContain('No such file or directory');
    expect(listing).toBe('Exit code 0.\n(no output)');
    expect(database).toContain('No such file or directory');
    expect(named).toContain("Denied:");
    expect(named).toContain("Studio's own data directory");
    const everything = JSON.stringify(kit.model.chats.map((chat) => chat.body));
    expect(everything).not.toContain(secret);
    expect(everything).not.toContain('SQLite format');
  });

  it('cannot read the credential folders of the account it runs as', async (context) => {
    needsSandbox(context);
    const ssh = path.join(os.homedir(), '.ssh');
    const real = existsSync(ssh) ? readdirSync(ssh) : [];
    const [listing, key] = await run(command('ls -A ~/.ssh'), command('cat ~/.ssh/id_ed25519 ~/.ssh/id_rsa ~/.ssh/config'));
    // Where the folder exists it is an empty one in the sandbox; where it does not, there is nothing to read anyway.
    expect(listing).toMatch(/\(no output\)|No such file or directory/);
    expect(key).toContain('No such file or directory');
    expect(key).not.toContain('PRIVATE KEY');
    for (const name of real) expect(listing).not.toContain(name);
  });

  it('cannot write outside the project', async (context) => {
    needsSandbox(context);
    const marker = `agent-studio-sandbox-escape-${process.pid}-${Date.now()}`;
    const inHome = path.join(os.homedir(), `.${marker}`);
    const besideProject = path.join(kit.t.workspace, `${marker}.txt`);
    const inTmp = path.join(os.tmpdir(), `${marker}.txt`);
    try {
      const [home, beside, tmp, system, inside] = await run(
        command(`touch "$HOME/.${marker}"`),
        command(`echo escaped > ../${marker}.txt; echo exit=$?`),
        command(`echo escaped > /tmp/${marker}.txt; echo exit=$?`),
        command(`touch /usr/${marker}`),
        command(`touch ${marker}.txt && echo written`),
      );
      // The file system is read-only outside the project…
      expect(home).toContain('Read-only file system');
      expect(system).toContain('Read-only file system');
      // …and /tmp (where this test's project happens to live) is the sandbox's own: what lands there never reaches the host.
      expect(beside).toContain('exit=');
      expect(tmp).toContain('exit=');
      expect(inside).toContain('written');
      expect(existsSync(inHome)).toBe(false);
      expect(existsSync(besideProject)).toBe(false);
      expect(existsSync(inTmp)).toBe(false);
      expect(existsSync(`/usr/${marker}`)).toBe(false);
      expect(existsSync(kit.file(`${marker}.txt`))).toBe(true);
    } finally {
      // Nothing should be there; if a proof failed, do not leave litter behind.
      for (const leftover of [inHome, besideProject, inTmp]) {
        if (existsSync(leftover)) (await import('node:fs')).rmSync(leftover, { force: true });
      }
    }
  });

  it('has no network unless it was asked for and allowed', async (context) => {
    needsSandbox(context);
    const host = interfaces(readFileSync('/proc/net/dev', 'utf8'));
    const [offline, online] = await run(command('cat /proc/net/dev'), command('cat /proc/net/dev', { network: true }));
    // Without the request: the loopback interface of an empty network namespace, and nothing else.
    expect(interfaces(offline!)).toEqual(['lo']);
    // With it: the machine's interfaces.
    expect(interfaces(online!).sort()).toEqual([...host].sort());

    // In `ask` mode the network is a question of its own, after the command.
    const session = await kit.session(provider);
    kit.model.script({ toolCalls: [command('cat /proc/net/dev | head -3', { network: true })] }, { text: 'done' });
    const message = await kit.send(kit.owner, session.id, 'show the network');
    const first = (await kit.pending(kit.owner, session.id))[0]!;
    expect(first).toMatchObject({ toolName: 'run_command', toolKind: 'execute' });
    // With a sandbox a shell line is an ordinary request: it may be remembered.
    expect(first.suggestedRule).not.toBeNull();
    await kit.decide(kit.owner, first.id, { decision: 'allow' });
    const second = await until(async () => (await kit.pending(kit.owner, session.id)).find((entry) => entry.id !== first.id), { what: 'the network approval' });
    expect(second).toMatchObject({ toolName: 'run_command_network', toolKind: 'fetch' });
    await kit.decide(kit.owner, second.id, { decision: 'deny' });
    expect((await kit.runEnded(kit.owner, message.body.runId!)).status).toBe('completed');
    expect(results()[0]).toContain('Denied:');
  });

  it("does not see the server's own settings", async (context) => {
    needsSandbox(context);
    process.env.AGENT_STUDIO_SANDBOX_PROOF = 'must-not-leak-into-a-command';
    try {
      const [environment, proc] = await run(command('env'), command('cat /proc/1/environ | tr "\\0" "\\n"'));
      expect(environment).toContain('PATH=');
      expect(environment).toContain('HOME=');
      for (const output of [environment, proc]) {
        expect(output).not.toContain('AGENT_STUDIO');
        expect(output).not.toContain('must-not-leak-into-a-command');
        expect(output).not.toContain('STUDIO_BRIDGE');
      }
    } finally {
      delete process.env.AGENT_STUDIO_SANDBOX_PROOF;
    }
  });

  it('is killed with everything it started when its time is up', async (context) => {
    needsSandbox(context);
    const processes = kit.t.studio.context.processes;
    const started = Date.now();
    // A background process as well: the whole tree has to go.
    const [timedOut] = await run(command('sleep 31.4159 & sleep 31.4159; wait', { timeout_seconds: 1 }));
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(timedOut).toContain('The command was stopped after 1 s (timeout).');
    expect(processes.running).toBe(0);
    await until(async () => (await processes.run('pgrep', ['-f', 'sleep 31\\.4159'])).stdout.trim() === '', { what: 'the sleeping processes to be gone' });
  });

  it('is killed at once when the run is stopped', async (context) => {
    needsSandbox(context);
    const processes = kit.t.studio.context.processes;
    const session = await autoSession();
    kit.model.script({ toolCalls: [command('sleep 32.7182 & sleep 32.7182; wait')] }, { text: 'never reached' });
    const message = await kit.send(kit.owner, session.id, 'sleep');
    await until(async () => (await processes.run('pgrep', ['-f', 'sleep 32\\.7182'])).stdout.trim() !== '', { what: 'the command to be running' });
    const stopping = Date.now();
    await kit.owner.post(`/api/sessions/${session.id}/stop`);
    expect((await kit.runEnded(kit.owner, message.body.runId!)).status).toBe('stopped');
    await until(async () => (await processes.run('pgrep', ['-f', 'sleep 32\\.7182'])).stdout.trim() === '', { what: 'the sleeping processes to be gone' });
    expect(Date.now() - stopping).toBeLessThan(20_000);
    expect(processes.running).toBe(0);
    expect(kit.model.chats).toHaveLength(1);
    expect(kit.t.studio.context.services.providers.activeTurns).toBe(0);
  });
});
