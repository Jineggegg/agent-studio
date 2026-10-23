import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  AccountProfile,
  Attachment,
  ConversationGroup,
  Session,
  UploadAttachmentsResponse,
} from '@agent-studio/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ScriptedAdapter } from '../../src/testing/scripted-adapter.js';
import { createAgentsKit, type AgentsKit, nextRequestId } from '../../src/testing/agents-kit.js';

let kit: AgentsKit;
beforeAll(async () => {
  kit = await createAgentsKit();
});
afterAll(async () => {
  await kit.close();
});

describe('personal conversation groups', () => {
  it('assigns, filters, renames and removes a group without deleting its sessions', async () => {
    const group = await kit.owner.post<ConversationGroup>('/api/conversation-groups', {
      name: 'Release work',
    });
    expect(group.status).toBe(201);
    const session = await kit.session(kit.owner, { groupId: group.body.id });
    expect(session.groupId).toBe(group.body.id);
    const filtered = await kit.owner.get<{ sessions: Session[] }>(
      `/api/sessions?groupId=${group.body.id}`,
    );
    expect(filtered.body.sessions.map((row) => row.id)).toEqual([session.id]);
    expect(
      (await kit.owner.patch(`/api/conversation-groups/${group.body.id}`, { name: 'Shipped' }))
        .status,
    ).toBe(200);
    expect((await kit.owner.delete(`/api/conversation-groups/${group.body.id}`)).status).toBe(204);
    expect((await kit.owner.get<Session>(`/api/sessions/${session.id}`)).body.groupId).toBeNull();
  });

  it('never lets one person assign or modify another person’s groups', async () => {
    const member = await kit.t.member('group-member');
    await kit.share(kit.project, member);
    const group = (
      await kit.owner.post<ConversationGroup>('/api/conversation-groups', { name: 'Private group' })
    ).body;
    const session = await kit.session(member);
    expect((await member.patch(`/api/sessions/${session.id}`, { groupId: group.id })).status).toBe(
      404,
    );
    expect(
      (await member.patch(`/api/conversation-groups/${group.id}`, { name: 'Stolen' })).status,
    ).toBe(404);
    expect(
      (await member.get<{ groups: ConversationGroup[] }>('/api/conversation-groups')).body.groups,
    ).toEqual([]);
    expect((await kit.t.anonymous().get('/api/conversation-groups')).status).toBe(401);
  });
});

