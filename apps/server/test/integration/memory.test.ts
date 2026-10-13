import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  MEMORY_CHANGED,
  MEMORY_ERRORS,
  type MemoryFoldersResponse,
  type MemoryListResponse,
  type MemoryNote,
  type MemoryReindexResponse,
  type MemorySearchResponse,
  type MemoryStatus,
  type MemoryTagsResponse,
  type Project,
} from '@agent-studio/protocol';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestStudio, type TestClient, type TestStudio } from '../../src/testing/harness.js';

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

const query = (params: Record<string, string | number | undefined>) =>
  `?${new URLSearchParams(
    Object.entries(params)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]): [string, string] => [key, String(value)]),
  ).toString()}`;

const memoryDir = (t: TestStudio) => path.join(t.dataDir, 'memory');
const noteFile = (t: TestStudio, id: string) => `${path.join(memoryDir(t), ...id.split('/'))}.md`;

async function makeProject(t: TestStudio, directory: string, name = directory): Promise<Project> {
  const owner = await t.owner();
  const response = await owner.post<Project>('/api/projects', { name, rootDir: path.join(t.workspace, directory), createDirectory: true });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body;
}

async function share(t: TestStudio, project: Project, member: TestClient, access: 'read' | 'write') {
  const owner = await t.owner();
  expect((await owner.put(`/api/projects/${project.id}/members/${member.userId}`, { access })).status).toBe(204);
}

async function save(client: TestClient, folder: string, title: string, body: string, extra: { tags?: string[]; keywords?: string[] } = {}): Promise<MemoryNote> {
  const response = await client.post<MemoryNote>('/api/memory/notes', { folder, title, body, ...extra });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body;
}

/** Puts a file into the store the way a person with an editor would. */
async function put(t: TestStudio, id: string, content: string | Uint8Array, modifiedAt?: number): Promise<void> {
  const file = noteFile(t, id);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  if (modifiedAt !== undefined) await utimes(file, new Date(modifiedAt), new Date(modifiedAt));
}

const handNote = (title: string, body: string, updated: number, extra = '') =>
  `---\ntitle: ${title}\ntags: []\n${extra}created: ${new Date(updated).toISOString()}\nupdated: ${new Date(updated).toISOString()}\n---\n\n${body}\n`;

const read = (client: TestClient, id: string) => client.get<MemoryNote>(`/api/memory/note${query({ id })}`);
const list = (client: TestClient, params: Record<string, string | number | undefined> = {}) => client.get<MemoryListResponse>(`/api/memory/notes${query(params)}`);
const search = (client: TestClient, q: string, params: Record<string, string | number | undefined> = {}) =>
  client.get<MemorySearchResponse>(`/api/memory/search${query({ q, ...params })}`);
const folders = async (client: TestClient) => (await client.get<MemoryFoldersResponse>('/api/memory/folders')).body;

