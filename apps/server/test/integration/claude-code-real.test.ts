import { deflateSync } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Approval, Attachment, UploadAttachmentsResponse } from '@agent-studio/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ClaudeCodeAdapter } from '../../src/modules/claude-code/claude-code.module.js';
import { type AgentsKit, createAgentsKit, nextRequestId, until } from '../../src/testing/agents-kit.js';

/**
 * The manual smoke test against the **real** Claude Code CLI, the one that is
 * installed and signed in on this machine. It spends the account's quota
 * (four short turns on the smallest model), so it only runs when asked:
 *
 *   STUDIO_CLAUDE_SMOKE=1 npx vitest run --project server-integration apps/server/test/integration/claude-code-real.test.ts
 *
 * Optional: STUDIO_CLAUDE_SMOKE_DIR=<folder> keeps what went to and came from
 * the CLI, one file per step (it contains the conversation; do not commit it),
 * and STUDIO_CLAUDE_SMOKE_SANDBOX=off runs the CLI outside the sandbox.
 *
 * The project is a throw-away folder under the system's temporary directory.
 * What was observed with each CLI version is recorded in
 * `docs/guides/agent-smoke-test.md`.
 */

const enabled = process.env.STUDIO_CLAUDE_SMOKE === '1';
const captureDir = process.env.STUDIO_CLAUDE_SMOKE_DIR;
const CODE_WORD = 'PELICAN-7';
const TURN_MS = 180_000;

/** A 24×24 picture of one colour. */
function solidPng(red: number, green: number, blue: number): Buffer {
  const size = 24;
  const crcTable = Array.from({ length: 256 }, (_unused, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (data: Buffer): number => {
    let c = 0xffffffff;
    for (const byte of data) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const check = Buffer.alloc(4);
    check.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, check]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [red, green, blue]).flat())]);
  const pixels = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

