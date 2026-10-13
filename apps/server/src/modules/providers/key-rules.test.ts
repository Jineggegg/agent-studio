import { describe, expect, it } from 'vitest';
import { checkApiKey } from './key-rules.js';

describe('checkApiKey', () => {
  it.each([
    ['a DeepSeek-style key', 'sk-0123456789abcdef0123456789abcdef'],
    ['an OpenAI project key', 'sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCd'],
    ['an Anthropic API key', 'sk-ant-api03-AbCdEfGhIjKlMnOp_QrStUvWxYz-0123456789'],
    ['a key with a dot in it', '0123456789abcdef.ABCDEFGH'],
    ['the short key of a self-hosted server', 'local-llm'],
  ])('accepts %s', (_what, key) => {
    expect(checkApiKey(key)).toEqual({ ok: true, key });
  });

  it('drops white space around a pasted key', () => {
    expect(checkApiKey('  sk-0123456789abcdef \n')).toEqual({ ok: true, key: 'sk-0123456789abcdef' });
  });

  it.each([
    ['empty', '   ', 'empty'],
    ['too short', 'sk-1234', 'too_short'],
    ['too long', `sk-${'a'.repeat(600)}`, 'too_long'],
    ['two words', 'sk-0123456789 abcdef', 'whitespace'],
    ['two lines', 'sk-0123456789\nsk-abcdefghij', 'whitespace'],
    ['a header-smuggling attempt', 'sk-0123456789\r\nX-Other: 1', 'whitespace'],
    ['characters outside ASCII', 'sk-0123456789абвгд', 'characters'],
    ['an invisible control character', 'sk-01234567\u000789abcdef', 'characters'],
    ['an address', 'https://api.deepseek.com/v1', 'looks_like_url'],
    ['a subscription sign-in token', 'sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', 'sign_in_token'],
    ['a browser session key', 'sk-ant-sid01-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', 'sign_in_token'],
    ['a legacy session token', 'sess-AbCdEfGhIjKlMnOpQrStUvWxYz', 'sign_in_token'],
    ['a JSON Web Token', 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl', 'sign_in_token'],
    ['an organisation admin key', 'sk-admin-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', 'admin_key'],
    ['an Anthropic admin key', 'sk-ant-admin01-AbCdEfGhIjKlMnOpQrStUvWxYz', 'admin_key'],
    ['a GitHub token', 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', 'other_service'],
    ['a fine-grained GitHub token', 'github_pat_11ABCDEFG0abcdefghijkl', 'other_service'],
    ['an AWS access key id', 'AKIAIOSFODNN7EXAMPLE', 'other_service'],
    ["one of this Studio's own tokens", 'ast_AbCdEfGhIjKlMnOpQrStUvWxYz012345', 'other_service'],
  ])('refuses %s without repeating it', (_what, value, problem) => {
    const result = checkApiKey(value);
    expect(result).toMatchObject({ ok: false, problem });
    if (result.ok) return;
    const pasted = value.trim();
    // Not the value, and no recognisable piece of it.
    if (pasted !== '') expect(result.message).not.toContain(pasted);
    for (let at = 0; at + 6 <= pasted.length; at += 3) expect(result.message, `piece at ${at}`).not.toContain(pasted.slice(at, at + 6));
  });
});
