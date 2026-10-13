import { promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';
import { PROVIDER_NOTICE } from '@agent-studio/protocol';
import { z, type ZodType } from 'zod';
import { StudioError } from '../../../kernel/errors.js';
import { confine, isInside } from '../../../kernel/paths.js';
import type { ProcessSupervisor, Sandbox } from '../../../kernel/process.js';
import type { ApiAgentLimits } from '../limits.js';
import { MAX_COMMAND_CHARS, parseCommandLine, runsOtherCommands } from './command-line.js';
import { unifiedDiff } from './diff.js';
import { type ModelTool, type PermissionAsk, type PreparedCall, ToolRefusal, oneLine } from './tool.js';

/**
 * The tools an API model gets inside a project: reading, searching, changing
 * files and running commands in the project's working directory.
 *
 * **Files.** Every path a model names is resolved with the kernel's
 * `confine`: it must stay inside the project after symbolic links are
 * followed. On top of that two places are closed whatever the permission
 * engine says: Git's own files (a `.git` directory anywhere in the tree — a
 * hook or a config line written there would later run outside any sandbox)
 * and the Studio's data directory. A path is resolved when the call is
 * prepared — so that the permission engine is told the real target — and
 * again when it is carried out, since an approval can take a while. Directory
 * walks never follow links. Sizes are capped and binary files are described,
 * not dumped.
 *
 * **Commands.** A simple command is started directly as an argument array; a
 * line that needs a shell runs as `sh -c`. Either way it goes through the
 * kernel's process runner with the scrubbed environment, a timeout and
 * bounded output, wrapped in the sandbox's `confine` profile: the file
 * system is read-only except the project, credential folders and the
 * Studio's data are hidden, and there is no network unless the model asked
 * for it and that was allowed separately. Where the server has no sandbox the
 * command runs unconfined — the transcript says so — and a line that needs a
 * shell (or starts one) is put to a person every time: no mode and no saved
 * rule lets it through.
 */

export interface ProjectToolsOptions {
  /** The project's working directory, from the server's record of the project. */
  readonly root: string;
  readonly dataDir: string;
  /** Whether the session's user may change the project. Without it only the reading tools exist. */
  readonly write: boolean;
  readonly limits: ApiAgentLimits;
  readonly processes: ProcessSupervisor;
  readonly sandbox: Sandbox;
}

export const PROJECT_TOOL_NAMES = ['read_file', 'list_directory', 'find_files', 'search_text', 'write_file', 'edit_file', 'run_command'] as const;
/** The name the separate question about network access is asked under, so rules can tell it apart. */
export const NETWORK_TOOL_NAME = 'run_command_network';

const MAX_READ_LINES = 2_000;
const MAX_LIST_ENTRIES = 1_000;
const MAX_LINE_CHARS = 400;
const SEARCH_FILE_BYTES = 1024 * 1024;

const pathInput = z.string().min(1).max(4096);

function parse<T>(schema: ZodType<T>, args: unknown): T {
  const result = schema.safeParse(args ?? {});
  if (result.success) return result.data;
  const problems = result.error.issues.slice(0, 6).map((issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`);
  throw new ToolRefusal(`The arguments are not valid — ${problems.join('; ')}.`);
}

interface Located {
  /** The real absolute path: what the file system call uses and the permission engine is told. */
  readonly real: string;
  /** Relative to the project, forward slashes; "." for the project itself. */
  readonly relative: string;
}

const isGitSegment = (segment: string): boolean => segment.toLowerCase() === '.git';

async function locate(options: ProjectToolsOptions, requested: string | undefined): Promise<Located> {
  let wanted = requested === undefined || requested.trim() === '' ? '.' : requested;
  if (wanted.includes('\0')) throw new ToolRefusal('That path is not valid.');
  // A model that was told the working directory often writes absolute paths inside it.
  if (path.isAbsolute(wanted)) {
    const normalised = path.resolve(wanted);
    if (!isInside(options.root, normalised)) throw new ToolRefusal('That path is outside the project. Give paths relative to the working directory.');
    wanted = path.relative(options.root, normalised) || '.';
  }
  if (path.normalize(wanted).split(path.sep).some(isGitSegment)) {
    throw new ToolRefusal("Git's own files (.git) are off limits to the file tools. Use git commands through run_command instead.");
  }
  let real: string;
  let realRoot: string;
  try {
    real = await confine(options.root, wanted);
    realRoot = await fs.realpath(options.root);
  } catch (error) {
    if (error instanceof StudioError) throw new ToolRefusal(error.message);
    throw new ToolRefusal('That path cannot be used.');
  }
  const relative = path.relative(realRoot, real).split(path.sep).join('/') || '.';
  // Checked again on the real path: a link inside the project may point at .git.
  if (relative.split('/').some(isGitSegment)) {
    throw new ToolRefusal("Git's own files (.git) are off limits to the file tools. Use git commands through run_command instead.");
  }
  const dataDir = await fs.realpath(options.dataDir).catch(() => path.resolve(options.dataDir));
  if (isInside(dataDir, real)) throw new ToolRefusal("That path is inside the Studio's own data, which no tool may touch.");
  return { real, relative };
}

const looksBinary = (buffer: Buffer): boolean => buffer.subarray(0, 8192).includes(0);
const countLines = (text: string): number => (text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0));
const plural = (count: number, word: string, many = `${word}s`): string => `${count} ${count === 1 ? word : many}`;

/** `*` stays within a path segment, `**` crosses segments, `?` is one character. Everything else is literal. */
function globToRegExp(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i]!;
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        i += 1;
        if (pattern[i + 1] === '/') {
          i += 1;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (c === '?') {
      source += '[^/]';
    } else {
      source += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`, 'i');
}

const globInput = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => (value.match(/\*/g)?.length ?? 0) <= 8, 'Use fewer wildcards.');

interface WalkState {
  entries: number;
  /** The walk stopped early: too many entries, or out of time. */
  cut: boolean;
}

/** Every file below `base`, depth first, never through a link and never into `.git`. */
async function* walk(
  base: string,
  options: ProjectToolsOptions,
  signal: AbortSignal,
  state: WalkState,
  skipDependencies: boolean,
): AsyncGenerator<{ absolute: string; relative: string }> {
  const deadline = Date.now() + options.limits.maxWalkMs;
  const pending: Array<{ absolute: string; relative: string }> = [{ absolute: base, relative: '' }];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(directory.absolute, { withFileTypes: true });
    } catch {
      continue; // unreadable or gone: skip it
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const subdirectories: Array<{ absolute: string; relative: string }> = [];
    for (const entry of entries) {
      if (signal.aborted) return;
      state.entries += 1;
      if (state.entries > options.limits.maxWalkEntries || Date.now() > deadline) {
        state.cut = true;
        return;
      }
      if (entry.isSymbolicLink() || isGitSegment(entry.name)) continue;
      const relative = directory.relative === '' ? entry.name : `${directory.relative}/${entry.name}`;
      const absolute = path.join(directory.absolute, entry.name);
      if (entry.isDirectory()) {
        if (skipDependencies && entry.name === 'node_modules') continue;
        subdirectories.push({ absolute, relative });
      } else if (entry.isFile()) {
        yield { absolute, relative };
      }
    }
    // Reverse, so that popping visits them in name order.
    for (const subdirectory of subdirectories.reverse()) pending.push(subdirectory);
  }
}