describe.skipIf(!enabled)('the real Claude Code CLI (manual smoke test: spends quota)', () => {
  let kit: AgentsKit;
  let adapter: ClaudeCodeAdapter;
  let sessionId: string;
  let projectDir: string;
  let step = 'setup';
  const tapped: Array<{ step: string; stream: string; text: string }> = [];
  const observations: string[] = [];
  const note = (line: string): void => {
    observations.push(`[${step}] ${line}`);
  };

  beforeAll(async () => {
    kit = await createAgentsKit({ config: { sandbox: process.env.STUDIO_CLAUDE_SMOKE_SANDBOX === 'off' ? 'off' : 'auto' } });
    await kit.listen();
    adapter = kit.t.studio.context.services.agents.adapter('claude-code') as ClaudeCodeAdapter;
    adapter.observe((entry) => tapped.push({ step, stream: entry.stream, text: entry.text }));
    projectDir = kit.project.rootDir;
    sessionId = (await kit.session(kit.owner, { agentId: 'claude-code', model: 'haiku' })).id;
  }, 60_000);

  afterAll(async () => {
    if (captureDir) {
      mkdirSync(captureDir, { recursive: true });
      for (const name of new Set(tapped.map((entry) => entry.step))) {
        const lines = tapped.filter((entry) => entry.step === name).map((entry) => (entry.stream === 'stdout' ? entry.text : JSON.stringify({ __studio: entry.stream, text: entry.text })));
        writeFileSync(path.join(captureDir, `${name}.jsonl`), `${lines.join('\n')}\n`);
      }
      writeFileSync(path.join(captureDir, 'observations.txt'), `${observations.join('\n')}\n`);
    }
    await kit?.close();
  }, 60_000);

  const upload = async (files: Array<{ name: string; type: string; content: Buffer | string }>): Promise<Attachment[]> => {
    const boundary = `----claude-smoke-${Math.random().toString(16).slice(2)}`;
    const chunks: Buffer[] = [];
    for (const file of files) {
      chunks.push(Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="files"; filename="${file.name}"\r\ncontent-type: ${file.type}\r\n\r\n`), Buffer.from(file.content), Buffer.from('\r\n'));
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    const response = await kit.owner.request<UploadAttachmentsResponse>('POST', `/api/sessions/${sessionId}/attachments`, Buffer.concat(chunks), { 'content-type': `multipart/form-data; boundary=${boundary}` });
    return response.body.attachments;
  };
  const send = async (text: string, extra: Record<string, unknown> = {}): Promise<string> => {
    const receipt = await kit.owner.post<{ runId: string; disposition: string }>(`/api/sessions/${sessionId}/messages`, { requestId: nextRequestId(), text, ...extra });
    expect(receipt.status).toBe(202);
    return receipt.body.runId;
  };
  const ended = (runId: string) =>
    until(
      async () => {
        const run = (await kit.owner.get<{ status: string; error: { code: string; message: string } | null }>(`/api/runs/${runId}`)).body;
        return run.status !== 'accepted' && run.status !== 'running' ? run : null;
      },
      { what: 'the run to end', timeoutMs: TURN_MS },
    );
  const events = () => kit.events(kit.owner, sessionId);
  const ofRun = async <T>(runId: string, type: string): Promise<T[]> => (await events()).filter((event) => event.type === type && (event.data as { runId?: string }).runId === runId).map((event) => event.data as T);
  const texts = async (runId: string): Promise<string[]> => (await ofRun<{ text: string; parentToolCallId: string | null }>(runId, 'message.assistant')).filter((message) => message.parentToolCallId === null).map((message) => message.text);
  const argvOf = (name: string): string[] => (JSON.parse(tapped.filter((entry) => entry.step === name && entry.stream === 'argv').at(-1)!.text) as { args: string[] }).args;
  /** Waits for a run to end, answering every approval it asks for on the way. */
  const answering = async (runId: string, decide: (approval: Approval) => 'allow' | 'deny') => {
    const seen = new Set<string>();
    return until(
      async () => {
        for (const approval of (await kit.state(kit.owner, sessionId)).pendingApprovals) {
          if (seen.has(approval.id)) continue;
          seen.add(approval.id);
          const decision = decide(approval);
          note(`approval asked: kind=${approval.kind} tool=${approval.toolName} toolKind=${approval.toolKind} title=${JSON.stringify(approval.title)} paths=${JSON.stringify(approval.paths)} risk=${approval.risk} → ${decision}`);
          const answered = await kit.owner.post(`/api/approvals/${approval.id}/decision`, decision === 'allow' ? { decision } : { decision, note: 'Not this file.' });
          expect(answered.status).toBe(200);
        }
        const run = (await kit.owner.get<{ status: string; error: { code: string; message: string } | null }>(`/api/runs/${runId}`)).body;
        return run.status !== 'accepted' && run.status !== 'running' ? run : null;
      },
      { what: 'the run to end', timeoutMs: TURN_MS },
    );
  };

  it('is installed and signed in, according to its own status command', async () => {
    step = 'status';
    const status = await adapter.cli.settledStatus();
    note(`status: installed=${status.installed} version=${status.version} signedIn=${status.signedIn} account=${status.account ? 'present' : 'none'} problem=${status.problem}`);
    note(`sandbox: ${kit.t.studio.context.sandbox.status.mode}`);
    const capabilities = await adapter.capabilities();
    note(`models: ${capabilities.models.map((model) => model.id).join(', ')}; efforts: ${capabilities.models[0]?.efforts?.join(', ')}; steering: ${capabilities.steering}`);
    expect(status).toMatchObject({ installed: true, signedIn: true, problem: null });
  }, 60_000);

  it('(a) answers a plain question, reads an attached file without a prompt and sees an attached image', async () => {
    step = 'a-plain';
    const [notes, picture] = await upload([
      { name: 'notes.txt', type: 'text/plain', content: `The code word is ${CODE_WORD}.\n` },
      { name: 'swatch.png', type: 'image/png', content: solidPng(220, 20, 20) },
    ]);
    const startedAt = Date.now();
    const runId = await send('Answer in exactly three short lines and do nothing else: line 1, the code word from the attached text file; line 2, the main colour of the attached picture as one word; line 3, the word READY.', {
      attachmentIds: [notes!.id, picture!.id],
    });
    const run = await answering(runId, () => 'deny');
    note(`run: ${run.status} ${run.error ? `${run.error.code}: ${run.error.message}` : ''} in ${Date.now() - startedAt} ms`);
    const answer = (await texts(runId)).join('\n');
    note(`answer: ${JSON.stringify(answer)}`);
    const tools = await ofRun<{ name: string; kind: string; title: string }>(runId, 'tool.started');
    note(`tools: ${tools.map((tool) => `${tool.name}(${tool.kind})`).join(', ') || 'none'}`);
    note(`tool results: ${(await ofRun<{ status: string }>(runId, 'tool.finished')).map((tool) => tool.status).join(', ') || 'none'}`);
    note(`approvals asked: ${(await ofRun(runId, 'approval.requested')).length}`);
    note(`usage: ${JSON.stringify((await ofRun(runId, 'usage.reported')).at(-1))}`);
    note(`notices: ${JSON.stringify(await ofRun(runId, 'notice'))}`);
    const stdout = tapped.filter((entry) => entry.step === step && entry.stream === 'stdout').map((entry) => JSON.parse(entry.text) as { type: string; subtype?: string; mcp_servers?: unknown; permissionMode?: string; model?: string });
    const init = stdout.find((line) => line.type === 'system' && line.subtype === 'init');
    note(`init: model=${init?.model} permissionMode=${init?.permissionMode} mcp_servers=${JSON.stringify(init?.mcp_servers)}`);
    note(`first output after ${tapped.length} tapped entries; event types: ${[...new Set(stdout.map((line) => `${line.type}${line.subtype ? `:${line.subtype}` : ''}`))].join(', ')}`);

    expect(run.status).toBe('completed');
    expect(answer).toContain(CODE_WORD);
    expect(answer.toLowerCase()).toContain('red');
    expect(answer).toContain('READY');
    // Only the Studio's bridge was offered to the CLI, and it connected.
    expect(init?.mcp_servers).toEqual([expect.objectContaining({ name: 'studio', status: 'connected' })]);
    // The attachment was read without a question (its folder was named with --add-dir).
    expect(await ofRun(runId, 'approval.requested')).toEqual([]);
    expect((await ofRun<{ status: string }>(runId, 'tool.finished')).every((tool) => tool.status === 'ok')).toBe(true);
    // Text was streamed and then stored once.
    expect((await ofRun(runId, 'message.assistant')).length).toBeGreaterThanOrEqual(1);
    expect(await ofRun(runId, 'usage.reported')).not.toEqual([]);
  }, TURN_MS + 30_000);

  it('(b, c, d) resumes the conversation; a file write arrives as an approval — one allowed and carried out, one denied', async () => {
    step = 'bcd-approvals';
    const runId = await send(
      'Do exactly this with the Write tool, one call after the other: first create smoke-note.txt containing only the code word you read earlier; then create denied.txt containing only the word no. If a call is refused, do not retry it. Finish with one line: DONE.',
    );
    const decided: Approval[] = [];
    // Allow exactly the one file; refuse anything else the CLI asks about.
    const run = await answering(runId, (approval) => {
      decided.push(approval);
      return approval.toolName === 'Write' && approval.paths[0] === path.join(projectDir, 'smoke-note.txt') ? 'allow' : 'deny';
    });
    note(`run: ${run.status} ${run.error ? `${run.error.code}: ${run.error.message}` : ''}`);
    const finished = await ofRun<{ status: string; output: string; diffs: unknown[] }>(runId, 'tool.finished');
    note(`tool results: ${JSON.stringify(finished.map((tool) => ({ status: tool.status, output: tool.output.slice(0, 120), diffs: tool.diffs })))}`);
    note(`answer: ${JSON.stringify((await texts(runId)).join('\n'))}`);
    note(`argv: ${JSON.stringify(argvOf(step).map((arg) => (arg.length > 60 ? `${arg.slice(0, 40)}…` : arg)))}`);

    expect(run.status).toBe('completed');
    // (d) the second turn resumed the CLI's own conversation — and knew the code word from it.
    const argv = argvOf(step);
    expect(argv).toContain('--resume');
    expect(decided.map((approval) => [approval.kind, approval.toolName, approval.toolKind, approval.paths[0]])).toEqual([
      ['tool', 'Write', 'edit', path.join(projectDir, 'smoke-note.txt')],
      ['tool', 'Write', 'edit', path.join(projectDir, 'denied.txt')],
    ]);
    // (b) allowed: the file is there, with what the model remembered.
    expect(readFileSync(path.join(projectDir, 'smoke-note.txt'), 'utf8')).toContain(CODE_WORD);
    // (c) denied: nothing was written, the call is recorded as denied, and the turn went on to its end.
    expect(existsSync(path.join(projectDir, 'denied.txt'))).toBe(false);
    expect(finished.map((tool) => tool.status)).toEqual(['ok', 'denied']);
    expect(finished[1]!.output).toContain('Not this file.');
    expect(finished[0]!.diffs).toHaveLength(1);
  }, TURN_MS + 30_000);

  it('(f) takes a message steered into the running turn', async () => {
    step = 'f-steer';
    const runId = await send('In your reply (no tools), write the numbers from one to sixty in English words, one per line.');
    await until(async () => ((await kit.state(kit.owner, sessionId)).streaming[0]?.text.length ?? 0) > 40, { what: 'the answer to start streaming', timeoutMs: TURN_MS });
    const steered = await kit.owner.post<{ disposition: string; runId: string }>(`/api/sessions/${sessionId}/messages`, { requestId: nextRequestId(), text: 'One more thing: reply with the single word PINEAPPLE.', whenBusy: 'steer' });
    note(`steer receipt: ${steered.body.disposition}`);
    const run = await ended(runId);
    const said = await texts(runId);
    note(`run: ${run.status}; assistant messages: ${said.length}; last: ${JSON.stringify(said.at(-1)?.slice(-80))}`);
    const stdout = tapped.filter((entry) => entry.step === step && entry.stream === 'stdout').map((entry) => JSON.parse(entry.text) as { type: string; isReplay?: boolean; queued_turn_count?: number; result_index?: number });
    note(`results printed: ${JSON.stringify(stdout.filter((line) => line.type === 'result').map((line) => ({ queued: line.queued_turn_count, index: line.result_index })))}; replays: ${stdout.filter((line) => line.isReplay).length}`);
    expect(steered.body).toMatchObject({ disposition: 'steered', runId });
    expect(run.status).toBe('completed');
    expect(said.join('\n')).toContain('PINEAPPLE');
    expect((await events()).filter((event) => event.type === 'run.finished' && (event.data as { runId: string }).runId === runId)).toHaveLength(1);
  }, TURN_MS + 30_000);

  it('(e) stops mid-answer: the run ends once, the partial answer is kept, no process is left', async () => {
    step = 'e-stop';
    const runId = await send('In your reply (no tools), write the numbers from one to four hundred in English words, one per line.');
    await until(async () => ((await kit.state(kit.owner, sessionId)).streaming[0]?.text.length ?? 0) > 60, { what: 'the answer to start streaming', timeoutMs: TURN_MS });
    const configFile = argvOf(step)[argvOf(step).indexOf('--mcp-config') + 1]!;
    const running = (): string[] =>
      readdirSync('/proc')
        .filter((entry) => /^\d+$/.test(entry))
        .flatMap((entry) => {
          try {
            return readFileSync(`/proc/${entry}/cmdline`, 'utf8').includes(configFile) ? [entry] : [];
          } catch {
            return [];
          }
        });
    expect(running().length).toBeGreaterThanOrEqual(1);
    const startedAt = Date.now();
    const stopped = await kit.owner.post<{ run: { status: string } }>(`/api/sessions/${sessionId}/stop`);
    note(`stop answered ${stopped.status} after ${Date.now() - startedAt} ms with status ${stopped.body.run?.status}`);
    const run = await ended(runId);
    const stored = await ofRun<{ text: string; partial: boolean }>(runId, 'message.assistant');
    note(`run: ${run.status}; stored text: ${stored.map((message) => `${message.text.length} chars, partial=${message.partial}`).join('; ')}`);
    const stdout = tapped.filter((entry) => entry.step === step && entry.stream === 'stdout').map((entry) => JSON.parse(entry.text) as { type: string; subtype?: string; terminal_reason?: string; is_error?: boolean });
    note(`after the interrupt the CLI printed: ${JSON.stringify(stdout.filter((line) => line.type === 'result' || line.type === 'control_response').map((line) => ({ type: line.type, subtype: line.subtype, reason: line.terminal_reason })))}`);
    await until(() => running().length === 0, { what: 'the CLI process to be gone', timeoutMs: 10_000 });
    note(`processes left: ${running().length}; configuration file still there: ${existsSync(configFile)}`);

    expect(run.status).toBe('stopped');
    expect(Date.now() - startedAt).toBeLessThan(15_000);
    expect(stored.length).toBeGreaterThanOrEqual(1);
    expect(stored.map((message) => message.text).join('')).toMatch(/one/i);
    expect((await events()).filter((event) => event.type === 'run.finished' && (event.data as { runId: string }).runId === runId)).toHaveLength(1);
    expect(existsSync(configFile)).toBe(false);
  }, TURN_MS + 30_000);
});
