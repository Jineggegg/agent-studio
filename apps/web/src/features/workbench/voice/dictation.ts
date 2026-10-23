import {
  VOICE_LIMITS,
  voiceCapabilitiesSchema,
  voiceTranscriptSchema,
} from '@agent-studio/protocol';
import { api } from '@/data/api';

interface SpeechResult {
  isFinal: boolean;
  0: { transcript: string };
}
export interface BrowserRecognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { resultIndex: number; results: ArrayLike<SpeechResult> }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type SpeechWindow = Window & {
  SpeechRecognition?: new () => BrowserRecognition;
  webkitSpeechRecognition?: new () => BrowserRecognition;
};
export function speechConstructor(): (new () => BrowserRecognition) | undefined {
  const browser = window as SpeechWindow;
  return browser.SpeechRecognition ?? browser.webkitSpeechRecognition;
}
export async function voiceMode(signal: AbortSignal): Promise<'server' | 'browser'> {
  const result = await api.get('/api/voice/capabilities', {
    schema: voiceCapabilitiesSchema,
    signal,
  });
  return result.server ? 'server' : 'browser';
}

export function encodeAudio(blob: Blob, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const abort = () => {
      reader.abort();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
    const cleanup = () => signal.removeEventListener('abort', abort);
    reader.onload = () => {
      cleanup();
      resolve(String(reader.result).split(',')[1] ?? '');
    };
    reader.onerror = () => {
      cleanup();
      reject(new Error('audio_read_failed'));
    };
    reader.onabort = cleanup;
    if (signal.aborted) {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    reader.readAsDataURL(blob);
  });
}

export async function transcribeAudio(blob: Blob, signal: AbortSignal): Promise<string> {
  if (!blob.size || blob.size > VOICE_LIMITS.audioBytes) throw new Error('audio_size');
  const audio = await encodeAudio(blob, signal);
  const mediaType = blob.type.split(';')[0];
  const result = await api.post(
    '/api/voice/transcribe',
    { audio, mediaType },
    { schema: voiceTranscriptSchema, signal, timeoutMs: 70_000 },
  );
  return result.text;
}
