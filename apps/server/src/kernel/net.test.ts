import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkUrl, classifyAddress, guardedRequest, readBody } from './net.js';

describe('classifyAddress', () => {
  it.each([
    ['8.8.8.8', 'public'],
    ['1.1.1.1', 'public'],
    ['2606:4700:4700::1111', 'public'],
    ['127.0.0.1', 'non-public'],
    ['10.1.2.3', 'non-public'],
    ['172.16.0.1', 'non-public'],
    ['192.168.1.1', 'non-public'],
    ['100.64.0.1', 'non-public'],
    ['0.0.0.0', 'non-public'],
    ['::1', 'non-public'],
    ['fd00::1', 'non-public'],
    ['::ffff:127.0.0.1', 'non-public'],
    ['::ffff:10.0.0.1', 'non-public'],
    ['169.254.169.254', 'link-local'],
    ['::ffff:169.254.169.254', 'link-local'],
    ['fe80::1', 'link-local'],
    ['not-an-ip', 'invalid'],
  ])('%s is %s', (address, expected) => {
    expect(classifyAddress(address)).toBe(expected);
  });
});

describe('checkUrl', () => {
  it('accepts a public https URL', () => {
    expect(checkUrl('https://api.example.com/v1').hostname).toBe('api.example.com');
  });

  it.each([
    'http://api.example.com',
    'file:///etc/passwd',
    'gopher://example.com',
    'https://user:pass@example.com',
    'https://127.0.0.1/',
    'https://[::1]/',
    'https://169.254.169.254/latest/meta-data',
    'https://10.0.0.5/',
    'not a url',
  ])('rejects %s by default', (url) => {
    expect(() => checkUrl(url)).toThrow();
  });

  it('never allows link-local, even when private networks are allowed', () => {
    expect(() => checkUrl('http://169.254.169.254/', { allowPrivateNetwork: true, allowHttp: true })).toThrow();
    expect(checkUrl('http://127.0.0.1:11434/', { allowPrivateNetwork: true, allowHttp: true }).port).toBe('11434');
  });
});

describe('guardedRequest', () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      if (request.url === '/redirect') {
        response.writeHead(302, { location: 'http://169.254.169.254/' }).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'text/plain' }).end('hello from the inside');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(() => {
    server.close();
  });

  it('refuses a name that resolves to this machine', async () => {
    await expect(
      guardedRequest(`http://localhost:${port}/`, { policy: { allowHttp: true } }),
    ).rejects.toMatchObject({ code: 'address_not_allowed' });
  });

  it('reaches a local service only when the policy says so', async () => {
    const response = await guardedRequest(`http://localhost:${port}/`, {
      policy: { allowHttp: true, allowPrivateNetwork: true },
    });
    expect(response.status).toBe(200);
    expect((await readBody(response.body)).toString()).toBe('hello from the inside');
  });

  it('checks every request on a connection of its own, never one a looser policy left open', async () => {
    const allowed = await guardedRequest(`http://localhost:${port}/`, {
      policy: { allowHttp: true, allowPrivateNetwork: true },
    });
    await readBody(allowed.body);
    await expect(
      guardedRequest(`http://localhost:${port}/`, { policy: { allowHttp: true } }),
    ).rejects.toMatchObject({ code: 'address_not_allowed' });
  });

  it('does not follow redirects', async () => {
    const response = await guardedRequest(`http://127.0.0.1:${port}/redirect`, {
      policy: { allowHttp: true, allowPrivateNetwork: true },
    });
    expect(response.status).toBe(302);
    response.body.resume();
  });

  it('caps how much it will buffer', async () => {
    const response = await guardedRequest(`http://127.0.0.1:${port}/`, {
      policy: { allowHttp: true, allowPrivateNetwork: true },
    });
    await expect(readBody(response.body, 5)).rejects.toMatchObject({ code: 'too_large' });
  });
});