describe('independent conversation branches', () => {
  it('copies a whole transcript and keeps subsequent provider history independent', async () => {
    const source = await kit.session();
    kit.agent.script([{ text: 'Original answer' }]);
    await kit.turn(kit.owner, source.id, 'Original question');
    const before = await kit.events(kit.owner, source.id);
    const fork = await kit.owner.post<Session>(`/api/sessions/${source.id}/fork`, {});
    expect(fork.status).toBe(201);
    expect(fork.body).toMatchObject({
      parentSessionId: source.id,
      chainId: null,
      resumable: false,
      forkedAtSeq: before.at(-1)!.seq,
    });
    const copied = await kit.events(kit.owner, fork.body.id);
    expect(
      copied
        .filter((event) => event.type.startsWith('message.'))
        .map((event) => (event.data as { text: string }).text),
    ).toEqual(['Original question', 'Original answer']);
    kit.agent.script([{ text: 'Branch answer' }]);
    await kit.turn(kit.owner, fork.body.id, 'Only on branch');
    expect(kit.agent.lastRun.request.nativeSessionId).toBeNull();
    expect(kit.agent.lastRun.request.history).toEqual([
      { role: 'user', text: 'Original question' },
      { role: 'assistant', text: 'Original answer' },
    ]);
    expect(await kit.events(kit.owner, source.id)).toEqual(before);
  });

  it('copies sent attachment bytes so deleting the original leaves the branch intact', async () => {
    const source = await kit.session();
    const upload = await kit.owner.request<UploadAttachmentsResponse>(
      'POST',
      `/api/sessions/${source.id}/attachments`,
      Buffer.from(
        '--branch-test\r\ncontent-disposition: form-data; name="files"; filename="notes.txt"\r\ncontent-type: text/plain\r\n\r\nIndependent attachment\r\n--branch-test--\r\n',
      ),
      { 'content-type': 'multipart/form-data; boundary=branch-test' },
    );
    expect(upload.status).toBe(201);
    await kit.turn(kit.owner, source.id, 'Read this', {
      attachmentIds: [upload.body.attachments[0]!.id],
    });
    const branch = (await kit.owner.post<Session>(`/api/sessions/${source.id}/fork`, {})).body;
    const files = (
      await kit.owner.get<{ attachments: Attachment[] }>(
        `/api/sessions/${branch.id}/attachments?pending=false`,
      )
    ).body.attachments;
    expect(files).toHaveLength(1);
    expect(files[0]!.id).not.toBe(upload.body.attachments[0]!.id);
    expect((await kit.owner.delete(`/api/sessions/${source.id}`)).status).toBe(204);
    expect((await kit.owner.get(files[0]!.url)).body).toBe('Independent attachment');
  });

  it('branches at a selected message and edits only a new branch', async () => {
    const source = await kit.session();
    kit.agent.script([{ text: 'first answer' }]);
    await kit.turn(kit.owner, source.id, 'first question');
    kit.agent.script([{ text: 'old answer' }]);
    await kit.turn(kit.owner, source.id, 'old second question');
    const before = await kit.events(kit.owner, source.id);
    const second = before.find(
      (event) => event.type === 'message.user' && event.data.text === 'old second question',
    )!;
    kit.agent.script([{ text: 'new answer' }]);
    const edited = await kit.owner.post<Session>(`/api/sessions/${source.id}/fork`, {
      throughSeq: second.seq,
      replacement: { text: 'replacement question', requestId: nextRequestId() },
    });
    expect(edited.status).toBe(201);
    await kit.idle(kit.owner, edited.body.id);
    const texts = (await kit.events(kit.owner, edited.body.id))
      .filter((event) => event.type.startsWith('message.'))
      .map((event) => (event.data as { text: string }).text);
    expect(texts).toEqual(['first question', 'first answer', 'replacement question', 'new answer']);
    expect(await kit.events(kit.owner, source.id)).toEqual(before);
    expect(
      (await kit.owner.post(`/api/sessions/${source.id}/fork`, { throughSeq: 9999 })).status,
    ).toBe(404);
    const member = await kit.t.member('fork-member');
    await kit.share(kit.project, member);
    expect((await member.post(`/api/sessions/${source.id}/fork`, {})).status).toBe(404);
  });
});

