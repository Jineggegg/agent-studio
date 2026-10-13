import path from 'node:path';
import type { FileDiff, ToolKind } from '@agent-studio/protocol';

/**
 * What the Studio needs to know about one of Claude Code's own tools: what
 * kind of thing it does, how to name the call in a sentence, and which
 * command, files or address it touches — the inputs of the permission engine.
 *
 * The names and input fields are the CLI's (observed with Claude Code 2.1,
 * see `docs/guides/agent-smoke-test.md`). A tool this file does not know is
 * reported as `other`, which the permission engine always asks about.
 */

export interface ToolDescription {
  readonly kind: ToolKind;
  /** A short human sentence: "Run npm test", "Edit src/app.ts". */
  readonly title: string;
  readonly command?: string;
  readonly paths?: readonly string[];
  readonly url?: string;
  /** A preview of the change an edit tool would make. */
  readonly diff?: string;
}

/** The tool that puts questions to the user. */
export const ASK_USER_TOOL = 'AskUserQuestion';
/** The tool that presents a plan and asks to leave plan mode. */
export const EXIT_PLAN_TOOL = 'ExitPlanMode';
/** Tools that start a sub-agent (the name changed between CLI versions). */
export const SUB_AGENT_TOOLS: ReadonlySet<string> = new Set(['Task', 'Agent']);

const TITLE_CHARS = 200;
const PREVIEW_CHARS = 20_000;
const PATCH_CHARS = 200_000;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** The first line of a possibly long text, shortened for a title. */
function headline(value: string): string {
  const first = value.trim().split('\n', 1)[0] ?? '';
  return clip(first.trim(), TITLE_CHARS);
}

/** A path as a person would read it: relative to the project when it is inside it. */
export function shownPath(file: string, cwd: string | null): string {
  if (cwd === null || !path.isAbsolute(file)) return file;
  const relative = path.relative(cwd, file);
  if (relative === '') return '.';
  return relative.startsWith('..') || path.isAbsolute(relative) ? file : relative;
}

function splitLines(value: string): string[] {
  if (value === '') return [];
  const lines = value.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** A path for the header of a patch: an absolute one loses its leading slash, as in `git diff`. */
const inHeader = (shown: string): string => shown.replace(/^\/+/, '');

function previewOf(file: string, cwd: string | null, removed: readonly string[], added: readonly string[]): string {
  const shown = inHeader(shownPath(file, cwd));
  const body = [...removed.map((line) => `-${line}`), ...added.map((line) => `+${line}`)].join('\n');
  return clip(`--- a/${shown}\n+++ b/${shown}\n@@\n${body}`, PREVIEW_CHARS);
}

function editPreview(name: string, input: Record<string, unknown>, cwd: string | null): string | undefined {
  const file = text(input.file_path) ?? text(input.notebook_path);
  if (!file) return undefined;
  if (name === 'Write') return typeof input.content === 'string' ? previewOf(file, cwd, [], splitLines(input.content)) : undefined;
  if (name === 'NotebookEdit') return typeof input.new_source === 'string' ? previewOf(file, cwd, [], splitLines(input.new_source)) : undefined;
  if (name === 'Edit') {
    if (typeof input.old_string !== 'string' || typeof input.new_string !== 'string') return undefined;
    return previewOf(file, cwd, splitLines(input.old_string), splitLines(input.new_string));
  }
  if (name === 'MultiEdit' && Array.isArray(input.edits)) {
    const removed: string[] = [];
    const added: string[] = [];
    for (const edit of input.edits) {
      if (!isRecord(edit)) continue;
      if (typeof edit.old_string === 'string') removed.push(...splitLines(edit.old_string));
      if (typeof edit.new_string === 'string') added.push(...splitLines(edit.new_string));
    }
    return previewOf(file, cwd, removed, added);
  }
  return undefined;
}

/** `mcp__server__tool` → its two halves; null for a built-in tool. */
export function parseMcpToolName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith('mcp__')) return null;
  const rest = name.slice('mcp__'.length);
  const at = rest.indexOf('__');
  if (at <= 0 || at + 2 >= rest.length) return null;
  return { server: rest.slice(0, at), tool: rest.slice(at + 2) };
}