describe('who may see and change what', () => {
  let t: TestStudio;
  let owner: TestClient;
  let alice: TestClient;
  let alpha: Project;
  let beta: Project;
  let alphaNote: MemoryNote;
  let betaNote: MemoryNote;
  let globalNote: MemoryNote;

  beforeAll(async () => {
    t = await createTestStudio();
    owner = await t.owner();
    alice = await t.member('alice');
    alpha = await makeProject(t, 'alpha');
    beta = await makeProject(t, 'beta');
    alphaNote = await save(owner, 'alpha', 'Alpha deploy rules', 'Alpha ships on Tuesdays through the zebra pipeline.', { tags: ['alphatag'] });
    betaNote = await save(owner, 'beta', 'Beta topology', 'Beta talks to the internal host walrus.corp.example.', { tags: ['betatag'] });
    globalNote = await save(owner, 'global', 'House style', 'Write commit messages in the imperative.');
  });
  afterAll(async () => {
    await t.close();
  });

  it('refuses every memory capability without a sign-in', async () => {
    const anonymous = t.anonymous();
    const responses = await Promise.all([
      anonymous.get('/api/memory/status'),
      anonymous.get('/api/memory/folders'),
      anonymous.get('/api/memory/notes'),
      anonymous.get('/api/memory/search?q=deploy'),
      anonymous.get('/api/memory/tags'),
      anonymous.get(`/api/memory/note${query({ id: globalNote.id })}`),
      anonymous.post('/api/memory/notes', { folder: 'global', title: 'x', body: 'y' }),
      anonymous.put('/api/memory/note', { id: globalNote.id, baseVersion: globalNote.version, body: 'changed' }),
      anonymous.post('/api/memory/note/move', { id: globalNote.id, title: 'renamed' }),
      anonymous.delete(`/api/memory/note${query({ id: globalNote.id })}`),
      anonymous.put('/api/memory/settings', { agentAccess: false }),
      anonymous.post('/api/memory/reindex'),
    ]);
    for (const response of responses) {
      expect(response.status, response.raw.payload).toBe(401);
      expect(response.body).toMatchObject({ error: { code: 'unauthorized' } });
    }
    expect((await read(owner, globalNote.id)).body.body).toBe('Write commit messages in the imperative.');
  });

  it('marks every answer as not cacheable', async () => {
    for (const url of ['/api/memory/status', '/api/memory/folders', '/api/memory/notes', '/api/memory/search?q=deploy', `/api/memory/note${query({ id: globalNote.id })}`]) {
      const response = await owner.get(url);
      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
    }
  });

  it('shows a member without a project nothing of that project: its folder is the same as no folder', async () => {
    expect((await folders(alice)).folders.map((folder) => folder.name)).toEqual(['global']);

    // Reading: a hidden note and a note that does not exist give the very same answer.
    const hidden = await read(alice, alphaNote.id);
    const missing = await read(alice, 'nowhere/nothing');
    const missingInVisible = await read(alice, 'global/nothing');
    expect(hidden.status).toBe(404);
    expect(hidden.body).toEqual(missing.body);
    expect(hidden.body).toEqual(missingInVisible.body);
    expect(hidden.body).toMatchObject({ error: { code: MEMORY_ERRORS.noteNotFound } });

    // Listing and searching.
    const recent = (await list(alice)).body;
    expect(recent.notes.map((note) => note.id)).toEqual([globalNote.id]);
    expect(recent.total).toBe(1);
    for (const term of ['zebra', 'walrus', 'Alpha deploy rules', 'alphatag', 'Tuesdays']) {
      expect((await search(alice, term)).body, term).toMatchObject({ hits: [], total: 0 });
    }
    const hiddenFolder = await list(alice, { folder: 'alpha' });
    const missingFolder = await list(alice, { folder: 'nowhere' });
    expect(hiddenFolder.status).toBe(404);
    expect(hiddenFolder.body).toEqual(missingFolder.body);
    expect((await search(alice, 'zebra', { folder: 'alpha' })).body).toEqual((await search(alice, 'zebra', { folder: 'nowhere' })).body);
    expect((await search(alice, 'zebra', { folder: 'alpha' })).status).toBe(404);
    expect((await alice.get<MemoryTagsResponse>('/api/memory/tags')).body.tags).toEqual([]);
    expect((await alice.get(`/api/memory/tags${query({ folder: 'alpha' })}`)).status).toBe(404);

    // Writing, moving, deleting.
    const createHidden = await alice.post<ErrorBody>('/api/memory/notes', { folder: 'alpha', title: 'Intruder', body: 'text' });
    const createMissing = await alice.post<ErrorBody>('/api/memory/notes', { folder: 'nowhere', title: 'Intruder', body: 'text' });
    expect(createHidden.status).toBe(404);
    expect(createHidden.body).toEqual(createMissing.body);
    expect(createHidden.body.error.code).toBe(MEMORY_ERRORS.folderNotFound);
    expect((await alice.put('/api/memory/note', { id: alphaNote.id, baseVersion: alphaNote.version, body: 'defaced' })).body).toEqual(hidden.body);
    expect((await alice.post('/api/memory/note/move', { id: alphaNote.id, title: 'Stolen' })).body).toEqual(hidden.body);
    expect((await alice.delete(`/api/memory/note${query({ id: alphaNote.id })}`)).body).toEqual(hidden.body);
    expect((await alice.delete(`/api/memory/note${query({ id: alphaNote.id })}`)).status).toBe(404);

    expect(existsSync(noteFile(t, 'alpha/intruder'))).toBe(false);
    expect((await read(owner, alphaNote.id)).body).toMatchObject({ title: 'Alpha deploy rules', body: 'Alpha ships on Tuesdays through the zebra pipeline.', version: alphaNote.version });
    expect((await alice.get<MemoryStatus>('/api/memory/status')).body).toMatchObject({ notes: 1, folders: 1, location: null, skippedFiles: null });
  });

  it('lets a read-only member read a project folder and change nothing in it', async () => {
    const bob = await t.member('bob');
    await share(t, alpha, bob, 'read');

    expect((await folders(bob)).folders).toEqual([
      expect.objectContaining({ name: 'global', kind: 'global', access: 'read' }),
      expect.objectContaining({ name: 'alpha', kind: 'project', access: 'read', count: 1, project: expect.objectContaining({ id: alpha.id, name: 'alpha' }) }),
    ]);
    const note = (await read(bob, alphaNote.id)).body;
    expect(note).toMatchObject({ body: 'Alpha ships on Tuesdays through the zebra pipeline.', access: 'read' });
    expect((await search(bob, 'zebra')).body.hits.map((hit) => hit.id)).toEqual([alphaNote.id]);
    expect((await read(bob, betaNote.id)).status).toBe(404);

    const refusals = [
      await bob.post<ErrorBody>('/api/memory/notes', { folder: 'alpha', title: 'From Bob', body: 'text' }),
      await bob.put<ErrorBody>('/api/memory/note', { id: alphaNote.id, baseVersion: note.version, body: 'changed by Bob' }),
      await bob.post<ErrorBody>('/api/memory/note/move', { id: alphaNote.id, title: 'Renamed by Bob' }),
      await bob.delete<ErrorBody>(`/api/memory/note${query({ id: alphaNote.id })}`),
    ];
    for (const refusal of refusals) {
      expect(refusal.status).toBe(403);
      expect(refusal.body.error.code).toBe(MEMORY_ERRORS.readOnly);
    }
    // A note that is not there is still "not found", not "read only".
    expect((await bob.delete(`/api/memory/note${query({ id: 'alpha/nothing' })}`)).status).toBe(404);
    expect((await read(owner, alphaNote.id)).body.version).toBe(alphaNote.version);
    expect(existsSync(noteFile(t, 'alpha/from-bob'))).toBe(false);

    // With write access the same member can.
    await share(t, alpha, bob, 'write');
    const created = await save(bob, 'alpha', 'From Bob', 'Bob was here.');
    expect(created).toMatchObject({ id: 'alpha/from-bob', author: 'user:bob', access: 'write' });
    const edited = await bob.put<MemoryNote>('/api/memory/note', { id: created.id, baseVersion: created.version, body: 'Bob changed his mind.' });
    expect(edited.status).toBe(200);
    expect((await bob.delete(`/api/memory/note${query({ id: created.id })}`)).status).toBe(204);
  });

  it('lets every user read global but only the owner write it', async () => {
    expect((await read(alice, globalNote.id)).body).toMatchObject({ title: 'House style', access: 'read' });
    const refusals = [
      await alice.post<ErrorBody>('/api/memory/notes', { folder: 'global', title: 'Member note', body: 'text' }),
      await alice.put<ErrorBody>('/api/memory/note', { id: globalNote.id, baseVersion: globalNote.version, body: 'changed' }),
      await alice.post<ErrorBody>('/api/memory/note/move', { id: globalNote.id, title: 'Renamed' }),
      await alice.delete<ErrorBody>(`/api/memory/note${query({ id: globalNote.id })}`),
    ];
    for (const refusal of refusals) expect(refusal.body).toMatchObject({ error: { code: MEMORY_ERRORS.readOnly } });
    expect(existsSync(noteFile(t, 'global/member-note'))).toBe(false);

    const byOwner = await save(owner, 'global', 'Owner note', 'The owner may.');
    expect(byOwner).toMatchObject({ id: 'global/owner-note', author: 'user:owner', access: 'write' });
    expect((await owner.delete(`/api/memory/note${query({ id: byOwner.id })}`)).status).toBe(204);
  });

  it('does not let a member move a note out of their reach or into a folder they cannot write', async () => {
    const carol = await t.member('carol');
    await share(t, beta, carol, 'write');
    const mine = await save(carol, 'beta', 'Carol note', 'Carol keeps this in beta.');

    const intoHidden = await carol.post<ErrorBody>('/api/memory/note/move', { id: mine.id, folder: 'alpha' });
    expect(intoHidden.status).toBe(404);
    expect(intoHidden.body).toEqual((await carol.post<ErrorBody>('/api/memory/note/move', { id: mine.id, folder: 'nowhere' })).body);
    const intoGlobal = await carol.post<ErrorBody>('/api/memory/note/move', { id: mine.id, folder: 'global' });
    expect(intoGlobal.body).toMatchObject({ error: { code: MEMORY_ERRORS.readOnly } });
    // Pulling somebody else's note towards oneself fails too.
    expect((await carol.post('/api/memory/note/move', { id: alphaNote.id, folder: 'beta' })).status).toBe(404);

    expect(existsSync(noteFile(t, mine.id))).toBe(true);
    expect(await readdir(path.join(memoryDir(t), 'alpha'))).not.toContain('carol-note.md');
    expect(await readdir(path.join(memoryDir(t), 'global'))).not.toContain('carol-note.md');
    expect((await carol.delete(`/api/memory/note${query({ id: mine.id })}`)).status).toBe(204);
  });

  it('keeps the settings and the rebuild for the owner', async () => {
    expect((await alice.put('/api/memory/settings', { agentAccess: false })).status).toBe(403);
    expect((await alice.post('/api/memory/reindex')).status).toBe(403);
    expect((await owner.get<MemoryStatus>('/api/memory/status')).body.agentAccess).toBe(true);
  });

  it('lets only those who can read a folder follow its live updates', async () => {
    const memory = t.studio.context.services.memory;
    const principalOf = (client: TestClient, username: string, role: 'owner' | 'member') => ({
      userId: client.userId!,
      username,
      displayName: username,
      role,
      via: 'session' as const,
      credentialId: 'test',
      scopes: ['read' as const, 'write' as const],
      authenticatedAt: Date.now(),
    });
    expect(memory.canSee(principalOf(owner, 'owner', 'owner'), 'alpha')).toBe(true);
    expect(memory.canSee(principalOf(alice, 'alice', 'member'), 'global')).toBe(true);
    expect(memory.canSee(principalOf(alice, 'alice', 'member'), 'alpha')).toBe(false);
    expect(memory.canSee(principalOf(alice, 'alice', 'member'), 'nowhere')).toBe(false);
  });
});

