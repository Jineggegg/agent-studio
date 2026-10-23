import { Square, Volume2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useT } from '@/i18n';
import './media.css';

/** Speech is opt-in, plain text only; links and markup never become instructions. */
export function speechText(markdown: string): string {
  return markdown
    .replace(/```[^\n]*\n([\s\S]*?)```/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/^[ \t]*[#>]+[ \t]*/gm, '')
    .replace(/[*_`~]/g, '')
    .trim();
}

export function ReadAloud({ text }: { text: string }) {
  const t = useT();
  const [speaking, setSpeaking] = useState(false);
  const [failed, setFailed] = useState(false);
  const current = useRef<SpeechSynthesisUtterance | null>(null);
  useEffect(
    () => () => {
      if (current.current) {
        current.current.onend = null;
        current.current.onerror = null;
        window.speechSynthesis?.cancel();
        current.current = null;
      }
    },
    [text],
  );
  if (
    typeof window.speechSynthesis === 'undefined' ||
    typeof SpeechSynthesisUtterance === 'undefined'
  )
    return null;
  const toggle = () => {
    if (speaking) {
      window.speechSynthesis.cancel();
      current.current = null;
      setSpeaking(false);
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(speechText(text));
    current.current = utterance;
    utterance.onend = () => {
      setSpeaking(false);
      current.current = null;
    };
    utterance.onerror = () => {
      setSpeaking(false);
      setFailed(true);
      current.current = null;
    };
    setFailed(false);
    setSpeaking(true);
    window.speechSynthesis.speak(utterance);
  };
  return (
    <>
      <button
        type="button"
        className="wb-read-aloud"
        aria-label={t(speaking ? 'media.stopRead' : 'media.read')}
        title={t(speaking ? 'media.stopRead' : 'media.read')}
        aria-pressed={speaking}
        onClick={toggle}
      >
        {speaking ? <Square size={16} /> : <Volume2 size={18} />}
      </button>
      {failed && <span role="status">{t('media.speechFailed')}</span>}
    </>
  );
}
