import { ArrowRight, Sparkles, X } from 'lucide-react';
import { useMemo } from 'react';
import { useNavigate } from 'react-router';
import { setPreference, usePreference, usePreferences } from '@/data/preferences';
import { useUser } from '@/data/session';
import { useT } from '@/i18n';
import { Button, IconButton } from '@/ui';
import { WELCOME_KEY, dismissProgress, parseProgress, shouldOffer, stepsDone } from './progress';
import './onboarding.css';

/**
 * The launcher's offer of the welcome guide, for an account that is new (or
 * that started the guide and has not finished): a calm card, never a screen
 * that takes over. "Not now" puts the guide away for good; it stays in
 * Settings → Getting started.
 */
export function WelcomeCard({ className }: { className?: string }) {
  const t = useT();
  const navigate = useNavigate();
  const user = useUser();
  const loaded = usePreferences((state) => state.loaded);
  // The stored value itself is what is selected (a stable reference); it is parsed once per change.
  const raw = usePreference(WELCOME_KEY, (value) => value);
  const progress = useMemo(() => parseProgress(raw), [raw]);
  if (!user || !shouldOffer(progress, { loaded, createdAt: user.createdAt, now: Date.now() })) return null;
  const { done, total } = stepsDone(progress, user.role);
  return (
    <div className={className}>
      <section className="ob-card" aria-labelledby="ob-card-title">
        <span className="ob-card__glyph" aria-hidden="true">
          <Sparkles size={20} />
        </span>
        <div className="ob-card__text">
          <h2 id="ob-card-title" className="ob-card__title">
            {done === 0 ? t('onboarding.card.title') : t('onboarding.card.titleContinue')}
          </h2>
          <p className="ob-card__line">
            {done === 0 ? (user.role === 'owner' ? t('onboarding.card.owner') : t('onboarding.card.member')) : t('onboarding.card.progress', { done: t.number(done), total: t.number(total) })}
          </p>
        </div>
        <div className="ob-card__actions">
          <Button size="sm" variant="primary" icon={<ArrowRight size={16} />} onClick={() => void navigate('/welcome')}>
            {done === 0 ? t('onboarding.card.start') : t('onboarding.card.continue')}
          </Button>
          <IconButton label={t('onboarding.card.dismiss')} icon={<X size={18} />} tone="secondary" onClick={() => setPreference(WELCOME_KEY, dismissProgress(progress, Date.now()))} />
        </div>
      </section>
    </div>
  );
}
