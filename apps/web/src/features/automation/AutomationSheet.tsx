import { AUTOMATION_LIMITS, type Automation, type AutomationOptions, type PermissionMode } from '@agent-studio/protocol';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, Bot, CalendarClock, ShieldCheck, TriangleAlert, UserRound } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { isApiError } from '@/data/api';
import { describeError } from '@/data/errors';
import { useUser } from '@/data/session';
import { workbenchApi } from '@/features/workbench/api';
import { type MessageKey, useT } from '@/i18n';
import { useUnsavedWork } from '@/pwa/update';
import { Banner, Button, Form, SegmentedControl, Select, Sheet, Spinner, Switch, TextArea, TextField, confirm, toast } from '@/ui';
import { automationApi, automationKeys } from './api';
import { type AutomationForm, type FormProblem, type RepeatKind, REPEAT_KINDS, defaultForm, formProblems, fromAutomation, previewable, switchRepeat, toCreateRequest, toUpdateRequest, triggerOf } from './form';
import { TimeZonePicker } from './TimeZonePicker';
import { deviceTimeZone } from './time';
import { BEHAVIOUR, MODE, MODE_REFUSAL, REASON, inBothZones, mondayFirst, weekdayNames } from './words';

const REPEAT_LABEL: Record<RepeatKind, MessageKey> = {
  once: 'automation.repeat.once',
  hourly: 'automation.repeat.hourly',
  daily: 'automation.repeat.daily',
  weekdays: 'automation.repeat.weekdays',
  weekly: 'automation.repeat.weekly',
  cron: 'automation.repeat.cron',
  event: 'automation.repeat.event',
};

const PROBLEM_LABEL: Record<FormProblem, MessageKey> = {
  name: 'automation.problem.name',
  date: 'automation.problem.date',
  time: 'automation.problem.time',
  days: 'automation.problem.days',
  cron: 'automation.problem.cron',
  message: 'automation.problem.message',
  agent: 'automation.problem.agent',
  prompt: 'automation.problem.prompt',
  session: 'automation.problem.session',
};

const MINUTES = Array.from({ length: 12 }, (_, index) => index * 5);

/** A refusal appears at the top of a form that may be scrolled down: bring it into view (a stable ref, so once per message). */
const reveal = (element: HTMLElement | null) => element?.scrollIntoView?.({ block: 'nearest' });

function Group({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <fieldset className="aut-group">
      <legend className="aut-group__title">
        {icon}
        {title}
      </legend>
      {children}
    </fieldset>
  );
}

export interface AutomationSheetProps {
  open: boolean;
  projectId: string;
  /** Null to create one. */
  automation: Automation | null;
  options: AutomationOptions | undefined;
  onClose: () => void;
}

/**
 * Creating or editing an automation: when it runs (with the server's own
 * preview of the next five runs, as it is typed), what it does, and — for an
 * agent run — exactly which permission mode applies with nobody watching,
 * and why another one cannot.
 */
export function AutomationSheet({ open, projectId, automation, options, onClose }: AutomationSheetProps) {
  // Every opening starts a fresh form; the last one stays on screen while the sheet plays its exit.
  const [shown, setShown] = useState<{ opening: number; automation: Automation | null } | null>(null);
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setShown({ opening: (shown?.opening ?? 0) + 1, automation });
  }
  if (!shown) return null;
  return <FormSheet key={shown.opening} open={open} projectId={projectId} automation={shown.automation} options={options} onClose={onClose} />;
}