describe('account profile bindings and fast mode', () => {
  it('creates empty isolated homes and keeps old sessions bound when the default switches', async () => {
    const first = await kit.owner.post<AccountProfile>('/api/agent-accounts', {
      agentId: 'codex',
      name: 'Work',
    });
    const second = await kit.owner.post<AccountProfile>('/api/agent-accounts', {
      agentId: 'codex',
      name: 'Personal',
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(JSON.stringify(first.body)).not.toMatch(/credential|directory|token|secret/);
    const accounts = kit.t.studio.context.services.agents.accounts;
    const firstEnv = await accounts.environment(kit.owner.userId!, first.body.id);
    const secondEnv = await accounts.environment(kit.owner.userId!, second.body.id);
    expect(firstEnv.env.CODEX_HOME).not.toBe(secondEnv.env.CODEX_HOME);
    const agents = kit.t.studio.context.services.agents;
    const installed = agents.adapter('codex')!;
    agents.unregisterAdapter('codex');
    const simulated = new ScriptedAdapter({ id: 'codex' });
    agents.registerAdapter(simulated);
    await kit.owner.put(`/api/agent-accounts/${first.body.id}/default`, {});
    const old = await kit.owner.post<Session>('/api/sessions', {
      projectId: kit.project.id,
      agentId: 'codex',
    });
    expect(old.status).toBe(201);
    await kit.owner.put(`/api/agent-accounts/${second.body.id}/default`, {});
    const fresh = await kit.owner.post<Session>('/api/sessions', {
      projectId: kit.project.id,
      agentId: 'codex',
    });
    expect(fresh.body.accountProfileId).toBe(second.body.id);
    await kit.turn(kit.owner, old.body.id, 'Use original profile');
    expect(simulated.lastRun.request.accountEnvironment?.CODEX_HOME).toBe(firstEnv.directory);
    await kit.turn(kit.owner, fresh.body.id, 'Use selected profile');
    expect(simulated.lastRun.request.accountEnvironment?.CODEX_HOME).toBe(secondEnv.directory);
    expect(
      (await kit.owner.get<Session>(`/api/sessions/${old.body.id}`)).body.accountProfileId,
    ).toBe(first.body.id);
    const member = await kit.t.member('profile-member');
    await kit.share(kit.project, member);
    expect(
      (
        await member.post('/api/sessions', {
          projectId: kit.project.id,
          agentId: 'codex',
          accountProfileId: first.body.id,
        })
      ).status,
    ).toBe(404);
    expect((await member.get(`/api/agent-accounts/${first.body.id}/status`)).status).toBe(404);
    agents.unregisterAdapter('codex');
    agents.registerAdapter(installed);
  });

  it('rejects fast mode when the installed adapter does not advertise it', async () => {
    const session = await kit.session();
    expect((await kit.owner.patch(`/api/sessions/${session.id}`, { fastMode: true })).status).toBe(
      422,
    );
    expect((await kit.owner.get<Session>(`/api/sessions/${session.id}`)).body.fastMode).toBe(false);
  });
});

describe('message-linked file checkpoints', () => {
  it('captures before an approved edit and requires an explicit current version to restore', async () => {
    const root = kit.project.rootDir;
    const file = path.join(root, 'checkpoint.txt');
    await writeFile(file, 'before edit\n');
    const session = await kit.session(kit.owner, { permissionMode: 'accept-edits' });
    kit.agent.script([
      { permission: { toolName: 'Edit', kind: 'edit', paths: [file], input: { path: file } } },
      { text: 'done' },
    ]);
    await kit.turn(kit.owner, session.id, 'Edit this file');
    await writeFile(file, 'after edit\n');
    const message = (await kit.events(kit.owner, session.id)).find(
      (event) => event.type === 'message.user',
    )!;
    type Preview = {
      files: Array<{ id: string; before: string; current: string; currentVersion: string }>;
    };
    const preview = (
      await kit.owner.get<Preview>(
        `/api/sessions/${session.id}/messages/${message.seq}/checkpoints`,
      )
    ).body;
    expect(preview.files).toHaveLength(1);
    expect(preview.files[0]).toMatchObject({ before: 'before edit\n', current: 'after edit\n' });
    const checkpoint = preview.files[0]!;
    expect(
      (
        await kit.owner.post(`/api/sessions/${session.id}/checkpoints/${checkpoint.id}/restore`, {
          currentVersion: checkpoint.currentVersion,
        })
      ).status,
    ).toBe(400);
    await writeFile(file, 'concurrent change\n');
    expect(
      (
        await kit.owner.post(`/api/sessions/${session.id}/checkpoints/${checkpoint.id}/restore`, {
          currentVersion: checkpoint.currentVersion,
          confirm: true,
        })
      ).status,
    ).toBe(409);
    const current = (
      await kit.owner.get<Preview>(
        `/api/sessions/${session.id}/messages/${message.seq}/checkpoints`,
      )
    ).body.files[0]!;
    expect(
      (
        await kit.owner.post(`/api/sessions/${session.id}/checkpoints/${checkpoint.id}/restore`, {
          currentVersion: current.currentVersion,
          confirm: true,
        })
      ).status,
    ).toBe(200);
    expect(await readFile(file, 'utf8')).toBe('before edit\n');
  });

  it('excludes credential paths and skips whole secret-bearing snapshots and previews', async () => {
    const root = kit.project.rootDir;
    const blocked = [
      '.npmrc',
      '.netrc',
      '.git-credentials',
      'id_rsa',
      'id_ed25519',
      '.aws/config',
      '.azure/profile',
      '.kube/config',
      '.docker/config.json',
      '.config/gh/hosts.yml',
      '.config/gcloud/config',
      '.claude/settings.json',
      '.codex/auth.json',
    ];
    for (const relative of blocked) {
      await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
      await writeFile(path.join(root, relative), 'plain text still belongs to a credential path');
    }
    const synthetic = 'access_token = ghp_AbCdEf0123456789AbCdEf0123456789';
    const ordinary = path.join(root, 'ordinary-settings.txt');
    await writeFile(ordinary, synthetic);
    const session = await kit.session(kit.owner, { permissionMode: 'accept-edits' });
    kit.agent.script([
      {
        permission: {
          toolName: 'Edit',
          kind: 'edit',
          paths: [ordinary],
          input: {},
        },
      },
      { text: 'Nothing copied' },
    ]);
    await kit.turn(kit.owner, session.id, 'Test checkpoint exclusions');
    expect(
      kit.t.studio.context.db.all(
        'SELECT * FROM agent_file_checkpoints WHERE session_id = ?',
        session.id,
      ),
    ).toEqual([]);
    const service = kit.t.studio.context.services.agents.checkpoints;
    await service.capture(
      session.id,
      kit.agent.lastRun.request.runId,
      kit.owner.userId!,
      kit.project.id,
      blocked,
    );
    expect(
      kit.t.studio.context.db.all(
        'SELECT * FROM agent_file_checkpoints WHERE session_id = ?',
        session.id,
      ),
    ).toEqual([]);
    for (const relative of blocked)
      await expect(service.safePath(root, relative)).rejects.toMatchObject({ status: 403 });
    const safe = path.join(root, 'becomes-secret.txt');
    await writeFile(safe, 'safe original');
    const changing = await kit.session(kit.owner, { permissionMode: 'accept-edits' });
    kit.agent.script([
      { permission: { toolName: 'Edit', kind: 'edit', paths: [safe], input: {} } },
      { text: 'Captured safe content' },
    ]);
    await kit.turn(kit.owner, changing.id, 'Capture only safe text');
    const message = (await kit.events(kit.owner, changing.id)).find(
      (event) => event.type === 'message.user',
    )!;
    const before = await kit.owner.get<{ files: Array<{ id: string; currentVersion: string }> }>(
      `/api/sessions/${changing.id}/messages/${message.seq}/checkpoints`,
    );
    expect(before.body.files).toHaveLength(1);
    await writeFile(safe, synthetic);
    const preview = await kit.owner.get<{ files: unknown[] }>(
      `/api/sessions/${changing.id}/messages/${message.seq}/checkpoints`,
    );
    expect(preview.body.files).toEqual([]);
    expect(JSON.stringify(preview.body)).not.toContain(synthetic);
    expect(
      (
        await kit.owner.post(
          `/api/sessions/${changing.id}/checkpoints/${before.body.files[0]!.id}/restore`,
          { confirm: true, currentVersion: before.body.files[0]!.currentVersion },
        )
      ).status,
    ).toBe(403);
    expect(await readFile(safe, 'utf8')).toBe(synthetic);
    expect(
      JSON.stringify(kit.t.studio.context.db.all('SELECT content FROM agent_file_checkpoints')),
    ).not.toContain(synthetic);
  });

  it('refuses symlinks, credential files and path escapes without claiming a checkpoint', async () => {
    const root = kit.project.rootDir;
    const outside = path.join(kit.t.workspace, 'outside.txt');
    await writeFile(outside, 'not in project');
    await symlink(outside, path.join(root, 'escape.txt'));
    await writeFile(path.join(root, '.env'), 'private setting');
    const session = await kit.session();
    const service = kit.t.studio.context.services.agents.checkpoints;
    await expect(service.safePath(root, '../outside.txt')).rejects.toMatchObject({ status: 403 });
    await expect(service.safePath(root, 'escape.txt')).rejects.toMatchObject({ status: 403 });
    await expect(service.safePath(root, '.env')).rejects.toMatchObject({ status: 403 });
    expect(session.id).toBeTruthy();
  });
});
