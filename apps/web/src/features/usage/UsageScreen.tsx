import { USER_AGENT_EVENT, type UsageFigures, type UsagePeriod, type UsageReport, userTopic } from '@agent-studio/protocol';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useStaleness } from '@/data/connection';
import { useRealtimeTopic } from '@/data/realtime';
import { useIsOwner, useUser } from '@/data/session';
import { deviceTimeZone, formatCalendarDate } from '@/features/automation/time';
import { useProviders } from './useProviders';
import { type Translator, useT } from '@/i18n';
import { Screen } from '@/shell/Screen';
import { useScreenActive } from '@/shell/ScreenStack';
import { DelayedSkeleton, EmptyState, ErrorState, IconButton, SegmentedControl, Skeleton, StaleNotice, progress } from '@/ui';
import { type ReportParams, usageApi, usageKeys } from './api';
import { Budgets } from './Budgets';
import { type BarRow, BarTable, ColumnChart } from './charts';
import { AgentPlanCard, useQuota } from './PlanWindows';
import { ProviderSpend, useProviderUsage } from './ProviderSpend';
import { type ColumnDatum, type Metric, compactNumber, costCaveat, costText, shapeBuckets, usd } from './shape';
import './usage.css';

const PERIOD_TITLE = { day: 'usage.chart.perDay', week: 'usage.chart.perWeek', month: 'usage.chart.perMonth' } as const;

function metricValue(figures: UsageFigures, metric: Metric): number {
  return metric === 'tokens' ? figures.totalTokens : (figures.cost.usd ?? 0);
}

/** A breakdown's rows for the chosen measure, largest first; a cost nobody knows sorts last and reads "unknown". */
function breakdownRows<T extends UsageFigures>(rows: readonly T[], metric: Metric, t: Translator, label: (row: T) => { key: string; label: string; detail?: string }): BarRow[] {
  const sorted = [...rows].sort((a, b) => {
    if (metric === 'cost') {
      const known = (row: T) => row.cost.coverage === 'complete' || row.cost.coverage === 'partial';
      if (known(a) !== known(b)) return known(a) ? -1 : 1;
    }
    return metricValue(b, metric) - metricValue(a, metric);
  });
  return sorted.map((row) => {
    const name = label(row);
    return {
      key: name.key,
      label: name.label,
      ...(name.detail ? { detail: name.detail } : {}),
      value: metric === 'cost' && (row.cost.coverage === 'unknown' || row.cost.coverage === 'none') ? 0 : metricValue(row, metric),
      valueText: metric === 'tokens' ? compactNumber(row.totalTokens, t) : costText(row.cost, t),
      extra: metric === 'tokens' ? costText(row.cost, t) : compactNumber(row.totalTokens, t),
    };
  });
}

function withOthers(rows: BarRow[], others: (UsageFigures & { count: number }) | null, metric: Metric, t: Translator): BarRow[] {
  if (!others) return rows;
  return [
    ...rows,
    {
      key: 'others',
      label: t.plural('usage.breakdown.others', others.count),
      value: metric === 'cost' && (others.cost.coverage === 'unknown' || others.cost.coverage === 'none') ? 0 : metricValue(others, metric),
      valueText: metric === 'tokens' ? compactNumber(others.totalTokens, t) : costText(others.cost, t),
      extra: metric === 'tokens' ? costText(others.cost, t) : compactNumber(others.totalTokens, t),
    },
  ];
}

function Kpis({ report, metric }: { report: UsageReport; metric: Metric }) {
  const t = useT();
  const totals = report.totals;
  const caveat = costCaveat(totals.cost, t);
  return (
    <div className="use-kpis" data-metric={metric}>
      <div className="use-kpi" data-lead={metric === 'tokens' || undefined}>
        <p className="use-kpi__label">{t('usage.kpi.tokens')}</p>
        <p className="use-kpi__value">{compactNumber(totals.totalTokens, t)}</p>
        <p className="use-kpi__detail">
          {t('usage.kpi.tokensDetail', { input: compactNumber(totals.inputTokens, t), output: compactNumber(totals.outputTokens, t), cache: compactNumber(totals.cacheReadTokens + totals.cacheWriteTokens, t) })}
        </p>
      </div>
      <div className="use-kpi" data-lead={metric === 'cost' || undefined} data-coverage={totals.cost.coverage}>
        <p className="use-kpi__label">{t('usage.kpi.cost')}</p>
        <p className="use-kpi__value">{costText(totals.cost, t)}</p>
        <p className="use-kpi__detail">{caveat ?? (totals.cost.coverage === 'complete' ? t('usage.kpi.costComplete') : t('usage.kpi.costNone'))}</p>
      </div>
      <div className="use-kpi">
        <p className="use-kpi__label">{t('usage.kpi.runs')}</p>
        <p className="use-kpi__value">{t.number(totals.runs)}</p>
        <p className="use-kpi__detail">{t.plural('usage.kpi.sessions', totals.sessions)}</p>
      </div>
    </div>
  );
}

