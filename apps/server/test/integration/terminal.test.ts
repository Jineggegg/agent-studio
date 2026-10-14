import { readFileSync, readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  type AuthState,
  type CloseTerminalSessionResponse,
  type CreatedApiToken,
  type Project,
  TERMINAL_CLOSE_CODES,
  TERMINAL_EVENTS,
  type TerminalCapability,
  type TerminalSession,
  type TerminalSessionList,
  type TypeTextResponse,
} from '@agent-studio/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import type WebSocket from 'ws';
import type { ConfigOverrides } from '../../src/kernel/config.js';
import { programLauncher } from '../../src/modules/terminal/launchers.js';
import { loadNativePty } from '../../src/modules/terminal/pty.js';
import { type TerminalModuleOptions, createTerminalModule } from '../../src/modules/terminal/terminal.module.js';
import {
  type AttachOptions,
  type AttachedTerminal,
  type TerminalConnection,
  attachTerminal,
  connectTerminal,
  modulesWith,
  processIsRunning,
  waitUntil,
} from '../../src/modules/terminal/testing/terminal-client.js';
import { TEST_PASSWORD, type TestClient, type TestStudio, createTestStudio } from '../../src/testing/harness.js';

/**
 * These tests drive real shells in real pseudo-terminals over real WebSockets.
 * Every shell they start is ended by the server under test; `afterEach`
 * verifies that against the process table, so a leak fails the suite.
 */

const pty = await loadNativePty();
const live = describe.skipIf(!pty.available);
const liveTitle = (title: string) => (pty.available ? title : `${title} (SKIPPED: the pseudo-terminal library cannot load: ${pty.reason})`);

/** A plain POSIX shell without the account's profile, so that tests see the same prompt everywhere. */
const TEST_SHELL = { file: '/bin/sh', args: [] } as const;
/** Short enough that ending a terminal does not slow the suite, long enough for a shell to react to a hang-up. */
const FAST = { terminateGraceMs: 400, killWaitMs: 800 } as const;
const MISSING_ID = '00000000000000000000000000';

interface Bench {
  readonly t: TestStudio;
  readonly wsUrl: string;
  readonly origin: string;
  readonly owner: TestClient;
  readonly project: Project;
  /** Creates a session and remembers its process so that the clean-up check covers it. */
  create(body?: Record<string, unknown>, as?: TestClient): Promise<TerminalSession>;
  attach(session: TerminalSession | string, options?: Partial<AttachOptions>): Promise<AttachedTerminal>;
  connect(session: TerminalSession | string, options?: Partial<AttachOptions>): Promise<TerminalConnection>;
  pidOf(session: TerminalSession, as?: TestClient): number;
  secondOwner(): Promise<TestClient>;
  apiToken(): Promise<TestClient>;
  /** Makes every browser session look as if its last proof of identity was long ago. */
  ageAuthentication(): void;
}

const benches: Bench[] = [];
const sockets: WebSocket[] = [];
const startedPids: number[] = [];

async function start(options: { terminal?: TerminalModuleOptions; config?: ConfigOverrides } = {}): Promise<Bench> {
  const t = await createTestStudio({
    modules: modulesWith(
      createTerminalModule({ shell: TEST_SHELL, ...options.terminal, limits: { ...FAST, ...options.terminal?.limits } }),
    ),
    ...(options.config ? { config: options.config } : {}),
  });
  const address = await t.listen();
  const owner = await t.owner();
  const created = await owner.post<Project>('/api/projects', { name: 'demo', rootDir: path.join(t.workspace, 'demo'), createDirectory: true });
  expect(created.status).toBe(201);

  const idOf = (session: TerminalSession | string) => (typeof session === 'string' ? session : session.id);
  const socketOptions = (session: TerminalSession | string, extra: Partial<AttachOptions> = {}): AttachOptions => ({
    wsUrl: address.wsUrl,
    origin: address.url,
    client: owner,
    sessionId: idOf(session),
    ...extra,
  });
  const bench: Bench = {
    t,
    wsUrl: address.wsUrl,
    origin: address.url,
    owner,
    project: created.body,
    async create(body = {}, as = owner) {
      const response = await as.post<TerminalSession>('/api/terminal/sessions', { projectId: created.body.id, ...body });
      expect(response.body, JSON.stringify(response.body)).toMatchObject({ alive: true });
      expect(response.status).toBe(201);
      startedPids.push(bench.pidOf(response.body, as));
      return response.body;
    },
    async attach(session, extra) {
      const connection = await attachTerminal(socketOptions(session, extra));
      sockets.push(connection.socket);
      return connection;
    },
    async connect(session, extra) {
      const connection = await connectTerminal(socketOptions(session, extra));
      sockets.push(connection.socket);
      return connection;
    },
    pidOf(session, as = owner) {
      const pid = t.studio.context.services.terminal.processIdOf(as.userId!, session.id);
      expect(pid).toBeTypeOf('number');
      return pid!;
    },
    async secondOwner() {
      const made = await owner.post('/api/users', { username: 'second', password: TEST_PASSWORD, role: 'owner' });
      expect(made.status).toBe(201);
      return t.signIn('second');
    },
    async apiToken() {
      const made = await owner.post<CreatedApiToken>('/api/auth/tokens', { name: 'robot', scopes: ['read', 'write', 'admin'] });
      expect(made.status).toBe(200);
      const robot = t.anonymous();
      robot.bearer = made.body.token;
      return robot;
    },
    ageAuthentication() {
      t.studio.context.db.run('UPDATE auth_sessions SET authenticated_at = ?', Date.now() - 16 * 60 * 1000);
    },
  };
  benches.push(bench);
  return bench;
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const bench of benches.splice(0)) await bench.t.close();
  // Stopping the server must have ended every shell these tests started.
  const pids = startedPids.splice(0);
  await waitUntil(() => pids.every((pid) => !processIsRunning(pid)), 3000, 'every test shell to be gone').catch(() => {});
  expect(pids.filter(processIsRunning), 'shells left running after the server stopped').toEqual([]);
});

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs a command in the shell and returns what it printed, using markers the echoed command line cannot contain. */
async function run(terminal: TerminalConnection, command: string, timeoutMs = 5000): Promise<string> {
  // Only what comes after this point counts: a replay may hold the markers of earlier commands.
  const from = terminal.mark();
  terminal.type(`printf '<%s>' be"gin"; ${command}; printf '<%s>\\n' e"nd"\r`);
  await terminal.expectOutput('<begin>', timeoutMs);
  await terminal.expectOutput('<end>', timeoutMs);
  const text = terminal.text();
  const begin = text.indexOf('<begin>', from) + '<begin>'.length;
  return text.slice(begin, text.indexOf('<end>', begin)).replaceAll('\r\n', '\n').trim();
}

/** Waits until a client has received nothing new for a moment: a shell prints its prompt after a command's output. */
async function quiet(terminal: { readonly seq: number }, restMs = 300): Promise<void> {
  let seen = terminal.seq;
  let since = Date.now();
  await waitUntil(
    () => {
      if (terminal.seq !== seen) {
        seen = terminal.seq;
        since = Date.now();
      }
      return Date.now() - since >= restMs;
    },
    5000,
    'the output to come to rest',
  );
}

/** Waits until a client has been told that the terminal now has this size. */
const toldSize = (terminal: TerminalConnection, cols: number, rows: number) =>
  waitUntil(() => terminal.frames.some((frame) => frame.type === 'resize' && frame.cols === cols && frame.rows === rows), 3000, `a resize to ${cols}x${rows}`);

