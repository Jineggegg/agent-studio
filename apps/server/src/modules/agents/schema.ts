import type { Migration } from '../../kernel/database.js';

/**
 * Tables of the agent runtime. Every row belongs to a user and (usually) a
 * project; queries filter on both. Timestamps are milliseconds since the
 * epoch; booleans are 0/1.
 */
export const AGENTS_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'sessions, event log, runs, queue, approvals, rules, attachments, usage',
    sql: `
      -- One conversation with one agent. The id is issued before the first message and never changes.
      CREATE TABLE agent_sessions (
        id TEXT PRIMARY KEY,
        -- Null only for a conversation with an API model outside any project.
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL,
        model TEXT,
        effort TEXT,
        permission_mode TEXT NOT NULL CHECK (permission_mode IN ('plan', 'ask', 'accept-edits', 'auto')),
        title TEXT NOT NULL,
        -- default: placeholder; auto: from the first message; agent: proposed by the agent; manual: typed by the user.
        title_source TEXT NOT NULL DEFAULT 'default' CHECK (title_source IN ('default', 'auto', 'agent', 'manual')),
        -- The agent's own id for the conversation, for resuming. Never sent to clients in events.
        native_session_id TEXT,
        pinned INTEGER NOT NULL DEFAULT 0,
        archived_at INTEGER,
        chain_id TEXT,
        parent_session_id TEXT,
        attention TEXT NOT NULL DEFAULT 'none' CHECK (attention IN ('none', 'running', 'needs-you', 'unseen')),
        draft TEXT NOT NULL DEFAULT '',
        draft_updated_at INTEGER,
        -- Sequence number of the newest event in agent_events.
        last_seq INTEGER NOT NULL DEFAULT 0,
        last_activity_at INTEGER NOT NULL,
        last_user_message_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX agent_sessions_user ON agent_sessions(user_id, archived_at, last_activity_at);
      CREATE INDEX agent_sessions_project ON agent_sessions(project_id, user_id);
      CREATE INDEX agent_sessions_native ON agent_sessions(native_session_id) WHERE native_session_id IS NOT NULL;

      -- The append-only log of a session. (session_id, seq) orders the whole conversation.
      CREATE TABLE agent_events (
        session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        run_id TEXT,
        type TEXT NOT NULL,
        data TEXT NOT NULL,
        at INTEGER NOT NULL,
        PRIMARY KEY (session_id, seq)
      ) WITHOUT ROWID;

      -- Message text for full-text search. Trigram tokens make Chinese (and any other
      -- unsegmented script) searchable; queries shorter than three characters use LIKE.
      CREATE VIRTUAL TABLE agent_message_fts USING fts5(
        text,
        session_id UNINDEXED,
        seq UNINDEXED,
        role UNINDEXED,
        tokenize = 'trigram'
      );

      -- One execution of the agent for one user message.
      CREATE TABLE agent_runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        project_id TEXT,
        agent_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        origin TEXT NOT NULL CHECK (origin IN ('interactive', 'queued', 'continue', 'scheduled', 'automation')),
        unattended INTEGER NOT NULL DEFAULT 0,
        wait_for_approval INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL CHECK (status IN ('accepted', 'running', 'completed', 'failed', 'stopped', 'interrupted')),
        -- What the user asked, as typed.
        source_text TEXT NOT NULL,
        -- What is sent to the agent: {"text", "attachmentIds", "quote"}.
        prompt TEXT NOT NULL,
        model TEXT,
        effort TEXT,
        permission_mode TEXT NOT NULL,
        error_code TEXT,
        error_message TEXT,
        interrupted_by_restart INTEGER NOT NULL DEFAULT 0,
        continues_run_id TEXT,
        -- Set exactly once when a failed or interrupted run is continued: the claim.
        continued_by_run_id TEXT,
        dismissed_at INTEGER,
        seen_at INTEGER,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER
      );
      CREATE INDEX agent_runs_session ON agent_runs(session_id, created_at);
      CREATE INDEX agent_runs_user_status ON agent_runs(user_id, status);
      -- At most one run in progress per session, whatever the code does.
      CREATE UNIQUE INDEX agent_runs_one_active ON agent_runs(session_id) WHERE status IN ('accepted', 'running');

      -- The durable acknowledgement of a sent message, keyed by the client's request id.
      CREATE TABLE agent_receipts (
        user_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        -- Hash of target, content and options: the same id with different content is a conflict.
        request_hash TEXT NOT NULL,
        disposition TEXT NOT NULL CHECK (disposition IN ('run', 'queued', 'steered')),
        run_id TEXT,
        queue_item_id TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, request_id)
      );

      -- Messages waiting for the run in progress to end, in send order.
      CREATE TABLE agent_queue (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        text TEXT NOT NULL,
        attachment_ids TEXT NOT NULL DEFAULT '[]',
        quote TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX agent_queue_session ON agent_queue(session_id, position);

      -- A question put to a person: may this tool run, is this plan approved, what is the answer.
      CREATE TABLE agent_approvals (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        project_id TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('tool', 'plan', 'question')),
        tool_name TEXT,
        tool_kind TEXT,
        tool_call_id TEXT,
        title TEXT NOT NULL,
        -- {"command", "paths", "diff", "input", "plan", "questions", "suggestedRule"}
        detail TEXT NOT NULL,
        risk TEXT NOT NULL,
        risk_categories TEXT NOT NULL DEFAULT '[]',
        reason TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'allowed', 'denied', 'expired', 'cancelled')),
        decided_by TEXT,
        decided_at INTEGER,
        note TEXT,
        answers TEXT,
        expires_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX agent_approvals_status ON agent_approvals(status, user_id);
      CREATE INDEX agent_approvals_session ON agent_approvals(session_id, status);

      CREATE TABLE agent_permission_rules (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK (scope IN ('account', 'project', 'session')),
        -- Whose rule it is. Rules apply to their creator's runs, plus "shared" project rules to everyone's.
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        session_id TEXT REFERENCES agent_sessions(id) ON DELETE CASCADE,
        effect TEXT NOT NULL CHECK (effect IN ('allow', 'deny', 'ask')),
        tool TEXT NOT NULL,
        pattern TEXT,
        shared INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX agent_permission_rules_user ON agent_permission_rules(user_id, scope);
      CREATE INDEX agent_permission_rules_project ON agent_permission_rules(project_id);

      -- Files attached to messages. The bytes live in <data>/attachments/<session_id>/<stored_name>.
      CREATE TABLE agent_attachments (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        stored_name TEXT NOT NULL,
        media_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        -- Set when it goes out with a message (or into the queue).
        sent_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX agent_attachments_session ON agent_attachments(session_id);

      -- What each run used, one row per run and model. This is the table a usage
      -- report aggregates: it deliberately has no foreign keys, so the record of
      -- what was spent outlives a deleted session, project or account.
      --   input/output/cache tokens: totals of the run for that model
      --   cost_usd: null when the agent does not report cost
      --   context_tokens / context_window: how full the context was after the newest request
      --   at: when the row was last updated
      CREATE TABLE agent_usage (
        run_id TEXT NOT NULL,
        model TEXT NOT NULL,
        session_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        project_id TEXT,
        agent_id TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL,
        context_tokens INTEGER,
        context_window INTEGER,
        at INTEGER NOT NULL,
        PRIMARY KEY (run_id, model)
      );
      CREATE INDEX agent_usage_user_at ON agent_usage(user_id, at);
      CREATE INDEX agent_usage_session ON agent_usage(session_id, at);
    `,
  },
];
