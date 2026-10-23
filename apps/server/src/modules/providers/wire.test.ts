import { describe, expect, it } from 'vitest';
import { badRequest, forbidden, payloadTooLarge, unavailable } from '../../kernel/errors.js';
import { ProviderError } from './openai-client.js';
import { PROVIDER_PRESETS } from './presets.js';
import { assertTransport, checkBaseUrl, describeFailure, policyOf } from './wire.js';

describe('checkBaseUrl', () => {
  it('accepts a public https address and stores it without a trailing slash', () => {
    expect(checkBaseUrl('https://api.deepseek.com', false)).toBe('https://api.deepseek.com');
    expect(checkBaseUrl(' https://API.OpenAI.com/v1/ ', false)).toBe('https://api.openai.com/v1');
    expect(checkBaseUrl('https://example.com:8443/llm/v1', false)).toBe(
      'https://example.com:8443/llm/v1',
    );
  });

  it.each([
    ['plain http', 'http://api.example.com/v1', 'insecure_url'],
    ['loopback over https', 'https://127.0.0.1:8080/v1', 'address_not_allowed'],
    ['a private address', 'https://192.168.1.20/v1', 'address_not_allowed'],
    ['IPv6 loopback', 'https://[::1]:8080/v1', 'address_not_allowed'],
    ['the cloud metadata address', 'https://169.254.169.254/latest', 'address_not_allowed'],
    ['an IPv4-mapped loopback address', 'https://[::ffff:127.0.0.1]/v1', 'address_not_allowed'],
    ['credentials in the address', 'https://user:secret@api.example.com/v1', 'invalid_url'],
    ['another scheme', 'ftp://api.example.com/v1', 'invalid_url'],
    ['a file', 'file:///etc/passwd', 'invalid_url'],
    ['something that is no address', 'not a url', 'invalid_url'],
    ['a query string', 'https://api.example.com/v1?key=abc', 'invalid_url'],
    ['a fragment', 'https://api.example.com/v1#x', 'invalid_url'],
  ])('refuses %s without the private-network flag', (_what, url, code) => {
    expect(() => checkBaseUrl(url, false)).toThrow(expect.objectContaining({ code }));
  });

  it('with the flag, accepts loopback and private addresses, also over plain http', () => {
    expect(checkBaseUrl('http://127.0.0.1:11434/v1', true)).toBe('http://127.0.0.1:11434/v1');
    expect(checkBaseUrl('http://192.168.1.20:8000', true)).toBe('http://192.168.1.20:8000');
    expect(checkBaseUrl('http://[::1]:8080/v1', true)).toBe('http://[::1]:8080/v1');
    expect(checkBaseUrl('http://localhost:1234/v1', true)).toBe('http://localhost:1234/v1');
    expect(checkBaseUrl('https://10.0.0.5/v1', true)).toBe('https://10.0.0.5/v1');
  });

  it('even with the flag, never accepts link-local addresses or plain http to a public address', () => {
    expect(() => checkBaseUrl('http://169.254.169.254/latest/meta-data', true)).toThrow(
      expect.objectContaining({ code: 'address_not_allowed' }),
    );
    expect(() => checkBaseUrl('https://169.254.169.254/', true)).toThrow(
      expect.objectContaining({ code: 'address_not_allowed' }),
    );
    expect(() => checkBaseUrl('http://[fe80::1]/v1', true)).toThrow(
      expect.objectContaining({ code: 'address_not_allowed' }),
    );
    expect(() => checkBaseUrl('http://8.8.8.8/v1', true)).toThrow(
      expect.objectContaining({ code: 'insecure_url' }),
    );
  });

  it('gives the guarded client a policy that matches the flag', () => {
    expect(policyOf(false)).toEqual({});
    expect(policyOf(true)).toEqual({ allowPrivateNetwork: true, allowHttp: true });
  });
});

describe('assertTransport', () => {
  it('lets https through without resolving anything', async () => {
    await expect(
      assertTransport({
        baseUrl: 'https://name-that-does-not-resolve.invalid/v1',
        allowPrivateNetwork: false,
      }),
    ).resolves.toBeUndefined();
  });

  it('allows plain http only to names that resolve to private addresses', async () => {
    await expect(
      assertTransport({ baseUrl: 'http://localhost:1/v1', allowPrivateNetwork: true }),
    ).resolves.toBeUndefined();
    await expect(
      assertTransport({ baseUrl: 'http://127.0.0.1:1/v1', allowPrivateNetwork: true }),
    ).resolves.toBeUndefined();
    await expect(
      assertTransport({ baseUrl: 'http://8.8.8.8/v1', allowPrivateNetwork: true }),
    ).rejects.toMatchObject({ code: 'insecure_url' });
    await expect(
      assertTransport({
        baseUrl: 'http://name-that-does-not-resolve.invalid/v1',
        allowPrivateNetwork: true,
      }),
    ).rejects.toMatchObject({ code: 'upstream_unreachable' });
  });

  it('refuses plain http outright without the flag', async () => {
    await expect(
      assertTransport({ baseUrl: 'http://localhost:1/v1', allowPrivateNetwork: false }),
    ).rejects.toMatchObject({ code: 'insecure_url' });
  });
});

