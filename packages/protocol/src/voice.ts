import { z } from 'zod';
export const VOICE_LIMITS = {
  audioBytes: 5 * 1024 * 1024,
  recordingMs: 60_000,
  textChars: 30_000,
} as const;
export const voiceCapabilitiesSchema = z.object({
  server: z.boolean(),
  maxAudioBytes: z.number(),
  maxRecordingMs: z.number(),
});
export const voiceSettingsSchema = z.object({
  enabled: z.boolean(),
  endpoint: z.string().max(2048),
  model: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-zA-Z0-9._/:-]+$/),
  allowPrivateNetwork: z.boolean(),
  keyConfigured: z.boolean(),
});
export const updateVoiceSettingsSchema = voiceSettingsSchema
  .omit({ keyConfigured: true })
  .extend({
    apiKey: z
      .string()
      .max(8192)
      .regex(/^[^\r\n]*$/)
      .optional(),
    removeKey: z.boolean().optional(),
  })
  .strict();
export const transcribeVoiceSchema = z
  .object({
    audio: z
      .string()
      .min(4)
      .max(Math.ceil(VOICE_LIMITS.audioBytes / 3) * 4)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
    mediaType: z.enum(['audio/webm', 'audio/ogg', 'audio/wav', 'audio/mp4', 'audio/mpeg']),
  })
  .strict();
export const voiceTranscriptSchema = z.object({ text: z.string().max(VOICE_LIMITS.textChars) });
export type VoiceSettings = z.infer<typeof voiceSettingsSchema>;
export type UpdateVoiceSettings = z.infer<typeof updateVoiceSettingsSchema>;
