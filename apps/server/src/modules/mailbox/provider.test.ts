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
});

describe('HTML mail text extraction', () => {
  it('extracts readable text without resource attributes or executable content', () => {
    expect(
      htmlToMailText(
        '<style>x{}</style><script>steal()</script><p>A &amp; B</p><img src="https://tracker.invalid">',
      ),
    ).toBe('A & B\n');
  });

  it('omits document metadata, hidden content and inert templates', () => {
    expect(
      htmlToMailText(
        '<!doctype html><html><head><title>Private metadata</title>' +
          '<style>@import "https://tracker.invalid/style";</style></head><body>' +
          '<template><p>Template</p></template><noscript>Fallback</noscript>' +
          '<div hidden><p>Hidden content</p></div><p>Visible</p></body></html>',
      ),
    ).toBe('Visible\n');
  });

  it('handles quoted brackets and malformed or unclosed script tags with HTML parsing rules', () => {
    expect(
      htmlToMailText(
        '<p title="a > b">Before</p><script>hidden </ script ><script>also hidden</script><p>After</p>',
      ),
    ).toBe('Before\nAfter\n');
    expect(htmlToMailText('<p>Visible</p><script>unclosed script')).toBe('Visible\n');
    expect(htmlToMailText('<p>Visible</p><style>unclosed style')).toBe('Visible\n');
  });

  it('decodes entities once, preserving escaped tags as literal text', () => {
    expect(
      htmlToMailText(
        '&lt;img src="https://tracker.invalid/pixel" onerror="alert(1)"&gt;' +
          ' &amp;lt;script&amp;gt; &copy; &#x1f600; &nbsp;',
      ),
    ).toBe(
      '<img src="https://tracker.invalid/pixel" onerror="alert(1)">' + ' &lt;script&gt; © 😀  ',
    );
    expect(htmlToMailText('&#0; &#xD800; &#x110000;')).toBe('� � �');
  });

  it('preserves reading order and line breaks without recursive traversal', () => {
    expect(htmlToMailText('<div>One<br>Two</div><ul><li>Three</li></ul>')).toBe(
      'One\nTwo\nThree\n',
    );
    const depth = 12_000;
    expect(htmlToMailText('<span>'.repeat(depth) + 'Deep text' + '</span>'.repeat(depth))).toBe(
      'Deep text',
    );
  });

  it('bounds input before parsing and text output while collecting it', () => {
    expect(htmlToMailText('<!--' + 'x'.repeat(1_000_000) + '--><p>Beyond input limit</p>')).toBe(
      '',
    );
    expect(htmlToMailText('x'.repeat(500_001))).toBe('x'.repeat(500_000));
    expect(htmlToMailText('x'.repeat(499_999) + '<br>Beyond text limit')).toBe(
      'x'.repeat(499_999) + '\n',
    );
  });
});
