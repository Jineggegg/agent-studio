import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Attachment, MessageReceipt, UploadAttachmentsResponse } from '@agent-studio/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AgentsKit, createAgentsKit, nextRequestId, until } from '../../src/testing/agents-kit.js';
import type { TestClient, TestResponse } from '../../src/testing/harness.js';

let kit: AgentsKit;
beforeAll(async () => {
  kit = await createAgentsKit();
});
afterAll(async () => {
  await kit.close();
});

interface Part {
  name: string;
  type?: string;
  content: Buffer | string;
  field?: string;
}

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest of a picture')]);
const MB = 1024 * 1024;

function multipart(parts: Part[]): { body: Buffer; headers: Record<string, string> } {
  const boundary = `----studio-test-${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(
      Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="${part.field ?? 'files'}"; filename="${part.name}"\r\ncontent-type: ${part.type ?? 'application/octet-stream'}\r\n\r\n`),
      typeof part.content === 'string' ? Buffer.from(part.content) : part.content,
      Buffer.from('\r\n'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

function upload(client: TestClient, sessionId: string, parts: Part[]): Promise<TestResponse<UploadAttachmentsResponse & { error?: { code: string; message: string; details?: { rejected: unknown[] } } }>> {
  const form = multipart(parts);
  return client.request('POST', `/api/sessions/${sessionId}/attachments`, form.body, form.headers);
}

const storeDir = (sessionId: string): string => path.join(kit.t.dataDir, 'attachments', sessionId);

describe('attachments', () => {
  it('stores uploads under generated names and hands them to the agent with the message', async () => {
    const { owner, agent } = kit;
    const session = await kit.session();
    const response = await upload(owner, session.id, [
      { name: 'screenshot.png', type: 'image/png', content: PNG },
      { name: 'notes.txt', type: 'text/plain', content: 'remember the milk' },
    ]);
    expect(response.status).toBe(201);
    expect(response.body.rejected).toEqual([]);
    const [image, notes] = response.body.attachments;
    expect(image).toMatchObject({ name: 'screenshot.png', mediaType: 'image/png', isImage: true, size: PNG.length, pending: true, sessionId: session.id });
    expect(notes).toMatchObject({ name: 'notes.txt', mediaType: 'text/plain', isImage: false, size: 17, pending: true });
    expect(image!.url).toBe(`/api/sessions/${session.id}/attachments/${image!.id}`);

    // On disk: one folder per session, names the server made up, readable by the service account only.
    const stored = readdirSync(storeDir(session.id)).sort();
    expect(stored).toEqual([`${image!.id}.png`, `${notes!.id}.txt`].sort());
    expect(stored.join()).not.toContain('screenshot');
    if (process.platform !== 'win32') {
      expect(statSync(path.join(storeDir(session.id), stored[0]!)).mode & 0o077).toBe(0);
      expect(statSync(storeDir(session.id)).mode & 0o077).toBe(0);
    }
    expect((await owner.get<{ attachments: Attachment[] }>(`/api/sessions/${session.id}/attachments`)).body.attachments.map((entry) => entry.id)).toEqual([image!.id, notes!.id]);

    const run = await kit.turn(owner, session.id, 'what is in these?', { attachmentIds: [image!.id, notes!.id] });
    expect(run.status).toBe('completed');
    const given = agent.lastRun.request.prompt.attachments;
    expect(given.map((entry) => ({ name: entry.name, mediaType: entry.mediaType, isImage: entry.isImage }))).toEqual([
      { name: 'screenshot.png', mediaType: 'image/png', isImage: true },
      { name: 'notes.txt', mediaType: 'text/plain', isImage: false },
    ]);
    // Absolute paths inside the data directory, which the adapter must expose to its sandbox.
    expect(given[0]!.path).toBe(path.join(storeDir(session.id), `${image!.id}.png`));
    expect(readFileSync(given[1]!.path, 'utf8')).toBe('remember the milk');

    // The transcript shows them with the message; they are no longer pending and cannot go out twice.
    const events = await kit.events(owner, session.id);
    expect(events[0]).toMatchObject({ type: 'message.user', data: { attachments: [{ id: image!.id, name: 'screenshot.png', isImage: true }, { id: notes!.id, name: 'notes.txt' }] } });
    expect((await owner.get<{ attachments: Attachment[] }>(`/api/sessions/${session.id}/attachments`)).body.attachments).toEqual([]);
    expect((await owner.get<{ attachments: Attachment[] }>(`/api/sessions/${session.id}/attachments?pending=false`)).body.attachments).toHaveLength(2);
    const again = await owner.post(`/api/sessions/${session.id}/messages`, { requestId: nextRequestId(), text: 'again', attachmentIds: [image!.id] });
    expect(again.status).toBe(422);
    expect(again.body).toMatchObject({ error: { code: 'attachment_already_sent' } });
    expect((await owner.delete(`/api/sessions/${session.id}/attachments/${image!.id}`)).status).toBe(409);
  });

  it('accepts a message that is only an attachment, and travels with a queued message', async () => {
    const { owner, agent } = kit;
    const session = await kit.session();
    const first = (await upload(owner, session.id, [{ name: 'a.txt', content: 'a' }])).body.attachments[0]!;
    agent.script([{ gate: 'attachment-queue' }]);
    const running = await owner.post<MessageReceipt>(`/api/sessions/${session.id}/messages`, { requestId: nextRequestId(), attachmentIds: [first.id] });
    expect(running.status).toBe(202);
    await agent.reached('attachment-queue');
    const second = (await upload(owner, session.id, [{ name: 'b.txt', content: 'b' }])).body.attachments[0]!;
    const queued = await kit.send(owner, session.id, 'and this one', { attachmentIds: [second.id] });
    expect(queued.body.disposition).toBe('queued');
    expect((await kit.state(owner, session.id)).queue[0]!.attachments).toEqual([expect.objectContaining({ id: second.id, name: 'b.txt' })]);
    agent.open('attachment-queue');
    await until(() => agent.runs.filter((run) => run.request.sessionId === session.id).length === 2);
    await kit.idle(owner, session.id);
    expect(agent.lastRun.request.prompt).toMatchObject({ text: 'and this one', attachments: [{ id: second.id, name: 'b.txt' }] });
  });

  it('refuses a file over 10 MB by itself and keeps the others', async () => {
    const { owner } = kit;
    const session = await kit.session();
    const response = await upload(owner, session.id, [
      { name: 'small.bin', content: Buffer.alloc(1024, 1) },
      { name: 'huge.bin', content: Buffer.alloc(10 * MB + 1, 2) },
      { name: 'exactly.bin', content: Buffer.alloc(10 * MB, 3) },
    ]);
    expect(response.status).toBe(201);
    expect(response.body.attachments.map((entry) => [entry.name, entry.size])).toEqual([
      ['small.bin', 1024],
      ['exactly.bin', 10 * MB],
    ]);
    expect(response.body.rejected).toEqual([{ name: 'huge.bin', code: 'attachment_too_large', message: '"huge.bin" is larger than 10 MB.' }]);
    // Nothing of the refused file is left on disk.
    expect(readdirSync(storeDir(session.id))).toHaveLength(2);

    const alone = await upload(owner, session.id, [{ name: 'huge.bin', content: Buffer.alloc(10 * MB + 1, 2) }]);
    expect(alone.status).toBe(413);
    expect(alone.body).toMatchObject({ error: { code: 'attachment_too_large', message: '"huge.bin" is larger than 10 MB.' } });
    expect(readdirSync(storeDir(session.id))).toHaveLength(2);
  });

  it('takes at most ten files per upload and per message', async () => {
    const { owner } = kit;
    const session = await kit.session();
    const twelve = Array.from({ length: 12 }, (_unused, index) => ({ name: `file-${index + 1}.txt`, content: `content ${index + 1}` }));
    const response = await upload(owner, session.id, twelve);
    expect(response.status).toBe(201);
    expect(response.body.attachments.map((entry) => entry.name)).toEqual(twelve.slice(0, 10).map((part) => part.name));
    expect(response.body.rejected.map((entry) => [entry.name, entry.code])).toEqual([
      ['file-11.txt', 'too_many_attachments'],
      ['file-12.txt', 'too_many_attachments'],
    ]);
    const extra = (await upload(owner, session.id, [{ name: 'eleventh.txt', content: 'x' }])).body.attachments[0]!;
    const tooMany = await owner.post(`/api/sessions/${session.id}/messages`, { requestId: nextRequestId(), text: 'all of them', attachmentIds: [...response.body.attachments.map((entry) => entry.id), extra.id] });
    expect(tooMany.status).toBe(400);
    // The eleventh can be removed again before anything is sent.
    expect((await owner.delete(`/api/sessions/${session.id}/attachments/${extra.id}`)).status).toBe(204);
    expect(readdirSync(storeDir(session.id))).toHaveLength(10);
    expect((await kit.turn(owner, session.id, 'ten is fine', { attachmentIds: response.body.attachments.map((entry) => entry.id) })).status).toBe('completed');
    expect(kit.agent.lastRun.request.prompt.attachments).toHaveLength(10);
  });

  it('refuses uploads that are empty, not files, or not multipart', async () => {
    const { owner } = kit;
    const session = await kit.session();
    expect((await upload(owner, session.id, [])).body).toMatchObject({ error: { code: 'no_files' } });
    expect((await upload(owner, session.id, [{ name: 'empty.txt', content: '' }])).body).toMatchObject({ error: { code: 'attachment_empty' } });
    const json = await owner.post(`/api/sessions/${session.id}/attachments`, { file: 'not a file' });
    expect(json.status).toBe(400);
    expect(json.body).toMatchObject({ error: { code: 'not_multipart' } });
    const lying = await owner.request('POST', `/api/sessions/${session.id}/attachments`, Buffer.from('x'), {
      'content-type': 'multipart/form-data; boundary=x',
      'content-length': String(200 * MB),
    });
    expect([400, 413]).toContain(lying.status);
    expect(existsSync(storeDir(session.id)) ? readdirSync(storeDir(session.id)) : []).toEqual([]);
  });

  it('never lets a file name or an id reach the file system', async () => {
    const { owner } = kit;
    const session = await kit.session();
    const hostile = await upload(owner, session.id, [
      { name: '../../../../etc/cron.d/evil', content: 'pwned' },
      { name: '..\\\\..\\\\windows\\\\system.ini', content: 'pwned' },
      { name: 'innocent.txt\u0000.sh', content: 'pwned' },
      { name: '.htaccess', content: 'pwned' },
      { name: 'x.' + 'a'.repeat(40), content: 'long extension' },
    ]);
    expect(hostile.status).toBe(201);
    expect(hostile.body.attachments).toHaveLength(5);
    const stored = readdirSync(storeDir(session.id));
    expect(stored).toHaveLength(5);
    for (const name of stored) expect(name).toMatch(/^[0-9a-z]{26}(\.[a-z0-9]{1,10})?$/);
    // Display names lose their directories; nothing was written anywhere else.
    expect(hostile.body.attachments.map((entry) => entry.name)).toEqual(['evil', 'system.ini', expect.stringMatching(/^innocent\.txt/), '.htaccess', expect.stringMatching(/^x\.a+$/)]);
    expect(existsSync('/etc/cron.d/evil')).toBe(false);
    expect(readdirSync(path.join(kit.t.dataDir, 'attachments')).every((entry) => /^[0-9a-z]{26}$/.test(entry))).toBe(true);

    // Fetching is by id only: nothing that is not an id is even looked up.
    for (const id of ['..%2F..%2Fstudio.db', '../../studio.db', 'studio.db', '%2e%2e', `${hostile.body.attachments[0]!.id}%2F..`, 'a'.repeat(26).toUpperCase()]) {
      const response = await owner.get(`/api/sessions/${session.id}/attachments/${id}`);
      expect([400, 404], id).toContain(response.status);
    }
    expect((await owner.get(`/api/sessions/${session.id}/attachments/00000000000000000000000000`)).status).toBe(404);
    // An attachment belongs to its session: another session of the same user cannot fetch or send it.
    const other = await kit.session();
    const id = hostile.body.attachments[0]!.id;
    expect((await owner.get(`/api/sessions/${other.id}/attachments/${id}`)).status).toBe(404);
    const foreign = await owner.post(`/api/sessions/${other.id}/messages`, { requestId: nextRequestId(), text: 'borrowed', attachmentIds: [id] });
    expect(foreign.status).toBe(422);
    expect(foreign.body).toMatchObject({ error: { code: 'attachment_not_found' } });
    expect((await owner.delete(`/api/sessions/${other.id}/attachments/${id}`)).status).toBe(404);
  });

  it('serves a file back as data: images inline when they really are images, everything else as a download', async () => {
    const { owner } = kit;
    const session = await kit.session();
    const html = '<script>alert(document.cookie)</script>';
    const uploaded = await upload(owner, session.id, [
      { name: 'real.png', type: 'image/png', content: PNG },
      { name: 'fake.png', type: 'image/png', content: html },
      { name: 'page.html', type: 'text/html', content: html },
      { name: 'drawing.svg', type: 'image/svg+xml', content: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' },
      { name: '报告 final.pdf', type: 'application/pdf', content: '%PDF-1.7' },
      { name: 'weird', type: 'text/html; charset=utf-8\r\nx-injected: 1', content: 'x' },
    ]);
    const [real, fake, page, svg, pdf, weird] = uploaded.body.attachments;
    // A declared image type is believed only when the bytes agree.
    expect([real!.mediaType, real!.isImage]).toEqual(['image/png', true]);
    expect([fake!.mediaType, fake!.isImage]).toEqual(['application/octet-stream', false]);
    expect(svg!.isImage).toBe(false);

    const fetched = await owner.get(real!.url);
    expect(fetched.status).toBe(200);
    expect(fetched.headers['content-type']).toBe('image/png');
    expect(fetched.headers['content-disposition']).toBe(`inline; filename="real.png"; filename*=UTF-8''real.png`);
    expect(fetched.headers['x-content-type-options']).toBe('nosniff');
    expect(fetched.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(fetched.raw.rawPayload.equals(PNG)).toBe(true);

    for (const entry of [fake!, page!, svg!, pdf!, weird!]) {
      const response = await owner.get(entry.url);
      expect(response.status, entry.name).toBe(200);
      expect(response.headers['content-type'], entry.name).toBe('application/octet-stream');
      expect(String(response.headers['content-disposition']), entry.name).toMatch(/^attachment; /);
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['x-injected']).toBeUndefined();
    }
    expect((await owner.get(page!.url)).raw.payload).toBe(html);
    expect((await owner.get(pdf!.url)).headers['content-disposition']).toBe(`attachment; filename="__ final.pdf"; filename*=UTF-8''${encodeURIComponent('报告 final.pdf')}`);
    expect(weird!.mediaType).toBe('text/html');
  });

  it('serves and accepts files only for people who can see the session', async () => {
    const { owner } = kit;
    const member = await kit.t.member('uploader');
    const outsider = await kit.t.member('outsider');
    await kit.share(kit.project, member);
    await kit.share(kit.project, outsider);
    const session = await kit.session(member);
    const mine = (await upload(member, session.id, [{ name: 'private.txt', content: 'for my eyes' }])).body.attachments[0]!;

    expect((await member.get(mine.url)).raw.payload).toBe('for my eyes');
    // The instance owner can see the session, so can fetch — but not add to it.
    expect((await owner.get(mine.url)).status).toBe(200);
    expect((await upload(owner, session.id, [{ name: 'x.txt', content: 'x' }])).status).toBe(403);
    for (const client of [outsider, kit.t.anonymous()]) {
      const expected = client === outsider ? 404 : 401;
      expect((await client.get(mine.url)).status).toBe(expected);
      expect((await upload(client, session.id, [{ name: 'x.txt', content: 'x' }])).status).toBe(expected);
      expect((await client.get(`/api/sessions/${session.id}/attachments`)).status).toBe(expected);
    }
    expect(JSON.stringify((await outsider.get(mine.url)).body)).not.toContain('for my eyes');
    // A browser session without the anti-forgery token cannot upload.
    const form = multipart([{ name: 'x.txt', content: 'x' }]);
    const forged = await kit.t.studio.app.inject({
      method: 'POST',
      url: `/api/sessions/${session.id}/attachments`,
      headers: { host: 'localhost:7420', origin: 'http://localhost:7420', cookie: member.cookie!, ...form.headers },
      payload: form.body,
    });
    expect(forged.statusCode).toBe(403);
    // Taken off the project, the uploader cannot fetch their own file any more.
    await owner.delete(`/api/projects/${kit.project.id}/members/${member.userId}`);
    expect((await member.get(mine.url)).status).toBe(404);
    expect(readdirSync(storeDir(session.id))).toHaveLength(1);
  });

  it('removes the files when the session is deleted', async () => {
    const { owner } = kit;
    const session = await kit.session();
    const uploaded = await upload(owner, session.id, [{ name: 'a.txt', content: 'a' }, { name: 'b.txt', content: 'b' }]);
    await kit.turn(owner, session.id, 'with one of them', { attachmentIds: [uploaded.body.attachments[0]!.id] });
    expect(readdirSync(storeDir(session.id))).toHaveLength(2);
    expect((await owner.delete(`/api/sessions/${session.id}`)).status).toBe(204);
    expect(existsSync(storeDir(session.id))).toBe(false);
    expect((await owner.get(uploaded.body.attachments[0]!.url)).status).toBe(404);
  });
});
