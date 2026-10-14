import { ArrowRight, Check, Circle, Minus } from 'lucide-react';
import { useMemo } from 'react';
import { useNavigate } from 'react-router';
import { setPreference, usePreference } from '@/data/preferences';
import { useUser } from '@/data/session';
import { type MessageKey, useT } from '@/i18n';
import { Button, List, ListRow } from '@/ui';
import { type StepId, WELCOME_KEY, freshProgress, parseProgress, stepsFor } from './progress';
import './onboarding.css';

const NAMES: Record<StepId, MessageKey> = {
  identity: 'onboarding.identity.title',
  agents: 'onboarding.agents.title',
  project: 'onboarding.project.title',
  notifications: 'onboarding.notifications.title',
};

/** Settings → Getting started: where each step of the welcome guide stands, and the way back into it. */
export default function GettingStartedPage() {
  const t = useT();
  const navigate = useNavigate();
  const user = useUser();
  const raw = usePreference(WELCOME_KEY, (value) => value);
  const progress = useMemo(() => parseProgress(raw), [raw]);
  const steps = stepsFor(user?.role ?? 'member');
  return (
    <>
      <List footer={progress?.state === 'finished' ? t('onboarding.settings.finished') : progress?.state === 'dismissed' ? t('onboarding.settings.dismissed') : t('onboarding.settings.open')}>
        {steps.map((step) => {
          const outcome = progress?.steps[step];
          return (
            <ListRow
              key={step}
              leading={outcome === 'done' ? <Check size={20} /> : outcome === 'skipped' ? <Minus size={20} /> : <Circle size={20} />}
              title={t(NAMES[step])}
              value={outcome === 'done' ? t('onboarding.stepDone') : outcome === 'skipped' ? t('onboarding.stepSkipped') : t('onboarding.stepOpen')}
            />
          );
        })}
      </List>
      <div className="ob-settings-actions">
        <Button
          variant="tinted"
          icon={<ArrowRight size={18} />}
          onClick={() => {
            // Opened again on purpose: offered again until finished, from the first step not yet done.
            if (progress?.state !== 'open') setPreference(WELCOME_KEY, { ...(progress ?? freshProgress(Date.now())), state: 'open', updatedAt: Date.now() });
            void navigate('/welcome');
          }}
        >
          {t('onboarding.settings.openGuide')}
        </Button>
      </div>
    </>
  );
}
