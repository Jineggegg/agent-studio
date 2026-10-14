import { type Automation, type AutomationTrigger, createAutomationRequestSchema, updateAutomationRequestSchema } from '@agent-studio/protocol';
import { describe, expect, it } from 'vitest';
import { getTranslator } from '@/i18n';
import { sendLaterBlock } from './SendLater';
import { visibleDeferred } from './DeferredList';
import { type AutomationForm, defaultForm, formProblems, fromAutomation, previewable, switchRepeat, toCreateRequest, toUpdateRequest } from './form';
import { formatCalendarDate, fromLocalInput, toLocalInput, wallClock } from './time';
import { triggerText } from './words';

// Friday 2026-10-16 18:00 UTC.
const NOW = Date.UTC(2026, 9, 16, 18, 0);

function saved(input: Pick<Automation, 'trigger' | 'action'> & Partial<Pick<Automation, 'name' | 'enabled' | 'timeZone'>>): Pick<Automation, 'name' | 'enabled' | 'timeZone' | 'trigger' | 'action'> {
  return { name: 'Stand-up', enabled: true, timeZone: 'Asia/Shanghai', ...input };
}

const TRIGGERS: AutomationTrigger[] = [
  { type: 'once', date: '2026-11-02', time: '07:30' },
  { type: 'hourly', minute: 45 },
  { type: 'daily', time: '09:00' },
  { type: 'weekdays', time: '08:15' },
  { type: 'weekly', days: [1, 3, 5], time: '17:00' },
  { type: 'cron', expression: '0 8 * * 1-5' },
  { type: 'event', event: 'run-failed' },
];

describe('the automation form', () => {
  it('maps every trigger kind to the payload and back, keeping the time zone', () => {
    for (const trigger of TRIGGERS) {
      for (const timeZone of ['Asia/Shanghai', 'America/New_York', 'UTC']) {
        const automation = saved({ trigger, timeZone, action: { type: 'notify', message: 'Time for the stand-up' } });
        const form = fromAutomation(automation, NOW);
        const payload = toCreateRequest(form);
        expect(payload.trigger, trigger.type).toEqual(trigger);
        expect(payload.timeZone).toBe(timeZone);
        // What the form sends is what the server accepts, and an untouched form changes nothing.
        expect(createAutomationRequestSchema.safeParse(payload).success, `${trigger.type} in ${timeZone}`).toBe(true);
        expect(toUpdateRequest(automation, form), trigger.type).toBeNull();
      }
    }
  });

  it('maps an agent run — existing conversation, model, kept effort — both ways', () => {
    const automation = saved({
      trigger: { type: 'daily', time: '06:00' },
      action: { type: 'agent-run', agentId: 'claude-code', prompt: 'Summarise yesterday’s commits.', session: { type: 'existing', sessionId: '01jabcdefghjkmnpqrstvwxyz0' }, permissionMode: 'plan', model: 'opus', effort: 'high' },
    });
    const form = fromAutomation(automation, NOW);
    expect(form).toMatchObject({ action: 'agent-run', agentId: 'claude-code', sessionMode: 'existing', sessionId: '01jabcdefghjkmnpqrstvwxyz0', permissionMode: 'plan', model: 'opus', effort: 'high' });
    expect(toCreateRequest(form).action).toEqual(automation.action);
    expect(toUpdateRequest(automation, form)).toBeNull();

    const fresh = toCreateRequest({ ...form, sessionMode: 'new', model: '' });
    expect(fresh.action).toEqual({ type: 'agent-run', agentId: 'claude-code', prompt: 'Summarise yesterday’s commits.', session: { type: 'new' }, permissionMode: 'plan', effort: 'high' });
  });

  it('sends only what changed — and never the switch of a one-off that ran unless it was moved', () => {
    const automation = saved({ enabled: false, trigger: { type: 'once', date: '2026-10-01', time: '08:00' }, action: { type: 'notify', message: 'Renew the certificate' } });
    const form = fromAutomation(automation, NOW);
    expect(toUpdateRequest(automation, { ...form, name: '  Renew   it ' })).toEqual({ name: 'Renew it' });
    expect(toUpdateRequest(automation, { ...form, date: '2026-12-01' })).toEqual({ trigger: { type: 'once', date: '2026-12-01', time: '08:00' } });
    expect(toUpdateRequest(automation, { ...form, timeZone: 'Europe/Berlin' })).toEqual({ timeZone: 'Europe/Berlin' });
    expect(toUpdateRequest(automation, { ...form, enabled: true })).toEqual({ enabled: true });
    const change = toUpdateRequest(automation, { ...form, message: 'Renew the TLS certificate' });
    expect(change).toEqual({ action: { type: 'notify', message: 'Renew the TLS certificate' } });
    expect(updateAutomationRequestSchema.safeParse(change).success).toBe(true);
  });

  it('keeps what makes sense when the kind of schedule changes', () => {
    const base = { ...defaultForm('Europe/Berlin', NOW), time: '07:45' };
    expect(switchRepeat(base, 'hourly').minute).toBe(45);
    expect(switchRepeat(base, 'weekdays').time).toBe('07:45');
    expect(switchRepeat({ ...base, days: [] }, 'weekly').days).toEqual([1]);
    const event = switchRepeat({ ...base, action: 'agent-run' }, 'event');
    expect(event.action).toBe('notify');
    // Weekly days go out sorted and without repeats.
    expect(toCreateRequest({ ...switchRepeat(base, 'weekly'), days: [5, 1, 5, 3] }).trigger).toEqual({ type: 'weekly', days: [1, 3, 5], time: '07:45' });
  });

  it('starts a new automation tomorrow in the device’s zone, as a daily reminder at nine', () => {
    const form = defaultForm('Asia/Shanghai', NOW, 'claude-code');
    // 18:00 UTC is already Saturday 02:00 in Shanghai; tomorrow there is Sunday the 18th.
    expect(form).toMatchObject({ timeZone: 'Asia/Shanghai', repeat: 'daily', time: '09:00', date: '2026-10-18', days: [0], agentId: 'claude-code', permissionMode: 'ask' });
  });

  it('says what is missing before anything is sent', () => {
    const empty: AutomationForm = defaultForm('UTC', NOW);
    expect(formProblems(empty)).toEqual(['name', 'message']);
    expect(formProblems({ ...empty, name: 'x', message: 'y', repeat: 'weekly', days: [] })).toEqual(['days']);
    expect(formProblems({ ...empty, name: 'x', message: 'y', repeat: 'cron', cron: '0 8 * *' })).toEqual(['cron']);
    expect(formProblems({ ...empty, name: 'x', repeat: 'daily', action: 'agent-run', agentId: '', prompt: '', sessionMode: 'existing' })).toEqual(['agent', 'prompt', 'session']);
    // An event trigger leads only to a reminder, so only the message is asked for.
    expect(formProblems({ ...empty, name: 'x', repeat: 'event', action: 'agent-run', message: 'Build failed' })).toEqual([]);
    expect(previewable({ ...empty, repeat: 'once', date: '2026-02-30' })).toBe(false);
    expect(previewable({ ...empty, repeat: 'event' })).toBe(false);
    expect(previewable({ ...empty, repeat: 'daily', time: '08:00' })).toBe(true);
  });
});