describe('creating, editing, moving and deleting notes', () => {
  let t: TestStudio;
  let owner: TestClient;

  beforeAll(async () => {
    t = await createTestStudio();
    owner = await t.owner();
    await makeProject(t, 'alpha');
  });
  afterAll(async () => {
    await t.close();
  });

  it('stores a note as a Markdown file a person can read', async () => {
    const note = await save(owner, 'global', '  Deploy   rules ', 'Releases go out on Tuesdays.\r\n\r\nNever on a Friday.\n\nKeywords: 发布 上线', {
      tags: ['#Ops', 'ops', 'Release Train', '!!'],
      keywords: ['deploy'],
    });
    expect(note).toMatchObject({
      id: 'global/deploy-rules',
      folder: 'global',
      path: 'global',
      title: 'Deploy rules',
      author: 'user:owner',
      tags: ['ops', 'release-train'],
      keywords: ['deploy', '发布', '上线'],
      body: 'Releases go out on Tuesdays.\n\nNever on a Friday.',
      truncated: false,
      credential: null,
      problem: null,
      access: 'write',
    });
    expect(note.version).toMatch(/^[0-9a-f]{32}$/);
    expect(note.createdAt).toBe(note.updatedAt);

    const text = await readFile(noteFile(t, note.id), 'utf8');
    expect(text).toBe(
      [
        '---',
        'title: Deploy rules',
        'tags: [ops, release-train]',
        'author: user:owner',
        `created: ${new Date(note.createdAt).toISOString()}`,
        `updated: ${new Date(note.updatedAt).toISOString()}`,
        '---',
        '',
        'Releases go out on Tuesdays.',
        '',
        'Never on a Friday.',
        '',
        'Keywords: deploy 发布 上线',
        '',
      ].join('\n'),
    );
    expect((await read(owner, note.id)).body).toEqual(note);
    expect((await list(owner, { folder: 'global' })).body.notes.map((entry) => entry.id)).toContain(note.id);
  });

  it('refuses a second note whose title comes down to the same file', async () => {
    await save(owner, 'alpha', 'Naming rules', 'First.');
    for (const title of ['Naming rules', 'naming RULES', 'Naming rules.', '-Naming rules', 'Naming_rules!']) {
      const response = await owner.post<ErrorBody>('/api/memory/notes', { folder: 'alpha', title, body: 'Second.' });
      expect(response.status, title).toBe(409);
      expect(response.body.error, title).toMatchObject({ code: MEMORY_ERRORS.noteExists, details: { id: 'alpha/naming-rules' } });
    }
    expect((await read(owner, 'alpha/naming-rules')).body.body).toBe('First.');
  });

  it('puts a note into normalised sub-folders', async () => {
    const note = await save(owner, 'alpha/Decisions 2026/Q1', 'Use Postgres', 'We chose Postgres.');
    expect(note).toMatchObject({ id: 'alpha/decisions-2026/q1/use-postgres', folder: 'alpha', path: 'alpha/decisions-2026/q1' });
    expect(existsSync(noteFile(t, note.id))).toBe(true);
    expect((await list(owner, { folder: 'alpha/decisions-2026' })).body.notes.map((entry) => entry.id)).toEqual([note.id]);
    expect((await list(owner, { folder: 'alpha/decisions' })).body).toEqual({ notes: [], total: 0 });
    const tooDeep = await owner.post('/api/memory/notes', { folder: 'alpha/a/b/c/d/e', title: 'Deep', body: 'x' });
    expect(tooDeep.status).toBe(400);
  });

  it.each([
    ['an empty body', { title: 'Valid', body: '' }],
    ['a body of white space', { title: 'Valid', body: ' \n\t ' }],
    ['a body that is only a keyword line', { title: 'Valid', body: 'Keywords: a b' }],
    ['a body over the limit', { title: 'Valid', body: 'x'.repeat(64_001) }],
    ['no title', { title: '   ', body: 'text' }],
    ['a title of 121 characters', { title: 'x'.repeat(121), body: 'text' }],
    ['a title with a slash', { title: 'a/b', body: 'text' }],
    ['a title with a backslash', { title: 'a\\b', body: 'text' }],
    ['a title with a control character', { title: 'a\u0007b', body: 'text' }],
    ['a title without a letter or digit', { title: '?!…', body: 'text' }],
    ['a title that is two dots', { title: '..', body: 'text' }],
    ['tags that are not a list', { title: 'Valid', body: 'text', tags: 'ops' }],
    ['a missing folder field', { title: 'Valid', body: 'text', folder: undefined }],
  ])('refuses %s as invalid and stores nothing', async (_what, input) => {
    const before = await readdir(path.join(memoryDir(t), 'global'));
    const response = await owner.post<ErrorBody>('/api/memory/notes', { folder: 'global', ...input });
    expect(response.status).toBe(400);
    expect(await readdir(path.join(memoryDir(t), 'global'))).toEqual(before);
  });

  it.each([
    ['a private key', 'private_key', (secret: string) => `The deploy key:\n\n-----BEGIN OPENSSH PRIVATE KEY-----\n${secret}\n-----END OPENSSH PRIVATE KEY-----`, 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmU'],
    ['a stated password', 'password', (secret: string) => `password = ${secret}`, 'Xy7!abcd'],
    ['an access token', 'access_token', (secret: string) => `use ${secret} for the API`, 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['a long random-looking string', 'random_string', (secret: string) => `the value is ${secret}`, 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0'],
  ])('refuses a note that contains %s, naming the kind and never the value', async (_what, kind, body, secret) => {
    const response = await owner.post<ErrorBody>('/api/memory/notes', { folder: 'global', title: 'Credentials', body: body(secret) });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe(MEMORY_ERRORS.credential);
    expect(response.body.error.details).toEqual({ kind });
    expect(response.raw.payload).not.toContain(secret);
    expect(existsSync(noteFile(t, 'global/credentials'))).toBe(false);
  });

  it('looks for credentials in the title, the tags and the keywords as well', async () => {
    const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    for (const input of [
      { title: `Token ${token}`, body: 'Fine body.' },
      { title: 'Fine title', body: 'Fine body.', keywords: [token] },
      { title: 'Fine title', body: 'Fine body.', tags: ['AKIAIOSFODNN7EXAMPLE'] },
    ]) {
      const response = await owner.post<ErrorBody>('/api/memory/notes', { folder: 'global', ...input });
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe(MEMORY_ERRORS.credential);
      expect(response.raw.payload).not.toContain(token);
    }
    expect(existsSync(noteFile(t, 'global/fine-title'))).toBe(false);
  });

  it('accepts notes that talk about credentials without stating one', async () => {
    const body = ['The API token is stored in ~/.config/app/token.', 'token limit 2048', 'the signing key uses ed25519', 'a password is mandatory.', 'max_tokens: 128000'].join('\n\n');
    const note = await save(owner, 'global', 'About credentials', body);
    expect(note).toMatchObject({ credential: null, body });
    expect((await owner.delete(`/api/memory/note${query({ id: note.id })}`)).status).toBe(204);
  });

  it('refuses a save that is based on a version somebody else has replaced', async () => {
    const created = await save(owner, 'alpha', 'Shared draft', 'Original text.');
    const phone = await t.signIn('owner');
    const onPhone = (await read(phone, created.id)).body;
    const onLaptop = (await read(owner, created.id)).body;
    expect(onPhone.version).toBe(created.version);

    const first = await owner.put<MemoryNote>('/api/memory/note', { id: created.id, baseVersion: onLaptop.version, body: 'Edited on the laptop.' });
    expect(first.status).toBe(200);
    expect(first.body.version).not.toBe(created.version);
    expect(first.body.updatedAt).toBeGreaterThan(created.updatedAt);
    expect(first.body.createdAt).toBe(created.createdAt);

    const second = await phone.put<ErrorBody>('/api/memory/note', { id: created.id, baseVersion: onPhone.version, body: 'Edited on the phone.' });
    expect(second.status).toBe(409);
    expect(second.body.error).toMatchObject({ code: MEMORY_ERRORS.noteChanged, details: { currentVersion: first.body.version } });
    expect((await read(owner, created.id)).body.body).toBe('Edited on the laptop.');

    // After reloading, the phone can save.
    const reloaded = (await read(phone, created.id)).body;
    const third = await phone.put<MemoryNote>('/api/memory/note', { id: created.id, baseVersion: reloaded.version, body: 'Merged on the phone.', tags: ['merged'] });
    expect(third.status).toBe(200);
    expect(third.body).toMatchObject({ body: 'Merged on the phone.', tags: ['merged'], title: 'Shared draft' });

    // The same guard on moving and deleting.
    expect((await owner.post<ErrorBody>('/api/memory/note/move', { id: created.id, title: 'Moved', baseVersion: created.version })).body.error.code).toBe(MEMORY_ERRORS.noteChanged);
    expect((await owner.delete<ErrorBody>(`/api/memory/note${query({ id: created.id, version: created.version })}`)).body.error.code).toBe(MEMORY_ERRORS.noteChanged);
    expect((await owner.delete(`/api/memory/note${query({ id: created.id, version: third.body.version })}`)).status).toBe(204);
  });

  it('notices a hand edit as a new version', async () => {
    const created = await save(owner, 'alpha', 'Edited outside', 'Saved from the app.');
    const file = noteFile(t, created.id);
    await writeFile(file, (await readFile(file, 'utf8')).replace('Saved from the app.', 'Changed in an editor.'));
    const stale = await owner.put<ErrorBody>('/api/memory/note', { id: created.id, baseVersion: created.version, body: 'Saved again from the app.' });
    expect(stale.body.error.code).toBe(MEMORY_ERRORS.noteChanged);
    expect(await readFile(file, 'utf8')).toContain('Changed in an editor.');
  });

  it('renames the file when the title changes, and keeps unknown header lines', async () => {
    await put(t, 'alpha/old-name', '---\ntitle: Old name\npermalink: /kept\nauthor: codex\ncreated: 2026-01-05T09:30:00.000Z\nupdated: 2026-01-05T09:30:00.000Z\n---\n\nText.\n');
    const loaded = (await read(owner, 'alpha/old-name')).body;
    expect(loaded).toMatchObject({ title: 'Old name', author: 'codex', createdAt: Date.UTC(2026, 0, 5, 9, 30) });

    const renamed = await owner.put<MemoryNote>('/api/memory/note', { id: loaded.id, baseVersion: loaded.version, title: 'New name' });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ id: 'alpha/new-name', title: 'New name', body: 'Text.', author: 'user:owner', createdAt: Date.UTC(2026, 0, 5, 9, 30) });
    expect(existsSync(noteFile(t, 'alpha/old-name'))).toBe(false);
    expect(await readFile(noteFile(t, 'alpha/new-name'), 'utf8')).toContain('\npermalink: /kept\n');
    expect((await read(owner, 'alpha/old-name')).status).toBe(404);

    // A change of case or punctuation alone keeps the file where it is.
    const recased = await owner.put<MemoryNote>('/api/memory/note', { id: renamed.body.id, baseVersion: renamed.body.version, title: 'NEW name!' });
    expect(recased.body).toMatchObject({ id: 'alpha/new-name', title: 'NEW name!' });

    // A title another note already has is refused.
    await save(owner, 'alpha', 'Taken title', 'x');
    const clash = await owner.put<ErrorBody>('/api/memory/note', { id: recased.body.id, baseVersion: recased.body.version, title: 'Taken title' });
    expect(clash.body.error).toMatchObject({ code: MEMORY_ERRORS.noteExists, details: { id: 'alpha/taken-title' } });
    expect(existsSync(noteFile(t, 'alpha/new-name'))).toBe(true);
  });

  it('moves a note between folders and into sub-folders', async () => {
    const created = await save(owner, 'alpha', 'Wandering note', 'I move around.', { tags: ['travel'] });
    const original = await readFile(noteFile(t, created.id), 'utf8');

    const moved = await owner.post<MemoryNote>('/api/memory/note/move', { id: created.id, folder: 'global/Archive' });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ id: 'global/archive/wandering-note', folder: 'global', path: 'global/archive', version: created.version, updatedAt: created.updatedAt });
    // A plain move leaves the file byte for byte as it was.
    expect(await readFile(noteFile(t, moved.body.id), 'utf8')).toBe(original);
    expect(existsSync(noteFile(t, created.id))).toBe(false);
    expect((await read(owner, created.id)).status).toBe(404);

    const back = await owner.post<MemoryNote>('/api/memory/note/move', { id: moved.body.id, folder: 'alpha', title: 'Settled note' });
    expect(back.body).toMatchObject({ id: 'alpha/settled-note', title: 'Settled note', body: 'I move around.', tags: ['travel'] });
    // The sub-folder that became empty is tidied away; the top-level folder stays.
    expect(existsSync(path.join(memoryDir(t), 'global', 'archive'))).toBe(false);
    expect(existsSync(path.join(memoryDir(t), 'global'))).toBe(true);

    await save(owner, 'global', 'Settled note', 'Already here.');
    const clash = await owner.post<ErrorBody>('/api/memory/note/move', { id: back.body.id, folder: 'global' });
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe(MEMORY_ERRORS.noteExists);
    expect((await read(owner, 'global/settled-note')).body.body).toBe('Already here.');
    expect((await read(owner, back.body.id)).body.body).toBe('I move around.');

    expect((await owner.post('/api/memory/note/move', { id: back.body.id })).status).toBe(400);
    expect((await owner.post('/api/memory/note/move', { id: 'alpha/not-there', folder: 'global' })).status).toBe(404);
  });

  it('deletes a note for good, and says "not found" when there is nothing to delete', async () => {
    const created = await save(owner, 'alpha', 'Short lived', 'Soon gone.');
    const before = (await list(owner, { folder: 'alpha' })).body.total;
    const events: unknown[] = [];
    const stop = t.studio.context.bus.onTopic('memory:alpha', (event) => events.push({ type: event.type, data: event.data }));

    expect((await owner.delete(`/api/memory/note${query({ id: created.id })}`)).status).toBe(204);
    stop();
    expect(events).toEqual([{ type: MEMORY_CHANGED, data: { action: 'deleted', id: created.id } }]);
    expect(existsSync(noteFile(t, created.id))).toBe(false);
    expect((await read(owner, created.id)).status).toBe(404);
    expect((await list(owner, { folder: 'alpha' })).body.total).toBe(before - 1);
    expect((await search(owner, 'Short lived')).body.hits).toEqual([]);

    const again = await owner.delete<ErrorBody>(`/api/memory/note${query({ id: created.id })}`);
    expect(again.status).toBe(404);
    expect(again.body.error.code).toBe(MEMORY_ERRORS.noteNotFound);
    expect((await list(owner, { folder: 'alpha' })).body.total).toBe(before - 1);
  });

  it('announces changes on the folder they happen in', async () => {
    const events: { topic: string; data: unknown }[] = [];
    const stop = t.studio.context.bus.subscribeAll((event) => {
      if (event.type === MEMORY_CHANGED) events.push({ topic: event.topic, data: event.data });
    });
    const created = await save(owner, 'alpha', 'Announced', 'x');
    const updated = (await owner.put<MemoryNote>('/api/memory/note', { id: created.id, baseVersion: created.version, body: 'y' })).body;
    const moved = (await owner.post<MemoryNote>('/api/memory/note/move', { id: updated.id, folder: 'global' })).body;
    await owner.delete(`/api/memory/note${query({ id: moved.id })}`);
    stop();
    expect(events).toEqual([
      { topic: 'memory:alpha', data: { action: 'created', id: 'alpha/announced' } },
      { topic: 'memory:alpha', data: { action: 'updated', id: 'alpha/announced' } },
      { topic: 'memory:global', data: { action: 'moved', id: 'global/announced', previousId: 'alpha/announced' } },
      { topic: 'memory:alpha', data: { action: 'deleted', id: 'alpha/announced' } },
      { topic: 'memory:global', data: { action: 'deleted', id: 'global/announced' } },
    ]);
  });
});

