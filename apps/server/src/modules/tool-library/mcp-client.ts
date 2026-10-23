import { Readable } from 'node:stream';
import { z } from 'zod';
import { libraryToolsSchema } from '@agent-studio/protocol';
import { unavailable } from '../../kernel/errors.js';
import { guardedRequest, readBody, type NetPolicy } from '../../kernel/net.js';
import { redactSecrets } from '../../kernel/redact.js';
import { sseData } from '../providers/openai-client.js';

const MAX_BYTES = 1024 * 1024;
const supported = ['2025-11-25', '2025-06-18', '2025-03-26'];
const failure = () =>
  unavailable(
    'The MCP server did not complete the request. No request is retried automatically.',
    'mcp_failed',
  );
const envelope = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.number(), z.string()]).optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
  method: z.string().optional(),
});

/** One short-lived MCP session per approved operation; no sampling, roots or server-initiated tools. */
export async function mcpOperation(options: {
  endpoint: string;
  token: string | null;
  policy: NetPolicy;
  method: 'tools/list' | 'tools/call';
  params: Record<string, unknown>;
  request?: typeof guardedRequest;
  signal?: AbortSignal;
}): Promise<unknown> {
  const request = options.request ?? guardedRequest;
  const signal = AbortSignal.any([
    AbortSignal.timeout(30_000),
    ...(options.signal ? [options.signal] : []),
  ]);
  let session: string | null = null;
  let version = supported[0]!;
  let nextId = 1;
  const headers = () => ({
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    'mcp-protocol-version': version,
    ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    ...(session ? { 'mcp-session-id': session } : {}),
  });
  async function send(
    method: string,
    params: Record<string, unknown>,
    notification = false,
  ): Promise<unknown> {
    signal.throwIfAborted();
    const id = nextId++;
    const response = await request(options.endpoint, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ jsonrpc: '2.0', ...(!notification ? { id } : {}), method, params }),
      policy: options.policy,
      signal,
    });
    try {
      signal.throwIfAborted();
      if (response.status < 200 || response.status >= 300) throw failure();
      if (method === 'initialize') {
        const value = response.headers['mcp-session-id'];
        if (value !== undefined) {
          if (typeof value !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(value)) throw failure();
          session = value;
        }
      }
      if (notification) return null;
      const data = await readBody(response.body, MAX_BYTES);
      const type = String(response.headers['content-type'] ?? '').toLowerCase();
      const payloads: string[] = [];
      if (type.startsWith('text/event-stream')) {
        for await (const payload of sseData(Readable.from([data]), MAX_BYTES))
          if (payload.trim()) payloads.push(payload);
      } else if (type.startsWith('application/json')) payloads.push(data.toString('utf8'));
      else throw failure();
      for (const payload of payloads) {
        const value = envelope.parse(JSON.parse(payload));
        // Advertised capabilities are empty. Refuse unsolicited requests instead of executing them.
        if (value.method && value.id !== undefined) throw failure();
        if (value.id === id) {
          if (value.error !== undefined || value.result === undefined) throw failure();
          return value.result;
        }
      }
      throw failure();
    } finally {
      response.body.destroy();
    }
  }
  try {
    const initialize = z
      .object({
        protocolVersion: z.string(),
        capabilities: z.object({ tools: z.unknown().optional() }),
      })
      .parse(
        await send('initialize', {
          protocolVersion: version,
          capabilities: {},
          clientInfo: { name: 'cloud-harness', version: '1' },
        }),
      );
    if (
      !supported.includes(initialize.protocolVersion) ||
      initialize.capabilities.tools === undefined
    )
      throw failure();
    version = initialize.protocolVersion;
    await send('notifications/initialized', {}, true);
    if (options.method === 'tools/call') return await send(options.method, options.params);
    const tools: z.infer<typeof libraryToolsSchema>['tools'] = [];
    let cursor: string | undefined;
    const cursors = new Set<string>();
    for (let page = 0; page < 10; page++) {
      const result = libraryToolsSchema
        .extend({ nextCursor: z.string().max(2000).optional() })
        .parse(await send('tools/list', cursor ? { cursor } : {}));
      tools.push(...result.tools);
      if (tools.length > 200) throw failure();
      if (!result.nextCursor) return { tools };
      if (cursors.has(result.nextCursor)) throw failure();
      cursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    throw failure();
  } catch {
    throw failure();
  } finally {
    if (session) {
      try {
        const response = await request(options.endpoint, {
          method: 'DELETE',
          headers: headers(),
          policy: options.policy,
          signal: AbortSignal.timeout(3000),
        });
        response.body.destroy();
      } catch {
        /* A server may not support session termination. No credentials or responses are logged. */
      }
    }
  }
}

/** Do not render remote HTML, auto-fetch resources or leak an echoed access token into a transcript. */
export function mcpResultText(
  result: unknown,
  token: string | null,
): { text: string; isError: boolean } {
  const parsed = z
    .object({
      content: z
        .array(z.object({ type: z.string(), text: z.string().optional() }))
        .max(200)
        .optional(),
      structuredContent: z.record(z.string(), z.unknown()).optional(),
      isError: z.boolean().optional(),
    })
    .parse(result);
  const text =
    parsed.content
      ?.filter((item) => item.type === 'text')
      .map((item) => item.text ?? '')
      .join('\n') || JSON.stringify(parsed.structuredContent ?? {});
  const hidden = token ? text.split(token).join('[redacted]') : text;
  return {
    text: `Untrusted MCP tool output:\n${redactSecrets(hidden).slice(0, 64_000)}`,
    isError: parsed.isError ?? false,
  };
}
