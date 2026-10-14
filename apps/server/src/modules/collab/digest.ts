import { COLLAB_LIMITS, HANDOFF_NOTICE, type SessionEvent } from '@agent-studio/protocol';
import { redactSecrets } from '../../kernel/redact.js';
import { neutralise } from './framing.js';

/**
 * The digest of a conversation: what a new agent needs to know to continue
 * it, made by rule from the conversation's stored events. No model is
 * involved, and the same events always give the same text.
 *
 * What goes in, in this order:
 *
 * 1. a header — whose conversation, how many messages and runs;
 * 2. **what the user asked** — the user's own messages, most recent first;
 * 3. **what the agent concluded** — the last thing it said in each run, most recent first;
 * 4. **files changed** — paths only, from edits that were carried out;
 * 5. **commands run** — their titles only;
 * 6. **the to-do list** as it last stood;
 * 7. **left pending** — a last run that failed, was stopped or was interrupted, approvals
 *    that still wait, tool calls that never finished, a message that got no answer;
 * 8. **background from an earlier handoff**, when this conversation itself began with one.
 *
 * What never goes in: reasoning, the output of tools, the input of tools
 * (but for the path of an edit), what sub-agents said among themselves,
 * attachments, the agent's own conversation id.
 *
 * Every piece is passed through `redactSecrets` and {@link neutralise} before
 * anything else happens to it, and then cut to its budget — at the end of a
 * sentence or a line where there is one — with {@link CUT_MARKER} to show it.
 * Every section has a budget of its own and the whole has one; what does not
 * fit is counted and said ("3 earlier messages not shown"), never dropped in
 * silence.
 */

export interface ListBudget {
  /** Characters of the whole section. */
  readonly section: number;
  /** Entries shown at most. */
  readonly count: number;
  /** Characters of one entry. */
  readonly each: number;
}

export interface QuoteBudget extends ListBudget {
  /** Characters of the most recent entry, which matters most. */
  readonly latest: number;
}

export interface DigestBudgets {
  /** Characters of the whole digest. */
  readonly total: number;
  readonly asked: QuoteBudget;
  readonly concluded: QuoteBudget;
  readonly files: ListBudget;
  readonly commands: ListBudget;
  readonly todos: ListBudget;
  readonly pending: ListBudget;
  /** Characters carried over from the brief this conversation itself began with. */
  readonly earlier: number;
}

/** What a new agent is given. */
export const DIGEST_BUDGETS: DigestBudgets = {
  total: COLLAB_LIMITS.briefChars,
  asked: { section: 1900, latest: 1100, each: 450, count: 8 },
  concluded: { section: 2200, latest: 1400, each: 400, count: 6 },
  files: { section: 800, count: 30, each: 160 },
  commands: { section: 500, count: 10, each: 160 },
  todos: { section: 500, count: 20, each: 160 },
  pending: { section: 450, count: 8, each: 300 },
  earlier: 450,
};

/** What an agent that writes a summary is given to write it from: the same digest with more room. */
export const SUMMARY_INPUT_BUDGETS: DigestBudgets = {
  total: 24_000,
  asked: { section: 6000, latest: 3000, each: 1200, count: 20 },
  concluded: { section: 8000, latest: 4000, each: 1200, count: 12 },
  files: { section: 2400, count: 60, each: 200 },
  commands: { section: 1800, count: 30, each: 200 },
  todos: { section: 1500, count: 40, each: 200 },
  pending: { section: 1200, count: 12, each: 400 },
  earlier: 2400,
};

export const CUT_MARKER = ' […cut]';