/** Living child processes of a process, from the process table. */
function childrenOf(pid: number): number[] {
  return readdirSync('/proc')
    .filter((name) => /^\d+$/.test(name))
    .filter((name) => {
      try {
        const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        return fields[0] !== 'Z' && Number(fields[1]) === pid;
      } catch {
        return false;
      }
    })
    .map(Number);
}

const sessionOf = async (client: TestClient, id: string) => client.get<TerminalSession>(`/api/terminal/sessions/${id}`);

// ─────────────────────────────────────────────────────────────────────────────

live(liveTitle('a terminal session'), () => {
  it('starts the shell in the project folder and echoes what is typed', async () => {
    const bench = await start();
    const session = await bench.create({ cols: 100, rows: 30 });
    expect(session).toMatchObject({
      projectId: bench.project.id,
      title: 'demo',
      launcher: null,
      remoteHostId: null,
      directory: bench.project.rootDir,
      attachedClients: 0,
      alive: true,
      exitCode: null,
      cols: 100,
      rows: 30,
      attachable: true,
    });

    const terminal = await bench.attach(session, { cols: 100, rows: 30 });
    expect(terminal.attached).toMatchObject({ protocol: 1, replay: { from: 0, truncated: false }, session: { id: session.id, attachedClients: 1 } });
    expect(await run(terminal, 'pwd')).toBe(bench.project.rootDir);
    expect(await run(terminal, 'echo round-$((40 + 2))-trip')).toBe('round-42-trip');

    const listed = await bench.owner.get<TerminalSessionList>('/api/terminal/sessions');
    expect(listed.body.sessions).toHaveLength(1);
    expect(listed.body.sessions[0]).toMatchObject({ id: session.id, attachedClients: 1, idleExpiresAt: null });
    expect(listed.body.sessions[0]!.seq).toBeGreaterThan(0);
    // Filtering by project.
    expect((await bench.owner.get<TerminalSessionList>(`/api/terminal/sessions?projectId=${bench.project.id}`)).body.sessions).toHaveLength(1);
    expect((await bench.owner.get<TerminalSessionList>(`/api/terminal/sessions?projectId=${MISSING_ID}`)).body.sessions).toEqual([]);
  });

  it("gives the shell the account's environment without anything of the server's own", async () => {
    process.env.AGENT_STUDIO_TEST_SECRET = 'must-not-leak-into-a-terminal';
    try {
      const bench = await start();
      const terminal = await bench.attach(await bench.create());
      const environment = await run(terminal, 'env');
      expect(environment).toContain('TERM=xterm-256color');
      expect(environment).toContain('COLORTERM=truecolor');
      expect(environment).toContain('SHELL=/bin/sh');
      expect(environment).toMatch(/^(LANG|LC_ALL|LC_CTYPE)=/m);
      expect(environment).not.toContain('AGENT_STUDIO_');
      expect(environment).not.toContain('must-not-leak');
      expect(environment).not.toContain(bench.t.dataDir);
    } finally {
      delete process.env.AGENT_STUDIO_TEST_SECRET;
    }
  });

  it('resizes the terminal when the client says so', async () => {
    const bench = await start();
    const session = await bench.create();
    const terminal = await bench.attach(session);
    expect(await run(terminal, 'stty size')).toBe('24 80');

    terminal.sendFrame({ type: 'resize', cols: 132, rows: 43 });
    expect(await terminal.next('resize')).toMatchObject({ cols: 132, rows: 43 });
    expect(await run(terminal, 'stty size')).toBe('43 132');
    expect((await sessionOf(bench.owner, session.id)).body).toMatchObject({ cols: 132, rows: 43 });

    // Sizes outside the allowed range are a protocol error, not a crash.
    terminal.sendFrame({ type: 'resize', cols: 0, rows: 43 });
    expect((await terminal.closed).code).toBe(TERMINAL_CLOSE_CODES.protocol);
  });

  it('carries bytes untouched when a character is split across frames, in both directions', async () => {
    const bench = await start();
    const terminal = await bench.attach(await bench.create());
    const sample = 'héllo→世界🙂';
    // At its prompt first: input that arrives before the shell reads it is echoed by the terminal driver
    // byte by byte, and a character split across frames would then be echoed in two pieces.
    await run(terminal, 'true');

    // Input: cut the command in the middle of a three-byte character.
    const command = Buffer.from(`printf '<%s>' be"gin"; printf '%s' '${sample}' | od -An -v -tx1 | tr -d ' \\n'; printf '<%s>\\n' e"nd"\r`, 'utf8');
    const cut = command.indexOf(Buffer.from('世', 'utf8')) + 2;
    terminal.type(command.subarray(0, cut));
    await pause(60);
    terminal.type(command.subarray(cut));
    await terminal.expectOutput('<begin>');
    await terminal.expectOutput('<end>');
    const hex = /<begin>([0-9a-f]+)<end>/.exec(terminal.text())?.[1];
    expect(hex).toBe(Buffer.from(sample, 'utf8').toString('hex'));
    // The terminal echoed the typed line, and the echo is intact as well.
    expect(terminal.text()).toContain(`printf '%s' '${sample}'`);

    // Output: thousands of small writes, read by the server at arbitrary boundaries.
    const repeat = 3000;
    const out = await run(terminal, `i=0; while [ $i -lt ${repeat} ]; do printf '世界🙂'; i=$((i+1)); done`);
    expect(out).toBe('世界🙂'.repeat(repeat));
    expect(terminal.text()).not.toContain('\ufffd');
  });

  it('keeps running while nobody is attached and restores the screen on return', async () => {
    const bench = await start();
    const session = await bench.create();
    const first = await bench.attach(session);
    expect(await run(first, 'MARKER=kept-$((6 * 7)); echo set')).toBe('set');
    first.type('(sleep 0.4; echo late-$((20 + 3))) &\r');
    await first.expectOutput(') &');
    await pause(80);
    const reached = first.seq;
    await first.close();
    expect((await sessionOf(bench.owner, session.id)).body).toMatchObject({ attachedClients: 0, alive: true });
    expect((await sessionOf(bench.owner, session.id)).body.idleExpiresAt).toBeGreaterThan(Date.now());

    // The job finished while no client was there.
    await waitUntil(async () => (await sessionOf(bench.owner, session.id)).body.seq > reached, 3000, 'output while detached');
    await pause(150);

    // Coming back with a position: exactly what was missed, nothing more.
    const second = await bench.attach(session, { after: reached });
    expect(second.attached.replay).toMatchObject({ mode: 'delta', from: reached, truncated: false });
    expect(second.attached.replay.to).toBeGreaterThan(reached);
    expect(second.bytes().length).toBe(second.attached.replay.to - reached);
    expect(second.text()).toContain('late-23');
    expect(second.text()).not.toContain('kept-');
    expect(second.seq).toBe(second.attached.replay.to);
    // The shell is the same one: its variable is still there.
    expect(await run(second, 'echo $MARKER')).toBe('kept-42');
    await second.close();

    // Coming back without a position: the whole screen, from the start.
    const third = await bench.attach(session);
    expect(third.attached.replay).toMatchObject({ mode: 'full', from: 0, truncated: false });
    expect(third.text()).toContain('late-23');
    expect(third.text()).toContain('kept-42');
    expect(third.seq).toBe((await sessionOf(bench.owner, session.id)).body.seq);
    expect(await run(third, 'echo still-$MARKER')).toBe('still-kept-42');
  });

  it('replays from a clean line when older output has scrolled out of the buffer', async () => {
    const bench = await start({ terminal: { limits: { replayBufferBytes: 4096 } } });
    const session = await bench.create();
    const first = await bench.attach(session);
    await run(first, 'i=0; while [ $i -lt 400 ]; do echo "line $i of filler text that overflows the buffer"; i=$((i+1)); done');
    await quiet(first);
    const total = first.seq;
    await first.close();

    const second = await bench.attach(session);
    const replay = second.attached.replay;
    expect(replay).toMatchObject({ mode: 'full', truncated: true, to: total });
    expect(replay.from).toBeGreaterThan(total - 4096);
    expect(replay.to - replay.from).toBeLessThanOrEqual(4096);
    expect(second.bytes().length).toBe(replay.to - replay.from);
    expect(second.text()).toMatch(/^line \d+ of filler text/);
    await second.close();

    // A position that is no longer kept, or that never existed, also gets the full replay.
    for (const after of [10, total + 1_000_000]) {
      const again = await bench.attach(session, { after });
      expect(again.attached.replay.mode).toBe('full');
      await again.close();
    }
  });

  it('lets a connection that had not attached yet read why the terminal ended', async () => {
    const bench = await start();
    const session = await bench.create();
    const waiting = await bench.connect(session); // connected, its attach frame not sent yet
    const first = await bench.attach(session);
    first.type('echo gone-$((1 + 1)); exit 3\r');
    expect(await first.next('exit')).toMatchObject({ exitCode: 3, reason: 'exited' });
    waiting.sendFrame({ type: 'attach', cols: 80, rows: 24 });
    await waiting.next('attached');
    expect(await waiting.next('exit')).toMatchObject({ exitCode: 3, reason: 'exited' });
    expect(waiting.text()).toContain('gone-2');
  });

  it('serves two devices at once and follows the size of the one used last', async () => {
    const bench = await start();
    const session = await bench.create();
    const laptop = await bench.attach(session, { cols: 80, rows: 24 });
    const phone = await bench.attach(session, { cols: 50, rows: 20 });
    // The newcomer is the most recently active client.
    await toldSize(laptop, 50, 20);
    await toldSize(phone, 50, 20);
    expect((await sessionOf(bench.owner, session.id)).body).toMatchObject({ attachedClients: 2, cols: 50, rows: 20 });

    expect(await run(phone, 'stty size; echo from-phone-$((1 + 1))')).toBe('20 50\nfrom-phone-2');
    await laptop.expectOutput('from-phone-2');

    // Typing on the laptop makes it the active one: the terminal takes its size back.
    expect(await run(laptop, 'stty size; echo from-laptop-$((2 + 1))')).toBe('24 80\nfrom-laptop-3');
    await phone.expectOutput('from-laptop-3');
    await toldSize(phone, 80, 24);

    // When the active device leaves, the size follows the one that remains.
    phone.sendFrame({ type: 'resize', cols: 60, rows: 22 });
    await toldSize(laptop, 60, 22);
    await phone.close();
    await waitUntil(async () => (await sessionOf(bench.owner, session.id)).body.attachedClients === 1);
    expect((await sessionOf(bench.owner, session.id)).body).toMatchObject({ cols: 80, rows: 24, idleExpiresAt: null });
    expect(laptop.frames.some((frame) => frame.type === 'session' && frame.session.attachedClients === 1)).toBe(true);
    expect(await run(laptop, 'stty size')).toBe('24 80');
  });

  it('ends a session nobody has been attached to for the idle window', async () => {
    const bench = await start({ terminal: { limits: { idleTimeoutMs: 1200 } } });
    const session = await bench.create();
    const pid = bench.pidOf(session);
    expect(session.idleExpiresAt).toBeGreaterThan(Date.now());

    // An attached client holds the session open past the window.
    const terminal = await bench.attach(session);
    await pause(1800);
    expect(await run(terminal, 'echo alive-$((3 + 4))')).toBe('alive-7');
    expect(processIsRunning(pid)).toBe(true);

    // The countdown starts when the last client leaves.
    await terminal.close();
    await waitUntil(async () => (await sessionOf(bench.owner, session.id)).body.alive === false, 4000, 'the idle session to end');
    expect((await sessionOf(bench.owner, session.id)).body).toMatchObject({ alive: false, endReason: 'idle', idleExpiresAt: null });
    await waitUntil(() => !processIsRunning(pid), 2000, 'the idle shell to be gone');

    // The next visit starts a fresh shell.
    const fresh = await bench.attach(await bench.create());
    expect(await run(fresh, 'echo fresh-$((5 + 5))')).toBe('fresh-10');
  });

  it('ends a session that reaches its maximum age even while it is in use', async () => {
    const bench = await start({ terminal: { limits: { maxLifetimeMs: 600 } } });
    const session = await bench.create();
    expect(session.expiresAt - session.createdAt).toBe(600);
    const terminal = await bench.attach(session);
    expect(await terminal.next('exit', 4000)).toMatchObject({ reason: 'lifetime' });
    expect((await terminal.closed).code).toBe(TERMINAL_CLOSE_CODES.ended);
    await waitUntil(() => !processIsRunning(bench.pidOf(session)), 2000);
  });

  it('reports the exit status and lets a late client read how it ended', async () => {
    const bench = await start({ terminal: { limits: { endedRetentionMs: 2000 } } });
    const session = await bench.create();
    const terminal = await bench.attach(session);
    expect(await run(terminal, 'echo last-words-$((9 * 9))')).toBe('last-words-81');
    terminal.type('exit 3\r');
    expect(await terminal.next('exit')).toMatchObject({ exitCode: 3, signal: null, reason: 'exited' });
    expect(await terminal.closed).toMatchObject({ code: TERMINAL_CLOSE_CODES.ended });
    expect((await sessionOf(bench.owner, session.id)).body).toMatchObject({ alive: false, exitCode: 3, signal: null, endReason: 'exited', attachedClients: 0 });

    // An ended session is still listed for a while and can be read once more.
    const late = await bench.connect(session);
    late.sendFrame({ type: 'attach', cols: 80, rows: 24 });
    expect((await late.next('attached')).session).toMatchObject({ alive: false, exitCode: 3 });
    expect(await late.next('exit')).toMatchObject({ exitCode: 3, reason: 'exited' });
    expect((await late.closed).code).toBe(TERMINAL_CLOSE_CODES.ended);
    expect(late.text()).toContain('last-words-81');
    // Nothing can be typed into it any more.
    expect((await bench.owner.post(`/api/terminal/sessions/${session.id}/input`, { text: 'echo hi' })).body).toMatchObject({ error: { code: 'terminal_ended' } });

    // Then it is forgotten.
    await waitUntil(async () => (await sessionOf(bench.owner, session.id)).status === 404, 6000, 'the ended session to be forgotten');
    const gone = await bench.connect(session);
    expect((await gone.closed).code).toBe(TERMINAL_CLOSE_CODES.notFound);
  });

  it('reports a program that was killed by a signal', async () => {
    const bench = await start();
    const session = await bench.create();
    const terminal = await bench.attach(session);
    terminal.type('kill -9 $$\r');
    expect(await terminal.next('exit')).toMatchObject({ exitCode: null, signal: 9, reason: 'exited' });
    expect((await sessionOf(bench.owner, session.id)).body).toMatchObject({ alive: false, exitCode: null, signal: 9 });
  });

  it('leaves no process behind when a session is closed', async () => {
    const bench = await start();
    const session = await bench.create();
    const shell = bench.pidOf(session);
    const terminal = await bench.attach(session);
    const background = Number(await run(terminal, 'sleep 3021 & echo $!'));
    // A job that ignores the hang-up a closing terminal sends.
    const stubborn = Number(await run(terminal, "(trap '' HUP; exec sleep 3022) & echo $!"));
    terminal.type('sleep 3023\r');
    await waitUntil(() => childrenOf(shell).length === 3, 3000, 'the foreground job to start');
    const all = [shell, ...childrenOf(shell)];
    expect(all).toContain(background);
    expect(all).toContain(stubborn);
    expect(all.every(processIsRunning)).toBe(true);

    const closed = await bench.owner.delete<CloseTerminalSessionResponse>(`/api/terminal/sessions/${session.id}`);
    expect(closed.status).toBe(200);
    expect(closed.body).toEqual({ closed: true, remainingProcesses: 0 });
    // The answer came only after the process table confirmed it.
    expect(all.filter(processIsRunning)).toEqual([]);

    expect(await terminal.next('exit')).toMatchObject({ reason: 'closed' });
    expect((await terminal.closed).code).toBe(TERMINAL_CLOSE_CODES.ended);
    expect((await sessionOf(bench.owner, session.id)).status).toBe(404);
    expect((await bench.owner.get<TerminalSessionList>('/api/terminal/sessions')).body.sessions).toEqual([]);
    expect((await bench.owner.delete(`/api/terminal/sessions/${session.id}`)).status).toBe(404);
  });

  it('also clears what a shell leaves running when it exits by itself', async () => {
    const bench = await start();
    const session = await bench.create();
    const terminal = await bench.attach(session);
    const background = Number(await run(terminal, 'sleep 3031 & echo $!'));
    expect(processIsRunning(background)).toBe(true);
    terminal.type('exit 0\r');
    expect(await terminal.next('exit')).toMatchObject({ exitCode: 0, reason: 'exited' });
    await waitUntil(() => !processIsRunning(background), 3000, 'the orphaned job to be ended');
    // Closing an ended session reports the same clean state.
    expect((await bench.owner.delete<CloseTerminalSessionResponse>(`/api/terminal/sessions/${session.id}`)).body).toEqual({ closed: true, remainingProcesses: 0 });
  });

  it('ends every terminal when the server stops', async () => {
    const bench = await start();
    const pids: number[] = [];
    const terminals: AttachedTerminal[] = [];
    for (let index = 0; index < 3; index += 1) {
      const session = await bench.create();
      const terminal = await bench.attach(session);
      pids.push(bench.pidOf(session), Number(await run(terminal, `sleep 304${index} & echo $!`)));
      terminals.push(terminal);
    }
    expect(pids.every(processIsRunning)).toBe(true);

    await bench.t.close();
    expect(pids.filter(processIsRunning)).toEqual([]);
    for (const terminal of terminals) {
      expect(terminal.frames.find((frame) => frame.type === 'exit')).toMatchObject({ reason: 'shutdown' });
      expect((await terminal.closed).code).toBe(TERMINAL_CLOSE_CODES.goingAway);
    }
  });

  it('refuses more terminals than the limits allow', async () => {
    const bench = await start({ terminal: { limits: { maxSessionsPerUser: 2, maxSessions: 3 } } });
    const first = await bench.create();
    await bench.create();
    const third = await bench.owner.post('/api/terminal/sessions', { projectId: bench.project.id });
    expect(third.status).toBe(409);
    expect(third.body).toMatchObject({ error: { code: 'terminal_limit_reached', details: { scope: 'user', limit: 2 } } });

    // The limit for the whole server spans users.
    const second = await bench.secondOwner();
    await bench.create({}, second);
    const overall = await second.post('/api/terminal/sessions', { projectId: bench.project.id });
    expect(overall.body).toMatchObject({ error: { code: 'terminal_limit_reached', details: { scope: 'server', limit: 3 } } });

    // Closing one makes room; an ended one does not count either.
    expect((await bench.owner.delete(`/api/terminal/sessions/${first.id}`)).status).toBe(200);
    const replacement = await bench.create();
    const terminal = await bench.attach(replacement);
    terminal.type('exit\r');
    await terminal.next('exit');
    await bench.create();
  });

  it('limits how many devices attach to one session', async () => {
    const bench = await start({ terminal: { limits: { maxClientsPerSession: 1 } } });
    const session = await bench.create();
    const first = await bench.attach(session);
    const second = await bench.connect(session);
    second.sendFrame({ type: 'attach', cols: 80, rows: 24 });
    expect(await second.next('error')).toMatchObject({ code: 'too_many_clients' });
    expect((await second.closed).code).toBe(TERMINAL_CLOSE_CODES.tooManyClients);
    expect(second.bytes().length).toBe(0);
    expect(await run(first, 'echo undisturbed-$((1 + 2))')).toBe('undisturbed-3');
    await first.close();
    await waitUntil(async () => (await sessionOf(bench.owner, session.id)).body.attachedClients === 0);
    const third = await bench.attach(session);
    expect(await run(third, 'echo welcome-$((2 + 2))')).toBe('welcome-4');
  });

  it('drops connections that break the protocol and keeps the session', async () => {
    const bench = await start({ terminal: { limits: { maxInputFrameBytes: 1024, attachTimeoutMs: 1000 } } });
    const session = await bench.create();
    const protocol = TERMINAL_CLOSE_CODES.protocol;

    const tooBig = await bench.attach(session);
    tooBig.type(Buffer.alloc(2000, 0x61));
    expect(await tooBig.next('error')).toMatchObject({ code: 'frame_too_large' });
    expect((await tooBig.closed).code).toBe(protocol);

    const early = await bench.connect(session);
    early.type('echo before attaching\r');
    expect(await early.next('error')).toMatchObject({ code: 'attach_expected' });
    expect((await early.closed).code).toBe(protocol);

    const silent = await bench.connect(session);
    expect(await silent.next('error', 3000)).toMatchObject({ code: 'attach_expected' });
    expect((await silent.closed).code).toBe(protocol);

    const twice = await bench.attach(session);
    twice.sendFrame({ type: 'attach', cols: 80, rows: 24 });
    expect(await twice.next('error')).toMatchObject({ code: 'already_attached' });
    expect((await twice.closed).code).toBe(protocol);

    for (const bad of ['this is not json', JSON.stringify({ type: 'run', command: 'id' }), JSON.stringify({ type: 'attach', cols: 80, rows: 24, command: 'id' }), JSON.stringify(['attach'])]) {
      const connection = await bench.connect(session);
      connection.socket.send(bad);
      expect(await connection.next('error')).toMatchObject({ code: 'malformed_frame' });
      expect((await connection.closed).code).toBe(protocol);
    }

    // A frame beyond what the server accepts at all ends that connection only.
    const huge = await bench.attach(session);
    huge.type(Buffer.alloc(2 * 1024 * 1024, 0x61));
    expect((await huge.closed).code).toBe(1009);

    // None of that reached the shell or harmed the session.
    const fine = await bench.attach(session);
    expect(fine.text()).not.toContain('before attaching');
    expect(await run(fine, 'echo intact-$((7 * 6))')).toBe('intact-42');
    fine.sendFrame({ type: 'ping', t: 7 });
    expect(await fine.next('pong')).toMatchObject({ t: 7 });
  });

  it('types text for the user without ever pressing Enter or passing a control sequence', async () => {
    const bench = await start();
    const session = await bench.create();
    const terminal = await bench.attach(session);
    const input = `/api/terminal/sessions/${session.id}/input`;

    // Typed, shown, not run — until the user presses Enter.
    const typed = await bench.owner.post<TypeTextResponse>(input, { text: 'echo typed-$((20 + 22))\n' });
    expect(typed.status).toBe(200);
    expect(typed.body).toEqual({ typed: 'echo typed-$((20 + 22))', removed: 1 });
    await terminal.expectOutput('echo typed-$((20 + 22))');
    await pause(300);
    expect(terminal.text()).not.toContain('typed-42');
    terminal.type('\r');
    await terminal.expectOutput('typed-42');

    // Control characters are taken out: no Enter, no interrupt, no escape sequence, no hidden reordering.
    const hostile = 'echo A\u001b[2JB\u0003C\u0007D\u009b31mE\u202eF\tG\r';
    const cleaned = await bench.owner.post<TypeTextResponse>(input, { text: hostile });
    expect(cleaned.body).toEqual({ typed: 'echo A[2JBCD31mEF\tG', removed: 6 });
    await pause(200);
    expect(terminal.bytes().includes(Buffer.from('\u001b[2J'))).toBe(false);
    terminal.type('\u0015'); // the user clears the line themselves

    // Several lines are refused whole rather than glued into one command.
    for (const text of ['cd /tmp\nrm -rf *', 'first\r\nsecond\n', 'a\u0085b']) {
      const refused = await bench.owner.post(input, { text });
      expect(refused.status).toBe(400);
      expect(refused.body).toMatchObject({ error: { code: 'multiline_text' } });
    }
    expect((await bench.owner.post(input, { text: '\u001b\u0007\n' })).body).toMatchObject({ error: { code: 'nothing_to_type' } });
    expect((await bench.owner.post(input, { text: 'x'.repeat(4001) })).status).toBe(400);
    expect((await bench.owner.post(input, { text: '' })).status).toBe(400);
    expect((await bench.owner.post(input, { text: 'echo hi', enter: true })).status).toBe(400);
    expect((await bench.owner.post(`/api/terminal/sessions/${MISSING_ID}/input`, { text: 'echo hi' })).status).toBe(404);
    await pause(200);
    expect(terminal.text()).not.toContain('rm -rf');

    // The shell is still at a clean prompt.
    expect(await run(terminal, 'echo prompt-$((1 + 1))')).toBe('prompt-2');
  });

  it('announces local development servers once each, and nothing else', async () => {
    const bench = await start();
    const session = await bench.create();
    const terminal = await bench.attach(session);
    // Coloured the way a development server prints its address, with the port in bold.
    terminal.type("printf '  Local:   \\033[36mhttp://localhost:\\033[1m5173\\033[22m/\\033[39m\\n'\r");
    expect(await terminal.next('url')).toEqual({ type: 'url', url: { url: 'http://localhost:5173/', scheme: 'http', host: 'localhost', port: 5173 } });

    await run(terminal, 'echo https://example.com/docs http://192.168.1.20:3000/ http://localhost.example.com:3000/');
    await run(terminal, "printf 'again http://localhost:%s/\\n' 5173");
    await run(terminal, "printf 'api on http://127.0.0.1:%s/health.\\n' 8080");
    expect(await terminal.next('url')).toMatchObject({ url: { url: 'http://127.0.0.1:8080/health', host: '127.0.0.1', port: 8080 } });
    await pause(400);
    expect(terminal.frames.filter((frame) => frame.type === 'url')).toHaveLength(2);

    const listed = (await sessionOf(bench.owner, session.id)).body.urls;
    expect(listed.map((url) => url.url)).toEqual(['http://localhost:5173/', 'http://127.0.0.1:8080/health']);
    // A client that attaches later learns them from the session, not from the replay.
    const later = await bench.attach(session);
    expect(later.attached.session.urls).toEqual(listed);
    await pause(300);
    expect(later.frames.some((frame) => frame.type === 'url')).toBe(false);
  });

  it('pauses the program for a client that stops reading, then drops that client', async () => {
    const KIB = 1024;
    const bench = await start({
      terminal: {
        limits: { clientBufferHighBytes: 64 * KIB, clientBufferLowBytes: 16 * KIB, clientBufferHardBytes: 4096 * KIB, slowClientGraceMs: 300, replayBufferBytes: 64 * KIB },
      },
    });
    const session = await bench.create();
    const stalled = await bench.attach(session);
    await run(stalled, 'echo ready');
    // 40 MB of output towards a client that has stopped reading.
    stalled.type("head -c 40000000 /dev/zero | tr '\\000' x; echo; echo flood-$((1 + 1))-done\r");
    stalled.socket.pause();

    // The server gives up on the stalled client instead of buffering the flood,
    // and tells it why once it reads again.
    await waitUntil(async () => (await sessionOf(bench.owner, session.id)).body.attachedClients === 0, 15_000, 'the stalled client to be dropped');
    stalled.socket.resume();
    expect((await stalled.closed).code).toBe(TERMINAL_CLOSE_CODES.slowConsumer);
    expect(stalled.frames.some((frame) => frame.type === 'error' && frame.code === 'slow_consumer')).toBe(true);
    // It was sent only a bounded backlog, not the whole flood.
    expect(stalled.seq).toBeLessThan(30_000_000);

    // The program, which had been held back, then runs to its end.
    await waitUntil(async () => (await sessionOf(bench.owner, session.id)).body.seq > 40_000_000, 30_000, 'the flood to finish');
    const watcher = await bench.attach(session);
    expect(watcher.text()).toContain('flood-2-done');
    expect(await run(watcher, 'echo recovered-$((2 + 2))')).toBe('recovered-4');
  }, 60_000);

  it('slows down a client that floods input instead of losing or buffering it without bound', async () => {
    const bench = await start({ terminal: { limits: { inputBurstBytes: 8 * 1024, inputBytesPerSecond: 128 * 1024 } } });
    const session = await bench.create();
    const terminal = await bench.attach(session);
    expect(await run(terminal, 'stty -echo; n=0; echo quiet')).toBe('quiet');
    // 400 lines of about a kilobyte each, sent as fast as the socket takes them: far beyond the allowance.
    const lines = 400;
    const started = Date.now();
    for (let index = 0; index < lines; index += 1) terminal.type(`n=$((n+1)) # ${'x'.repeat(1000)}\r`);
    // Every line arrived, in order, exactly once …
    expect(await run(terminal, 'echo counted-$n', 20_000)).toBe(`counted-${lines}`);
    // … but no faster than the sustained rate allows (about 430 kB at 128 kB/s).
    expect(Date.now() - started).toBeGreaterThan(1500);
  }, 40_000);

  it('runs only the fixed launchers the server defines', async () => {
    const bench = await start();
    const terminal = bench.t.studio.context.services.terminal;
    terminal.registerLauncher(programLauncher({ key: 'test-banner', title: 'Banner', kind: 'other', program: 'sh', args: ['-c', 'echo launched-$((6 * 6)); pwd; exec cat'] }));
    terminal.registerLauncher(programLauncher({ key: 'test-anywhere', title: 'Anywhere', kind: 'other', program: 'sh', args: ['-c', 'pwd; exec cat'], projectOptional: true }));
    terminal.registerLauncher(programLauncher({ key: 'test-missing', title: 'Missing', kind: 'other', program: 'no-such-program-anywhere', args: [] }));
    expect(() => terminal.registerLauncher(programLauncher({ key: 'test-banner', title: 'Again', kind: 'other', program: 'sh', args: [] }))).toThrow(/already registered/);
    expect(() => terminal.registerLauncher(programLauncher({ key: 'Not A Key', title: 'x', kind: 'other', program: 'sh', args: [] }))).toThrow(/not a valid launcher key/);

    const capability = (await bench.owner.get<TerminalCapability>('/api/terminal/capability')).body;
    const byKey = new Map(capability.launchers.map((launcher) => [launcher.key, launcher]));
    expect(byKey.get('test-banner')).toMatchObject({ title: 'Banner', kind: 'other', requiresProject: true, requiresRemote: false, available: true, unavailableReason: null });
    expect(byKey.get('test-anywhere')).toMatchObject({ requiresProject: false, available: true });
    expect(byKey.get('test-missing')).toMatchObject({ available: false, unavailableReason: expect.stringContaining('not installed') });
    for (const key of ['claude-login', 'codex-login', 'codex-login-device']) {
      expect(byKey.get(key)).toMatchObject({ kind: 'agent-sign-in', requiresProject: false, requiresRemote: false });
    }

    const session = await bench.create({ launcher: 'test-banner' });
    expect(session).toMatchObject({ launcher: 'test-banner', title: 'Banner', directory: bench.project.rootDir });
    const banner = await bench.attach(session);
    await banner.expectOutput('launched-36');
    await banner.expectOutput(bench.project.rootDir);
    banner.type('typed into the launcher\r');
    await banner.expectOutput('typed into the launcher');

    // Without a project a launcher that allows it starts in the account's home directory.
    const anywhere = await bench.owner.post<TerminalSession>('/api/terminal/sessions', { launcher: 'test-anywhere' });
    expect(anywhere.status).toBe(201);
    startedPids.push(bench.pidOf(anywhere.body));
    expect(anywhere.body).toMatchObject({ projectId: null, directory: null });
    const home = await bench.attach(anywhere.body);
    await home.expectOutput(os.homedir());

    // What a client cannot do.
    const post = (body: Record<string, unknown>) => bench.owner.post('/api/terminal/sessions', { projectId: bench.project.id, ...body });
    expect((await post({ launcher: 'test-missing' })).body).toMatchObject({ error: { code: 'launcher_unavailable' } });
    expect((await post({ launcher: 'no-such-launcher' })).body).toMatchObject({ error: { code: 'unknown_launcher' } });
    expect((await post({ launcher: '../../bin/sh' })).status).toBe(400);
    expect((await post({ launcher: 'test-banner', remote: { hostId: 'somewhere' } })).body).toMatchObject({ error: { code: 'remote_not_expected' } });
    for (const extra of [{ command: 'id' }, { shell: '/bin/bash' }, { cwd: '/etc' }, { args: ['-c', 'id'] }, { env: { X: '1' } }, { program: 'id' }]) {
      const refused = await post(extra);
      expect(refused.status, JSON.stringify(extra)).toBe(400);
      expect(refused.body).toMatchObject({ error: { code: 'invalid_request' } });
    }
    expect((await bench.owner.post('/api/terminal/sessions', {})).body).toMatchObject({ error: { code: 'project_required' } });
    expect((await bench.owner.post('/api/terminal/sessions', { launcher: 'test-banner' })).body).toMatchObject({ error: { code: 'project_required' } });
    expect((await bench.owner.post('/api/terminal/sessions', { projectId: MISSING_ID })).status).toBe(404);
    expect((await post({ cols: 0 })).status).toBe(400);
    expect((await post({ title: 'bad\u0007title' })).status).toBe(400);
  });

  it('hides the data directory from a launcher that asks for the sandbox', async (context) => {
    const bench = await start({ config: { sandbox: 'auto' } });
    if (bench.t.studio.context.sandbox.status.mode !== 'bwrap') return context.skip();
    const terminal = bench.t.studio.context.services.terminal;
    const count = `ls -A ${bench.t.dataDir} | wc -l`;
    terminal.registerLauncher({ key: 'test-masked', title: 'Masked', kind: 'other', plan: () => ({ file: 'sh', args: ['-c', `echo entries=$(${count}); exec cat`], sandbox: { kind: 'mask' } }) });
    terminal.registerLauncher({ key: 'test-open', title: 'Open', kind: 'other', plan: () => ({ file: 'sh', args: ['-c', `echo entries=$(${count}); exec cat`] }) });

    const open = await bench.attach(await bench.create({ launcher: 'test-open' }));
    expect(Number(/entries=(\d+)/.exec(await open.expectOutput(/entries=\d+/))![1])).toBeGreaterThan(0);

    const session = await bench.create({ launcher: 'test-masked' });
    const masked = await bench.attach(session);
    await masked.expectOutput('entries=0');
    // Ending it ends the sandbox and what runs inside it.
    const pids = [bench.pidOf(session), ...childrenOf(bench.pidOf(session))];
    expect(pids.length).toBeGreaterThan(1);
    expect((await bench.owner.delete<CloseTerminalSessionResponse>(`/api/terminal/sessions/${session.id}`)).body).toEqual({ closed: true, remainingProcesses: 0 });
    expect(pids.filter(processIsRunning)).toEqual([]);
  });

  it('renames a session and tells its clients', async () => {
    const bench = await start();
    const session = await bench.create({ title: 'build' });
    expect(session.title).toBe('build');
    const terminal = await bench.attach(session);
    const renamed = await bench.owner.patch<TerminalSession>(`/api/terminal/sessions/${session.id}`, { title: '  dev server  ' });
    expect(renamed.body).toMatchObject({ id: session.id, title: 'dev server' });
    await waitUntil(() => terminal.frames.some((frame) => frame.type === 'session' && frame.session.title === 'dev server'));
    expect((await bench.owner.patch(`/api/terminal/sessions/${session.id}`, { title: '' })).status).toBe(400);
    expect((await bench.owner.patch(`/api/terminal/sessions/${session.id}`, { title: 'x'.repeat(81) })).status).toBe(400);
    expect((await bench.owner.patch(`/api/terminal/sessions/${session.id}`, { title: 'ok', alive: false })).status).toBe(400);
    expect((await bench.owner.patch(`/api/terminal/sessions/${MISSING_ID}`, { title: 'ok' })).status).toBe(404);
  });

  it('records who opened what in the audit log, and nothing that was typed', async () => {
    const bench = await start();
    const events: Array<{ type: string; data: unknown }> = [];
    bench.t.studio.context.bus.onTopic(`user:${bench.owner.userId}`, (event) => events.push({ type: event.type, data: event.data }));

    const session = await bench.create();
    const terminal = await bench.attach(session);
    await run(terminal, 'echo a-very-private-line-$((1 + 1))');
    await bench.owner.post(`/api/terminal/sessions/${session.id}/input`, { text: 'echo another-private-line' });
    await bench.owner.delete(`/api/terminal/sessions/${session.id}`);

    const audit = await bench.owner.get<{ events: Array<{ action: string; subject: string | null; detail: string; userId: string }> }>('/api/audit?category=change&limit=200');
    const created = audit.body.events.filter((event) => event.action === 'terminal.session.created');
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ userId: bench.owner.userId, subject: 'demo', detail: `launcher: shell; project: ${bench.project.id}` });
    expect(JSON.stringify(audit.body)).not.toContain('private-line');

    // Other tabs are told that the list changed, by id only.
    const ours = events.filter((event) => event.type.startsWith('terminal.'));
    for (const type of Object.values(TERMINAL_EVENTS)) expect(ours.map((event) => event.type)).toContain(type);
    for (const event of ours) expect(event.data).toEqual({ sessionId: session.id, projectId: bench.project.id });
  });

  it('ends the terminals of a project that is removed', async () => {
    const bench = await start();
    const session = await bench.create();
    const pid = bench.pidOf(session);
    const terminal = await bench.attach(session);
    expect((await bench.owner.delete(`/api/projects/${bench.project.id}`)).status).toBe(204);
    expect(await terminal.next('exit')).toMatchObject({ reason: 'project_removed' });
    await waitUntil(() => !processIsRunning(pid), 3000);
  });

  it('refuses to start in a project folder that has disappeared', async () => {
    const bench = await start();
    await rm(bench.project.rootDir, { recursive: true });
    const refused = await bench.owner.post('/api/terminal/sessions', { projectId: bench.project.id });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: { code: 'project_folder_missing' } });
    expect(bench.t.studio.context.services.terminal.liveSessionCount).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

