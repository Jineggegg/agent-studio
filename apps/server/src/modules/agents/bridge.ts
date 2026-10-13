import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { type StudioConfig, isLoopbackHostname } from '../../kernel/config.js';
import { randomToken, sha256 } from '../../kernel/crypto.js';
import { forbidden, unauthorized } from '../../kernel/errors.js';
import type { ModuleContext } from '../../kernel/module.js';
import type { BridgeConnection } from './adapter.js';
import type { RunService } from './runtime.js';

/**
 * The server side of the MCP bridge.
 *
 * A CLI agent cannot call into the Studio directly, so each run gets a small
 * stdio MCP server (`src/bin/mcp-bridge.ts`) as a child of the agent. It
 * forwards `tools/list` and `tools/call` to the two endpoints below.
 *
 * What it is trusted with is deliberately tiny: one random token, minted when
 * the run starts, kept here only as a hash and only in memory, and deleted the
 * moment the run ends. The token names one run; every call made with it runs
 * as that run's user, in that run's session and project, and nothing else.
 * The endpoints answer only to a peer on this machine that did not come
 * through a proxy.
 */

export const BRIDGE_TOKEN_HEADER = 'x-studio-bridge-token';
export const BRIDGE_SERVER_NAME = 'studio';
export const PERMISSION_PROMPT_TOOL = 'permission_prompt';

export interface BridgeIdentity {
  readonly runId: string;
  readonly sessionId: string;
  readonly projectId: string | null;
  readonly userId: string;
  readonly agentId: string;
}

export class BridgeTokens {
  readonly #byHash = new Map<string, BridgeIdentity>();
  readonly #byRun = new Map<string, string[]>();
  readonly #config: StudioConfig;
  readonly #listeningPort: () => number | null;
  #pin: string | null | undefined;

  constructor(config: StudioConfig, listeningPort: () => number | null) {
    this.#config = config;
    this.#listeningPort = listeningPort;
  }

  /** Issues the token for a run. Only its hash is kept. */
  mint(identity: BridgeIdentity): string {
    const token = randomToken(32);
    const hash = sha256(token);
    this.#byHash.set(hash, identity);
    this.#byRun.set(identity.runId, [...(this.#byRun.get(identity.runId) ?? []), hash]);
    return token;
  }

  resolve(token: string): BridgeIdentity | null {
    if (token.length < 20 || token.length > 200) return null;
    return this.#byHash.get(sha256(token)) ?? null;
  }

  /** Called when a run ends: its token stops working at once. */
  revokeRun(runId: string): void {
    for (const hash of this.#byRun.get(runId) ?? []) this.#byHash.delete(hash);
    this.#byRun.delete(runId);
  }

  get size(): number {
    return this.#byHash.size;
  }

  /** Where the bridge reaches this server: always this machine, never a public name. */
  #url(): string {
    const port = this.#listeningPort() ?? this.#config.port;
    const bound = this.#config.host;
    const host = bound === '0.0.0.0' || isLoopbackHostname(bound) ? (bound === '::1' ? '[::1]' : '127.0.0.1') : bound === '::' ? '[::1]' : bound.includes(':') ? `[${bound}]` : bound;
    return `${this.#config.tls ? 'https' : 'http'}://${host}:${port}`;
  }

  /**
   * With TLS on, the bridge cannot check the certificate by name (it connects
   * to 127.0.0.1), so it is given the certificate's fingerprint to pin instead.
   */
  #tlsPin(): string | null {
    if (this.#pin === undefined) {
      this.#pin = this.#config.tls ? new X509Certificate(readFileSync(this.#config.tls.certFile)).fingerprint256 : null;
    }
    return this.#pin;
  }

  /**
   * What an adapter needs to launch the bridge: the Node.js binary this
   * server runs on and the bridge script — the TypeScript source when the
   * server itself runs from source, the compiled file otherwise — plus the
   * environment. The environment carries the run's token and nothing else
   * that is secret.
   */
  connection(token: string): BridgeConnection {
    const fromSource = import.meta.url.endsWith('.ts');
    const script = fileURLToPath(new URL(fromSource ? '../../bin/mcp-bridge.ts' : '../../bin/mcp-bridge.js', import.meta.url));
    const pin = this.#tlsPin();
    return {
      command: process.execPath,
      // Node runs the single-file TypeScript source directly by stripping its types.
      args: fromSource ? ['--experimental-strip-types', '--no-warnings', script] : [script],
      env: {
        STUDIO_BRIDGE_URL: this.#url(),
        STUDIO_BRIDGE_TOKEN: token,
        ...(pin === null ? {} : { STUDIO_BRIDGE_TLS_PIN: pin }),
      },
      serverName: BRIDGE_SERVER_NAME,
      permissionPromptTool: PERMISSION_PROMPT_TOOL,
    };
  }
}