describe('names that try to leave the store', () => {
  let t: TestStudio;
  let owner: TestClient;
  let alice: TestClient;
  let outside: string;

  const HOSTILE_IDS = [
    '../outside',
    '../../outside',
    'global/../../outside',
    'global/../outside',
    'global/..',
    '..',
    '/etc/passwd',
    '/global/secret',
    'global//secret',
    'global/./secret',
    'global/secret/',
    './global/secret',
    '.hidden/secret',
    'global/.secret',
    'global/.git/config',
    'global\\secret',
    'global/..\\..\\outside',
    'global/sec\u0000ret',
    'global/secret\u0000.md',
    'global/sec\nret',
    'C:/Windows/win.ini',
    'c:\\windows\\win.ini',
    'global',
    ' global/secret',
    'global/secret ',
    `global/${'x'.repeat(401)}`,
    'a/b/c/d/e/f/g/h',
  ];

  beforeAll(async () => {
    t = await createTestStudio();
    owner = await t.owner();
    alice = await t.member('alice');
    const alpha = await makeProject(t, 'alpha');
    await makeProject(t, 'beta');
    await share(t, alpha, alice, 'write');
    await save(owner, 'global', 'Visible', 'A note everyone may read.');
    await save(owner, 'beta', 'Beta secret', 'Only for people on beta: the wombat protocol.');

    // Things a traversal would be after.
    outside = path.join(t.dataDir, 'outside.md');
    await writeFile(outside, '---\ntitle: Outside\n---\n\nOUTSIDE-THE-STORE\n');
    await writeFile(path.join(memoryDir(t), 'global', '.secret.md'), 'DOT-FILE-IN-STORE\n');
    await mkdir(path.join(memoryDir(t), '.hidden'), { recursive: true });
    await writeFile(path.join(memoryDir(t), '.hidden', 'secret.md'), 'DOT-FOLDER-IN-STORE\n');
    await writeFile(path.join(memoryDir(t), 'rootfile.md'), 'FILE-IN-THE-ROOT\n');
  });
  afterAll(async () => {
    await t.close();
  });

  it.each(HOSTILE_IDS)('refuses to read, change, move or delete %j', async (id) => {
    const responses = [
      await owner.get(`/api/memory/note${query({ id })}`),
      await owner.put('/api/memory/note', { id, baseVersion: '0123456789abcdef', body: 'overwritten' }),
      await owner.post('/api/memory/note/move', { id, folder: 'global' }),
      await owner.delete(`/api/memory/note${query({ id })}`),
    ];
    for (const response of responses) {
      expect(response.status).toBe(400);
      expect(response.raw.payload).not.toMatch(/OUTSIDE-THE-STORE|DOT-FILE-IN-STORE|DOT-FOLDER-IN-STORE|FILE-IN-THE-ROOT/);
    }
    expect(await readFile(outside, 'utf8')).toContain('OUTSIDE-THE-STORE');
    expect(await readFile(path.join(memoryDir(t), 'global', '.secret.md'), 'utf8')).toBe('DOT-FILE-IN-STORE\n');
  });

  it.each(['../outside', 'global/..', 'global/../..', '..', '/tmp', 'global/.hidden', '.hidden', 'global\\x', 'global//x', 'global/', 'glo\u0000bal', 'C:/x'])(
    'refuses %j as a folder to list, search or write into',
    async (folder) => {
      expect((await list(owner, { folder })).status).toBe(400);
      expect((await search(owner, 'note', { folder })).status).toBe(400);
      expect((await owner.get(`/api/memory/tags${query({ folder })}`)).status).toBe(400);
      expect((await owner.post('/api/memory/notes', { folder, title: 'Escapee', body: 'text' })).status).toBe(400);
      expect((await owner.post('/api/memory/note/move', { id: 'global/visible', folder })).status).toBe(400);
    },
  );

  it('creates nothing outside the store, whatever the title or folder', async () => {
    const snapshot = async () => ({ data: (await readdir(t.dataDir)).sort(), root: (await readdir(memoryDir(t))).sort(), workspace: (await readdir(t.workspace)).sort() });
    const before = await snapshot();
    for (const title of ['../../escaped', '..\\..\\escaped', '/etc/cron.d/escaped', '.hidden', '...', 'a/../../b']) {
      expect((await owner.post('/api/memory/notes', { folder: 'global', title, body: 'text' })).status, title).toBeLessThan(500);
    }
    // A sub-folder name is normalised, never followed.
    const odd = await owner.post<MemoryNote>('/api/memory/notes', { folder: 'global/..hidden../~root', title: 'Tame', body: 'text' });
    expect(odd.status).toBe(400);
    const tamed = await save(owner, 'global/Sub Folder!', '.dotted title', 'text');
    expect(tamed.id).toBe('global/sub-folder/dotted-title');
    expect(await snapshot()).toEqual(before);
    expect(existsSync(path.join(t.dataDir, 'escaped.md'))).toBe(false);
  });

  it('never lists or returns dot-files, files in the root, or anything outside', async () => {
    const all = (await list(owner, { limit: 100 })).body;
    // "global/hidden" is the note the previous test made from the title ".hidden": the dot went, the note stayed inside.
    expect(all.notes.map((note) => note.id).sort()).toEqual(['beta/beta-secret', 'global/hidden', 'global/sub-folder/dotted-title', 'global/visible']);
    for (const term of ['OUTSIDE-THE-STORE', 'DOT-FILE-IN-STORE', 'DOT-FOLDER-IN-STORE', 'FILE-IN-THE-ROOT', 'Outside']) {
      expect((await search(owner, term)).body.hits, term).toEqual([]);
    }
    expect((await folders(owner)).folders.map((folder) => folder.name)).toEqual(['global', 'alpha', 'beta']);
    expect((await read(owner, 'global/rootfile')).status).toBe(404);
    expect((await owner.get<MemoryStatus>('/api/memory/status')).body.skippedFiles).toBe(1);
  });

  it('never follows a symbolic link, into another folder or out of the store', async () => {
    const elsewhere = path.join(t.dataDir, 'elsewhere');
    await mkdir(elsewhere);
    await writeFile(path.join(elsewhere, 'note.md'), 'LINKED-OUTSIDE\n');
    await symlink(elsewhere, path.join(memoryDir(t), 'linked'));
    await symlink(outside, path.join(memoryDir(t), 'global', 'outside-link.md'));
    await symlink(elsewhere, path.join(memoryDir(t), 'global', 'linked-dir'));
    // A link from a folder the member may read into one she may not.
    await mkdir(path.join(memoryDir(t), 'alpha'), { recursive: true });
    await symlink(path.join(memoryDir(t), 'beta', 'beta-secret.md'), path.join(memoryDir(t), 'alpha', 'peek.md'));
    await symlink(path.join(memoryDir(t), 'beta'), path.join(memoryDir(t), 'alpha', 'tunnel'));

    expect((await folders(owner)).folders.map((folder) => folder.name)).toEqual(['global', 'alpha', 'beta']);
    const ids = (await list(owner, { limit: 100 })).body.notes.map((note) => note.id);
    for (const id of ['linked/note', 'global/outside-link', 'global/linked-dir/note', 'alpha/peek', 'alpha/tunnel/beta-secret']) {
      expect(ids).not.toContain(id);
      for (const client of [owner, alice]) {
        const response = await read(client, id);
        expect(response.status, id).toBe(404);
        expect(response.raw.payload).not.toMatch(/LINKED-OUTSIDE|OUTSIDE-THE-STORE|wombat/);
      }
    }
    expect((await search(alice, 'wombat')).body.hits).toEqual([]);
    expect((await search(owner, 'LINKED-OUTSIDE')).body.hits).toEqual([]);

    // Writing through a link is refused as well: nothing lands in the linked directory.
    const through = await owner.post('/api/memory/notes', { folder: 'global/linked-dir', title: 'Through the link', body: 'text' });
    expect(through.status).toBe(400);
    expect(await readdir(elsewhere)).toEqual(['note.md']);
    const viaAlpha = await alice.post('/api/memory/notes', { folder: 'alpha/tunnel', title: 'Through the tunnel', body: 'text' });
    expect(viaAlpha.status).toBe(400);
    expect(await readdir(path.join(memoryDir(t), 'beta'))).toEqual(['beta-secret.md']);
    // Deleting the link's name does not delete what it points at.
    expect((await owner.delete(`/api/memory/note${query({ id: 'alpha/peek' })}`)).status).toBe(404);
    expect(existsSync(path.join(memoryDir(t), 'beta', 'beta-secret.md'))).toBe(true);
  });
});

