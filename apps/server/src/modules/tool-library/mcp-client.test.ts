import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { mcpOperation, mcpResultText } from './mcp-client.js';
import type { guardedRequest } from '../../kernel/net.js';
const options = {
  endpoint: 'https://example.invalid/mcp',
  token: 'synthetic-credential',
  policy: {},
  method: 'tools/list' as const,
  params: {},
};
describe('MCP transport refusals', () => {
  it('does not dispatch an external tool after cancellation during initialization', async () => {
    const abort = new AbortController();
    const methods: string[] = [];
    const request = vi.fn<typeof guardedRequest>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { id: number; method: string };
      methods.push(body.method);
      abort.abort();
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: Readable.from([
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: { protocolVersion: '2025-11-25', capabilities: { tools: {} } },
          }),
        ]),
      };
    });
    await expect(
      mcpOperation({
        ...options,
        method: 'tools/call',
        params: { name: 'synthetic_write', arguments: {} },
        signal: abort.signal,
        request,
      }),
    ).rejects.toMatchObject({ code: 'mcp_failed' });
    expect(methods).toEqual(['initialize']);
  });
  it('refuses redirects without forwarding raw upstream errors', async () => {
    const request = vi.fn<typeof guardedRequest>(async () => ({
      status: 302,
      headers: { location: 'https://elsewhere.invalid' },
      body: Readable.from(['synthetic-credential']),
    }));
    await expect(mcpOperation({ ...options, request })).rejects.toMatchObject({
      code: 'mcp_failed',
      message: expect.not.stringContaining('synthetic-credential'),
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('supports SSE replies without following remote resource links or server-initiated commands', async () => {
    const request = vi.fn<typeof guardedRequest>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { id?: number; method: string };
      if (body.id === undefined) return { status: 202, headers: {}, body: Readable.from([]) };
      const result =
        body.method === 'initialize'
          ? { protocolVersion: '2025-11-25', capabilities: { tools: {} } }
          : { tools: [] };
      return {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: Readable.from([
          `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result })}\n\n`,
        ]),
      };
    });
    expect(await mcpOperation({ ...options, request })).toEqual({ tools: [] });
    request.mockImplementation(async () => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: Readable.from([
        JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'sampling/createMessage', params: {} }),
      ]),
    }));
    await expect(mcpOperation({ ...options, request })).rejects.toMatchObject({
      code: 'mcp_failed',
    });
  });
  it('redacts echoed credentials and ignores image/resource blocks', () => {
    expect(
      mcpResultText(
        {
          content: [
            { type: 'text', text: 'hello synthetic-credential' },
            { type: 'resource_link', uri: 'https://private.invalid' },
          ],
        },
        'synthetic-credential',
      ),
    ).toEqual({ text: 'Untrusted MCP tool output:\nhello [redacted]', isError: false });
  });
});
