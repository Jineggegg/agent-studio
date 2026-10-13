import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Black-box harness. It starts the server as a separate process — the built
 * one by default, exactly as an operator would run it — and talks to it only
 * over HTTP and WebSocket. Nothing here imports server code.
 *
 *   ACCEPTANCE_SERVER=src   run the TypeScript sources through tsx instead of
 *                           the build output (handy while developing)
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const SETUP_TOKEN = 'acceptance-setup-token-0001';

/** How to invoke the server's entry point (also used for operator commands). */
export function serverCommand(): { args: string[]; env: Record<string, string> } {
  if (process.env.ACCEPTANCE_SERVER === 'src') {
    return {
      args: ['--import', 'tsx', path.join(repoRoot, 'apps/server/src/main.ts')],
      env: { TSX_TSCONFIG_PATH: path.join(repoRoot, 'apps/server/tsconfig.json') },
    };
  }
  return { args: [path.join(repoRoot, 'apps/server/dist/main.js')], env: {} };
}
export const OWNER = { username: 'owner', password: 'acceptance passphrase 1' };

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

export interface ApiResponse<T = unknown> {
  readonly status: number;
  readonly body: T;
  readonly headers: Headers;
}

/** A browser-like client: keeps the session cookie, sends Origin and the anti-forgery token. */
export class ApiClient {
  cookie: string | null = null;
  csrfToken: string | null = null;
  bearer: string | null = null;
  userId: string | null = null;
  /** Override to imitate requests coming from another site. */
  origin: string;

  constructor(readonly baseUrl: string) {
    this.origin = baseUrl;
  }

  async request<T = unknown>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<ApiResponse<T>> {
    const send: Record<string, string> = { ...headers };
    if (this.bearer) send.authorization = `Bearer ${this.bearer}`;
    if (this.cookie) send.cookie = this.cookie;
    if (method !== 'GET' && !this.bearer && send.origin === undefined) send.origin = this.origin;
    if (method !== 'GET' && this.csrfToken && send['x-studio-csrf'] === undefined) send['x-studio-csrf'] = this.csrfToken;
    if (body !== undefined && !(body instanceof FormData)) send['content-type'] = 'application/json';
    const response = await fetch(this.baseUrl + url, {
      method,
      headers: send,
      redirect: 'manual',
      ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }),
    });
    for (const header of response.headers.getSetCookie()) {
      const [pair] = header.split(';');
      const [name, value] = pair!.split('=');
      if (name!.endsWith('studio_session')) this.cookie = value ? `${name}=${value}` : null;
    }
    const text = await response.text();
    let parsed: unknown = text;
    if (text.length > 0 && response.headers.get('content-type')?.includes('json')) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    } else if (text.length === 0) {
      parsed = undefined;
    }
    return { status: response.status, body: parsed as T, headers: response.headers };
  }

  get = <T = unknown>(url: string, headers?: Record<string, string>) => this.request<T>('GET', url, undefined, headers);
  post = <T = unknown>(url: string, body: unknown = {}, headers?: Record<string, string>) => this.request<T>('POST', url, body, headers);
  put = <T = unknown>(url: string, body: unknown = {}) => this.request<T>('PUT', url, body);
  patch = <T = unknown>(url: string, body: unknown = {}) => this.request<T>('PATCH', url, body);
  delete = <T = unknown>(url: string) => this.request<T>('DELETE', url);

  private adopt(state: { csrfToken?: string | null; user?: { id: string } | null }): void {
    this.csrfToken = state.csrfToken ?? null;
    this.userId = state.user?.id ?? null;
  }

  async setup(credentials = OWNER, setupToken = SETUP_TOKEN): Promise<ApiResponse> {
    const response = await this.post<{ csrfToken: string; user: { id: string } }>('/api/auth/setup', { setupToken, ...credentials });
    if (response.status === 200) this.adopt(response.body);
    return response;
  }

  async login(credentials = OWNER): Promise<ApiResponse> {
    const response = await this.post<{ csrfToken: string; user: { id: string } }>('/api/auth/login', credentials);
    if (response.status === 200) this.adopt(response.body);
    return response;
  }
}

export interface RunningStudio {
  readonly url: string;
  readonly wsUrl: string;
  readonly port: number;
  readonly dataDir: string;
  /** An empty directory inside the configured workspace root, for creating projects. */
  readonly workspace: string;
  client(): ApiClient;
  /** Creates the owner on first call; afterwards returns a fresh signed-in browser. */
  owner(): Promise<ApiClient>;
  /** Everything the server has written to stdout and stderr so far. */
  output(): string;
  stop(): Promise<void>;
  /** Stops and starts the server on the same data directory and port. */
  restart(): Promise<void>;
  /** Stops the server and deletes its data. */
  destroy(): Promise<void>;
}

