import { type Budget, USAGE_EVENT, userTopic } from '@agent-studio/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { isApiError } from '@/data/api';
import { describeError } from '@/data/errors';
import { useRealtimeTopic } from '@/data/realtime';
import { useUser } from '@/data/session';
import { TimeZonePicker } from '@/features/automation/TimeZonePicker';
import { deviceTimeZone } from '@/features/automation/time';
import { useAgents } from '@/features/workbench/agents';
import { type Translator, useT } from '@/i18n';
import { Banner, Button, EmptyState, ErrorState, Form, LoadingRow, MenuButton, SegmentedControl, Select, Sheet, TextField, confirm, toast } from '@/ui';
import { usageApi, usageKeys } from './api';
import { Meter } from './charts';
import { compactNumber, usd } from './shape';

function amountText(metric: Budget['metric'], value: number, t: Translator): string {
  return metric === 'cost' ? usd(value, t) : t('usage.budget.tokens', { amount: compactNumber(value, t) });
}

/** The caller's monthly marks, kept current over the live connection. They inform; nothing is ever blocked. */
export function useBudgets(enabled = true) {
  const user = useUser();
  const queryClient = useQueryClient();
  const budgets = useQuery({ queryKey: usageKeys.budgets, queryFn: ({ signal }) => usageApi.budgets(signal), enabled, meta: { live: true } });
  useRealtimeTopic(enabled && user ? userTopic(user.id) : null, (event) => {
    if (event.type === USAGE_EVENT.budgetChanged) void queryClient.invalidateQueries({ queryKey: usageKeys.budgets });
  });
  return budgets;
}

function BudgetRow({ budget, onEdit, onDelete }: { budget: Budget; onEdit: () => void; onDelete: () => void }) {
  const t = useT();
  const percent = Math.round(budget.fraction * 100);
  const who = budget.agentId === null ? t('usage.budget.everything') : (budget.agentName ?? budget.agentId);
  const valueText = t('usage.budget.progress', { used: amountText(budget.metric, budget.used, t), amount: amountText(budget.metric, budget.amount, t), percent: t.number(percent) });
  return (
    <li className="use-budget" data-state={budget.state}>
      <div className="use-budget__line">
        <span className="use-budget__who">
          {who}
          <span className="use-budget__metric">{budget.metric === 'cost' ? t('usage.budget.metricCost') : t('usage.budget.metricTokens')}</span>
        </span>
        <MenuButton
          label={t('usage.budget.actions', { name: who })}
          items={[
            { id: 'edit', label: t('usage.budget.edit'), icon: <Pencil size={18} />, onSelect: onEdit },
            { id: 'delete', label: t('usage.budget.delete'), icon: <Trash2 size={18} />, tone: 'danger', onSelect: onDelete },
          ]}
        />
      </div>
      <Meter fraction={budget.fraction} label={t('usage.budget.meter', { name: who })} valueText={valueText} />
      <p className="use-budget__text">
        {valueText}
        {budget.state === 'exceeded' ? ` · ${t('usage.budget.exceeded')}` : budget.state === 'warning' ? ` · ${t('usage.budget.warning')}` : ''}
      </p>
      {budget.metric === 'cost' && budget.unpricedRuns > 0 && <p className="use-budget__caveat">{t.plural('usage.budget.unpriced', budget.unpricedRuns)}</p>}
      <p className="use-budget__caveat">{t('usage.budget.month', { month: budget.month, zone: budget.timeZone })}</p>
    </li>
  );
}

/**
 * Budgets: a monthly mark per agent (or for everything), in tokens or US
 * dollars, with how far this month has got. Crossing 80 % and 100 % is
 * announced; nothing is ever stopped by one.
 */
export function Budgets() {
  const t = useT();
  const queryClient = useQueryClient();
  const budgets = useBudgets();
  const [editing, setEditing] = useState<{ budget: Budget | null } | null>(null);

  const remove = async (budget: Budget) => {
    const who = budget.agentId === null ? t('usage.budget.everything') : (budget.agentName ?? budget.agentId);
    if (!(await confirm({ title: t('usage.budget.deleteTitle', { name: who }), message: t('usage.budget.deleteText'), confirmLabel: t('usage.budget.delete'), tone: 'danger' }))) return;
    try {
      await usageApi.removeBudget(budget.id);
      void queryClient.invalidateQueries({ queryKey: usageKeys.budgets });
    } catch (error) {
      toast.error(describeError(error, t));
    }
  };

  return (
    <section className="use-section" aria-labelledby="use-budgets-title">
      <div className="use-section__head">
        <h2 id="use-budgets-title">{t('usage.budget.title')}</h2>
        <Button size="sm" variant="tinted" icon={<Plus size={16} />} onClick={() => setEditing({ budget: null })}>
          {t('usage.budget.add')}
        </Button>
      </div>
      {!budgets.data ? (
        budgets.isError ? (
          <ErrorState error={budgets.error} onRetry={() => void budgets.refetch()} retrying={budgets.isFetching} compact />
        ) : (
          <LoadingRow label={t('common.loading')} />
        )
      ) : budgets.data.budgets.length === 0 ? (
        <EmptyState title={t('usage.budget.empty')} description={t('usage.budget.emptyText')} compact />
      ) : (
        <ul className="use-budgets">
          {budgets.data.budgets.map((budget) => (
            <BudgetRow key={budget.id} budget={budget} onEdit={() => setEditing({ budget })} onDelete={() => void remove(budget)} />
          ))}
        </ul>
      )}
      <p className="use-note">{t('usage.budget.footer')}</p>
      <BudgetSheet open={editing !== null} budget={editing?.budget ?? null} taken={budgets.data?.budgets ?? []} onClose={() => setEditing(null)} />
    </section>
  );
}

