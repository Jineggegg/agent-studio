import { existsSync } from 'node:fs';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AccountProfile } from '@agent-studio/protocol';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { newId } from '../../src/kernel/crypto.js';
import { createAgentsKit, type AgentsKit, until } from '../../src/testing/agents-kit.js';
import { TEST_PASSWORD } from '../../src/testing/harness.js';
let kit: AgentsKit;
beforeAll(async () => {
  kit = await createAgentsKit();
});
afterAll(async () => {
  await kit.close();
});

describe('isolated account credential cleanup', () => {
  it('waits for stopped user processes, removes only the deleted owner, and never follows profile links', async () => {
    expect(
      (
        await kit.owner.post('/api/users', {
          username: 'profile-owner',
          password: TEST_PASSWORD,
          role: 'owner',
        })
      ).status,
    ).toBe(201);
    const other = await kit.t.signIn('profile-owner');
    const own = (
      await kit.owner.post<AccountProfile>('/api/agent-accounts', {
        name: 'Keep',
        agentId: 'codex',
      })
    ).body;
    const doomed = (
      await other.post<AccountProfile>('/api/agent-accounts', { name: 'Remove', agentId: 'codex' })
    ).body;
    const accounts = kit.t.studio.context.services.agents.accounts;
    const keep = await accounts.environment(kit.owner.userId!, own.id);
    const remove = await accounts.environment(other.userId!, doomed.id);
    await writeFile(path.join(keep.directory, 'auth.json'), 'synthetic-kept-credential');
    await writeFile(path.join(remove.directory, 'auth.json'), 'synthetic-deleted-credential');
    await symlink(keep.directory, path.join(remove.directory, 'sibling-link'));
    const session = await kit.session(other);
    kit.agent.script([{ hang: true }]);
    await kit.send(other, session.id, 'Wait until this account is deleted');
    await until(() => kit.agent.runs.some((run) => run.request.sessionId === session.id));
    let release!: () => void;
    const stopped = new Promise<void>((resolve) => {
      release = resolve;
    });
    const terminals = vi
      .spyOn(kit.t.studio.context.services.terminal, 'stopUser')
      .mockReturnValue(stopped);
    try {
      expect((await kit.owner.delete(`/api/users/${other.userId}`)).status).toBe(204);
      expect(terminals).toHaveBeenCalledWith(other.userId);
      expect(existsSync(remove.directory)).toBe(true);
      expect(kit.agent.lastRun.cancelled).toBe(true);
      release();
      await until(() => !existsSync(path.dirname(remove.directory)), {
        what: 'deleted account credentials to be erased',
      });
      expect(await readFile(path.join(keep.directory, 'auth.json'), 'utf8')).toBe(
        'synthetic-kept-credential',
      );
      await expect(accounts.environment(other.userId!, doomed.id)).rejects.toMatchObject({
        status: 404,
      });
      expect(existsSync(path.dirname(remove.directory))).toBe(false);
    } finally {
      release();
      terminals.mockRestore();
    }
  });

  it('sweeps only orphaned generated directories at startup, unlinking unsafe roots without following them', async () => {
    const accounts = kit.t.studio.context.services.agents.accounts;
    const root = path.join(kit.t.dataDir, 'agent-accounts');
    const orphanId = newId(),
      linkedId = newId();
    const orphan = path.join(root, orphanId);
    await mkdir(path.join(orphan, newId()), { recursive: true });
    await writeFile(path.join(orphan, 'leftover.txt'), 'synthetic orphan');
    const survivor = path.join(kit.t.workspace, 'outside-profile-root');
    await mkdir(survivor);
    await writeFile(path.join(survivor, 'keep.txt'), 'outside must survive');
    await symlink(survivor, path.join(root, linkedId));
    await kit.listen();
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(path.join(root, linkedId))).toBe(false);
    expect(await readFile(path.join(survivor, 'keep.txt'), 'utf8')).toBe('outside must survive');
    expect(existsSync(path.join(root, kit.owner.userId!))).toBe(true);
    await expect(accounts.removeUserDirectory('../escape')).rejects.toMatchObject({ status: 409 });
  });
});
