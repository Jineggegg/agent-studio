import {
  AGENT_LIMITS,
  type Approval,
  type Attachment,
  type AttachmentRef,
  type FileDiff,
  type PermissionRule,
  type Question,
  type QuestionAnswer,
  type RiskCategory,
  type Run,
  type SessionEvent,
  type ToolKind,
} from '@agent-studio/protocol';
import type { ApprovalRow, AttachmentRow, EventRow, RuleRow, RunRow } from './store.js';

/** Row → wire shape, and the bounding of what goes into the log. Pure functions only. */

export const RASTER_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export const attachmentUrl = (sessionId: string, attachmentId: string): string => `/api/sessions/${sessionId}/attachments/${attachmentId}`;

export function presentAttachment(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    sessionId: row.session_id,
    name: row.name,
    mediaType: row.media_type,
    size: row.size,
    isImage: RASTER_IMAGE_TYPES.has(row.media_type),
    url: attachmentUrl(row.session_id, row.id),
    pending: row.sent_at === null,
    createdAt: row.created_at,
  };
}

export function attachmentRef(row: AttachmentRow): AttachmentRef {
  return {
    id: row.id,
    name: row.name,
    mediaType: row.media_type,
    size: row.size,
    isImage: RASTER_IMAGE_TYPES.has(row.media_type),
    url: attachmentUrl(row.session_id, row.id),
  };
}

