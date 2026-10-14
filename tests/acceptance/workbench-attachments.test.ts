import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiClient, RunningStudio } from './support/studio.js';
import {
  assistantText,
  createMember,
  createProject,
  createSession,
  postMessage,
  runEnded,
  runToEnd,
  shareProject,
  startAgentStudio,
  transcript,
  type ErrorBody,
  type Json,
  type Project,
} from './support/workbench.js';

/**
 * 6.2 — Attachments (requirements 01 §6.2, §5.15, §7.1.3).
 *
 * A file is uploaded to a session first and gets an id; a message then names
 * ids, never paths. Limits: ten files a message, 10 MB a file. A file is
 * served back only to someone who can see the session — as a download, unless
 * it is a verified raster image.
 */

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
    '1f15c4890000000d4944415478da63fccfc0500f0004850181' +
    'f2b6f6d00000000049454e44ae426082',
  'hex',
);

interface Uploaded {
  attachments: Array<{
    id: string;
    name: string;
    size: number;
    mediaType: string;
    isImage: boolean;
    url: string;
    pending: boolean;
    sessionId: string;
  }>;
  rejected: Array<{ name: string; code: string; message: string }>;
}

function form(
  files: Array<{ name: string; content: string | Buffer | Uint8Array; type?: string }>,
): FormData {
  const data = new FormData();
  for (const file of files) {
    const bytes = typeof file.content === 'string' ? Buffer.from(file.content) : file.content;
    data.append(
      'files',
      new Blob([new Uint8Array(bytes)], { type: file.type ?? 'text/plain' }),
      file.name,
    );
  }
  return data;
}

