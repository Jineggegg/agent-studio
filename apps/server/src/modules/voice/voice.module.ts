import { randomBytes } from 'node:crypto';
import {
  VOICE_LIMITS,
  transcribeVoiceSchema,
  updateVoiceSettingsSchema,
  voiceTranscriptSchema,
  type UpdateVoiceSettings,
} from '@agent-studio/protocol';
import { isLoopbackHostname } from '../../kernel/config.js';
import { badRequest, payloadTooLarge, rateLimited, unavailable } from '../../kernel/errors.js';
import type { StudioModule } from '../../kernel/module.js';
import { checkUrl, guardedRequest, readBody, type NetPolicy } from '../../kernel/net.js';

const SECRET = 'voice.transcription.key';
const DEFAULTS = { enabled: false, endpoint: '', model: 'whisper-1', allowPrivateNetwork: false };

export function transcriptionPolicy(
  settings: Pick<UpdateVoiceSettings, 'endpoint' | 'allowPrivateNetwork'>,
): NetPolicy {
  let url: URL;
  try {
    url = new URL(settings.endpoint);
  } catch {
    throw badRequest('Invalid transcription URL.', undefined, 'invalid_url');
  }
  if (url.search || url.hash)
    throw badRequest('Transcription URLs cannot contain query strings or fragments.');
  const policy = {
    allowPrivateNetwork: settings.allowPrivateNetwork,
    allowHttp: settings.allowPrivateNetwork && isLoopbackHostname(url.hostname),
  };
  checkUrl(settings.endpoint, policy);
  return policy;
}

/** No recording or transcript is persisted. The transport is injected only for fake-network tests. */
export function createVoiceModule(request: typeof guardedRequest = guardedRequest): StudioModule {
  return {
    name: 'voice',
    migrations: [
      {
        version: 1,
        name: 'voice configuration',
        sql: 'CREATE TABLE voice_settings (id INTEGER PRIMARY KEY CHECK (id = 1), settings TEXT NOT NULL);',
      },
    ],
    setup(context) {
      const read = (): typeof DEFAULTS => {
        const row = context.db.get<{ settings: string }>(
          'SELECT settings FROM voice_settings WHERE id = 1',
        );
        return row ? (JSON.parse(row.settings) as typeof DEFAULTS) : DEFAULTS;
      };
      const describe = () => ({
        ...read(),
        keyConfigured: context.secrets.describe(SECRET) !== null,
      });
      const active = new Set<string>();
      context.http.route({
        method: 'GET',
        url: '/api/voice/capabilities',
        access: 'user',
        handler: () => ({
          server: read().enabled,
          maxAudioBytes: VOICE_LIMITS.audioBytes,
          maxRecordingMs: VOICE_LIMITS.recordingMs,
        }),
      });
      context.http.route({
        method: 'GET',
        url: '/api/voice/settings',
        access: 'owner',
        handler: describe,
      });
      context.http.route({
        method: 'PUT',
        url: '/api/voice/settings',
        access: 'owner',
        sessionOnly: true,
        recentAuth: true,
        body: updateVoiceSettingsSchema,
        handler: ({ body, user }) => {
          if (body.enabled || body.endpoint) transcriptionPolicy(body);
          const { apiKey, removeKey, ...settings } = body;
          const previous = read();
          const changedOrigin =
            previous.endpoint !== '' &&
            (!settings.endpoint ||
              new URL(previous.endpoint).origin !== new URL(settings.endpoint).origin);
          context.db.transaction(() => {
            if (removeKey || changedOrigin) context.secrets.delete(SECRET);
            if (apiKey) context.secrets.put(SECRET, apiKey);
            context.db.run(
              'INSERT INTO voice_settings (id, settings) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET settings = excluded.settings',
              JSON.stringify(settings),
            );
          });
          context.services.audit.record({
            category: 'change',
            action: 'voice.settings.updated',
            userId: user.userId,
            subject: 'Voice transcription',
            detail: JSON.stringify({
              enabled: settings.enabled,
              keyChanged: Boolean(apiKey || removeKey),
            }),
          });
          return describe();
        },
      });
      context.http.route({
        method: 'POST',
        url: '/api/voice/transcribe',
        access: 'user',
        sessionOnly: true,
        body: transcribeVoiceSchema,
        bodyLimit: Math.ceil(VOICE_LIMITS.audioBytes / 3) * 4 + 1024,
        rateLimit: { max: 10, windowMs: 60_000 },
        handler: async ({ body, user, reply }) => {
          const settings = read();
          if (!settings.enabled)
            throw unavailable('Server transcription is not configured.', 'voice_unavailable');
          if (active.has(user.userId) || active.size >= 4) throw rateLimited(15);
          const audio = Buffer.from(body.audio, 'base64');
          if (audio.length === 0 || audio.length > VOICE_LIMITS.audioBytes) throw payloadTooLarge();
          active.add(user.userId);
          const abort = new AbortController();
          const disconnect = () => {
            if (!reply.raw.writableEnded) abort.abort();
          };
          reply.raw.on('close', disconnect);
          const timeout = setTimeout(() => abort.abort(), 65_000);
          try {
            const boundary = `voice-${randomBytes(20).toString('hex')}`;
            const extension = {
              'audio/webm': 'webm',
              'audio/ogg': 'ogg',
              'audio/wav': 'wav',
              'audio/mp4': 'mp4',
              'audio/mpeg': 'mp3',
            }[body.mediaType];
            const payload = Buffer.concat([
              Buffer.from(
                `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${settings.model}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="dictation.${extension}"\r\nContent-Type: ${body.mediaType}\r\n\r\n`,
              ),
              audio,
              Buffer.from(`\r\n--${boundary}--\r\n`),
            ]);
            const key = context.secrets.reveal(SECRET);
            const response = await request(settings.endpoint, {
              method: 'POST',
              body: payload,
              headers: {
                'content-type': `multipart/form-data; boundary=${boundary}`,
                'content-length': String(payload.length),
                ...(key ? { authorization: `Bearer ${key}` } : {}),
              },
              policy: transcriptionPolicy(settings),
              signal: abort.signal,
              timeoutMs: 60_000,
            });
            if (response.status < 200 || response.status >= 300) {
              response.body.destroy();
              throw unavailable('Transcription service refused the recording.', 'voice_failed');
            }
            const parsed = voiceTranscriptSchema.safeParse(
              JSON.parse((await readBody(response.body, 128 * 1024)).toString('utf8')) as unknown,
            );
            if (!parsed.success)
              throw unavailable(
                'Transcription service returned an invalid answer.',
                'voice_failed',
              );
            return parsed.data;
          } catch {
            // No upstream response, URL, credential or recording is returned or logged.
            throw unavailable('Could not transcribe this recording.', 'voice_failed');
          } finally {
            clearTimeout(timeout);
            reply.raw.off('close', disconnect);
            active.delete(user.userId);
          }
        },
      });
    },
  };
}
export const voiceModule = createVoiceModule();
