import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Realtime } from './support/realtime.js';
import type { ApiClient, RunningStudio } from './support/studio.js';
import {
  assistantText,
  createProject,
  createSession,
  getRun,
  newRequestId,
  postMessage,
  runEnded,
  runToEnd,
  sandboxIsOn,
  SANDBOX_OFF,
  send,
  startAgentStudio,
  transcript,
  type ErrorBody,
  type Json,
  type Project,
  type Receipt,
} from './support/workbench.js';

/**
 * 6.1 — Sending and delivery (requirements 01 §6.1, §5.4), driven through the
 * real Claude Code and Codex adapters against the stand-in CLIs.
 *
 * A send carries a client-made request id. The server stores the message and
 * answers with a receipt (HTTP 202) before the agent has produced anything;
 * the same id again returns the same receipt flagged `duplicate` (HTTP 200)
 * and never runs twice; `GET …/messages/:requestId` is the delivery check.
 *
 * Deliberate difference: a busy session queues by default instead of refusing.
 * The predecessor's "busy, nothing stored" is what `whenBusy: 'reject'` gives.
 */
describe('6.1 sending and delivery', () => {
  let studio: RunningStudio;
  let owner: ApiClient;
  let project: Project;
  let other: Project;

  beforeAll(async () => {
    studio = await startAgentStudio();
    owner = await studio.owner();
    project = await createProject(studio, owner, 'sending');
    other = await createProject(studio, owner, 'elsewhere');
  });
  afterAll(() => studio?.destroy());

  it('AT-WB-001 (adapted): the first message is recorded at once, names the session after its first four words, and the reply follows it', async () => {
    const session = await createSession(owner, project.id);
    expect(session.titleSource).toBe('default');
    const receipt = await send(owner, session.id, 'fix the login bug please now thanks');
    expect(receipt.disposition).toBe('run');
    await runEnded(owner, receipt.runId!);

    const after = (await owner.get<Json>(`/api/sessions/${session.id}`)).body;
    expect(after.id).toBe(session.id); // the id issued before the first message never changes
    expect(after.titleSource).toBe('auto');
    expect(after.title).toBe('fix the login bug'); // the first four words

    const events = await transcript(owner, session.id);
    expect(events[0]).toMatchObject({
      seq: 1,
      type: 'message.user',
      data: { text: 'fix the login bug please now thanks', origin: 'interactive' },
    });
    const reply = events.find((event) => event.type === 'message.assistant');
    expect(reply, 'the agent replied').toBeDefined();
    expect(reply!.seq).toBeGreaterThan(1);
    // The project's history lists it.
    const list = await owner.get<{ sessions: Array<{ id: string }> }>(
      `/api/sessions?projectId=${project.id}`,
    );
    expect(list.body.sessions.map((row) => row.id)).toContain(session.id);
  });

  it('WB-011: the receipt is durable and arrives before the agent has produced anything', async () => {
    const session = await createSession(owner, project.id);
    const live = await Realtime.open(studio, owner);
    await live.subscribe(`session:${session.id}`);
    const requestId = newRequestId();
    const response = await owner.post<Receipt>(`/api/sessions/${session.id}/messages`, {
      requestId,
      text: 'hello [[scenario:long 5]]',
    });
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      requestId,
      sessionId: session.id,
      disposition: 'run',
      duplicate: false,
      queueItemId: null,
    });
    expect(['accepted', 'running']).toContain(response.body.run!.status);
    // The receipt can be read back at once, whatever the run is doing.
    const check = await owner.get<Receipt>(`/api/sessions/${session.id}/messages/${requestId}`);
    expect(check.status).toBe(200);
    expect(check.body.runId).toBe(response.body.runId);

    // On the live stream the stored user message is the first event; the agent's output comes after it.
    const topic = `session:${session.id}`;
    await live.event(topic, 'run.finished');
    const numbered = live.durable(topic);
    expect(numbered[0]).toMatchObject({ type: 'message.user', seq: 1, data: { requestId } });
    expect(numbered[1]).toMatchObject({ type: 'run.started', seq: 2 });
    const firstOutput = live
      .events(topic)
      .findIndex((frame) => frame.type === 'message.delta' || frame.type === 'message.assistant');
    const userAt = live.events(topic).findIndex((frame) => frame.type === 'message.user');
    expect(userAt).toBeGreaterThanOrEqual(0);
    expect(firstOutput).toBeGreaterThan(userAt);
    await live.close();
  });

  it('AT-WB-004/005: the same request id again returns the same run flagged duplicate, and the agent is not invoked a second time', async () => {
    const session = await createSession(owner, project.id);
    const body = { requestId: newRequestId(), text: 'only once please' };
    const [first, second] = await Promise.all([
      owner.post<Receipt>(`/api/sessions/${session.id}/messages`, body),
      owner.post<Receipt>(`/api/sessions/${session.id}/messages`, body),
    ]);
    // A double tap: one of the two started the run, the other is told it was a duplicate.
    expect([first.status, second.status].sort()).toEqual([200, 202]);
    expect(first.body.runId).toBe(second.body.runId);
    expect([first.body.duplicate, second.body.duplicate].sort()).toEqual([false, true]);
    await runEnded(owner, first.body.runId!);

    // Again after the run has ended: still the same receipt, now with the finished run.
    const third = await owner.post<Receipt>(`/api/sessions/${session.id}/messages`, body);
    expect(third.status).toBe(200);
    expect(third.body).toMatchObject({
      duplicate: true,
      runId: first.body.runId,
      run: { status: 'completed' },
    });

    const events = await transcript(owner, session.id);
    expect(events.filter((event) => event.type === 'message.user')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'run.started')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'run.finished')).toHaveLength(1);
    const runs = await owner.get<{ runs: unknown[] }>(
      `/api/runs?state=all&sessionId=${session.id}`,
    );
    expect(runs.body.runs).toHaveLength(1);
  });

  it('AT-WB-006: a used request id with different text is refused as a conflict and nothing runs', async () => {
    const session = await createSession(owner, project.id);
    const requestId = newRequestId();
    const first = await owner.post<Receipt>(`/api/sessions/${session.id}/messages`, {
      requestId,
      text: 'the original text',
    });
    expect(first.status).toBe(202);
    await runEnded(owner, first.body.runId!);
    const conflict = await owner.post<ErrorBody>(`/api/sessions/${session.id}/messages`, {
      requestId,
      text: 'something else entirely',
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('request_conflict');
    const events = await transcript(owner, session.id);
    expect(events.filter((event) => event.type === 'message.user')).toHaveLength(1);
    expect(events.some((event) => JSON.stringify(event).includes('something else entirely'))).toBe(
      false,
    );
  });

  it('AT-WB-008/009/011 (adapted): the delivery check tells an accepted send from one the server never received', async () => {
    const session = await createSession(owner, project.id);
    const accepted = await send(owner, session.id, 'did this arrive?');
    const lookup = await owner.get<Receipt>(
      `/api/sessions/${session.id}/messages/${accepted.requestId}`,
    );
    expect(lookup.status).toBe(200);
    expect(lookup.body).toMatchObject({ requestId: accepted.requestId, runId: accepted.runId });

    // A request id the server never saw: "not received" — only then may the original be sent again.
    const lost = newRequestId();
    const unknown = await owner.get<ErrorBody>(`/api/sessions/${session.id}/messages/${lost}`);
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('receipt_not_found');
    await runEnded(owner, accepted.runId!);
    // Retrying the original with its original id is then a normal first send.
    const retried = await owner.post<Receipt>(`/api/sessions/${session.id}/messages`, {
      requestId: lost,
      text: 'the original text',
    });
    expect(retried.status).toBe(202);
    expect(retried.body.duplicate).toBe(false);
    await runEnded(owner, retried.body.runId!);
    // Checking never sends anything: two sends, two user turns.
    const events = await transcript(owner, session.id);
    expect(
      events.filter((event) => event.type === 'message.user').map((event) => event.data.text),
    ).toEqual(['did this arrive?', 'the original text']);
  });

  it('AT-WB-013 (adapted): a send that asks not to queue is refused as busy while a run is in progress; nothing is stored and the run is unaffected', async () => {
    const session = await createSession(owner, project.id);
    const running = await send(owner, session.id, 'work for a while [[scenario:long 60]]');
    const secondDevice = await studio.owner();
    const requestId = newRequestId();
    const refused = await secondDevice.post<ErrorBody>(`/api/sessions/${session.id}/messages`, {
      requestId,
      text: 'barging in',
      whenBusy: 'reject',
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('session_busy');
    expect((await owner.get(`/api/sessions/${session.id}/messages/${requestId}`)).status).toBe(404);
    expect(
      (await owner.get<{ queue: unknown[] }>(`/api/sessions/${session.id}/queue`)).body.queue,
    ).toEqual([]);
    const run = await runEnded(owner, running.runId!);
    expect(run.status).toBe('completed');
    const events = await transcript(owner, session.id);
    expect(events.filter((event) => event.type === 'message.user')).toHaveLength(1);
  });

  it('AT-WB-014: a send to a session that does not exist is refused and no run starts', async () => {
    const missing = '0123456789abcdefghjkmnpqrs';
    const response = await postMessage(owner, missing, 'anyone there?');
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('session_not_found');
    expect((await owner.get<{ runs: unknown[] }>('/api/runs?state=active')).body.runs).toEqual([]);
  });

  it('WB-010: an empty message, or one past the length limit, is refused and nothing is recorded', async () => {
    const session = await createSession(owner, project.id);
    expect((await postMessage(owner, session.id, '   ')).status).toBe(400);
    expect((await postMessage(owner, session.id, 'x'.repeat(100_001))).status).toBe(400);
    expect(
      (await owner.post(`/api/sessions/${session.id}/messages`, { text: 'no request id' })).status,
    ).toBe(400);
    expect(await transcript(owner, session.id)).toEqual([]);
  });

  it('AT-WB-021 (adapted): a quote goes out above the message it was sent with, and not with the next one', async () => {
    const session = await createSession(owner, project.id);
    const quoted = await runToEnd(owner, session.id, 'why? [[scenario:echo-prompt]]', {
      quote: 'the cache is rebuilt on every request',
    });
    const prompt = await assistantText(owner, session.id, quoted.id);
    expect(prompt).toContain('the cache is rebuilt on every request');
    expect(prompt.indexOf('the cache is rebuilt on every request')).toBeLessThan(
      prompt.indexOf('why?'),
    );
    const next = await runToEnd(owner, session.id, 'and then? [[scenario:echo-prompt]]');
    expect(await assistantText(owner, session.id, next.id)).not.toContain('the cache is rebuilt');
    const users = (await transcript(owner, session.id)).filter(
      (event) => event.type === 'message.user',
    );
    expect(users.map((event) => event.data.quote)).toEqual([
      'the cache is rebuilt on every request',
      null,
    ]);
  });

  it('AT-WB-140: a send that names another working folder still runs in the folder of the session’s project', async () => {
    const session = await createSession(owner, project.id);
    const response = await owner.post<Json>(`/api/sessions/${session.id}/messages`, {
      requestId: newRequestId(),
      text: 'where are you? [[scenario:inspect]]',
      cwd: other.rootDir,
      rootDir: other.rootDir,
      projectId: other.id,
      workingDirectory: other.rootDir,
    });
    // The fields are not part of a send: they are ignored, never honoured.
    expect(response.status).toBe(202);
    const run = await runEnded(owner, response.body.runId);
    expect(run.status).toBe('completed');
    const report = await assistantText(owner, session.id, run.id);
    expect(report).toContain(project.rootDir);
    expect(report).not.toContain(other.rootDir);
    expect((await owner.get<Json>(`/api/sessions/${session.id}`)).body.projectId).toBe(project.id);
  });

  it('AT-WB-153: one session per offered agent, both run in the project’s folder and share its single history', async (context) => {
    if (!(await sandboxIsOn(owner))) return context.skip(SANDBOX_OFF);
    const shared = await createProject(studio, owner, 'both-agents');
    const claude = await createSession(owner, shared.id, 'claude-code');
    const codex = await createSession(owner, shared.id, 'codex');
    const claudeRun = await runToEnd(owner, claude.id, 'where are you? [[scenario:inspect]]');
    const codexRun = await runToEnd(owner, codex.id, 'where are you? [[scenario:inspect]]');
    expect(claudeRun.status).toBe('completed');
    expect(codexRun.status).toBe('completed');
    expect(await assistantText(owner, claude.id)).toContain(shared.rootDir);
    expect(await assistantText(owner, codex.id)).toContain(shared.rootDir);
    const list = await owner.get<{ sessions: Array<{ id: string; agentId: string }> }>(
      `/api/sessions?projectId=${shared.id}`,
    );
    expect(list.body.sessions.map((row) => row.agentId).sort()).toEqual(['claude-code', 'codex']);
  });

  it('AT-WB-162: the agent’s own conversation id is available once a run has completed, refused before, and the session’s id never changes', async () => {
    const session = await createSession(owner, project.id);
    const before = await owner.get<ErrorBody>(`/api/sessions/${session.id}/native-id`);
    expect(before.status).toBeGreaterThanOrEqual(400);
    expect(before.status).toBeLessThan(500);
    expect(session.resumable).toBe(false);
    await runToEnd(owner, session.id, 'say something');
    const after = await owner.get<{ nativeSessionId: string }>(
      `/api/sessions/${session.id}/native-id`,
    );
    expect(after.status).toBe(200);
    expect(after.body.nativeSessionId.length).toBeGreaterThan(8);
    const reread = (await owner.get<Json>(`/api/sessions/${session.id}`)).body;
    expect(reread.id).toBe(session.id);
    expect(reread.resumable).toBe(true);
    // AT-WB-101: a link that uses the agent's own id resolves to the same session.
    const byNative = await owner.get<Json>(`/api/sessions/${after.body.nativeSessionId}`);
    expect(byNative.status).toBe(200);
    expect(byNative.body.id).toBe(session.id);
  });

  it('AT-WB-089: a send to an agent that is not signed in ends with one readable failure and leaves the session idle', async () => {
    const session = await createSession(owner, project.id);
    const run = await runToEnd(owner, session.id, 'hello [[scenario:not-signed-in]]');
    expect(run.status).toBe('failed');
    expect(run.error).toMatchObject({ code: 'not_signed_in' });
    expect(run.error!.message.length).toBeGreaterThan(10);
    const events = await transcript(owner, session.id);
    const finished = events.filter((event) => event.type === 'run.finished');
    expect(finished).toHaveLength(1);
    expect(finished[0]!.data).toMatchObject({ status: 'failed', error: { code: 'not_signed_in' } });
    const after = (await owner.get<Json>(`/api/sessions/${session.id}`)).body;
    expect(after.activeRunId).toBeNull();
    expect(after.attention).toBe('needs-you'); // a failure is never marked read by itself
    // Idle: the next message starts a new run at once.
    const next = await send(owner, session.id, 'are you back?');
    expect(next.disposition).toBe('run');
    await runEnded(owner, next.runId!);
  });

  it('AT-WB-089 (Codex): the same promise holds for the other agent', async (context) => {
    if (!(await sandboxIsOn(owner))) return context.skip(SANDBOX_OFF);
    const session = await createSession(owner, project.id, 'codex');
    const run = await runToEnd(owner, session.id, 'hello [[scenario:not-signed-in]]');
    expect(run.status).toBe('failed');
    expect(run.error!.code).toBe('not_signed_in');
    const finished = (await transcript(owner, session.id)).filter(
      (event) => event.type === 'run.finished',
    );
    expect(finished).toHaveLength(1);
    expect((await owner.get<Json>(`/api/sessions/${session.id}`)).body.activeRunId).toBeNull();
  });

  it('WB-152: a crash of the agent is one failed run with a bounded, redacted reason — never the raw error stream', async () => {
    const session = await createSession(owner, project.id);
    const run = await runToEnd(owner, session.id, 'hello [[scenario:crash]]');
    expect(run.status).toBe('failed');
    expect(run.error!.code).toBeTruthy();
    const everything =
      JSON.stringify(await transcript(owner, session.id)) +
      JSON.stringify(await getRun(owner, run.id));
    expect(everything).not.toContain('ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'); // the secret-looking string the stand-in prints as it dies
    expect(
      (await transcript(owner, session.id)).filter((event) => event.type === 'run.finished'),
    ).toHaveLength(1);
  });
});
