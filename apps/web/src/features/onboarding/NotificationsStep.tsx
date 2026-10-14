import { PushStatus } from '@/features/notifications/PushStatus';
import { usePushSetup } from '@/features/notifications/state';
import { useT } from '@/i18n';
import { Button } from '@/ui';

/**
 * Notifications on this device: the notification settings' own status card,
 * with its one fixing action (ask the browser, register this device, turn
 * push on). Done once this device gets them; skippable like every step.
 */
export default function NotificationsStep({ onDone }: { onDone: () => void }) {
  const t = useT();
  const setup = usePushSetup();
  const on = setup.state.kind === 'on';
  return (
    <div className="ob-form">
      <PushStatus setup={setup} variant="card" origin="settings" />
      <Button variant={on ? 'primary' : 'neutral'} block onClick={onDone}>
        {on ? t('onboarding.next') : t('onboarding.notifications.later')}
      </Button>
    </div>
  );
}
