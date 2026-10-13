import { CircleCheck, WifiOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { type ConnectionState, useConnectionState } from '@/data/connection';
import { useT } from '@/i18n';
import { Spinner } from '@/ui';

/**
 * The one global sign that the app has lost touch with the server, and that
 * it is back. While it shows, what is on screen may be out of date; surfaces
 * that show figures label them themselves (see `useStaleness`).
 */
export function ConnectionCue() {
  const t = useT();
  const connection = useConnectionState();
  const [shown, setShown] = useState<ConnectionState | 'restored' | null>(null);
  const [closing, setClosing] = useState(false);

  if (connection !== 'online' && shown !== connection) {
    setShown(connection);
    setClosing(false);
  } else if (connection === 'online' && shown !== null && shown !== 'restored') {
    setShown('restored');
  }

  useEffect(() => {
    if (shown !== 'restored') return;
    const leave = window.setTimeout(() => setClosing(true), 1_600);
    const remove = window.setTimeout(() => {
      setShown(null);
      setClosing(false);
    }, 1_900);
    return () => {
      window.clearTimeout(leave);
      window.clearTimeout(remove);
    };
  }, [shown]);

  if (shown === null) return null;
  return (
    <div className="cue" role="status" data-tone={shown === 'restored' ? 'ok' : 'warn'} data-state={closing ? 'closing' : 'open'}>
      {shown === 'offline' ? <WifiOff size={16} aria-hidden="true" /> : shown === 'restored' ? <CircleCheck size={16} aria-hidden="true" /> : <Spinner size={16} />}
      <span>{shown === 'offline' ? t('shell.cue.offline') : shown === 'restored' ? t('shell.cue.restored') : t('shell.cue.reconnecting')}</span>
    </div>
  );
}
