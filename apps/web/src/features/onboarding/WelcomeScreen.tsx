import { type GitIdentityState, gitIdentitySchema } from '@agent-studio/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, Bot, Check, FolderPlus, GitCommitHorizontal, PartyPopper } from 'lucide-react';
import { type ReactNode, lazy, Suspense, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { isApiError } from '@/data/api';
import { describeError } from '@/data/errors';
import { setPreference, usePreference } from '@/data/preferences';
import { useProjects } from '@/data/projects';
import { useUser } from '@/data/session';
import { gitApi, gitKeys } from '@/features/git/api';
import { NewProjectSheet } from '@/features/home/NewProjectSheet';
import { type MessageKey, useT } from '@/i18n';
import { Screen } from '@/shell/Screen';
import { Banner, Button, ErrorState, Form, LoadingRow, TextField, toast } from '@/ui';
import { type StepId, WELCOME_KEY, dismissProgress, finishProgress, markStep, nextStep, parseProgress, stepsFor } from './progress';
import './onboarding.css';

const AgentAccounts = lazy(() => import('@/features/terminal/AgentAccountsPage'));
const NotificationsStep = lazy(() => import('./NotificationsStep'));

const STEP_WORDS: Record<StepId, { title: MessageKey; lead: MessageKey; icon: ReactNode }> = {
  identity: { title: 'onboarding.identity.title', lead: 'onboarding.identity.lead', icon: <GitCommitHorizontal size={20} /> },
  agents: { title: 'onboarding.agents.title', lead: 'onboarding.agents.lead', icon: <Bot size={20} /> },
  project: { title: 'onboarding.project.title', lead: 'onboarding.project.lead', icon: <FolderPlus size={20} /> },
  notifications: { title: 'onboarding.notifications.title', lead: 'onboarding.notifications.lead', icon: <Bell size={20} /> },
};

/** Step 1: the name and e-mail written into commits, prefilled from what Git on the server would use. */
function IdentityStep({ onSaved }: { onSaved: () => void }) {
  const t = useT();
  const queryClient = useQueryClient();
  const identity = useQuery({ queryKey: gitKeys.identity, queryFn: ({ signal }) => gitApi.identity(signal) });
  if (identity.isPending) return <LoadingRow label={t('common.loading')} />;
  if (!identity.data) return <ErrorState compact error={identity.error} onRetry={() => void identity.refetch()} retrying={identity.isFetching} />;
  return (
    <IdentityForm
      state={identity.data}
      onSaved={(saved) => {
        queryClient.setQueryData(gitKeys.identity, saved);
        onSaved();
      }}
    />
  );
}

function IdentityForm({ state, onSaved }: { state: GitIdentityState; onSaved: (saved: GitIdentityState) => void }) {
  const t = useT();
  const [name, setName] = useState(state.name ?? '');
  const [email, setEmail] = useState(state.email ?? '');
  const [errors, setErrors] = useState<{ name?: string; email?: string }>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    const parsed = gitIdentitySchema.safeParse({ name, email });
    if (!parsed.success) {
      const next: { name?: string; email?: string } = {};
      for (const issue of parsed.error.issues) {
        if (issue.path[0] === 'name') next.name = name.trim() === '' ? t('onboarding.identity.nameMissing') : t('onboarding.identity.nameInvalid');
        if (issue.path[0] === 'email') next.email = t('onboarding.identity.emailInvalid');
      }
      setErrors(next);
      return;
    }
    setSaving(true);
    setProblem(null);
    try {
      onSaved(await gitApi.saveIdentity(parsed.data));
      toast.success(t('onboarding.identity.saved'));
    } catch (error) {
      if (!(isApiError(error) && error.code === 'reauth_cancelled')) setProblem(describeError(error, t));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Form className="ob-form" onSubmit={() => void save()}>
      {state.source === 'host' && <p className="ob-note">{t('onboarding.identity.fromHost')}</p>}
      {state.source === 'user' && <p className="ob-note">{t('onboarding.identity.already')}</p>}
      {problem && (
        <Banner tone="danger" role="alert">
          {problem}
        </Banner>
      )}
      <TextField label={t('onboarding.identity.name')} value={name} onChange={(value) => { setName(value); setErrors((current) => ({ ...current, name: undefined })); }} autoComplete="name" error={errors.name} disabled={saving} />
      <TextField label={t('onboarding.identity.email')} type="email" value={email} onChange={(value) => { setEmail(value); setErrors((current) => ({ ...current, email: undefined })); }} autoComplete="email" inputMode="email" autoCapitalize="off" error={errors.email} hint={t('onboarding.identity.emailHint')} disabled={saving} />
      <Button type="submit" variant="primary" loading={saving} block>
        {t('onboarding.identity.save')}
      </Button>
    </Form>
  );
}

/** Step 3: a project to work in — the owner's "New project", or the ones already there. */
function ProjectStep({ onDone }: { onDone: () => void }) {
  const t = useT();
  const projects = useProjects();
  const [creating, setCreating] = useState(false);
  const own = (projects.data ?? []).filter((project) => !project.scratch);
  return (
    <div className="ob-form">
      {projects.isPending ? (
        <LoadingRow label={t('common.loading')} />
      ) : own.length > 0 ? (
        <>
          <p className="ob-note">{t.plural('onboarding.project.have', own.length)}</p>
          <Button variant="primary" block onClick={onDone}>
            {t('onboarding.next')}
          </Button>
        </>
      ) : (
        <Button variant="primary" icon={<FolderPlus size={18} />} block onClick={() => setCreating(true)}>
          {t('onboarding.project.create')}
        </Button>
      )}
      <NewProjectSheet
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(project) => {
          setCreating(false);
          toast.success(t('onboarding.project.created', { name: project.name }));
          onDone();
        }}
      />
    </div>
  );
}