const withinNodeModules = (relative: string): boolean => relative.split('/').includes('node_modules');
const join = (base: string, relative: string): string => (base === '.' ? relative : `${base}/${relative}`);

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const readFileInput = z.object({
  path: pathInput,
  offset: z.number().int().min(1).max(100_000_000).optional(),
  limit: z.number().int().min(1).max(MAX_READ_LINES).optional(),
});

function readFile(options: ProjectToolsOptions): ModelTool {
  return {
    kind: 'read',
    declaration: {
      name: 'read_file',
      description: `Reads a text file of the project. Returns up to ${MAX_READ_LINES} lines; use "offset" (first line, counting from 1) and "limit" to read a long file in parts.`,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path of the file, relative to the working directory.' },
          offset: { type: 'integer', minimum: 1, description: 'The first line to return. Default 1.' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_READ_LINES, description: `How many lines to return. Default ${MAX_READ_LINES}.` },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
    async prepare(args) {
      const input = parse(readFileInput, args);
      const target = await locate(options, input.path);
      const stat = await fs.stat(target.real).catch(() => null);
      if (!stat) throw new ToolRefusal(`There is no file "${target.relative}".`);
      if (stat.isDirectory()) throw new ToolRefusal(`"${target.relative}" is a directory. Use list_directory.`);
      if (!stat.isFile()) throw new ToolRefusal(`"${target.relative}" is not a regular file.`);
      if (stat.size > options.limits.maxFileBytes) {
        throw new ToolRefusal(`"${target.relative}" is ${stat.size} bytes, more than the ${options.limits.maxFileBytes} this tool reads. Use search_text, or run_command with head, tail or sed.`);
      }
      const title = `Read ${target.relative}`;
      return {
        kind: 'read',
        title,
        input,
        permissions: [{ toolName: 'read_file', kind: 'read', title, paths: [target.real] }],
        async run() {
          const buffer = await fs.readFile((await locate(options, target.relative)).real);
          if (looksBinary(buffer)) return { status: 'ok', text: `"${target.relative}" is a binary file (${buffer.length} bytes). Its content is not shown.` };
          const lines = buffer.toString('utf8').split('\n');
          if (lines[lines.length - 1] === '') lines.pop();
          const first = input.offset ?? 1;
          const shown = lines.slice(first - 1, first - 1 + (input.limit ?? MAX_READ_LINES));
          if (shown.length === 0) {
            return { status: 'ok', text: lines.length === 0 ? `"${target.relative}" is empty.` : `"${target.relative}" has only ${plural(lines.length, 'line')}.` };
          }
          const last = first + shown.length - 1;
          const more = last < lines.length ? ` Continue with offset ${last + 1}.` : '';
          return { status: 'ok', text: `${target.relative} — lines ${first}–${last} of ${lines.length}.${more}\n\n${shown.join('\n')}` };
        },
      };
    },
  };
}

const listDirectoryInput = z.object({ path: pathInput.optional() });

function listDirectory(options: ProjectToolsOptions): ModelTool {
  return {
    kind: 'read',
    declaration: {
      name: 'list_directory',
      description: 'Lists what is in a directory of the project: sub-directories end with "/", files show their size.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Directory, relative to the working directory. Default: the working directory itself.' } },
        additionalProperties: false,
      },
    },
    async prepare(args) {
      const input = parse(listDirectoryInput, args);
      const target = await locate(options, input.path);
      const stat = await fs.stat(target.real).catch(() => null);
      if (!stat) throw new ToolRefusal(`There is no directory "${target.relative}".`);
      if (!stat.isDirectory()) throw new ToolRefusal(`"${target.relative}" is a file. Use read_file.`);
      const title = target.relative === '.' ? 'List the working directory' : `List ${target.relative}`;
      return {
        kind: 'read',
        title,
        input,
        permissions: [{ toolName: 'list_directory', kind: 'read', title, paths: [target.real] }],
        async run() {
          const directory = (await locate(options, target.relative)).real;
          const entries = await fs.readdir(directory, { withFileTypes: true });
          entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
          const lines: string[] = [];
          for (const entry of entries.slice(0, MAX_LIST_ENTRIES)) {
            if (entry.isDirectory()) lines.push(`${entry.name}/`);
            else if (entry.isSymbolicLink()) lines.push(`${entry.name} (link)`);
            else {
              const size = await fs.lstat(path.join(directory, entry.name)).then((info) => info.size, () => null);
              lines.push(size === null ? entry.name : `${entry.name}  (${size} bytes)`);
            }
          }
          if (lines.length === 0) return { status: 'ok', text: `"${target.relative}" is empty.` };
          const more = entries.length > MAX_LIST_ENTRIES ? `\n… and ${entries.length - MAX_LIST_ENTRIES} more entries.` : '';
          return { status: 'ok', text: `${target.relative === '.' ? 'Working directory' : target.relative} — ${plural(entries.length, 'entry', 'entries')}:\n${lines.join('\n')}${more}` };
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Searching
// ---------------------------------------------------------------------------

const findFilesInput = z.object({
  pattern: globInput,
  path: pathInput.optional(),
  max_results: z.number().int().min(1).max(500).optional(),
});

function findFiles(options: ProjectToolsOptions): ModelTool {
  return {
    kind: 'search',
    declaration: {
      name: 'find_files',
      description:
        'Finds files of the project by name. "pattern" is a wildcard pattern: "*.ts" matches by file name anywhere, a pattern with "/" such as "src/**/*.test.ts" matches the path. Case is ignored. ".git" is never searched and "node_modules" only when "path" points into it.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Wildcard pattern: * within a name, ** across directories, ? one character.' },
          path: { type: 'string', description: 'Directory to search in, relative to the working directory. Default: all of it.' },
          max_results: { type: 'integer', minimum: 1, maximum: 500, description: 'Default 200.' },
        },
        required: ['pattern'],
        additionalProperties: false,
      },
    },
    async prepare(args) {
      const input = parse(findFilesInput, args);
      const target = await locate(options, input.path);
      const stat = await fs.stat(target.real).catch(() => null);
      if (!stat?.isDirectory()) throw new ToolRefusal(`There is no directory "${target.relative}".`);
      const title = `Find ${oneLine(input.pattern, 80)}${target.relative === '.' ? '' : ` in ${target.relative}`}`;
      return {
        kind: 'search',
        title,
        input,
        permissions: [{ toolName: 'find_files', kind: 'search', title, paths: [target.real] }],
        async run(io) {
          const matcher = globToRegExp(input.pattern);
          const byPath = input.pattern.includes('/');
          const limit = input.max_results ?? 200;
          const state: WalkState = { entries: 0, cut: false };
          const found: string[] = [];
          let more = false;
          const base = (await locate(options, target.relative)).real;
          for await (const file of walk(base, options, io.signal, state, !withinNodeModules(target.relative))) {
            const name = file.relative.slice(file.relative.lastIndexOf('/') + 1);
            if (!matcher.test(byPath ? file.relative : name)) continue;
            if (found.length >= limit) {
              more = true;
              break;
            }
            found.push(join(target.relative, file.relative));
          }
          const notes = [more ? `Only the first ${limit} are listed.` : '', state.cut ? 'The search stopped early: the tree is too large. Search a sub-directory.' : ''].filter(Boolean).join(' ');
          if (found.length === 0) return { status: 'ok', text: `No file matches "${input.pattern}".${notes ? ` ${notes}` : ''}` };
          return { status: 'ok', text: `${plural(found.length, 'file')} match "${input.pattern}".${notes ? ` ${notes}` : ''}\n${found.join('\n')}` };
        },
      };
    },
  };
}