live(liveTitle('who may reach a terminal'), () => {
  it('keeps one owner out of another owner\u2019s sessions', async () => {
    const bench = await start();
    const second = await bench.secondOwner();
    const mine = await bench.create();
    const theirs = await bench.create({}, second);

    expect((await bench.owner.get<TerminalSessionList>('/api/terminal/sessions')).body.sessions.map((session) => session.id)).toEqual([mine.id]);
    expect((await second.get<TerminalSessionList>('/api/terminal/sessions')).body.sessions.map((session) => session.id)).toEqual([theirs.id]);

    // Somebody else's session answers exactly like one that does not exist.
    const foreign = `/api/terminal/sessions/${theirs.id}`;
    const missing = `/api/terminal/sessions/${MISSING_ID}`;
    for (const call of [
      (url: string) => bench.owner.get(url),
      (url: string) => bench.owner.patch(url, { title: 'mine now' }),
      (url: string) => bench.owner.post(`${url}/input`, { text: 'id' }),
      (url: string) => bench.owner.delete(url),
    ]) {
      const [a, b] = [await call(foreign), await call(missing)];
      expect(a.status).toBe(404);
      expect(a.body).toEqual(b.body);
    }
    for (const id of [theirs.id, MISSING_ID, 'not-an-id']) {
      const connection = await bench.connect(id);
      expect(await connection.next('error')).toMatchObject({ code: 'session_not_found' });
      expect((await connection.closed).code).toBe(TERMINAL_CLOSE_CODES.notFound);
      expect(connection.bytes().length).toBe(0);
    }

    // Untouched, and still its creator's.
    expect((await sessionOf(second, theirs.id)).body).toMatchObject({ title: 'demo', alive: true });
    const terminal = await bench.attach(theirs, { client: second });
    expect(await run(terminal, 'echo private-$((8 * 8))')).toBe('private-64');
  });

  it('refuses visitors, members and API tokens on every route', async () => {
    const bench = await start();
    const session = await bench.create();
    const member = await bench.t.member();
    const token = await bench.apiToken();
    const base = `/api/terminal/sessions/${session.id}`;
    const calls: Array<[string, (client: TestClient) => Promise<{ status: number; body: unknown }>]> = [
      ['list', (client) => client.get('/api/terminal/sessions')],
      ['create', (client) => client.post('/api/terminal/sessions', { projectId: bench.project.id })],
      ['read', (client) => client.get(base)],
      ['rename', (client) => client.patch(base, { title: 'x' })],
      ['type', (client) => client.post(`${base}/input`, { text: 'id' })],
      ['close', (client) => client.delete(base)],
    ];
    for (const [name, call] of calls) {
      expect((await call(bench.t.anonymous())).status, `anonymous ${name}`).toBe(401);
      expect((await call(member)).body, `member ${name}`).toMatchObject({ error: { code: 'owner_required' } });
      expect((await call(token)).body, `token ${name}`).toMatchObject({ error: { code: 'session_required' } });
    }
    // A member cannot be given a terminal by sharing the project with them either.
    await bench.owner.put(`/api/projects/${bench.project.id}/members/${member.userId}`, { access: 'write' });
    expect((await member.post('/api/terminal/sessions', { projectId: bench.project.id })).status).toBe(403);

    // The same people at the socket: refused before the upgrade, so no frame is ever received.
    await expect(bench.connect(session, { client: null })).rejects.toThrow('HTTP 401');
    await expect(bench.connect(session, { client: member })).rejects.toThrow('HTTP 403');
    await expect(bench.connect(session, { client: token })).rejects.toThrow('HTTP 403');
    await expect(bench.connect(session, { headers: { origin: 'https://evil.example' } })).rejects.toThrow('HTTP 403');
    await expect(bench.connect(session, { headers: { origin: 'null' } })).rejects.toThrow('HTTP 403');
    const stolen = bench.t.anonymous();
    stolen.cookie = 'studio_session=not-a-real-session';
    await expect(bench.connect(session, { client: stolen })).rejects.toThrow('HTTP 401');

    // Nobody got in, and the session is as it was.
    expect((await sessionOf(bench.owner, session.id)).body).toMatchObject({ alive: true, attachedClients: 0, title: 'demo' });
    expect(bench.t.studio.context.services.terminal.liveSessionCount).toBe(1);

    // What each of them is told when asking whether they can have a terminal.
    expect((await bench.t.anonymous().get('/api/terminal/capability')).status).toBe(401);
    expect((await member.get<TerminalCapability>('/api/terminal/capability')).body).toMatchObject({ available: false, reason: { code: 'owner_only' }, launchers: [] });
    expect((await token.get<TerminalCapability>('/api/terminal/capability')).body).toMatchObject({ available: false, reason: { code: 'session_required' } });
    expect((await bench.owner.get<TerminalCapability>('/api/terminal/capability')).body).toMatchObject({
      available: true,
      reason: null,
      needsReauth: false,
      shell: 'sh',
      limits: { maxSessionsPerUser: 16, maxSessions: 32, maxClientsPerSession: 4, idleTimeoutMs: 30 * 60_000, replayBufferBytes: 1024 * 1024, typedTextMaxChars: 4000 },
    });
  });

  it('asks for a recent proof of identity for the first terminal of a browser, and not again on return', async () => {
    const bench = await start();
    bench.ageAuthentication();
    expect((await bench.owner.get<TerminalCapability>('/api/terminal/capability')).body).toMatchObject({ available: true, needsReauth: true });
    const refused = await bench.owner.post('/api/terminal/sessions', { projectId: bench.project.id });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ error: { code: 'reauth_required' } });
    expect(bench.t.studio.context.services.terminal.liveSessionCount).toBe(0);

    expect((await bench.owner.post('/api/auth/reauth', { password: TEST_PASSWORD })).status).toBe(200);
    const session = await bench.create();

    // Much later, the phone comes back: attaching to its own terminal just works …
    bench.ageAuthentication();
    expect((await sessionOf(bench.owner, session.id)).body.attachable).toBe(true);
    const terminal = await bench.attach(session);
    expect(await run(terminal, 'echo back-$((1 + 1))')).toBe('back-2');
    expect((await bench.owner.post(`/api/terminal/sessions/${session.id}/input`, { text: 'true' })).status).toBe(200);
    terminal.type('\r');
    // … and a browser that holds a live terminal may open another.
    expect((await bench.owner.get<TerminalCapability>('/api/terminal/capability')).body.needsReauth).toBe(false);
    await bench.create();

    // Another browser of the same user, signed in long ago, must prove itself before it can join.
    const tablet = await bench.t.signIn('owner');
    bench.ageAuthentication();
    expect((await sessionOf(tablet, session.id)).body.attachable).toBe(false);
    const blocked = await bench.connect(session, { client: tablet });
    expect(await blocked.next('error')).toMatchObject({ code: 'reauth_required' });
    expect((await blocked.closed).code).toBe(TERMINAL_CLOSE_CODES.reauthRequired);
    expect(blocked.bytes().length).toBe(0);
    expect((await tablet.post(`/api/terminal/sessions/${session.id}/input`, { text: 'id' })).body).toMatchObject({ error: { code: 'reauth_required' } });
    expect((await tablet.post('/api/terminal/sessions', { projectId: bench.project.id })).body).toMatchObject({ error: { code: 'reauth_required' } });

    expect((await tablet.post('/api/auth/reauth', { password: TEST_PASSWORD })).status).toBe(200);
    const joined = await bench.attach(session, { client: tablet });
    expect(await run(joined, 'echo joined-$((2 + 2))')).toBe('joined-4');
    await joined.close();
    // Once admitted it is not asked again for this terminal.
    bench.ageAuthentication();
    expect((await sessionOf(tablet, session.id)).body.attachable).toBe(true);
    const again = await bench.attach(session, { client: tablet });
    expect(again.attached.session.id).toBe(session.id);

    // When its terminals are gone, the next one needs a fresh proof again.
    for (const open of (await bench.owner.get<TerminalSessionList>('/api/terminal/sessions')).body.sessions) {
      await bench.owner.delete(`/api/terminal/sessions/${open.id}`);
    }
    expect((await bench.owner.post('/api/terminal/sessions', { projectId: bench.project.id })).body).toMatchObject({ error: { code: 'reauth_required' } });
  });

  it('closes the socket the moment the browser session is signed out', async () => {
    const bench = await start();
    const session = await bench.create();
    const pid = bench.pidOf(session);
    const terminal = await bench.attach(session);
    expect(await run(terminal, 'KEEP=through-sign-out; echo ok')).toBe('ok');

    const before = Date.now();
    expect((await bench.owner.post('/api/auth/logout')).status).toBe(204);
    expect((await terminal.closed).code).toBe(TERMINAL_CLOSE_CODES.authEnded);
    expect(Date.now() - before).toBeLessThan(1000);
    await expect(bench.connect(session)).rejects.toThrow('HTTP 401');

    // The shell itself is not lost: after signing in again the user finds it as it was.
    expect(processIsRunning(pid)).toBe(true);
    const back = await bench.t.signIn('owner');
    expect((await sessionOf(back, session.id)).body).toMatchObject({ alive: true, attachable: true });
    const again = await bench.attach(session, { client: back });
    expect(await run(again, 'echo $KEEP')).toBe('through-sign-out');
  });

  it('closes every socket of the account on "sign out everywhere"', async () => {
    const bench = await start();
    const session = await bench.create();
    const laptop = await bench.attach(session);
    const phoneClient = await bench.t.signIn('owner');
    const phone = await bench.attach(session, { client: phoneClient });

    expect((await phoneClient.post('/api/auth/logout-everywhere')).status).toBe(204);
    expect((await laptop.closed).code).toBe(TERMINAL_CLOSE_CODES.authEnded);
    expect((await phone.closed).code).toBe(TERMINAL_CLOSE_CODES.authEnded);
    await expect(bench.connect(session)).rejects.toThrow('HTTP 401');
    await expect(bench.connect(session, { client: phoneClient })).rejects.toThrow('HTTP 401');
    expect((await bench.owner.get('/api/terminal/sessions')).status).toBe(401);
  });

  it('ends the terminals of an account that stops being an owner', async () => {
    const bench = await start();
    const second = await bench.secondOwner();
    const demoted = await bench.create({}, second);
    const demotedPid = bench.pidOf(demoted, second);
    const terminal = await bench.attach(demoted, { client: second });
    const kept = await bench.create();

    expect((await bench.owner.patch(`/api/users/${second.userId}`, { role: 'member' })).status).toBe(200);
    expect((await terminal.closed).code).toBe(TERMINAL_CLOSE_CODES.authEnded);
    await waitUntil(() => !processIsRunning(demotedPid), 3000, "the demoted account's shell to be ended");
    // The other owner's terminal is unaffected.
    expect((await sessionOf(bench.owner, kept.id)).body.alive).toBe(true);

    // The same when an account is deleted outright.
    const third = await bench.owner.post<{ id: string }>('/api/users', { username: 'third', password: TEST_PASSWORD, role: 'owner' });
    const thirdClient = await bench.t.signIn('third');
    const doomed = await bench.create({}, thirdClient);
    const doomedPid = bench.pidOf(doomed, thirdClient);
    expect((await bench.owner.delete(`/api/users/${third.body.id}`)).status).toBe(204);
    await waitUntil(() => !processIsRunning(doomedPid), 3000, "the deleted account's shell to be ended");
  });

  it('drops a client that stops answering pings, and one whose browser session has expired', async () => {
    const bench = await start({ terminal: { limits: { heartbeatMs: 150 } } });
    const session = await bench.create();
    const healthy = await bench.attach(session);
    const deaf = await bench.attach(session, { autoPong: false });
    expect(healthy.attached.limits.heartbeatMs).toBe(150);
    expect((await deaf.closed).code).toBe(1006);
    await pause(400);
    expect(await run(healthy, 'echo still-here-$((4 + 4))')).toBe('still-here-8');

    // A connection must not outlive the browser session that opened it.
    const state = await bench.owner.get<AuthState>('/api/auth/state');
    bench.t.studio.context.db.run('UPDATE auth_sessions SET expires_at = ? WHERE id = ?', Date.now() - 1000, state.body.session!.id);
    expect((await healthy.closed).code).toBe(TERMINAL_CLOSE_CODES.authEnded);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('a server where terminals cannot be used', () => {
  it('says so, and refuses everything, when the operator turned them off', async () => {
    const bench = await start({ config: { terminalEnabled: false } });
    expect((await bench.owner.get<TerminalCapability>('/api/terminal/capability')).body).toMatchObject({
      available: false,
      reason: { code: 'disabled' },
      launchers: [],
    });
    const base = `/api/terminal/sessions/${MISSING_ID}`;
    for (const response of [
      await bench.owner.get('/api/terminal/sessions'),
      await bench.owner.post('/api/terminal/sessions', { projectId: bench.project.id }),
      await bench.owner.get(base),
      await bench.owner.patch(base, { title: 'x' }),
      await bench.owner.post(`${base}/input`, { text: 'id' }),
      await bench.owner.delete(base),
    ]) {
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ error: { code: 'terminal_disabled' } });
    }
    const connection = await bench.connect(MISSING_ID);
    expect(await connection.next('error')).toMatchObject({ code: 'terminal_disabled' });
    expect((await connection.closed).code).toBe(TERMINAL_CLOSE_CODES.unavailable);
    expect(bench.t.studio.context.services.terminal.liveSessionCount).toBe(0);
    // The rest of the server is unaffected.
    expect((await bench.owner.get(`/api/projects/${bench.project.id}`)).status).toBe(200);
  });

  it('says why when the pseudo-terminal library is missing, and keeps everything else working', async () => {
    const bench = await start({
      terminal: { loadPty: () => Promise.resolve({ available: false, reason: 'The pseudo-terminal library could not be loaded (not installed).' }) },
    });
    expect((await bench.owner.get<TerminalCapability>('/api/terminal/capability')).body).toMatchObject({
      available: false,
      reason: { code: 'pty_unavailable', message: expect.stringContaining('not installed') },
    });
    const refused = await bench.owner.post('/api/terminal/sessions', { projectId: bench.project.id });
    expect(refused.status).toBe(503);
    expect(refused.body).toMatchObject({ error: { code: 'terminal_unavailable' } });
    expect((await bench.owner.get<TerminalSessionList>('/api/terminal/sessions')).body).toEqual({ sessions: [] });
    expect((await bench.owner.get(`/api/projects/${bench.project.id}`)).status).toBe(200);
    expect((await bench.owner.get('/api/health')).status).toBe(200);
  });
});
