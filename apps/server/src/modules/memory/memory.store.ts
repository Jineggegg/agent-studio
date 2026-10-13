import { createHash, randomBytes } from 'node:crypto';
import { promises as fs, type Dirent, type Stats } from 'node:fs';
import path from 'node:path';
import { MEMORY_ERRORS, MEMORY_LIMITS, type MemoryCredentialKind, type MemoryNoteProblem } from '@agent-studio/protocol';
import type { FastifyBaseLogger } from 'fastify';
import { escapeLike, type Database, type Migration, type SqlValue } from '../../kernel/database.js';
import { badRequest, describeError, isStudioError, notFound } from '../../kernel/errors.js';
import { confine } from '../../kernel/paths.js';
import { findCredentialInNote } from './credentials.js';
import { MAX_NOTE_FILE_BYTES, parseNoteFile, serialiseNote, type NoteDraft } from './front-matter.js';
import { GLOBAL_FOLDER, NOTE_EXTENSION, cleanAuthor, cleanKeywords, cleanTags, isSafeSegment, slugify, type NoteRef } from './names.js';
import type { ParsedQuery } from './search.js';

/**
 * The note files and their index.
 *
 * **The files are the truth.** A note is `<dataDir>/memory/<folder>/…/<name>.md`
 * (format: `front-matter.ts`). People may edit, add, move and delete these
 * files with any tool; the product reads them back.
 *
 * **The index is a cache** of what the files say — a row per note plus an
 * FTS5 table — so that listing and search do not read every file. It is kept
 * in line with the files like this:
 *
 * - *Synchronising* walks the directory tree, compares each file's
 *   modification time and size with its row, re-reads the files that differ,
 *   adds new ones and forgets rows whose file is gone. It runs when the
 *   server starts, before every listing and search, and on demand.
 *   While the store holds no more than {@link ALWAYS_FRESH_UP_TO} notes it
 *   runs before *every* listing and search, so a file changed by hand shows
 *   up on the very next one. Larger stores are walked at most once every
 *   {@link LARGE_STORE_INTERVAL_MS}, so there a hand edit shows up in lists
 *   within that time.
 * - *Reading one note* always reads its file, so the text returned is the
 *   text on disk, and the note's row is corrected on the spot if it was out
 *   of date.
 * - *Rebuilding* throws the rows away and reads every file again. It happens
 *   when the owner asks for it, when {@link INDEX_VERSION} changes, and by
 *   itself when the full-text table and the note rows disagree in number.
 *
 * What is ignored on disk: anything whose name starts with a dot, symbolic
 * links (never followed), files that are not `*.md`, files directly in the
 * store's root, directories nested deeper than the product creates, and names
 * with control characters or backslashes. A `*.md` file that cannot be read
 * as UTF-8 text, or is larger than 1 MiB, is still listed — under its file
 * name, with a `problem` — and can be moved or deleted, but not edited.
 *
 * Product writes are atomic (a temporary file renamed into place) and
 * serialised through {@link MemoryStore.exclusive}.
 */