describe('describeFailure', () => {
  const who = { name: 'Acme AI', model: 'acme-1' };
  const upstream = (status: number, code: string, detail: string, retryAfter?: number) =>
    new ProviderError(502, code, `The model provider said (${detail}).`, retryAfter, status);

  it.each([
    [
      upstream(401, 'provider_auth_failed', 'Incorrect API key sk-live-12345678901234567890'),
      'provider_auth_failed',
      'rejected the API key',
    ],
    [
      upstream(402, 'provider_no_credit', 'Insufficient Balance'),
      'provider_no_credit',
      'no credit left',
    ],
    [
      upstream(404, 'provider_model_not_found', 'model does not exist'),
      'provider_model_not_found',
      'does not know the model "acme-1"',
    ],
    [upstream(429, 'provider_rate_limited', 'slow down', 7), 'provider_rate_limited', 'in 7 s'],
    [
      upstream(503, 'provider_unavailable', 'internal stack trace at db.internal:5432'),
      'provider_unavailable',
      'HTTP 503',
    ],
    [
      upstream(400, 'provider_rejected', 'invalid parameter foo from internal-host-17'),
      'provider_rejected',
      'HTTP 400',
    ],
    [upstream(302, 'provider_rejected', ''), 'provider_redirected', 'never followed'],
    [
      upstream(400, 'provider_rejected', "This model's maximum context length is 65536 tokens"),
      'provider_context_too_long',
      'too long for this model',
    ],
    [
      new ProviderError(503, 'provider_stream_broken', 'ended early'),
      'provider_stream_broken',
      'broke off',
    ],
    [
      new ProviderError(503, 'provider_stream_error', 'mid-answer (secret detail)'),
      'provider_stream_broken',
      'broke off',
    ],
    [
      new ProviderError(502, 'provider_protocol_error', 'oversized event'),
      'provider_protocol_error',
      'not a valid answer',
    ],
    [payloadTooLarge('too much'), 'provider_protocol_error', 'not a valid answer'],
    [
      unavailable(
        'Could not reach internal-host:8443: connect ECONNREFUSED 10.1.2.3:8443',
        'upstream_unreachable',
      ),
      'provider_unreachable',
      'could not be reached',
    ],
    [
      forbidden('"x" resolves to an address this server may not contact.', 'address_not_allowed'),
      'provider_address_not_allowed',
      'allow private network',
    ],
    [
      badRequest('Only https:// addresses are accepted here.', undefined, 'insecure_url'),
      'provider_address_not_allowed',
      'https is required',
    ],
    [new DOMException('aborted', 'AbortError'), 'provider_timeout', 'took too long'],
    [
      new TypeError("Cannot read properties of undefined (reading 'x')"),
      'provider_error',
      'failed unexpectedly',
    ],
    ['a thrown string', 'provider_error', 'failed unexpectedly'],
  ])('maps %s', (error, code, phrase) => {
    const failure = describeFailure(error, who);
    expect(failure.code).toBe(code);
    expect(failure.message).toContain(phrase);
    expect(failure.message).toContain('Acme AI');
  });

  it("never passes on the provider's own words", () => {
    const leaky = [
      upstream(401, 'provider_auth_failed', 'Incorrect API key sk-live-12345678901234567890'),
      upstream(500, 'provider_unavailable', 'internal stack trace at db.internal:5432'),
      upstream(400, 'provider_rejected', 'invalid parameter foo from internal-host-17'),
      new ProviderError(503, 'provider_stream_error', 'mid-answer (secret detail)'),
      unavailable(
        'Could not reach internal-host:8443: connect ECONNREFUSED 10.1.2.3:8443',
        'upstream_unreachable',
      ),
    ];
    for (const error of leaky) {
      const { message } = describeFailure(error, who);
      for (const secret of [
        'sk-live',
        '12345678901234567890',
        'db.internal',
        'internal-host',
        'secret detail',
        '10.1.2.3',
        'stack trace',
      ])
        expect(message).not.toContain(secret);
    }
  });

  it('carries the wait a rate limit asks for, and copes without a model name', () => {
    expect(
      describeFailure(upstream(429, 'provider_rate_limited', '', 30), who).retryAfterSeconds,
    ).toBe(30);
    expect(describeFailure(upstream(429, 'provider_rate_limited', ''), who).message).toContain(
      'in a moment',
    );
    expect(
      describeFailure(upstream(404, 'provider_model_not_found', ''), { name: 'Acme AI' }).message,
    ).toContain('Check the base URL');
  });
});

describe('presets', () => {
  it('offers DeepSeek, OpenAI, Anthropic and a custom server without claiming verification', () => {
    expect(PROVIDER_PRESETS.map((preset) => preset.id)).toEqual([
      'deepseek',
      'openai',
      'anthropic',
      'custom',
    ]);
    for (const preset of PROVIDER_PRESETS) {
      expect(preset.verified).toBe(false);
      expect(preset.note.length).toBeGreaterThan(20);
      // A preset must pass the same check as anything the owner types.
      if (preset.baseUrl !== '')
        expect(checkBaseUrl(preset.baseUrl, preset.allowPrivateNetwork)).toBe(preset.baseUrl);
      const ids = preset.models.map((model) => model.id);
      expect(new Set(ids).size).toBe(ids.length);
      if (preset.defaultModel !== null) expect(ids).toContain(preset.defaultModel);
      // No price is preset: a wrong one would show a confident, wrong cost.
      expect(preset.models.every((model) => model.prices === null)).toBe(true);
    }
    expect(PROVIDER_PRESETS[0]).toMatchObject({
      baseUrl: 'https://api.deepseek.com',
      balance: 'deepseek',
      keyRequired: true,
    });
    expect(PROVIDER_PRESETS.find((preset) => preset.id === 'custom')).toMatchObject({
      baseUrl: '',
      keyRequired: false,
      models: [],
    });
    expect(PROVIDER_PRESETS.find((preset) => preset.id === 'anthropic')).toMatchObject({
      kind: 'anthropic',
      keyRequired: true,
      models: [],
    });
  });
});
