import type { Approval, ApprovalDecisionRequest, RiskCategory, ToolKind } from '@agent-studio/protocol';
import { ChevronDown, Clock, ListChecks, Maximize2, MessageSquare, ShieldAlert, ShieldQuestion } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { describeError } from '@/data/errors';
import { useSession, useUser } from '@/data/session';
import { type MessageKey, type Translator, useT } from '@/i18n';
import { Banner, Button, Checkbox, Menu, Sheet, TextArea, TextField, toast } from '@/ui';
import { workbenchApi } from '../api';
import { DiffView } from '../transcript/DiffView';
import { Prose } from '../transcript/Prose';
import { tidyToolName } from '../transcript/tools';
import { modeHint, modeLabel } from '../chat/Pickers';
import {
  type ApprovalChoices,
  type ContinuationMode,
  type DraftAnswer,
  type RememberScope,
  approvalChoices,
  collectAnswers,
  decisionFailure,
  describeRule,
  emptyAnswer,
  formatCountdown,
  isAnswered,
  secondsLeft,
  toggleOption,
  toggleOther,
  usableQuestions,
} from './logic';

const WANTS: Record<ToolKind, MessageKey> = {
  execute: 'workbench.approval.wants.execute',
  edit: 'workbench.approval.wants.edit',
  read: 'workbench.approval.wants.read',
  search: 'workbench.approval.wants.search',
  fetch: 'workbench.approval.wants.fetch',
  agent: 'workbench.approval.wants.agent',
  other: 'workbench.approval.wants.other',
};

const RISK_WORDS: Record<RiskCategory, MessageKey> = {
  destructive: 'workbench.risk.destructive',
  privilege: 'workbench.risk.privilege',
  'download-exec': 'workbench.risk.download-exec',
  'outside-project': 'workbench.risk.outside-project',
  credentials: 'workbench.risk.credentials',
  'recursive-permissions': 'workbench.risk.recursive-permissions',
  obfuscated: 'workbench.risk.obfuscated',
  'studio-data': 'workbench.risk.studio-data',
  catastrophic: 'workbench.risk.catastrophic',
};

const REMEMBER_LABELS: Record<RememberScope, MessageKey> = {
  session: 'workbench.approval.remember.session',
  project: 'workbench.approval.remember.project',
  always: 'workbench.approval.remember.always',
};

export function approvalHeadline(approval: Approval, agentName: string, t: Translator): string {
  if (approval.kind === 'plan') return t('workbench.plan.heading', { agent: agentName });
  if (approval.kind === 'question') return t('workbench.question.heading', { agent: agentName });
  return t(WANTS[approval.toolKind ?? 'other'], { agent: agentName, tool: tidyToolName(approval.toolName ?? '') });
}

