import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Project } from '@agent-studio/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ClaudeKit, createClaudeKit } from '../../src/modules/claude-code/testing/kit.js';

/**
 * The credentials of the account the Studio runs as — SSH keys, the GitHub
 * CLI's token, the other agent's sign-in, … — are hidden from Claude Code by
 * the sandbox unless the project's owner switched the project's
 * `agentCredentials` feature on. Its own configuration, which holds its
 * sign-in, always stays.
 */
describe("the account's credentials and Claude Code, inside the Studio's sandbox", () => {
  let c: ClaudeKit;
  let sandboxed = false;
  let ssh: string;
  let key: string;
  let gh: string;
  let codex: string;
  let own: string;
  const NO_SANDBOX = 'bubblewrap is not usable on this machine, so hiding credentials could not be tested here';

  beforeAll(async () => {
    c = await createClaudeKit({ config: { sandbox: 'auto' } });
    sandboxed = c.kit.t.studio.context.sandbox.status.mode === 'bwrap';
    ssh = path.join(c.home, '.ssh');
    key = path.join(ssh, 'id_ed25519');
    gh = path.join(c.home, '.config', 'gh', 'hosts.yml');
    codex = path.join(c.home, '.codex', 'auth.json');
    own = path.join(c.home, '.claude', 'kept.json');
    for (const file of [key, gh, codex, own]) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, 'a secret');
    }
  });
  afterAll(async () => {
    await c.close();
  });

  /** What the CLI can read: `false` for a file that is not there, the number of entries for a folder. */
  const canRead = async (sessionId: string): Promise<Record<string, boolean | number>> => {
    const run = await c.turn(sessionId, `[[scenario:inspect ${key} ${ssh} ${gh} ${codex} ${own}]]`);
    expect(run.status).toBe('completed');
    const report = JSON.parse((await c.texts(sessionId)).at(-1)!) as { canRead: Record<string, boolean | number> };
    return report.canRead;
  };
  const setFlag = async (value: boolean): Promise<void> => {
    const response = await c.owner.patch<Project>(`/api/projects/${c.kit.project.id}`, { features: { agentCredentials: value } });
    expect(response.body.features.agentCredentials).toBe(value);
  };

  it('are not there for a run by default — all but Claude Code\'s own configuration', async ({ skip }) => {
    skip(!sandboxed, NO_SANDBOX);
    const session = await c.session();
    expect(await canRead(session.id)).toEqual({ [key]: false, [ssh]: 0, [gh]: false, [codex]: false, [own]: true });
    // Outside the run nothing changed.
    expect(readFileSync(key, 'utf8')).toBe('a secret');
  });

  it('are there once the owner of the project allows agents to use them', async ({ skip }) => {
    skip(!sandboxed, NO_SANDBOX);
    await setFlag(true);
    try {
      const session = await c.session();
      expect(await canRead(session.id)).toEqual({ [key]: true, [ssh]: 1, [gh]: true, [codex]: true, [own]: true });
    } finally {
      await setFlag(false);
    }
  });

  it('are not there for a run outside any project, whatever a project allows', async ({ skip }) => {
    skip(!sandboxed, NO_SANDBOX);
    // The runtime gives a coding agent no session without a project, so the request is made to look like one:
    // the project allows credentials, and the run reaches the adapter with no project named.
    await setFlag(true);
    const adapter = c.kit.t.studio.context.services.agents.adapter('claude-code')!;
    const run = adapter.run.bind(adapter);
    adapter.run = (request, host) => run({ ...request, projectId: null }, host);
    try {
      const session = await c.session();
      expect(await canRead(session.id)).toEqual({ [key]: false, [ssh]: 0, [gh]: false, [codex]: false, [own]: true });
    } finally {
      adapter.run = run;
      await setFlag(false);
    }
  });
});
