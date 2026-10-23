import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type MailAccount, type MailDraft } from '@agent-studio/protocol';
import { modules } from '../../src/modules/index.js';
import { createMailboxModule } from '../../src/modules/mailbox/mailbox.module.js';
import type { MailTransport } from '../../src/modules/mailbox/provider.js';
import { createTestStudio, type TestStudio } from '../../src/testing/harness.js';
const opened: TestStudio[] = [];
afterEach(async () => {
  for (const t of opened.splice(0)) await t.close();
});
function answer(data: unknown, status = 200) {
  return { status, headers: {}, body: Readable.from([JSON.stringify(data)]) };
}
const fake = () =>
  vi.fn<MailTransport>(async (url) => {
    if (url.endsWith('/profile')) return answer({ emailAddress: 'synthetic@example.invalid' });
    if (url.endsWith('/labels')) return answer({ labels: [{ id: 'INBOX', name: 'Inbox' }] });
    if (url.includes('/attachments/'))
      return answer({ data: Buffer.from('fake attachment').toString('base64url'), size: 15 });
    if (url.includes('messages?')) return answer({ messages: [{ id: 'fake-message' }] });
    if (url.endsWith('/send')) return answer({ id: 'fake-sent' });
    return answer({
      id: 'fake-message',
      snippet: 'Synthetic message',
      labelIds: ['UNREAD'],
      payload: {
        headers: [{ name: 'Subject', value: 'Example' }],
        parts: [
          {
            mimeType: 'text/html',
            body: {
              data: Buffer.from(
                '<script>bad()</script><p>Hello<img src="https://tracker.invalid/pixel"></p>',
              ).toString('base64url'),
            },
          },
          {
            mimeType: 'text/html',
            filename: '../example.html',
            body: { attachmentId: 'fake-attachment', size: 15 },
          },
        ],
      },
    });
  });