function FormSheet({ open, projectId, automation, options, onClose }: AutomationSheetProps) {
  const t = useT();
  const user = useUser();
  const queryClient = useQueryClient();
  const device = deviceTimeZone();
  const firstAgent = options?.agents.find((agent) => agent.available)?.id ?? '';
  const [initial] = useState<AutomationForm>(() => (automation ? fromAutomation(automation, Date.now()) : defaultForm(device, Date.now(), firstAgent)));
  const [form, setForm] = useState<AutomationForm>(initial);
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const set = (patch: Partial<AutomationForm>) => setForm((current) => ({ ...current, ...patch }));
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  useUnsavedWork(open && dirty);

  // An agent chosen before the options arrived (or none): settle on the first usable one.
  useEffect(() => {
    if (!options || form.agentId !== '') return;
    const first = options.agents.find((agent) => agent.available);
    if (first) setForm((current) => ({ ...current, agentId: first.id }));
  }, [options, form.agentId]);

  const problems = formProblems(form);
  const agent = options?.agents.find((entry) => entry.id === form.agentId);
  const modeOption = agent?.modes.find((entry) => entry.mode === form.permissionMode);
  const isEvent = form.repeat === 'event';
  const action = isEvent ? 'notify' : form.action;

  // ---- the server's preview of the next runs, as the schedule is typed ----------------------
  const trigger = previewable(form) ? triggerOf(form) : null;
  const previewKey = trigger ? JSON.stringify([form.timeZone, trigger]) : null;
  const [settled, setSettled] = useState<string | null>(previewKey);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(previewKey), 350);
    return () => window.clearTimeout(timer);
  }, [previewKey]);
  const preview = useQuery({
    queryKey: automationKeys.preview(form.timeZone, trigger ?? { type: 'event', event: 'run-failed' }),
    queryFn: ({ signal }) => automationApi.preview(form.timeZone, trigger!, signal),
    enabled: open && trigger !== null && settled === previewKey,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    retry: false,
  });

  // ---- the caller's conversations with this agent, for "always the same conversation" --------
  const sessions = useQuery({
    queryKey: ['automation', projectId, 'sessions'],
    queryFn: ({ signal }) => workbenchApi.listSessions({ projectId, limit: 100 }, signal),
    enabled: open && action === 'agent-run' && form.sessionMode === 'existing',
    staleTime: 30_000,
  });
  const ownSessions = (sessions.data?.sessions ?? []).filter((session) => session.agentId === form.agentId && session.userId === user?.id && !session.archived);

  const save = async () => {
    setTried(true);
    if (problems.length > 0 || saving) return;
    setSaving(true);
    setFailure(null);
    try {
      if (automation) {
        const changes = toUpdateRequest(automation, form);
        if (changes) await automationApi.update(projectId, automation.id, changes);
      } else {
        await automationApi.create(projectId, toCreateRequest(form));
      }
      void queryClient.invalidateQueries({ queryKey: automationKeys.project(projectId) });
      toast.success(automation ? t('automation.saved', { name: form.name.trim() }) : t('automation.created', { name: form.name.trim() }));
      onClose();
    } catch (error) {
      const issues = isApiError(error) ? error.fieldIssues : [];
      setFailure(issues.length > 0 ? `${describeError(error, t)} ${issues.map((issue) => issue.message).join(' ')}` : describeError(error, t));
    } finally {
      setSaving(false);
    }
  };

  const close = async () => {
    if (saving) return;
    if (dirty && !(await confirm({ title: t('automation.discardTitle'), message: t('automation.discardText'), confirmLabel: t('automation.discard'), tone: 'danger' }))) return;
    onClose();
  };

  const shownProblems = tried ? problems : [];
  const fieldError = (problem: FormProblem) => (shownProblems.includes(problem) ? t(PROBLEM_LABEL[problem]) : null);
  const days = weekdayNames(t.language, 'short');
  const minuteOptions = [...new Set([...MINUTES, form.minute])].sort((a, b) => a - b);
  const previewError = preview.error && isApiError(preview.error) ? describeError(preview.error, t) : preview.error ? t('automation.preview.failed') : null;

  return (
    <Sheet
      open={open}
      onClose={() => void close()}
      title={automation ? t('automation.editTitle') : t('automation.newTitle')}
      size="lg"
      fill
      dismissible={!saving}
      footer={
        <>
          <Button variant="primary" block loading={saving} onClick={() => void save()}>
            {automation ? t('common.save') : t('common.create')}
          </Button>
          <Button variant="plain" block disabled={saving} onClick={() => void close()}>
            {t('common.cancel')}
          </Button>
        </>
      }
    >
      <Form className="aut-form" onSubmit={() => void save()}>
        {failure && (
          <div key={failure} ref={reveal}>
            <Banner tone="danger" role="alert" title={t('automation.saveFailed')}>
              <p>{failure}</p>
            </Banner>
          </div>
        )}
        <TextField label={t('automation.field.name')} value={form.name} onChange={(name) => set({ name })} maxLength={AUTOMATION_LIMITS.nameChars} error={fieldError('name')} data-autofocus="" autoComplete="off" />

        <Group title={t('automation.group.when')} icon={<CalendarClock size={16} aria-hidden="true" />}>
          <div className="ui-field">
            <span className="ui-field__label">{t('automation.field.repeat')}</span>
            <Select
              label={t('automation.field.repeat')}
              value={form.repeat}
              onChange={(repeat) => setForm((current) => switchRepeat(current, repeat))}
              block
              options={REPEAT_KINDS.map((kind) => ({ value: kind, label: t(REPEAT_LABEL[kind]), ...(kind === 'cron' ? { hint: t('automation.repeat.cronHint') } : kind === 'event' ? { hint: t('automation.repeat.eventHint') } : {}) }))}
            />
          </div>
          {form.repeat === 'once' && (
            <div className="aut-form__pair">
              <TextField label={t('automation.field.date')} type="date" value={form.date} onChange={(date) => set({ date })} error={fieldError('date')} />
              <TextField label={t('automation.field.time')} type="time" value={form.time} onChange={(time) => set({ time })} error={fieldError('time')} />
            </div>
          )}
          {(form.repeat === 'daily' || form.repeat === 'weekdays' || form.repeat === 'weekly') && (
            <TextField label={t('automation.field.time')} type="time" value={form.time} onChange={(time) => set({ time })} error={fieldError('time')} />
          )}
          {form.repeat === 'weekly' && (
            <div className="ui-field">
              <span className="ui-field__label" id="aut-days-label">
                {t('automation.field.days')}
              </span>
              <div className="aut-days" role="group" aria-labelledby="aut-days-label">
                {mondayFirst([0, 1, 2, 3, 4, 5, 6]).map((day) => (
                  <button
                    key={day}
                    type="button"
                    className="aut-day"
                    aria-pressed={form.days.includes(day)}
                    onClick={() => set({ days: form.days.includes(day) ? form.days.filter((entry) => entry !== day) : [...form.days, day] })}
                  >
                    {days[day]}
                  </button>
                ))}
              </div>
              {fieldError('days') && (
                <p className="ui-field__error" role="alert">
                  {fieldError('days')}
                </p>
              )}
            </div>
          )}
          {form.repeat === 'hourly' && (
            <div className="ui-field">
              <span className="ui-field__label">{t('automation.field.minute')}</span>
              <Select
                label={t('automation.field.minute')}
                value={String(form.minute)}
                onChange={(minute) => set({ minute: Number(minute) })}
                block
                options={minuteOptions.map((minute) => ({ value: String(minute), label: t('automation.minuteOption', { minute: String(minute).padStart(2, '0') }) }))}
              />
            </div>
          )}
          {form.repeat === 'cron' && (
            <TextField
              label={t('automation.field.cron')}
              value={form.cron}
              onChange={(cron) => set({ cron })}
              mono
              placeholder="0 8 * * 1-5"
              hint={t('automation.field.cronHint')}
              error={fieldError('cron')}
              maxLength={AUTOMATION_LIMITS.cronChars}
              autoCapitalize="none"
              spellCheck={false}
              autoComplete="off"
            />
          )}
          {isEvent ? (
            <p className="aut-form__fixed">{t('automation.when.event')}</p>
          ) : (
            <div className="ui-field">
              <span className="ui-field__label">{t('automation.field.zone')}</span>
              <TimeZonePicker value={form.timeZone} onChange={(timeZone) => set({ timeZone })} />
            </div>
          )}
          {!isEvent && (
            <div className="aut-preview" aria-live="polite">
              <p className="aut-preview__title">
                {t('automation.preview.title')}
                {(preview.isFetching || (trigger !== null && settled !== previewKey)) && <Spinner size={14} />}
              </p>
              {!trigger ? (
                <p className="aut-preview__note">{t('automation.preview.incomplete')}</p>
              ) : previewError ? (
                <p className="aut-preview__error" role="alert">
                  {previewError}
                </p>
              ) : preview.data ? (
                preview.data.runs.length === 0 ? (
                  <p className="aut-preview__note">{t('automation.preview.none')}</p>
                ) : (
                  <ol className="aut-preview__list" data-pending={preview.isPlaceholderData || undefined}>
                    {preview.data.runs.map((run) => (
                      <li key={run}>{inBothZones(run, form.timeZone, device, t)}</li>
                    ))}
                  </ol>
                )
              ) : null}
            </div>
          )}
        </Group>

        <Group title={t('automation.group.what')} icon={action === 'notify' ? <BellRing size={16} aria-hidden="true" /> : <Bot size={16} aria-hidden="true" />}>
          {!isEvent && (
            <SegmentedControl
              label={t('automation.field.action')}
              value={form.action}
              onChange={(next) => set({ action: next })}
              options={[
                { value: 'notify', label: t('automation.action.notify') },
                { value: 'agent-run', label: t('automation.action.agent') },
              ]}
            />
          )}
          {action === 'notify' ? (
            <>
              <TextField
                label={t('automation.field.message')}
                value={form.message}
                onChange={(message) => set({ message })}
                maxLength={AUTOMATION_LIMITS.messageChars}
                error={fieldError('message')}
                hint={isEvent ? t('automation.field.messageEventHint') : t('automation.field.messageHint')}
                autoComplete="off"
              />
              <p className="aut-form__limits">{t('automation.limits.notify')}</p>
            </>
          ) : (
            <AgentRunFields
              form={form}
              set={set}
              options={options}
              fieldError={fieldError}
              sessions={ownSessions}
              sessionsLoading={sessions.isPending && form.sessionMode === 'existing'}
              guard={automation?.guard ?? null}
              actsAs={automation?.guard?.actsAs.displayName ?? options?.actsAs.displayName ?? user?.displayName ?? ''}
              modeAllowed={modeOption?.allowed ?? true}
            />
          )}
        </Group>

        <div className="aut-switch-row">
          <div>
            <p className="aut-switch-row__title">{t('automation.field.enabled')}</p>
            <p className="aut-switch-row__text">{form.enabled ? t('automation.field.enabledOn') : t('automation.field.enabledOff')}</p>
          </div>
          <Switch checked={form.enabled} onChange={(enabled) => set({ enabled })} label={t('automation.field.enabled')} />
        </div>
        {tried && problems.length > 0 && (
          <p className="ui-field__error" role="alert">
            {t('automation.problem.summary')}
          </p>
        )}
        <button type="submit" hidden />
      </Form>
    </Sheet>
  );
}

