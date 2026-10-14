import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { request } from '@playwright/test';
import { AUTH_FILE, BASE_URL, OWNER, SETUP_TOKEN } from './support/env.js';

/**
 * Creates the owner through the API with the fixed setup token and stores the
 * signed-in browser state, so that most tests start signed in. (Walking the
 * same first run through the UI is first-run.spec.ts, on a server of its own.)
 */
export default async function globalSetup(): Promise<void> {
  const api = await request.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: { origin: BASE_URL },
  });
  try {
    const state = (await (await api.get('/api/auth/state')).json()) as { needsSetup: boolean };
    // A fresh server needs its owner; one that has it (a run started by hand against a kept server) is signed in to.
    const response = state.needsSetup
      ? await api.post('/api/auth/setup', { data: { setupToken: SETUP_TOKEN, ...OWNER } })
      : await api.post('/api/auth/login', {
          data: { username: OWNER.username, password: OWNER.password },
        });
    if (response.status() !== 200) {
      throw new Error(
        `Could not sign the owner in (${response.status()}): ${await response.text()}`,
      );
    }
    await mkdir(path.dirname(AUTH_FILE), { recursive: true });
    await api.storageState({ path: AUTH_FILE });
  } finally {
    await api.dispose();
  }
}
