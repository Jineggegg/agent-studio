import { VOICE_LIMITS } from '@agent-studio/protocol';
import { Mic, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useT } from '@/i18n';
import { getDraft, setDraft, type DraftKey } from '../composer/drafts';
import {
  speechConstructor,
  transcribeAudio,
  voiceMode,
  type BrowserRecognition,
} from './dictation';
import '../media/media.css';

/** The generation token invalidates every async callback when its conversation is left. */
export function Dictation({
  draftKey,
  disabled = false,
}: {
  draftKey: DraftKey;
  disabled?: boolean;
}) {
  const t = useT();
  const [state, setState] = useState<
    'idle' | 'checking' | 'consent' | 'recording' | 'transcribing'
  >('idle');
  const [mode, setMode] = useState<'browser' | 'server'>('browser');
  const [error, setError] = useState('');
  const epoch = useRef(0);
  const control = useRef<AbortController | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const recognition = useRef<BrowserRecognition | null>(null);
  const timer = useRef<number | null>(null);
  const browserText = useRef('');
  const finishing = useRef(false);
  const lock = useRef(false);
  const starting = useRef(false);
  const stillCurrent = (value: number) => epoch.current === value;

  function cleanup() {
    epoch.current += 1;
    control.current?.abort();
    control.current = null;
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    if (recorder.current) {
      recorder.current.ondataavailable = null;
      recorder.current.onstop = null;
      recorder.current.onerror = null;
      if (recorder.current.state !== 'inactive') recorder.current.stop();
      recorder.current = null;
    }
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    if (recognition.current) {
      recognition.current.onend = null;
      recognition.current.onresult = null;
      recognition.current.onerror = null;
      recognition.current.abort();
      recognition.current = null;
    }
    browserText.current = '';
    finishing.current = false;
    lock.current = false;
    starting.current = false;
  }
  useEffect(() => {
    setState('idle');
    setError('');
    return cleanup;
  }, [draftKey]);
  function cancel() {
    cleanup();
    setState('idle');
  }
  function append(value: string, generation: number) {
    if (!stillCurrent(generation)) return;
    const text = value.trim();
    if (text) {
      const current = getDraft(draftKey);
      setDraft(draftKey, `${current}${current && !/\s$/.test(current) ? ' ' : ''}${text}`);
    }
  }
  async function prepare() {
    if (lock.current || disabled) return;
    lock.current = true;
    setError('');
    setState('checking');
    const generation = epoch.current;
    const abort = new AbortController();
    control.current = abort;
    try {
      const next = await voiceMode(abort.signal);
      if (!stillCurrent(generation)) return;
      if (
        (next === 'browser' && !speechConstructor()) ||
        (next === 'server' &&
          (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined'))
      ) {
        setError(t('voice.unavailable'));
        setState('idle');
        lock.current = false;
        return;
      }
      setMode(next);
      setState('consent');
    } catch {
      if (stillCurrent(generation)) {
        setError(t('voice.failed'));
        setState('idle');
        lock.current = false;
      }
    }
  }
  function finish() {
    if (finishing.current) return;
    finishing.current = true;
    if (recorder.current?.state === 'recording') {
      recorder.current.stop();
      stream.current?.getTracks().forEach((track) => track.stop());
      setState('transcribing');
    } else recognition.current?.stop();
  }
  async function start() {
    if (starting.current) return;
    starting.current = true;
    const generation = epoch.current;
    const abort = control.current ?? new AbortController();
    control.current = abort;
    const fail = () => {
      if (stillCurrent(generation)) {
        cleanup();
        setState('idle');
        setError(t('voice.failed'));
      }
    };
    try {
      setState('checking');
      if (mode === 'browser') {
        const Constructor = speechConstructor();
        if (!Constructor) throw new Error('unavailable');
        const speech = new Constructor();
        recognition.current = speech;
        speech.lang = t.language;
        speech.continuous = true;
        speech.interimResults = false;
        speech.onresult = (event) => {
          if (!stillCurrent(generation)) return;
          for (let index = event.resultIndex; index < event.results.length; index += 1) {
            const result = event.results[index];
            if (result?.isFinal) browserText.current += `${result[0].transcript} `;
          }
        };
        speech.onerror = fail;
        speech.onend = () => {
          if (!stillCurrent(generation)) return;
          append(browserText.current, generation);
          cleanup();
          setState('idle');
        };
        speech.start();
      } else {
        const microphone = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (!stillCurrent(generation)) {
          microphone.getTracks().forEach((track) => track.stop());
          return;
        }
        stream.current = microphone;
        const type = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find((mime) =>
          MediaRecorder.isTypeSupported(mime),
        );
        if (!type) throw new Error('unsupported_audio');
        const record = new MediaRecorder(microphone, {
          mimeType: type,
          audioBitsPerSecond: 64_000,
        });
        recorder.current = record;
        const chunks: Blob[] = [];
        let bytes = 0;
        record.ondataavailable = (event) => {
          if (!stillCurrent(generation)) return;
          bytes += event.data.size;
          if (bytes > VOICE_LIMITS.audioBytes) {
            fail();
            return;
          }
          chunks.push(event.data);
        };
        record.onerror = fail;
        record.onstop = () => {
          if (!stillCurrent(generation)) return;
          microphone.getTracks().forEach((track) => track.stop());
          setState('transcribing');
          void transcribeAudio(new Blob(chunks, { type }), abort.signal).then((text) => {
            if (stillCurrent(generation)) {
              append(text, generation);
              cleanup();
              setState('idle');
            }
          }, fail);
        };
        record.start(1000);
      }
      if (!stillCurrent(generation)) return;
      setState('recording');
      timer.current = window.setTimeout(finish, VOICE_LIMITS.recordingMs);
    } catch {
      fail();
    }
  }

  const active = state === 'recording';
  return (
    <>
      <button
        type="button"
        className="wb-bar-button"
        aria-label={t(active ? 'voice.stop' : 'voice.start')}
        title={t(active ? 'voice.stop' : 'voice.start')}
        aria-pressed={active}
        disabled={disabled || (state !== 'idle' && !active)}
        onClick={() => (active ? finish() : void prepare())}
      >
        {active ? <Square size={18} /> : <Mic size={20} />}
      </button>
      {state !== 'idle' || error ? (
        <div className="wb-voice" role="status">
          {error ||
            (state === 'checking'
              ? t('common.loading')
              : state === 'consent'
                ? t(mode === 'server' ? 'voice.serverNotice' : 'voice.browserNotice')
                : state === 'recording'
                  ? t('voice.recording')
                  : t('voice.transcribing'))}
          <div className="wb-voice__actions">
            {state === 'consent' && (
              <button type="button" onClick={() => void start()}>
                {t('voice.confirm')}
              </button>
            )}
            {state === 'recording' && (
              <button type="button" onClick={finish}>
                {t('voice.stop')}
              </button>
            )}
            {state !== 'idle' && (
              <button type="button" onClick={cancel}>
                {t('voice.cancel')}
              </button>
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}
