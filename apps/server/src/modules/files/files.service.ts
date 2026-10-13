import { constants as fsConstants, promises as fs, type BigIntStats, type Stats } from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  FILE_LIMITS,
  type FileContent,
  type FileContentSearch,
  type FileEntry,
  type FileLimits,
  type FileListing,
  type FileNameMatch,
  type FileNameSearch,
  type FileTree,
  type FileTreeNode,
  type SavedFile,
  type SaveFileRequest,
  type UploadResult,
} from '@agent-studio/protocol';
import { randomToken, sha256 } from '../../kernel/crypto.js';
import { StudioError, badRequest, conflict, forbidden, isStudioError, notFound, payloadTooLarge } from '../../kernel/errors.js';
import type { ModuleContext, Services } from '../../kernel/module.js';
import { isInside, toRelative } from '../../kernel/paths.js';
import { DOWNLOAD_CSP, PREVIEW_CSP, SNIFF_BYTES, contentDisposition, hasPreviewableExtension, isUtf8, looksBinary, previewType } from './media.js';
import { assertEntryName, nameProblem, projectRoot, refuseGitInternal, refuseProjectRoot, resolveEntry, resolveTarget, type ResolvedPath } from './project-paths.js';
import { zipStream, type ZipEntry } from './zip.js';

/** Never listed, whatever the ignore rules say: repository metadata and installed dependencies. */
const ALWAYS_HIDDEN = new Set(['.git', '.hg', '.svn', 'node_modules']);

/** Hidden like ignored files when the folder has no repository to say what is ignored. */
const CONVENTIONALLY_IGNORED = new Set([
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '.next',
  '.nuxt',
  '.output',
  '.cache',
  '.turbo',
  '.parcel-cache',
  '.gradle',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  '.DS_Store',
]);

const MAX_WALK_DEPTH = 64;
const UPLOAD_TEMP_PREFIX = '.studio-upload-';

type Kind = FileEntry['kind'];

interface WalkResult {
  readonly nodes: FileTreeNode[];
  readonly count: number;
  readonly truncatedBy: 'entries' | 'depth' | null;
}

interface RawFile {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly stream: Readable;
}

/** A file part of an upload, as the route hands it over. */
export interface UploadPart {
  /** The path the client declared for it (relative, forward slashes) or its bare file name. */
  readonly name: string;
  readonly stream: Readable & { truncated?: boolean };
}

const versionOf = (stat: BigIntStats): string => sha256(`${stat.mtimeNs}:${stat.size}`).slice(0, 32);

/** Translates a file-system failure into an answer a client can act on. */
function fsFailure(error: unknown): unknown {
  if (isStudioError(error)) return error;
  switch ((error as NodeJS.ErrnoException).code) {
    case 'ENOENT':
      return notFound('That file or folder does not exist.', 'file_not_found');
    case 'ENOTDIR':
      return badRequest('Part of that path is a file, not a folder.', undefined, 'not_a_directory');
    case 'EISDIR':
      return badRequest('That path is a folder, not a file.', undefined, 'is_directory');
    case 'EACCES':
    case 'EPERM':
    case 'EROFS':
      return forbidden('The server is not permitted to do that to this file or folder.', 'permission_denied');
    case 'ENOTEMPTY':
    case 'EEXIST':
      return conflict('That folder is not empty.', 'directory_not_empty');
    case 'ENAMETOOLONG':
      return badRequest('That name is too long.', undefined, 'invalid_name');
    case 'ENOSPC':
    case 'EDQUOT':
      return new StudioError(507, 'storage_full', 'The server has no space left for that.');
    case 'EXDEV':
      return badRequest('That would move the item to a different disk, which is not supported here.', undefined, 'cross_device');
    default:
      return error;
  }
}

function lineEndingOf(text: string): 'lf' | 'crlf' | 'mixed' | 'none' {
  let crlf = 0;
  let lf = 0;
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) {
    if (index > 0 && text.charCodeAt(index - 1) === 13) crlf += 1;
    else lf += 1;
  }
  if (crlf === 0 && lf === 0) return 'none';
  if (crlf === 0) return 'lf';
  return lf === 0 ? 'crlf' : 'mixed';
}

const byName = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0);

/**
 * Reading and changing the files of a project.
 *
 * Every path arrives project-relative and goes through the confinement
 * helpers before the file system is touched: content is only ever read or
 * written at a place whose real location is inside the project, entries are
 * renamed and deleted as themselves (a link is never followed), and the
 * project folder itself and the repository's `.git` are off limits.
 */
