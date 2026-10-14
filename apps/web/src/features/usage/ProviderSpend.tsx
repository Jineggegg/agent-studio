import { type ProviderBalance, type ProviderUsage, USAGE_EVENT, userTopic } from '@agent-studio/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Coins, PiggyBank, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { describeError } from '@/data/errors';
import { useRealtimeTopic } from '@/data/realtime';
import { useUser } from '@/data/session';
import { type Translator, useT } from '@/i18n';
import { Banner, Button, Form, Glyph, Sheet, TextField, confirm, toast } from '@/ui';
import { usageApi, usageKeys } from './api';
import { usd } from './shape';
import './plan.css';

/** Every provider's noted amount and estimate for the caller, kept current over the live connection. */
export function useProviderUsage(enabled = true) {
  const user = useUser();
  const queryClient = useQueryClient();
  const usage = useQuery({ queryKey: usageKeys.providers, queryFn: ({ signal }) => usageApi.providers(signal), enabled, staleTime: 30_000, meta: { live: true } });
  useRealtimeTopic(enabled && user ? userTopic(user.id) : null, (event) => {
    if (event.type === USAGE_EVENT.providerNoteChanged) void queryClient.invalidateQueries({ queryKey: usageKeys.providers });
  });
  return usage;
}

function money(amount: number, currency: string, t: Translator): string {
  try {
    return t.number(amount, { style: 'currency', currency, maximumFractionDigits: 2 });
  } catch {
    return `${t.number(amount)} ${currency}`;
  }
}

/** The estimate in one or two sentences, with how far it can be trusted. */
function estimateLines(entry: ProviderUsage, t: Translator): string[] {
  const note = entry.note;
  const estimate = entry.estimate;
  if (!note || !estimate) return [];
  const lines: string[] = [];
  if (estimate.remaining !== null) lines.push(t('usage.spend.remaining', { amount: usd(estimate.remaining, t) }));
  lines.push(
    estimate.runs === 0
      ? t('usage.spend.noRuns')
      : estimate.spentUsd === null
        ? t.plural('usage.spend.spentUnknown', estimate.runs)
        : t.plural('usage.spend.spent', estimate.runs, { amount: usd(estimate.spentUsd, t) }),
  );
  if (note.currency !== 'USD') lines.push(t('usage.spend.otherCurrency', { currency: note.currency }));
  if (estimate.unpricedRuns > 0) lines.push(t.plural('usage.spend.unpriced', estimate.unpricedRuns));
  return lines;
}

function balanceLines(balance: ProviderBalance, t: Translator): string[] {
  if (!balance.available) return [];
  return balance.balances.map((entry) => {
    const total = Number(entry.total);
    return Number.isFinite(total) ? money(total, entry.currency, t) : `${entry.total} ${entry.currency}`;
  });
}

export interface ProviderSpendProps {
  providerId: string;
  /** Reading the balance from the provider uses its key: the owner's alone. */
  isOwner: boolean;
  /** Whether the provider documents a balance call at all. */
  balanceKind: 'none' | 'deepseek';
}

/**
 * Money for one API provider: the balance as the provider states it (where
 * it has a way to, for the owner), and the estimate — an amount the person
 * noted on a date minus what the Studio's records say was spent since. An
 * estimate, never a bill, and it says so.
 */