export function presentRun(row: RunRow): Run {
  return {
    id: row.id,
    sessionId: row.session_id,
    projectId: row.project_id,
    userId: row.user_id,
    agentId: row.agent_id,
    requestId: row.request_id,
    origin: row.origin,
    unattended: row.unattended === 1,
    status: row.status,
    text: row.source_text,
    model: row.model,
    effort: row.effort,
    permissionMode: row.permission_mode,
    error: row.error_code === null ? null : { code: row.error_code, message: row.error_message ?? '' },
    interruptedByRestart: row.interrupted_by_restart === 1,
    continuesRunId: row.continues_run_id,
    continuedByRunId: row.continued_by_run_id,
    dismissedAt: row.dismissed_at,
    seenAt: row.seen_at,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export interface ApprovalDetail {
  command: string | null;
  paths: string[];
  diff: string | null;
  input: unknown;
  plan: string | null;
  questions: Question[] | null;
  suggestedRule: { tool: string; pattern: string | null } | null;
}

export function presentApproval(row: ApprovalRow): Approval {
  const detail = JSON.parse(row.detail) as ApprovalDetail;
  return {
    id: row.id,
    runId: row.run_id,
    sessionId: row.session_id,
    projectId: row.project_id,
    userId: row.user_id,
    kind: row.kind,
    toolName: row.tool_name,
    toolKind: row.tool_kind as ToolKind | null,
    toolCallId: row.tool_call_id,
    title: row.title,
    command: detail.command,
    paths: detail.paths,
    diff: detail.diff,
    input: detail.input,
    plan: detail.plan,
    questions: detail.questions,
    risk: row.risk,
    riskCategories: JSON.parse(row.risk_categories) as RiskCategory[],
    reason: row.reason,
    requiresOwner: row.risk === 'dangerous',
    suggestedRule: detail.suggestedRule,
    status: row.status,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    note: row.note,
    answers: row.answers === null ? null : (JSON.parse(row.answers) as QuestionAnswer[]),
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

export function presentRule(row: RuleRow): PermissionRule {
  return {
    id: row.id,
    scope: row.scope,
    projectId: row.project_id,
    sessionId: row.session_id,
    effect: row.effect,
    tool: row.tool,
    pattern: row.pattern,
    shared: row.shared === 1,
    createdBy: row.user_id,
    createdAt: row.created_at,
  };
}

export function presentEvent(row: EventRow): SessionEvent {
  return { seq: row.seq, type: row.type, data: JSON.parse(row.data) as unknown, at: row.at } as SessionEvent;
}

// ---- titles ----------------------------------------------------------------

export const DEFAULT_TITLE = 'New session';
const AUTO_TITLE_WORDS = 4;
const AUTO_TITLE_CHARS = 60;

/** A session's first name: the first few words of its first message. */
export function titleFromMessage(text: string): string | null {
  const words = text.trim().split(/\s+/u).filter(Boolean).slice(0, AUTO_TITLE_WORDS);
  if (words.length === 0) return null;
  const characters = [...words.join(' ')];
  return characters.length > AUTO_TITLE_CHARS ? `${characters.slice(0, AUTO_TITLE_CHARS - 1).join('')}…` : characters.join('');
}

/** Cleans up a title an agent proposed. Null when it is not usable as a name. */
export function cleanProposedTitle(raw: string): string | null {
  if (raw.length > 400) return null;
  let title = raw.replace(/\s+/gu, ' ').trim();
  // Decoration a model tends to add around a name.
  for (let pass = 0; pass < 3; pass += 1) {
    title = title.replace(/^[\s"'`*_#“”‘’「」『』《》〈〉([{]+/u, '').replace(/[\s"'`*_“”‘’「」『』《》〈〉)\]}.。,，;；:：!！?？]+$/u, '');
  }
  const length = [...title].length;
  if (length < 2 || length > 60) return null;
  if (!/[\p{L}\p{N}]/u.test(title)) return null;
  return title;
}

// ---- bounding --------------------------------------------------------------

/** Keeps the head and the tail of long output — the tail usually says how it ended. */
export function boundOutput(text: string, limit: number = AGENT_LIMITS.toolOutputChars): { output: string; omitted: number } {
  if (text.length <= limit) return { output: text, omitted: 0 };
  const head = Math.floor(limit / 4);
  const tail = limit - head;
  const omitted = text.length - limit;
  return { output: `${text.slice(0, head)}\n… ${omitted} characters omitted …\n${text.slice(text.length - tail)}`, omitted };
}

const STRING_FIELD_LIMIT = 4000;

function shorten(value: unknown, depth: number): unknown {
  if (typeof value === 'string') {
    return value.length > STRING_FIELD_LIMIT ? `${value.slice(0, STRING_FIELD_LIMIT)}… (${value.length - STRING_FIELD_LIMIT} more characters)` : value;
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 6) return '…';
  if (Array.isArray(value)) {
    const items = value.slice(0, 50).map((item) => shorten(item, depth + 1));
    if (value.length > 50) items.push(`… (${value.length - 50} more items)`);
    return items;
  }
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 100)) result[key] = shorten(item, depth + 1);
  return result;
}

/** A tool's input as it is stored: whole when small, otherwise with long strings cut, otherwise a preview. */
export function boundInput(input: unknown, limit: number = AGENT_LIMITS.toolInputChars): { input: unknown; truncated: boolean } {
  let encoded: string;
  try {
    encoded = JSON.stringify(input) ?? 'null';
  } catch {
    return { input: '[input could not be recorded]', truncated: true };
  }
  if (encoded.length <= limit) return { input: JSON.parse(encoded) as unknown, truncated: false };
  const shortened = shorten(JSON.parse(encoded) as unknown, 0);
  const reencoded = JSON.stringify(shortened);
  if (reencoded.length <= limit) return { input: shortened, truncated: true };
  return { input: { preview: `${encoded.slice(0, limit - 200)}…` }, truncated: true };
}

/** Keeps the counts of every diff and as much patch text as fits. */
export function boundDiffs(diffs: readonly FileDiff[], limit: number = AGENT_LIMITS.toolDiffChars): { diffs: FileDiff[]; truncated: boolean } {
  let budget = limit;
  let truncated = diffs.length > 200;
  const bounded: FileDiff[] = [];
  for (const diff of diffs.slice(0, 200)) {
    const entry: FileDiff = { path: String(diff.path).slice(0, 1024), added: Math.max(0, Math.trunc(diff.added) || 0), removed: Math.max(0, Math.trunc(diff.removed) || 0) };
    if (typeof diff.patch === 'string') {
      if (diff.patch.length <= budget) {
        entry.patch = diff.patch;
        budget -= diff.patch.length;
      } else {
        truncated = true;
      }
    }
    bounded.push(entry);
  }
  return { diffs: bounded, truncated };
}

export const clip = (text: string, limit: number): string => (text.length > limit ? `${text.slice(0, limit - 1)}…` : text);
