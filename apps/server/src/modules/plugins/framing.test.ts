import { describe, expect, it } from 'vitest';
import { LineDecoder, classify, encodeLine, type FramingProblem } from './framing.js';

function collect(maxBytes = 1024) {
  const messages: Record<string, unknown>[] = [];
  const problems: FramingProblem[] = [];
  const decoder = new LineDecoder({ maxBytes, onMessage: (message) => messages.push(message), onProblem: (problem) => problems.push(problem) });
  return { messages, problems, decoder };
}

describe('LineDecoder', () => {
  it('reassembles a message split at every byte, including inside multi-byte characters', () => {
    const { messages, problems, decoder } = collect();
    for (const byte of encodeLine({ id: 1, text: 'zażółć ✓ 日本語' })) decoder.push(Buffer.of(byte));
    expect(problems).toEqual([]);
    expect(messages).toEqual([{ id: 1, text: 'zażółć ✓ 日本語' }]);
  });

  it('separates messages merged into one chunk and keeps the unfinished tail', () => {
    const { messages, decoder } = collect();
    const all = Buffer.concat([encodeLine({ id: 1 }), encodeLine({ id: 2 }), encodeLine({ id: 3 })]);
    decoder.push(all.subarray(0, all.length - 3));
    expect(messages.map((message) => message.id)).toEqual([1, 2]);
    expect(decoder.buffered).toBeGreaterThan(0);
    decoder.push(all.subarray(all.length - 3));
    expect(messages.map((message) => message.id)).toEqual([1, 2, 3]);
    expect(decoder.buffered).toBe(0);
  });

  it('never buffers more than the limit while a line without an end keeps coming', () => {
    const { messages, problems, decoder } = collect(4096);
    let most = 0;
    for (let i = 0; i < 2000; i += 1) {
      decoder.push(Buffer.alloc(1024, 0x78));
      most = Math.max(most, decoder.buffered);
    }
    expect(most).toBeLessThanOrEqual(4096);
    expect(problems).toEqual(['oversized']);
    decoder.push(Buffer.from('\n{"id":"next"}\n'));
    expect(messages).toEqual([{ id: 'next' }]);
  });

  it('rejects an oversized line that arrives whole, and one that crosses the limit at its last chunk', () => {
    const whole = collect(32);
    whole.decoder.push(Buffer.from(`{"a":"${'x'.repeat(64)}"}\n{"ok":1}\n`));
    expect(whole.problems).toEqual(['oversized']);
    expect(whole.messages).toEqual([{ ok: 1 }]);

    const late = collect(16);
    late.decoder.push(Buffer.from('{"a":"1234567'));
    late.decoder.push(Buffer.from('890123"}\n{"ok":2}\n'));
    expect(late.problems).toEqual(['oversized']);
    expect(late.messages).toEqual([{ ok: 2 }]);
  });

  it('accepts a line of exactly the limit', () => {
    const line = '{"a":"xxxxxxxx"}';
    const { messages, problems, decoder } = collect(line.length);
    decoder.push(Buffer.from(line + '\n'));
    expect(problems).toEqual([]);
    expect(messages).toHaveLength(1);
  });

  it('reports garbage without throwing and keeps going', () => {
    const { messages, problems, decoder } = collect();
    decoder.push(Buffer.from('hello\n[1]\n42\n"s"\nnull\ntrue\n{"a":\n\u0000\u0001\n'));
    decoder.push(Buffer.of(0xff, 0xfe, 0xfd, 0x0a));
    decoder.push(Buffer.from('\n\r\n   \n{"fine":true}\r\n'));
    expect(problems).toEqual(['invalid-json', 'not-an-object', 'not-an-object', 'not-an-object', 'not-an-object', 'not-an-object', 'invalid-json', 'invalid-json', 'invalid-json']);
    expect(messages).toEqual([{ fine: true }]);
  });

  it('does not keep a reference to a chunk the caller may reuse', () => {
    const { messages, decoder } = collect();
    const chunk = Buffer.from('{"id":"abc');
    decoder.push(chunk);
    chunk.fill(0);
    decoder.push(Buffer.from('def"}\n'));
    expect(messages).toEqual([{ id: 'abcdef' }]);
  });
});

describe('classify', () => {
  it('recognises the four kinds of JSON-RPC message', () => {
    expect(classify({ jsonrpc: '2.0', id: 1, method: 'host.storage.get', params: { key: 'a' } })).toEqual({
      kind: 'request',
      id: 1,
      method: 'host.storage.get',
      params: { key: 'a' },
    });
    expect(classify({ jsonrpc: '2.0', method: 'host.log', params: { message: 'x' } })).toEqual({ kind: 'notification', method: 'host.log', params: { message: 'x' } });
    expect(classify({ jsonrpc: '2.0', id: 's1', result: null })).toEqual({ kind: 'result', id: 's1', result: null });
    expect(classify({ jsonrpc: '2.0', id: 's1', error: { code: -32000, message: 'no', data: { code: 'not_found' } } })).toEqual({
      kind: 'error',
      id: 's1',
      code: 'not_found',
      message: 'no',
    });
  });

  it('gives an error without a usable code a generic one, and caps its text', () => {
    expect(classify({ jsonrpc: '2.0', id: 1, error: { message: 'x'.repeat(5000) } })).toMatchObject({ kind: 'error', code: 'plugin_error', message: 'x'.repeat(2000) });
    expect(classify({ jsonrpc: '2.0', id: 1, error: { data: { code: 'Not A Code!' } } })).toMatchObject({ code: 'plugin_error', message: 'The plugin reported an error.' });
    expect(classify({ jsonrpc: '2.0', id: 1, error: { data: { code: 42 } } })).toMatchObject({ code: 'plugin_error' });
  });

  it.each([
    ['no version', { id: 1, method: 'x' }],
    ['another version', { jsonrpc: '1.0', id: 1, method: 'x' }],
    ['a method that is not text', { jsonrpc: '2.0', id: 1, method: 5 }],
    ['an empty method', { jsonrpc: '2.0', id: 1, method: '' }],
    ['an endless method name', { jsonrpc: '2.0', id: 1, method: 'm'.repeat(65) }],
    ['an object as id', { jsonrpc: '2.0', id: { a: 1 }, method: 'x' }],
    ['a fractional id', { jsonrpc: '2.0', id: 1.5, result: 1 }],
    ['an endless id', { jsonrpc: '2.0', id: 'i'.repeat(65), result: 1 }],
    ['a response without an id', { jsonrpc: '2.0', result: 1 }],
    ['a response with neither result nor error', { jsonrpc: '2.0', id: 1 }],
    ['an error that is not an object', { jsonrpc: '2.0', id: 1, error: 'boom' }],
    ['an error that is an array', { jsonrpc: '2.0', id: 1, error: [] }],
    ['nothing at all', {}],
  ])('calls %s invalid', (_what, message) => {
    expect(classify(message)).toEqual({ kind: 'invalid' });
  });

  it('treats a null id on a method as a notification', () => {
    expect(classify({ jsonrpc: '2.0', id: null, method: 'host.log' })).toMatchObject({ kind: 'notification' });
  });
});