/**
 * Shortens text to `max` characters, marker included. The cut falls after the
 * last sentence or at the last line break in the second half of what fits,
 * else at the last space there, else wherever it must — never inside a
 * surrogate pair.
 */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  // The first half of a character that takes two units is not a character.
  const whole = (part: string): string => (/[\ud800-\udbff]$/.test(part) ? part.slice(0, -1) : part);
  // No room for the marker: just what fits.
  if (max <= CUT_MARKER.length) return whole(text.slice(0, Math.max(0, max)));
  const room = max - CUT_MARKER.length;
  let head = whole(text.slice(0, room));
  const floor = Math.floor(room / 2);
  let boundary = -1;
  // A full stop counts when white space follows it; the full-width ones stand alone.
  for (const match of head.matchAll(/[.!?](?=\s|$)|[。！？]|\n/g)) {
    // After the full stop; at the line break.
    boundary = match[0] === '\n' ? match.index : match.index + match[0].length;
  }
  if (boundary >= floor) head = head.slice(0, boundary);
  else {
    const space = head.lastIndexOf(' ');
    if (space >= floor) head = head.slice(0, space);
  }
  return `${head.trimEnd()}${CUT_MARKER}`;
}

/** Text of the conversation made safe to pass on: credentials out, fences impossible. */
const safe = (text: string): string => neutralise(redactSecrets(text));

/** A message or an answer: kept in paragraphs, cut to its budget. */
function block(text: string, max: number): string {
  return cutText(safe(text).trim().replace(/\n{3,}/g, '\n\n'), max);
}

/** A name, a title, an item: one line, cut to its budget. */
function line(text: string, max: number): string {
  return cutText(safe(text).replace(/\s+/g, ' ').trim(), max);
}

/** A path: one line; when it is too long its end is kept, because that is where the file's name is. */
function pathLine(text: string, max: number): string {
  const whole = safe(text).replace(/\s+/g, ' ').trim();
  return whole.length <= max ? whole : `…${whole.slice(whole.length - (max - 1))}`;
}

/** Shown as a quotation, so that nothing inside it can pass for a heading or an item of the digest itself. */
const quote = (text: string): string =>
  text
    .split('\n')
    .map((row) => (row === '' ? '>' : `> ${row}`))
    .join('\n');

/** A message or an answer as a quotation of at most `max` characters, the quotation marks counted. */
function quoted(text: string, max: number): string {
  let room = max;
  for (let attempt = 0; attempt < 6 && room > CUT_MARKER.length + 2; attempt += 1) {
    const result = quote(block(text, room));
    if (result.length <= max) return result;
    // Many short lines: every one of them costs a mark of its own.
    room -= result.length - max;
  }
  return quote(line(text, Math.max(0, max - 2)));
}

const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

export interface DigestSource {
  readonly title: string;
  /** "Claude Code". */
  readonly agentName: string;
  readonly model: string | null;
  /** The log was longer than what was read: only its newest part is in the digest. */
  readonly truncated?: boolean;
}

export type DigestSectionId = 'asked' | 'concluded' | 'files' | 'commands' | 'todos' | 'pending' | 'earlier';

export interface DigestSection {
  readonly id: DigestSectionId;
  readonly title: string;
  /** The section's body, without its heading. */
  readonly text: string;
  readonly shown: number;
  /** Entries that exist and are not shown. */
  readonly omitted: number;
}

export interface Digest {
  readonly header: string;
  readonly sections: DigestSection[];
  /** Header and sections as one text, within the total budget. */
  readonly text: string;
  readonly userMessages: number;
  readonly runs: number;
}

interface RunFacts {
  answer: { text: string; partial: boolean } | null;
  finished: { status: string; errorMessage: string | null; interruptedByRestart: boolean } | null;
}

interface ToolFacts {
  readonly runId: string;
  readonly seq: number;
  readonly kind: string;
  readonly title: string;
  readonly input: unknown;
  status: 'ok' | 'error' | 'denied' | null;
}

const PATH_FIELDS = ['file_path', 'path', 'notebook_path', 'filePath'] as const;

/**
 * Entries, in the order given, as long as they fit the section — with room
 * kept for the line that says how many do not. The first entry is always
 * shown; the rest is counted.
 */
function fit(entries: readonly string[], budget: ListBudget, separator: string, note: (omitted: number) => string): { shown: string[]; omitted: number } {
  // The longest the closing line can get: when all but one entry are left out.
  const reserve = entries.length > 1 ? note(entries.length - 1).length + separator.length : 0;
  const shown: string[] = [];
  let used = 0;
  for (const entry of entries) {
    if (shown.length >= budget.count) break;
    const cost = entry.length + (shown.length === 0 ? 0 : separator.length);
    const last = shown.length === entries.length - 1;
    if (shown.length > 0 && used + cost + (last ? 0 : reserve) > budget.section) break;
    shown.push(entry);
    used += cost;
  }
  return { shown, omitted: entries.length - shown.length };
}