describe('times and zones', () => {
  it('reads the wall clock of a zone, not the device’s', () => {
    expect(wallClock(NOW, 'Asia/Shanghai')).toEqual({ date: '2026-10-17', time: '02:00', weekday: 6 });
    expect(wallClock(NOW, 'America/Los_Angeles')).toEqual({ date: '2026-10-16', time: '11:00', weekday: 5 });
  });

  it('never moves a calendar date to the day before', () => {
    expect(formatCalendarDate('2026-11-02', 'en')).toBe('Nov 2, 2026');
    expect(formatCalendarDate('2026-11-02', 'zh-CN')).toBe('2026年11月2日');
  });

  it('round-trips a local date-time field', () => {
    const at = new Date(2026, 9, 20, 14, 30).getTime();
    expect(fromLocalInput(toLocalInput(at))).toBe(at);
    expect(fromLocalInput('not a time')).toBeNull();
  });

  it('names the zone only when it is not the device’s', () => {
    const t = getTranslator('en');
    expect(triggerText({ type: 'weekdays', time: '08:00' }, t, null)).toBe('Weekdays at 8:00 AM');
    expect(triggerText({ type: 'weekly', days: [5, 1], time: '17:00' }, t, 'Asia/Shanghai')).toBe('Every Monday and Friday at 5:00 PM (Asia/Shanghai)');
    expect(triggerText({ type: 'hourly', minute: 5 }, t, null)).toBe('Every hour at :05');
    expect(triggerText({ type: 'event', event: 'run-failed' }, t, 'UTC')).toBe('When a run in this project fails or is cut short');
  });
});

describe('send later', () => {
  it('takes text only, and only where the project allows unattended work', () => {
    expect(sendLaterBlock({ text: 'Run the tests', files: 0, quote: false, projectAutomation: true })).toBeNull();
    expect(sendLaterBlock({ text: 'Run the tests', files: 0, quote: false, projectAutomation: null })).toBeNull();
    expect(sendLaterBlock({ text: 'Run the tests', files: 0, quote: false, projectAutomation: false })).toBe('automation-off');
    expect(sendLaterBlock({ text: '   ', files: 0, quote: false, projectAutomation: true })).toBe('empty');
    expect(sendLaterBlock({ text: 'See this', files: 2, quote: false, projectAutomation: true })).toBe('files');
    expect(sendLaterBlock({ text: 'About this', files: 0, quote: true, projectAutomation: true })).toBe('quote');
  });

  it('lists what waits, what runs and what failed — not what was sent, cancelled or put away', () => {
    const base = { sessionId: 's', projectId: null, text: 'x', queued: false, reason: null, detail: null, options: { model: null, effort: null, permissionMode: null }, runId: null, dismissed: false, createdAt: 0, updatedAt: 0 };
    const rows = visibleDeferred([
      { ...base, id: 'a', sendAt: 30, state: 'pending' },
      { ...base, id: 'b', sendAt: 10, state: 'in-progress' },
      { ...base, id: 'c', sendAt: 20, state: 'failed' },
      { ...base, id: 'd', sendAt: 5, state: 'failed', dismissed: true },
      { ...base, id: 'e', sendAt: 1, state: 'sent' },
      { ...base, id: 'f', sendAt: 2, state: 'cancelled' },
    ]);
    expect(rows.map((row) => row.id)).toEqual(['b', 'c', 'a']);
  });
});