export class FilesService {
  /** The limits in force. Operators (and tests) may tighten or loosen them. */
  readonly limits: FileLimits = { ...FILE_LIMITS };
  readonly #context: ModuleContext;

  constructor(context: ModuleContext) {
    this.#context = context;
  }

  #git(): Services['git'] | undefined {
    return (this.#context.services as Partial<Services>).git;
  }

  // ---- listing -------------------------------------------------------------------

  async #describe(root: string, absolute: string, relative: string, name: string): Promise<FileEntry | null> {
    let stat: Stats;
    try {
      stat = await fs.lstat(absolute);
    } catch {
      return null; // vanished between the listing and now
    }
    const kind: Kind = stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : 'file';
    const entry: FileEntry = {
      name,
      path: relative,
      kind,
      size: kind === 'directory' ? 0 : stat.size,
      modifiedAt: Math.max(0, Math.round(stat.mtimeMs)),
      mode: stat.mode & 0o7777,
      ignored: false,
    };
    if (kind === 'symlink') {
      try {
        const real = await fs.realpath(absolute);
        if (!isInside(root, real)) entry.linkTarget = 'outside';
        else entry.linkTarget = (await fs.stat(real)).isDirectory() ? 'directory' : 'file';
      } catch {
        entry.linkTarget = 'missing';
      }
    }
    return entry;
  }

  /** The entries of one folder — folders first, then by name — without the always-hidden ones. */
  async #readDirectory(root: string, absolute: string, relative: string, cap: number): Promise<{ entries: FileEntry[]; truncated: boolean }> {
    const names = (await fs.readdir(absolute)).filter((name) => !ALWAYS_HIDDEN.has(name) && !name.startsWith(UPLOAD_TEMP_PREFIX)).sort(byName);
    const entries: FileEntry[] = [];
    for (const name of names.slice(0, cap)) {
      const entry = await this.#describe(root, path.join(absolute, name), relative === '' ? name : `${relative}/${name}`, name);
      if (entry) entries.push(entry);
    }
    entries.sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || byName(a.name, b.name));
    return { entries, truncated: names.length > cap };
  }

  /** Decides which entries the project's ignore rules hide: git's own answer in a repository, a conventional list otherwise. */
  async #ignoreFilter(rootDir: string): Promise<(entries: readonly FileEntry[]) => Promise<Set<string>>> {
    const git = this.#git();
    const inRepository = git !== undefined && (await git.inspect(rootDir)).state === 'ready';
    if (inRepository) {
      return (entries) => git.ignored(rootDir, entries.map((entry) => entry.path));
    }
    return (entries) => Promise.resolve(new Set(entries.filter((entry) => CONVENTIONALLY_IGNORED.has(entry.name)).map((entry) => entry.path)));
  }

  async #directory(rootDir: string, requested: string): Promise<ResolvedPath> {
    const resolved = await resolveTarget(rootDir, requested);
    let stat: Stats;
    try {
      stat = await fs.stat(resolved.absolute);
    } catch (error) {
      throw fsFailure(error);
    }
    if (!stat.isDirectory()) throw badRequest('That path is a file, not a folder.', undefined, 'not_a_directory');
    return resolved;
  }

  /** One folder's entries, for a tree that loads as it is opened. */
  async list(rootDir: string, requested: string, showIgnored: boolean): Promise<FileListing> {
    const directory = await this.#directory(rootDir, requested);
    let listing: { entries: FileEntry[]; truncated: boolean };
    try {
      listing = await this.#readDirectory(directory.root, directory.absolute, directory.relative, this.limits.maxListEntries);
    } catch (error) {
      throw fsFailure(error);
    }
    const ignored = await (await this.#ignoreFilter(rootDir))(listing.entries);
    const entries = showIgnored
      ? listing.entries.map((entry) => (ignored.has(entry.path) ? { ...entry, ignored: true } : entry))
      : listing.entries.filter((entry) => !ignored.has(entry.path));
    return { path: directory.relative, entries, truncated: listing.truncated };
  }

  /**
   * Walks a folder level by level. Ignored entries are left out and never
   * descended into; links are listed but never followed, so the walk cannot
   * leave the project or go round in circles.
   */
  async #walk(rootDir: string, start: ResolvedPath, maxDepth: number, maxEntries: number): Promise<WalkResult> {
    const isIgnored = await this.#ignoreFilter(rootDir);
    const top: FileTreeNode[] = [];
    let level: Array<{ absolute: string; relative: string; owner: FileTreeNode | null }> = [{ absolute: start.absolute, relative: start.relative, owner: null }];
    let count = 0;
    let truncatedBy: WalkResult['truncatedBy'] = null;

    for (let depth = 1; level.length > 0; depth += 1) {
      const read: Array<{ owner: FileTreeNode | null; absolute: string; entries: FileEntry[] }> = [];
      let pending = 0;
      for (const directory of level) {
        if (count + pending >= maxEntries) {
          if (directory.owner) directory.owner.childrenOmitted = true;
          truncatedBy = 'entries';
          continue;
        }
        try {
          const listing = await this.#readDirectory(start.root, directory.absolute, directory.relative, maxEntries - count - pending + 1);
          if (listing.truncated) truncatedBy = 'entries';
          read.push({ owner: directory.owner, absolute: directory.absolute, entries: listing.entries });
          pending += listing.entries.length;
        } catch (error) {
          // The folder that was asked for must be readable; one unreadable folder deeper down does not fail the tree.
          if (directory.owner === null) throw fsFailure(error);
          directory.owner.childrenOmitted = true;
        }
      }

      const ignored = await isIgnored(read.flatMap((batch) => batch.entries));
      const next: typeof level = [];
      for (const batch of read) {
        const visible = batch.entries.filter((entry) => !ignored.has(entry.path));
        const kept: FileTreeNode[] = visible.slice(0, Math.max(0, maxEntries - count));
        if (kept.length < visible.length) truncatedBy = 'entries';
        count += kept.length;
        if (batch.owner) batch.owner.children = kept;
        else top.push(...kept);
        for (const node of kept) {
          if (node.kind !== 'directory') continue;
          if (depth >= maxDepth) {
            node.childrenOmitted = true;
            truncatedBy ??= 'depth';
          } else {
            next.push({ absolute: path.join(batch.absolute, node.name), relative: node.path, owner: node });
          }
        }
      }
      level = next;
    }
    return { nodes: top, count, truncatedBy };
  }

  /** A bounded read of a whole folder tree. What did not fit is marked, never silently missing. */
  async tree(rootDir: string, requested: string, depth: number | undefined, limit: number | undefined): Promise<FileTree> {
    const start = await this.#directory(rootDir, requested);
    const limits = {
      depth: Math.min(depth ?? this.limits.maxTreeDepth, this.limits.maxTreeDepth),
      entries: Math.min(limit ?? this.limits.maxTreeEntries, this.limits.maxTreeEntries),
    };
    const walked = await this.#walk(rootDir, start, limits.depth, limits.entries);
    return { path: start.relative, entries: walked.nodes, entryCount: walked.count, truncated: walked.truncatedBy !== null, truncatedBy: walked.truncatedBy, limits };
  }

  // ---- searching -----------------------------------------------------------------

  /** Finds files and folders by name, for the "@" picker. Case-insensitive, best matches first. */
  async searchNames(rootDir: string, query: string, limit: number): Promise<FileNameSearch> {
    await projectRoot(rootDir);
    const wanted = query.toLowerCase();
    const cap = Math.min(limit, this.limits.maxSearchResults);
    const candidates: FileNameMatch[] = [];
    let truncated: boolean;

    const listed = await this.#git()?.listFiles(rootDir);
    if (listed) {
      truncated = listed.truncated;
      const folders = new Set<string>();
      for (const file of listed.files) {
        if (file.split('/').some((part) => ALWAYS_HIDDEN.has(part))) continue;
        candidates.push({ path: file, name: file.slice(file.lastIndexOf('/') + 1), kind: 'file' });
        for (let slash = file.lastIndexOf('/'); slash > 0; slash = file.lastIndexOf('/', slash - 1)) {
          const folder = file.slice(0, slash);
          if (folders.has(folder)) break;
          folders.add(folder);
          candidates.push({ path: folder, name: folder.slice(folder.lastIndexOf('/') + 1), kind: 'directory' });
        }
      }
    } else {
      const walked = await this.#walk(rootDir, await this.#directory(rootDir, ''), 16, 20_000);
      truncated = walked.truncatedBy !== null;
      const flatten = (nodes: readonly FileTreeNode[]): void => {
        for (const node of nodes) {
          if (node.kind !== 'symlink') candidates.push({ path: node.path, name: node.name, kind: node.kind });
          if (node.children) flatten(node.children);
        }
      };
      flatten(walked.nodes);
    }

    const ranked: Array<{ match: FileNameMatch; rank: number }> = [];
    for (const match of candidates) {
      const name = match.name.toLowerCase();
      const rank = name.startsWith(wanted) ? 0 : name.includes(wanted) ? 1 : match.path.toLowerCase().includes(wanted) ? 2 : -1;
      if (rank !== -1) ranked.push({ match, rank });
    }
    ranked.sort((a, b) => a.rank - b.rank || a.match.path.length - b.match.path.length || byName(a.match.path, b.match.path));
    return { query, results: ranked.slice(0, cap).map((entry) => entry.match), truncated: truncated || ranked.length > cap };
  }

  /** Literal text search inside files. Binary files are skipped and the answer is capped. */
  async searchContent(rootDir: string, request: { query: string; caseSensitive: boolean; path: string; limit: number }): Promise<FileContentSearch> {
    if (request.query.includes('\n') || request.query.includes('\0')) throw badRequest('Search for text on one line.', undefined, 'invalid_query');
    const directory = await this.#directory(rootDir, request.path);
    const limit = Math.min(request.limit, this.limits.maxContentMatches);

    const viaGit = await this.#git()?.grep(rootDir, request.query, {
      caseSensitive: request.caseSensitive,
      directory: directory.relative,
      limit,
      // Dependencies are searched no more than they are listed, even when the repository forgot to ignore them.
      skip: (file) => file.split('/').some((part) => ALWAYS_HIDDEN.has(part)),
    });
    if (viaGit) return { query: request.query, matches: viaGit.matches, truncated: viaGit.truncated, engine: 'git' };

    // No repository: a bounded walk over ordinary, reasonably small text files.
    const walked = await this.#walk(rootDir, directory, 16, 5000);
    const files: FileTreeNode[] = [];
    const flatten = (nodes: readonly FileTreeNode[]): void => {
      for (const node of nodes) {
        if (node.kind === 'file') files.push(node);
        if (node.children) flatten(node.children);
      }
    };
    flatten(walked.nodes);

    const needle = request.caseSensitive ? request.query : request.query.toLowerCase();
    const matches: FileContentSearch['matches'] = [];
    let truncated = walked.truncatedBy !== null;
    let budget = 64 * 1024 * 1024;
    const deadline = Date.now() + 5000;
    scan: for (const file of files) {
      if (file.size > 1024 * 1024 || file.size === 0) continue;
      if (budget < file.size || Date.now() > deadline) {
        truncated = true;
        break;
      }
      budget -= file.size;
      let content: Buffer;
      try {
        content = await this.#readRegularFile(path.join(directory.root, file.path), 1024 * 1024);
      } catch {
        continue;
      }
      if (looksBinary(content.subarray(0, 8192))) continue;
      const lines = content.toString('utf8').split('\n');
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]!;
        if (!(request.caseSensitive ? line : line.toLowerCase()).includes(needle)) continue;
        if (matches.length >= limit) {
          truncated = true;
          break scan;
        }
        const text = line.endsWith('\r') ? line.slice(0, -1) : line;
        matches.push({ path: file.path, line: index + 1, text: text.length > 400 ? `${text.slice(0, 400)}…` : text });
      }
    }
    return { query: request.query, matches, truncated, engine: 'scan' };
  }

  // ---- reading -------------------------------------------------------------------

  /** Opens a path that has already been confined, refusing anything but a regular file and any link put there since. */
  async #openRegular(absolute: string): Promise<{ handle: fs.FileHandle; stat: BigIntStats }> {
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw forbidden('That path leads outside the project.', 'path_outside_root');
      throw fsFailure(error);
    }
    try {
      const stat = await handle.stat({ bigint: true });
      if (stat.isDirectory()) throw badRequest('That path is a folder, not a file.', undefined, 'is_directory');
      if (!stat.isFile()) throw badRequest('That is not an ordinary file.', undefined, 'not_a_file');
      return { handle, stat };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async #readRegularFile(absolute: string, maxBytes: number): Promise<Buffer> {
    const { handle, stat } = await this.#openRegular(absolute);
    try {
      if (stat.size > BigInt(maxBytes)) throw payloadTooLarge('That file is too large to open.');
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  }

  async #head(handle: fs.FileHandle, length: number): Promise<Buffer> {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  }

  /** A file's text, with the version to hand back when saving. Anything that is not UTF-8 text is reported as binary. */
  async read(rootDir: string, requested: string): Promise<FileContent> {
    const resolved = await resolveTarget(rootDir, requested);
    const { handle, stat } = await this.#openRegular(resolved.absolute);
    try {
      const facts = {
        path: resolved.relative,
        size: Number(stat.size),
        modifiedAt: Number(stat.mtimeMs),
        version: versionOf(stat),
      };
      const name = path.basename(resolved.absolute);
      const binary = async (head: Buffer): Promise<FileContent> => {
        const mediaType = previewType(name, head.subarray(0, SNIFF_BYTES));
        return { kind: 'binary', ...facts, previewable: mediaType !== null, mediaType: mediaType ?? 'application/octet-stream' };
      };
      if (facts.size > this.limits.maxTextBytes) {
        const head = await this.#head(handle, 8192);
        if (looksBinary(head) || hasPreviewableExtension(name)) return await binary(head);
        return { kind: 'too_large', ...facts, limit: this.limits.maxTextBytes };
      }
      const content = await handle.readFile();
      if (looksBinary(content) || !isUtf8(content)) return await binary(content);
      // Decoded without dropping a byte-order mark, so that saving the text back writes the same bytes.
      const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(content);
      return { kind: 'text', ...facts, content: text, lineEnding: lineEndingOf(text) };
    } finally {
      await handle.close();
    }
  }

  /**
   * A file's bytes, for a download or — for the few passive media types — an
   * inline preview. Either way the response is sandboxed and its type is never
   * guessed by the browser.
   */
  async raw(rootDir: string, requested: string, disposition: 'attachment' | 'inline', range: string | undefined): Promise<RawFile> {
    const resolved = await resolveTarget(rootDir, requested);
    const { handle, stat } = await this.#openRegular(resolved.absolute);
    try {
      const size = Number(stat.size);
      const name = path.basename(resolved.absolute);
      const headers: Record<string, string> = {
        'x-content-type-options': 'nosniff',
        'accept-ranges': 'bytes',
        'last-modified': new Date(Number(stat.mtimeMs)).toUTCString(),
        'cross-origin-resource-policy': 'same-origin',
      };
      if (disposition === 'inline') {
        const mediaType = previewType(name, await this.#head(handle, SNIFF_BYTES));
        if (mediaType === null) {
          throw new StudioError(415, 'not_previewable', 'This kind of file cannot be shown in the browser. Download it instead.');
        }
        headers['content-type'] = mediaType;
        headers['content-disposition'] = contentDisposition('inline', name);
        headers['content-security-policy'] = PREVIEW_CSP;
      } else {
        headers['content-type'] = 'application/octet-stream';
        headers['content-disposition'] = contentDisposition('attachment', name);
        headers['content-security-policy'] = DOWNLOAD_CSP;
      }

      let start = 0;
      let end = size - 1;
      let status = 200;
      if (range !== undefined && size > 0) {
        // One range, as media elements ask for when seeking. Anything else gets the whole file.
        const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
        if (match && (match[1] !== '' || match[2] !== '')) {
          if (match[1] === '') {
            start = Math.max(0, size - Number(match[2]));
          } else {
            start = Number(match[1]);
            if (match[2] !== '') end = Math.min(Number(match[2]), size - 1);
          }
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
            throw new StudioError(416, 'range_not_satisfiable', 'That part of the file does not exist.', { size });
          }
          status = 206;
          headers['content-range'] = `bytes ${start}-${end}/${size}`;
        }
      }
      headers['content-length'] = String(size === 0 ? 0 : end - start + 1);
      const stream = size === 0 ? Readable.from([]) : handle.createReadStream({ start, end, autoClose: true });
      if (size === 0) await handle.close();
      return { status, headers, stream };
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  // ---- writing -------------------------------------------------------------------

  /** Replaces a file's content in one step: readers see the old bytes or the new ones, never a half-written file. */
  async #replaceAtomically(destination: string, write: (handle: fs.FileHandle) => Promise<void>, mode: number | null): Promise<void> {
    const temporary = path.join(path.dirname(destination), `.${path.basename(destination).slice(0, 80)}.${randomToken(6)}.tmp`);
    let handle: fs.FileHandle | null = null;
    try {
      handle = await fs.open(temporary, 'wx', mode ?? 0o666);
      if (mode !== null) await handle.chmod(mode);
      await write(handle);
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temporary, destination);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await fs.unlink(temporary).catch(() => undefined);
      throw fsFailure(error);
    }
  }

  async save(rootDir: string, request: SaveFileRequest): Promise<SavedFile> {
    if (Buffer.byteLength(request.content) > this.limits.maxTextBytes) {
      throw payloadTooLarge(`A file saved from the editor can be at most ${Math.floor(this.limits.maxTextBytes / (1024 * 1024))} MB.`);
    }
    const resolved = await resolveTarget(rootDir, request.path);
    refuseProjectRoot(resolved);

    let existing: BigIntStats | null = null;
    try {
      existing = await fs.stat(resolved.absolute, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw fsFailure(error);
    }
    if (existing?.isDirectory()) throw badRequest('That path is a folder, not a file.', undefined, 'is_directory');
    if (existing && !existing.isFile()) throw badRequest('That is not an ordinary file.', undefined, 'not_a_file');

    if (existing) {
      const currentVersion = versionOf(existing);
      if (!request.force) {
        if (request.baseVersion === null) {
          throw conflict('A file with that name already exists.', 'file_exists', { currentVersion });
        }
        if (request.baseVersion !== currentVersion) {
          throw conflict('The file was changed by someone or something else since you opened it. Nothing was saved.', 'file_changed', { currentVersion });
        }
      }
    } else {
      if (request.baseVersion !== null && !request.force) {
        throw conflict('The file was deleted or moved since you opened it. Nothing was saved.', 'file_changed', { currentVersion: null });
      }
      assertEntryName(path.basename(resolved.absolute));
      const parent = await fs.stat(path.dirname(resolved.absolute)).catch(() => null);
      if (!parent) throw notFound('The folder for that file does not exist.', 'parent_missing');
      if (!parent.isDirectory()) throw badRequest('Part of that path is a file, not a folder.', undefined, 'not_a_directory');
    }

    await this.#replaceAtomically(
      resolved.absolute,
      (handle) => handle.writeFile(request.content, 'utf8'),
      existing ? Number(existing.mode & 0o7777n) : null,
    );
    const saved = await fs.stat(resolved.absolute, { bigint: true });
    return {
      path: resolved.relative,
      size: Number(saved.size),
      modifiedAt: Number(saved.mtimeMs),
      version: versionOf(saved),
      created: existing === null,
    };
  }

  async create(rootDir: string, request: { parent: string; name: string; kind: 'file' | 'directory' }): Promise<FileEntry> {
    const name = assertEntryName(request.name);
    let parent: ResolvedPath;
    try {
      parent = await this.#directory(rootDir, request.parent);
    } catch (error) {
      if (isStudioError(error) && error.code === 'file_not_found') throw notFound('The folder to create it in does not exist.', 'parent_missing');
      throw error;
    }
    const absolute = path.join(parent.absolute, name);
    const relative = toRelative(parent.root, absolute);
    refuseGitInternal(relative);
    try {
      // Both calls fail when the name is taken — by anything, a dangling link included.
      if (request.kind === 'directory') await fs.mkdir(absolute);
      else await (await fs.open(absolute, 'wx', 0o666)).close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw conflict('Something with that name already exists there.', 'already_exists');
      throw fsFailure(error);
    }
    return (await this.#describe(parent.root, absolute, relative, name))!;
  }

  /** Renames or moves an entry inside the project. The entry itself moves; a link is never followed. Nothing is overwritten. */
  async move(rootDir: string, request: { from: string; to: string }): Promise<{ from: string; entry: FileEntry }> {
    const source = await resolveEntry(rootDir, request.from);
    refuseProjectRoot(source);
    const sourceStat = await fs.lstat(source.absolute).catch((error: unknown) => {
      throw fsFailure(error);
    });

    const destination = request.to.replace(/\/+$/, '');
    const name = assertEntryName(path.posix.basename(destination));
    const folder = path.posix.dirname(destination);
    let parent: ResolvedPath;
    try {
      parent = await this.#directory(rootDir, folder === '.' ? '' : folder);
    } catch (error) {
      if (isStudioError(error) && error.code === 'file_not_found') throw notFound('The destination folder does not exist.', 'parent_missing');
      throw error;
    }
    const absolute = path.join(parent.absolute, name);
    const relative = toRelative(parent.root, absolute);
    refuseGitInternal(relative);

    if (absolute === source.absolute) return { from: source.relative, entry: (await this.#describe(source.root, absolute, relative, name))! };
    if (sourceStat.isDirectory() && isInside(source.absolute, absolute)) {
      throw badRequest('A folder cannot be moved into itself.', undefined, 'invalid_move');
    }
    if (await fs.lstat(absolute).then(() => true, () => false)) {
      throw conflict('Something with that name already exists there.', 'already_exists');
    }
    try {
      await fs.rename(source.absolute, absolute);
    } catch (error) {
      throw fsFailure(error);
    }
    return { from: source.relative, entry: (await this.#describe(source.root, absolute, relative, name))! };
  }

  /** Deletes an entry for good. A folder with anything in it needs `recursive`. A link is removed, not what it points to. */
  async remove(rootDir: string, request: { path: string; recursive: boolean }): Promise<string> {
    const target = await resolveEntry(rootDir, request.path);
    refuseProjectRoot(target);
    try {
      const stat = await fs.lstat(target.absolute);
      if (!stat.isDirectory()) await fs.unlink(target.absolute);
      else if (request.recursive) await fs.rm(target.absolute, { recursive: true });
      else await fs.rmdir(target.absolute);
    } catch (error) {
      throw fsFailure(error);
    }
    return target.relative;
  }

  // ---- uploading -----------------------------------------------------------------

  /** Splits a declared upload path into safe components, or says why it cannot be used. */
  #uploadComponents(declared: string): { parts: string[] } | { reason: 'invalid_name' | 'outside_project' | 'protected' } {
    if (declared.includes('\0') || declared.includes('\\')) return { reason: 'invalid_name' };
    if (declared.startsWith('/') || /^[A-Za-z]:/.test(declared)) return { reason: 'outside_project' };
    const parts = declared.split('/').filter((part) => part !== '' && part !== '.');
    if (parts.length === 0) return { reason: 'invalid_name' };
    if (parts.includes('..')) return { reason: 'outside_project' };
    if (parts.some((part) => part.toLowerCase() === '.git')) return { reason: 'protected' };
    if (parts.some((part) => nameProblem(part) !== null)) return { reason: 'invalid_name' };
    return { parts };
  }

  /**
   * Stores uploaded files under `target`. Each file is first written beside
   * its destination under a temporary name and only moved into place when the
   * whole request has arrived within its limits — a request that breaks a
   * limit stores nothing. A file that cannot be stored for a reason of its own
   * (bad name, would leave the project, name taken) is skipped and reported.
   */
  async upload(rootDir: string, target: string, overwrite: boolean, parts: AsyncIterable<UploadPart>): Promise<UploadResult> {
    const base = await resolveTarget(rootDir, target);
    if (await fs.stat(base.absolute).then((stat) => !stat.isDirectory(), () => false)) {
      throw badRequest('The upload target is a file, not a folder.', undefined, 'not_a_directory');
    }

    const staged: Array<{ temporary: string; destination: string; relative: string; size: number; replaced: boolean }> = [];
    const skipped: UploadResult['skipped'] = [];
    const createdFolders: string[] = [];
    let requested = 0;
    let total = 0;

    const drain = (stream: Readable): Promise<void> =>
      new Promise((resolve) => {
        stream.on('end', resolve).on('error', () => resolve()).on('close', resolve).resume();
      });

    try {
      for await (const part of parts) {
        requested += 1;
        if (requested > this.limits.maxUploadFiles) {
          throw payloadTooLarge(`At most ${this.limits.maxUploadFiles} files can be uploaded at once.`, 'too_many_files');
        }
        const skip = async (reason: UploadResult['skipped'][number]['reason']) => {
          skipped.push({ name: part.name.slice(0, 300), reason });
          await drain(part.stream);
        };

        const components = this.#uploadComponents(part.name);
        if ('reason' in components) {
          await skip(components.reason);
          continue;
        }
        const name = components.parts[components.parts.length - 1]!;
        const folderRequest = [base.relative, ...components.parts.slice(0, -1)].filter((piece) => piece !== '').join('/');
        let folder: ResolvedPath;
        try {
          folder = await resolveTarget(rootDir, folderRequest);
        } catch (error) {
          if (!isStudioError(error)) throw error;
          await skip(error.code === 'protected_path' ? 'protected' : 'outside_project');
          continue;
        }
        const destination = path.join(folder.absolute, name);
        const existing = await fs.lstat(destination).catch(() => null);
        if (existing?.isDirectory()) {
          await skip('is_directory');
          continue;
        }
        if (existing && !overwrite) {
          await skip('exists');
          continue;
        }
        if (staged.some((entry) => entry.destination === destination)) {
          await skip('exists');
          continue;
        }

        // Create missing folders, remembering the topmost new one so that a refused request can take them away again.
        let missing = folder.absolute;
        let topmostNew: string | null = null;
        while (!(await fs.stat(missing).then(() => true, () => false))) {
          topmostNew = missing;
          missing = path.dirname(missing);
        }
        try {
          await fs.mkdir(folder.absolute, { recursive: true });
        } catch (error) {
          throw fsFailure(error);
        }
        if (topmostNew) createdFolders.push(topmostNew);

        const temporary = path.join(folder.absolute, `${UPLOAD_TEMP_PREFIX}${randomToken(9)}.tmp`);
        let size = 0;
        const counter = new Transform({
          transform: (chunk: Buffer, _encoding, done) => {
            size += chunk.length;
            total += chunk.length;
            if (size > this.limits.maxUploadFileBytes) {
              done(payloadTooLarge(`A single uploaded file can be at most ${Math.floor(this.limits.maxUploadFileBytes / (1024 * 1024))} MB.`, 'file_too_large'));
            } else if (total > this.limits.maxUploadTotalBytes) {
              done(payloadTooLarge(`One upload can be at most ${Math.floor(this.limits.maxUploadTotalBytes / (1024 * 1024))} MB in total.`, 'upload_too_large'));
            } else {
              done(null, chunk);
            }
          },
        });
        staged.push({ temporary, destination, relative: toRelative(folder.root, destination), size: 0, replaced: existing !== null });
        const handle = await fs.open(temporary, 'wx', 0o666).catch((error: unknown) => {
          throw fsFailure(error);
        });
        try {
          await pipeline(part.stream, counter, handle.createWriteStream());
        } catch (error) {
          throw fsFailure(error);
        }
        // The multipart parser cuts a file at its own limit and flags it rather than failing.
        if (part.stream.truncated) {
          throw payloadTooLarge(`A single uploaded file can be at most ${Math.floor(this.limits.maxUploadFileBytes / (1024 * 1024))} MB.`, 'file_too_large');
        }
        staged[staged.length - 1]!.size = size;
      }
      if (requested === 0) throw badRequest('The upload contained no files.', undefined, 'no_files');

      // Everything arrived within the limits: move the files into place.
      for (const entry of staged) {
        try {
          await fs.rename(entry.temporary, entry.destination);
        } catch (error) {
          throw fsFailure(error);
        }
      }
    } catch (error) {
      for (const entry of staged) await fs.unlink(entry.temporary).catch(() => undefined);
      // Only folders this request created, and only while they are empty.
      for (const folder of createdFolders.reverse()) await this.#removeEmptyFolders(folder);
      throw error;
    }

    return {
      target: base.relative,
      requested,
      stored: staged.map((entry) => ({ path: entry.relative, size: entry.size, replaced: entry.replaced })),
      skipped,
    };
  }

  async #removeEmptyFolders(folder: string): Promise<void> {
    try {
      for (const name of await fs.readdir(folder)) {
        const child = path.join(folder, name);
        if ((await fs.lstat(child)).isDirectory()) await this.#removeEmptyFolders(child);
      }
      await fs.rmdir(folder);
    } catch {
      /* not empty or already gone: leave it */
    }
  }

  // ---- archive -------------------------------------------------------------------

  /**
   * A folder as a ZIP archive: exactly the files the tree shows (ignored and
   * always-hidden entries are left out). Links are skipped, never followed.
   * Size and entry count are checked before the first byte is sent.
   */
  async archive(rootDir: string, requested: string): Promise<{ fileName: string; stream: Readable }> {
    const start = await this.#directory(rootDir, requested);
    const walked = await this.#walk(rootDir, start, MAX_WALK_DEPTH, this.limits.maxArchiveEntries + 1);
    if (walked.count > this.limits.maxArchiveEntries || walked.truncatedBy !== null) {
      throw payloadTooLarge(
        `That folder has more than ${this.limits.maxArchiveEntries} entries, too many to download as one archive. Choose a smaller folder.`,
        'archive_too_large',
      );
    }
    const top = path.basename(start.absolute);
    const entries: ZipEntry[] = [];
    let total = 0;
    const collect = (nodes: readonly FileTreeNode[]): void => {
      for (const node of nodes) {
        // Links are never followed into an archive, and a name with a backslash cannot be stored portably.
        if (node.kind === 'symlink' || node.name.includes('\\')) continue;
        const relativeToStart = start.relative === '' ? node.path : node.path.slice(start.relative.length + 1);
        const name = `${top}/${relativeToStart}`;
        const modifiedAt = new Date(node.modifiedAt);
        if (node.kind === 'directory') {
          entries.push({ name, directory: true, modifiedAt, mode: node.mode });
          if (node.children) collect(node.children);
          continue;
        }
        total += node.size;
        const absolute = path.join(start.root, node.path);
        entries.push({
          name,
          modifiedAt,
          mode: node.mode,
          // Opened only when its turn comes, and only if it is still an ordinary file: a link swapped in meanwhile is skipped.
          open: async () => {
            try {
              const { handle } = await this.#openRegular(absolute);
              return handle.createReadStream({ autoClose: true });
            } catch {
              return null;
            }
          },
        });
      }
    };
    collect(walked.nodes);
    if (total > this.limits.maxArchiveBytes) {
      throw payloadTooLarge(
        `That folder holds more than ${Math.floor(this.limits.maxArchiveBytes / (1024 * 1024))} MB, too much to download as one archive.`,
        'archive_too_large',
      );
    }
    return { fileName: `${top}.zip`, stream: Readable.from(zipStream(entries), { objectMode: false }) };
  }
}