/** Server time, as well as this device can tell: its own clock corrected by what the server last said. */
function useServerNow(active: boolean): number {
  const skew = useSession((state) => state.clockSkewMs);
  const [now, setNow] = useState(() => Date.now() + skew);
  useEffect(() => {
    if (!active) return;
    const tick = () => setNow(Date.now() + skew);
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [active, skew]);
  return now;
}

function Countdown({ approval }: { approval: Approval }) {
  const t = useT();
  const now = useServerNow(approval.expiresAt !== null);
  const left = secondsLeft(approval, now);
  if (left === null) return null;
  return (
    <span className="wb-approval__countdown u-tabular" data-urgent={left <= 60 || undefined} role="timer" aria-label={t('workbench.approval.expiresIn', { time: formatCountdown(left) })}>
      <Clock size={14} aria-hidden="true" />
      {formatCountdown(left)}
    </span>
  );
}

/** Everything known about a request: what, on what, why it is asked, how risky, what would be remembered. */
function Details({ approval, full, choices }: { approval: Approval; full: boolean; choices: ApprovalChoices }) {
  const t = useT();
  const args = (() => {
    if (!full || approval.input === null || approval.input === undefined) return '';
    try {
      const text = JSON.stringify(approval.input, null, 2);
      return text === '{}' ? '' : text.slice(0, 6000);
    } catch {
      return '';
    }
  })();
  return (
    <div className="wb-approval__details" data-full={full || undefined}>
      {approval.command && (
        <pre className="wb-approval__command" tabIndex={0}>
          {approval.command}
        </pre>
      )}
      {approval.paths.length > 0 && (
        <ul className="wb-approval__paths">
          {approval.paths.slice(0, full ? 50 : 3).map((path) => (
            <li key={path} className="u-mono">
              {path}
            </li>
          ))}
          {!full && approval.paths.length > 3 && <li>{t.plural('workbench.approval.morePaths', approval.paths.length - 3)}</li>}
        </ul>
      )}
      {approval.diff && <DiffView patch={approval.diff} limit={full ? 300 : 8} compact={!full} />}
      {approval.kind === 'plan' && approval.plan && full && (
        <div className="wb-plan">
          <Prose>{approval.plan}</Prose>
        </div>
      )}
      {approval.risk === 'dangerous' && (
        <Banner tone="danger" title={t('workbench.approval.dangerous')}>
          {approval.riskCategories.length > 0 ? approval.riskCategories.map((category) => t(RISK_WORDS[category])).join(' · ') : t('workbench.approval.dangerousGeneric')}
        </Banner>
      )}
      <p className="wb-approval__reason">{approval.reason}</p>
      {choices.waitingForOwner && <Banner tone="warning">{t('workbench.approval.waitingForOwner')}</Banner>}
      {full && approval.suggestedRule && choices.remember.length > 0 && (
        <p className="wb-approval__rule">
          {t('workbench.approval.ruleWouldBe')} <code className="u-mono">{describeRule(approval.suggestedRule)}</code>
        </p>
      )}
      {args !== '' && !approval.command && !approval.diff && (
        <details className="wb-tool__arguments">
          <summary>{t('workbench.tool.arguments')}</summary>
          <pre tabIndex={0}>{args}</pre>
        </details>
      )}
    </div>
  );
}

/** Sends a decision and says, in words, what became of it. A lost race is not an error: the request is simply answered. */
export function useDecision(onStale: () => void) {
  const t = useT();
  const [busy, setBusy] = useState<string | null>(null);
  const decide = useCallback(
    async (approval: Approval, request: ApprovalDecisionRequest, action: string): Promise<boolean> => {
      setBusy(action);
      try {
        const result = await workbenchApi.decide(approval.id, request);
        if (result.rule) toast.success(t('workbench.approval.ruleSaved', { rule: describeRule(result.rule) }));
        return true;
      } catch (error) {
        const failure = decisionFailure(error);
        if (failure.kind === 'already-answered' || failure.kind === 'gone') {
          toast.info(t('workbench.approval.alreadyAnswered'));
          onStale();
          return true;
        }
        if (failure.kind === 'owner-required') toast.error(t('workbench.approval.waitingForOwner'));
        else if (failure.kind === 'remember-refused') toast.error(t('workbench.approval.rememberRefused'));
        else toast.error(describeError(failure.error, t));
        // A refusal may mean what is on screen is out of date (the project's settings changed, say).
        if (failure.kind === 'mode-refused') onStale();
        return false;
      } finally {
        setBusy(null);
      }
    },
    [onStale, t],
  );
  return { busy, decide };
}

function RememberButton({ approval, scopes, disabled, onChoose }: { approval: Approval; scopes: RememberScope[]; disabled: boolean; onChoose: (scope: RememberScope) => void }) {
  const t = useT();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  if (scopes.length === 0 || !approval.suggestedRule) return null;
  const rule = describeRule(approval.suggestedRule);
  return (
    <>
      <Button ref={anchor} variant="tinted" disabled={disabled} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} className="wb-approval__remember">
        {t('workbench.approval.allowAndRemember')}
        <ChevronDown size={16} aria-hidden="true" />
      </Button>
      <Menu
        open={open}
        onClose={() => setOpen(false)}
        anchor={anchor}
        label={t('workbench.approval.rememberTitle', { rule })}
        align="end"
        items={scopes.map((scope) => ({ id: scope, label: t(REMEMBER_LABELS[scope]), hint: rule, onSelect: () => onChoose(scope) }))}
      />
    </>
  );
}

interface SurfaceProps {
  approval: Approval;
  agentName: string;
  /** Other requests waiting behind this one. */
  more: number;
  onStale: () => void;
  /** For a plan: the permission modes the session may continue in once it is approved. */
  continuation?: readonly ContinuationMode[];
}

function ContinueInButton({ modes, disabled, onChoose }: { modes: readonly ContinuationMode[]; disabled: boolean; onChoose: (mode: ContinuationMode) => void }) {
  const t = useT();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  if (modes.length === 0) return null;
  return (
    <>
      <Button ref={anchor} variant="tinted" disabled={disabled} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} className="wb-approval__continue">
        {t('workbench.plan.approveIn')}
        <ChevronDown size={16} aria-hidden="true" />
      </Button>
      <Menu
        open={open}
        onClose={() => setOpen(false)}
        anchor={anchor}
        label={t('workbench.plan.approveInTitle')}
        align="end"
        items={modes.map((mode) => ({ id: mode, label: modeLabel(mode, t), hint: modeHint(mode, t), onSelect: () => onChoose(mode) }))}
      />
    </>
  );
}

