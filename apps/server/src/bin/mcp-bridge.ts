#!/usr/bin/env node
/**
 * The Studio's MCP bridge: a small stdio MCP server that an agent CLI starts
 * as a child process. It offers the Studio's own tools to the agent by
 * forwarding `tools/list` and `tools/call` to the Studio server on this
 * machine.
 *
 * It is given exactly two things, in its environment:
 *
 *   STUDIO_BRIDGE_URL     where the server listens (always this machine)
 *   STUDIO_BRIDGE_TOKEN   a token for one run, useless once that run ends
 *
 * and, only when the server speaks TLS, STUDIO_BRIDGE_TLS_PIN: the SHA-256
 * fingerprint of the server's certificate, which is checked instead of the
 * host name because the bridge connects to a loopback address.
 *
 * This file must stay self-contained (no imports from the rest of the server)
 * and free of TypeScript features that need compiling, because in development
 * Node runs it directly from source.
 */
import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import type { TLSSocket } from 'node:tls';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const PERMISSION_PROMPT_TOOL = 'permission_prompt';
const TOKEN_HEADER = 'x-studio-bridge-token';

const baseUrl = process.env.STUDIO_BRIDGE_URL ?? '';
const token = process.env.STUDIO_BRIDGE_TOKEN ?? '';
const tlsPin = process.env.STUDIO_BRIDGE_TLS_PIN ?? '';
// Nothing this process might ever start should inherit the token.
delete process.env.STUDIO_BRIDGE_TOKEN;

interface Reply {
  status: number;
  body: unknown;
}

async function post(path: string, payload: unknown): Promise<Reply> {
  const target = new URL(path, baseUrl);
  if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new Error('STUDIO_BRIDGE_URL is not an http(s) address.');
  const secure = target.protocol === 'https:';
  const data = Buffer.from(JSON.stringify(payload));
  return new Promise<Reply>((resolve, reject) => {
    // No timeout: a permission prompt may wait for a person for a long time.
    const options = {
      host: target.hostname.replace(/^\[|\]$/g, ''),
      port: Number(target.port || (secure ? 443 : 80)),
      path: target.pathname,
      method: 'POST',
      agent: false as const,
      headers: {
        host: target.host,
        'content-type': 'application/json',
        'content-length': String(data.length),
        connection: 'close',
        [TOKEN_HEADER]: token,
      },
    };
    const onResponse = (response: IncomingMessage): void => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        resolve({ status: response.statusCode ?? 0, body: parseJson(Buffer.concat(chunks).toString('utf8')) });
      });
    };
    if (!secure) {
      const request = http.request(options, onResponse);
      request.on('error', reject);
      request.end(data);
      return;
    }
    // The certificate is identified by its fingerprint, not by a name or an authority: the bridge
    // connects to a loopback address, which no certificate is issued for. Nothing — least of all
    // the token — is written until the fingerprint has been checked.
    const request = https.request({ ...options, rejectUnauthorized: false }, onResponse);
    request.on('error', reject);
    request.once('socket', (socket) => {
      const checked = (): void => {
        const fingerprint = (socket as TLSSocket).getPeerCertificate().fingerprint256;
        if (!tlsPin || fingerprint !== tlsPin) {
          request.destroy(new Error('The server presented a certificate the bridge was not told to trust.'));
          return;
        }
        request.end(data);
      };
      socket.once('secureConnect', checked);
    });
  });
}

function parseJson(text: string): unknown {
  try {
    return text === '' ? null : JSON.parse(text);
  } catch {
    return null;
  }
}

function problemOf(reply: Reply): string {
  const error = (reply.body as { error?: { message?: unknown } } | null)?.error;
  return typeof error?.message === 'string' ? error.message : `The Studio answered with status ${reply.status}.`;
}

const textResult = (text: string, isError: boolean) => ({ content: [{ type: 'text' as const, text }], isError });

async function main(): Promise<void> {
  if (!baseUrl || !token) {
    console.error('The Studio bridge needs STUDIO_BRIDGE_URL and STUDIO_BRIDGE_TOKEN. It is started by the Studio, not by hand.');
    process.exit(2);
  }

  const server = new Server({ name: 'agent-studio', version: '1.0.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const reply = await post('/api/bridge/tools/list', {});
    if (reply.status !== 200) throw new Error(problemOf(reply));
    const tools = (reply.body as { tools?: unknown } | null)?.tools;
    return { tools: Array.isArray(tools) ? tools : [] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    try {
      const reply = await post('/api/bridge/tools/call', { name, arguments: request.params.arguments ?? {} });
      if (reply.status === 200 && reply.body && typeof reply.body === 'object') return reply.body as ReturnType<typeof textResult>;
      // A permission prompt that cannot be decided is a refusal, never an error the agent might ignore.
      if (name === PERMISSION_PROMPT_TOOL) return textResult(JSON.stringify({ behavior: 'deny', message: problemOf(reply) }), false);
      return textResult(problemOf(reply), true);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      if (name === PERMISSION_PROMPT_TOOL) {
        return textResult(JSON.stringify({ behavior: 'deny', message: `The Studio could not be reached: ${message}` }), false);
      }
      return textResult(`The Studio could not be reached: ${message}`, true);
    }
  });

  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
