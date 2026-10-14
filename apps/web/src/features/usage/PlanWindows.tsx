import { type AgentQuota, type QuotaResponse, type QuotaWindow, USAGE_EVENT, usageEventSchema, userTopic } from '@agent-studio/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock } from 'lucide-react';
import { useRealtimeTopic } from '@/data/realtime';
import { useUser } from '@/data/session';
import { type Translator, useT } from '@/i18n';
import { Badge } from '@/ui';
import { usageApi, usageKeys } from './api';
import { Meter } from './charts';
import './plan.css';

/**
 * Plan windows: what an agent's own program last said about the limits of
 * the account it is signed in to. The Studio asks no usage endpoint of its
 * own, so there is nothing to refresh by hand — a reading is renewed when the
 * agent next reports during a run, and it says how old it is.
 */
export function useQuota(enabled = true) {
  const user = useUser();
  const queryClient = useQueryClient();
  const quota = useQuery({ queryKey: usageKeys.quota, queryFn: ({ signal }) => usageApi.quota(signal), enabled, staleTime: 60_000, meta: { live: true } });
  useRealtimeTopic(enabled && user ? userTopic(user.id) : null, (event) => {
    if (event.type !== USAGE_EVENT.quotaChanged) return;
    const parsed = usageEventSchema.safeParse({ type: event.type, data: event.data });
    if (!parsed.success || parsed.data.type !== USAGE_EVENT.quotaChanged) return;
    const next = parsed.data.data.quota;
    queryClient.setQueryData<QuotaResponse>(usageKeys.quota, (current) =>
      current ? { ...current, agents: current.agents.some((entry) => entry.agentId === next.agentId) ? current.agents.map((entry) => (entry.agentId === next.agentId ? next : entry)) : [...current.agents, next] } : current,
    );
  });
  return quota;
}

/** "5-hour window", "Weekly window", or the program's own name for it. */
export function windowLabel(window: Pick<QuotaWindow, 'id' | 'label' | 'windowMinutes'>, t: Translator): string {
  const minutes = window.windowMinutes ?? (window.id === 'five_hour' ? 300 : window.id === 'seven_day' ? 10_080 : null);
  if (minutes === 300) return t('usage.window.fiveHour');
  if (minutes === 10_080) return t('usage.window.weekly');
  if (minutes !== null && minutes % 1440 === 0) return t('usage.window.days', { days: t.number(minutes / 1440) });
  if (minutes !== null && minutes % 60 === 0) return t('usage.window.hours', { hours: t.number(minutes / 60) });
  return window.label;
}

/** How old a reading is and whether it can still be trusted, in words. */
export function freshnessText(quota: Pick<AgentQuota, 'state' | 'staleCode' | 'observedAt' | 'agentName'>, t: Translator): string {
  if (quota.state === 'none' || quota.observedAt === null) return t('usage.plan.none', { agent: quota.agentName });
  const when = t.relative(quota.observedAt);
  if (quota.staleCode === 'reset-passed') return t('usage.plan.resetPassed', { when });
  if (quota.state === 'stale') return t('usage.plan.old', { when });
  return t('usage.plan.observed', { when });
}

function resetsText(window: QuotaWindow, t: Translator): string | null {
  if (window.resetsAt === null) return null;
  return window.resetPassed ? t('usage.plan.windowOver') : t('usage.plan.resets', { when: t.relative(window.resetsAt) });
}

function WindowRow({ window, t }: { window: QuotaWindow; t: Translator }) {
  const label = windowLabel(window, t);
  const percent = window.usedFraction === null ? null : Math.round(window.usedFraction * 100);
  const valueText = percent === null ? t('usage.plan.noFigure') : t('usage.plan.used', { percent: t.number(percent) });
  const resets = resetsText(window, t);
  return (
    <li className="use-window" data-stale={window.resetPassed || undefined}>
      <div className="use-window__line">
        <span className="use-window__label">{label}</span>
        <span className="use-window__value">{valueText}</span>
      </div>
      <Meter fraction={window.usedFraction} label={label} valueText={valueText} />
      {resets && <p className="use-window__resets">{resets}</p>}
    </li>
  );
}

const STATUS_TONE = { allowed: 'positive', warning: 'warning', limited: 'danger' } as const;

/** One agent's plan windows, as its program last reported them. */
export function AgentPlanCard({ quota }: { quota: AgentQuota }) {
  const t = useT();
  return (
    <article className="use-plan" data-state={quota.state}>
      <header className="use-plan__head">
        <h3>{quota.agentName}</h3>
        {quota.plan && <Badge tone="neutral">{quota.plan}</Badge>}
        {quota.status && <Badge tone={STATUS_TONE[quota.status]}>{t(`usage.plan.status.${quota.status}`)}</Badge>}
      </header>
      {quota.windows.length > 0 && (
        <ul className="use-plan__windows">
          {quota.windows.map((window) => (
            <WindowRow key={window.id} window={window} t={t} />
          ))}
        </ul>
      )}
      {quota.credits && (
        <p className="use-plan__note">
          {quota.credits.unlimited ? t('usage.plan.creditsUnlimited') : quota.credits.balance !== null ? t('usage.plan.credits', { balance: quota.credits.balance }) : quota.credits.hasCredits ? t('usage.plan.creditsSome') : t('usage.plan.creditsNone')}
        </p>
      )}
      {quota.usingOverage === true && <p className="use-plan__note" data-tone="warning">{t('usage.plan.overage')}</p>}
      <p className="use-plan__fresh" data-stale={quota.state === 'stale' || undefined}>
        <Clock size={13} aria-hidden="true" />
        {freshnessText(quota, t)}
      </p>
      {quota.state !== 'none' && <p className="use-plan__note">{t('usage.plan.updates', { agent: quota.agentName })}</p>}
      {!quota.available && <p className="use-plan__note">{t('usage.plan.unavailable')}</p>}
    </article>
  );
}

/**
 * The plan windows of the agent in a conversation, for the context ring's
 * details. Nothing for an agent that has no plan of its own (an API model).
 */
export function PlanSummary({ agentId }: { agentId: string | null }) {
  const t = useT();
  const quota = useQuota(agentId !== null);
  if (!agentId || !quota.data) return null;
  const entry = quota.data.agents.find((candidate) => candidate.agentId === agentId);
  if (!entry) return null;
  return (
    <section className="use-plan-summary">
      <h3>{t('usage.plan.title')}</h3>
      {entry.windows.length > 0 ? (
        <ul className="use-plan__windows">
          {entry.windows.map((window) => (
            <WindowRow key={window.id} window={window} t={t} />
          ))}
        </ul>
      ) : null}
      <p className="use-plan__fresh" data-stale={entry.state === 'stale' || undefined}>
        <Clock size={13} aria-hidden="true" />
        {freshnessText(entry, t)}
      </p>
      {entry.state !== 'none' && <p className="use-plan__note">{t('usage.plan.updates', { agent: entry.agentName })}</p>}
    </section>
  );
}
