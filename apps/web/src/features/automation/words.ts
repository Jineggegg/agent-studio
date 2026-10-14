import type { AutomationAction, AutomationExecution, AutomationOutcome, AutomationReason, AutomationTrigger, PermissionMode, UnattendedBehaviour } from '@agent-studio/protocol';
import type { MessageKey, Translator } from '@/i18n';
import { dayDistance, formatCalendarDate, formatInstant, formatTimeOfDay } from './time';

/** Sunday-first names for weekdays 0–6, in this language. */
export function weekdayNames(language: string, style: 'short' | 'long' = 'short'): string[] {
  // 2023-01-01 was a Sunday.
  return Array.from({ length: 7 }, (_, day) => new Intl.DateTimeFormat(language, { weekday: style, timeZone: 'UTC' }).format(Date.UTC(2023, 0, 1 + day, 12)));
}

/** The days of a weekly schedule, Monday first as people read a week. */
export function mondayFirst(days: readonly number[]): number[] {
  return [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
}

/** When it runs, in words: "Weekdays at 08:00". The zone is named only when it is not this device's. */
export function triggerText(trigger: AutomationTrigger, t: Translator, zone: string | null): string {
  const language = t.language;
  let text: string;
  switch (trigger.type) {
    case 'once':
      text = t('automation.when.once', { date: formatCalendarDate(trigger.date, language), time: formatTimeOfDay(trigger.time, language) });
      break;
    case 'hourly':
      text = t('automation.when.hourly', { minute: String(trigger.minute).padStart(2, '0') });
      break;
    case 'daily':
      text = t('automation.when.daily', { time: formatTimeOfDay(trigger.time, language) });
      break;
    case 'weekdays':
      text = t('automation.when.weekdays', { time: formatTimeOfDay(trigger.time, language) });
      break;
    case 'weekly': {
      const names = weekdayNames(language, trigger.days.length > 2 ? 'short' : 'long');
      text = t('automation.when.weekly', { days: t.list(mondayFirst(trigger.days).map((day) => names[day]!)), time: formatTimeOfDay(trigger.time, language) });
      break;
    }
    case 'cron':
      text = t('automation.when.cron', { expression: trigger.expression });
      break;
    case 'event':
      return t('automation.when.event');
  }
  return zone ? t('automation.when.inZone', { when: text, zone }) : text;
}

/** What it does, in words. */
export function actionText(action: AutomationAction, t: Translator, agentName: (id: string) => string): string {
  if (action.type === 'notify') return t('automation.what.notify', { message: action.message });
  const prompt = action.prompt.split('\n', 1)[0]!.slice(0, 120);
  return action.session.type === 'new'
    ? t('automation.what.agentNew', { agent: agentName(action.agentId), prompt })
    : t('automation.what.agentExisting', { agent: agentName(action.agentId), prompt });
}

export const OUTCOME: Record<AutomationOutcome, { label: MessageKey; tone: 'positive' | 'neutral' | 'info' | 'danger' | 'warning' }> = {
  notified: { label: 'automation.outcome.notified', tone: 'positive' },
  quiet: { label: 'automation.outcome.quiet', tone: 'neutral' },
  started: { label: 'automation.outcome.started', tone: 'info' },
  completed: { label: 'automation.outcome.completed', tone: 'positive' },
  failed: { label: 'automation.outcome.failed', tone: 'danger' },
  denied: { label: 'automation.outcome.denied', tone: 'warning' },
  skipped: { label: 'automation.outcome.skipped', tone: 'neutral' },
  missed: { label: 'automation.outcome.missed', tone: 'warning' },
};

export const REASON: Record<AutomationReason, MessageKey> = {
  'event-off': 'automation.reason.event-off',
  'channels-off': 'automation.reason.channels-off',
  'still-running': 'automation.reason.still-running',
  'session-busy': 'automation.reason.session-busy',
  'server-down': 'automation.reason.server-down',
  'automation-off': 'automation.reason.automation-off',
  'project-archived': 'automation.reason.project-archived',
  'creator-disabled': 'automation.reason.creator-disabled',
  'access-lost': 'automation.reason.access-lost',
  'agent-unavailable': 'automation.reason.agent-unavailable',
  'agent-not-enabled': 'automation.reason.agent-not-enabled',
  'mode-not-allowed': 'automation.reason.mode-not-allowed',
  'mode-not-supported': 'automation.reason.mode-not-supported',
  'session-gone': 'automation.reason.session-gone',
  'approval-needed': 'automation.reason.approval-needed',
  'run-failed': 'automation.reason.run-failed',
  'run-stopped': 'automation.reason.run-stopped',
  interrupted: 'automation.reason.interrupted',
  'not-delivered': 'automation.reason.not-delivered',
  error: 'automation.reason.error',
};

export const BEHAVIOUR: Record<UnattendedBehaviour, MessageKey> = {
  'read-only': 'automation.behaviour.read-only',
  'deny-and-report': 'automation.behaviour.deny-and-report',
  'edits-allowed': 'automation.behaviour.edits-allowed',
  auto: 'automation.behaviour.auto',
};

export const MODE: Record<PermissionMode, MessageKey> = {
  plan: 'automation.mode.plan',
  ask: 'automation.mode.ask',
  'accept-edits': 'automation.mode.accept-edits',
  auto: 'automation.mode.auto',
};

export const MODE_REFUSAL: Record<'auto-mode-off' | 'unsupported', MessageKey> = {
  'auto-mode-off': 'automation.refusal.auto-mode-off',
  unsupported: 'automation.refusal.unsupported',
};

/** "today 08:00", "tomorrow 08:00", "Tue, Oct 20, 08:00" — an instant on this device's calendar. */
export function whenText(instant: number, now: number, t: Translator): string {
  const days = dayDistance(instant, now);
  const time = t.date(instant, 'time');
  if (days === 0) return t('automation.day.today', { time });
  if (days === 1) return t('automation.day.tomorrow', { time });
  if (days === -1) return t('automation.day.yesterday', { time });
  return new Intl.DateTimeFormat(t.language, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(instant);
}

/** The time an execution is about: the occurrence it was due for, else when it started. */
export function executionTime(execution: AutomationExecution): number {
  return execution.scheduledFor ?? execution.startedAt;
}

/** An instant in the automation's zone and, when that differs, on this device as well. */
export function inBothZones(instant: number, zone: string, deviceZone: string, t: Translator): string {
  const there = formatInstant(instant, zone, t.language, true);
  if (zone === deviceZone) return there;
  return t('automation.preview.both', { there, here: formatInstant(instant, deviceZone, t.language, true) });
}

/** Server error codes of the automation routes, said as sentences (the dictionaries hold them under `errors.<code>`). */
export const AUTOMATION_ERROR_CODES = [
  'automation_disabled',
  'project_archived',
  'automation_limit',
  'time_passed',
  'invalid_cron',
  'never_runs',
  'cron_too_frequent',
  'agent_unavailable',
  'agent_not_enabled',
  'unsupported_permission_mode',
  'mode_not_allowed',
  'session_not_usable',
  'creator_without_access',
  'not_your_automation',
  'automation_not_found',
] as const;
