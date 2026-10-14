import { type PluginContributions, type UsageSummary, usageSummarySchema } from '@agent-studio/protocol';
import { useQuery } from '@tanstack/react-query';
import { Activity, ArrowUpRight, Gauge, Inbox, Link } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { api } from '@/data/api';
import { useStaleness } from '@/data/connection';
import { useRunningWork } from '@/features/collab/running/status';
import { inboxApi, inboxKeys } from '@/features/inbox/api';
import { useInboxLiveUpdates } from '@/features/inbox/status';
import { AgentMark } from '@/features/workbench/chat/parts';
import { type MessageKey, type Translator, useT } from '@/i18n';
import { useScreenActive } from '@/shell/ScreenStack';
import { ActivityMark, Skeleton } from '@/ui';
import { pluginIcon } from '@/features/plugins/icons';
import { safeLinkUrl } from '../catalogue';
import type { WidgetEntry, WidgetSize, WidgetType } from '../layout';

/** What the gallery says about each kind of widget, and where a tap on one leads. */
export interface WidgetKind {
  type: WidgetType;
  title: MessageKey;
  description: MessageKey;
  icon: LucideIcon;
  tint: 'teal' | 'red' | 'green' | 'purple';
  /** The app a tap opens; null when the widget's own parts are what is tapped. */
  to: string | null;
}

export const WIDGET_KINDS: Record<WidgetType, WidgetKind> = {
  usage: { type: 'usage', title: 'home.widget.usage', description: 'home.widget.usageText', icon: Gauge, tint: 'teal', to: '/usage' },
  inbox: { type: 'inbox', title: 'home.widget.inbox', description: 'home.widget.inboxText', icon: Inbox, tint: 'red', to: '/inbox' },
  running: { type: 'running', title: 'home.widget.running', description: 'home.widget.runningText', icon: Activity, tint: 'green', to: '/running' },
  'plugin-links': { type: 'plugin-links', title: 'home.widget.links', description: 'home.widget.linksText', icon: Link, tint: 'purple', to: null },
};

export interface WidgetBodyProps {
  widget: WidgetEntry;
  editing: boolean;
  contributions: PluginContributions | undefined;
}

/** The figure a reading shows, and a word on how fresh it is. */
export interface Reading {
  body: ReactNode;
  /** "may be out of date", the age, or nothing. */
  badge: string | null;
}

function Placeholder({ size }: { size: WidgetSize }) {
  const lines = size === 'large' ? 5 : size === 'medium' ? 3 : 2;
  return (
    <div className="hw-placeholder" aria-hidden="true">
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton key={index} width={`${80 - index * 12}%`} height={10} />
      ))}
    </div>
  );
}

function staleBadge(stale: boolean, since: number | undefined, t: Translator): string | null {
  if (!stale) return null;
  return since ? t('home.widget.staleSince', { when: t.relative(since) }) : t('home.widget.stale');
}

// ---- usage per agent ----------------------------------------------------------------

const timeZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

function usageLine(agent: UsageSummary['agents'][number], t: Translator): string {
  if (agent.fraction !== null) {
    const percent = t.number(Math.min(agent.fraction, 9.99), { style: 'percent', maximumFractionDigits: 0 });
    return agent.basis === 'quota' ? t('home.widget.usageQuota', { percent, window: agent.window?.label ?? '' }) : t('home.widget.usageBudget', { percent });
  }
  return t('home.widget.usageMonth', { tokens: t.number(agent.month.totalTokens, { notation: 'compact', maximumFractionDigits: 1 }) });
}

export function useUsageReading(size: WidgetSize): Reading {
  const t = useT();
  const active = useScreenActive();
  const query = useQuery({
    queryKey: ['home', 'widget', 'usage'],
    queryFn: ({ signal }) => api.get('/api/usage/summary', { schema: usageSummarySchema, query: { timeZone: timeZone() }, signal }),
    staleTime: 60_000,
    refetchInterval: active ? 3 * 60_000 : false,
    meta: { live: true },
  });
  const staleness = useStaleness(query);
  const data = query.data;
  if (!data) return { body: query.isError ? <p className="hw-empty">{t('home.widget.unreadable')}</p> : <Placeholder size={size} />, badge: null };
  const agents = [...data.agents].sort((a, b) => (b.fraction ?? -1) - (a.fraction ?? -1) || b.month.totalTokens - a.month.totalTokens);
  if (agents.length === 0) return { body: <p className="hw-empty">{t('home.widget.usageNone')}</p>, badge: staleBadge(staleness.stale, staleness.since, t) };
  const shown = agents.slice(0, size === 'small' ? 1 : size === 'medium' ? 3 : 6);
  const stale = staleness.stale || agents.some((agent) => agent.quotaState === 'stale');
  return {
    badge: stale ? t('home.widget.stale') : null,
    body: (
      <>
        <ul className="hw-gauges" data-size={size}>
          {shown.map((agent) => {
            const fraction = agent.fraction === null ? null : Math.min(1, agent.fraction);
            return (
              <li key={agent.agentId} className="hw-gauge" data-tone={fraction !== null && fraction >= 0.9 ? 'danger' : fraction !== null && fraction >= 0.75 ? 'warning' : undefined}>
                <span className="hw-gauge__name u-truncate">{agent.agentName}</span>
                {fraction !== null && (
                  <span className="hw-gauge__bar" role="img" aria-label={usageLine(agent, t)}>
                    <span style={{ width: `${Math.round(fraction * 100)}%` }} />
                  </span>
                )}
                <span className="hw-gauge__line u-truncate">{usageLine(agent, t)}</span>
              </li>
            );
          })}
        </ul>
        {size === 'large' && agents.some((agent) => agent.staleReason) && <p className="hw-foot">{agents.find((agent) => agent.staleReason)?.staleReason}</p>}
      </>
    ),
  };
}

