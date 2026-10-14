import type { ToolKind } from '@agent-studio/protocol';
import type { MessageKey } from '@/i18n';
import type { StackEntry, ToolEntry } from './model';

/**
 * How a tool call is named in a row, in the run status line and in an
 * approval: a verb from one small vocabulary, and the thing it acts on.
 * Agents name their tools differently; the kind and a few conventional
 * argument names are enough to say something a person can read.
 */
export interface ToolDescription {
  /** The translated verb for the kind, or null when the tool's own name stands in for it. */
  verb: MessageKey | null;
  /** The tool's own name, tidied, for kinds without a verb. */
  name: string;
  /** What it acts on: a path, a command line, a pattern, an address. May be empty. */
  target: string;
  /** Whether `target` is code-like text that should be drawn in the monospaced face. */
  mono: boolean;
}

const VERBS: Record<ToolKind, MessageKey | null> = {
  read: 'workbench.tool.verb.read',
  search: 'workbench.tool.verb.search',
  edit: 'workbench.tool.verb.edit',
  execute: 'workbench.tool.verb.execute',
  fetch: 'workbench.tool.verb.fetch',
  agent: 'workbench.tool.verb.agent',
  other: null,
};

const TARGET_FIELDS: Record<ToolKind, readonly string[]> = {
  read: ['file_path', 'path', 'notebook_path', 'file', 'filename'],
  edit: ['file_path', 'path', 'notebook_path', 'file', 'filename'],
  execute: ['command', 'cmd', 'script'],
  search: ['pattern', 'query', 'glob', 'regex'],
  fetch: ['url', 'query', 'uri'],
  agent: ['description', 'prompt', 'task'],
  other: [],
};

function firstLine(text: string, limit = 240): string {
  const line = text.split('\n').find((entry) => entry.trim() !== '') ?? '';
  const trimmed = line.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit - 1)}…` : trimmed;
}

function field(input: unknown, names: readonly string[]): string {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return '';
  const record = input as Record<string, unknown>;
  for (const name of names) {
    const value = record[name];
    if (typeof value === 'string' && value.trim() !== '') return firstLine(value);
  }
  return '';
}

/** "mcp__github__create_issue" → "create_issue · github"; anything else as it is. */
export function tidyToolName(name: string): string {
  const match = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
  return match ? `${match[2]} · ${match[1]}` : name;
}

export function describeTool(tool: Pick<ToolEntry, 'name' | 'kind' | 'title' | 'input'>): ToolDescription {
  const verb = VERBS[tool.kind];
  const name = tidyToolName(tool.name);
  let target = field(tool.input, TARGET_FIELDS[tool.kind]);
  if (tool.kind === 'search') {
    const where = field(tool.input, ['path', 'directory', 'cwd']);
    if (target !== '' && where !== '') target = `${target} — ${where}`;
  }
  if (target === '' && tool.kind === 'other') {
    // An unknown tool: its first plain argument says most about what it is doing.
    const input = tool.input;
    if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
      const value = Object.values(input as Record<string, unknown>).find((entry) => typeof entry === 'string' && entry.trim() !== '');
      if (typeof value === 'string') target = firstLine(value, 120);
    }
  }
  if (target === '') {
    // The adapter's own description, without repeating the verb or the tool's name in front of it.
    const title = firstLine(tool.title);
    target = title === tool.name || title === name ? '' : title;
  }
  return { verb, name: name === '' ? '' : name, target, mono: tool.kind !== 'agent' && tool.kind !== 'other' };
}

/** The file a read or an edit is about, as the agent named it — what "open file" opens. */
export function filePathOf(tool: Pick<ToolEntry, 'kind' | 'input'>): string | null {
  if (tool.kind !== 'read' && tool.kind !== 'edit') return null;
  const path = field(tool.input, TARGET_FIELDS[tool.kind]);
  return path === '' || path.endsWith('…') ? null : path;
}

/** Lines added and removed by an edit, across its files. */
export function changeCounts(tool: Pick<ToolEntry, 'diffs'>): { added: number; removed: number } | null {
  if (tool.diffs.length === 0) return null;
  return tool.diffs.reduce((total, diff) => ({ added: total.added + diff.added, removed: total.removed + diff.removed }), { added: 0, removed: 0 });
}

/** How many calls a sub-agent made (its own and those of agents it spawned in turn). */
export function countNestedTools(entries: readonly StackEntry[]): number {
  let count = 0;
  for (const entry of entries) if (entry.type === 'tool') count += 1 + countNestedTools(entry.children);
  return count;
}

export interface CollapsedStack<T> {
  head: T[];
  hidden: T[];
  tail: T[];
}

/** A long stack shows its first and last rows; the middle folds away behind "N more steps". */
export function collapseStack<T>(entries: readonly T[], options: { threshold?: number; head?: number; tail?: number } = {}): CollapsedStack<T> {
  const threshold = options.threshold ?? 6;
  const head = options.head ?? 2;
  const tail = options.tail ?? 3;
  if (entries.length <= threshold) return { head: [...entries], hidden: [], tail: [] };
  return { head: entries.slice(0, head), hidden: entries.slice(head, entries.length - tail), tail: entries.slice(entries.length - tail) };
}

/** The end of a long output, and how much came before it. */
export function tailOf(text: string, limit: number): { text: string; omitted: number } {
  if (text.length <= limit) return { text, omitted: 0 };
  const cut = text.length - limit;
  // Start at a line boundary when one is near, so the first line shown is whole.
  const newline = text.indexOf('\n', cut);
  const start = newline !== -1 && newline - cut < 400 ? newline + 1 : cut;
  return { text: text.slice(start), omitted: start };
}
