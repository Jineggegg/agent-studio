import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AUTOMATION_LIMITS, type AutomationTrigger } from '@agent-studio/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../../kernel/database.js';
import { type ScheduleTrigger, planOverdue } from './schedule.js';
import { AUTOMATION_MIGRATIONS } from './schema.js';
import { type AutomationRow, AutomationStore, type ClaimTexts, type DeferredRow } from './store.js';

const at = (iso: string): number => Date.parse(iso);
const USER = 'u'.repeat(26);
const PROJECT = 'p'.repeat(26);

const texts: ClaimTexts = {
  missed: (plan) => `missed ${new Date(plan.scheduledFor).toISOString()} (+${plan.earlierMissed})`,
  earlierMissed: (plan, dueAt) => `missed ${plan.earlierMissed} since ${new Date(dueAt).toISOString()}`,
  stillRunning: () => 'still running',
};

let directory: string;
let db: Database;
let store: AutomationStore;
let counter = 0;

beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), 'automation-store-'));
  db = new Database(path.join(directory, 'test.db'));
  // The two tables the automation tables point at, as small as they can be.
  db.exec('CREATE TABLE users (id TEXT PRIMARY KEY); CREATE TABLE projects (id TEXT PRIMARY KEY);');
  db.run('INSERT INTO users (id) VALUES (?)', USER);
  db.run('INSERT INTO projects (id) VALUES (?)', PROJECT);
  db.migrate('automation', AUTOMATION_MIGRATIONS);
  store = new AutomationStore(db);
});

afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

