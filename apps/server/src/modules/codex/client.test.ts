import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { FastifyBaseLogger } from 'fastify';
import { describe, expect, it } from 'vitest';
import { type AppServerHandlers, AppServerClient, ProcessEnded } from './client.js';
import { runFailure } from './errors.js';

/** Just enough of a child process for the client: three streams and the lifecycle events. */
function fakeChild() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 1 });
  return child;
}

const quiet = { debug() {}, info() {}, warn() {}, error() {} } as unknown as FastifyBaseLogger;
const handlers: AppServerHandlers = { notification() {}, request: async () => null, failed() {} };

describe('the tail of the Codex error stream', () => {
  it('is redacted before it is cut, so a token straddling the cut leaves no fragment', async () => {
    const child = fakeChild();
    const client = new AppServerClient(child as unknown as ConstructorParameters<typeof AppServerClient>[0], handlers, quiet);
    const token = 'ghp_ZQ7ZQ7ZQ7ZQ7ZQ7ZQ7ZQ7ZQ7ZQ7ZQ7ZQ7ZQ7';
    // 8 KiB are kept; the token starts 20 characters before the cut, and arrives in two chunks.
    const tail = ` ${'e'.repeat(8 * 1024 - 21)}`;
    child.stderr.write(`panic: ${token.slice(0, 10)}`);
    child.stderr.write(`${token.slice(10)}${tail}`);
    await new Promise((resolve) => setImmediate(resolve));

    expect(client.stderrTail).not.toContain('ZQ7');
    expect(client.stderrTail.length).toBeLessThanOrEqual(8 * 1024);
    expect(client.stderrTail.endsWith(tail)).toBe(true);
    // What a person would be shown about the crash carries none of it either.
    const failure = runFailure(new ProcessEnded(3, null), { stderr: client.stderrTail, during: 'in the middle of the turn' });
    expect(failure.message).not.toContain('ZQ7');
    child.emit('close', 3, null);
    await client.exited;
  });
});