describe('the files are the truth', () => {
  let t: TestStudio;
  let owner: TestClient;

  beforeEach(async () => {
    t = await createTestStudio();
    owner = await t.owner();
  });
  afterEach(async () => {
    await t.close();
  });

  it('answers "not found", not an error, before the store has ever been used', async () => {
    expect(existsSync(memoryDir(t))).toBe(false);
    const response = await read(owner, 'global/nothing-yet');
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ error: { code: MEMORY_ERRORS.noteNotFound } });
    expect((await owner.delete(`/api/memory/note${query({ id: 'global/nothing-yet' })}`)).status).toBe(404);
    // The first write makes the folder, owner-only.
    const note = await save(owner, 'global', 'First ever', 'text');
    expect(existsSync(noteFile(t, note.id))).toBe(true);
  });

  it('clears away what an interrupted write left behind, and nothing else', async () => {
    await save(owner, 'global', 'Kept', 'text');
    const directory = path.join(memoryDir(t), 'global');
    const old = Date.now() - 2 * 60 * 60 * 1000;
    await writeFile(path.join(directory, '.0123456789abcdef01.tmp'), 'half a note');
    await utimes(path.join(directory, '.0123456789abcdef01.tmp'), new Date(old), new Date(old));
    await writeFile(path.join(directory, '.fedcba987654321001.tmp'), 'being written right now');
    await writeFile(path.join(directory, '.private.md'), 'a dot-file somebody keeps here');
    await utimes(path.join(directory, '.private.md'), new Date(old), new Date(old));
    await writeFile(path.join(directory, 'notes.tmp'), 'not ours');
    await utimes(path.join(directory, 'notes.tmp'), new Date(old), new Date(old));

    expect((await list(owner)).body.notes.map((note) => note.id)).toEqual(['global/kept']);
    expect((await readdir(directory)).sort()).toEqual(['.fedcba987654321001.tmp', '.private.md', 'kept.md', 'notes.tmp']);
  });

  it('returns what a person saved in an editor, without a restart', async () => {
    const note = await save(owner, 'global', 'Edited by hand', 'The original sentence.', { tags: ['first'] });
    const file = noteFile(t, note.id);
    await writeFile(file, (await readFile(file, 'utf8')).replace('The original sentence.', 'The pelican sentence, typed in an editor.').replace('tags: [first]', 'tags: [second, third]'));

    const reread = (await read(owner, note.id)).body;
    expect(reread).toMatchObject({ body: 'The pelican sentence, typed in an editor.', tags: ['second', 'third'], author: 'user:owner' });
    expect(reread.version).not.toBe(note.version);
    expect(reread.updatedAt).toBeGreaterThanOrEqual(note.updatedAt);
    expect((await search(owner, 'pelican')).body.hits.map((hit) => hit.id)).toEqual([note.id]);
    expect((await search(owner, 'original')).body.hits).toEqual([]);
    expect((await owner.get<MemoryTagsResponse>('/api/memory/tags')).body.tags).toEqual([
      { tag: 'second', count: 1 },
      { tag: 'third', count: 1 },
    ]);
  });

  it('shows a file added by hand on the next listing, and forgets one that was removed', async () => {
    expect((await list(owner)).body.total).toBe(0);
    await put(t, 'global/typed-by-hand', '# Typed by hand\n\nNo header at all, just Markdown about the ocelot.\n');
    await put(t, 'global/just-text', 'A file without even a heading.\n');
    await put(t, 'global/notes/My Notes v2', '---\ntitle: Nested by hand\nauthor: someone\ntags:\n  - Loose Tag\n---\n\nIn a folder made with mkdir.\n\n关键词：手写 嵌套\n');

    const listed = (await list(owner)).body;
    expect(listed.total).toBe(3);
    expect(listed.notes.map((note) => [note.id, note.title, note.author])).toEqual(
      expect.arrayContaining([
        ['global/typed-by-hand', 'Typed by hand', null],
        ['global/just-text', 'just-text', null],
        ['global/notes/My Notes v2', 'Nested by hand', 'someone'],
      ]),
    );
    expect((await read(owner, 'global/notes/My Notes v2')).body).toMatchObject({ body: 'In a folder made with mkdir.', keywords: ['手写', '嵌套'], tags: ['loose-tag'], path: 'global/notes' });
    expect((await search(owner, 'ocelot')).body.hits.map((hit) => hit.id)).toEqual(['global/typed-by-hand']);
    expect((await search(owner, '嵌套')).body.hits.map((hit) => hit.id)).toEqual(['global/notes/My Notes v2']);

    await rm(noteFile(t, 'global/typed-by-hand'));
    expect((await list(owner)).body.total).toBe(2);
    expect((await search(owner, 'ocelot')).body.hits).toEqual([]);
    expect((await read(owner, 'global/typed-by-hand')).status).toBe(404);
  });

  it('lists a file it cannot read as a note under its file name, and nothing breaks', async () => {
    await save(owner, 'global', 'Healthy', 'A perfectly good note about the heron.');
    await put(t, 'global/latin1', new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x20, 0x68, 0x65, 0x72, 0x6f, 0x6e]));
    await put(t, 'global/binary', new Uint8Array(Array.from({ length: 2048 }, (_, index) => (index * 97) % 256)));
    await put(t, 'global/huge', new Uint8Array(1024 * 1024 + 1).fill(0x61));
    await put(t, 'global/half-header', '---\ntitle: Never closed\n\nheron text without an end of header\n');
    await put(t, 'global/empty', '');

    const listed = (await list(owner, { limit: 100 })).body;
    expect(listed.total).toBe(6);
    const byId = new Map(listed.notes.map((note) => [note.id, note]));
    expect(byId.get('global/latin1')).toMatchObject({ title: 'latin1', problem: 'not_text', author: null, tags: [] });
    expect(byId.get('global/binary')).toMatchObject({ title: 'binary', problem: 'not_text' });
    expect(byId.get('global/huge')).toMatchObject({ title: 'huge', problem: 'too_large' });
    // Text that merely does not follow the format is a note like any other: all of it is body.
    expect(byId.get('global/half-header')).toMatchObject({ title: 'half-header', problem: null });
    expect(byId.get('global/empty')).toMatchObject({ title: 'empty', problem: null });
    expect(byId.get('global/healthy')).toMatchObject({ title: 'Healthy', problem: null });

    expect((await search(owner, 'heron')).body.hits.map((hit) => hit.id).sort()).toEqual(['global/half-header', 'global/healthy']);
    expect((await search(owner, 'latin1')).body.hits.map((hit) => hit.id)).toEqual(['global/latin1']);
    expect((await folders(owner)).folders).toEqual([expect.objectContaining({ name: 'global', count: 6 })]);
    expect((await owner.get<MemoryStatus>('/api/memory/status')).body).toMatchObject({ healthy: true, notes: 6, unreadable: 3 });

    const broken = await read(owner, 'global/latin1');
    expect(broken.status).toBe(200);
    expect(broken.body).toMatchObject({ title: 'latin1', body: '', problem: 'not_text' });
    const edit = await owner.put<ErrorBody>('/api/memory/note', { id: 'global/latin1', baseVersion: broken.body.version, body: 'fixed' });
    expect(edit.status).toBe(409);
    expect(edit.body.error.code).toBe(MEMORY_ERRORS.noteUnreadable);
    expect((await owner.post<ErrorBody>('/api/memory/note/move', { id: 'global/latin1', title: 'Renamed' })).body.error.code).toBe(MEMORY_ERRORS.noteUnreadable);

    // It can still be moved out of the way, or deleted.
    const moved = await owner.post<MemoryNote>('/api/memory/note/move', { id: 'global/binary', folder: 'global/quarantine' });
    expect(moved.body).toMatchObject({ id: 'global/quarantine/binary', problem: 'not_text' });
    expect((await owner.delete(`/api/memory/note${query({ id: 'global/latin1' })}`)).status).toBe(204);
    expect((await list(owner, { limit: 100 })).body.total).toBe(5);
  });

  it('flags a note that has a credential typed into it, for the person to deal with', async () => {
    const note = await save(owner, 'global', 'Server access', 'Ask the owner for access.');
    const file = noteFile(t, note.id);
    await writeFile(file, (await readFile(file, 'utf8')).replace('Ask the owner for access.', 'The root password is Tr0ub4dor&3 — do not share.'));

    const listed = (await list(owner)).body.notes[0]!;
    expect(listed).toMatchObject({ id: note.id, credential: 'password' });
    const opened = (await read(owner, note.id)).body;
    expect(opened).toMatchObject({ credential: 'password', body: 'The root password is Tr0ub4dor&3 — do not share.' });
    expect((await owner.get<MemoryStatus>('/api/memory/status')).body.withheld).toBe(1);

    // Saving it as it is stays refused; taking the credential out clears the flag.
    const unchanged = await owner.put<ErrorBody>('/api/memory/note', { id: note.id, baseVersion: opened.version, tags: ['access'] });
    expect(unchanged.body.error).toMatchObject({ code: MEMORY_ERRORS.credential, details: { kind: 'password' } });
    const cleaned = await owner.put<MemoryNote>('/api/memory/note', { id: note.id, baseVersion: opened.version, body: 'The root password is in the team vault.' });
    expect(cleaned.body).toMatchObject({ credential: null });
    expect((await owner.get<MemoryStatus>('/api/memory/status')).body.withheld).toBe(0);
  });

  it('never cuts down what a hand-written file holds when something else about it is changed', async () => {
    // Longer than a note saved from the app may be, but short enough to be shown whole.
    const long = 'word '.repeat(14_000).trim();
    const manyTags = Array.from({ length: 12 }, (_, index) => `t${index}`);
    await put(t, 'global/long-read', `---\ntitle: Long read\ntags: [${manyTags.join(', ')}]\n---\n\n${long}\n\nKeywords: ${manyTags.join(' ')} extra1 extra2\n`);
    const loaded = (await read(owner, 'global/long-read')).body;
    expect(loaded.body).toHaveLength(69_999);
    expect(loaded).toMatchObject({ truncated: false, tags: manyTags });
    expect(loaded.keywords).toHaveLength(14);

    const retitled = await owner.put<MemoryNote>('/api/memory/note', { id: loaded.id, baseVersion: loaded.version, title: 'Long read, renamed' });
    expect(retitled.status).toBe(200);
    expect(retitled.body).toMatchObject({ id: 'global/long-read-renamed', tags: manyTags, body: long });
    expect(retitled.body.keywords).toHaveLength(14);
    // New text has to fit the limit; new tags are cut to the usual number.
    expect((await owner.put('/api/memory/note', { id: retitled.body.id, baseVersion: retitled.body.version, body: `${long} and more` })).status).toBe(400);
    const retagged = await owner.put<MemoryNote>('/api/memory/note', { id: retitled.body.id, baseVersion: retitled.body.version, tags: [...manyTags, 'one-more'] });
    expect(retagged.body.tags).toEqual(manyTags.slice(0, 8));
    expect(retagged.body.body).toBe(long);

    // Longer than the app can show: it gets the start, and may not save that back over the whole.
    const lines = Array.from({ length: 20_000 }, (_, index) => `line ${String(index).padStart(6, '0')}`);
    await put(t, 'global/huge-log', `${lines.join('\n')}\n`);
    const huge = (await read(owner, 'global/huge-log')).body;
    expect(huge).toMatchObject({ truncated: true, title: 'huge-log' });
    expect(huge.body).toHaveLength(200_000);
    const overwrite = await owner.put<ErrorBody>('/api/memory/note', { id: huge.id, baseVersion: huge.version, body: 'Replaced by the short text the app had.' });
    expect(overwrite.status).toBe(409);
    expect(overwrite.body.error.code).toBe(MEMORY_ERRORS.noteTooLong);
    expect(await readFile(noteFile(t, huge.id), 'utf8')).toBe(`${lines.join('\n')}\n`);
    // Its tags can still be set, and every line survives that.
    const tagged = await owner.put<MemoryNote>('/api/memory/note', { id: huge.id, baseVersion: huge.version, tags: ['log'] });
    expect(tagged.status).toBe(200);
    const onDisk = await readFile(noteFile(t, huge.id), 'utf8');
    expect(onDisk).toContain('\ntags: [log]\n');
    expect(onDisk.endsWith(`${lines.join('\n')}\n`)).toBe(true);
  });

  it('holds at most 2 000 notes in a folder, and checks a large store against its files every two seconds at most', async () => {
    await makeProject(t, 'alpha');
    await mkdir(path.join(memoryDir(t), 'alpha'), { recursive: true });
    for (let start = 0; start < 2_000; start += 200) {
      await Promise.all(Array.from({ length: 200 }, (_, offset) => writeFile(noteFile(t, `alpha/n${start + offset}`), `# Note ${start + offset}\n\nbody ${start + offset}\n`)));
    }
    expect((await list(owner, { folder: 'alpha' })).body.total).toBe(2_000);
    expect((await search(owner, 'body 1999')).body.hits[0]!.id).toBe('alpha/n1999');

    const full = await owner.post<ErrorBody>('/api/memory/notes', { folder: 'alpha', title: 'One too many', body: 'x' });
    expect(full.status).toBe(409);
    expect(full.body.error.code).toBe(MEMORY_ERRORS.folderFull);
    const elsewhere = await save(owner, 'global', 'Elsewhere', 'x');
    expect((await owner.post<ErrorBody>('/api/memory/note/move', { id: elsewhere.id, folder: 'alpha' })).body.error.code).toBe(MEMORY_ERRORS.folderFull);
    expect(existsSync(noteFile(t, 'alpha/one-too-many'))).toBe(false);
    expect(existsSync(noteFile(t, 'alpha/elsewhere'))).toBe(false);
    // Making room helps; what the product writes is in the index at once.
    expect((await owner.delete(`/api/memory/note${query({ id: 'alpha/n0' })}`)).status).toBe(204);
    await save(owner, 'alpha', 'One too many', 'x');
    expect((await list(owner, { folder: 'alpha' })).body).toMatchObject({ total: 2_000, notes: expect.arrayContaining([expect.objectContaining({ id: 'alpha/one-too-many' })]) });

    // A file added by hand to a store this large: reading it works at once, lists follow within two seconds.
    await put(t, 'global/late-arrival', '# Late arrival\n\nAdded while the store was large.\n');
    expect((await read(owner, 'global/late-arrival')).body).toMatchObject({ title: 'Late arrival', body: '# Late arrival\n\nAdded while the store was large.' });
    await put(t, 'global/later-arrival', '# Later arrival\n\nAdded a moment after.\n');
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    expect((await list(owner, { folder: 'global' })).body.notes.map((note) => note.id).sort()).toEqual(['global/elsewhere', 'global/late-arrival', 'global/later-arrival']);
  });

  it('rebuilds the index from the files on demand, and reports on itself', async () => {
    await save(owner, 'global', 'One', 'first');
    await put(t, 'global/two', '# Two\n\nsecond\n');
    await put(t, 'global/broken', new Uint8Array([0xff, 0xfe, 0x00, 0x41]));
    await writeFile(path.join(memoryDir(t), 'stray.md'), 'not in a folder\n');

    const before = (await owner.get<MemoryStatus>('/api/memory/status')).body;
    expect(before).toMatchObject({ healthy: true, problem: null, notes: 3, folders: 1, unreadable: 1, withheld: 0, indexStale: false, agentAccess: true, skippedFiles: 1 });
    expect(before.indexedAt).toBeGreaterThan(Date.now() - 60_000);
    expect(before.location).toMatch(/memory$/);

    // Damage the index behind the product's back: it comes back from the files.
    t.studio.context.db.run("UPDATE memory_notes SET title = 'Corrupted', tags = '[\"bogus\"]'");
    expect((await list(owner)).body.notes.map((note) => note.title)).toEqual(['Corrupted', 'Corrupted', 'Corrupted']);
    const rebuilt = await owner.post<MemoryReindexResponse>('/api/memory/reindex');
    expect(rebuilt.status).toBe(200);
    expect(rebuilt.body).toMatchObject({ notes: 3, unreadable: 1, skippedFiles: 1 });
    expect((await list(owner)).body.notes.map((note) => note.title).sort()).toEqual(['One', 'Two', 'broken']);
    expect((await search(owner, 'second')).body.hits.map((hit) => hit.id)).toEqual(['global/two']);

    // A full-text table that lost its rows is noticed and refilled without being asked.
    t.studio.context.db.run('DELETE FROM memory_fts');
    expect((await search(owner, 'second')).body.hits.map((hit) => hit.id)).toEqual(['global/two']);
    t.studio.context.db.run("DELETE FROM memory_fts WHERE rowid = (SELECT n FROM memory_notes WHERE id = 'global/one')");
    expect((await search(owner, 'first')).body.hits.map((hit) => hit.id)).toEqual(['global/one']);
  });

  it('brings the index in line with the files when the server starts', async () => {
    await put(t, 'global/before-start', '# Before start\n\nWritten while the server was down.\n');
    await t.listen();
    const row = t.studio.context.db.get<{ title: string }>("SELECT title FROM memory_notes WHERE id = 'global/before-start'");
    expect(row).toEqual({ title: 'Before start' });
  });
});

