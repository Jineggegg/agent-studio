import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { type HttpClientDeps, type UploadRequest, createHttpClient } from './http';

/** A stand-in for XMLHttpRequest that the test drives by hand. */
class FakeUpload implements UploadRequest {
  method = '';
  url = '';
  headers: Record<string, string> = {};
  body: FormData | null = null;
  aborted = false;
  status = 0;
  responseText = '';
  timeout = 0;
  upload: UploadRequest['upload'] = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value;
  }
  send(body: FormData): void {
    this.body = body;
  }
  abort(): void {
    this.aborted = true;
    this.onabort?.();
  }
  answer(status: number, body: unknown): void {
    this.status = status;
    this.responseText = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    this.onload?.();
  }
}

function setup(overrides: Partial<HttpClientDeps> = {}) {
  const requests: FakeUpload[] = [];
  const deps: HttpClientDeps = {
    fetch: (async () => {
      throw new Error('uploads do not use fetch');
    }) as typeof fetch,
    createUploadRequest: () => {
      const request = new FakeUpload();
      requests.push(request);
      return request;
    },
    getCsrfToken: () => 'csrf-token-1',
    onUnauthorized: vi.fn(),
    requestReauth: vi.fn(async () => true),
    ...overrides,
  };
  return { client: createHttpClient(deps), requests, deps };
}

const form = () => {
  const data = new FormData();
  data.append('file', new Blob(['hello']), 'hello.txt');
  return data;
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('uploading files', () => {
  it('posts the form with the anti-forgery header, reports progress and validates the answer', async () => {
    const { client, requests } = setup();
    const progress: number[] = [];
    const body = form();
    const pending = client.upload('/api/sessions/s1/attachments', body, { schema: z.object({ ok: z.boolean() }), onProgress: (value) => progress.push(value) });
    const request = requests[0]!;
    expect([request.method, request.url]).toEqual(['POST', '/api/sessions/s1/attachments']);
    expect(request.headers['x-studio-csrf']).toBe('csrf-token-1');
    // The browser sets the multipart boundary itself.
    expect(request.headers['content-type']).toBeUndefined();
    expect(request.body).toBe(body);

    request.upload.onprogress?.({ lengthComputable: true, loaded: 25, total: 100 });
    request.upload.onprogress?.({ lengthComputable: false, loaded: 99, total: 0 });
    request.answer(201, { ok: true });
    await expect(pending).resolves.toEqual({ ok: true });
    expect(progress).toEqual([0.25, 1]);
  });

  it('refuses anything but a same-origin path', async () => {
    const { client, requests } = setup();
    await expect(client.upload('https://evil.example/upload', form())).rejects.toMatchObject({ code: 'invalid_request' });
    expect(requests).toHaveLength(0);
  });

  it('turns the server’s refusal into the same error as any other request', async () => {
    const { client, requests } = setup();
    const pending = client.upload('/api/x', form()).catch((reason: unknown) => reason);
    requests[0]!.answer(413, { error: { code: 'attachment_too_large', message: '"big.mov" is larger than 10 MB.', details: { rejected: [] } } });
    expect(await pending).toMatchObject({ status: 413, code: 'attachment_too_large', message: '"big.mov" is larger than 10 MB.' });
  });

  it('names a refusal that is not JSON by its status', async () => {
    const { client, requests } = setup();
    const pending = client.upload('/api/x', form()).catch((reason: unknown) => reason);
    requests[0]!.answer(413, '<html>Request Entity Too Large</html>');
    expect(await pending).toMatchObject({ status: 413, code: 'too_large' });
  });

  it.each([
    ['a network failure', (request: FakeUpload) => request.onerror?.(), 'network_error'],
    ['a timeout', (request: FakeUpload) => request.ontimeout?.(), 'timeout'],
  ])('reports %s as unreachable, never as a sign-out', async (_name, fail, code) => {
    const { client, requests, deps } = setup();
    const pending = client.upload('/api/x', form()).catch((reason: unknown) => reason);
    fail(requests[0]!);
    expect(await pending).toMatchObject({ status: 0, code, unreachable: true });
    expect(deps.onUnauthorized).not.toHaveBeenCalled();
  });

  it('can be cancelled', async () => {
    const { client, requests } = setup();
    const controller = new AbortController();
    const pending = client.upload('/api/x', form(), { signal: controller.signal }).catch((reason: unknown) => reason);
    controller.abort();
    expect(await pending).toMatchObject({ code: 'aborted' });
    expect(requests[0]!.aborted).toBe(true);
  });

  it('ends the session on 401', async () => {
    const { client, requests, deps } = setup();
    const pending = client.upload('/api/x', form()).catch((reason: unknown) => reason);
    requests[0]!.answer(401, { error: { code: 'unauthorized', message: 'Sign in.' } });
    expect(await pending).toMatchObject({ status: 401 });
    expect(deps.onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('asks for the password once on reauth_required and then repeats the upload', async () => {
    const { client, requests, deps } = setup();
    const pending = client.upload('/api/x', form());
    requests[0]!.answer(403, { error: { code: 'reauth_required', message: 'Confirm.' } });
    await tick();
    expect(deps.requestReauth).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(2);
    requests[1]!.answer(200, { done: true });
    await expect(pending).resolves.toEqual({ done: true });
  });

  it('rejects an answer the schema does not recognise', async () => {
    const { client, requests } = setup();
    const pending = client.upload('/api/x', form(), { schema: z.object({ id: z.string() }) }).catch((reason: unknown) => reason);
    requests[0]!.answer(200, { id: 5 });
    expect(await pending).toMatchObject({ code: 'invalid_response' });
  });
});