const SECTION_TITLES: Readonly<Record<DigestSectionId, string>> = {
  asked: 'What the user asked (most recent first)',
  concluded: 'What the agent concluded (most recent first)',
  files: 'Files changed',
  commands: 'Commands run',
  todos: 'To-do list',
  pending: 'Left pending',
  earlier: 'Background from an earlier handoff',
};

/** Builds the digest from a session's durable events, oldest first. */
export function buildDigest(events: readonly SessionEvent[], source: DigestSource, budgets: DigestBudgets = DIGEST_BUDGETS): Digest {
  const asked: string[] = [];
  const runs = new Map<string, RunFacts>();
  const tools = new Map<string, ToolFacts>();
  const files = new Map<string, { edits: number; seq: number }>();
  const approvals = new Map<string, { kind: string; title: string }>();
  let todos: Array<{ text: string; status: string }> | null = null;
  let earlier: string | null = null;
  let lastUserSeq = 0;
  let lastAnswerSeq = 0;
  /** The run the newest event belongs to. */
  const last: { runId: string | null } = { runId: null };

  const runOf = (runId: string): RunFacts => {
    let facts = runs.get(runId);
    if (!facts) runs.set(runId, (facts = { answer: null, finished: null }));
    last.runId = runId;
    return facts;
  };
  const touch = (path: unknown, seq: number): void => {
    if (typeof path !== 'string' || path.trim() === '') return;
    const known = files.get(path);
    files.set(path, { edits: (known?.edits ?? 0) + 1, seq });
  };

  for (const event of events) {
    switch (event.type) {
      case 'message.user':
        runOf(event.data.runId);
        // A continuation repeats the request it continues: once is enough.
        if (event.data.origin === 'continue') break;
        asked.push(event.data.text.trim() === '' && event.data.attachments.length > 0 ? '(no text; files were attached)' : event.data.text);
        lastUserSeq = event.seq;
        break;
      case 'run.started':
        runOf(event.data.runId);
        break;
      case 'message.assistant':
        // What a sub-agent said is its parent's working material, not a conclusion.
        if (event.data.parentToolCallId !== null || event.data.text.trim() === '') break;
        runOf(event.data.runId).answer = { text: event.data.text, partial: event.data.partial };
        lastAnswerSeq = event.seq;
        break;
      case 'tool.started':
        tools.set(`${event.data.runId}\n${event.data.toolCallId}`, {
          runId: event.data.runId,
          seq: event.seq,
          kind: event.data.kind,
          title: event.data.title,
          input: event.data.input,
          status: null,
        });
        break;
      case 'tool.finished': {
        const tool = tools.get(`${event.data.runId}\n${event.data.toolCallId}`);
        if (tool) tool.status = event.data.status;
        if (event.data.status !== 'ok') break;
        // The paths of a change that was carried out: from its diffs, else from the edit's own input.
        if (event.data.diffs.length > 0) {
          for (const diff of event.data.diffs) touch(diff.path, event.seq);
        } else if (tool?.kind === 'edit' && typeof tool.input === 'object' && tool.input !== null) {
          const input = tool.input as Record<string, unknown>;
          touch(PATH_FIELDS.map((field) => input[field]).find((value) => typeof value === 'string'), event.seq);
        }
        break;
      }
      case 'todos.updated':
        todos = event.data.items;
        break;
      case 'notice':
        if (event.data.code === HANDOFF_NOTICE.received && earlier === null) earlier = event.data.text;
        break;
      case 'approval.requested':
        approvals.set(event.data.approval.id, { kind: event.data.approval.kind, title: event.data.approval.title });
        break;
      case 'approval.resolved':
        approvals.delete(event.data.approvalId);
        break;
      case 'run.finished':
        runOf(event.data.runId).finished = { status: event.data.status, errorMessage: event.data.error?.message ?? null, interruptedByRestart: event.data.interruptedByRestart };
        break;
      default:
      // Reasoning, usage and everything else stay where they are.
    }
  }

  const sections: DigestSection[] = [];
  const add = (id: DigestSectionId, body: string, shown: number, omitted: number): void => {
    // Entries are chosen to fit; the cut here is what makes the section's budget hold whatever they contain.
    const budget = id === 'earlier' ? budgets.earlier : budgets[id].section;
    sections.push({ id, title: SECTION_TITLES[id], text: cutText(body, budget), shown, omitted });
  };

  // ---- what the user asked ---------------------------------------------------
  if (asked.length > 0) {
    const entries = asked
      .map((text, index) => ({ text, number: index + 1 }))
      .reverse()
      .map((entry, position) => {
        const latest = position === 0;
        return `Message ${entry.number} of ${asked.length}${latest ? ' (the latest)' : ''}:\n${quoted(entry.text, latest ? budgets.asked.latest : budgets.asked.each)}`;
      });
    const note = (omitted: number): string => `(${plural(omitted, 'earlier message')} not shown)`;
    const { shown, omitted } = fit(entries, budgets.asked, '\n\n', note);
    add('asked', [...shown, ...(omitted > 0 ? [note(omitted)] : [])].join('\n\n'), shown.length, omitted);
  }

  // ---- what the agent concluded ------------------------------------------------
  const answers = [...runs.values()].filter((run) => run.answer !== null).map((run) => run.answer!);
  if (answers.length > 0) {
    const entries = answers
      .map((answer, index) => ({ answer, number: index + 1 }))
      .reverse()
      .map((entry, position) => {
        const latest = position === 0;
        const label = `Answer ${entry.number} of ${answers.length}${latest ? ' (the latest)' : ''}${entry.answer.partial ? ', cut short when its run ended' : ''}:`;
        return `${label}\n${quoted(entry.answer.text, latest ? budgets.concluded.latest : budgets.concluded.each)}`;
      });
    const note = (omitted: number): string => `(${plural(omitted, 'earlier answer')} not shown)`;
    const { shown, omitted } = fit(entries, budgets.concluded, '\n\n', note);
    add('concluded', [...shown, ...(omitted > 0 ? [note(omitted)] : [])].join('\n\n'), shown.length, omitted);
  }

  // ---- files changed -----------------------------------------------------------
  if (files.size > 0) {
    const entries = [...files.entries()]
      .sort((a, b) => b[1].seq - a[1].seq)
      .map(([path, facts]) => `- ${pathLine(path, budgets.files.each)}${facts.edits > 1 ? ` (${facts.edits} edits)` : ''}`);
    const note = (omitted: number): string => `(${plural(omitted, 'more file')} not shown)`;
    const { shown, omitted } = fit(entries, budgets.files, '\n', note);
    add('files', [...shown, ...(omitted > 0 ? [note(omitted)] : [])].join('\n'), shown.length, omitted);
  }

  // ---- commands run --------------------------------------------------------------
  const lastRunId = last.runId;
  const lastRun: RunFacts | null = lastRunId === null ? null : (runs.get(lastRunId) ?? null);
  const commands = [...tools.values()].filter((tool) => tool.kind === 'execute' && tool.status !== 'denied');
  if (commands.length > 0) {
    const entries = commands
      .sort((a, b) => b.seq - a.seq)
      .map((tool) => `- ${line(tool.title, budgets.commands.each)}${tool.status === 'error' ? ' (failed)' : tool.status === null ? ' (did not finish)' : ''}`);
    const note = (omitted: number): string => `(${plural(omitted, 'earlier command')} not shown)`;
    const { shown, omitted } = fit(entries, budgets.commands, '\n', note);
    // The newest that fit, in the order they ran.
    add('commands', [...shown.reverse(), ...(omitted > 0 ? [note(omitted)] : [])].join('\n'), shown.length, omitted);
  }

  // ---- the to-do list ------------------------------------------------------------
  const items: Array<{ text: string; status: string }> = todos ?? [];
  if (items.length > 0) {
    const entries = items.map((item) => `- ${item.status === 'completed' ? '[x]' : '[ ]'} ${line(item.text, budgets.todos.each)}${item.status === 'in_progress' ? ' (in progress)' : ''}`);
    const note = (omitted: number): string => `(${plural(omitted, 'more item')} not shown)`;
    const { shown, omitted } = fit(entries, budgets.todos, '\n', note);
    add('todos', [...shown, ...(omitted > 0 ? [note(omitted)] : [])].join('\n'), shown.length, omitted);
  }

  // ---- left pending --------------------------------------------------------------
  const pending: string[] = [];
  if (lastRun !== null) {
    if (lastRun.finished === null) pending.push('The last run had not finished when this was written.');
    else if (lastRun.finished.status === 'failed') pending.push(`The last run failed: ${lastRun.finished.errorMessage ?? 'no reason was given.'}`);
    else if (lastRun.finished.status === 'interrupted') pending.push('The last run was interrupted before it finished (the server restarted). Part of its work may have been done.');
    else if (lastRun.finished.status === 'stopped') pending.push('The last run was stopped before it finished.');
  }
  for (const approval of approvals.values()) {
    pending.push(approval.kind === 'plan' ? 'A plan waits for approval.' : approval.kind === 'question' ? `A question waits for an answer: ${approval.title}` : `Waits for approval: ${approval.title}`);
  }
  for (const tool of tools.values()) {
    if (tool.status === null && tool.runId === lastRunId && tool.kind !== 'execute') pending.push(`Did not finish: ${tool.title}`);
  }
  if (lastUserSeq > lastAnswerSeq && lastRun?.finished?.status === 'completed') pending.push("The user's latest message got no answer in words.");
  if (pending.length > 0) {
    const entries = pending.map((entry) => `- ${line(entry, budgets.pending.each)}`);
    const note = (omitted: number): string => `(${plural(omitted, 'more item')} not shown)`;
    const { shown, omitted } = fit(entries, budgets.pending, '\n', note);
    add('pending', [...shown, ...(omitted > 0 ? [note(omitted)] : [])].join('\n'), shown.length, omitted);
  }

  // ---- what this conversation itself was handed ---------------------------------
  if (earlier !== null && earlier.trim() !== '') {
    add('earlier', quoted(earlier, budgets.earlier), 1, 0);
  }

  const model = source.model === null ? '' : ` (${line(source.model, 80)})`;
  const counts = asked.length === 0 && runs.size === 0 ? 'nothing has been said in it yet' : `${plural(asked.length, 'message')} from the user, ${plural(runs.size, 'run')}`;
  const header = `Conversation "${line(source.title, 120)}" with ${line(source.agentName, 80)}${model}: ${counts}.${source.truncated ? ' It is long: only its most recent part was read.' : ''}`;
  return { header, sections, text: renderDigest(header, sections, budgets.total), userMessages: asked.length, runs: runs.size };
}

/** Header and sections as one text, within a budget. */
export function renderDigest(header: string, sections: readonly DigestSection[], total: number): string {
  return cutText([header, ...sections.map((section) => `## ${section.title}\n${section.text}`)].join('\n\n'), total);
}

/**
 * The brief when an agent wrote a summary: the summary in place of the two
 * sections it retells, and the facts — files, commands, to-dos, what is
 * pending — as the digest has them.
 */
export function renderSummaryBrief(digest: Digest, summary: string, writer: string, total: number = DIGEST_BUDGETS.total): string {
  const facts = digest.sections.filter((section) => section.id !== 'asked' && section.id !== 'concluded');
  const summarySection: DigestSection = {
    id: 'concluded',
    title: `Summary (written by ${line(writer, 120)} from the record of the conversation)`,
    // What a model wrote is treated like anything else from a conversation: credentials out, fences impossible, bounded.
    text: quoted(summary, COLLAB_LIMITS.summaryChars),
    shown: 1,
    omitted: 0,
  };
  return renderDigest(digest.header, [summarySection, ...facts], total);
}