function automation(trigger: AutomationTrigger, nextRunAt: number | null, overrides: Partial<AutomationRow> = {}): AutomationRow {
  counter += 1;
  const row: AutomationRow = {
    id: `a${String(counter).padStart(25, '0')}`,
    project_id: PROJECT,
    created_by: USER,
    name: 'Test',
    enabled: 1,
    time_zone: 'UTC',
    trigger: JSON.stringify(trigger),
    action: JSON.stringify({ type: 'notify', message: 'hello' }),
    event: null,
    next_run_at: nextRunAt,
    disabled_reason: null,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
  store.insert(row);
  return row;
}

const claim = (id: string, now: number) =>
  store.claimDue(
    id,
    now,
    (row) => planOverdue({ trigger: JSON.parse(row.trigger) as ScheduleTrigger, timeZone: row.time_zone, dueAt: row.next_run_at!, now, graceMs: AUTOMATION_LIMITS.graceMs }),
    texts,
  );

const executions = (id: string) => store.history(id, 100).reverse();
const DAILY: AutomationTrigger = { type: 'daily', time: '08:00' };

describe('claiming a due automation', () => {
  it('hands the occurrence to exactly one claimant and moves the schedule in the same breath', () => {
    const row = automation(DAILY, at('2026-10-13T08:00:00Z'));
    const now = at('2026-10-13T08:00:12Z');
    const first = claim(row.id, now);
    expect(first).toMatchObject({ kind: 'run', automation: { next_run_at: at('2026-10-14T08:00:00Z'), enabled: 1 } });
    if (first.kind !== 'run') throw new Error('unreachable');
    expect(first.execution).toMatchObject({ trigger: 'schedule', scheduled_for: at('2026-10-13T08:00:00Z'), started_at: now, ended_at: null, outcome: 'started' });
    expect(store.byId(row.id)).toMatchObject({ next_run_at: at('2026-10-14T08:00:00Z'), enabled: 1 });

    // A second pass at the same instant — or a moment later, or after a restart — finds nothing to claim.
    expect(claim(row.id, now)).toEqual({ kind: 'nothing' });
    expect(claim(row.id, now + 30_000)).toEqual({ kind: 'nothing' });
    expect(new AutomationStore(db).claimDue(row.id, now, () => ({ action: 'run', scheduledFor: at('2026-10-13T08:00:00Z'), earlierMissed: 0, next: null }), texts)).toEqual({ kind: 'nothing' });
    expect(executions(row.id)).toHaveLength(1);
  });

  it('claims nothing that is not due, switched off, or unknown', () => {
    const early = automation(DAILY, at('2026-10-13T08:00:00Z'));
    const off = automation(DAILY, at('2026-10-13T08:00:00Z'), { enabled: 0 });
    const unplanned = automation({ type: 'event', event: 'run-failed' }, null, { event: 'run-failed' });
    expect(claim(early.id, at('2026-10-13T07:59:59.999Z'))).toEqual({ kind: 'nothing' });
    for (const id of [off.id, unplanned.id, 'z'.repeat(26)]) expect(claim(id, at('2026-10-14T00:00:00Z'))).toEqual({ kind: 'nothing' });
    expect(store.due(at('2026-10-13T07:59:59Z'), 10)).toEqual([]);
    expect(store.due(at('2026-10-13T08:00:00Z'), 10)).toEqual([early.id]);
  });

  it('never lets an automation overlap itself: due again while still running, it is recorded as skipped', () => {
    const row = automation({ type: 'hourly', minute: 0 }, at('2026-10-13T08:00:00Z'));
    const first = claim(row.id, at('2026-10-13T08:00:05Z'));
    expect(first.kind).toBe('run');
    // An hour later the first execution is still open.
    const second = claim(row.id, at('2026-10-13T09:00:05Z'));
    expect(second).toMatchObject({ kind: 'skipped', execution: { outcome: 'skipped', reason: 'still-running', summary: 'still running', scheduled_for: at('2026-10-13T09:00:00Z') } });
    expect(store.byId(row.id)!.next_run_at).toBe(at('2026-10-13T10:00:00Z'));
    expect(executions(row.id).map((entry) => [entry.outcome, entry.ended_at === null])).toEqual([
      ['started', true],
      ['skipped', false],
    ]);

    // Once it has ended, the next occurrence runs again.
    if (first.kind !== 'run') throw new Error('unreachable');
    expect(store.finish(first.execution.id, { outcome: 'completed', reason: null, summary: 'done', endedAt: at('2026-10-13T09:30:00Z') })).toBe(true);
    expect(claim(row.id, at('2026-10-13T10:00:05Z')).kind).toBe('run');
  });

  it('the database itself refuses a second open execution and a second record of one occurrence', () => {
    const row = automation(DAILY, at('2026-10-13T08:00:00Z'));
    expect(claim(row.id, at('2026-10-13T08:00:05Z')).kind).toBe('run');
    const insert = (id: string, scheduledFor: number | null, endedAt: number | null) =>
      db.run(
        "INSERT INTO automation_executions (id, automation_id, trigger, scheduled_for, started_at, ended_at, outcome) VALUES (?, ?, 'schedule', ?, 1, ?, 'started')",
        id,
        row.id,
        scheduledFor,
        endedAt,
      );
    expect(() => insert('x'.repeat(26), at('2026-10-14T08:00:00Z'), null)).toThrow(/UNIQUE/);
    expect(() => insert('y'.repeat(26), at('2026-10-13T08:00:00Z'), 5)).toThrow(/UNIQUE/);
  });

  it('switches a one-off off at the moment it is claimed', () => {
    const row = automation({ type: 'once', date: '2026-10-13', time: '08:00' }, at('2026-10-13T08:00:00Z'));
    expect(claim(row.id, at('2026-10-13T08:00:20Z'))).toMatchObject({ kind: 'run', automation: { enabled: 0, next_run_at: null, disabled_reason: 'ran-once' } });
    expect(store.byId(row.id)).toMatchObject({ enabled: 0, next_run_at: null, disabled_reason: 'ran-once' });
    expect(claim(row.id, at('2026-10-13T08:01:00Z'))).toEqual({ kind: 'nothing' });
  });

  it('records a run that is too late as missed instead of running it', () => {
    const row = automation(DAILY, at('2026-10-13T08:00:00Z'));
    const late = claim(row.id, at('2026-10-13T15:00:00Z'));
    expect(late).toMatchObject({ kind: 'missed', execution: { outcome: 'missed', reason: 'server-down', summary: 'missed 2026-10-13T08:00:00.000Z (+0)', scheduled_for: at('2026-10-13T08:00:00Z') } });
    expect(late.kind === 'missed' && late.execution.ended_at).toBe(at('2026-10-13T15:00:00Z'));
    expect(store.byId(row.id)!.next_run_at).toBe(at('2026-10-14T08:00:00Z'));
    expect(store.openOf(row.id)).toBeUndefined();

    // A one-off that was missed is switched off all the same: its time is gone.
    const once = automation({ type: 'once', date: '2026-10-13', time: '08:00' }, at('2026-10-13T08:00:00Z'));
    expect(claim(once.id, at('2026-10-13T20:00:00Z'))).toMatchObject({ kind: 'missed', automation: { enabled: 0, next_run_at: null } });
  });

  it('after a long outage makes up the most recent occurrence and records the earlier ones as missed, once', () => {
    const row = automation(DAILY, at('2026-10-10T08:00:00Z'));
    const result = claim(row.id, at('2026-10-13T09:30:00Z'));
    expect(result).toMatchObject({ kind: 'run', execution: { scheduled_for: at('2026-10-13T08:00:00Z'), outcome: 'started' } });
    expect(executions(row.id).map((entry) => [entry.outcome, entry.scheduled_for, entry.summary])).toEqual([
      ['missed', at('2026-10-10T08:00:00Z'), 'missed 3 since 2026-10-10T08:00:00.000Z'],
      ['started', at('2026-10-13T08:00:00Z'), ''],
    ]);
    expect(store.byId(row.id)!.next_run_at).toBe(at('2026-10-14T08:00:00Z'));
  });

  it('never records — or runs — an occurrence that already has a record', () => {
    const row = automation(DAILY, at('2026-10-13T08:00:00Z'));
    expect(claim(row.id, at('2026-10-13T08:00:05Z')).kind).toBe('run');
    // Something set the schedule back to the same instant (a clock that jumped, a hand-edited row).
    db.run('UPDATE automations SET next_run_at = ? WHERE id = ?', at('2026-10-13T08:00:00Z'), row.id);
    expect(claim(row.id, at('2026-10-13T08:00:40Z'))).toEqual({ kind: 'nothing' });
    expect(executions(row.id)).toHaveLength(1);
    // The schedule has moved on rather than staying stuck on it.
    expect(store.byId(row.id)!.next_run_at).toBe(at('2026-10-14T08:00:00Z'));
  });
});

describe('running now', () => {
  it('opens an execution without touching the schedule, and not while one is open', () => {
    const row = automation(DAILY, at('2026-10-14T08:00:00Z'), { enabled: 0, next_run_at: null });
    const first = store.claimNow(row.id, 'manual', 100);
    expect(first).toMatchObject({ trigger: 'manual', scheduled_for: null, ended_at: null, outcome: 'started' });
    expect(store.claimNow(row.id, 'manual', 101)).toBeNull();
    expect(store.claimNow(row.id, 'event', 102)).toBeNull();
    expect(store.byId(row.id)).toMatchObject({ enabled: 0, next_run_at: null });
    expect(store.claimNow('z'.repeat(26), 'manual', 103)).toBeNull();

    // Closing happens once.
    expect(store.finish(first!.id, { outcome: 'notified', reason: null, summary: 'sent', endedAt: 200 })).toBe(true);
    expect(store.finish(first!.id, { outcome: 'failed', reason: 'error', summary: 'again', endedAt: 300 })).toBe(false);
    expect(store.execution(first!.id)).toMatchObject({ outcome: 'notified', summary: 'sent', ended_at: 200 });
    expect(store.claimNow(row.id, 'manual', 400)).not.toBeNull();
  });
});

describe('history', () => {
  it('is paged newest first and bounded, and an open execution is never pruned', () => {
    const row = automation({ type: 'hourly', minute: 0 }, at('2026-10-13T00:00:00Z'));
    for (let hour = 0; hour < 8; hour += 1) {
      const result = claim(row.id, at('2026-10-13T00:00:00Z') + hour * 3_600_000 + 1000);
      if (result.kind === 'run' && hour < 7) store.finish(result.execution.id, { outcome: 'notified', reason: null, summary: `run ${hour}`, endedAt: result.execution.started_at + 10 });
    }
    const page = store.history(row.id, 3);
    expect(page.map((entry) => entry.summary)).toEqual(['', 'run 6', 'run 5']);
    expect(store.history(row.id, 3, page[2]!.id).map((entry) => entry.summary)).toEqual(['run 4', 'run 3', 'run 2']);
    expect(store.latest(row.id)!.outcome).toBe('started');

    expect(store.pruneHistory(row.id, 3)).toBe(5);
    expect(store.history(row.id, 10).map((entry) => entry.summary)).toEqual(['', 'run 6', 'run 5']);
    expect(store.pruneHistory(row.id, 0)).toBe(2);
    expect(store.history(row.id, 10).map((entry) => entry.outcome)).toEqual(['started']);
  });

  it('counts denied requests against the open execution of a run', () => {
    const row = automation(DAILY, at('2026-10-13T08:00:00Z'));
    const result = claim(row.id, at('2026-10-13T08:00:05Z'));
    if (result.kind !== 'run') throw new Error('unreachable');
    store.attachRun(result.execution.id, 's'.repeat(26), 'r'.repeat(26), 'working');
    store.countDenied('r'.repeat(26));
    store.countDenied('r'.repeat(26));
    store.countDenied('q'.repeat(26));
    expect(store.openByRun('r'.repeat(26))).toMatchObject({ denied_count: 2, session_id: 's'.repeat(26), summary: 'working' });
    store.finish(result.execution.id, { outcome: 'denied', reason: 'approval-needed', summary: 'denied', endedAt: 10 });
    expect(store.openByRun('r'.repeat(26))).toBeUndefined();
  });
});

describe('deferred messages', () => {
  const deferred = (overrides: Partial<DeferredRow> = {}): DeferredRow => {
    counter += 1;
    const row: DeferredRow = {
      id: `d${String(counter).padStart(25, '0')}`,
      user_id: USER,
      session_id: 's'.repeat(26),
      project_id: PROJECT,
      text: 'later',
      model: null,
      effort: null,
      permission_mode: null,
      send_at: 1000,
      state: 'pending',
      reason: null,
      detail: null,
      run_id: null,
      dismissed_at: null,
      created_at: 1,
      updated_at: 1,
      ...overrides,
    };
    store.insertDeferred(row);
    return row;
  };

  it('are claimed by exactly one of two attempts', () => {
    const row = deferred();
    expect(store.dueDeferred(999, 10)).toEqual([]);
    expect(store.dueDeferred(1000, 10)).toEqual([row.id]);
    expect(store.moveDeferred(row.id, ['pending'], { state: 'sending' }, 1001)).toBe(true);
    expect(store.moveDeferred(row.id, ['pending'], { state: 'sending' }, 1002)).toBe(false);
    expect(store.dueDeferred(2000, 10)).toEqual([]);
    // A cancelled message cannot be claimed, and a claimed one cannot be cancelled.
    expect(store.moveDeferred(row.id, ['pending'], { state: 'cancelled' }, 1003)).toBe(false);
    const cancelled = deferred();
    expect(store.moveDeferred(cancelled.id, ['pending'], { state: 'cancelled' }, 1004)).toBe(true);
    expect(store.moveDeferred(cancelled.id, ['pending'], { state: 'sending' }, 1005)).toBe(false);
  });

  it('belong to their author, and go with their project', () => {
    const row = deferred();
    expect(store.deferredOf(USER, row.id)).toBeDefined();
    expect(store.deferredOf('x'.repeat(26), row.id)).toBeUndefined();
    expect(store.listDeferred({ userId: 'x'.repeat(26), includeDismissed: true, limit: 10 })).toEqual([]);
    expect(store.listDeferred({ userId: USER, states: ['pending'], includeDismissed: false, limit: 10 })).toHaveLength(1);
    db.run('DELETE FROM projects WHERE id = ?', PROJECT);
    expect(store.deferred(row.id)).toBeUndefined();
  });
});

describe('what goes when something else goes', () => {
  it('a project takes its automations and their history with it; so does an account', () => {
    const row = automation(DAILY, at('2026-10-13T08:00:00Z'));
    claim(row.id, at('2026-10-13T08:00:05Z'));
    db.run('DELETE FROM projects WHERE id = ?', PROJECT);
    expect(store.byId(row.id)).toBeUndefined();
    expect(store.openExecutions()).toEqual([]);

    db.run('INSERT INTO projects (id) VALUES (?)', PROJECT);
    const second = automation(DAILY, at('2026-10-13T08:00:00Z'));
    db.run('DELETE FROM users WHERE id = ?', USER);
    expect(store.byId(second.id)).toBeUndefined();
  });

  it('switching off what a person created in one project leaves everything else alone', () => {
    const other = 'o'.repeat(26);
    db.run('INSERT INTO users (id) VALUES (?)', other);
    const mine = automation(DAILY, at('2026-10-13T08:00:00Z'));
    const theirs = automation(DAILY, at('2026-10-13T08:00:00Z'), { created_by: other });
    expect(store.disableOfCreator(PROJECT, USER, 'access-lost', 50).map((row) => row.id)).toEqual([mine.id]);
    expect(store.byId(mine.id)).toMatchObject({ enabled: 0, next_run_at: null, disabled_reason: 'access-lost', updated_at: 50 });
    expect(store.byId(theirs.id)).toMatchObject({ enabled: 1, disabled_reason: null });
    expect(store.disableOfCreator(PROJECT, USER, 'access-lost', 60)).toEqual([]);
  });
});
