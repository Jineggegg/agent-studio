import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { modules } from '../../src/modules/index.js';
import { createVoiceModule } from '../../src/modules/voice/voice.module.js';
import type { guardedRequest } from '../../src/kernel/net.js';
import { createTestStudio, type TestClient, type TestStudio } from '../../src/testing/harness.js';

const request = vi.fn<typeof guardedRequest>();
let studio: TestStudio;
let owner: TestClient;
let member: TestClient;
const config = {
  enabled: true,
  endpoint: 'https://speech.example/v1/audio/transcriptions',
  model: 'whisper-1',
  allowPrivateNetwork: false,
  apiKey: 'fake-test-voice-key-never-real',
};
beforeAll(async () => {
  studio = await createTestStudio({
    modules: modules.map((module) =>
      module.name === 'voice' ? createVoiceModule(request) : module,
    ),
  });
  owner = await studio.owner();
  member = await studio.member();
});
afterAll(async () => {
  await studio.close();
});

describe('voice transcription boundary', () => {
  it('requires sign-in and restricts configuration to a recently authenticated owner', async () => {
    expect((await studio.anonymous().get('/api/voice/capabilities')).status).toBe(401);
    expect(
      (
        await studio
          .anonymous()
          .post('/api/voice/transcribe', { audio: 'AAAA', mediaType: 'audio/webm' })
      ).status,
    ).toBe(401);
    expect((await member.put('/api/voice/settings', config)).status).toBe(403);
    const result = await owner.put('/api/voice/settings', config);
    expect(result.status).toBe(200);
    expect(JSON.stringify(result.body)).not.toContain(config.apiKey);
    const row = studio.studio.context.db.get<{ sealed: string }>(
      'SELECT sealed FROM secrets WHERE name = ?',
      'voice.transcription.key',
    );
    expect(row?.sealed).toBeTruthy();
    expect(row?.sealed).not.toContain(config.apiKey);
  });
  it('rejects insecure or metadata endpoints before contacting a network', async () => {
    for (const endpoint of [
      'http://example.com/transcribe',
      'http://169.254.169.254/metadata',
      'https://user:pass@example.com',
      'https://example.com?key=secret',
    ])
      expect(
        (await owner.put('/api/voice/settings', { ...config, endpoint, allowPrivateNetwork: true }))
          .status,
      ).toBeGreaterThanOrEqual(400);
    expect(request).not.toHaveBeenCalled();
  });
  it('transcribes with the configured key and returns plain bounded text only', async () => {
    request.mockResolvedValueOnce({
      status: 200,
      headers: {},
      body: Readable.from([JSON.stringify({ text: 'Hello draft' })]),
    });
    const result = await member.post('/api/voice/transcribe', {
      audio: Buffer.from('fake audio bytes').toString('base64'),
      mediaType: 'audio/webm',
    });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ text: 'Hello draft' });
    expect(request).toHaveBeenLastCalledWith(
      config.endpoint,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: `Bearer ${config.apiKey}` }),
        policy: { allowPrivateNetwork: false, allowHttp: false },
      }),
    );
  });
  it('refuses redirects and malformed transcripts without exposing upstream content', async () => {
    request.mockResolvedValueOnce({
      status: 302,
      headers: { location: 'https://attacker.example' },
      body: Readable.from(['secret upstream response']),
    });
    const result = await owner.post('/api/voice/transcribe', {
      audio: 'AAAA',
      mediaType: 'audio/webm',
    });
    expect(result.status).toBe(503);
    expect(JSON.stringify(result.body)).not.toContain('secret');
    expect(
      (await owner.post('/api/voice/transcribe', { audio: 'not base64', mediaType: 'text/plain' }))
        .status,
    ).toBe(400);
  });
  it('clears retained credentials when the endpoint origin changes', async () => {
    expect(
      (
        await owner.put('/api/voice/settings', {
          ...config,
          apiKey: '',
          endpoint: 'https://other.example/transcribe',
        })
      ).status,
    ).toBe(200);
    expect(studio.studio.context.secrets.describe('voice.transcription.key')).toBe(null);
  });
});
