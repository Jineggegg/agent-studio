import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { MailProvider, htmlToMailText, type MailTransport } from './provider.js';
const response = (value: unknown, status = 200) => ({
  status,
  headers: {},
  body: Readable.from([JSON.stringify(value)]),
});
describe('mail protocol adapters', () => {
  it('refuses foreign and credential-bearing Graph cursors before sending credentials', async () => {
    const transport = vi.fn<MailTransport>();
    const provider = new MailProvider(
      'outlook',
      { accessToken: 'synthetic-token' },
      () => {},
      transport,
    );
    for (const cursor of [
      'https://evil.invalid/v1.0/me/messages',
      'https://graph.microsoft.com/v1.0/users/another/messages',
      'https://attacker@graph.microsoft.com/v1.0/me/messages',
    ])
      await expect(provider.list({ search: '', cursor })).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });
  it('uses fixed refresh endpoints and only stores the renewed encrypted-store payload', async () => {
    const save = vi.fn(),
      transport = vi
        .fn<MailTransport>()
        .mockResolvedValueOnce(response({}, 401))
        .mockResolvedValueOnce(
          response({ access_token: 'synthetic-new', refresh_token: 'synthetic-refresh-new' }),
        )
        .mockResolvedValueOnce(response({ labels: [] }));
    const provider = new MailProvider(
      'gmail',
      {
        accessToken: 'synthetic-old',
        refreshToken: 'synthetic-refresh',
        clientId: 'synthetic-client',
      },
      save,
      transport,
    );
    await expect(provider.folders()).resolves.toEqual({ folders: [], truncated: false });
    expect(transport.mock.calls[1]?.[0]).toBe('https://oauth2.googleapis.com/token');
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'synthetic-new' }));
  });
  it('never follows HTML links or preserves active markup', () => {
    expect(
      htmlToMailText(
        '<style>x{}</style><script>steal()</script><p>A &amp; B</p><img src="https://tracker.invalid">',
      ),
    ).toBe('A & B\n');
  });
});