function ToolApproval({ approval, agentName, more, onStale, variant, onDetails }: SurfaceProps & { variant: 'dock' | 'sheet'; onDetails?: () => void }) {
  const t = useT();
  const user = useUser();
  const { busy, decide } = useDecision(onStale);
  const [note, setNote] = useState('');
  const choices = approvalChoices(approval, { userId: user?.id ?? '', role: user?.role ?? 'member' });
  const full = variant === 'sheet';
  const RiskIcon = approval.risk === 'dangerous' ? ShieldAlert : ShieldQuestion;

  return (
    <div className="wb-approval" data-risk={approval.risk} data-variant={variant}>
      <header className="wb-approval__header">
        <RiskIcon size={20} aria-hidden="true" />
        <div className="wb-approval__heading">
          <p className="wb-approval__title">{approvalHeadline(approval, agentName, t)}</p>
          <p className="wb-approval__subtitle">
            {approval.title}
            {more > 0 && <span className="wb-approval__more"> · {t.plural('workbench.approval.more', more)}</span>}
          </p>
        </div>
        <Countdown approval={approval} />
        {onDetails && (
          <button type="button" className="wb-bar-button" onClick={onDetails} aria-label={t('workbench.approval.details')} title={t('workbench.approval.details')}>
            <Maximize2 size={17} aria-hidden="true" />
          </button>
        )}
      </header>
      <Details approval={approval} full={full} choices={choices} />
      {full && choices.canDeny && <TextArea label={t('workbench.approval.note')} hint={t('workbench.approval.noteHint')} value={note} onChange={setNote} rows={2} autoGrow maxRows={5} optional />}
      {choices.canAnswer ? (
        <div className="wb-approval__actions">
          <Button variant="neutral" disabled={busy !== null} loading={busy === 'deny'} onClick={() => void decide(approval, { decision: 'deny', ...(note.trim() ? { note: note.trim() } : {}) }, 'deny')}>
            {full && note.trim() ? t('workbench.approval.denyWithNote') : t('workbench.approval.deny')}
          </Button>
          {choices.canAllow && (
            <>
              <RememberButton approval={approval} scopes={choices.remember} disabled={busy !== null} onChoose={(scope) => void decide(approval, { decision: 'allow', remember: scope }, 'remember')} />
              <Button variant="primary" disabled={busy !== null} loading={busy === 'allow'} onClick={() => void decide(approval, { decision: 'allow' }, 'allow')} data-autofocus={full ? '' : undefined}>
                {approval.risk === 'dangerous' ? t('workbench.approval.allowOnce') : t('workbench.approval.allow')}
              </Button>
            </>
          )}
        </div>
      ) : (
        <p className="wb-approval__reason">{t('workbench.approval.notYours')}</p>
      )}
    </div>
  );
}

function PlanApproval({ approval, agentName, onStale, variant, onDetails, continuation = [] }: SurfaceProps & { variant: 'dock' | 'sheet'; onDetails?: () => void }) {
  const t = useT();
  const user = useUser();
  const { busy, decide } = useDecision(onStale);
  const [revising, setRevising] = useState(false);
  const [note, setNote] = useState('');
  const choices = approvalChoices(approval, { userId: user?.id ?? '', role: user?.role ?? 'member' });

  return (
    <div className="wb-approval" data-variant={variant}>
      <header className="wb-approval__header">
        <ListChecks size={20} aria-hidden="true" />
        <div className="wb-approval__heading">
          <p className="wb-approval__title">{approvalHeadline(approval, agentName, t)}</p>
          <p className="wb-approval__subtitle">{t('workbench.plan.hint')}</p>
        </div>
        <Countdown approval={approval} />
        {onDetails && (
          <button type="button" className="wb-bar-button" onClick={onDetails} aria-label={t('workbench.plan.read')} title={t('workbench.plan.read')}>
            <Maximize2 size={17} aria-hidden="true" />
          </button>
        )}
      </header>
      {variant === 'sheet' && <Details approval={approval} full choices={choices} />}
      {revising && <TextArea label={t('workbench.plan.noteLabel')} value={note} onChange={setNote} rows={2} autoGrow maxRows={5} placeholder={t('workbench.plan.notePlaceholder')} autoFocus />}
      {choices.canAnswer ? (
        <div className="wb-approval__actions">
          {revising ? (
            <>
              <Button variant="plain" disabled={busy !== null} onClick={() => setRevising(false)}>
                {t('common.cancel')}
              </Button>
              <Button variant="tinted" disabled={busy !== null} loading={busy === 'deny'} onClick={() => void decide(approval, { decision: 'deny', ...(note.trim() ? { note: note.trim() } : {}) }, 'deny')}>
                {t('workbench.plan.sendBack')}
              </Button>
            </>
          ) : (
            <>
              <Button variant="neutral" disabled={busy !== null} onClick={() => setRevising(true)}>
                {t('workbench.plan.revise')}
              </Button>
              <ContinueInButton modes={continuation} disabled={busy !== null} onChoose={(mode) => void decide(approval, { decision: 'allow', permissionMode: mode }, 'allow')} />
              <Button variant="primary" disabled={busy !== null} loading={busy === 'allow'} onClick={() => void decide(approval, { decision: 'allow' }, 'allow')}>
                {t('workbench.plan.approve')}
              </Button>
            </>
          )}
        </div>
      ) : (
        <p className="wb-approval__reason">{t('workbench.approval.notYours')}</p>
      )}
    </div>
  );
}

