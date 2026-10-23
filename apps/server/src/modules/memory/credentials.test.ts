import { describe, expect, it } from 'vitest';
import { redactSecrets } from '../../kernel/redact.js';
import { describeCredentialKind, findCredential, findCredentialInNote, looksGenerated } from './credentials.js';

// Every value below is made up for these tests. None of them opens anything.

/** A repeatable stand-in for a generated key: the same "random" characters on every run. */
function generated(length: number, seed: number, alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'): string {
  let state = seed >>> 0;
  let result = '';
  while (result.length < length) {
    // xorshift32
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    result += alphabet[state % alphabet.length];
  }
  return result;
}

const kindOf = (text: string) => findCredential(text)?.kind ?? null;

describe('well-known credential formats', () => {
  it.each([
    ['private_key', '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----'],
    ['private_key', 'here it is: -----BEGIN OPENSSH PRIVATE KEY----- b3BlbnNzaC1rZXktdjEA'],
    ['private_key', '-----BEGIN RSA PRIVATE KEY-----'],
    ['private_key', '-----BEGIN PGP PRIVATE KEY BLOCK-----'],
    ['api_key', 'use sk-abcdefghijklmnopqrstuvwxyz123456 for the staging model'],
    ['api_key', 'sk-proj-Ab12Cd34Ef56Gh78Ij90Kl12Mn34'],
    ['api_key', `sk_live_${generated(24, 7)}`],
    ['api_key', `AIza${generated(35, 3)}`],
    ['access_token', 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['access_token', 'github_pat_11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz'],
    ['access_token', 'glpat-abcdefghij0123456789'],
    ['access_token', 'ast_abcdefghijklmnopqrstuvwxyz012345'],
    ['access_token', 'xoxb-123456789012-abcdefghijkl'],
    ['access_token', `hf_${generated(34, 5)}`],
    ['cloud_key', 'AKIAIOSFODNN7EXAMPLE'],
    ['cloud_key', 'aws_access_key_id = ASIAIOSFODNN7EXAMPLE'],
    ['signed_token', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpM'],
    ['bearer_token', 'Authorization: Bearer abcdef0123456789abcdef'],
    ['bearer_token', 'curl -H "authorization: basic dXNlcjpwYXNzd29yZDEyMw=="'],
    ['webhook', 'post to https://hooks.slack.com/services/T00000000/B00000000/abcdefghijklmnopqrstuvwx'],
    ['webhook', 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz-0123456789_ABCD'],
    ['url_password', 'postgres://admin:s3cr3t-Pa55@db.internal:5432/app'],
    ['url_password', 'clone from https://deploy:glx9Q2kd@git.example.com/team/repo.git'],
  ] as const)('finds %s in %j', (kind, text) => {
    expect(findCredential(text)).toEqual({ kind });
  });

  it('catches every token format the log redactor knows', () => {
    // The redactor and this detector keep separate pattern tables; this keeps them from drifting apart.
    const samples = [
      'sk-abcdefghijklmnopqrstuvwxyz123456',
      'rk-Ab12Cd34Ef56Gh78Ij90Kl12',
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'gho_abcdefghijklmnopqrstuvwxyz0123456789',
      'github_pat_11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz',
      'ast_abcdefghijklmnopqrstuvwxyz012345',
      'xoxp-123456789012-abcdefghijkl',
      'AKIAIOSFODNN7EXAMPLE',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpM',
      '-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----',
      'Bearer abcdef0123456789abcdef',
      'DB_PASSWORD=hunter2hunter2',
      '"api_key": "abcd1234efgh5678"',
    ];
    for (const sample of samples) {
      expect(redactSecrets(sample), sample).not.toBe(sample);
      expect(findCredential(sample), sample).not.toBeNull();
    }
  });
});

describe('a credential stated in words or as an assignment', () => {
  it.each([
    ['password', 'password = Xy7!abcd'],
    ['password', 'Password: hunter2!'],
    ['password', '**Password:** hunter2!'],
    ['password', '**Password**: `hunter2!`'],
    ['password', '"password": "P@ssw0rd!"'],
    ['password', "password: 'two w0rds here'"],
    ['password', 'export DB_PASSWORD=hunter2hunter2'],
    ['password', 'the admin passwd is letmein99'],
    ['password', 'The password for the staging box is Tr0ub4dor&3.'],
    ['password', 'set the root password to n3wSecret!'],
    ['password', 'if (password === "hunter2!") return true'],
    ['password', 'pwd=abc123!@#'],
    ['password', '密码是 Abc12345!'],
    ['password', '数据库密码：hunter2go，不要外传'],
    ['password', '口令为Passw0rd!'],
    ['secret_value', 'api_key: abcd1234efgh5678'],
    ['secret_value', 'X-API-Key: 12345abcdef67890'],
    ['secret_value', 'client_secret = "9f8e7d6c5b4a3210"'],
    ['secret_value', 'the access token is a1b2c3d4e5f6'],
    ['secret_value', 'GET https://api.example.com/v1/items?token=abc123def456&page=2'],
    ['secret_value', 'TOKEN_GITHUB=abcd1234efgh'],
    ['secret_value', '令牌是 tk9281abcz'],
    ['secret_value', 'aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'],
  ] as const)('finds %s in %j', (kind, text) => {
    expect(findCredential(text)).toEqual({ kind });
  });

  it.each([
    // The four sentences of the acceptance test: a credential word without a credential.
    'The API token is stored in ~/.config/app/token and rotated monthly.',
    'token limit 2048',
    'the signing key uses ed25519',
    'a password is mandatory.',
    // Settings that merely contain the word.
    'max_tokens: 128000',
    'max_output_tokens = 204800',
    'token limit: 2048',
    'TOKEN_TTL=3600s',
    'password_min_length: 12',
    'passwordPolicy: strict-2026',
    'secretName: prod-db-2',
    'api-key-id: key12345678',
    'tokenizer = trigram',
    'the tokenizer is unicode61',
    'passwords are hashed with scrypt',
    'PASSWORDS=enabled123',
    // Where the secret lives, not the secret.
    'password_file=/run/secrets/db_password',
    'token: ~/.config/gh/hosts.yml',
    'apiKey: process.env.OPENAI_API_KEY',
    'password = os.environ["DB_PASSWORD"]',
    'password=$DB_PASSWORD',
    'token: ${{ secrets.GITHUB_TOKEN }}',
    'secret: vault:kv/data/app#password',
    'token_endpoint: https://auth.example.com/oauth2/token',
    // Placeholders.
    'password: ********',
    'password: [redacted]',
    'token = <YOUR_TOKEN>',
    'api_key: xxxxxxxxxxxx',
    'password: changeme',
    'secret: none',
    // Ordinary words describing a credential.
    'password: required',
    'password: case-sensitive',
    'The password is stored hashed.',
    'the token was rotated',
    'Token: see the team vault',
    'secret = "client side only"',
    // Numbers, algorithms, types and code.
    'token: 123456',
    'password timeout is 30min',
    'signing key: ed25519',
    'secret key: aes-256-gcm',
    'token: hs256',
    'password hash is argon2id',
    'const token = await getToken();',
    'password: z.string().min(10)',
    'token = jwt.sign(payload, key)',
    'password !== confirmation1',
    'token?: string',
    'let secret: Buffer1',
    'Token::Variant123456',
    // Chinese prose about credentials.
    '密码是必填的',
    '密码长度为8位以上',
    '令牌保存在密钥管理器里',
    // Addresses with placeholder passwords, as in documentation.
    'postgres://user:password@localhost:5432/app',
    'https://user:<password>@example.com/',
    'redis://default:${REDIS_PASSWORD}@cache:6379',
    'git@github.com:team/repo.git',
    'https://example.com:8443/path@v2',
    // "Bearer" and "Basic" as words.
    'Send it as a Bearer token in the Authorization header.',
    'Basic authentication is switched off.',
    'Authorization: Bearer <token>',
    // Things that look a little like keys.
    'sk-learn-pipeline-config-notes',
    'the pk-migration-checklist-document',
    'commit 3f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39',
    'id 550e8400-e29b-41d4-a716-446655440000',
    'ID 550E8400-E29B-41D4-A716-446655440000',
    'sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    'AKIA is the prefix of an access key id',
    'eyJ is how a signed token starts',
  ])('lets %j through', (text) => {
    expect(kindOf(text)).toBeNull();
  });
});

describe('long random-looking strings', () => {
  it('finds a 40-character mixed-case alphanumeric string', () => {
    expect(kindOf(`the value is ${generated(40, 42)} — keep it safe`)).toBe('random_string');
    expect(kindOf('A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0')).toBe('random_string');
    expect(kindOf('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij0123')).toBe('random_string');
  });

  it('finds nearly every generated key of 32 to 64 characters', () => {
    for (const length of [32, 40, 48, 64]) {
      let found = 0;
      const samples = 400;
      for (let seed = 1; seed <= samples; seed += 1) {
        const value = generated(length, seed * 2654435761);
        const mixed = /[A-Z]/.test(value) && /[a-z]/.test(value) && /\d/.test(value);
        if (!mixed || kindOf(value) === 'random_string') found += 1;
      }
      expect(found / samples, `length ${length}`).toBeGreaterThan(0.97);
    }
  });

  it.each([
    'handleUserAuthenticationCallbackV2ForOAuthProviders',
    'testOAuth2LoginFlowWithPKCEAndRefreshTokenRotation',
    'MemoryServiceIntegrationTestForProjectAlpha2026V3',
    'QuarterlyRevenueReportQ3FiscalYear2026DraftV12Final',
    'ThisIsAVeryLongCamelCaseIdentifierNumber12345WithDigits',
    'SELECT_Column1_FROM_Table2_WHERE_Id3_Equals4_AND5',
    'Cloud-Harness-Release-Notes-2026-10-13-Final-Draft',
    'cloud_harness_release_notes_2026_10_13_final_draft',
    'a-very-long-kebab-case-file-name-without-capitals-2026',
    'integrity sha512-Xk9mP2vL8nQ4wR7tY1uI5oA3sD6fG0hJ2kZ4xC8bN7mV1cX5zL9kJ3hG6fD2sA4q',
    'THISISALLUPPERCASEWITHDIGITS1234567890ANDNOTHINGELSE',
    'thisisalllowercasewithdigits1234567890andnothingelse',
  ])('lets %j through', (text) => {
    expect(kindOf(text)).toBeNull();
  });

  it('tells generated strings from identifiers by their texture', () => {
    expect(looksGenerated(generated(40, 99))).toBe(true);
    expect(looksGenerated('handleUserAuthenticationCallbackV2ForOAuthProviders')).toBe(false);
    expect(looksGenerated('short1A')).toBe(false);
  });
});

describe('what the detector gives away', () => {
  it('names a kind and never the value', () => {
    const secret = `Xy7!${generated(12, 8)}`;
    const finding = findCredential(`password = ${secret}`);
    expect(finding).toEqual({ kind: 'password' });
    expect(JSON.stringify(finding)).not.toContain(secret);
    expect(describeCredentialKind(finding!.kind)).toBe('a password');
    expect(describeCredentialKind('private_key')).toBe('a private key');
  });

  it('looks at the title, the tags and the keywords of a note too', () => {
    const clean = { title: 'Deploy rules', body: 'Releases go out on Tuesdays.', tags: ['ops'], keywords: ['部署'] };
    expect(findCredentialInNote(clean)).toBeNull();
    expect(findCredentialInNote({ ...clean, title: 'password = Xy7!abcd' })).toEqual({ kind: 'password' });
    expect(findCredentialInNote({ ...clean, tags: ['ghp_abcdefghijklmnopqrstuvwxyz0123456789'] })).toEqual({ kind: 'access_token' });
    expect(findCredentialInNote({ ...clean, keywords: ['AKIAIOSFODNN7EXAMPLE'] })).toEqual({ kind: 'cloud_key' });
    expect(findCredentialInNote({ ...clean, body: 'see below\n\n-----BEGIN PRIVATE KEY-----' })).toEqual({ kind: 'private_key' });
  });

  it('handles empty and very large text in bounded time', () => {
    expect(findCredential('')).toBeNull();
    const started = performance.now();
    const filler = 'The token is stored in the vault; password policy: strong. max_tokens: 4096. '.repeat(14_000); // about 1 MB
    expect(findCredential(filler)).toBeNull();
    expect(findCredential('a'.repeat(1_000_000))).toBeNull();
    expect(findCredential(`${'-----BEGIN '.repeat(90_000)}`)).toBeNull();
    expect(findCredential(`${'password '.repeat(100_000)}= Xy7!abcd`)).toEqual({ kind: 'password' });
    expect(findCredential(`${filler}\npassword = Xy7!abcd`)).toEqual({ kind: 'password' });
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});