/**
 * Usage: what was used — by day, week or month in this device's zone, by
 * agent, model, project (and, for the owner, by person) — what the agents'
 * plans have left as they last reported it, monthly budgets, and money left
 * with API providers. Tokens are what agents reported; a cost nobody knows is
 * said to be unknown, never shown as zero.
 */
export default function UsageScreen() {
  const t = useT();
  const user = useUser();
  const isOwner = useIsOwner();
  const active = useScreenActive();
  const queryClient = useQueryClient();
  const [scope, setScope] = useState<'mine' | 'all'>('mine');
  const [period, setPeriod] = useState<UsagePeriod>('day');
  const [metric, setMetric] = useState<Metric>('tokens');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const zone = deviceTimeZone();
  const params: ReportParams = { period, timeZone: zone, scope: isOwner ? scope : 'mine' };

  const report = useQuery({ queryKey: usageKeys.report(params), queryFn: ({ signal }) => usageApi.report(params, signal), enabled: active, placeholderData: keepPreviousData, meta: { live: true } });
  const { stale, since } = useStaleness(report);
  const quota = useQuota(active);
  const providerUsage = useProviderUsage(active);
  const providers = useProviders(active);

  // A finished run adds to the figures: read them again, once per burst.
  useRealtimeTopic(user ? userTopic(user.id) : null, (event) => {
    if (event.type !== USER_AGENT_EVENT.runFinished || timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      void queryClient.invalidateQueries({ queryKey: ['usage', 'report'] });
      void queryClient.invalidateQueries({ queryKey: usageKeys.budgets });
      void queryClient.invalidateQueries({ queryKey: usageKeys.providers });
    }, 1500);
  });

  const data = report.data;
  const columns: ColumnDatum[] = useMemo(() => (data ? shapeBuckets(data.buckets, data.period, metric, t) : []), [data, metric, t]);
  const format = (value: number) => (metric === 'tokens' ? compactNumber(value, t) : usd(value, t));
  const describe = (datum: ColumnDatum) => {
    const bucket = datum.bucket;
    const figure = metric === 'tokens' ? t('usage.readout.tokens', { tokens: compactNumber(bucket.totalTokens, t) }) : costText(bucket.cost, t);
    const runs = t.plural('usage.readout.runs', bucket.runs);
    return `${datum.longLabel}${datum.current ? ` (${t('usage.readout.soFar')})` : ''} · ${figure} · ${runs}`;
  };

  const refresh = () => void progress.track(queryClient.refetchQueries({ queryKey: usageKeys.all, type: 'active' }));
  const quotas = (quota.data?.agents ?? []).filter((entry) => entry.available || entry.state !== 'none');
  const apiProviders = (providerUsage.data?.providers ?? []).filter((entry) => providers.data?.some((provider) => provider.id === entry.providerId) ?? true);

  const filters = (
    <div className="use-filters" role="group" aria-label={t('usage.filters')}>
      {isOwner && (
        <SegmentedControl
          label={t('usage.scope')}
          value={scope}
          onChange={setScope}
          options={[
            { value: 'mine', label: t('usage.scope.mine') },
            { value: 'all', label: t('usage.scope.all') },
          ]}
        />
      )}
      <SegmentedControl
        label={t('usage.period')}
        value={period}
        onChange={setPeriod}
        options={[
          { value: 'day', label: t('usage.period.day') },
          { value: 'week', label: t('usage.period.week') },
          { value: 'month', label: t('usage.period.month') },
        ]}
      />
      <SegmentedControl
        label={t('usage.metric')}
        value={metric}
        onChange={setMetric}
        options={[
          { value: 'tokens', label: t('usage.metric.tokens') },
          { value: 'cost', label: t('usage.metric.cost') },
        ]}
      />
    </div>
  );

  let body;
  if (!data) {
    body = report.isError ? (
      <ErrorState error={report.error} onRetry={() => void report.refetch()} retrying={report.isFetching} />
    ) : (
      <DelayedSkeleton label={t('common.loading')}>
        <div className="use-kpis">
          {[0, 1, 2].map((index) => (
            <div key={index} className="use-kpi">
              <Skeleton width="40%" height={12} />
              <Skeleton width="60%" height={28} />
            </div>
          ))}
        </div>
        <Skeleton height={200} radius={16} />
      </DelayedSkeleton>
    );
  } else {
    const agentRows = withOthers(breakdownRows(data.byAgent.rows, metric, t, (row) => ({ key: row.agentId, label: row.agentName })), data.byAgent.others, metric, t);
    const modelRows = withOthers(breakdownRows(data.byModel.rows, metric, t, (row) => ({ key: `${row.agentId}:${row.model}`, label: row.model, detail: data.byAgent.rows.find((agent) => agent.agentId === row.agentId)?.agentName ?? row.agentId })), data.byModel.others, metric, t);
    const projectRows = withOthers(
      breakdownRows(data.byProject.rows, metric, t, (row) => ({
        key: row.projectId ?? row.kind,
        label: row.kind === 'project' ? (row.projectName ?? t('usage.breakdown.project')) : row.kind === 'none' ? t('usage.breakdown.noProject') : t('usage.breakdown.unavailable'),
      })),
      data.byProject.others,
      metric,
      t,
    );
    const userRows = data.byUser ? withOthers(breakdownRows(data.byUser.rows, metric, t, (row) => ({ key: row.userId, label: row.displayName ?? row.username ?? t('usage.breakdown.removedUser') })), data.byUser.others, metric, t) : null;
    const valueHeader = metric === 'tokens' ? t('usage.metric.tokens') : t('usage.metric.cost');
    const extraHeader = metric === 'tokens' ? t('usage.metric.cost') : t('usage.metric.tokens');
    const empty = data.totals.runs === 0;

    body = (
      <div className="use-report" data-pending={report.isPlaceholderData || undefined}>
        <p className="use-range">
          {t('usage.range', { from: formatCalendarDate(data.from, t.language), to: formatCalendarDate(data.to, t.language), zone: data.timeZone })}
          {data.lastRecordedAt !== null ? ` · ${t('usage.lastRecorded', { when: t.relative(data.lastRecordedAt) })}` : ''}
          {stale && (
            <>
              {' '}
              <StaleNotice since={since} />
            </>
          )}
        </p>
        <Kpis report={data} metric={metric} />
        {empty ? (
          <EmptyState title={t('usage.empty.title')} description={t('usage.empty.text')} compact />
        ) : (
          <>
            <section className="use-card">
              <ColumnChart data={columns} title={t(PERIOD_TITLE[data.period], { metric: metric === 'tokens' ? t('usage.metric.tokens') : t('usage.metric.cost') })} format={format} describe={describe} />
              {metric === 'cost' && columns.some((column) => column.state === 'unknown' || column.state === 'partial') && (
                <p className="use-legend">
                  {columns.some((column) => column.state === 'unknown') && (
                    <span className="use-legend__item" data-kind="unknown">
                      <span aria-hidden="true" />
                      {t('usage.legend.unknown')}
                    </span>
                  )}
                  {columns.some((column) => column.state === 'partial') && (
                    <span className="use-legend__item" data-kind="partial">
                      <span aria-hidden="true" />
                      {t('usage.legend.partial')}
                    </span>
                  )}
                </p>
              )}
              <details className="use-figures">
                <summary>{t('usage.figures.show')}</summary>
                <table className="use-table">
                  <caption className="visually-hidden">{t(PERIOD_TITLE[data.period], { metric: valueHeader })}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t('usage.figures.when')}</th>
                      <th scope="col">{t('usage.metric.tokens')}</th>
                      <th scope="col">{t('usage.metric.cost')}</th>
                      <th scope="col">{t('usage.kpi.runs')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...columns].reverse().map((column) => (
                      <tr key={column.key} data-current={column.current || undefined}>
                        <th scope="row">
                          {column.longLabel}
                          {column.current ? ` (${t('usage.readout.soFar')})` : ''}
                        </th>
                        <td>{compactNumber(column.bucket.totalTokens, t)}</td>
                        <td data-coverage={column.bucket.cost.coverage}>{costText(column.bucket.cost, t)}</td>
                        <td>{t.number(column.bucket.runs)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            </section>
            <div className="use-grid">
              <section className="use-card" aria-labelledby="use-by-agent">
                <h2 id="use-by-agent" className="use-card__title">
                  {t('usage.breakdown.byAgent')}
                </h2>
                <BarTable rows={agentRows} caption={t('usage.breakdown.byAgent')} labelHeader={t('usage.breakdown.agent')} valueHeader={valueHeader} extraHeader={extraHeader} />
              </section>
              <section className="use-card" aria-labelledby="use-by-model">
                <h2 id="use-by-model" className="use-card__title">
                  {t('usage.breakdown.byModel')}
                </h2>
                <BarTable rows={modelRows} caption={t('usage.breakdown.byModel')} labelHeader={t('usage.breakdown.model')} valueHeader={valueHeader} extraHeader={extraHeader} />
              </section>
              <section className="use-card" aria-labelledby="use-by-project">
                <h2 id="use-by-project" className="use-card__title">
                  {t('usage.breakdown.byProject')}
                </h2>
                <BarTable rows={projectRows} caption={t('usage.breakdown.byProject')} labelHeader={t('usage.breakdown.project')} valueHeader={valueHeader} extraHeader={extraHeader} />
              </section>
              {userRows && (
                <section className="use-card" aria-labelledby="use-by-user">
                  <h2 id="use-by-user" className="use-card__title">
                    {t('usage.breakdown.byUser')}
                  </h2>
                  <BarTable rows={userRows} caption={t('usage.breakdown.byUser')} labelHeader={t('usage.breakdown.user')} valueHeader={valueHeader} extraHeader={extraHeader} />
                </section>
              )}
            </div>
          </>
        )}
        <p className="use-note">{t('usage.reasoningNote')}</p>
      </div>
    );
  }

  return (
    <Screen
      title={t('usage.title')}
      width="wide"
      className="use-screen"
      actions={<IconButton label={t('usage.refresh')} icon={<RefreshCw size={21} />} busy={report.isFetching && report.data !== undefined} onClick={refresh} />}
    >
      <div className="use-page">
        {filters}
        {body}
        <section className="use-section" aria-labelledby="use-plans-title">
          <div className="use-section__head">
            <h2 id="use-plans-title">{t('usage.plan.sectionTitle')}</h2>
          </div>
          {quota.isError && !quota.data ? (
            <ErrorState error={quota.error} onRetry={() => void quota.refetch()} retrying={quota.isFetching} compact />
          ) : quotas.length === 0 ? (
            <p className="use-note">{quota.data ? t('usage.plan.noAgents') : t('common.loading')}</p>
          ) : (
            <div className="use-plans">
              {quotas.map((entry) => (
                <AgentPlanCard key={entry.agentId} quota={entry} />
              ))}
            </div>
          )}
          <p className="use-note">{t('usage.plan.footer')}</p>
        </section>
        <Budgets />
        {apiProviders.length > 0 && (
          <section className="use-section" aria-labelledby="use-providers-title">
            <div className="use-section__head">
              <h2 id="use-providers-title">{t('usage.providers.title')}</h2>
            </div>
            <div className="use-providers">
              {apiProviders.map((entry) => (
                <article key={entry.providerId} className="use-card">
                  <h3 className="use-card__title">{entry.name}</h3>
                  <ProviderSpend providerId={entry.providerId} isOwner={isOwner} balanceKind={providers.data?.find((provider) => provider.id === entry.providerId)?.settings?.balance ?? 'none'} />
                </article>
              ))}
            </div>
            <p className="use-note">{t('usage.providers.footer')}</p>
          </section>
        )}
      </div>
    </Screen>
  );
}