export const MEMORY_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'note index, folder mapping, settings',
    sql: `
      CREATE TABLE memory_notes (
        n INTEGER PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        folder TEXT NOT NULL,
        dir TEXT NOT NULL,
        name TEXT NOT NULL,
        name_key TEXT NOT NULL,
        title TEXT NOT NULL,
        title_key TEXT NOT NULL,
        author TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        keywords TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        mtime_ms REAL NOT NULL,
        size INTEGER NOT NULL,
        version TEXT NOT NULL,
        credential TEXT,
        problem TEXT
      );
      CREATE INDEX memory_notes_recent ON memory_notes(folder, updated_at DESC);
      CREATE INDEX memory_notes_dir ON memory_notes(dir);
      CREATE TABLE memory_note_tags (
        n INTEGER NOT NULL REFERENCES memory_notes(n) ON DELETE CASCADE,
        tag TEXT NOT NULL,
        PRIMARY KEY (n, tag)
      ) WITHOUT ROWID;
      CREATE INDEX memory_note_tags_tag ON memory_note_tags(tag);
      CREATE VIRTUAL TABLE memory_fts USING fts5(title, body, tags, keywords, tokenize = 'trigram');
      CREATE TABLE memory_folders (
        folder TEXT PRIMARY KEY,
        project_id TEXT UNIQUE,
        root_dir TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        released_at INTEGER
      );
      CREATE TABLE memory_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
];

/** Raise when the way files are read into the index changes; the index is then rebuilt from the files. */
export const INDEX_VERSION = '1';
/** Up to this many notes the files are checked before every listing and search. */
export const ALWAYS_FRESH_UP_TO = 500;
/** Above that, at most this often. */
export const LARGE_STORE_INTERVAL_MS = 2_000;

const MAX_DEPTH = 1 + MEMORY_LIMITS.subfolderDepth;
/** The name of a file a write is prepared in, before it is renamed into place. */
const TEMPORARY_NAME = /^\.[0-9a-f]{18}\.tmp$/;
const STALE_TEMPORARY_MS = 60 * 60 * 1000;
const MAX_FILES = 50_000;
const STAT_BATCH = 32;
const CANDIDATE_LIMIT = 150;
const SCORING_BODY_CHARS = 20_000;

export type StoreProblem = 'store_unreadable' | 'index_error';

/** Thrown when the files or the index cannot be used right now. */
export class MemoryStoreError extends Error {
  readonly problem: StoreProblem;
  constructor(problem: StoreProblem, cause: unknown) {
    super(`memory ${problem}: ${describeError(cause)}`);
    this.name = 'MemoryStoreError';
    this.problem = problem;
  }
}

export interface IndexedNote {
  readonly id: string;
  readonly folder: string;
  readonly dir: string;
  readonly name: string;
  readonly title: string;
  readonly author: string | null;
  readonly tags: string[];
  readonly keywords: string[];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly version: string;
  readonly credential: MemoryCredentialKind | null;
  readonly problem: MemoryNoteProblem | null;
  readonly size: number;
}

/** A note as its file says right now. */
export interface LoadedNote extends IndexedNote {
  readonly body: string;
  /** Header lines the product does not use; written back unchanged. */
  readonly extra: string[];
}

export interface Candidate extends IndexedNote {
  /** The start of the body, for scoring and snippets. */
  readonly bodyHead: string;
}

export interface QueryScope {
  /** Top-level folders the caller may see. Nothing outside them is ever returned. */
  readonly folders: readonly string[];
  /** Only this directory and what is below it. */
  readonly path?: string;
  readonly tag?: string;
  /** Leave out notes that appear to hold a credential or could not be read. */
  readonly cleanOnly?: boolean;
}

export interface SyncSummary {
  readonly notes: number;
  readonly unreadable: number;
  readonly skippedFiles: number;
  readonly changed: number;
  readonly tookMs: number;
}

interface NoteRow {
  n: number;
  id: string;
  folder: string;
  dir: string;
  name: string;
  title: string;
  author: string | null;
  tags: string;
  keywords: string;
  created_at: number;
  updated_at: number;
  mtime_ms: number;
  size: number;
  version: string;
  credential: string | null;
  problem: string | null;
}

const NOTE_COLUMNS =
  'n.n, n.id, n.folder, n.dir, n.name, n.title, n.author, n.tags, n.keywords, n.created_at, n.updated_at, n.mtime_ms, n.size, n.version, n.credential, n.problem';

/** The scope of a query as SQL. Takes the parameters produced by {@link scopeParams}, in order. */
const SCOPE_SQL = `
  n.folder IN (SELECT value FROM json_each(?))
  AND (? IS NULL OR n.dir = ? OR n.dir LIKE ? ESCAPE '\\')
  AND (? IS NULL OR EXISTS (SELECT 1 FROM memory_note_tags t WHERE t.n = n.n AND t.tag = ?))
  AND (? = 0 OR (n.credential IS NULL AND n.problem IS NULL))`;

function scopeParams(scope: QueryScope): SqlValue[] {
  const dir = scope.path ?? null;
  const tag = scope.tag ?? null;
  return [JSON.stringify(scope.folders), dir, dir, dir === null ? null : `${escapeLike(dir)}/%`, tag, tag, scope.cleanOnly ? 1 : 0];
}

function parseStringList(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

const toNote = (row: NoteRow): IndexedNote => ({
  id: row.id,
  folder: row.folder,
  dir: row.dir,
  name: row.name,
  title: row.title,
  author: row.author,
  tags: parseStringList(row.tags),
  keywords: parseStringList(row.keywords),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  version: row.version,
  credential: row.credential as MemoryCredentialKind | null,
  problem: row.problem as MemoryNoteProblem | null,
  size: row.size,
});

const fingerprint = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex').slice(0, 32);

const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code;

/** The first line of the body when it is a first-level heading. */
function headingTitle(body: string): string | null {
  const lineEnd = body.indexOf('\n');
  const line = (lineEnd === -1 ? body : body.slice(0, lineEnd)).slice(0, 400);
  const match = /^#[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
  return match ? match[1]!.trim() || null : null;
}

interface FoundFile {
  readonly ref: NoteRef;
  readonly file: string;
  readonly mtimeMs: number;
  readonly size: number;
}

export class MemoryStore {
  readonly rootDir: string;
  readonly #db: Database;
  readonly #log: FastifyBaseLogger;
  #queue: Promise<unknown> = Promise.resolve();
  #running: Promise<SyncSummary> | null = null;
  #last: SyncSummary | null = null;
  #lastAt = 0;
  #problem: StoreProblem | null = null;
  #diskFolders = new Set<string>([GLOBAL_FOLDER]);
  /** Told which top-level folders changed when a synchronisation finds differences. */
  onExternalChange: (folders: ReadonlySet<string>) => void = () => {};

  constructor(deps: { db: Database; rootDir: string; log: FastifyBaseLogger }) {
    this.#db = deps.db;
    this.rootDir = deps.rootDir;
    this.#log = deps.log;
  }

  // ---- serialising writers ----------------------------------------------------

  /** Runs `work` when every earlier exclusive job has finished. All product writes and synchronisations go through here. */
  exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(work);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  // ---- state ------------------------------------------------------------------

  /** Why the last synchronisation failed, or null when it succeeded. */
  get problem(): StoreProblem | null {
    return this.#problem;
  }

  get lastSync(): SyncSummary | null {
    return this.#last;
  }

  /** Top-level folders found on disk by the last synchronisation. */
  get diskFolders(): ReadonlySet<string> {
    return this.#diskFolders;
  }

  getState(key: string): string | null {
    return this.#db.get<{ value: string }>('SELECT value FROM memory_state WHERE key = ?', key)?.value ?? null;
  }

  setState(key: string, value: string): void {
    this.#db.run('INSERT INTO memory_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, value);
  }

  /** When the index was last brought in line with the files. */
  indexedAt(): number | null {
    const value = Number(this.getState('indexed_at'));
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  // ---- synchronising ----------------------------------------------------------

  /**
   * Brings the index in line with the files. Concurrent callers share one
   * walk. Throws {@link MemoryStoreError} when the directory or the index
   * cannot be used.
   */
  refresh(options: { force?: boolean } = {}): Promise<SyncSummary> {
    if (this.#running) return this.#running;
    const fresh = this.#last !== null && this.#problem === null && this.#last.notes > ALWAYS_FRESH_UP_TO && Date.now() - this.#lastAt < LARGE_STORE_INTERVAL_MS;
    if (fresh && !options.force) return Promise.resolve(this.#last!);
    const running = this.exclusive(() => this.#synchronise(false)).finally(() => {
      this.#running = null;
    });
    this.#running = running;
    return running;
  }

  /** Forgets the index and reads every file again. */
  rebuild(): Promise<SyncSummary> {
    return this.exclusive(() => this.#synchronise(true));
  }

  async #synchronise(rebuild: boolean): Promise<SyncSummary> {
    const started = performance.now();
    let found: { files: Map<string, FoundFile>; folders: Set<string>; skipped: number };
    try {
      await fs.mkdir(path.join(this.rootDir, GLOBAL_FOLDER), { recursive: true, mode: 0o700 });
      found = await this.#walk();
    } catch (error) {
      this.#problem = 'store_unreadable';
      throw new MemoryStoreError('store_unreadable', error);
    }

    const changedFolders = new Set<string>();
    let changed = 0;
    try {
      // A full-text table that does not hold exactly the indexed notes cannot be trusted: start over.
      const held = this.#db.get<{ notes: number; indexed: number }>('SELECT (SELECT COUNT(*) FROM memory_notes) AS notes, (SELECT COUNT(*) FROM memory_fts) AS indexed')!;
      if (rebuild || held.notes !== held.indexed || this.getState('index_version') !== INDEX_VERSION) {
        this.#db.transaction(() => {
          this.#db.run('DELETE FROM memory_fts');
          this.#db.run('DELETE FROM memory_notes');
          this.setState('index_version', INDEX_VERSION);
        });
      }
      const rows = new Map(
        this.#db.all<{ id: string; folder: string; mtime_ms: number; size: number }>('SELECT id, folder, mtime_ms, size FROM memory_notes').map((row) => [row.id, row]),
      );
      for (const file of found.files.values()) {
        const row = rows.get(file.ref.id);
        if (row && row.mtime_ms === file.mtimeMs && row.size === file.size) continue;
        const loaded = await this.#load(file.ref, file.file, file);
        if (loaded) this.#save(loaded.note, loaded.body, loaded.mtimeMs);
        else this.#forget(file.ref.id);
        changed += 1;
        changedFolders.add(file.ref.folder);
      }
      for (const row of rows.values()) {
        if (found.files.has(row.id)) continue;
        this.#forget(row.id);
        changed += 1;
        changedFolders.add(row.folder);
      }
      this.setState('indexed_at', String(Date.now()));
      const totals = this.#db.get<{ notes: number; unreadable: number }>(
        'SELECT COUNT(*) AS notes, COALESCE(SUM(problem IS NOT NULL), 0) AS unreadable FROM memory_notes',
      )!;
      this.#last = { notes: totals.notes, unreadable: totals.unreadable, skippedFiles: found.skipped, changed, tookMs: Math.round(performance.now() - started) };
    } catch (error) {
      this.#problem = 'index_error';
      throw new MemoryStoreError('index_error', error);
    }
    this.#problem = null;
    this.#lastAt = Date.now();
    this.#diskFolders = found.folders;
    if (changedFolders.size > 0 && !rebuild) {
      try {
        this.onExternalChange(changedFolders);
      } catch (error) {
        this.#log.warn({ err: describeError(error) }, 'memory change listener failed');
      }
    }
    return this.#last;
  }

  /** Lists the note files. Symbolic links are never followed and nothing whose name starts with a dot is entered. */
  async #walk(): Promise<{ files: Map<string, FoundFile>; folders: Set<string>; skipped: number }> {
    const files = new Map<string, FoundFile>();
    const folders = new Set<string>([GLOBAL_FOLDER]);
    let skipped = 0;
    const pending: { ref: NoteRef; file: string }[] = [];
    const leftovers: string[] = [];
    const queue: { dir: string; segments: string[] }[] = [{ dir: this.rootDir, segments: [] }];

    while (queue.length > 0) {
      const { dir, segments } = queue.pop()!;
      let entries: Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (error) {
        // The root must be readable; a sub-directory that is not is skipped.
        if (segments.length === 0) throw error;
        skipped += 1;
        continue;
      }
      for (const entry of entries) {
        if (TEMPORARY_NAME.test(entry.name) && entry.isFile()) leftovers.push(path.join(dir, entry.name));
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (!isSafeSegment(entry.name) || segments.length >= MAX_DEPTH) {
            skipped += 1;
            continue;
          }
          if (segments.length === 0) folders.add(entry.name);
          queue.push({ dir: path.join(dir, entry.name), segments: [...segments, entry.name] });
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith(NOTE_EXTENSION)) continue;
        const name = entry.name.slice(0, -NOTE_EXTENSION.length);
        const id = [...segments, name].join('/');
        if (segments.length === 0 || !isSafeSegment(name) || id.length > MEMORY_LIMITS.noteIdChars || pending.length >= MAX_FILES) {
          skipped += 1;
          continue;
        }
        pending.push({ ref: { id, folder: segments[0]!, dir: segments.join('/'), name }, file: path.join(dir, entry.name) });
      }
    }

    for (let offset = 0; offset < pending.length; offset += STAT_BATCH) {
      const batch = pending.slice(offset, offset + STAT_BATCH);
      const stats = await Promise.all(batch.map((item) => fs.lstat(item.file).catch(() => null)));
      batch.forEach((item, index) => {
        const stat = stats[index];
        if (stat?.isFile()) files.set(item.ref.id, { ref: item.ref, file: item.file, mtimeMs: stat.mtimeMs, size: stat.size });
      });
    }
    // A write that was cut short (a crash, a full disk) leaves its temporary file behind; old ones are cleared away.
    for (const leftover of leftovers.slice(0, 100)) {
      const stat = await fs.lstat(leftover).catch(() => null);
      if (stat?.isFile() && Date.now() - stat.mtimeMs > STALE_TEMPORARY_MS) await fs.rm(leftover, { force: true }).catch(() => undefined);
    }
    return { files, folders, skipped };
  }

  /** Reads one file into the shape of a note. Null when the file is gone. */
  async #load(ref: NoteRef, file: string, stat: Pick<Stats, 'mtimeMs' | 'size'>): Promise<{ note: LoadedNote; body: string; mtimeMs: number } | null> {
    const modified = Math.floor(stat.mtimeMs);
    const broken = (problem: MemoryNoteProblem, version: string): { note: LoadedNote; body: string; mtimeMs: number } => ({
      note: {
        ...ref,
        title: ref.name,
        author: null,
        tags: [],
        keywords: [],
        createdAt: modified,
        updatedAt: modified,
        version,
        credential: null,
        problem,
        size: stat.size,
        body: '',
        extra: [],
      },
      body: '',
      mtimeMs: stat.mtimeMs,
    });

    if (stat.size > MAX_NOTE_FILE_BYTES) return broken('too_large', fingerprint(`${stat.size}:${stat.mtimeMs}`));
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(file);
    } catch (error) {
      if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') return null;
      return broken('unreadable', fingerprint(`${stat.size}:${stat.mtimeMs}`));
    }
    const parsed = parseNoteFile(bytes);
    if (!parsed.ok) return broken(parsed.reason, fingerprint(bytes));

    const document = parsed.note;
    const title = (document.title ?? headingTitle(document.body) ?? ref.name).replace(/\s+/g, ' ').trim().slice(0, 200) || ref.name;
    const tags = cleanTags(document.tags, 24);
    const keywords = cleanKeywords(document.keywords, 32);
    const updatedAt = Math.max(document.updated ?? 0, modified);
    const createdAt = Math.min(document.created ?? document.updated ?? modified, updatedAt);
    const note: LoadedNote = {
      ...ref,
      title,
      author: cleanAuthor(document.author),
      tags,
      keywords,
      createdAt,
      updatedAt,
      version: fingerprint(bytes),
      credential: findCredentialInNote({ title, body: document.body, tags, keywords })?.kind ?? null,
      problem: null,
      size: stat.size,
      body: document.body,
      extra: document.extra,
    };
    return { note, body: document.body, mtimeMs: stat.mtimeMs };
  }

  #save(note: IndexedNote, body: string, mtimeMs: number): void {
    this.#db.transaction(() => {
      const row = this.#db.get<{ n: number }>(
        `INSERT INTO memory_notes (id, folder, dir, name, name_key, title, title_key, author, tags, keywords, created_at, updated_at, mtime_ms, size, version, credential, problem)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           folder = excluded.folder, dir = excluded.dir, name = excluded.name, name_key = excluded.name_key,
           title = excluded.title, title_key = excluded.title_key, author = excluded.author, tags = excluded.tags,
           keywords = excluded.keywords, created_at = excluded.created_at, updated_at = excluded.updated_at,
           mtime_ms = excluded.mtime_ms, size = excluded.size, version = excluded.version,
           credential = excluded.credential, problem = excluded.problem
         RETURNING n`,
        note.id,
        note.folder,
        note.dir,
        note.name,
        slugify(note.name),
        note.title,
        slugify(note.title),
        note.author,
        JSON.stringify(note.tags),
        JSON.stringify(note.keywords),
        note.createdAt,
        note.updatedAt,
        mtimeMs,
        note.size,
        note.version,
        note.credential,
        note.problem,
      )!;
      this.#db.run('DELETE FROM memory_fts WHERE rowid = ?', row.n);
      this.#db.run('INSERT INTO memory_fts (rowid, title, body, tags, keywords) VALUES (?, ?, ?, ?, ?)', row.n, note.title, body, note.tags.join(' '), note.keywords.join(' '));
      this.#db.run('DELETE FROM memory_note_tags WHERE n = ?', row.n);
      for (const tag of note.tags) this.#db.run('INSERT OR IGNORE INTO memory_note_tags (n, tag) VALUES (?, ?)', row.n, tag);
    });
  }

  #forget(id: string): void {
    this.#db.transaction(() => {
      const row = this.#db.get<{ n: number }>('SELECT n FROM memory_notes WHERE id = ?', id);
      if (!row) return;
      this.#db.run('DELETE FROM memory_fts WHERE rowid = ?', row.n);
      this.#db.run('DELETE FROM memory_notes WHERE n = ?', row.n);
    });
  }

  // ---- files ------------------------------------------------------------------

  /**
   * The real path of a note's file, or null when the id cannot name a file in
   * the store: it would leave the root, or some part of the way is a symbolic
   * link (a link could lead into another folder, or anywhere).
   */
  async #locate(id: string): Promise<string | null> {
    const relative = `${id}${NOTE_EXTENSION}`;
    let root: string;
    try {
      root = await fs.realpath(this.rootDir);
    } catch (error) {
      // No store directory yet: there is no such file.
      if (errorCode(error) === 'ENOENT') return null;
      throw error;
    }
    try {
      const real = await confine(root, relative);
      return real === path.join(root, ...relative.split('/')) ? real : null;
    } catch (error) {
      if (isStudioError(error)) return null;
      throw error;
    }
  }

  /** Reads a note from its file, correcting the index if the file has changed. Null when there is no such file. */
  async read(ref: NoteRef): Promise<LoadedNote | null> {
    const file = await this.#locate(ref.id);
    if (!file) return null;
    let stat: Stats;
    try {
      stat = await fs.lstat(file);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT' && errorCode(error) !== 'ENOTDIR') throw error;
      this.#forget(ref.id);
      return null;
    }
    if (!stat.isFile()) return null;
    const loaded = await this.#load(ref, file, stat);
    if (!loaded) {
      this.#forget(ref.id);
      return null;
    }
    const row = this.#db.get<{ version: string; mtime_ms: number; size: number }>('SELECT version, mtime_ms, size FROM memory_notes WHERE id = ?', ref.id);
    if (!row || row.version !== loaded.note.version || row.mtime_ms !== loaded.mtimeMs || row.size !== loaded.note.size) {
      this.#save(loaded.note, loaded.body, loaded.mtimeMs);
    }
    return loaded.note;
  }

  /** Where a note is to be written, with its directory made. Refuses a place that is reached through a symbolic link. */
  async #place(ref: NoteRef): Promise<string> {
    await fs.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    const file = await this.#locate(ref.id);
    if (!file) throw badRequest('Notes cannot be written there: part of that path is a link to somewhere else.', undefined, MEMORY_ERRORS.invalidFolder);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    return file;
  }

  async #writeTemporary(directory: string, text: string): Promise<string> {
    const temporary = path.join(directory, `.${randomBytes(9).toString('hex')}.tmp`);
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    return temporary;
  }

  async #afterWrite(ref: NoteRef, file: string, updated: number): Promise<LoadedNote> {
    // The file's time is set to the note's own "updated", so the two agree to the millisecond.
    const time = new Date(updated);
    await fs.utimes(file, time, time);
    const loaded = await this.#load(ref, file, await fs.lstat(file));
    if (!loaded) throw new MemoryStoreError('store_unreadable', new Error('the note vanished while it was being written'));
    this.#save(loaded.note, loaded.body, loaded.mtimeMs);
    return loaded.note;
  }

  /** Puts `source` at `target` only if nothing is there. Returns false when something is. */
  async #linkNew(source: string, target: string): Promise<boolean> {
    try {
      // A hard link fails when the name exists, which makes "create only if absent" one step.
      await fs.link(source, target);
    } catch (error) {
      if (errorCode(error) === 'EEXIST') return false;
      // File systems without hard links: check, then rename.
      if (await fs.lstat(target).then(() => true, () => false)) return false;
      await fs.rename(source, target);
      return true;
    }
    await fs.rm(source, { force: true });
    return true;
  }

  /** Writes a new note. Returns null, and writes nothing, when a file with that name is already there. */
  async create(ref: NoteRef, draft: NoteDraft): Promise<LoadedNote | null> {
    const file = await this.#place(ref);
    const temporary = await this.#writeTemporary(path.dirname(file), serialiseNote(draft));
    try {
      if (!(await this.#linkNew(temporary, file))) return null;
    } finally {
      await fs.rm(temporary, { force: true });
    }
    return this.#afterWrite(ref, file, draft.updated);
  }

  /** Replaces a note's file in one step. */
  async replace(ref: NoteRef, draft: NoteDraft): Promise<LoadedNote> {
    const file = await this.#place(ref);
    const temporary = await this.#writeTemporary(path.dirname(file), serialiseNote(draft));
    try {
      await fs.rename(temporary, file);
    } finally {
      await fs.rm(temporary, { force: true });
    }
    return this.#afterWrite(ref, file, draft.updated);
  }

  /**
   * Moves a note. With a `draft` the note is rewritten at the new place (its
   * title or author changed too); without one the file is moved untouched.
   * Returns null, and changes nothing, when the target name is taken.
   */
  async move(from: NoteRef, to: NoteRef, draft: NoteDraft | null): Promise<LoadedNote | null> {
    const source = await this.#locate(from.id);
    if (!source) throw notFound('No such note.', MEMORY_ERRORS.noteNotFound);
    const target = await this.#place(to);
    let moved: LoadedNote;
    if (draft) {
      const temporary = await this.#writeTemporary(path.dirname(target), serialiseNote(draft));
      try {
        if (!(await this.#linkNew(temporary, target))) return null;
      } finally {
        await fs.rm(temporary, { force: true });
      }
      await fs.rm(source, { force: true });
      moved = await this.#afterWrite(to, target, draft.updated);
    } else {
      const stat = await fs.lstat(source);
      if (!(await this.#linkNew(source, target))) return null;
      const loaded = await this.#load(to, target, { mtimeMs: stat.mtimeMs, size: stat.size });
      if (!loaded) throw new MemoryStoreError('store_unreadable', new Error('the note vanished while it was being moved'));
      this.#save(loaded.note, loaded.body, loaded.mtimeMs);
      moved = loaded.note;
    }
    this.#forget(from.id);
    await this.#prune(path.dirname(source));
    return moved;
  }

  /** Deletes a note's file. Returns false when there was none. */
  async remove(ref: NoteRef): Promise<boolean> {
    const file = await this.#locate(ref.id);
    if (!file) {
      this.#forget(ref.id);
      return false;
    }
    try {
      await fs.unlink(file);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT' && errorCode(error) !== 'ENOTDIR') throw error;
      this.#forget(ref.id);
      return false;
    }
    this.#forget(ref.id);
    await this.#prune(path.dirname(file));
    return true;
  }

  /** Removes sub-folders a move or delete left empty. Top-level folders stay. */
  async #prune(directory: string): Promise<void> {
    const root = await fs.realpath(this.rootDir);
    let current = directory;
    while (path.dirname(current) !== root && current !== root && current.startsWith(root + path.sep)) {
      try {
        await fs.rmdir(current);
      } catch {
        return;
      }
      current = path.dirname(current);
    }
  }

  // ---- reading the index ------------------------------------------------------

  /** The index row of a note, without touching its file. */
  find(id: string): IndexedNote | null {
    const row = this.#db.get<NoteRow>(`SELECT ${NOTE_COLUMNS} FROM memory_notes n WHERE n.id = ?`, id);
    return row ? toNote(row) : null;
  }

  /**
   * Notes in `dir` that a new note called `slug` would collide with: the same
   * file name, a file name that differs only in case or punctuation, or the
   * same title under another file name.
   */
  findByName(dir: string, slug: string): IndexedNote[] {
    return this.#db
      .all<NoteRow>(`SELECT ${NOTE_COLUMNS} FROM memory_notes n WHERE n.dir = ? AND (n.name = ? OR n.name_key = ? OR n.title_key = ?) ORDER BY n.id`, dir, slug, slug, slug)
      .map(toNote);
  }

  recent(scope: QueryScope, limit: number, offset: number): IndexedNote[] {
    return this.#db
      .all<NoteRow>(`SELECT ${NOTE_COLUMNS} FROM memory_notes n WHERE ${SCOPE_SQL} ORDER BY n.updated_at DESC, n.id LIMIT ? OFFSET ?`, ...scopeParams(scope), limit, offset)
      .map(toNote);
  }

  count(scope: QueryScope): number {
    return this.#db.get<{ total: number }>(`SELECT COUNT(*) AS total FROM memory_notes n WHERE ${SCOPE_SQL}`, ...scopeParams(scope))!.total;
  }

  /** Notes per top-level folder, sub-folders included. */
  folderCounts(scope: QueryScope): Map<string, number> {
    const rows = this.#db.all<{ folder: string; total: number }>(`SELECT n.folder, COUNT(*) AS total FROM memory_notes n WHERE ${SCOPE_SQL} GROUP BY n.folder`, ...scopeParams(scope));
    return new Map(rows.map((row) => [row.folder, row.total]));
  }

  /** How many notes in scope are withheld from assistants, and how many could not be read. */
  flagged(scope: QueryScope): { withheld: number; unreadable: number } {
    return this.#db.get<{ withheld: number; unreadable: number }>(
      `SELECT COALESCE(SUM(n.credential IS NOT NULL), 0) AS withheld, COALESCE(SUM(n.problem IS NOT NULL), 0) AS unreadable FROM memory_notes n WHERE ${SCOPE_SQL}`,
      ...scopeParams(scope),
    )!;
  }

  tags(scope: QueryScope, limit = 200): { tag: string; count: number }[] {
    return this.#db.all<{ tag: string; count: number }>(
      `SELECT t.tag AS tag, COUNT(*) AS count FROM memory_note_tags t JOIN memory_notes n ON n.n = t.n
       WHERE ${SCOPE_SQL} GROUP BY t.tag ORDER BY count DESC, t.tag LIMIT ?`,
      ...scopeParams(scope),
      limit,
    );
  }

  /** Titles, tags and keywords of every clean note in scope — small columns only — for matching a message against keywords. */
  labels(scope: QueryScope, limit: number): { id: string; title: string; tags: string[]; keywords: string[] }[] {
    return this.#db
      .all<{ id: string; title: string; tags: string; keywords: string }>(
        `SELECT n.id, n.title, n.tags, n.keywords FROM memory_notes n WHERE ${SCOPE_SQL} ORDER BY n.updated_at DESC LIMIT ?`,
        ...scopeParams({ ...scope, cleanOnly: true }),
        limit,
      )
      .map((row) => ({ id: row.id, title: row.title, tags: parseStringList(row.tags), keywords: parseStringList(row.keywords) }));
  }

  /**
   * Notes in scope that contain any unit of the query, each with the start of
   * its body. At most {@link CANDIDATE_LIMIT} from the full-text index (best
   * first by the index's own ranking) and as many from the short-word scan
   * (newest first); the caller ranks them. `capped` says a limit was reached.
   */
  candidates(query: ParsedQuery, scope: QueryScope): { notes: Candidate[]; capped: boolean } {
    const found = new Map<number, NoteRow & { head: string }>();
    let capped = false;
    const select = `SELECT ${NOTE_COLUMNS}, substr(f.body, 1, ${SCORING_BODY_CHARS}) AS head FROM memory_fts f JOIN memory_notes n ON n.n = f.rowid`;

    if (query.match) {
      const rows = this.#db.all<NoteRow & { head: string }>(
        `${select} WHERE memory_fts MATCH ? AND ${SCOPE_SQL} ORDER BY bm25(memory_fts, 8.0, 1.0, 4.0, 6.0) LIMIT ?`,
        query.match,
        ...scopeParams(scope),
        CANDIDATE_LIMIT,
      );
      if (rows.length >= CANDIDATE_LIMIT) capped = true;
      for (const row of rows) found.set(row.n, row);
    }
    if (query.short.length > 0) {
      // One fixed clause per short word; the words themselves are bound.
      const clause = `(f.title LIKE ? ESCAPE '\\' OR f.keywords LIKE ? ESCAPE '\\' OR f.tags LIKE ? ESCAPE '\\' OR f.body LIKE ? ESCAPE '\\')`;
      const patterns = query.short.flatMap((word) => {
        const pattern = `%${escapeLike(word)}%`;
        return [pattern, pattern, pattern, pattern];
      });
      const rows = this.#db.all<NoteRow & { head: string }>(
        `${select} WHERE (${query.short.map(() => clause).join(' OR ')}) AND ${SCOPE_SQL} ORDER BY n.updated_at DESC LIMIT ?`,
        ...patterns,
        ...scopeParams(scope),
        CANDIDATE_LIMIT,
      );
      if (rows.length >= CANDIDATE_LIMIT) capped = true;
      for (const row of rows) found.set(row.n, row);
    }
    return { notes: [...found.values()].map((row) => ({ ...toNote(row), bodyHead: row.head })), capped };
  }

  /** The start of a note's indexed body. */
  bodyHead(id: string, maxChars: number): string {
    return (
      this.#db.get<{ head: string }>('SELECT substr(f.body, 1, ?) AS head FROM memory_fts f JOIN memory_notes n ON n.n = f.rowid WHERE n.id = ?', maxChars, id)?.head ?? ''
    );
  }
}
