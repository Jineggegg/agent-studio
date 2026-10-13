import { describe, expect, it } from 'vitest';
import { createDecoder, encodeMessage } from './framing.js';
import type { FramingProblem } from './types.js';

function collect(maxBytes?: number) {
  const messages: Record<string, unknown>[] = [];
  const problems: FramingProblem['kind'][] = [];
  const decoder = createDecoder({
    ...(maxBytes === undefined ? {} : { maxBytes }),
    onMessage: (message) => messages.push(message),
    onProblem: (problem) => problems.push(problem.kind),
  });
  return { messages, problems, decoder };
}

describe('message framing', () => {
  it('writes one JSON object per line', () => {
    expect(encodeMessage({ jsonrpc: '2.0', id: 1, result: 'a\nb' })).toBe('{"jsonrpc":"2.0","id":1,"result":"a\\nb"}\n');
  });

  it('reassembles a message that arrives in pieces', () => {
    const { messages, problems, decoder } = collect();
    const text = encodeMessage({ id: 1, method: 'tool.call', params: { input: { text: 'héllo wörld ✓' } } });
    const bytes = Buffer.from(text, 'utf8');
    // Byte by byte: every multi-byte character is split across chunks.
    for (const byte of bytes) decoder.push(Uint8Array.of(byte));
    expect(problems).toEqual([]);
    expect(messages).toEqual([{ id: 1, method: 'tool.call', params: { input: { text: 'héllo wörld ✓' } } }]);
  });

  it('separates messages that arrive together, and one that straddles two chunks', () => {
    const { messages, decoder } = collect();
    const all = encodeMessage({ id: 1 }) + encodeMessage({ id: 2 }) + encodeMessage({ id: 3 });
    decoder.push(all.slice(0, all.length - 4));
    expect(messages.map((message) => message.id)).toEqual([1, 2]);
    decoder.push(all.slice(all.length - 4));
    expect(messages.map((message) => message.id)).toEqual([1, 2, 3]);
  });

  it('accepts strings, CRLF line ends and blank lines', () => {
    const { messages, problems, decoder } = collect();
    decoder.push('{"id":1}\r\n\n   \n{"id":2}\n');
    expect(messages).toEqual([{ id: 1 }, { id: 2 }]);
    expect(problems).toEqual([]);
  });

  it('drops a line that is too long without keeping it, and carries on with the next', () => {
    const { messages, problems, decoder } = collect(64);
    decoder.push('{"big":"');
    for (let i = 0; i < 100; i += 1) decoder.push('x'.repeat(50));
    decoder.push('"}\n{"id":"after"}\n');
    expect(problems).toEqual(['oversized']);
    expect(messages).toEqual([{ id: 'after' }]);
  });

  it('drops a too-long line that arrives in one chunk', () => {
    const { messages, problems, decoder } = collect(32);
    decoder.push(`{"big":"${'x'.repeat(100)}"}\n{"id":1}\n`);
    expect(problems).toEqual(['oversized']);
    expect(messages).toEqual([{ id: 1 }]);
  });

  it('reports a line that grows too long across a line break in the same chunk', () => {
    const { messages, problems, decoder } = collect(16);
    decoder.push('{"a":"12345');
    decoder.push('67890123"}\n{"b":1}\n');
    expect(problems).toEqual(['oversized']);
    expect(messages).toEqual([{ b: 1 }]);
  });

  it('reports garbage instead of throwing', () => {
    const { messages, problems, decoder } = collect();
    decoder.push('not json at all\n');
    decoder.push('[1,2,3]\n');
    decoder.push('"just a string"\n');
    decoder.push('null\n');
    decoder.push('{"unterminated": \n');
    decoder.push(Uint8Array.of(0xff, 0xfe, 0x00, 0x0a));
    decoder.push('{"ok":true}\n');
    expect(problems).toEqual(['invalid-json', 'not-an-object', 'not-an-object', 'not-an-object', 'invalid-json', 'invalid-json']);
    expect(messages).toEqual([{ ok: true }]);
  });

  it('does not let a chunk that is reused by the caller corrupt a buffered line', () => {
    const { messages, decoder } = collect();
    const chunk = Buffer.from('{"id":"first-ha');
    decoder.push(chunk);
    chunk.fill(0x20);
    decoder.push('lf"}\n');
    expect(messages).toEqual([{ id: 'first-half' }]);
  });
});
