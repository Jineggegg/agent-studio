import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AuthState } from '@agent-studio/protocol';
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import { loadConfig, type ConfigOverrides } from '../kernel/config.js';
import type { StudioModule } from '../kernel/module.js';
import { createStudio, type Studio } from '../kernel/studio.js';
import { modules as allModules } from '../modules/index.js';

export const TEST_HOST = 'localhost:7420';
export const TEST_ORIGIN = `http://${TEST_HOST}`;
export const TEST_SETUP_TOKEN = 'test-setup-token-0123456789';
export const TEST_PASSWORD = 'correct horse battery staple';

export interface TestResponse<T = unknown> {
  readonly status: number;
  readonly body: T;
  readonly headers: LightMyRequestResponse['headers'];
  readonly raw: LightMyRequestResponse;
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Something that can call the API: anonymous, a browser session, or an API token. */
export class TestClient {
  cookie: string | null = null;
  csrfToken: string | null = null;
  bearer: string | null = null;
  userId: string | null = null;
  readonly #studio: Studio;

  constructor(studio: Studio) {
    this.#studio = studio;
  }

  async request<T = unknown>(method: Method, url: string, body?: unknown, extra: InjectOptions['headers'] = {}): Promise<TestResponse<T>> {
    const headers: Record<string, string> = { host: TEST_HOST };
    if (this.bearer) headers.authorization = `Bearer ${this.bearer}`;
    if (this.cookie) headers.cookie = this.cookie;
    if (method !== 'GET') {
      if (!this.bearer) headers.origin = TEST_ORIGIN;
      if (this.csrfToken) headers['x-studio-csrf'] = this.csrfToken;
    }
    const raw = await this.#studio.app.inject({
      method,
      url,
      headers: { ...headers, ...(extra as Record<string, string>) },
      ...(body === undefined ? {} : { payload: body as object }),
    });
    let parsed: unknown = undefined;
    if (raw.body.length > 0) {
      try {
        parsed = raw.json();
      } catch {
        parsed = raw.body;
      }
    }
    const setCookie = raw.cookies.find((entry) => entry.name.endsWith('studio_session'));
    if (setCookie) this.cookie = setCookie.value ? `${setCookie.name}=${setCookie.value}` : null;
    return { status: raw.statusCode, body: parsed as T, headers: raw.headers, raw };
  }

  get = <T = unknown>(url: string) => this.request<T>('GET', url);
  post = <T = unknown>(url: string, body?: unknown) => this.request<T>('POST', url, body ?? {});
  put = <T = unknown>(url: string, body?: unknown) => this.request<T>('PUT', url, body ?? {});
  patch = <T = unknown>(url: string, body?: unknown) => this.request<T>('PATCH', url, body ?? {});
  delete = <T = unknown>(url: string) => this.request<T>('DELETE', url);

  adopt(state: AuthState): void {
    this.csrfToken = state.csrfToken;
    this.userId = state.user?.id ?? null;
  }
}

export interface TestStudio {
  readonly studio: Studio;
  readonly dataDir: string;
  /** An empty directory, inside the configured workspace roots, for tests to create projects in. */
  readonly workspace: string;
  anonymous(): TestClient;
  /** Creates the owner account on first call and returns a signed-in browser client for it. */
  owner(): Promise<TestClient>;
  /** Creates another account (as the owner) and returns a signed-in browser client for it. */
  member(username?: string): Promise<TestClient>;
  /** A fresh browser session for an existing account. */
  signIn(username: string, password?: string): Promise<TestClient>;
  /** Starts listening on a free port, for tests that need real sockets. */
  listen(): Promise<{ url: string; wsUrl: string; port: number }>;
  close(): Promise<void>;
}

export async function createTestStudio(options: { modules?: readonly StudioModule[]; config?: ConfigOverrides } = {}): Promise<TestStudio> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-studio-test-'));
  const dataDir = path.join(root, 'data');
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace, { recursive: true });

  const config = loadConfig(
    {},
    {
      env: 'test',
      host: '127.0.0.1',
      port: 0,
      dataDir,
      logLevel: 'silent',
      sandbox: 'off',
      setupToken: TEST_SETUP_TOKEN,
      workspaceRoots: [workspace],
      ...options.config,
    },
  );
  const studio = await createStudio(config, options.modules ?? allModules);
  await studio.app.ready();

  let ownerCreated = false;
  let memberCount = 0;

  const signIn = async (username: string, password = TEST_PASSWORD): Promise<TestClient> => {
    const client = new TestClient(studio);
    const response = await client.post<AuthState>('/api/auth/login', { username, password });
    if (response.status !== 200) throw new Error(`Sign-in failed for ${username}: ${JSON.stringify(response.body)}`);
    client.adopt(response.body);
    return client;
  };

  const owner = async (): Promise<TestClient> => {
    if (ownerCreated) return signIn('owner');
    const client = new TestClient(studio);
    const response = await client.post<AuthState>('/api/auth/setup', {
      setupToken: TEST_SETUP_TOKEN,
      username: 'owner',
      password: TEST_PASSWORD,
    });
    if (response.status !== 200) throw new Error(`Setup failed: ${JSON.stringify(response.body)}`);
    client.adopt(response.body);
    ownerCreated = true;
    return client;
  };

  return {
    studio,
    dataDir,
    workspace,
    anonymous: () => new TestClient(studio),
    owner,
    signIn,
    async member(username?: string) {
      const admin = await owner();
      memberCount += 1;
      const name = username ?? `member${memberCount}`;
      const created = await admin.post('/api/users', { username: name, password: TEST_PASSWORD, role: 'member' });
      if (created.status !== 201) throw new Error(`Could not create ${name}: ${JSON.stringify(created.body)}`);
      return signIn(name);
    },
    async listen() {
      const { port } = await studio.start();
      return { url: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}`, port };
    },
    async close() {
      await studio.stop();
      await rm(root, { recursive: true, force: true });
    },
  };
}