export function describeTool(name: string, rawInput: unknown, cwd: string | null): ToolDescription {
  const input = isRecord(rawInput) ? rawInput : {};
  const file = text(input.file_path) ?? text(input.notebook_path);
  const shown = file ? shownPath(file, cwd) : null;
  const filePaths = file ? { paths: [file] } : {};

  switch (name) {
    case 'Read':
    case 'NotebookRead':
      return { kind: 'read', title: shown ? `Read ${shown}` : 'Read a file', ...filePaths };
    case 'LS': {
      const directory = text(input.path);
      return { kind: 'read', title: directory ? `List ${shownPath(directory, cwd)}` : 'List a folder', ...(directory ? { paths: [directory] } : {}) };
    }
    case 'Glob':
    case 'Grep': {
      const pattern = text(input.pattern);
      const where = text(input.path) ?? cwd ?? undefined;
      const title = name === 'Glob' ? `Find files matching ${pattern ?? 'a pattern'}` : `Search for ${pattern ? JSON.stringify(clip(pattern, 120)) : 'text'}`;
      return { kind: 'search', title: clip(title, TITLE_CHARS), ...(where ? { paths: [where] } : {}) };
    }
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': {
      const diff = editPreview(name, input, cwd);
      return { kind: 'edit', title: shown ? `Edit ${shown}` : 'Edit a file', ...filePaths, ...(diff ? { diff } : {}) };
    }
    case 'Write': {
      const diff = editPreview(name, input, cwd);
      return { kind: 'edit', title: shown ? `Write ${shown}` : 'Write a file', ...filePaths, ...(diff ? { diff } : {}) };
    }
    case 'Bash':
    case 'PowerShell': {
      const command = text(input.command);
      return { kind: 'execute', title: command ? `Run ${headline(command)}` : 'Run a command', ...(command ? { command } : {}) };
    }
    case 'WebFetch': {
      const url = text(input.url);
      return { kind: 'fetch', title: url ? `Fetch ${clip(url, TITLE_CHARS)}` : 'Fetch a web page', ...(url ? { url } : {}) };
    }
    case 'WebSearch': {
      const query = text(input.query);
      return { kind: 'fetch', title: query ? `Search the web for ${JSON.stringify(clip(query, 120))}` : 'Search the web' };
    }
    case 'Task':
    case 'Agent': {
      const description = text(input.description);
      return { kind: 'agent', title: description ? `Sub-agent: ${headline(description)}` : 'Start a sub-agent' };
    }
    case 'TodoWrite':
      return { kind: 'other', title: 'Update the to-do list' };
    case 'TaskCreate': {
      const subject = text(input.subject);
      return { kind: 'other', title: subject ? `Add to-do: ${headline(subject)}` : 'Add a to-do' };
    }
    case 'TaskUpdate': {
      const id = text(input.taskId);
      const status = text(input.status);
      return { kind: 'other', title: `Update to-do${id ? ` #${clip(id, 20)}` : ''}${status ? ` → ${status.replace('_', ' ')}` : ''}` };
    }
    case 'TaskList':
    case 'TaskGet':
      return { kind: 'other', title: 'Look at the to-do list' };
    case ASK_USER_TOOL: {
      const first = Array.isArray(input.questions) && isRecord(input.questions[0]) ? text(input.questions[0].question) : undefined;
      return { kind: 'other', title: first ? `Ask: ${headline(first)}` : 'Ask a question' };
    }
    case EXIT_PLAN_TOOL:
      return { kind: 'other', title: 'Present the plan' };
    case 'EnterPlanMode':
      return { kind: 'other', title: 'Switch to planning' };
    case 'Skill': {
      const skill = text(input.skill) ?? text(input.command);
      return { kind: 'other', title: skill ? `Use the skill ${headline(skill)}` : 'Use a skill' };
    }
    case 'ToolSearch': {
      const query = text(input.query);
      return { kind: 'other', title: query ? `Look up tools: ${headline(query)}` : 'Look up tools' };
    }
    default: {
      const mcp = parseMcpToolName(name);
      if (mcp) return { kind: 'other', title: clip(`${mcp.tool.replace(/_/g, ' ')} (${mcp.server})`, TITLE_CHARS) };
      // A tool this version of the Studio has not met: by convention a `command` is something that runs.
      const command = text(input.command);
      if (command) return { kind: 'execute', title: clip(`${name}: ${headline(command)}`, TITLE_CHARS), command };
      return { kind: 'other', title: clip(name, TITLE_CHARS), ...filePaths };
    }
  }
}

/** The text of a tool result, whose content is a string or a list of content blocks. */
export function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') parts.push(block);
    else if (!isRecord(block)) continue;
    else if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'image') parts.push('[image]');
    else if (block.type === 'tool_reference' && typeof block.tool_name === 'string') parts.push(`[tool: ${block.tool_name}]`);
    else if (typeof block.type === 'string') parts.push(`[${block.type}]`);
  }
  return parts.join('\n');
}

interface Hunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: readonly string[];
}

function readHunks(value: unknown): Hunk[] {
  if (!Array.isArray(value)) return [];
  const hunks: Hunk[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || !Array.isArray(entry.lines)) continue;
    const numbers = [entry.oldStart, entry.oldLines, entry.newStart, entry.newLines];
    if (!numbers.every((number) => typeof number === 'number' && Number.isInteger(number) && number >= 0)) continue;
    hunks.push({
      oldStart: entry.oldStart as number,
      oldLines: entry.oldLines as number,
      newStart: entry.newStart as number,
      newLines: entry.newLines as number,
      lines: entry.lines.filter((line): line is string => typeof line === 'string'),
    });
  }
  return hunks;
}

/**
 * The file changes an edit tool reports with its result. The CLI attaches a
 * structured patch to results of its main thread; where there is none (a
 * sub-agent's result, an unknown tool) nothing is invented.
 */
export function diffsFromResult(structured: unknown, cwd: string | null): FileDiff[] {
  if (!isRecord(structured)) return [];
  const file = text(structured.filePath) ?? text(structured.file_path);
  if (!file) return [];
  const shown = shownPath(file, cwd);
  const hunks = readHunks(structured.structuredPatch);

  if (hunks.length > 0) {
    let added = 0;
    let removed = 0;
    const body: string[] = [];
    for (const hunk of hunks) {
      body.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
      for (const line of hunk.lines) {
        if (line.startsWith('+')) added += 1;
        else if (line.startsWith('-')) removed += 1;
        body.push(line);
      }
    }
    const patch = `--- a/${inHeader(shown)}\n+++ b/${inHeader(shown)}\n${body.join('\n')}\n`;
    return [{ path: shown, added, removed, ...(patch.length <= PATCH_CHARS ? { patch } : {}) }];
  }

  // A file that did not exist before: the whole content is new.
  if (structured.type === 'create' && typeof structured.content === 'string') {
    const lines = splitLines(structured.content);
    if (lines.length === 0) return [{ path: shown, added: 0, removed: 0 }];
    const patch = `--- /dev/null\n+++ b/${inHeader(shown)}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join('\n')}\n`;
    return [{ path: shown, added: lines.length, removed: 0, ...(patch.length <= PATCH_CHARS ? { patch } : {}) }];
  }
  return [];
}
