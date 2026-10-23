import { afterEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { NOTIFICATION_PREFERENCE_KEYS } from '@agent-studio/protocol';
import type { guardedRequest } from '../../src/kernel/net.js';
import { modules } from '../../src/modules/index.js';
import { createInboxModule } from '../../src/modules/inbox/inbox.module.js';
import { sendSmtp } from '../../src/modules/inbox/smtp.js';
import { createTestStudio, type TestStudio } from '../../src/testing/harness.js';
const studios: TestStudio[] = [];
afterEach(async () => {
  for (const t of studios.splice(0)) await t.close();
});
const smtpConfig = {
  kind: 'smtp',
  enabled: true,
  host: 'smtp.example.invalid',
  username: 'test-user',
  password: 'synthetic-smtp-secret',
  from: 'sender@example.invalid',
  to: 'recipient@example.invalid',
};
async function start() {
  const smtp = vi.fn<typeof sendSmtp>().mockResolvedValue(undefined);
  const http = vi.fn<typeof guardedRequest>(async () => ({
    status: 200,
    headers: {},
    body: Readable.from(['{"code":200}']),
  }));
  const t = await createTestStudio({
    modules: modules.map((m) =>
      m.name === 'inbox' ? createInboxModule({ external: { smtp, http } }) : m,
    ),
  });
  studios.push(t);
  return { t, owner: await t.owner(), smtp, http };
}
describe('explicit portable notification channels', () => {
  it('keeps empty defaults and secrets private, never tests on save, and enforces CSRF', async () => {
    const { t, owner, smtp } = await start();
    expect((await t.anonymous().get('/api/notifications/channels')).status).toBe(401);
    expect((await owner.get('/api/notifications/channels')).body).toEqual({ channels: [] });
    expect((await owner.put('/api/notifications/channels', smtpConfig)).status).toBe(200);
    expect(smtp).not.toHaveBeenCalled();
    expect(JSON.stringify((await owner.get('/api/notifications/channels')).body)).not.toContain(
      smtpConfig.password,
    );
    expect(JSON.stringify(t.studio.context.db.all('SELECT * FROM secrets'))).not.toContain(
      smtpConfig.password,
    );
    const member = await t.member();
    expect((await member.get('/api/notifications/channels')).body).toEqual({ channels: [] });
    expect(
      (await member.post('/api/notifications/channels/smtp/test', { confirmed: true })).status,
    ).toBe(400);
    expect((await owner.post('/api/notifications/channels/smtp/test', {})).status).toBe(400);
    expect(
      (
        await owner.request(
          'POST',
          '/api/notifications/channels/smtp/test',
          { confirmed: true },
          { 'x-studio-csrf': 'invalid' },
        )
      ).status,
    ).toBe(403);
    expect(
      (await owner.post('/api/notifications/channels/smtp/test', { confirmed: true })).status,
    ).toBe(200);
    expect(smtp).toHaveBeenCalledOnce();
  });
  it('requires new credentials on destination changes and blocks private Bark addresses', async () => {
    const { owner, http } = await start();
    expect(
      (
        await owner.put('/api/notifications/channels', {
          kind: 'bark',
          enabled: true,
          endpoint: 'https://127.0.0.1/',
          deviceKey: 'fake-key',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await owner.put('/api/notifications/channels', {
          kind: 'bark',
          enabled: true,
          endpoint: 'https://bark.example.invalid/',
          deviceKey: 'fake-key',
        })
      ).status,
    ).toBe(200);
    expect(http).not.toHaveBeenCalled();
    expect(
      (
        await owner.put('/api/notifications/channels', {
          kind: 'bark',
          enabled: true,
          endpoint: 'https://another.example.invalid/',
        })
      ).status,
    ).toBe(400);
    expect(
      (await owner.post('/api/notifications/channels/bark/test', { confirmed: true })).status,
    ).toBe(200);
    expect(http.mock.calls[0]?.[0]).toBe('https://bark.example.invalid/push');
  });
  it('delivers through configured channels with discreet content and honors event switches', async () => {
    const { t, owner, smtp } = await start();
    await owner.put('/api/notifications/channels', smtpConfig);
    const service = t.studio.context.services.inbox;
    const content = {
      kind: 'automation' as const,
      title: 'Task',
      body: 'Private reminder text',
      discreet: { body: 'Reminder ready' },
      link: '/',
      tag: 'fake',
    };
    await service.notify(owner.userId!, content);
    expect(smtp).toHaveBeenCalledWith(expect.objectContaining({ text: 'Reminder ready' }));
    t.studio.context.services.preferences.patch(owner.userId!, {
      [NOTIFICATION_PREFERENCE_KEYS.events]: { automation: false },
    });
    await service.notify(owner.userId!, content);
    expect(smtp).toHaveBeenCalledTimes(1);
  });
  it('refuses local SMTP destinations before opening a connection', async () => {
    await expect(
      sendSmtp({ ...smtpConfig, port: 465, host: '127.0.0.1', title: 'Test', text: 'Test' }),
    ).rejects.toMatchObject({ code: 'address_not_allowed' });
  });
});