const searchTextInput = z.object({
  query: z.string().min(1).max(500),
  path: pathInput.optional(),
  glob: globInput.optional(),
  case_sensitive: z.boolean().optional(),
  max_results: z.number().int().min(1).max(200).optional(),
});

function searchText(options: ProjectToolsOptions): ModelTool {
  return {
    kind: 'search',
    declaration: {
      name: 'search_text',
      description:
        'Searches the text files of the project for a piece of text (taken literally, not as a regular expression) and returns the matching lines with file and line number. For regular expressions use run_command with grep. ".git" is never searched, "node_modules" only when "path" points into it; binary and very large files are skipped.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The text to look for. One line.' },
          path: { type: 'string', description: 'File or directory to search, relative to the working directory. Default: all of it.' },
          glob: { type: 'string', description: 'Only search files whose name matches this wildcard pattern, e.g. "*.ts".' },
          case_sensitive: { type: 'boolean', description: 'Default false.' },
          max_results: { type: 'integer', minimum: 1, maximum: 200, description: 'Default 60.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
    async prepare(args) {
      const input = parse(searchTextInput, args);
      if (/[\r\n]/.test(input.query)) throw new ToolRefusal('The text to search for must be a single line.');
      const target = await locate(options, input.path);
      const stat = await fs.stat(target.real).catch(() => null);
      if (!stat) throw new ToolRefusal(`There is no "${target.relative}" to search.`);
      const title = `Search for "${oneLine(input.query, 60)}"${target.relative === '.' ? '' : ` in ${target.relative}`}`;
      return {
        kind: 'search',
        title,
        input,
        permissions: [{ toolName: 'search_text', kind: 'search', title, paths: [target.real] }],
        async run(io) {
          const limit = input.max_results ?? 60;
          const needle = input.case_sensitive ? input.query : input.query.toLowerCase();
          const nameFilter = input.glob === undefined ? null : globToRegExp(input.glob);
          const state: WalkState = { entries: 0, cut: false };
          const hits: string[] = [];
          const filesWithHits = new Set<string>();
          let more = false;
          let skipped = 0;

          const searchFile = async (absolute: string, shown: string): Promise<void> => {
            const info = await fs.stat(absolute).catch(() => null);
            if (!info?.isFile()) return;
            if (info.size > SEARCH_FILE_BYTES) {
              skipped += 1;
              return;
            }
            const buffer = await fs.readFile(absolute).catch(() => null);
            if (!buffer || looksBinary(buffer)) return;
            const lines = buffer.toString('utf8').split('\n');
            for (let index = 0; index < lines.length; index += 1) {
              const line = lines[index]!;
              if (!(input.case_sensitive ? line : line.toLowerCase()).includes(needle)) continue;
              if (hits.length >= limit) {
                more = true;
                return;
              }
              filesWithHits.add(shown);
              hits.push(`${shown}:${index + 1}: ${oneLine(line, MAX_LINE_CHARS)}`);
            }
          };

          const base = (await locate(options, target.relative)).real;
          if (stat.isFile()) {
            await searchFile(base, target.relative);
          } else {
            for await (const file of walk(base, options, io.signal, state, !withinNodeModules(target.relative))) {
              if (nameFilter && !nameFilter.test(file.relative.slice(file.relative.lastIndexOf('/') + 1))) continue;
              await searchFile(file.absolute, join(target.relative, file.relative));
              if (more) break;
            }
          }
          const notes = [
            more ? `Only the first ${limit} matches are listed.` : '',
            skipped > 0 ? `${plural(skipped, 'file')} larger than ${SEARCH_FILE_BYTES} bytes ${skipped === 1 ? 'was' : 'were'} not searched.` : '',
            state.cut ? 'The search stopped early: the tree is too large. Search a sub-directory.' : '',
          ]
            .filter(Boolean)
            .join(' ');
          if (hits.length === 0) return { status: 'ok', text: `Nothing matches "${input.query}".${notes ? ` ${notes}` : ''}` };
          return { status: 'ok', text: `${plural(hits.length, 'match', 'matches')} in ${plural(filesWithHits.size, 'file')}.${notes ? ` ${notes}` : ''}\n${hits.join('\n')}` };
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Changing files
// ---------------------------------------------------------------------------

/** The text of an existing file, null when there is none, or a refusal when it cannot be treated as text. */
async function currentText(options: ProjectToolsOptions, target: Located, purpose: 'replace' | 'edit'): Promise<string | null> {
  const stat = await fs.stat(target.real).catch(() => null);
  if (!stat) return null;
  if (stat.isDirectory()) throw new ToolRefusal(`"${target.relative}" is a directory.`);
  if (!stat.isFile()) throw new ToolRefusal(`"${target.relative}" is not a regular file.`);
  if (stat.size > options.limits.maxFileBytes) {
    throw new ToolRefusal(`"${target.relative}" is ${stat.size} bytes, more than the ${options.limits.maxFileBytes} this tool handles.`);
  }
  const buffer = await fs.readFile(target.real);
  if (looksBinary(buffer)) {
    throw new ToolRefusal(purpose === 'edit' ? `"${target.relative}" is a binary file and cannot be edited as text.` : `"${target.relative}" is a binary file; this tool does not overwrite it.`);
  }
  return buffer.toString('utf8');
}

const writeFileInput = z.object({ path: pathInput, content: z.string() });

function writeFile(options: ProjectToolsOptions): ModelTool {
  return {
    kind: 'edit',
    declaration: {
      name: 'write_file',
      description: 'Creates a file of the project, or replaces the whole content of an existing one. Missing directories are created. To change part of a file use edit_file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path of the file, relative to the working directory.' },
          content: { type: 'string', description: 'The complete new content of the file.' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
    async prepare(args) {
      const input = parse(writeFileInput, args);
      if (Buffer.byteLength(input.content) > options.limits.maxWriteBytes) {
        throw new ToolRefusal(`The content is larger than the ${options.limits.maxWriteBytes} bytes this tool writes.`);
      }
      const target = await locate(options, input.path);
      if (target.relative === '.') throw new ToolRefusal('Name a file, not the working directory.');
      const before = await currentText(options, target, 'replace');
      const diff = unifiedDiff(target.relative, before, input.content);
      const title = `${before === null ? 'Create' : 'Replace'} ${target.relative}`;
      return {
        kind: 'edit',
        title,
        input,
        permissions: [{ toolName: 'write_file', kind: 'edit', title, paths: [target.real], diff: diff.patch }],
        async run() {
          await fs.mkdir(path.dirname(target.real), { recursive: true });
          // Resolved again now that the directories exist: nothing on the way may have become a link out.
          const now = await locate(options, target.relative);
          const previous = await currentText(options, now, 'replace');
          if (previous === input.content) return { status: 'ok', text: `"${now.relative}" already has exactly this content; nothing was changed.` };
          await fs.writeFile(now.real, input.content, 'utf8');
          const made = unifiedDiff(now.relative, previous, input.content);
          const summary = previous === null ? `Created "${now.relative}" (${plural(countLines(input.content), 'line')}).` : `Replaced "${now.relative}" (+${made.added} −${made.removed} lines).`;
          return { status: 'ok', text: summary, diffs: [made] };
        },
      };
    },
  };
}

const editFileInput = z.object({
  path: pathInput,
  old_string: z.string().min(1),
  new_string: z.string(),
  replace_all: z.boolean().optional(),
});

const occurrences = (text: string, piece: string): number => text.split(piece).length - 1;

function applyEdit(text: string, input: z.infer<typeof editFileInput>, relative: string): string {
  const count = occurrences(text, input.old_string);
  if (count === 0) {
    const hint = text.includes('\r\n') && !input.old_string.includes('\r\n') && input.old_string.includes('\n') ? ' The file uses Windows line endings (CRLF).' : '';
    throw new ToolRefusal(`old_string was not found in "${relative}". It has to match the file exactly, including spaces and line breaks.${hint} Read the file again.`);
  }
  if (count > 1 && input.replace_all !== true) {
    throw new ToolRefusal(`old_string occurs ${count} times in "${relative}". Add surrounding lines so that it matches exactly one place, or set replace_all.`);
  }
  return input.replace_all === true ? text.split(input.old_string).join(input.new_string) : text.replace(input.old_string, () => input.new_string);
}

function editFile(options: ProjectToolsOptions): ModelTool {
  return {
    kind: 'edit',
    declaration: {
      name: 'edit_file',
      description:
        'Changes part of an existing text file: replaces "old_string" with "new_string". old_string must match the file exactly (spaces, indentation and line breaks included) and must occur exactly once, unless "replace_all" is true. Read the file first.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path of the file, relative to the working directory.' },
          old_string: { type: 'string', description: 'The exact text to replace.' },
          new_string: { type: 'string', description: 'What to put in its place. May be empty to delete the text.' },
          replace_all: { type: 'boolean', description: 'Replace every occurrence. Default false.' },
        },
        required: ['path', 'old_string', 'new_string'],
        additionalProperties: false,
      },
    },
    async prepare(args) {
      const input = parse(editFileInput, args);
      if (input.old_string === input.new_string) throw new ToolRefusal('old_string and new_string are the same: there is nothing to change.');
      const target = await locate(options, input.path);
      const before = await currentText(options, target, 'edit');
      if (before === null) throw new ToolRefusal(`There is no file "${target.relative}". Use write_file to create it.`);
      const after = applyEdit(before, input, target.relative);
      if (Buffer.byteLength(after) > options.limits.maxFileBytes) throw new ToolRefusal('The file would become larger than this tool handles.');
      const diff = unifiedDiff(target.relative, before, after);
      const title = `Edit ${target.relative}`;
      return {
        kind: 'edit',
        title,
        input,
        permissions: [{ toolName: 'edit_file', kind: 'edit', title, paths: [target.real], diff: diff.patch }],
        async run() {
          // The file may have changed while the request waited for approval: the edit is applied to what is there now.
          const now = await locate(options, target.relative);
          const current = await currentText(options, now, 'edit');
          if (current === null) throw new ToolRefusal(`"${now.relative}" no longer exists.`);
          const result = current === before ? after : applyEdit(current, input, now.relative);
          await fs.writeFile(now.real, result, 'utf8');
          const made = unifiedDiff(now.relative, current, result);
          return { status: 'ok', text: `Edited "${now.relative}" (+${made.added} −${made.removed} lines).`, diffs: [made] };
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function runCommand(options: ProjectToolsOptions): ModelTool {
  const { limits } = options;
  const maxSeconds = Math.max(1, Math.floor(limits.maxCommandTimeoutMs / 1000));
  const defaultSeconds = Math.max(1, Math.min(maxSeconds, Math.round(limits.commandTimeoutMs / 1000)));
  const input = z.object({
    command: z.string().min(1).max(MAX_COMMAND_CHARS),
    timeout_seconds: z.number().int().min(1).max(maxSeconds).optional(),
    network: z.boolean().optional(),
  });
  return {
    kind: 'execute',
    declaration: {
      name: 'run_command',
      description: [
        'Runs one command in the working directory and returns its exit code and output. Nothing is typed into it: commands that wait for input fail.',
        'It cannot change files outside the project and has no network access unless "network" is true — which is asked about separately, so request it only when the command needs it (installing packages, fetching).',
        `It is stopped after "timeout_seconds" (default ${defaultSeconds}, at most ${maxSeconds}). Do not start servers or other programs that never finish.`,
        'A plain command (a program and its arguments) is started directly. Pipes, &&, redirections, variables and wildcards work too; such a line is run by sh.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command line, e.g. "npm test" or "git status --short".' },
          timeout_seconds: { type: 'integer', minimum: 1, maximum: maxSeconds, description: `Seconds before the command is stopped. Default ${defaultSeconds}.` },
          network: { type: 'boolean', description: 'The command needs the network. Default false.' },
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
    async prepare(args) {
      const parsed = parse(input, args);
      const line = parseCommandLine(parsed.command);
      if (line.kind === 'invalid') throw new ToolRefusal(line.reason);
      const sandboxed = options.sandbox.status.mode === 'bwrap';
      const network = parsed.network === true;
      const viaShell = line.kind === 'shell';
      // Without a sandbox a shell line is unconfined and hard to judge: a person decides, every time.
      const humanOnly = !sandboxed && (viaShell || runsOtherCommands(line.argv));
      const shown = oneLine(parsed.command, 160);
      const permissions: PermissionAsk[] = [
        { toolName: 'run_command', kind: 'execute', title: `Run ${shown}`, command: parsed.command, ...(humanOnly ? { requireHuman: true } : {}) },
      ];
      if (network) permissions.push({ toolName: NETWORK_TOOL_NAME, kind: 'fetch', title: `Give network access to: ${shown}`, command: parsed.command });

      const call: PreparedCall = {
        kind: 'execute',
        title: `Run ${shown}`,
        input: parsed,
        permissions,
        async run(io) {
          if (!sandboxed) {
            io.notice(
              'warning',
              PROVIDER_NOTICE.sandboxUnavailable,
              `No sandbox is available on this server (${options.sandbox.status.reason ?? 'unknown reason'}): commands this agent runs are not confined to the project and can use the network.`,
            );
          }
          const [file, args] = viaShell ? ['sh', ['-c', parsed.command]] : [line.argv[0]!, line.argv.slice(1)];
          const wrapped = options.sandbox.wrap(file, args, { kind: 'confine', writable: [options.root], network });
          const seconds = parsed.timeout_seconds ?? defaultSeconds;
          const env = options.processes.env({
            TERM: 'dumb',
            NO_COLOR: '1',
            PAGER: 'cat',
            GIT_PAGER: 'cat',
            GIT_TERMINAL_PROMPT: '0',
            // The home directory is read-only in the sandbox: point caches at its private /tmp.
            ...(wrapped.sandboxed ? { XDG_CACHE_HOME: '/tmp/.cache', npm_config_cache: '/tmp/.npm' } : {}),
          });
          let result;
          try {
            result = await options.processes.run(wrapped.file, wrapped.args, {
              cwd: options.root,
              env,
              timeoutMs: seconds * 1000,
              maxOutputBytes: limits.commandOutputBytes,
              signal: io.signal,
            });
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'ENOENT') return { status: 'error', text: `There is no program "${oneLine(file, 80)}" on this server.` };
            if (code === 'EACCES') return { status: 'error', text: `"${oneLine(file, 80)}" cannot be executed.` };
            return { status: 'error', text: 'The command could not be started.' };
          }
          const ending = result.timedOut
            ? `The command was stopped after ${seconds} s (timeout).`
            : io.signal.aborted
              ? 'The command was stopped.'
              : result.signal
                ? `The command was ended by ${result.signal}.`
                : `Exit code ${result.code ?? 'unknown'}.`;
          const parts = [ending];
          if (result.stdout !== '') parts.push(`--- output ---\n${result.stdout.trimEnd()}`);
          if (result.stderr !== '') parts.push(`--- error output ---\n${result.stderr.trimEnd()}`);
          if (result.stdout === '' && result.stderr === '') parts.push('(no output)');
          if (result.truncated) parts.push(`(more output than ${limits.commandOutputBytes} bytes per stream was produced; the rest was dropped)`);
          const text = parts.join('\n');
          io.output(text);
          return { status: result.code === 0 && !result.timedOut ? 'ok' : 'error', text };
        },
      };
      return call;
    },
  };
}

/** The project tools for one run, reading tools first. */
export function projectTools(options: ProjectToolsOptions): ModelTool[] {
  const tools = [readFile(options), listDirectory(options), findFiles(options), searchText(options)];
  if (options.write) tools.push(writeFile(options), editFile(options), runCommand(options));
  return tools;
}
