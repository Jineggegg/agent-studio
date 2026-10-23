import type { Migration } from '../../kernel/database.js';

export const AUTOMATION_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'automations, their executions, deferred messages',
    sql: `
      -- Something a project does by itself. It goes when its project or its creator goes.
      CREATE TABLE automations (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        -- The account every execution acts as.
        created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        time_zone TEXT NOT NULL,
        -- JSON, as validated by the protocol schemas.
        trigger TEXT NOT NULL,
        action TEXT NOT NULL,
        -- The event an event-triggered automation waits for; null for schedules.
        event TEXT,
        -- When it is due next. Null: off, waiting for an event, or a one-off that has run.
        next_run_at INTEGER,
        -- Why the server switched it off by itself: 'ran-once', 'access-lost'.
        disabled_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX automations_project ON automations(project_id, created_at);
      CREATE INDEX automations_due ON automations(next_run_at) WHERE enabled = 1 AND next_run_at IS NOT NULL;
      CREATE INDEX automations_creator ON automations(created_by, project_id);

      -- One row per time an automation fired, or should have.
      CREATE TABLE automation_executions (
        -- The order in which executions were recorded; ids alone do not order two rows written in the same millisecond.
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
        trigger TEXT NOT NULL CHECK (trigger IN ('schedule', 'manual', 'event')),
        -- The occurrence it is for; null for manual and event executions.
        scheduled_for INTEGER,
        started_at INTEGER NOT NULL,
        -- Null while an agent run started by it is still going.
        ended_at INTEGER,
        outcome TEXT NOT NULL,
        reason TEXT,
        summary TEXT NOT NULL DEFAULT '',
        session_id TEXT,
        run_id TEXT,
        -- Requests of the run that needed approval and were denied because nobody was there.
        denied_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX automation_executions_history ON automation_executions(automation_id, seq);
      -- An occurrence is claimed once: a second claim of the same instant cannot be recorded.
      CREATE UNIQUE INDEX automation_executions_occurrence ON automation_executions(automation_id, scheduled_for) WHERE scheduled_for IS NOT NULL;
      -- An automation never overlaps itself: at most one execution of it is open.
      CREATE UNIQUE INDEX automation_executions_open ON automation_executions(automation_id) WHERE ended_at IS NULL;
      CREATE INDEX automation_executions_run ON automation_executions(run_id) WHERE run_id IS NOT NULL;

      -- One message to one existing session, to be sent at a chosen instant.
      CREATE TABLE deferred_messages (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        -- Not a foreign key on purpose: a message whose session is gone must fail with a reason, not vanish.
        session_id TEXT NOT NULL,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        model TEXT,
        effort TEXT,
        permission_mode TEXT,
        send_at INTEGER NOT NULL,
        -- pending -> sending -> queued | running -> sent | failed;  pending -> cancelled
        state TEXT NOT NULL CHECK (state IN ('pending', 'sending', 'queued', 'running', 'sent', 'failed', 'cancelled')),
        reason TEXT,
        detail TEXT,
        run_id TEXT,
        dismissed_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX deferred_messages_user ON deferred_messages(user_id, state, send_at);
      CREATE INDEX deferred_messages_due ON deferred_messages(send_at) WHERE state = 'pending';
      CREATE INDEX deferred_messages_session ON deferred_messages(session_id, user_id);
      CREATE INDEX deferred_messages_run ON deferred_messages(run_id) WHERE run_id IS NOT NULL;
    `,
  },
  {
    version: 2,
    name: 'reminders pending human approval',
    sql: `CREATE TABLE reminder_proposals (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, proposal TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL); CREATE INDEX reminder_proposals_owner ON reminder_proposals(user_id, project_id);`,
  },
];