export interface StartOptions {
  /** Extra AGENT_STUDIO_* settings. */
  readonly env?: Readonly<Record<string, string>>;
  /** A directory to put first on PATH (fake agent CLIs, a fake gh, …). */
  readonly binDir?: string;
}

/**
 * Like {@link startStudio} but runs the server in `test` env, which only raises
 * the Fastify rate-limit plugin's ceilings (see docs/configuration.md: test env
 * "relax[es] nothing security-relevant"). The per-account lockout and
 * per-address sign-in throttles live in the auth module, not that plugin, so
 * they still fire at their real thresholds — which is what lets a functional
 * test make many requests without the generic limiter getting in the way.
 * Use plain {@link startStudio} when a test means to observe the limiter itself.
 */
export async function startTestStudio(options: StartOptions = {}): Promise<RunningStudio> {
  return startStudio({ ...options, env: { AGENT_STUDIO_ENV: 'test', ...(options.env ?? {}) } });
}

export async function startStudio(options: StartOptions = {}): Promise<RunningStudio> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-studio-acceptance-'));
  const dataDir = path.join(root, 'data');
  const workspace = path.join(root, 'workspace');
  const home = path.join(root, 'home');
  await mkdir(workspace, { recursive: true });
  await mkdir(home, { recursive: true });
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;

  const useSources = process.env.ACCEPTANCE_SERVER === 'src';
  const built = path.join(repoRoot, 'apps/server/dist/main.js');
  if (!useSources && !existsSync(built)) {
    throw new Error('The server is not built. Run `npm run build` first, or set ACCEPTANCE_SERVER=src.');
  }
  const command = useSources
    ? [process.execPath, '--import', 'tsx', path.join(repoRoot, 'apps/server/src/main.ts')]
    : [process.execPath, built];

  let output = '';
  let child: ChildProcess | null = null;
  let ownerCreated = false;

  const start = async (): Promise<void> => {
    child = spawn(command[0]!, command.slice(1), {
      cwd: repoRoot,
      env: {
        // A deliberately small environment: the server must not need more.
        PATH: [options.binDir, process.env.PATH].filter(Boolean).join(path.delimiter),
        HOME: home,
        LANG: 'C.UTF-8',
        AGENT_STUDIO_PORT: String(port),
        AGENT_STUDIO_DATA_DIR: dataDir,
        AGENT_STUDIO_WORKSPACE_ROOTS: workspace,
        AGENT_STUDIO_SETUP_TOKEN: SETUP_TOKEN,
        AGENT_STUDIO_LOG_LEVEL: 'warn',
        ...(useSources ? { TSX_TSCONFIG_PATH: path.join(repoRoot, 'apps/server/tsconfig.json') } : {}),
        ...options.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout!.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr!.on('data', (chunk: Buffer) => (output += chunk.toString()));
    const exited = new Promise<never>((_resolve, reject) =>
      child!.once('exit', (code) => reject(new Error(`The server exited with code ${code} during start-up.\n${output}`))),
    );
    const ready = (async () => {
      for (let attempt = 0; attempt < 300; attempt += 1) {
        const ok = await fetch(`${url}/api/health`).then((response) => response.ok, () => false);
        if (ok) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`The server did not become healthy within 30 seconds.\n${output}`);
    })();
    await Promise.race([ready, exited]);
    child.removeAllListeners('exit');
  };

  const stop = async (): Promise<void> => {
    const running = child;
    child = null;
    if (!running || running.exitCode !== null) return;
    const closed = new Promise<void>((resolve) => running.once('close', () => resolve()));
    running.kill('SIGTERM');
    const force = setTimeout(() => running.kill('SIGKILL'), 8000);
    await closed;
    clearTimeout(force);
  };

  await start();

  return {
    url,
    wsUrl: `ws://127.0.0.1:${port}`,
    port,
    dataDir,
    workspace,
    client: () => new ApiClient(url),
    async owner() {
      const client = new ApiClient(url);
      const response = ownerCreated ? await client.login() : await client.setup();
      if (response.status !== 200) throw new Error(`Could not sign the owner in: ${JSON.stringify(response.body)}`);
      ownerCreated = true;
      return client;
    },
    output: () => output,
    stop,
    async restart() {
      await stop();
      await start();
    },
    async destroy() {
      await stop();
      await rm(root, { recursive: true, force: true });
    },
  };
}