const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'x-real-ip', 'via', 'cf-connecting-ip', 'true-client-ip'];

const isLoopbackAddress = (address: string): boolean => {
  const plain = address.replace(/^::ffff:/i, '');
  return plain === '::1' || /^127(\.\d{1,3}){3}$/.test(plain);
};

/**
 * True when the request was made by a process on this machine, directly. A
 * reverse proxy or tunnel on the same host also connects from the loopback
 * interface, so anything carrying a forwarding header is refused: those are
 * requests from somewhere else.
 */
export function isLocalPeer(request: FastifyRequest): boolean {
  const socket = request.raw.socket as Socket | undefined;
  const remote = socket?.remoteAddress;
  if (!remote) return false;
  const local = socket.localAddress;
  if (!isLoopbackAddress(remote) && remote !== local) return false;
  if (PROXY_HEADERS.some((name) => request.headers[name] !== undefined)) return false;
  const host = (request.headers.host ?? '').toLowerCase();
  const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]!;
  return isLoopbackHostname(hostname) || hostname.replace(/^\[|\]$/g, '') === local;
}

const callBody = z.object({
  name: z.string().min(1).max(200),
  arguments: z.unknown().optional(),
});

const permissionPromptInput = z.looseObject({
  tool_name: z.string().min(1).max(200),
  input: z.unknown().optional(),
  tool_use_id: z.string().max(200).optional(),
});

const PERMISSION_PROMPT_DESCRIPTION =
  'Asks the Studio whether a tool call may proceed, waiting for a person when one has to decide. ' +
  'Answers with one line of JSON: {"behavior":"allow","updatedInput":{…}} or {"behavior":"deny","message":"…"}.';

const PERMISSION_PROMPT_SCHEMA = {
  type: 'object',
  properties: {
    tool_name: { type: 'string', description: 'The tool that wants to run.' },
    input: { type: 'object', description: 'The input it would run with.', additionalProperties: true },
    tool_use_id: { type: 'string', description: 'The id of the tool call, when there is one.' },
  },
  required: ['tool_name', 'input'],
  additionalProperties: true,
} as const;

export function registerBridgeRoutes(context: ModuleContext, tokens: BridgeTokens, runs: RunService): void {
  const identify = (request: FastifyRequest): BridgeIdentity => {
    if (!isLocalPeer(request)) throw forbidden('The bridge answers only to this machine.', 'bridge_local_only');
    const token = request.headers[BRIDGE_TOKEN_HEADER];
    const identity = typeof token === 'string' ? tokens.resolve(token) : null;
    if (!identity) throw unauthorized('That bridge token is not valid, or its run has ended.', 'invalid_bridge_token');
    return identity;
  };

  context.http.route({
    method: 'POST',
    url: '/api/bridge/tools/list',
    access: 'self',
    handler: ({ request }) => {
      identify(request);
      return {
        tools: [
          ...runs.studioTools().map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
          { name: PERMISSION_PROMPT_TOOL, description: PERMISSION_PROMPT_DESCRIPTION, inputSchema: PERMISSION_PROMPT_SCHEMA },
        ],
      };
    },
  });

  context.http.route({
    method: 'POST',
    url: '/api/bridge/tools/call',
    access: 'self',
    body: callBody,
    bodyLimit: 16 * 1024 * 1024,
    handler: async ({ request, body }) => {
      const identity = identify(request);
      if (body.name === PERMISSION_PROMPT_TOOL) {
        const parsed = permissionPromptInput.safeParse(body.arguments ?? {});
        const result = parsed.success
          ? await runs.permissionPrompt(identity.runId, {
              toolName: parsed.data.tool_name,
              input: parsed.data.input ?? {},
              toolCallId: parsed.data.tool_use_id ?? null,
            })
          : ({ behavior: 'deny', message: 'The permission request could not be read.' } as const);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false };
      }
      const result = await runs.callStudioTool(identity.runId, body.name, body.arguments ?? {});
      return { content: [{ type: 'text', text: result.text }], isError: result.isError === true };
    },
  });
}