/**
 * The welcome guide: the few things that make the Studio ready to use — who
 * commits, which agents are signed in, a first project, notifications on
 * this device. Every step can be skipped; where the person got to is kept
 * with their account; finished or put away, it is not offered again.
 */
export default function WelcomeScreen() {
  const t = useT();
  const navigate = useNavigate();
  const user = useUser();
  const role = user?.role ?? 'member';
  const raw = usePreference(WELCOME_KEY, (value) => value);
  const progress = useMemo(() => parseProgress(raw), [raw]);
  const steps = stepsFor(role);
  const upcoming = nextStep(progress, role);
  const [shown, setShown] = useState<StepId | null>(null);
  const current: StepId | null = shown ?? upcoming;
  const index = current ? steps.indexOf(current) : steps.length;

  const record = (step: StepId, outcome: 'done' | 'skipped') => {
    const next = markStep(progress, step, outcome, Date.now());
    setPreference(WELCOME_KEY, next);
    setShown(nextStep(next, role));
  };
  const finish = () => {
    setPreference(WELCOME_KEY, finishProgress(progress, Date.now()));
    void navigate('/', { replace: true });
  };
  const putAway = () => {
    setPreference(WELCOME_KEY, dismissProgress(progress, Date.now()));
    toast.show({ title: t('onboarding.putAway') });
    void navigate('/', { replace: true });
  };

  return (
    <Screen title={t('onboarding.title')} caption={t('onboarding.caption')} parent={{ to: '/', label: t('nav.home') }}>
      <ol className="ob-steps" aria-label={t('onboarding.stepsLabel')}>
        {steps.map((step, position) => {
          const outcome = progress?.steps[step];
          return (
            <li key={step} className="ob-steps__item" data-current={step === current || undefined} data-outcome={outcome}>
              <button type="button" className="ob-steps__button" onClick={() => setShown(step)} aria-current={step === current ? 'step' : undefined}>
                <span className="ob-steps__mark" aria-hidden="true">
                  {outcome === 'done' ? <Check size={14} strokeWidth={3} /> : position + 1}
                </span>
                <span className="ob-steps__name">{t(STEP_WORDS[step].title)}</span>
                <span className="visually-hidden">{outcome === 'done' ? t('onboarding.stepDone') : outcome === 'skipped' ? t('onboarding.stepSkipped') : ''}</span>
              </button>
            </li>
          );
        })}
      </ol>

      {current ? (
        <section className="ob-step" aria-labelledby="ob-step-title">
          <header className="ob-step__head">
            <span className="ob-step__icon" aria-hidden="true">
              {STEP_WORDS[current].icon}
            </span>
            <div>
              <p className="ob-step__count">{t('onboarding.stepOf', { index: t.number(index + 1), total: t.number(steps.length) })}</p>
              <h2 id="ob-step-title" className="ob-step__title">
                {t(STEP_WORDS[current].title)}
              </h2>
            </div>
          </header>
          <p className="ob-step__lead">{t(STEP_WORDS[current].lead)}</p>
          <div className="ob-step__body">
            <Suspense fallback={<LoadingRow label={t('common.loading')} />}>
              {current === 'identity' && <IdentityStep onSaved={() => record('identity', 'done')} />}
              {current === 'agents' && (
                <div className="ob-agents">
                  <AgentAccounts />
                  <Button variant="primary" block onClick={() => record('agents', 'done')}>
                    {t('onboarding.next')}
                  </Button>
                </div>
              )}
              {current === 'project' && <ProjectStep onDone={() => record('project', 'done')} />}
              {current === 'notifications' && <NotificationsStep onDone={() => record('notifications', 'done')} />}
            </Suspense>
          </div>
          <div className="ob-step__footer">
            <Button variant="plain" onClick={() => record(current, 'skipped')}>
              {t('onboarding.skip')}
            </Button>
            <Button variant="plain" onClick={putAway}>
              {t('onboarding.notAgain')}
            </Button>
          </div>
        </section>
      ) : (
        <section className="ob-step ob-step--done" aria-labelledby="ob-done-title">
          <span className="ob-step__icon" aria-hidden="true">
            <PartyPopper size={22} />
          </span>
          <h2 id="ob-done-title" className="ob-step__title">
            {t('onboarding.done.title')}
          </h2>
          <p className="ob-step__lead">{steps.some((step) => progress?.steps[step] === 'skipped') ? t('onboarding.done.someSkipped') : t('onboarding.done.text')}</p>
          <Button variant="primary" block onClick={finish}>
            {t('onboarding.done.home')}
          </Button>
        </section>
      )}
    </Screen>
  );
}