export function ProviderSpend({ providerId, isOwner, balanceKind }: ProviderSpendProps) {
  const t = useT();
  const queryClient = useQueryClient();
  const usage = useProviderUsage();
  const entry = usage.data?.providers.find((candidate) => candidate.providerId === providerId) ?? null;
  const [noting, setNoting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [balance, setBalance] = useState<ProviderBalance | null>(null);
  const [balanceProblem, setBalanceProblem] = useState<string | null>(null);

  const check = async () => {
    setChecking(true);
    setBalanceProblem(null);
    try {
      const answer = await usageApi.provider(providerId);
      setBalance(answer.balance);
      queryClient.setQueryData(usageKeys.providers, (current: { providers: ProviderUsage[] } | undefined) =>
        current ? { providers: current.providers.map((candidate) => (candidate.providerId === providerId ? { ...answer, balance: null } : candidate)) } : current,
      );
    } catch (error) {
      setBalanceProblem(describeError(error, t));
    } finally {
      setChecking(false);
    }
  };

  const clear = async () => {
    if (!(await confirm({ title: t('usage.spend.clearTitle'), message: t('usage.spend.clearText'), confirmLabel: t('common.remove'), tone: 'danger' }))) return;
    try {
      await usageApi.clearNote(providerId);
      void queryClient.invalidateQueries({ queryKey: usageKeys.providers });
    } catch (error) {
      toast.error(describeError(error, t));
    }
  };

  if (!entry) return usage.isError ? <p className="use-spend__note">{describeError(usage.error, t)}</p> : null;
  const lines = estimateLines(entry, t);

  return (
    <div className="use-spend">
      {isOwner && balanceKind !== 'none' && (
        <div className="use-spend__block">
          <div className="use-spend__head">
            <Glyph icon={<Coins size={16} />} tint="amber" size={28} />
            <p className="use-spend__title">{t('usage.spend.balance')}</p>
            <Button size="sm" variant="neutral" icon={<RefreshCw size={15} />} loading={checking} onClick={() => void check()}>
              {balance ? t('usage.spend.checkAgain') : t('usage.spend.check')}
            </Button>
          </div>
          {balance && (
            <div className="use-spend__lines" aria-live="polite">
              {balance.available ? (
                <>
                  {balanceLines(balance, t).map((line) => (
                    <p key={line} className="use-spend__figure">
                      {line}
                    </p>
                  ))}
                  {balance.sufficient === false && <p className="use-spend__warn">{t('usage.spend.insufficient')}</p>}
                  <p className="use-spend__note">{t('usage.spend.checked', { when: t.relative(balance.checkedAt) })}</p>
                </>
              ) : (
                <p className="use-spend__warn">{balance.message}</p>
              )}
            </div>
          )}
          {balanceProblem && <p className="use-spend__warn">{balanceProblem}</p>}
        </div>
      )}
      <div className="use-spend__block">
        <div className="use-spend__head">
          <Glyph icon={<PiggyBank size={16} />} tint="green" size={28} />
          <p className="use-spend__title">
            {entry.note ? t('usage.spend.noted', { amount: money(entry.note.amount, entry.note.currency, t), date: t.date(entry.note.notedAt, 'date') }) : t('usage.spend.noNote')}
          </p>
          <Button size="sm" variant="neutral" onClick={() => setNoting(true)}>
            {entry.note ? t('usage.spend.change') : t('usage.spend.add')}
          </Button>
          {entry.note && <Button size="sm" variant="plain-danger" icon={<Trash2 size={15} />} onClick={() => void clear()} aria-label={t('usage.spend.clear')}>{t('common.remove')}</Button>}
        </div>
        {lines.length > 0 && (
          <div className="use-spend__lines">
            {lines.map((line, index) => (
              <p key={line} className={index === 0 && entry.estimate?.remaining !== null ? 'use-spend__figure' : 'use-spend__note'}>
                {line}
              </p>
            ))}
          </div>
        )}
        <p className="use-spend__note">{entry.spendScope === 'everyone' ? t('usage.spend.scopeEveryone') : t('usage.spend.scopeOwn')}</p>
      </div>
      <NoteSheet open={noting} entry={entry} onClose={() => setNoting(false)} />
    </div>
  );
}

const today = (): string => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};

/** "I had this much on that day": the amount spend is counted down from. */
function NoteSheet({ open, entry, onClose }: { open: boolean; entry: ProviderUsage; onClose: () => void }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [date, setDate] = useState(today());
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [shownFor, setShownFor] = useState<boolean>(false);
  if (open && !shownFor) {
    setShownFor(true);
    setAmount(entry.note ? String(entry.note.amount) : '');
    setCurrency(entry.note?.currency ?? 'USD');
    setDate(today());
    setProblem(null);
  } else if (!open && shownFor) setShownFor(false);

  const value = Number(amount.replace(',', '.'));
  const valid = amount.trim() !== '' && Number.isFinite(value) && value >= 0 && /^[A-Za-z]{3}$/.test(currency.trim());

  const save = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const notedAt = date === today() ? Date.now() : new Date(`${date}T12:00:00`).getTime();
      await usageApi.setNote(entry.providerId, { amount: value, currency: currency.trim().toUpperCase(), ...(Number.isFinite(notedAt) ? { notedAt: Math.min(notedAt, Date.now()) } : {}) });
      void queryClient.invalidateQueries({ queryKey: usageKeys.providers });
      toast.success(t('usage.spend.saved'));
      onClose();
    } catch (error) {
      setProblem(describeError(error, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t('usage.spend.sheetTitle', { name: entry.name })}
      dismissible={!busy}
      footer={
        <>
          <Button variant="primary" block loading={busy} disabled={!valid} onClick={() => void save()}>
            {t('common.save')}
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
        <p className="use-form__text">{t('usage.spend.sheetText')}</p>
        <div className="use-form__pair">
          <TextField label={t('usage.spend.amount')} value={amount} onChange={setAmount} inputMode="decimal" autoComplete="off" data-autofocus="" />
          <TextField label={t('usage.spend.currency')} value={currency} onChange={(next) => setCurrency(next.toUpperCase().slice(0, 3))} autoCapitalize="characters" autoComplete="off" hint={t('usage.spend.currencyHint')} />
        </div>
        <TextField label={t('usage.spend.date')} type="date" value={date} onChange={setDate} max={today()} hint={t('usage.spend.dateHint')} />
        <button type="submit" hidden />
      </Form>
    </Sheet>
  );
}