describe('listing, folders and search', () => {
  let t: TestStudio;
  let owner: TestClient;

  beforeEach(async () => {
    t = await createTestStudio();
    owner = await t.owner();
  });
  afterEach(async () => {
    await t.close();
  });

  it('lists the newest notes first, with the exact count and the folders in order', async () => {
    await makeProject(t, 'zeta');
    await makeProject(t, 'alpha');
    const base = Date.UTC(2026, 5, 1);
    await put(t, 'alpha/one', handNote('One', 'a', base + 1_000), base + 1_000);
    await put(t, 'global/two', handNote('Two', 'b', base + 5_000), base + 5_000);
    await put(t, 'alpha/three', handNote('Three', 'c', base + 3_000), base + 3_000);
    await put(t, 'alpha/sub/four', handNote('Four', 'd', base + 4_000), base + 4_000);
    await put(t, 'global/five', handNote('Five', 'e', base + 2_000), base + 2_000);

    const all = (await list(owner)).body;
    expect(all.notes.map((note) => note.title)).toEqual(['Two', 'Four', 'Three', 'Five', 'One']);
    expect(all.notes.map((note) => note.updatedAt)).toEqual([5_000, 4_000, 3_000, 2_000, 1_000].map((offset) => base + offset));
    expect(all.total).toBe(5);

    const listed = await folders(owner);
    expect(listed.folders.map((folder) => [folder.name, folder.kind, folder.count])).toEqual([
      ['global', 'global', 2],
      ['alpha', 'project', 3],
      ['zeta', 'project', 0],
    ]);
    expect(listed.total).toBe(5);

    const inAlpha = (await list(owner, { folder: 'alpha' })).body;
    expect(inAlpha.notes.map((note) => note.title)).toEqual(['Four', 'Three', 'One']);
    expect(inAlpha.total).toBe(3);
    expect((await list(owner, { folder: 'alpha/sub' })).body).toMatchObject({ total: 1 });
    expect((await list(owner, { limit: 2, offset: 1 })).body.notes.map((note) => note.title)).toEqual(['Four', 'Three']);
    expect((await list(owner, { limit: 0 })).status).toBe(400);
    expect((await list(owner, { limit: 101 })).status).toBe(400);
  });

  it('returns at most forty notes by default and still counts all sixty', async () => {
    await makeProject(t, 'alpha');
    const base = Date.UTC(2026, 5, 1);
    for (let index = 0; index < 60; index += 1) {
      const id = index % 3 === 0 ? `alpha/sub/note-${index}` : `alpha/note-${index}`;
      await put(t, id, handNote(`Note ${index}`, `body ${index}`, base + index * 1_000), base + index * 1_000);
    }
    await put(t, 'global/other', handNote('Other', 'x', base), base);

    const page = (await list(owner, { folder: 'alpha' })).body;
    expect(page.notes).toHaveLength(40);
    expect(page.total).toBe(60);
    expect(page.notes[0]!.title).toBe('Note 59');
    expect(page.notes[39]!.title).toBe('Note 20');
    expect((await list(owner, { folder: 'alpha', limit: 100 })).body.notes).toHaveLength(60);
    expect((await folders(owner)).folders.find((folder) => folder.name === 'alpha')!.count).toBe(60);
  });

  it("names a project's folder after its working directory and shows the project with it", async () => {
    const project = await makeProject(t, 'My App', 'The App');
    const again = await makeProject(t, path.join('nested', 'my-app'), 'Second App');
    const third = await makeProject(t, path.join('other', 'MY_APP'), 'Third App');

    const listed = (await folders(owner)).folders;
    const first = listed.find((folder) => folder.project?.id === project.id)!;
    const second = listed.find((folder) => folder.project?.id === again.id)!;
    const last = listed.find((folder) => folder.project?.id === third.id)!;
    expect(first).toMatchObject({ name: 'my-app', kind: 'project', access: 'write', project: { name: 'The App', icon: project.icon, archived: false } });
    // The same name is taken: the others get a suffix that depends only on their directories.
    expect(second.name).toMatch(/^my-app-[0-9a-f]{6}$/);
    expect(last.name).toMatch(/^my-app-[0-9a-f]{6}$/);
    expect(second.name).not.toBe(last.name);
    expect((await folders(owner)).folders.map((folder) => folder.name)).toEqual(listed.map((folder) => folder.name));

    // Notes go where the folder says, and a member of one project sees only that one.
    const note = await save(owner, second.name, 'In the second', 'text');
    expect(existsSync(noteFile(t, `${second.name}/in-the-second`))).toBe(true);
    const member = await t.member('dana');
    await share(t, again, member, 'read');
    expect((await folders(member)).folders.map((folder) => [folder.name, folder.project?.name ?? null])).toEqual([
      ['global', null],
      [second.name, 'Second App'],
    ]);
    expect((await read(member, note.id)).status).toBe(200);

    // A project called "global" cannot take the shared folder.
    const impostor = await makeProject(t, 'Global', 'Impostor');
    const impostorFolder = (await folders(owner)).folders.find((folder) => folder.project?.id === impostor.id)!;
    expect(impostorFolder.name).toMatch(/^global-[0-9a-f]{6}$/);
  });

  it('keeps the notes of a removed project on disk and releases its folder', async () => {
    const project = await makeProject(t, 'alpha');
    const member = await t.member('erin');
    await share(t, project, member, 'write');
    const note = await save(owner, 'alpha', 'Hard-won knowledge', 'The quokka cluster needs a warm-up.');
    expect((await read(member, note.id)).status).toBe(200);

    expect((await owner.delete(`/api/projects/${project.id}`)).status).toBe(204);

    expect(await readFile(noteFile(t, note.id), 'utf8')).toContain('The quokka cluster needs a warm-up.');
    const afterRemoval = (await folders(owner)).folders.find((folder) => folder.name === 'alpha')!;
    expect(afterRemoval).toMatchObject({ kind: 'unassigned', project: null, access: 'write', count: 1 });
    expect((await read(owner, note.id)).body.body).toBe('The quokka cluster needs a warm-up.');
    expect((await search(owner, 'quokka')).body.hits.map((hit) => hit.id)).toEqual([note.id]);
    // Nobody but the owner reaches it any more.
    expect((await folders(member)).folders.map((folder) => folder.name)).toEqual(['global']);
    expect((await read(member, note.id)).status).toBe(404);
    expect((await search(member, 'quokka')).body.hits).toEqual([]);

    // Another directory with the same name does not inherit the folder…
    const lookalike = await makeProject(t, path.join('elsewhere', 'alpha'), 'Lookalike');
    const lookalikeFolder = (await folders(owner)).folders.find((folder) => folder.project?.id === lookalike.id)!;
    expect(lookalikeFolder.name).toMatch(/^alpha-[0-9a-f]{6}$/);
    expect(lookalikeFolder.count).toBe(0);
    // …but the same directory, added again, gets its notes back.
    const returned = await makeProject(t, 'alpha', 'Alpha again');
    const reattached = (await folders(owner)).folders.find((folder) => folder.name === 'alpha')!;
    expect(reattached).toMatchObject({ kind: 'project', count: 1, project: { id: returned.id, name: 'Alpha again' } });
  });

  it('searches titles, text, tags and keywords, best match first, with highlights', async () => {
    await makeProject(t, 'alpha');
    await makeProject(t, 'beta');
    await save(owner, 'alpha', 'Deploy rules', 'Releases go out on Tuesdays. We never deploy on a Friday.', { tags: ['ops'] });
    await save(owner, 'alpha', 'Standup notes', `${'Filler sentence about nothing in particular. '.repeat(20)}Somebody asked when we deploy next.`);
    await save(owner, 'beta', 'Beta runbook', 'To deploy beta, run the pipeline twice.');
    await save(owner, 'global', 'Tagged only', 'Nothing in the text.', { tags: ['deployment'] });
    await save(owner, 'global', 'Keyword only', 'Nothing in the text either.', { keywords: ['redeploy'] });
    await save(owner, 'global', 'Unrelated', 'Coffee is in the kitchen.');

    const result = (await search(owner, 'deploy')).body;
    expect(result.query).toBe('deploy');
    expect(result.total).toBe(5);
    expect(result.capped).toBe(false);
    expect(result.hits[0]!.id).toBe('alpha/deploy-rules');
    expect(result.hits.map((hit) => hit.id)).not.toContain('global/unrelated');
    expect(new Set(result.hits.map((hit) => hit.id)).size).toBe(result.hits.length);

    const top = result.hits[0]!;
    expect(top.titleHighlights.map(([from, to]) => top.title.slice(from, to))).toEqual(['Deploy']);
    expect(top.snippet.highlights.map(([from, to]) => top.snippet.text.slice(from, to))).toEqual(['deploy']);
    const buried = result.hits.find((hit) => hit.id === 'alpha/standup-notes')!;
    expect(buried.snippet.text.startsWith('…')).toBe(true);
    expect(buried.snippet.text.length).toBeLessThanOrEqual(242);
    expect(buried.snippet.highlights.map(([from, to]) => buried.snippet.text.slice(from, to))).toEqual(['deploy']);
    expect(buried.titleHighlights).toEqual([]);

    // A folder narrows the search; each note comes back once.
    expect((await search(owner, 'deploy', { folder: 'alpha' })).body.hits.map((hit) => hit.id)).toEqual(['alpha/deploy-rules', 'alpha/standup-notes']);
    expect((await search(owner, 'deploy', { folder: 'beta' })).body.hits.map((hit) => hit.id)).toEqual(['beta/beta-runbook']);
    // Prefixes and several words.
    expect((await search(owner, 'tuesd')).body.hits.map((hit) => hit.id)).toEqual(['alpha/deploy-rules']);
    expect((await search(owner, 'DEPLOY friday')).body.hits[0]!.id).toBe('alpha/deploy-rules');
    expect((await search(owner, 'deploy', { limit: 2 })).body).toMatchObject({ total: 5, hits: [expect.anything(), expect.anything()] });
    expect((await search(owner, 'ops')).body.hits.map((hit) => hit.id)).toEqual(['alpha/deploy-rules']);
    expect((await search(owner, 'zzzunknown')).body).toMatchObject({ hits: [], total: 0 });

    const tags = (await owner.get<MemoryTagsResponse>('/api/memory/tags')).body.tags;
    expect(tags).toEqual([
      { tag: 'deployment', count: 1 },
      { tag: 'ops', count: 1 },
    ]);
    expect((await list(owner, { tag: 'OPS' })).body.notes.map((note) => note.id)).toEqual(['alpha/deploy-rules']);
    expect((await list(owner, { tag: '!!' })).body).toEqual({ notes: [], total: 0 });
  });

  it('searches text written without spaces between words', async () => {
    await save(owner, 'global', '上线流程', '我们的规定是每次部署之前必须先跑完全部测试然后才能上线到生产环境。', { keywords: ['部署', '测试'] });
    await save(owner, 'global', '没有关键词的笔记', '团队每周三开会讨论部署计划和回滚方案。');
    await save(owner, 'global', '无关', '咖啡在厨房里。');

    // A two-character word in the middle of an unbroken sentence.
    const short = (await search(owner, '部署')).body;
    expect(short.hits.map((hit) => hit.id)).toEqual(['global/上线流程', 'global/没有关键词的笔记']);
    for (const hit of short.hits) expect(hit.snippet.highlights.map(([from, to]) => hit.snippet.text.slice(from, to))).toEqual(['部署']);
    // Longer phrases, found as typed.
    expect((await search(owner, '全部测试')).body.hits.map((hit) => hit.id)).toEqual(['global/上线流程']);
    expect((await search(owner, '回滚方案')).body.hits.map((hit) => hit.id)).toEqual(['global/没有关键词的笔记']);
    // Words the note has, in another order than typed, still find it.
    expect((await search(owner, '测试部署')).body.hits[0]!.id).toBe('global/上线流程');
    expect((await search(owner, '上线')).body.hits[0]!).toMatchObject({ id: 'global/上线流程', titleHighlights: [[0, 2]] });
    expect((await search(owner, '厨')).body.hits.map((hit) => hit.id)).toEqual(['global/无关']);
    expect((await search(owner, '火星')).body.hits).toEqual([]);
  });

  it('answers an empty query with an empty list and refuses an overlong one', async () => {
    await save(owner, 'global', 'Something', 'text');
    for (const q of ['', '   ']) expect((await search(owner, q)).body).toEqual({ query: '', hits: [], total: 0, capped: false });
    expect((await owner.get<MemorySearchResponse>('/api/memory/search')).body.hits).toEqual([]);
    expect((await search(owner, 'x'.repeat(200))).status).toBe(200);
    const tooLong = await search(owner, 'x'.repeat(201));
    expect(tooLong.status).toBe(400);
    expect(tooLong.body).toMatchObject({ error: { code: 'invalid_request' } });
  });

  it('treats search syntax as plain text', async () => {
    await save(owner, 'global', 'Alpha plan', 'The alpha service.');
    await save(owner, 'global', 'Beta plan', 'The beta service.');
    for (const q of ['alpha" OR "beta', '"alpha', 'alpha NOT beta', 'NEAR(alpha beta)', 'title:alpha', 'alp*', '(alpha', "'; DROP TABLE memory_notes; --", '%', '_', '\\', '*']) {
      const response = await search(owner, q);
      expect(response.status, q).toBe(200);
    }
    // As syntax this would exclude the beta note; as text it finds both words.
    expect((await search(owner, 'alpha NOT beta')).body.hits.map((hit) => hit.id).sort()).toEqual(['global/alpha-plan', 'global/beta-plan']);
    // LIKE wildcards are literal too.
    expect((await search(owner, '%')).body.hits).toEqual([]);
    expect((await search(owner, '_')).body.hits).toEqual([]);
    expect((await list(owner)).body.total).toBe(2);
  });
});