/** The agent's questions, one at a time, in the place of the composer until they are answered or skipped. */
export function QuestionForm({ approval, agentName, onStale }: SurfaceProps) {
  const t = useT();
  const user = useUser();
  const { busy, decide } = useDecision(onStale);
  const questions = usableQuestions(approval);
  const [index, setIndex] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, DraftAnswer>>({});
  const now = useServerNow(false);
  const choices = approvalChoices(approval, { userId: user?.id ?? '', role: user?.role ?? 'member' });
  const question = questions[Math.min(index, questions.length - 1)];
  const last = index >= questions.length - 1;

  const skip = () => void decide(approval, { decision: 'deny' }, 'skip');
  const submit = () => void decide(approval, { decision: 'allow', answers: collectAnswers(questions, drafts) }, 'submit');

  const expiry = (() => {
    if (approval.expiresAt === null || approval.expiresAt <= now) return null;
    const anyRecommended = questions.some((entry) => entry.options.some((option) => option.recommended));
    const time = t.date(approval.expiresAt - useSession.getState().clockSkewMs, 'time');
    return anyRecommended ? t('workbench.question.autoRecommended', { time }) : t('workbench.question.autoSkipped', { time });
  })();

  if (!question) {
    // Nothing usable was asked: the user must still be able to get the composer back.
    return (
      <div className="wb-approval wb-question" data-variant="dock">
        <header className="wb-approval__header">
          <MessageSquare size={20} aria-hidden="true" />
          <div className="wb-approval__heading">
            <p className="wb-approval__title">{approvalHeadline(approval, agentName, t)}</p>
            <p className="wb-approval__subtitle">{t('workbench.question.malformed')}</p>
          </div>
        </header>
        {choices.canAnswer && (
          <div className="wb-approval__actions">
            <Button variant="tinted" loading={busy === 'skip'} onClick={skip}>
              {t('workbench.question.skip')}
            </Button>
          </div>
        )}
      </div>
    );
  }

  const draft = drafts[question.id] ?? emptyAnswer();
  const update = (next: DraftAnswer) => setDrafts((current) => ({ ...current, [question.id]: next }));
  const single = questions.length === 1;

  return (
    <div className="wb-approval wb-question" data-variant="dock">
      <header className="wb-approval__header">
        <MessageSquare size={20} aria-hidden="true" />
        <div className="wb-approval__heading">
          <p className="wb-approval__title">{question.header ?? approvalHeadline(approval, agentName, t)}</p>
          {questions.length > 1 && <p className="wb-approval__subtitle u-tabular">{t('workbench.question.position', { index: t.number(index + 1), total: t.number(questions.length) })}</p>}
        </div>
        <Countdown approval={approval} />
      </header>
      <div className="wb-question__body u-scroll">
        <p className="wb-question__text" id={`question-${approval.id}-${question.id}`}>
          {question.question}
        </p>
        <div className="wb-question__options" role={question.multiSelect ? 'group' : 'radiogroup'} aria-labelledby={`question-${approval.id}-${question.id}`}>
          {question.options.map((option) => {
            const selected = draft.selected.includes(option.label);
            const hint = [option.recommended ? t('workbench.question.recommended') : null, option.description ?? null].filter(Boolean).join(' · ');
            return question.multiSelect ? (
              <Checkbox key={option.label} checked={selected} onChange={() => update(toggleOption(question, draft, option.label))} label={option.label} {...(hint ? { hint } : {})} />
            ) : (
              <button key={option.label} type="button" role="radio" aria-checked={selected} className="wb-question__option" onClick={() => update(toggleOption(question, draft, option.label))}>
                <span className="wb-question__radio" aria-hidden="true" />
                <span className="wb-question__label">
                  {option.label}
                  {hint && <span className="wb-question__hint">{hint}</span>}
                </span>
              </button>
            );
          })}
          {question.multiSelect ? (
            <Checkbox checked={draft.otherOpen} onChange={() => update(toggleOther(question, draft))} label={t('workbench.question.other')} />
          ) : (
            <button type="button" role="radio" aria-checked={draft.otherOpen} className="wb-question__option" onClick={() => update(toggleOther(question, draft))}>
              <span className="wb-question__radio" aria-hidden="true" />
              <span className="wb-question__label">{t('workbench.question.other')}</span>
            </button>
          )}
          {draft.otherOpen && <TextField label={t('workbench.question.otherLabel')} hideLabel placeholder={t('workbench.question.otherPlaceholder')} value={draft.other} onChange={(other) => update({ ...draft, other })} autoFocus />}
        </div>
        {expiry && <p className="wb-question__expiry">{expiry}</p>}
      </div>
      {choices.canAnswer ? (
        <div className="wb-approval__actions">
          {index === 0 ? (
            <Button variant="neutral" disabled={busy !== null} loading={busy === 'skip'} onClick={skip}>
              {single ? t('workbench.question.skip') : t('workbench.question.skipAll')}
            </Button>
          ) : (
            <Button variant="neutral" disabled={busy !== null} onClick={() => setIndex(index - 1)}>
              {t('workbench.question.previous')}
            </Button>
          )}
          {last ? (
            <Button variant="primary" disabled={busy !== null || (single && !isAnswered(draft))} loading={busy === 'submit'} onClick={submit}>
              {t('workbench.question.submit')}
            </Button>
          ) : (
            <Button variant="primary" disabled={busy !== null} onClick={() => setIndex(index + 1)}>
              {t('workbench.question.next')}
            </Button>
          )}
        </div>
      ) : (
        <p className="wb-approval__reason">{t('workbench.approval.notYours')}</p>
      )}
    </div>
  );
}

