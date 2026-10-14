import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { loggerOptions } from './http.js';
import { redactLogFields, redactedErrorText } from './redact.js';

const KEY = 'sk-test-0123456789abcdefghijklmnop';

function capture() {
  const lines: string[] = [];
  const app = Fastify({ logger: loggerOptions('debug', { write: (line: string) => void lines.push(line) }) });
  return { app, lines, text: () => lines.join('') };
}

describe('server log redaction', () => {
  it('redacts the stack of a logged error, not only its message', async () => {
    const { app, text } = capture();
    const error = new Error(`provider refused key ${KEY}`);
    app.log.error({ err: error }, 'a call failed');
    await app.close();
    expect(text()).not.toContain(KEY);
    expect(text()).toContain('[redacted]');
    // The frames are kept: the stack is still useful for finding the bug.
    expect(text()).toContain('log-redaction.test');
  });

  it('redacts a described error that a call site forgot to redact', async () => {
    const { app, text } = capture();
    app.log.warn({ sessionId: 's1', err: `spawn failed: OPENAI_API_KEY=${KEY}` }, 'stopping a run failed');
    app.log.info({ detail: `Authorization: Bearer ${KEY}` }, 'request');
    await app.close();
    expect(text()).not.toContain(KEY);
    expect(text()).toContain('"sessionId":"s1"');
  });

  it('redacts errors inside causes and nested details', async () => {
    const { app, text } = capture();
    const cause = new Error(`upstream said ${KEY}`);
    app.log.error({ err: new Error('wrapped', { cause }), details: [{ output: `token=${KEY}` }] }, 'failed');
    await app.close();
    expect(text()).not.toContain(KEY);
  });

  it('logs a failing request without the secret in its stack', async () => {
    const { app, text } = capture();
    // Fastify's own error log for an unhandled throw goes through the same formatter.
    app.get('/boom', () => {
      throw new Error(`bad key ${KEY}`);
    });
    const reply = await app.inject({ method: 'GET', url: '/boom' });
    await app.close();
    expect(reply.statusCode).toBe(500);
    expect(text()).not.toContain(KEY);
  });
});

describe('redactLogFields', () => {
  it('returns the same object when nothing needs changing', () => {
    const fields = { sessionId: 's1', count: 3, nested: { a: 1 } };
    expect(redactLogFields(fields)).toBe(fields);
  });

  it('leaves non-error objects to their serializers', () => {
    const request = { headers: { note: `sk-${'a'.repeat(30)}` } };
    expect(redactLogFields({ req: request }).req).toBe(request);
  });

  it('survives cycles and deep nesting', () => {
    const loop: Record<string, unknown> = { message: KEY };
    loop.self = loop;
    const out = JSON.stringify(redactLogFields({ err: loop }));
    expect(out).not.toContain(KEY);
    expect(out).toContain('[circular]');
  });
});

describe('redactedErrorText', () => {
  it('prints the stack with the secret removed', () => {
    const text = redactedErrorText(new Error(`crash with ${KEY}`));
    expect(text).not.toContain(KEY);
    expect(text).toMatch(/^Error: crash with \[redacted\]\n\s+at /);
  });

  it('handles values that are not errors', () => {
    expect(redactedErrorText(`plain ${KEY}`)).toBe('plain [redacted]');
  });
});
