import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ExternalConversation, Session } from '@agent-studio/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readExternalMessages } from '../../src/modules/agents/external-sessions.js';
import { createAgentsKit, type AgentsKit } from '../../src/testing/agents-kit.js';

let kit: AgentsKit;
beforeAll(async () => {
  kit = await createAgentsKit();
});
afterAll(async () => {
  await kit.close();
});
const claude = (role: 'user' | 'assistant', text: string) =>
  JSON.stringify({
    type: role,
    sessionId: 'external-native-id',
    message: { role, content: [{ type: 'text', text }] },
  });

describe('external transcript import', () => {
  it('extracts only human and assistant prose from public JSONL formats', () => {
    expect(
      readExternalMessages(
        [
          claude('user', 'Question'),
          '{not json}',
          JSON.stringify({
            type: 'assistant',
            message: {
              role: 'assistant',
              content: [{ type: 'tool_use', name: 'shell', input: { command: 'do not run' } }],
            },
          }),
          claude('assistant', 'Answer'),
        ].join('\n'),
        'claude-code',
      ),
    ).toEqual([
      { role: 'user', text: 'Question' },
      { role: 'assistant', text: 'Answer' },
    ]);
    expect(
      readExternalMessages(
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Codex question' }],
          },
        }),
        'codex',
      ),
    ).toEqual([{ role: 'user', text: 'Codex question' }]);
    expect(
      readExternalMessages(
        JSON.stringify({
          type: 'response_item',
          payload: { type: 'function_call', role: 'assistant', content: 'do not run' },
        }),
        'codex',
      ),
    ).toEqual([]);
  });

  it('discovers opted-in bounded metadata and imports an independent owned copy exactly once', async () => {
    const directory = path.join(kit.t.workspace, 'external-cli');
    await mkdir(directory);
    const original = `${claude('user', 'Imported question')}\n${claude('assistant', 'Imported answer')}\n`;
    const file = path.join(directory, 'conversation.jsonl');
    await writeFile(file, original);
    await writeFile(path.join(directory, 'auth.json'), '{"private":"never a transcript"}');
    await writeFile(path.join(directory, 'oversize.jsonl'), Buffer.alloc(2 * 1024 * 1024 + 1));
    const outside = path.join(kit.t.workspace, 'outside.jsonl');
    await writeFile(outside, `${claude('user', 'outside should never appear')}\n`);
    await symlink(outside, path.join(directory, 'symlink.jsonl'));
    const configured = await kit.owner.post<{ id: string }>('/api/external-conversation-roots', {
      name: 'CLI export',
      agentId: 'claude-code',
      directory,
    });
    expect(configured.status).toBe(201);
    const rootId = configured.body.id;
    const discovered = await kit.owner.get<{ conversations: ExternalConversation[] }>(
      `/api/external-conversation-roots/${rootId}/conversations`,
    );
    expect(discovered.body.conversations).toHaveLength(1);
    const source = discovered.body.conversations[0]!;
    expect(source.title).toBe('Imported question');
    expect(JSON.stringify(source)).not.toContain(directory);
    expect(JSON.stringify(source)).not.toContain('external-native-id');
    const request = { projectId: kit.project.id, sourceId: source.id, version: source.version };
    const imported = await kit.owner.post<Session>(
      `/api/external-conversation-roots/${rootId}/import`,
      request,
    );
    expect(imported.status).toBe(201);
    expect(imported.body).toMatchObject({
      agentId: 'claude-code',
      resumable: false,
      userId: kit.owner.userId,
    });
    const texts = (await kit.events(kit.owner, imported.body.id))
      .filter((event) => event.type.startsWith('message.'))
      .map((event) => (event.data as { text: string }).text);
    expect(texts).toEqual(['Imported question', 'Imported answer']);
    expect(
      (await kit.owner.post<Session>(`/api/external-conversation-roots/${rootId}/import`, request))
        .body.id,
    ).toBe(imported.body.id);
    expect(await readFile(file, 'utf8')).toBe(original);
    await writeFile(file, `${original}${claude('user', 'New turn')}\n`);
    expect(
      (await kit.owner.post(`/api/external-conversation-roots/${rootId}/import`, request)).status,
    ).toBe(409);
    const member = await kit.t.member('external-member');
    await kit.share(kit.project, member);
    expect(
      (await member.get(`/api/external-conversation-roots/${rootId}/conversations`)).status,
    ).toBe(403);
    expect(
      (await member.post(`/api/external-conversation-roots/${rootId}/import`, request)).status,
    ).toBe(403);
    expect(
      (
        await kit.owner.post(`/api/external-conversation-roots/${rootId}/import`, {
          ...request,
          sourceId: '../outside.jsonl',
        })
      ).status,
    ).toBe(400);
  });

  it('rejects symlink roots and application data before any scanning', async () => {
    const directory = path.join(kit.t.workspace, 'safe-source');
    await mkdir(directory);
    const linked = path.join(kit.t.workspace, 'linked-source');
    await symlink(directory, linked);
    for (const unsafe of [linked, kit.t.dataDir, path.dirname(kit.t.dataDir)]) {
      expect(
        (
          await kit.owner.post('/api/external-conversation-roots', {
            name: 'Unsafe',
            agentId: 'codex',
            directory: unsafe,
          })
        ).status,
      ).toBe(403);
    }
  });
});