/** The request waiting for the user, above the composer: enough to decide, with the full details one tap away. */
export function ApprovalDock({ approval, agentName, more, onStale, onDetails, continuation }: SurfaceProps & { onDetails: () => void }) {
  if (approval.kind === 'question') return <QuestionForm approval={approval} agentName={agentName} more={more} onStale={onStale} />;
  if (approval.kind === 'plan') {
    return <PlanApproval approval={approval} agentName={agentName} more={more} onStale={onStale} variant="dock" onDetails={onDetails} {...(continuation ? { continuation } : {})} />;
  }
  return <ToolApproval approval={approval} agentName={agentName} more={more} onStale={onStale} variant="dock" onDetails={onDetails} />;
}

/** The same request with everything about it: the whole command, the whole diff, the plan, a note for a denial. */
export function ApprovalSheet({
  approval,
  agentName,
  open,
  onClose,
  onStale,
  continuation,
}: {
  approval: Approval | null;
  agentName: string;
  open: boolean;
  onClose: () => void;
  onStale: () => void;
  continuation?: readonly ContinuationMode[];
}) {
  const t = useT();
  // The sheet outlives the request by the length of its exit: keep drawing the one it was opened for.
  const shown = useRef<Approval | null>(approval);
  if (approval) shown.current = approval;
  const current = approval ?? shown.current;
  if (!current) return null;
  return (
    <Sheet open={open && approval !== null} onClose={onClose} title={current.kind === 'plan' ? t('workbench.plan.title') : current.kind === 'question' ? t('workbench.question.title') : t('workbench.approval.sheetTitle')} size="lg">
      {current.kind === 'question' ? (
        <QuestionForm approval={current} agentName={agentName} more={0} onStale={onStale} />
      ) : current.kind === 'plan' ? (
        <PlanApproval approval={current} agentName={agentName} more={0} onStale={onStale} variant="sheet" {...(continuation ? { continuation } : {})} />
      ) : (
        <ToolApproval approval={current} agentName={agentName} more={0} onStale={onStale} variant="sheet" />
      )}
    </Sheet>
  );
}
