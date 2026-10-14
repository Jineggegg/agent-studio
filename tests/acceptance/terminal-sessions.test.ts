import { existsSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { until, within } from './support/realtime.js';
import { SETUP_TOKEN, type ApiClient, type RunningStudio } from './support/studio.js';
import { TerminalClient, terminalHandshake } from './support/terminal.js';
import {
  createMember,
  createProject,
  shareProject,
  startAgentStudio,
  type ErrorBody,
  type Json,
  type Project,
} from './support/workbench.js';

/**
 * 6.9 — Terminal (requirements 02 §6.9, §7.3).
 *
 * Deliberate differences this file is written for: the terminal is the
 * owner's alone, from a signed-in browser only; it always starts the login
 * shell in a project's folder and no client can name a program or a path.
 *
 * Real shells in real pseudo-terminals over real WebSockets. Every test that
 * starts a shell closes it, and the last test checks from the process table
 * that none is left.
 *
 * Not testable from outside: creating needs a sign-in no older than fifteen
 * minutes (a fixed window; a fresh sign-in always has one) and the idle
 * expiry after thirty minutes (AT-PJ-137) — both need a clock.
 */
describe('6.9 terminal', () => {
  let studio: RunningStudio;
  let owner: ApiClient;
  let project: Project;
  let second: Project;
  let available = false;
  let reason = '';
  const shells: number[] = [];

  beforeAll(async () => {
    studio = await startAgentStudio();
    owner = await studio.owner();
    project = await createProject(studio, owner, 'terminal-one');
    second = await createProject(studio, owner, 'terminal-two');
    const capability = (await owner.get<Json>('/api/terminal/capability')).body;
    available = capability.available === true;
    reason = `skipped: the terminal is not available on this machine (${capability.reason?.code ?? 'unknown'}: ${capability.reason?.message ?? ''})`;
  });
  afterAll(() => studio?.destroy());

  const open = async (target: Project = project, client: ApiClient = owner) => {
    const created = await client.post<Json>('/api/terminal/sessions', { projectId: target.id });
    if (created.status !== 201)
      throw new Error(
        `Could not open a terminal: ${created.status} ${JSON.stringify(created.body)}`,
      );
    return created.body as {
      id: string;
      directory: string;
      projectId: string;
      alive: boolean;
      attachable: boolean;
    };
  };
  const shut = (id: string, client: ApiClient = owner) =>
    client.delete<Json>(`/api/terminal/sessions/${id}`);
  /** Asks the shell for its process id by having it write the id into the project folder. */
  async function shellPid(terminal: TerminalClient, folder: string): Promise<number> {
    const file = path.join(folder, `.pid-${Math.random().toString(36).slice(2)}`);
    terminal.run(`echo $$ > ${file}`);
    const pid = Number(
      await until(
        () =>
          existsSync(file) && readFileSync(file, 'utf8').trim() !== ''
            ? readFileSync(file, 'utf8').trim()
            : undefined,
        { what: 'the shell to report its process id' },
      ),
    );
    await rm(file);
    shells.push(pid);
    return pid;
  }

  it('the owner’s browser is told the terminal can be used; a member and an API token are told why not', async (context) => {
    if (!available) return context.skip(reason);
    const capability = (await owner.get<Json>('/api/terminal/capability')).body;
    expect(capability).toMatchObject({ available: true, reason: null, needsReauth: false });
    expect(capability.shell.length).toBeGreaterThan(0);
    const member = await createMember(studio, owner, 'termmember');
    expect((await member.get<Json>('/api/terminal/capability')).body).toMatchObject({
      available: false,
      reason: { code: 'owner_only' },
    });
    const token = await owner.post<{ token: string }>('/api/auth/tokens', {
      name: 'terminal-probe',
      scopes: ['read', 'write', 'admin'],
    });
    const robot = studio.client();
    robot.bearer = token.body.token;
    expect((await robot.get<Json>('/api/terminal/capability')).body).toMatchObject({
      available: false,
      reason: { code: 'session_required' },
    });
  });

  it('AT-PJ-135: a terminal opened for a project starts in that project’s folder, and what is typed is run by the shell', async (context) => {
    if (!available) return context.skip(reason);
    const session = await open();
    expect(session).toMatchObject({
      projectId: project.id,
      directory: project.rootDir,
      alive: true,
      attachable: true,
    });
    const terminal = await TerminalClient.attach(studio, owner, session.id);
    expect(terminal.attached.session).toMatchObject({ id: session.id, directory: project.rootDir });
    await shellPid(terminal, project.rootDir);

    const from = terminal.output.length;
    terminal.run('printf "CWD=%s=END\\n" "$(pwd)"');
    const printed = await terminal.expectOutput(/CWD=\/[^=\n]*=END/, { from });
    expect(printed).toContain(`CWD=${project.rootDir}=END`);
    // Echo: arithmetic proves the shell evaluated the line rather than the server repeating it.
    terminal.run('echo "SUM-$((40 + 2))"');
    await terminal.expectOutput('SUM-42', { from });
    // It is listed as one of the owner's terminals, with a client attached.
    const listed = (
      await owner.get<{ sessions: Json[] }>(`/api/terminal/sessions?projectId=${project.id}`)
    ).body.sessions;
    expect(listed.find((item) => item.id === session.id)).toMatchObject({
      alive: true,
      attachedClients: 1,
    });
    await terminal.close();
    expect((await shut(session.id)).body).toEqual({ closed: true, remainingProcesses: 0 });
  });

  it('AT-PJ-138: resizing the terminal is seen by the shell at once', async (context) => {
    if (!available) return context.skip(reason);
    const session = await open();
    const terminal = await TerminalClient.attach(studio, owner, session.id, { cols: 80, rows: 24 });
    await shellPid(terminal, project.rootDir);
    let from = terminal.output.length;
    terminal.run('echo "SIZE=$(stty size)=END"');
    await terminal.expectOutput('SIZE=24 80=END', { from });
    terminal.sendControl({ type: 'resize', cols: 132, rows: 41 });
    await terminal.until(
      () =>
        terminal.controls.some(
          (frame) => frame.type === 'resize' && frame.cols === 132 && frame.rows === 41,
        ),
      'the resize to be confirmed',
      1000,
    );
    from = terminal.output.length;
    terminal.run('echo "SIZE=$(stty size)=END"');
    await terminal.expectOutput('SIZE=41 132=END', { from });
    expect((await owner.get<Json>(`/api/terminal/sessions/${session.id}`)).body).toMatchObject({
      cols: 132,
      rows: 41,
    });
    // A size outside the allowed range is not passed on to the shell.
    terminal.sendControl({ type: 'resize', cols: 100_000, rows: 0 });
    from = terminal.output.length;
    terminal.run('echo "SIZE=$(stty size)=END"');
    const stillOpen = await terminal.expectOutput(/SIZE=\d+ \d+=END/, { from }).then(
      () => true,
      () => false,
    );
    if (stillOpen) expect(terminal.output.slice(from)).toContain('SIZE=41 132=END');
    else expect(terminal.closeCode).toBe(4400);
    await terminal.close();
    await shut(session.id);
  });

  it('AT-PJ-136: the shell lives on while the browser is away — on return the missed output is replayed without gaps, the work went on, and the shell’s state is intact', async (context) => {
    if (!available) return context.skip(reason);
    const session = await open();
    const first = await TerminalClient.attach(studio, owner, session.id);
    const pid = await shellPid(first, project.rootDir);
    first.run('KEPT=still-here-$((6 * 7))');
    first.run('echo "BEFORE-$((1 + 1))"');
    await first.expectOutput('BEFORE-2');
    // Start something that keeps printing, then let the browser go away mid-way.
    first.run(
      'for i in 1 2 3 4 5 6; do echo "TICK-$((i * 11))"; sleep 0.3; done; echo "LOOP-$((50 + 5))"',
    );
    await first.expectOutput('TICK-11');
    const reached = first.seq;
    const seenBefore = first.output;
    await first.close();
    expect(existsSync(`/proc/${pid}`)).toBe(true); // nobody attached, and the shell is still there
    await until(
      async () =>
        (await owner.get<Json>(`/api/terminal/sessions/${session.id}`)).body.seq > reached + 20,
      { what: 'the shell to keep printing while detached' },
    );
    expect((await owner.get<Json>(`/api/terminal/sessions/${session.id}`)).body).toMatchObject({
      alive: true,
      attachedClients: 0,
    });

    // Back, saying where it had got to: exactly the missed bytes arrive, then the live output.
    const back = await TerminalClient.attach(studio, owner, session.id, { after: reached });
    expect(back.attached.replay).toMatchObject({ mode: 'delta', from: reached, truncated: false });
    await back.expectOutput('LOOP-55');
    const whole = seenBefore + back.output;
    for (const tick of ['TICK-11', 'TICK-22', 'TICK-33', 'TICK-44', 'TICK-55', 'TICK-66']) {
      expect(
        whole.split(`${tick}\r\n`).length - 1,
        `${tick} printed once across the two connections`,
      ).toBe(1);
    }
    // The variable set before the break is still set.
    const from = back.output.length;
    back.run('echo "VALUE=$KEPT=END"');
    await back.expectOutput('VALUE=still-here-42=END', { from });
    expect((await owner.get<Json>(`/api/terminal/sessions/${session.id}`)).body.seq).toBe(back.seq);
    await back.close();

    // A client that has seen nothing gets the whole buffer and is told to start afresh.
    const fresh = await TerminalClient.attach(studio, owner, session.id);
    expect(fresh.attached.replay).toMatchObject({ mode: 'full', from: 0 });
    expect(fresh.output).toContain('BEFORE-2');
    expect(fresh.output).toContain('LOOP-55');
    await fresh.close();
    await shut(session.id);
  });

  it('AT-PJ-152: terminals of two projects are independent — each in its own folder, a variable set in one unknown to the other', async (context) => {
    if (!available) return context.skip(reason);
    const one = await open(project);
    const two = await open(second);
    const a = await TerminalClient.attach(studio, owner, one.id);
    const b = await TerminalClient.attach(studio, owner, two.id);
    await shellPid(a, project.rootDir);
    await shellPid(b, second.rootDir);
    a.run('ONLY_HERE=secret-of-one');
    a.run('echo "A=[$ONLY_HERE] in $(pwd) END"');
    b.run('echo "B=[$ONLY_HERE] in $(pwd) END"');
    await a.expectOutput(`A=[secret-of-one] in ${project.rootDir} END`);
    await b.expectOutput(`B=[] in ${second.rootDir} END`);
    expect(b.output).not.toContain('secret-of-one');
    await Promise.all([a.close(), b.close()]);
    await shut(one.id);
    await shut(two.id);
  });

  it('AT-PJ-144: the shell’s environment holds none of the Service’s own settings or secrets', async (context) => {
    if (!available) return context.skip(reason);
    const session = await open();
    const terminal = await TerminalClient.attach(studio, owner, session.id);
    await shellPid(terminal, project.rootDir);
    const dump = path.join(project.rootDir, 'environment.txt');
    terminal.run(`env > ${dump}; echo "DUMPED-$((20 + 3))"`);
    await terminal.expectOutput('DUMPED-23');
    const environment = readFileSync(dump, 'utf8');
    expect(environment).toContain('PATH=');
    expect(environment).not.toMatch(/^AGENT_STUDIO_/m);
    expect(environment).not.toContain(SETUP_TOKEN);
    expect(environment).not.toContain(studio.dataDir);
    expect(environment).not.toMatch(/MASTER_KEY|STUDIO_BRIDGE|TSX_TSCONFIG/);
    expect(environment).not.toContain(owner.cookie!.split('=')[1]!);
    await rm(dump);
    await terminal.close();
    await shut(session.id);
  });

  it('AT-PJ-147/149/150 (adapted): text sent for a "run" button is typed into the shell, not run — it waits for the user’s Enter; text of several lines is refused', async (context) => {
    if (!available) return context.skip(reason);
    const session = await open();
    const terminal = await TerminalClient.attach(studio, owner, session.id);
    await shellPid(terminal, project.rootDir);
    terminal.run('echo "READY-$((3 * 3))"');
    await terminal.expectOutput('READY-9');
    const from = terminal.output.length;
    const typed = await owner.post<Json>(`/api/terminal/sessions/${session.id}/input`, {
      text: 'echo "TYPED-$((5 + 5))"',
    });
    expect(typed.status).toBe(200);
    expect(typed.body.typed).toBe('echo "TYPED-$((5 + 5))"');
    await terminal.expectOutput('echo "TYPED-$((5 + 5))"', { from }); // it is on the command line …
    expect(terminal.output.slice(from)).not.toContain('TYPED-10'); // … and has not run
    terminal.type('\r'); // the user presses Enter
    await terminal.expectOutput('TYPED-10', { from });

    const twoLines = await owner.post<ErrorBody>(`/api/terminal/sessions/${session.id}/input`, {
      text: 'echo one\nrm -rf important',
    });
    expect(twoLines.status).toBe(400);
    expect(twoLines.body.error.code).toBe('multiline_text');
    // Control characters cannot be smuggled in to press Enter for the user.
    const marker = terminal.output.length;
    const sneaky = await owner.post<Json>(`/api/terminal/sessions/${session.id}/input`, {
      text: 'echo "SNEAK-$((7 + 7))"\u0003\u001b[A',
    });
    expect(sneaky.status).toBe(200);
    expect(sneaky.body.typed).toBe('echo "SNEAK-$((7 + 7))"[A');
    expect(sneaky.body.removed).toBeGreaterThan(0);
    await terminal.expectOutput('SNEAK-$((7 + 7))', { from: marker });
    expect(terminal.output.slice(marker)).not.toContain('SNEAK-14');
    await terminal.close();
    await shut(session.id);
  });

  it('AT-PJ-151 (adapted): a local development address printed in the terminal is announced once; the address of a public website is not', async (context) => {
    if (!available) return context.skip(reason);
    const session = await open();
    const terminal = await TerminalClient.attach(studio, owner, session.id);
    await shellPid(terminal, project.rootDir);
    terminal.run(
      'echo "see https://example.com/docs and then"; echo "Local:   http://local""host:5173/"; echo "URLS-$((9 + 9))"',
    );
    await terminal.expectOutput('URLS-18');
    await terminal.until(
      () => terminal.controls.some((frame) => frame.type === 'url'),
      'the local address to be announced',
    );
    const announced = terminal.controls
      .filter((frame) => frame.type === 'url')
      .map((frame) => frame.url);
    expect(announced).toEqual([
      { url: 'http://localhost:5173/', scheme: 'http', host: 'localhost', port: 5173 },
    ]);
    expect((await owner.get<Json>(`/api/terminal/sessions/${session.id}`)).body.urls).toEqual(
      announced,
    );
    await terminal.close();
    await shut(session.id);
  });

  it('AT-PJ-139: a terminal cannot be opened without a project, for an unknown project, or for one whose folder is gone — and a client can name neither a program nor a path', async (context) => {
    if (!available) return context.skip(reason);
    const before = (await owner.get<{ sessions: unknown[] }>('/api/terminal/sessions')).body
      .sessions.length;
    const none = await owner.post<ErrorBody>('/api/terminal/sessions', {});
    expect(none.status).toBe(400);
    expect(none.body.error.code).toBe('project_required');
    expect(
      (await owner.post('/api/terminal/sessions', { projectId: '0123456789abcdefghjkmnpqrs' }))
        .status,
    ).toBe(404);
    const vanished = await createProject(studio, owner, 'terminal-vanished');
    await rm(vanished.rootDir, { recursive: true });
    const missing = await owner.post<ErrorBody>('/api/terminal/sessions', {
      projectId: vanished.id,
    });
    expect(missing.status).toBe(409);
    expect(missing.body.error.code).toBe('project_folder_missing');
    for (const extra of [
      { command: 'bash -c "id"' },
      { shell: '/bin/sh' },
      { cwd: '/etc' },
      { directory: '/etc' },
      { args: ['-c', 'id'] },
      { env: { X: '1' } },
      { launcher: '../../bin/sh' },
      { launcher: 'no-such-launcher' },
    ]) {
      const refused = await owner.post<ErrorBody>('/api/terminal/sessions', {
        projectId: project.id,
        ...extra,
      });
      expect(refused.status, JSON.stringify(extra)).toBe(400);
    }
    expect(
      (await owner.get<{ sessions: unknown[] }>('/api/terminal/sessions')).body.sessions.length,
    ).toBe(before);
  });

  it('AT-PJ-176/179 (adapted): remote machines are exactly what the operator’s file lists — here none; an unknown host is "not found" without any connection attempt, and a client can name neither a host address nor an unsafe directory', async (context) => {
    if (!available) return context.skip(reason);
    const hosts = await owner.get<Json>('/api/remotes/hosts');
    expect(hosts.status).toBe(200);
    expect(hosts.body.hosts).toEqual([]);
    expect(hosts.body.configuration.status).toBe('missing');
    const unknown = await owner.get<ErrorBody>('/api/remotes/hosts/build-box/status');
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('remote_host_not_found');
    expect(
      (await owner.get('/api/remotes/hosts/..%2f..%2fetc/status')).status,
    ).toBeGreaterThanOrEqual(400);

    const before = (await owner.get<{ sessions: unknown[] }>('/api/terminal/sessions')).body
      .sessions.length;
    const notConfigured = await owner.post<ErrorBody>('/api/terminal/sessions', {
      projectId: project.id,
      launcher: 'remote-shell',
      remote: { hostId: 'build-box', directory: '/srv/app' },
    });
    expect(notConfigured.status, JSON.stringify(notConfigured.body)).toBe(404);
    expect(notConfigured.body.error.code).toBe('remote_host_not_found');
    for (const directory of [
      '/srv/my app',
      '/srv/app;id',
      "/srv/'quoted'",
      '/srv/$HOME',
      '/srv/`id`',
      '/srv/../etc',
      'relative/path',
      '/srv/-rf',
    ]) {
      const refused = await owner.post<ErrorBody>('/api/terminal/sessions', {
        projectId: project.id,
        launcher: 'remote-shell',
        remote: { hostId: 'build-box', directory },
      });
      expect(refused.status, directory).toBe(400);
    }
    for (const remote of [
      { hostId: 'build-box', host: 'attacker.example.test' },
      { hostId: 'user@attacker.example.test' },
      { hostId: 'build-box', command: 'id' },
      { hostId: '-oProxyCommand=id' },
      { directory: '/srv/app' },
    ]) {
      expect(
        (
          await owner.post('/api/terminal/sessions', {
            projectId: project.id,
            launcher: 'remote-shell',
            remote,
          })
        ).status,
        JSON.stringify(remote),
      ).toBe(400);
    }
    expect(
      (await owner.get<{ sessions: unknown[] }>('/api/terminal/sessions')).body.sessions.length,
    ).toBe(before);
    // Like everything about terminals, remote machines are the owner's.
    const member = await createMember(studio, owner, 'remoteguest');
    expect((await member.get('/api/remotes/hosts')).status).toBe(403);
    expect((await studio.client().get('/api/remotes/hosts')).status).toBe(401);
  });

  it('AT-PJ-140: the terminal channel is refused before any upgrade without a sign-in, with a tampered one, from another origin, for a member and for an API token — and an unknown session id opens nothing', async (context) => {
    if (!available) return context.skip(reason);
    const session = await open();
    const token = owner.cookie!.split('=')[1]!;
    expect(await terminalHandshake(studio, session.id, { origin: studio.url })).toBe('HTTP 401');
    expect(
      await terminalHandshake(studio, session.id, {
        origin: studio.url,
        cookie: `studio_session=${token.slice(0, -1)}Z`,
      }),
    ).toBe('HTTP 401');
    expect(
      await terminalHandshake(studio, session.id, {
        origin: 'https://evil.example',
        cookie: owner.cookie!,
      }),
    ).toBe('HTTP 403');
    const member = await createMember(studio, owner, 'termguest');
    await shareProject(owner, project.id, member.userId!, 'write');
    expect(
      await terminalHandshake(studio, session.id, { origin: studio.url, cookie: member.cookie! }),
    ).toBe('HTTP 403');
    const created = await owner.post<{ token: string }>('/api/auth/tokens', {
      name: 'terminal-token',
      scopes: ['read', 'write', 'admin'],
    });
    expect(
      await terminalHandshake(studio, session.id, {
        origin: studio.url,
        authorization: `Bearer ${created.body.token}`,
      }),
    ).toBe('HTTP 403');

    // The management routes say the same.
    const asMember = await member.post<ErrorBody>('/api/terminal/sessions', {
      projectId: project.id,
    });
    expect(asMember.status).toBe(403);
    expect(asMember.body.error.code).toBe('owner_required');
    const robot = studio.client();
    robot.bearer = created.body.token;
    for (const attempt of [
      robot.post('/api/terminal/sessions', { projectId: project.id }),
      robot.get('/api/terminal/sessions'),
      robot.post(`/api/terminal/sessions/${session.id}/input`, { text: 'id' }),
      robot.delete(`/api/terminal/sessions/${session.id}`),
    ]) {
      const refused = await attempt;
      expect(refused.status).toBe(403);
      expect((refused.body as ErrorBody).error.code).toBe('session_required');
    }
    // A session id that does not exist: the socket opens and is closed at once with "no such session".
    const nowhere = await TerminalClient.attach(studio, owner, '0123456789abcdefghjkmnpqrs').then(
      () => 'attached',
      (error: Error) => error.message,
    );
    expect(nowhere).toBe('closed 4404');
    // None of it disturbed the real session, which no one ever attached to.
    expect((await owner.get<Json>(`/api/terminal/sessions/${session.id}`)).body).toMatchObject({
      alive: true,
      attachedClients: 0,
    });
    await shut(session.id);
  });

  it('AT-PJ-141: signing out closes the terminal channel within seconds, and it cannot be opened again with the old sign-in — "sign out everywhere" from another device does the same', async (context) => {
    if (!available) return context.skip(reason);
    // One browser signs out by itself.
    const laptop = await studio.owner();
    const first = await open(project, laptop);
    const terminal = await TerminalClient.attach(studio, laptop, first.id);
    const pid = await shellPid(terminal, project.rootDir);
    expect((await laptop.post('/api/auth/logout')).status).toBe(204);
    expect(
      await within(terminal.closed, 5000, 'the terminal channel to close after sign-out'),
    ).toBe(4401);
    expect(
      await terminalHandshake(studio, first.id, {
        origin: studio.url,
        cookie: laptop.cookie ?? 'studio_session=gone',
      }),
    ).toBe('HTTP 401');

    // Sign out everywhere, pressed on another device.
    const desk = await studio.owner();
    const phone = await studio.owner();
    const second = await open(project, desk);
    const attached = await TerminalClient.attach(studio, desk, second.id);
    const oldCookie = desk.cookie!;
    expect((await phone.post('/api/auth/logout-everywhere')).status).toBe(204);
    expect(
      await within(
        attached.closed,
        5000,
        'the terminal channel to close after sign-out everywhere',
      ),
    ).toBe(4401);
    expect(
      await terminalHandshake(studio, second.id, { origin: studio.url, cookie: oldCookie }),
    ).toBe('HTTP 401');
    expect((await desk.get(`/api/terminal/sessions/${second.id}`)).status).toBe(401);
    // Signing in again does not hand the old shells to whoever signs in: the owner closes what is left.
    owner = await studio.owner();
    for (const leftover of (
      await owner.get<{ sessions: Array<{ id: string }> }>('/api/terminal/sessions')
    ).body.sessions)
      await shut(leftover.id);
    await until(() => !existsSync(`/proc/${pid}`), { what: 'the first shell to be gone' });
  });

  it('AT-PJ-143: one message larger than the channel allows closes that channel only — the Service stays up and the shell can be attached to again', async (context) => {
    if (!available) return context.skip(reason);
    const session = await open();
    const terminal = await TerminalClient.attach(studio, owner, session.id);
    await shellPid(terminal, project.rootDir);
    terminal.run('echo "ALIVE-$((2 + 2))"');
    await terminal.expectOutput('ALIVE-4');
    terminal.socket.send(Buffer.alloc(2 * 1024 * 1024, 0x61), { binary: true });
    expect(await within(terminal.closed, 5000, 'the oversized message to close the channel')).toBe(
      1009,
    );
    expect((await studio.client().get('/api/health')).status).toBe(200);
    const again = await TerminalClient.attach(studio, owner, session.id);
    const from = again.output.length;
    again.run('echo "BACK-$((8 + 8))"');
    await again.expectOutput('BACK-16', { from });
    // A frame that is not the agreed protocol also ends only that channel.
    again.sendControl({ type: 'run', command: 'id' });
    expect(await within(again.closed, 5000, 'the unknown control frame to close the channel')).toBe(
      4400,
    );
    await shut(session.id);
  });

  it('AT-PJ-142 (adapted): the number of live terminals is capped per account — past it a new one is refused, not an old one silently killed; closing one makes room', async (context) => {
    if (!available) return context.skip(reason);
    const limit = (await owner.get<Json>('/api/terminal/capability')).body.limits
      .maxSessionsPerUser as number | undefined;
    const cap = limit ?? 16;
    const opened: string[] = [];
    for (let index = 0; index < cap; index += 1) opened.push((await open()).id);
    const refused = await owner.post<ErrorBody>('/api/terminal/sessions', {
      projectId: project.id,
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('terminal_limit_reached');
    const alive = (
      await owner.get<{ sessions: Array<{ id: string; alive: boolean }> }>('/api/terminal/sessions')
    ).body.sessions.filter((item) => item.alive);
    expect(alive.map((item) => item.id).sort()).toEqual([...opened].sort()); // all of the old ones are still there
    expect((await shut(opened.pop()!)).body.closed).toBe(true);
    opened.push((await open()).id);
    for (const id of opened)
      expect((await shut(id)).body).toEqual({ closed: true, remainingProcesses: 0 });
  });

  it('closing a terminal ends its shell and everything the shell started — nothing is left running on the host', async (context) => {
    if (!available) return context.skip(reason);
    const session = await open();
    const terminal = await TerminalClient.attach(studio, owner, session.id);
    const pid = await shellPid(terminal, project.rootDir);
    const childFile = path.join(project.rootDir, '.child-pid');
    terminal.run(`sleep 300 & echo $! > ${childFile}; echo "STARTED-$((4 + 4))"`);
    await terminal.expectOutput('STARTED-8');
    const child = Number(readFileSync(childFile, 'utf8').trim());
    expect(existsSync(`/proc/${child}`)).toBe(true);
    const closed = await shut(session.id);
    expect(closed.body).toEqual({ closed: true, remainingProcesses: 0 });
    expect(existsSync(`/proc/${pid}`)).toBe(false);
    expect(existsSync(`/proc/${child}`)).toBe(false);
    // The attached client was told the session ended, then its channel closed.
    expect(await within(terminal.closed, 5000, 'the channel to close with the session')).toBe(4410);
    expect(terminal.control('exit')).toBeDefined();
    const after = await owner.get<Json>(`/api/terminal/sessions/${session.id}`);
    if (after.status === 200) expect(after.body.alive).toBe(false);
    const typing = await owner.post<ErrorBody>(`/api/terminal/sessions/${session.id}/input`, {
      text: 'echo too late',
    });
    expect([404, 409]).toContain(typing.status);
    await rm(childFile);
    // Every shell this file started is gone.
    for (const shell of shells)
      expect(existsSync(`/proc/${shell}`), `shell ${shell} is still running`).toBe(false);
  });
});