function AgentRunFields({
  form,
  set,
  options,
  fieldError,
  sessions,
  sessionsLoading,
  guard,
  actsAs,
  modeAllowed,
}: {
  form: AutomationForm;
  set: (patch: Partial<AutomationForm>) => void;
  options: AutomationOptions | undefined;
  fieldError: (problem: FormProblem) => string | null;
  sessions: { id: string; title: string }[];
  sessionsLoading: boolean;
  guard: Automation['guard'];
  actsAs: string;
  modeAllowed: boolean;
}) {
  const t = useT();
  const agents = options?.agents ?? [];
  const usable = agents.filter((agent) => agent.available || agent.id === form.agentId);
  const unusable = agents.filter((agent) => !agent.available && agent.id !== form.agentId);
  const agent = agents.find((entry) => entry.id === form.agentId);
  const chosenMode = agent?.modes.find((entry) => entry.mode === form.permissionMode);
  // Whatever the saved automation's guard says applies only while the form still describes it.
  const guardApplies = guard !== null && guard.permissionMode === form.permissionMode;

  return (
    <>
      {!options ? (
        <p className="aut-form__fixed">
          <Spinner size={14} /> {t('automation.agents.loading')}
        </p>
      ) : usable.length === 0 ? (
        <Banner tone="warning">
          <p>{t('automation.agents.none')}</p>
        </Banner>
      ) : (
        <div className="aut-form__pair">
          <div className="ui-field">
            <span className="ui-field__label">{t('automation.field.agent')}</span>
            <Select
              label={t('automation.field.agent')}
              value={form.agentId}
              onChange={(agentId) => {
                const next = agents.find((entry) => entry.id === agentId);
                const keep = next?.modes.some((entry) => entry.mode === form.permissionMode && entry.allowed);
                set({ agentId, model: '', sessionId: '', ...(keep ? {} : { permissionMode: 'ask' as PermissionMode }) });
              }}
              block
              options={usable.map((entry) => ({ value: entry.id, label: entry.displayName, ...(entry.available ? {} : { hint: entry.problem ?? t('automation.agents.unavailable') }) }))}
            />
            {fieldError('agent') && (
              <p className="ui-field__error" role="alert">
                {fieldError('agent')}
              </p>
            )}
          </div>
          {agent && agent.models.length > 0 && (
            <div className="ui-field">
              <span className="ui-field__label">{t('automation.field.model')}</span>
              <Select
                label={t('automation.field.model')}
                value={form.model}
                onChange={(model) => set({ model })}
                block
                options={[
                  { value: '', label: agent.defaultModel ? t('automation.model.defaultNamed', { model: agent.models.find((model) => model.id === agent.defaultModel)?.label ?? agent.defaultModel }) : t('automation.model.default') },
                  ...agent.models.map((model) => ({ value: model.id, label: model.label })),
                ]}
              />
            </div>
          )}
        </div>
      )}
      {unusable.length > 0 && <p className="aut-form__limits">{t('automation.agents.unusable', { names: t.list(unusable.map((entry) => entry.displayName)) })}</p>}
      <TextArea
        label={t('automation.field.prompt')}
        value={form.prompt}
        onChange={(prompt) => set({ prompt })}
        rows={5}
        autoGrow
        maxRows={14}
        maxLength={AUTOMATION_LIMITS.promptChars}
        error={fieldError('prompt')}
      />
      <div className="ui-field">
        <span className="ui-field__label">{t('automation.field.session')}</span>
        <SegmentedControl
          label={t('automation.field.session')}
          value={form.sessionMode}
          onChange={(sessionMode) => set({ sessionMode })}
          options={[
            { value: 'new', label: t('automation.session.new') },
            { value: 'existing', label: t('automation.session.existing') },
          ]}
        />
        <p className="ui-field__hint">{form.sessionMode === 'new' ? t('automation.session.newHint') : t('automation.session.existingHint')}</p>
      </div>
      {form.sessionMode === 'existing' && (
        <div className="ui-field">
          {sessionsLoading ? (
            <p className="aut-form__fixed">
              <Spinner size={14} /> {t('common.loading')}
            </p>
          ) : sessions.length === 0 ? (
            <Banner tone="info">
              <p>{t('automation.session.none')}</p>
            </Banner>
          ) : (
            <Select
              label={t('automation.session.choose')}
              value={form.sessionId}
              onChange={(sessionId) => set({ sessionId })}
              block
              options={[{ value: '', label: t('automation.session.choose') }, ...sessions.map((session) => ({ value: session.id, label: session.title }))]}
            />
          )}
          {fieldError('session') && (
            <p className="ui-field__error" role="alert">
              {fieldError('session')}
            </p>
          )}
        </div>
      )}
      {agent && (
        <div className="ui-field">
          <span className="ui-field__label" id="aut-mode-label">
            {t('automation.field.mode')}
          </span>
          <div className="aut-modes" role="radiogroup" aria-labelledby="aut-mode-label">
            {agent.modes.map((entry) => (
              <button
                key={entry.mode}
                type="button"
                role="radio"
                aria-checked={form.permissionMode === entry.mode}
                className="aut-mode"
                disabled={!entry.allowed}
                onClick={() => set({ permissionMode: entry.mode })}
              >
                <span className="aut-mode__name">{t(MODE[entry.mode])}</span>
                <span className="aut-mode__text">{entry.allowed ? t(BEHAVIOUR[entry.behaviour]) : t(MODE_REFUSAL[entry.refusal ?? 'unsupported'])}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="aut-guard" data-allowed={(guardApplies ? guard.allowed : modeAllowed) || undefined}>
        <p className="aut-guard__line">
          <UserRound size={15} aria-hidden="true" />
          {t('automation.guard.actsAs', { name: actsAs })}
        </p>
        {chosenMode && (
          <p className="aut-guard__line">
            <ShieldCheck size={15} aria-hidden="true" />
            {t('automation.guard.mode', { mode: t(MODE[chosenMode.mode]), behaviour: t(BEHAVIOUR[chosenMode.behaviour]) })}
          </p>
        )}
        {guardApplies && !guard.allowed && guard.refusal && (
          <p className="aut-guard__line" data-tone="warning">
            <TriangleAlert size={15} aria-hidden="true" />
            {t('automation.guard.refused', { reason: t(REASON[guard.refusal]) })}
          </p>
        )}
        <p className="aut-guard__note">{t('automation.guard.unattended')}</p>
      </div>
    </>
  );
}
