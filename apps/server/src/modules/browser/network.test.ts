import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { guardedRequest } from '../../kernel/net.js';
import { BrowserNetwork } from './network.js';
const input = { url: 'https://example.com', method: 'GET', headers: {} };
describe('browser network boundary', () => {
  it('rejects every non-HTTPS or private-address request before transport', async () => {
    const request = vi.fn<typeof guardedRequest>();
    const network = new BrowserNetwork(request);
    for (const url of [
      'http://example.com',
      'https://127.0.0.1',
      'https://169.254.169.254',
      'https://[::1]',
      'file:///etc/passwd',
      'ws://example.com',
      'wss://example.com',
      'ftp://example.com',
    ])
      await expect(network.fetch({ ...input, url })).rejects.toBeDefined();
    expect(request).not.toHaveBeenCalled();
  });
  it('returns redirects without following and sends no proxy/upgrade headers', async () => {
    const request = vi.fn<typeof guardedRequest>().mockResolvedValue({
      status: 302,
      headers: { location: 'https://127.0.0.1/private' },
      body: Readable.from(['redirect']),
    });
    const result = await new BrowserNetwork(request).fetch({
      ...input,
      headers: {
        Host: 'localhost',
        Upgrade: 'websocket',
        'Proxy-Authorization': 'not-allowed',
        Accept: 'text/html',
      },
    });
    expect(result.status).toBe(302);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[1]?.headers).toEqual({
      Accept: 'text/html',
      'accept-encoding': 'identity',
    });
  });
  it('blocks downloads and protocol upgrades', async () => {
    for (const response of [
      { status: 200, headers: { 'content-disposition': 'attachment; filename=a' } },
      { status: 101, headers: {} },
    ]) {
      const request = vi
        .fn<typeof guardedRequest>()
        .mockResolvedValue({ ...response, body: Readable.from(['do not download']) });
      await expect(new BrowserNetwork(request).fetch(input)).rejects.toBeDefined();
    }
  });
  it('enforces bounded responses and rejects opaque uploads', async () => {
    const request = vi.fn<typeof guardedRequest>().mockResolvedValue({
      status: 200,
      headers: {},
      body: Readable.from([Buffer.alloc(6 * 1024 * 1024 + 1)]),
    });
    const network = new BrowserNetwork(request);
    await expect(network.fetch(input)).rejects.toBeDefined();
    await expect(
      network.fetch({ ...input, method: 'POST', hasPostData: true }),
    ).rejects.toBeDefined();
  });
});