function BudgetSheet({ open, budget, taken, onClose }: { open: boolean; budget: Budget | null; taken: readonly Budget[]; onClose: () => void }) {
  const t = useT();
  const queryClient = useQueryClient();
  const agents = useAgents({ enabled: open });
  const [agentId, setAgentId] = useState('');
  const [metric, setMetric] = useState<Budget['metric']>('tokens');
  const [amount, setAmount] = useState('');
  const [timeZone, setTimeZone] = useState(deviceTimeZone());
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [shown, setShown] = useState<Budget | null | undefined>(undefined);
  if (open && shown !== budget) {
    setShown(budget);
    setAgentId(budget?.agentId ?? '');
    setMetric(budget?.metric ?? 'tokens');
    setAmount(budget ? String(budget.amount) : '');
    setTimeZone(budget?.timeZone ?? deviceTimeZone());
    setProblem(null);
  } else if (!open && shown !== undefined) setShown(undefined);

  const value = Number(amount.replace(',', '.'));
  const valid = amount.trim() !== '' && Number.isFinite(value) && value > 0;
  const duplicate = !budget && taken.some((entry) => (entry.agentId ?? '') === agentId && entry.metric === metric);

  const save = async () => {
    if (!valid || busy || duplicate) return;
    setBusy(true);
    setProblem(null);
    try {
      if (budget) await usageApi.updateBudget(budget.id, { amount: value, timeZone });
      else await usageApi.createBudget({ agentId: agentId === '' ? null : agentId, metric, amount: value, timeZone });
      void queryClient.invalidateQueries({ queryKey: usageKeys.budgets });
      toast.success(budget ? t('usage.budget.saved') : t('usage.budget.created'));
      onClose();
    } catch (error) {
      setProblem(isApiError(error) && error.code === 'budget_exists' ? t('usage.budget.duplicate') : describeError(error, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={budget ? t('usage.budget.editTitle') : t('usage.budget.addTitle')}
      dismissible={!busy}
      footer={
        <>
          <Button variant="primary" block loading={busy} disabled={!valid || duplicate} onClick={() => void save()}>
            {budget ? t('common.save') : t('usage.budget.add')}
          </Button>
          <Button variant="plain" block disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </Button>
        </>
      }
    >
      <Form className="use-form" onSubmit={() => void save()}>
        {problem && (
          <Banner tone="danger" role="alert">
            <p>{problem}</p>
          </Banner>
        )}
        {!budget && (
          <>
            <div className="ui-field">
              <span className="ui-field__label">{t('usage.budget.for')}</span>
              <Select
                label={t('usage.budget.for')}
                value={agentId}
                onChange={setAgentId}
                block
                options={[{ value: '', label: t('usage.budget.everything') }, ...(agents.data ?? []).map((agent) => ({ value: agent.id, label: agent.displayName }))]}
              />
            </div>
            <div className="ui-field">
              <span className="ui-field__label">{t('usage.budget.metric')}</span>
              <SegmentedControl
                label={t('usage.budget.metric')}
                value={metric}
                onChange={setMetric}
                options={[
                  { value: 'tokens', label: t('usage.budget.metricTokens') },
                  { value: 'cost', label: t('usage.budget.metricCost') },
                ]}
              />
            </div>
          </>
        )}
        <TextField
          label={metric === 'cost' ? t('usage.budget.amountCost') : t('usage.budget.amountTokens')}
          value={amount}
          onChange={setAmount}
          inputMode="decimal"
          autoComplete="off"
          data-autofocus=""
          error={duplicate ? t('usage.budget.duplicate') : null}
          hint={metric === 'cost' ? t('usage.budget.amountCostHint') : t('usage.budget.amountTokensHint')}
        />
        <div className="ui-field">
          <span className="ui-field__label">{t('usage.budget.zone')}</span>
          <TimeZonePicker value={timeZone} onChange={setTimeZone} />
          <p className="ui-field__hint">{t('usage.budget.zoneHint')}</p>
        </div>
        <button type="submit" hidden />
      </Form>
    </Sheet>
  );
}
