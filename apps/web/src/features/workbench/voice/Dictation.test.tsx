import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dictation } from './Dictation';
import type { BrowserRecognition } from './dictation';
const fake = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  drafts: {} as Record<string, string>,
}));
vi.mock('@/data/api', () => ({ api: { get: fake.get, post: fake.post } }));
vi.mock('../composer/drafts', () => ({
  getDraft: (key: string) => fake.drafts[key] ?? '',
  setDraft: (key: string, text: string) => {
    fake.drafts[key] = text;
  },
}));
let speech: FakeSpeech;
class FakeSpeech implements BrowserRecognition {
  lang = '';
  continuous = false;
  interimResults = false;
  onresult: BrowserRecognition['onresult'] = null;
  onerror: BrowserRecognition['onerror'] = null;
  onend: BrowserRecognition['onend'] = null;
  constructor() {
    // Capture the fake instance to deliver synthetic recognition events in tests.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    speech = this;
  }
  start = vi.fn();
  stop = vi.fn(() => this.onend?.());
  abort = vi.fn();
}
beforeEach(() => {
  fake.get.mockResolvedValue({ server: false, maxAudioBytes: 5000, maxRecordingMs: 60000 });
  fake.drafts = {};
  Object.assign(window, { SpeechRecognition: FakeSpeech });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, 'SpeechRecognition');
});
async function start() {
  fireEvent.click(screen.getByRole('button', { name: 'Dictate into draft' }));
  await screen.findByRole('button', { name: 'Start microphone' });
  fireEvent.click(screen.getByRole('button', { name: 'Start microphone' }));
}

describe('dictation draft ownership', () => {
  it('appends final speech to the current text, including edits made while listening', async () => {
    render(<Dictation draftKey="session:a" />);
    await start();
    fake.drafts['session:a'] = 'Typed while listening';
    act(() =>
      speech.onresult?.({
        resultIndex: 0,
        results: [{ isFinal: true, 0: { transcript: 'spoken words' } }],
      }),
    );
    fireEvent.click(screen.getAllByRole('button', { name: 'Finish dictation' })[0]!);
    expect(fake.drafts['session:a']).toBe('Typed while listening spoken words');
    expect(fake.post).not.toHaveBeenCalled();
  });
  it('aborts on conversation change and ignores late recognition callbacks', async () => {
    const rendered = render(<Dictation draftKey="session:a" />);
    await start();
    const result = speech.onresult;
    const end = speech.onend;
    rendered.rerender(<Dictation draftKey="session:b" />);
    act(() => {
      result?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'late text' } }] });
      end?.();
    });
    expect(speech.abort).toHaveBeenCalled();
    expect(fake.drafts).toEqual({});
  });
  it('stops a microphone granted after its conversation has been left', async () => {
    fake.get.mockResolvedValue({ server: true, maxAudioBytes: 5000, maxRecordingMs: 60000 });
    let grant!: (stream: MediaStream) => void;
    const stop = vi.fn();
    vi.stubGlobal('MediaRecorder', class {});
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn(
          () =>
            new Promise<MediaStream>((resolve) => {
              grant = resolve;
            }),
        ),
      },
    });
    const rendered = render(<Dictation draftKey="session:a" />);
    await start();
    rendered.rerender(<Dictation draftKey="session:b" />);
    await act(async () => {
      grant({ getTracks: () => [{ stop }] } as unknown as MediaStream);
    });
    await waitFor(() => expect(stop).toHaveBeenCalled());
    expect(fake.post).not.toHaveBeenCalled();
  });
});