// ---- the inbox ---------------------------------------------------------------------

export function useInboxReading(size: WidgetSize): Reading {
  const t = useT();
  const query = useQuery({ queryKey: inboxKeys.summary, queryFn: ({ signal }) => inboxApi.summary(signal), meta: { live: true }, staleTime: 10_000 });
  useInboxLiveUpdates();
  const staleness = useStaleness(query);
  const data = query.data;
  if (!data) return { body: query.isError ? <p className="hw-empty">{t('home.widget.unreadable')}</p> : <Placeholder size={size} />, badge: null };
  const { counts } = data;
  const rows: [MessageKey, number][] = [
    ['home.widget.inboxApprovals', counts.approvals],
    ['home.widget.inboxHandling', counts.needsHandling],
    ['home.widget.inboxResults', counts.results],
    ['home.widget.inboxRunning', counts.running],
  ];
  return {
    badge: staleBadge(staleness.stale, staleness.since, t),
    body:
      size === 'small' ? (
        <div className="hw-big">
          <span className="hw-big__figure u-tabular" data-tone={data.waiting > 0 ? 'attention' : undefined}>
            {t.number(data.waiting)}
          </span>
          <span className="hw-big__label">{t.plural('home.widget.inboxWaiting', data.waiting)}</span>
        </div>
      ) : (
        <>
          <dl className="hw-counts">
            {rows.map(([label, count]) => (
              <div key={label}>
                <dt>{t(label)}</dt>
                <dd className="u-tabular">{t.number(count)}</dd>
              </div>
            ))}
          </dl>
          {size === 'large' && data.unreadNotifications > 0 && <p className="hw-foot">{t.plural('home.widget.inboxUnread', data.unreadNotifications)}</p>}
        </>
      ),
  };
}

// ---- what is running ----------------------------------------------------------------

export function useRunningReading(size: WidgetSize): Reading {
  const t = useT();
  const query = useRunningWork({ pollMs: 60_000 });
  const staleness = useStaleness(query);
  const data = query.data;
  if (!data) return { body: query.isError ? <p className="hw-empty">{t('home.widget.unreadable')}</p> : <Placeholder size={size} />, badge: null };
  const entries = [
    ...data.runs.map((run) => ({ id: run.runId, title: run.title, agentId: run.agentId, waiting: run.state === 'waiting' })),
    ...data.tasks.map((entry) => ({ id: entry.task.id, title: entry.task.title, agentId: null, waiting: entry.task.state === 'needs-attention' })),
  ];
  const badge = staleBadge(staleness.stale, staleness.since, t);
  if (size === 'small' || entries.length === 0) {
    return {
      badge,
      body: (
        <div className="hw-big">
          <span className="hw-big__figure u-tabular" data-tone={data.counts.waiting > 0 ? 'attention' : undefined}>
            {t.number(data.counts.runs + data.counts.tasks)}
          </span>
          <span className="hw-big__label">{data.counts.waiting > 0 ? t.plural('home.widget.runningWaiting', data.counts.waiting) : t('home.widget.runningNow')}</span>
        </div>
      ),
    };
  }
  return {
    badge,
    body: (
      <ul className="hw-list">
        {entries.slice(0, size === 'medium' ? 2 : 5).map((entry) => (
          <li key={entry.id}>
            {entry.agentId ? <AgentMark agentId={entry.agentId} size={18} /> : <span className="hw-list__dot" aria-hidden="true" />}
            <span className="u-truncate">{entry.title}</span>
            {entry.waiting && <ActivityMark kind="attention" />}
          </li>
        ))}
      </ul>
    ),
  };
}

// ---- a plugin's links ---------------------------------------------------------------

function PluginLinks({ widget, editing, contributions, size }: WidgetBodyProps & { size: WidgetSize }) {
  const t = useT();
  const links = (contributions?.linkTiles ?? []).filter((link) => link.pluginId === widget.pluginId);
  if (!contributions) return <Placeholder size={size} />;
  if (links.length === 0) return <p className="hw-empty">{t('home.widget.linksNone')}</p>;
  return (
    <ul className="hw-links" data-size={size}>
      {links.slice(0, size === 'small' ? 1 : size === 'medium' ? 4 : 8).map((link) => {
        const href = safeLinkUrl(link.url);
        const Icon = pluginIcon(link.icon, 'link');
        return (
          <li key={link.id}>
            {href && !editing ? (
              <a className="hw-link" href={href} target="_blank" rel="noopener noreferrer" title={link.title}>
                <Icon size={16} aria-hidden="true" />
                <span className="u-truncate">{link.title}</span>
                <ArrowUpRight size={14} aria-hidden="true" />
              </a>
            ) : (
              <span className="hw-link" data-disabled="">
                <Icon size={16} aria-hidden="true" />
                <span className="u-truncate">{link.title}</span>
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export { PluginLinks };