async function start(transport = fake()) {
  const t = await createTestStudio({
    modules: modules.map((m) => (m.name === 'mailbox' ? createMailboxModule({ transport }) : m)),
  });
  opened.push(t);
  return { t, owner: await t.owner(), transport };
}
const config = {
  provider: 'gmail',
  name: 'Synthetic account',
  credentials: { accessToken: 'fake-mail-access-only-for-tests' },
};
describe('mailbox privacy and explicit sending', () => {
  it('stores only encrypted credentials, isolates accounts, and saving makes no network request', async () => {
    const { t, owner, transport } = await start();
    expect((await t.anonymous().get('/api/mailbox/accounts')).status).toBe(401);
    const result = await owner.post<MailAccount>('/api/mailbox/accounts', config);
    expect(result.status).toBe(201);
    expect(transport).not.toHaveBeenCalled();
    expect(JSON.stringify(result.body)).not.toContain(config.credentials.accessToken);
    expect(JSON.stringify(t.studio.context.db.all('SELECT * FROM secrets'))).not.toContain(
      config.credentials.accessToken,
    );
    const member = await t.member();
    expect((await member.get('/api/mailbox/accounts')).body).toEqual({ accounts: [] });
    expect((await member.get(`/api/mailbox/accounts/${result.body.id}/folders`)).status).toBe(404);
    expect(
      (
        await owner.request(
          'PUT',
          `/api/mailbox/accounts/${result.body.id}/credentials`,
          config.credentials,
          { 'x-studio-csrf': 'bad' },
        )
      ).status,
    ).toBe(403);
    await owner.delete(`/api/mailbox/accounts/${result.body.id}`);
    expect(
      t.studio.context.secrets.describe(`mailbox:${owner.userId}:${result.body.id}:oauth`),
    ).toBeNull();
  });
  it('is read and drafted only from a signed-in browser: an API token of any scope reaches no mail', async () => {
    const { t, owner, transport } = await start();
    const account = (await owner.post<MailAccount>('/api/mailbox/accounts', config)).body;
    const robot = t.anonymous();
    robot.bearer = (
      await owner.post<{ token: string }>('/api/auth/tokens', {
        name: 'script',
        scopes: ['read', 'write', 'admin'],
      })
    ).body.token;
    const base = `/api/mailbox/accounts/${account.id}`;
    const calls: ['GET' | 'POST' | 'PUT' | 'DELETE', string, unknown?][] = [
      ['GET', '/api/mailbox/accounts'],
      ['GET', `${base}/folders`],
      ['GET', `${base}/messages`],
      ['GET', `${base}/messages/fake-message`],
      ['GET', `${base}/messages/fake-message/attachments/fake-attachment`],
      ['GET', `${base}/drafts`],
      ['POST', `${base}/drafts`, { to: ['someone@example.invalid'], subject: 'Hi', body: 'Hello' }],
      ['PUT', `${base}/drafts/${'0'.repeat(26)}`, { subject: 'Hi', body: 'Hello', revision: 1 }],
      ['DELETE', `${base}/drafts/${'0'.repeat(26)}`],
    ];
    for (const [method, url, body] of calls) {
      const refused = await robot.request(method, url, body);
      expect(refused.status, `${method} ${url}`).toBe(403);
      expect(refused.body, `${method} ${url}`).toMatchObject({ error: { code: 'session_required' } });
    }
    expect(transport).not.toHaveBeenCalled();
  });
  it('renders inert text and forces attachment download instead of HTML execution', async () => {
    const { owner } = await start();
    const account = (await owner.post<MailAccount>('/api/mailbox/accounts', config)).body;
    const path = `/api/mailbox/accounts/${account.id}/messages/fake-message`;
    expect((await owner.get(path)).body).toMatchObject({ text: 'Hello\n' });
    const download = await owner.get(`${path}/attachments/fake-attachment`);
    expect(download.status).toBe(200);
    expect(download.headers['content-type']).toBe('application/octet-stream');
    expect(download.headers['content-disposition']).toContain('attachment;');
    expect(download.headers['content-security-policy']).toContain("default-src 'none'");
    expect((await owner.get(`${path}/attachments/unlisted`)).status).toBe(400);
    expect(
      (await owner.post(`${path}/summary`, { consent: false, providerId: 'local', model: 'tiny' }))
        .status,
    ).toBe(400);
    expect(
      (await owner.post(`${path}/summary`, { consent: true, providerId: 'cloud', model: 'tiny' }))
        .status,
    ).toBe(400);
  });
  it('sends exactly the human-approved revision once and rejects header injection', async () => {
    const { owner, transport } = await start();
    const account = (await owner.post<MailAccount>('/api/mailbox/accounts', config)).body;
    const path = `/api/mailbox/accounts/${account.id}/drafts`;
    expect(
      (
        await owner.post(path, {
          to: ['friend@example.invalid'],
          subject: 'x\r\nBcc: victim@example.invalid',
          text: '',
        })
      ).status,
    ).toBe(400);
    const draft = (
      await owner.post<MailDraft>(path, {
        to: ['friend@example.invalid'],
        subject: 'Synthetic',
        text: 'No real delivery',
      })
    ).body;
    expect(transport).not.toHaveBeenCalled();
    expect(
      (await owner.post(`${path}/${draft.id}/send`, { confirmed: false, revision: 1 })).status,
    ).toBe(400);
    expect(
      (await owner.post(`${path}/${draft.id}/send`, { confirmed: true, revision: 2 })).status,
    ).toBe(409);
    const result = await owner.post(`${path}/${draft.id}/send`, { confirmed: true, revision: 1 });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ status: 'sent' });
    expect(
      (await owner.post(`${path}/${draft.id}/send`, { confirmed: true, revision: 1 })).status,
    ).toBe(409);
    expect(transport.mock.calls.filter(([url]) => url.endsWith('/send'))).toHaveLength(1);
  });
  it('marks ambiguous sends uncertain and never retries automatically', async () => {
    const transport = fake();
    transport.mockImplementation(async () => {
      throw new Error('fake private provider error fake-mail-access-only-for-tests');
    });
    const { owner } = await start(transport);
    const account = (await owner.post<MailAccount>('/api/mailbox/accounts', config)).body;
    const path = `/api/mailbox/accounts/${account.id}/drafts`;
    const draft = (
      await owner.post<MailDraft>(path, {
        to: ['friend@example.invalid'],
        subject: 'Test',
        text: '',
      })
    ).body;
    const result = await owner.post(`${path}/${draft.id}/send`, { confirmed: true, revision: 1 });
    expect(result.status).toBe(503);
    expect(JSON.stringify(result.body)).not.toContain('fake private');
    expect((await owner.get(path)).body).toMatchObject({ drafts: [{ status: 'uncertain' }] });
    expect(
      (await owner.post(`${path}/${draft.id}/send`, { confirmed: true, revision: 1 })).status,
    ).toBe(409);
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
