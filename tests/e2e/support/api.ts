import { type APIRequestContext, request } from '@playwright/test';
import { AUTH_FILE, BASE_URL } from './env.js';

export interface ProjectInfo {
  readonly id: string;
  readonly name: string;
  readonly rootDir: string;
}

/**
 * The owner's session, used from the test runner for set-up that is not what
 * a test is about (a project to work in, a known starting point). It sends
 * what the browser would: the session cookie, Origin and the anti-forgery token.
 */
export class StudioApi {
  private constructor(
    readonly context: APIRequestContext,
    private readonly csrfToken: string,
  ) {}

  static async signedIn(storageState: string = AUTH_FILE): Promise<StudioApi> {
    const context = await request.newContext({
      baseURL: BASE_URL,
      storageState,
      extraHTTPHeaders: { origin: BASE_URL },
    });
    const state = (await (await context.get('/api/auth/state')).json()) as {
      authenticated: boolean;
      csrfToken: string | null;
    };
    if (!state.authenticated || !state.csrfToken) {
      await context.dispose();
      throw new Error(
        'The stored owner session is not signed in: did the global setup run against this server?',
      );
    }
    return new StudioApi(context, state.csrfToken);
  }

  async call<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    data?: unknown,
  ): Promise<T> {
    const response = await this.context.fetch(url, {
      method,
      headers: { 'x-studio-csrf': this.csrfToken },
      ...(data === undefined ? {} : { data }),
    });
    if (!response.ok())
      throw new Error(`${method} ${url} answered ${response.status()}: ${await response.text()}`);
    return (response.status() === 204 ? undefined : await response.json()) as T;
  }

  /** A project whose conversations start with the demo agent (the stand-in Claude Code is listed first otherwise). */
  createProject(input: {
    name: string;
    rootDir: string;
    createDirectory?: boolean;
    agents?: readonly string[] | null;
  }): Promise<ProjectInfo> {
    return this.call<ProjectInfo>('POST', '/api/projects', {
      name: input.name,
      rootDir: input.rootDir,
      createDirectory: input.createDirectory ?? true,
      agents: input.agents === undefined ? ['demo'] : input.agents,
    });
  }

  /** Account preferences (theme, language, …); `null` removes one. */
  setPreferences(values: Record<string, unknown>): Promise<unknown> {
    return this.call('PATCH', '/api/preferences', { values });
  }

  dispose(): Promise<void> {
    return this.context.dispose();
  }
}
