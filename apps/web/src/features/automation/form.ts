import { type Automation, type AutomationAction, type AutomationTrigger, type PermissionMode, isCalendarDate } from '@agent-studio/protocol';
import type { CreateAutomationInput, UpdateAutomationInput } from './api';
import { wallClock } from './time';

/**
 * The automation form as a plain object, and the two mappings that must not
 * drift: form → the payload the server takes, and an automation the server
 * returns → the form that edits it. Every trigger kind and the time zone
 * survive the round trip; switching the kind keeps what still makes sense.
 */

export type RepeatKind = AutomationTrigger['type'];
export const REPEAT_KINDS: readonly RepeatKind[] = ['once', 'hourly', 'daily', 'weekdays', 'weekly', 'cron', 'event'];

export interface AutomationForm {
  name: string;
  enabled: boolean;
  /** IANA name; every clock time below is wall-clock time there. */
  timeZone: string;
  repeat: RepeatKind;
  /** YYYY-MM-DD, for `once`. */
  date: string;
  /** HH:MM, for `once`, `daily`, `weekdays`, `weekly`. */
  time: string;
  /** 0–59, for `hourly`. */
  minute: number;
  /** 0 = Sunday … 6 = Saturday, for `weekly`. */
  days: number[];
  cron: string;
  action: AutomationAction['type'];
  message: string;
  agentId: string;
  prompt: string;
  sessionMode: 'new' | 'existing';
  sessionId: string;
  permissionMode: PermissionMode;
  /** '' means the agent's default model. */
  model: string;
  /** Kept as it was: the form offers no control for it. */
  effort: string | null;
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A new automation: a daily reminder at nine, in this device's zone, the first run tomorrow if nine has passed. */
export function defaultForm(timeZone: string, now: number, agentId = ''): AutomationForm {
  const clock = wallClock(now + 24 * 60 * 60 * 1000, timeZone);
  return {
    name: '',
    enabled: true,
    timeZone,
    repeat: 'daily',
    date: clock.date,
    time: '09:00',
    minute: 0,
    days: [clock.weekday],
    cron: '',
    action: 'notify',
    message: '',
    agentId,
    prompt: '',
    sessionMode: 'new',
    sessionId: '',
    permissionMode: 'ask',
    model: '',
    effort: null,
  };
}

export function triggerOf(form: AutomationForm): AutomationTrigger {
  switch (form.repeat) {
    case 'once':
      return { type: 'once', date: form.date, time: form.time };
    case 'hourly':
      return { type: 'hourly', minute: form.minute };
    case 'daily':
      return { type: 'daily', time: form.time };
    case 'weekdays':
      return { type: 'weekdays', time: form.time };
    case 'weekly':
      return { type: 'weekly', days: [...new Set(form.days)].sort((a, b) => a - b), time: form.time };
    case 'cron':
      return { type: 'cron', expression: form.cron.trim().replace(/\s+/g, ' ') };
    case 'event':
      return { type: 'event', event: 'run-failed' };
  }
}

export function actionOf(form: AutomationForm): AutomationAction {
  // An event can only lead to a notification.
  if (form.action === 'notify' || form.repeat === 'event') return { type: 'notify', message: form.message.replace(/\s+/g, ' ').trim() };
  return {
    type: 'agent-run',
    agentId: form.agentId,
    prompt: form.prompt.trim(),
    session: form.sessionMode === 'existing' ? { type: 'existing', sessionId: form.sessionId } : { type: 'new' },
    permissionMode: form.permissionMode,
    ...(form.model !== '' ? { model: form.model } : {}),
    ...(form.effort ? { effort: form.effort } : {}),
  };
}

export function toCreateRequest(form: AutomationForm): CreateAutomationInput {
  return { name: form.name.replace(/\s+/g, ' ').trim(), enabled: form.enabled, timeZone: form.timeZone, trigger: triggerOf(form), action: actionOf(form) };
}

/** The form that edits an automation. Fields the trigger does not use start from sensible values, so switching the kind fills them. */
export function fromAutomation(automation: Pick<Automation, 'name' | 'enabled' | 'timeZone' | 'trigger' | 'action'>, now: number): AutomationForm {
  const form = defaultForm(automation.timeZone, now);
  form.name = automation.name;
  form.enabled = automation.enabled;
  const trigger = automation.trigger;
  form.repeat = trigger.type;
  switch (trigger.type) {
    case 'once':
      form.date = trigger.date;
      form.time = trigger.time;
      break;
    case 'hourly':
      form.minute = trigger.minute;
      break;
    case 'daily':
    case 'weekdays':
      form.time = trigger.time;
      break;
    case 'weekly':
      form.days = [...trigger.days].sort((a, b) => a - b);
      form.time = trigger.time;
      break;
    case 'cron':
      form.cron = trigger.expression;
      break;
    case 'event':
      break;
  }
  const action = automation.action;
  form.action = action.type;
  if (action.type === 'notify') form.message = action.message;
  else {
    form.agentId = action.agentId;
    form.prompt = action.prompt;
    form.sessionMode = action.session.type;
    form.sessionId = action.session.type === 'existing' ? action.session.sessionId : '';
    form.permissionMode = action.permissionMode;
    form.model = action.model ?? '';
    form.effort = action.effort ?? null;
  }
  return form;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * What an edit sends: only what changed. Sending the switch unchanged would,
 * for a one-off that has run, ask for an impossible re-enable — so it is
 * sent only when it was moved.
 */
export function toUpdateRequest(original: Pick<Automation, 'name' | 'enabled' | 'timeZone' | 'trigger' | 'action'>, form: AutomationForm): UpdateAutomationInput | null {
  const next = toCreateRequest(form);
  const changes: UpdateAutomationInput = {};
  if (next.name !== original.name) changes.name = next.name;
  if (next.enabled !== original.enabled) changes.enabled = next.enabled;
  if (next.timeZone !== original.timeZone) changes.timeZone = next.timeZone;
  if (!same(next.trigger, original.trigger)) changes.trigger = next.trigger;
  if (!same(next.action, normaliseAction(original.action))) changes.action = next.action;
  return Object.keys(changes).length > 0 ? changes : null;
}

/** The action as the form would send it back, so an untouched one compares equal. */
function normaliseAction(action: AutomationAction): AutomationAction {
  if (action.type === 'notify') return { type: 'notify', message: action.message };
  return {
    type: 'agent-run',
    agentId: action.agentId,
    prompt: action.prompt,
    session: action.session.type === 'existing' ? { type: 'existing', sessionId: action.session.sessionId } : { type: 'new' },
    permissionMode: action.permissionMode,
    ...(action.model ? { model: action.model } : {}),
    ...(action.effort ? { effort: action.effort } : {}),
  };
}

/**
 * Changes how often it runs, keeping what still makes sense: the time of day
 * stays, an hourly schedule keeps only its minute, and an event can only
 * lead to a reminder.
 */
export function switchRepeat(form: AutomationForm, repeat: RepeatKind): AutomationForm {
  const next = { ...form, repeat };
  if (repeat === 'hourly' && form.repeat !== 'hourly') next.minute = Number(form.time.slice(3, 5)) || 0;
  if (repeat === 'weekly' && next.days.length === 0) next.days = [1];
  if (repeat === 'event') next.action = 'notify';
  return next;
}

export type FormProblem = 'name' | 'date' | 'time' | 'days' | 'cron' | 'message' | 'agent' | 'prompt' | 'session';

/** What must be filled in before saving. The server checks again, and more (cron, times in the past, modes). */
export function formProblems(form: AutomationForm): FormProblem[] {
  const problems: FormProblem[] = [];
  if (form.name.trim() === '') problems.push('name');
  if (form.repeat === 'once' && !isCalendarDate(form.date)) problems.push('date');
  if (['once', 'daily', 'weekdays', 'weekly'].includes(form.repeat) && !TIME.test(form.time)) problems.push('time');
  if (form.repeat === 'weekly' && form.days.length === 0) problems.push('days');
  if (form.repeat === 'cron' && form.cron.trim().split(/\s+/).length !== 5) problems.push('cron');
  const action = form.repeat === 'event' ? 'notify' : form.action;
  if (action === 'notify' && form.message.trim() === '') problems.push('message');
  if (action === 'agent-run') {
    if (form.agentId === '') problems.push('agent');
    if (form.prompt.trim() === '') problems.push('prompt');
    if (form.sessionMode === 'existing' && form.sessionId === '') problems.push('session');
  }
  return problems;
}

/** Whether the schedule can be previewed yet (the server is asked only about well-formed triggers). */
export function previewable(form: AutomationForm): boolean {
  if (form.repeat === 'event') return false;
  const problems = formProblems(form).filter((problem) => problem === 'date' || problem === 'time' || problem === 'days' || problem === 'cron');
  return problems.length === 0;
}