describe('6.2 attachments', () => {
  let studio: RunningStudio;
  let owner: ApiClient;
  let project: Project;

  beforeAll(async () => {
    studio = await startAgentStudio();
    owner = await studio.owner();
    project = await createProject(studio, owner, 'attachments');
  });
  afterAll(() => studio?.destroy());

  const upload = (client: ApiClient, sessionId: string, files: Parameters<typeof form>[0]) =>
    client.post<Uploaded>(`/api/sessions/${sessionId}/attachments`, form(files));
  const pending = async (client: ApiClient, sessionId: string) =>
    (
      await client.get<{ attachments: Uploaded['attachments'] }>(
        `/api/sessions/${sessionId}/attachments?pending=true`,
      )
    ).body.attachments;

  it('WB-013: an uploaded file is listed as pending, goes out with the message that names it, and the agent can read it', async () => {
    const session = await createSession(owner, project.id);
    const uploaded = await upload(owner, session.id, [
      { name: 'notes.txt', content: 'the code word is heliotrope' },
      { name: 'pixel.png', content: PNG, type: 'image/png' },
    ]);
    expect(uploaded.status).toBe(201);
    expect(uploaded.body.rejected).toEqual([]);
    const [notes, pixel] = uploaded.body.attachments;
    expect(notes).toMatchObject({
      name: 'notes.txt',
      size: 27,
      isImage: false,
      pending: true,
      sessionId: session.id,
    });
    expect(pixel).toMatchObject({
      name: 'pixel.png',
      mediaType: 'image/png',
      isImage: true,
      pending: true,
    });
    expect((await pending(owner, session.id)).map((item) => item.id).sort()).toEqual(
      [notes!.id, pixel!.id].sort(),
    );

    const run = await runToEnd(
      owner,
      session.id,
      'read what I attached [[scenario:read-attachment]]',
      { attachmentIds: [notes!.id, pixel!.id] },
    );
    expect(run.status).toBe('completed');
    const user = (await transcript(owner, session.id)).find(
      (event) => event.type === 'message.user',
    )!;
    expect(user.data.attachments.map((item: Json) => item.name)).toEqual([
      'notes.txt',
      'pixel.png',
    ]);
    expect(JSON.stringify(await transcript(owner, session.id))).toContain(
      'the code word is heliotrope',
    ); // the agent really read the file
    // Sent: no longer pending, and not sendable a second time.
    expect(await pending(owner, session.id)).toEqual([]);
    const again = await postMessage(owner, session.id, 'same file again', {
      attachmentIds: [notes!.id],
    });
    expect(again.status).toBe(422);
    expect(again.body.error.code).toBe('attachment_already_sent');
    // A message may consist of an attachment alone.
    const more = await upload(owner, session.id, [
      { name: 'alone.txt', content: 'no words needed' },
    ]);
    const wordless = await owner.post<Json>(`/api/sessions/${session.id}/messages`, {
      requestId: 'wordless-0001',
      text: '',
      attachmentIds: [more.body.attachments[0]!.id],
    });
    expect(wordless.status).toBe(202);
    await runEnded(owner, wordless.body.runId);
  });

  it('AT-WB-015: of twelve files dropped at once, one of them 11 MB, at most ten are taken, the oversized one is refused by name, and the rest can be sent', async () => {
    const session = await createSession(owner, project.id);
    const files = Array.from({ length: 11 }, (_unused, index) => ({
      name: `small-${index + 1}.txt`,
      content: `file ${index + 1}`,
    }));
    const big = {
      name: 'huge.bin',
      content: new Uint8Array(11 * 1024 * 1024),
      type: 'application/octet-stream',
    };
    const uploaded = await upload(owner, session.id, [
      ...files.slice(0, 5),
      big,
      ...files.slice(5),
    ]);
    expect(uploaded.status).toBe(201);
    expect(uploaded.body.attachments.map((item) => item.name)).toEqual(
      files.slice(0, 10).map((file) => file.name),
    );
    expect(uploaded.body.rejected.map((item) => `${item.name}: ${item.code}`)).toEqual([
      'huge.bin: attachment_too_large',
      'small-11.txt: too_many_attachments',
    ]);
    expect(uploaded.body.rejected.every((item) => item.message.length > 5)).toBe(true);

    // The ten that were taken can be sent together; an eleventh in one message cannot.
    const ids = uploaded.body.attachments.map((item) => item.id);
    const extra = await upload(owner, session.id, [{ name: 'one-more.txt', content: 'eleventh' }]);
    expect(extra.body.attachments).toHaveLength(1);
    const eleven = await postMessage(owner, session.id, 'too many', {
      attachmentIds: [...ids, extra.body.attachments[0]!.id],
    });
    expect(eleven.status).toBe(400);
    const ten = await postMessage(owner, session.id, 'just enough', { attachmentIds: ids });
    expect(ten.status).toBe(202);
    await runEnded(owner, ten.body.runId);
    expect((await pending(owner, session.id)).map((item) => item.name)).toEqual(['one-more.txt']);
    // An empty file is refused by name too.
    const mixed = await upload(owner, session.id, [
      { name: 'nothing.txt', content: '' },
      { name: 'something.txt', content: 'x' },
    ]);
    expect(
      mixed.body.rejected.map((item) => `${item.name}: ${item.code}`),
      JSON.stringify(mixed.body),
    ).toEqual(['nothing.txt: attachment_empty']);
    expect(mixed.body.attachments.map((item) => item.name)).toEqual(['something.txt']);
  });

  it('AT-WB-017 (adapted): a file attached in one session and not sent belongs to that session only, and stays removed once removed', async () => {
    const a = await createSession(owner, project.id);
    const b = await createSession(owner, project.id);
    const [file] = (
      await upload(owner, a.id, [{ name: 'draft.png', content: PNG, type: 'image/png' }])
    ).body.attachments;
    expect(await pending(owner, b.id)).toEqual([]);
    expect((await pending(owner, a.id)).map((item) => item.id)).toEqual([file!.id]);
    // It cannot be sent from the other session …
    const crossed = await postMessage(owner, b.id, 'borrowing', { attachmentIds: [file!.id] });
    expect(crossed.status).toBe(422);
    // … nor fetched through it.
    expect((await owner.get(`/api/sessions/${b.id}/attachments/${file!.id}`)).status).toBe(404);
    expect(
      (await owner.delete(`/api/sessions/${a.id}/attachments/${file!.id}`)).status,
    ).toBeLessThan(300);
    expect(await pending(owner, a.id)).toEqual([]); // "after a reload" — the server no longer has it
    expect((await owner.get(`/api/sessions/${a.id}/attachments/${file!.id}`)).status).toBe(404);
    expect(
      (await postMessage(owner, a.id, 'with the removed file', { attachmentIds: [file!.id] }))
        .status,
    ).toBe(422);
    expect(await transcript(owner, a.id)).toEqual([]);
  });

  it('AT-WB-018: a send can name only uploaded files by id — a path, or an id that was never uploaded, is refused and nothing reaches the agent', async () => {
    const session = await createSession(owner, project.id);
    for (const foreign of [
      '/etc/passwd',
      '../../etc/passwd',
      `${studio.dataDir}/studio.db`,
      'file:///etc/passwd',
    ]) {
      const response = await postMessage(
        owner,
        session.id,
        'read this [[scenario:read-attachment]]',
        { attachmentIds: [foreign] },
      );
      expect(response.status, foreign).toBe(400);
    }
    const unknown = await postMessage(owner, session.id, 'read this [[scenario:read-attachment]]', {
      attachmentIds: ['0123456789abcdefghjkmnpqrs'],
    });
    expect(unknown.status).toBe(422);
    // Extra fields that look like file references are not a way in either.
    const sneaky = await owner.post<Json>(`/api/sessions/${session.id}/messages`, {
      requestId: 'sneaky-0001',
      text: 'what did you get? [[scenario:echo-prompt]]',
      attachments: [{ path: '/etc/passwd', name: 'passwd' }],
      files: ['/etc/passwd'],
    });
    expect([202, 400]).toContain(sneaky.status);
    if (sneaky.status === 202) {
      await runEnded(owner, sneaky.body.runId);
      expect(await assistantText(owner, session.id)).not.toContain('/etc/passwd');
      expect(
        (await transcript(owner, session.id)).find((event) => event.type === 'message.user')!.data
          .attachments,
      ).toEqual([]);
    }
  });

  it('AT-WB-143 (adapted): a stored file is served only by its id, only to those who can see the session, and never in a form a browser would run', async () => {
    const session = await createSession(owner, project.id);
    const uploaded = await upload(owner, session.id, [
      { name: 'page.html', content: '<script>alert(1)</script>', type: 'text/html' },
      {
        name: 'drawing.svg',
        content: '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
        type: 'image/svg+xml',
      },
      { name: 'fake.png', content: '<script>alert(1)</script>', type: 'image/png' },
      { name: 'real.png', content: PNG, type: 'image/png' },
    ]);
    const [html, svg, fake, real] = uploaded.body.attachments;
    expect([html!.isImage, svg!.isImage, fake!.isImage, real!.isImage]).toEqual([
      false,
      false,
      false,
      true,
    ]); // a declared type is believed only when the bytes agree

    for (const file of [html!, svg!, fake!]) {
      const served = await owner.get<string>(file.url);
      expect(served.status).toBe(200);
      expect(served.headers.get('content-disposition')).toMatch(/^attachment;/);
      expect(served.headers.get('content-type')).toBe('application/octet-stream');
      expect(served.headers.get('x-content-type-options')).toBe('nosniff');
    }
    const image = await owner.get(real!.url);
    expect(image.headers.get('content-type')).toBe('image/png');
    expect(image.headers.get('content-disposition')).toMatch(/^inline;/);
    expect(image.headers.get('x-content-type-options')).toBe('nosniff');

    // Not by any other name.
    for (const name of [
      '..%2f..%2f..%2fetc%2fpasswd',
      '%2e%2e%2f%2e%2e%2fstudio.db',
      'real.png',
      `${real!.id}%2f..%2f..`,
    ]) {
      const response = await owner.get(`/api/sessions/${session.id}/attachments/${name}`);
      expect([400, 404], name).toContain(response.status);
    }
    // Not without signing in, and not to another member of the same project.
    expect((await studio.client().get(real!.url)).status).toBe(401);
    const colleague = await createMember(studio, owner, 'colleague');
    await shareProject(owner, project.id, colleague.userId!, 'write');
    expect((await colleague.get(real!.url)).status).toBe(404);
    expect((await colleague.get(`/api/sessions/${session.id}/attachments`)).status).toBe(404);
    const planted = await upload(colleague, session.id, [
      { name: 'planted.txt', content: 'not mine to add' },
    ]);
    expect(planted.status).toBe(404);
    expect(
      (await colleague.delete<ErrorBody>(`/api/sessions/${session.id}/attachments/${real!.id}`))
        .status,
    ).toBe(404);
    expect((await pending(owner, session.id)).map((item) => item.name)).toEqual([
      'page.html',
      'drawing.svg',
      'fake.png',
      'real.png',
    ]);
  });

  it('WB-013: the name a file was uploaded with is for display only — it cannot choose where the file is stored', async () => {
    const session = await createSession(owner, project.id);
    const uploaded = await upload(owner, session.id, [
      { name: '../../../escape.txt', content: 'contained' },
    ]);
    expect(uploaded.status).toBe(201);
    const [file] = uploaded.body.attachments;
    expect(file!.name).toBe('escape.txt');
    expect(file!.url).toBe(`/api/sessions/${session.id}/attachments/${file!.id}`);
    expect((await owner.get<string>(file!.url)).body).toBe('contained');
    // What the agent is told is a path inside the session's own upload folder.
    const run = await runToEnd(owner, session.id, 'where is it? [[scenario:echo-prompt]]', {
      attachmentIds: [file!.id],
    });
    const prompt = await assistantText(owner, session.id, run.id);
    expect(prompt).toContain('escape.txt');
    expect(prompt).not.toContain('../');
  });
});
