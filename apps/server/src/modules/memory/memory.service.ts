import os from 'node:os';
import path from 'node:path';
import {
  MEMORY_CHANGED,
  MEMORY_ERRORS,
  MEMORY_LIMITS,
  memoryTopic,
  type CreateMemoryNoteRequest,
  type MemoryChangedEvent,
  type MemoryCredentialKind,
  type MemoryFolder,
  type MemoryFoldersResponse,
  type MemoryListQuery,
  type MemoryListResponse,
  type MemoryNote,
  type MemoryNoteSummary,
  type MemoryReindexResponse,
  type MemorySearchQuery,
  type MemorySearchResponse,
  type MemoryStatus,
  type MemoryTagsResponse,
  type MoveMemoryNoteRequest,
  type ProjectAccess,
  type UpdateMemoryNoteRequest,
  type User,
} from '@agent-studio/protocol';
import type { FastifyBaseLogger } from 'fastify';
import type { AgentToolContext } from '../../kernel/agent-tools.js';
import type { Database } from '../../kernel/database.js';
import { badRequest, conflict, describeError, forbidden, isStudioError, notFound, unavailable, unprocessable } from '../../kernel/errors.js';
import type { EventBus } from '../../kernel/events.js';
import type { ModuleContext, Services } from '../../kernel/module.js';
import type { Principal } from '../../kernel/principal.js';
import { redactSecrets } from '../../kernel/redact.js';
import { describeCredentialKind, findCredentialInNote } from './credentials.js';
import { MEMORY_AGENT_GUIDE, attribute, frameBlock, frameNote, toPlainText, truncate } from './framing.js';
import { splitKeywordLine, type NoteDraft } from './front-matter.js';
import { MemoryStoreError, type Candidate, type IndexedNote, type LoadedNote, type MemoryStore, type QueryScope, type StoreProblem } from './memory.store.js';
import {
  GLOBAL_FOLDER,
  agentAuthor,
  cleanKeywords,
  cleanTags,
  cleanTitle,
  disambiguatedFolderName,
  folderNameForDirectory,
  normaliseSubfolders,
  parseFolderPath,
  parseNoteId,
  slugify,
  splitSubfolder,
  userAuthor,
  type NoteRef,
} from './names.js';
import { contextUnits, findHighlights, makeSnippet, mentions, parseQuery, scoreFields, type ParsedQuery } from './search.js';

/**
 * Who may see and change what in shared memory, for people and for assistants
 * alike. Every way into memory — the REST API, the tools offered to agents,
 * the background attached to API-model chats — goes through this class, so
 * the rules live in one place:
 *
 * **A person**
 * - `global`: every signed-in user reads it; the owner writes it.
 * - a project's folder: follows the person's access to that project
 *   (read → read, write → write). No access to the project, no folder.
 * - the owner also sees folders on disk that belong to no current project.
 *
 * **An agent run** (identified by its {@link AgentToolContext}, never by
 * anything the model sends)
 * - the folder of the project the run belongs to, with the access the run's
 *   user has to that project, plus `global` — writable only when the run's
 *   user is the owner. A run outside any project, and a run in the scratch
 *   workspace (which exists for conversations that belong to no project),
 *   reaches `global` only.
 * - An agent replaces, edits, moves and deletes only notes that carry its own
 *   author label. Notes by people, by other assistants or without an author
 *   can be read, never overwritten.
 * - A note that appears to contain a credential is never given to an agent.
 *
 * A folder the caller may not see behaves exactly like one that does not exist.
 *
 * **Project folders.** A project's folder is named after the last segment of
 * its working directory, lower-cased and made filename-safe ("My App" →
 * `my-app`). The name is stored the first time it is needed, so everyone
 * resolves the same folder from then on. When the name is taken by another
 * project the newcomer gets `<name>-<six hex digits of a hash of its
 * directory>` — the same suffix whatever order projects are added in.
 *
 * **Removing a project keeps its notes.** They are the user's knowledge, so
 * the files stay where they are; only the link between folder and project is
 * released. The folder then belongs to no project: the owner still sees it
 * (kind `unassigned`) and can read, move or delete its notes; members and
 * agents no longer reach it. Adding a project for the *same* working
 * directory again re-attaches the folder. A different directory that happens
 * to have the same name does not inherit it — it gets a disambiguated name.
 * Removing a user needs no clean-up: author labels are plain text.
 */

declare module '../../kernel/module.js' {
  interface Services {
    memory: MemoryService;
  }
}

/** Limits on what an assistant may store; tighter than what a person may. */
export const AGENT_WRITE_LIMITS = { bodyChars: MEMORY_LIMITS.agentBodyChars, tags: 6, keywords: 8 } as const;
const PERSON_WRITE_LIMITS = { bodyChars: MEMORY_LIMITS.bodyChars, tags: MEMORY_LIMITS.tags, keywords: MEMORY_LIMITS.keywords } as const;

/** Bounds of what is handed to a model. */
export const AGENT_READ_LIMITS = {
  /** Characters of a note returned by one read. */
  readChars: 6_000,
  searchResults: 10,
  searchExcerptChars: 300,
  listEntries: 40,
} as const;

export const CONTEXT_LIMITS = {
  notes: 5,
  excerptChars: 600,
  /** All excerpts together. */
  totalExcerptChars: 3_600,
  /** The whole block, frame included. */
  blockChars: 8_000,
  /** Titles of other recent project notes listed when little matched. */
  titles: 4,
  /** The whole lookup is abandoned after this long. */
  timeoutMs: 1_500,
  /** How long the lookup waits for the files to be re-checked before using the index as it is. */
  refreshWaitMs: 400,
} as const;

/** A note attaches to a chat only with real evidence: a word in its title, keywords or tags, or several words in its text. */
const CONTEXT_MIN_SCORE = 8;

export type MemoryContextState = 'attached' | 'none' | 'off' | 'unavailable' | 'timeout';

export interface MemoryContext {
  /**
   * `attached` — `text` holds background for the model.
   * `none` — nothing relevant, or this run has no memory.
   * `off` — the owner switched assistant access to memory off.
   * `unavailable` — the store or its index failed; carry on without memory.
   * `timeout` — the lookup did not finish in time; carry on without memory.
   */
  readonly state: MemoryContextState;
  /** Ready to append to the model's instructions; null unless `attached`. */
  readonly text: string | null;
  /** The notes inside `text`. */
  readonly notes: readonly { id: string; title: string; folder: string }[];
  /** Notes that matched but were left out because they appear to contain a credential. */
  readonly withheld: number;
  readonly tookMs: number;
}

export type AgentScopeChoice = 'all' | 'project' | 'global';

interface Caller {
  readonly kind: 'person' | 'agent';
  /** Recorded as the author of what this caller writes. */
  readonly author: string;
  /** What the caller may do in each top-level folder it can see. */
  readonly access: ReadonlyMap<string, ProjectAccess>;
  /** For an agent: the folder of the run's project, when it has one. */
  readonly projectFolder: string | null;
}

interface PreparedContent {
  readonly title: string;
  readonly slug: string;
  readonly body: string;
  readonly tags: string[];
  readonly keywords: string[];
}

const noteNotFound = () => notFound('No such note.', MEMORY_ERRORS.noteNotFound);
const folderNotFound = () => notFound('No such memory folder.', MEMORY_ERRORS.folderNotFound);
const readOnly = (message = 'You can read this memory folder but not change it.') => forbidden(message, MEMORY_ERRORS.readOnly);
const credentialRefused = (kind: MemoryCredentialKind) =>
  unprocessable(
    `This looks like it contains ${describeCredentialKind(kind)}. Memory is shared with every assistant, so it must not hold credentials. Remove it and try again.`,
    MEMORY_ERRORS.credential,
    { kind },
  );

const toSummary = (note: IndexedNote): MemoryNoteSummary => ({
  id: note.id,
  folder: note.folder,
  path: note.dir,
  title: note.title,
  author: note.author,
  tags: note.tags,
  createdAt: note.createdAt,
  updatedAt: note.updatedAt,
  credential: note.credential,
  problem: note.problem,
});

function toNote(note: LoadedNote, access: ProjectAccess): MemoryNote {
  const truncated = note.body.length > MEMORY_LIMITS.readChars;
  return {
    ...toSummary(note),
    body: truncated ? note.body.slice(0, MEMORY_LIMITS.readChars) : note.body,
    truncated,
    keywords: note.keywords,
    version: note.version,
    access,
  };
}

const refOf = (note: { id: string; folder: string; dir: string; name: string }): NoteRef => ({ id: note.id, folder: note.folder, dir: note.dir, name: note.name });

// eslint-disable-next-line no-control-regex
const STRAY_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Limits for rewriting a note whose tags or keywords stay as they are: what it already carries is not cut down. */
const keeping = <L extends { tags: number; keywords: number }>(limits: L, current: { tags: readonly string[]; keywords: readonly string[] }, changing: { tags: boolean; keywords: boolean }): L => ({
  ...limits,
  tags: changing.tags ? limits.tags : Math.max(limits.tags, current.tags.length),
  keywords: changing.keywords ? limits.keywords : Math.max(limits.keywords, current.keywords.length),
});

/** A tag to filter by, cleaned like stored tags are. One that cleans to nothing matches no note ("#" is never part of a tag). */
const cleanTagFilter = (tag: string | undefined): string | undefined => (tag === undefined ? undefined : (cleanTags([tag], 1)[0] ?? '#'));

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let from = haystack.indexOf(needle); from !== -1; from = haystack.indexOf(needle, from + needle.length)) count += 1;
  return count;
}

export class MemoryService {
  readonly #db: Database;
  readonly #bus: EventBus;
  readonly #log: FastifyBaseLogger;
  readonly #services: Services;
  readonly #store: MemoryStore;

  constructor(context: Pick<ModuleContext, 'db' | 'bus' | 'log' | 'services'>, store: MemoryStore) {
    this.#db = context.db;
    this.#bus = context.bus;
    this.#log = context.log;
    this.#services = context.services;
    this.#store = store;
    store.onExternalChange = (folders) => {
      for (const folder of folders) this.#announce(folder, { action: 'reindexed' });
    };
  }

  // ---- plumbing ---------------------------------------------------------------

  /** Turns a failure of the files or the index into "unavailable"; errors meant for the caller pass through. */
  async #guard<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (isStudioError(error)) throw error;
      this.#log.error(
        { err: redactSecrets(describeError(error)), problem: error instanceof MemoryStoreError ? error.problem : undefined },
        'memory is unavailable',
      );
      throw unavailable('Memory is not available right now.', MEMORY_ERRORS.unavailable);
    }
  }

  #announce(folder: string, event: MemoryChangedEvent): void {
    this.#bus.publish(memoryTopic(folder), MEMORY_CHANGED, event);
  }

  // ---- project folders --------------------------------------------------------

  /**
   * The memory folder of a project, assigning one on first use. Stable from
   * then on. See the class comment for how names are chosen.
   */
  folderOfProject(project: { id: string; rootDir: string }): string {
    const assigned = this.#db.get<{ folder: string }>('SELECT folder FROM memory_folders WHERE project_id = ?', project.id);
    if (assigned) return assigned.folder;
    return this.#db.transaction(() => {
      const mine = this.#db.get<{ folder: string }>('SELECT folder FROM memory_folders WHERE project_id = ?', project.id);
      if (mine) return mine.folder;
      const base = folderNameForDirectory(path.basename(project.rootDir));
      for (let attempt = -1; attempt < 12; attempt += 1) {
        const folder = attempt === -1 ? base : disambiguatedFolderName(base, project.rootDir, attempt);
        if (folder === GLOBAL_FOLDER) continue;
        const row = this.#db.get<{ project_id: string | null; root_dir: string }>('SELECT project_id, root_dir FROM memory_folders WHERE folder = ?', folder);
        if (!row) {
          this.#db.run('INSERT INTO memory_folders (folder, project_id, root_dir, created_at) VALUES (?, ?, ?, ?)', folder, project.id, project.rootDir, Date.now());
          return folder;
        }
        // Released by a project that lived in this very directory: the same project, added again.
        if (row.project_id === null && row.root_dir === project.rootDir) {
          this.#db.run('UPDATE memory_folders SET project_id = ?, released_at = NULL WHERE folder = ?', project.id, folder);
          return folder;
        }
      }
      throw new Error('No memory folder name is free for this project.');
    });
  }

  /** Called when a project is removed: its notes stay on disk, the folder stops belonging to a project. */
  releaseProject(projectId: string): void {
    this.#db.run('UPDATE memory_folders SET project_id = NULL, released_at = ? WHERE project_id = ?', Date.now(), projectId);
  }

  /** Whether a principal may subscribe to a folder's realtime topic. */
  canSee(user: Principal, folder: string): boolean {
    try {
      return this.#person(user).access.has(folder);
    } catch {
      return false;
    }
  }

  // ---- callers ----------------------------------------------------------------

  #person(user: Principal): Caller {
    const access = new Map<string, ProjectAccess>();
    const projects = this.#services.projects.list(user, { includeArchived: true }).filter((project) => !project.scratch);
    if (user.role === 'owner') {
      access.set(GLOBAL_FOLDER, 'write');
      for (const folder of this.#store.diskFolders) access.set(folder, 'write');
      for (const row of this.#db.all<{ folder: string }>('SELECT DISTINCT folder FROM memory_notes')) access.set(row.folder, 'write');
      for (const project of projects) access.set(this.folderOfProject(project), 'write');
    } else {
      access.set(GLOBAL_FOLDER, 'read');
      for (const project of projects) access.set(this.folderOfProject(project), project.access);
    }
    return { kind: 'person', author: userAuthor(user.username), access, projectFolder: null };
  }

  /** The scope of an agent run, from the run's identity alone. Null when the run's user is gone or disabled. */
  #agent(run: AgentToolContext): Caller | null {
    const user: User | null = this.#services.auth.findUser(run.userId);
    if (!user || user.disabled) return null;
    const access = new Map<string, ProjectAccess>([[GLOBAL_FOLDER, user.role === 'owner' ? 'write' : 'read']]);
    let projectFolder: string | null = null;
    if (run.projectId) {
      const project = this.#services.projects.find(run.projectId);
      if (project && !this.#services.projects.settingsOf(project).scratch) {
        const principal: Principal = {
          userId: user.id,
          username: user.username,
          displayName: user.displayName,
          role: user.role,
          via: 'token',
          credentialId: `run:${run.runId}`,
          scopes: ['read', 'write'],
          authenticatedAt: 0,
        };
        const level = this.#services.projects.accessOf(principal, project.id);
        if (level) {
          projectFolder = this.folderOfProject(project);
          access.set(projectFolder, level);
        }
      }
    }
    return { kind: 'agent', author: agentAuthor(run.agentId), access, projectFolder };
  }

  #requireAgent(run: AgentToolContext): Caller {
    const caller = this.#agent(run);
    if (!caller) throw forbidden('Memory is not available to this run.', MEMORY_ERRORS.unavailable);
    return caller;
  }

  /** The folders an agent means by "all", "project" or "global". */
  #agentFolders(caller: Caller, choice: AgentScopeChoice): string[] {
    if (choice === 'global') return [GLOBAL_FOLDER];
    if (choice === 'project') {
      if (!caller.projectFolder) throw badRequest('This conversation does not belong to a project, so only global memory is available here.', undefined, MEMORY_ERRORS.folderNotFound);
      return [caller.projectFolder];
    }
    return [...caller.access.keys()];
  }

  #scope(caller: Caller, folderPath: string | undefined, tag?: string): QueryScope {
    const cleanTag = cleanTagFilter(tag);
    if (folderPath === undefined) return { folders: [...caller.access.keys()], tag: cleanTag };
    const ref = parseFolderPath(folderPath);
    if (!ref || !caller.access.has(ref.folder)) throw folderNotFound();
    return { folders: [ref.folder], path: ref.rest.length > 0 ? ref.path : undefined, tag: cleanTag };
  }

  // ---- validated writes -------------------------------------------------------

  /**
   * Checks and cleans what is about to be stored. The title rules and the
   * size rules apply to what is new: a title or a text that is already on
   * disk (a file somebody wrote by hand may break either rule) is kept as it
   * is when only something else about the note changes. The credential check
   * always covers the whole note. A keyword line at the end of the body is
   * folded into the keywords.
   */
  #prepare(
    input: { title: string; body: string; tags: readonly string[]; keywords: readonly string[] },
    limits: { bodyChars: number; tags: number; keywords: number },
    fresh: { title: boolean; body: boolean },
  ): PreparedContent {
    const titleIsNew = fresh.title;
    let title = input.title;
    if (titleIsNew) {
      const cleaned = cleanTitle(input.title);
      if (!cleaned) {
        throw badRequest(`A title is 1 to ${MEMORY_LIMITS.titleChars} characters on one line, without slashes.`, undefined, MEMORY_ERRORS.invalidTitle);
      }
      title = cleaned;
    }
    const slug = slugify(title);
    if (titleIsNew && !slug) throw badRequest('A title needs at least one letter or digit.', undefined, MEMORY_ERRORS.invalidTitle);

    const split = splitKeywordLine(input.body.replace(/\r\n?/g, '\n').replace(STRAY_CONTROLS, ''));
    if (fresh.body && split.body.trim() === '') throw badRequest('A note needs some text.', undefined, 'memory_empty_note');
    if (fresh.body && split.body.length > limits.bodyChars) {
      throw badRequest(`A note can hold at most ${limits.bodyChars} characters; this one has ${split.body.length}. Shorten it or split it into several notes.`, undefined, 'memory_note_too_long');
    }
    const tags = cleanTags(input.tags, limits.tags);
    const keywords = cleanKeywords([...input.keywords, ...split.keywords], limits.keywords);
    // Checked as given as well as cleaned: clean-up lower-cases tags, and a credential must not slip in by being mangled.
    const given = (values: readonly string[]) => values.filter((value): value is string => typeof value === 'string');
    const finding = findCredentialInNote({ title, body: split.body, tags: [...given(input.tags), ...tags], keywords: [...given(input.keywords), ...keywords] });
    if (finding) throw credentialRefused(finding.kind);
    return { title, slug, body: split.body, tags, keywords };
  }

  #checkRoom(folder: string, adding: number): void {
    if (this.#store.count({ folders: [folder] }) + adding > MEMORY_LIMITS.notesPerFolder) {
      throw conflict(`This folder already holds ${MEMORY_LIMITS.notesPerFolder} notes, the most a folder can hold. Delete or merge some first.`, MEMORY_ERRORS.folderFull);
    }
  }

  /** Where a client wants a note to go: an existing top-level folder it may write, plus normalised sub-folders. */
  #targetDir(caller: Caller, folderPath: string): { folder: string; dir: string } {
    const ref = parseFolderPath(folderPath);
    if (!ref) throw badRequest('That is not a valid folder.', undefined, MEMORY_ERRORS.invalidFolder);
    const access = caller.access.get(ref.folder);
    if (!access) throw folderNotFound();
    if (access !== 'write') throw readOnly();
    const subfolders = normaliseSubfolders(ref.rest);
    if (!subfolders) throw badRequest('That is not a valid folder.', undefined, MEMORY_ERRORS.invalidFolder);
    return { folder: ref.folder, dir: [ref.folder, ...subfolders].join('/') };
  }

  // ---- people: reading --------------------------------------------------------

  async folders(user: Principal): Promise<MemoryFoldersResponse> {
    return this.#guard(async () => {
      await this.#store.refresh();
      const caller = this.#person(user);
      const names = [...caller.access.keys()];
      const counts = this.#store.folderCounts({ folders: names });
      const owners = new Map(
        this.#db.all<{ folder: string; project_id: string }>('SELECT folder, project_id FROM memory_folders WHERE project_id IS NOT NULL').map((row) => [row.folder, row.project_id]),
      );
      const folders: MemoryFolder[] = names.map((name) => {
        const projectId = owners.get(name);
        const project = projectId ? this.#services.projects.find(projectId) : null;
        return {
          name,
          kind: name === GLOBAL_FOLDER ? 'global' : project ? 'project' : 'unassigned',
          project: project ? { id: project.id, name: project.name, icon: project.icon, archived: project.archivedAt !== null } : null,
          access: caller.access.get(name)!,
          count: counts.get(name) ?? 0,
        };
      });
      folders.sort((a, b) => Number(b.kind === 'global') - Number(a.kind === 'global') || a.name.localeCompare(b.name));
      return { folders, total: folders.reduce((sum, folder) => sum + folder.count, 0) };
    });
  }

  async recent(user: Principal, query: MemoryListQuery): Promise<MemoryListResponse> {
    return this.#guard(async () => {
      await this.#store.refresh();
      const scope = this.#scope(this.#person(user), query.folder, query.tag);
      return { notes: this.#store.recent(scope, query.limit, query.offset).map(toSummary), total: this.#store.count(scope) };
    });
  }

  async tags(user: Principal, folder: string | undefined): Promise<MemoryTagsResponse> {
    return this.#guard(async () => {
      await this.#store.refresh();
      return { tags: this.#store.tags(this.#scope(this.#person(user), folder)) };
    });
  }

  /** Candidates from the index, ranked. Every candidate matched something, so each starts with one point. */
  #rank(query: ParsedQuery, scope: QueryScope): { ranked: { note: Candidate; score: number }[]; capped: boolean } {
    const { notes, capped } = this.#store.candidates(query, scope);
    const ranked = notes
      .map((note) => ({
        note,
        score:
          1 +
          scoreFields(
            { title: note.title.toLowerCase(), tags: note.tags.join(' ').toLowerCase(), keywords: note.keywords.join(' ').toLowerCase(), body: note.bodyHead.toLowerCase() },
            query,
          ),
      }))
      .sort((a, b) => b.score - a.score || b.note.updatedAt - a.note.updatedAt || a.note.id.localeCompare(b.note.id));
    return { ranked, capped };
  }

  async search(user: Principal, input: MemorySearchQuery): Promise<MemorySearchResponse> {
    const query = parseQuery(input.q);
    // Nothing to look for: answer without touching the store.
    if (query.units.length === 0) return { query: query.text, hits: [], total: 0, capped: false };
    return this.#guard(async () => {
      await this.#store.refresh();
      const scope = this.#scope(this.#person(user), input.folder);
      const { ranked, capped } = this.#rank(query, scope);
      const hits = ranked.slice(0, input.limit).map(({ note }) => ({
        ...toSummary(note),
        titleHighlights: findHighlights(note.title, query.units),
        snippet: makeSnippet(toPlainText(note.bodyHead), query.units),
      }));
      return { query: query.text, hits, total: ranked.length, capped };
    });
  }

  async read(user: Principal, id: string): Promise<MemoryNote> {
    const ref = parseNoteId(id);
    if (!ref) throw badRequest('That is not a valid note id.', undefined, 'invalid_note_id');
    return this.#guard(async () => {
      const access = this.#person(user).access.get(ref.folder);
      const note = access ? await this.#store.read(ref) : null;
      if (!access || !note) throw noteNotFound();
      return toNote(note, access);
    });
  }

  // ---- people: writing --------------------------------------------------------

  async create(user: Principal, input: CreateMemoryNoteRequest): Promise<MemoryNote> {
    return this.#guard(async () => {
      await this.#store.refresh();
      const caller = this.#person(user);
      const target = this.#targetDir(caller, input.folder);
      const content = this.#prepare(input, PERSON_WRITE_LIMITS, { title: true, body: true });
      const note = await this.#store.exclusive(() => this.#createIn(caller, target, content));
      this.#announce(note.folder, { action: 'created', id: note.id });
      return toNote(note, 'write');
    });
  }

  /** Creates a note that must not exist yet. Call inside `exclusive`. */
  async #createIn(caller: Caller, target: { folder: string; dir: string }, content: PreparedContent): Promise<LoadedNote> {
    const taken = this.#store.findByName(target.dir, content.slug)[0];
    if (taken) throw conflict('A note with this title already exists in that folder.', MEMORY_ERRORS.noteExists, { id: taken.id });
    this.#checkRoom(target.folder, 1);
    const now = Date.now();
    const draft: NoteDraft = { title: content.title, tags: content.tags, author: caller.author, created: now, updated: now, body: content.body, keywords: content.keywords };
    const ref: NoteRef = { id: `${target.dir}/${content.slug}`, folder: target.folder, dir: target.dir, name: content.slug };
    if (ref.id.length > MEMORY_LIMITS.noteIdChars) throw badRequest('That folder and title together are too long.', undefined, MEMORY_ERRORS.invalidTitle);
    const note = await this.#store.create(ref, draft);
    // A file the index had not seen yet is in the way.
    if (!note) throw conflict('A note with this title already exists in that folder.', MEMORY_ERRORS.noteExists, { id: ref.id });
    return note;
  }

  async update(user: Principal, input: UpdateMemoryNoteRequest): Promise<MemoryNote> {
    const ref = parseNoteId(input.id);
    if (!ref) throw badRequest('That is not a valid note id.', undefined, 'invalid_note_id');
    return this.#guard(async () => {
      await this.#store.refresh();
      const caller = this.#person(user);
      const access = caller.access.get(ref.folder);
      if (!access) throw noteNotFound();
      const saved = await this.#store.exclusive(async () => {
        const current = await this.#store.read(ref);
        if (!current) throw noteNotFound();
        if (access !== 'write') throw readOnly();
        if (current.problem) throw conflict('This file cannot be read as a note, so it cannot be edited here. It can be moved or deleted.', MEMORY_ERRORS.noteUnreadable);
        if (current.version !== input.baseVersion) {
          throw conflict('This note was changed somewhere else since you opened it. Reload it and apply your changes again.', MEMORY_ERRORS.noteChanged, {
            currentVersion: current.version,
          });
        }
        // The app was given only the start of a very long note; saving that back would cut the rest off.
        if (input.body !== undefined && current.body.length > MEMORY_LIMITS.readChars) {
          throw conflict('This note is longer than the app can show in full, so its text cannot be saved from here without losing the end. Edit the file itself.', MEMORY_ERRORS.noteTooLong);
        }
        const retitled = input.title !== undefined && input.title !== current.title;
        const content = this.#prepare(
          { title: retitled ? input.title! : current.title, body: input.body ?? current.body, tags: input.tags ?? current.tags, keywords: input.keywords ?? current.keywords },
          keeping(PERSON_WRITE_LIMITS, current, { tags: input.tags !== undefined, keywords: input.keywords !== undefined }),
          { title: retitled, body: input.body !== undefined },
        );
        const draft: NoteDraft = {
          title: content.title,
          tags: content.tags,
          author: caller.author,
          created: current.createdAt,
          updated: Math.max(Date.now(), current.updatedAt + 1),
          extra: current.extra,
          body: content.body,
          keywords: content.keywords,
        };
        // A new title renames the file, unless the old name already is the new title's slug.
        if (retitled && content.slug !== slugify(current.name)) {
          const target: NoteRef = { id: `${ref.dir}/${content.slug}`, folder: ref.folder, dir: ref.dir, name: content.slug };
          const taken = this.#store.findByName(ref.dir, content.slug).find((other) => other.id !== ref.id);
          if (taken) throw conflict('Another note in this folder already has that title.', MEMORY_ERRORS.noteExists, { id: taken.id });
          const moved = await this.#store.move(ref, target, draft);
          if (!moved) throw conflict('Another note in this folder already has that title.', MEMORY_ERRORS.noteExists, { id: target.id });
          return moved;
        }
        return this.#store.replace(ref, draft);
      });
      if (saved.id === ref.id) this.#announce(saved.folder, { action: 'updated', id: saved.id });
      else this.#announce(saved.folder, { action: 'moved', id: saved.id, previousId: ref.id });
      return toNote(saved, 'write');
    });
  }

  async move(user: Principal, input: MoveMemoryNoteRequest): Promise<MemoryNote> {
    const ref = parseNoteId(input.id);
    if (!ref) throw badRequest('That is not a valid note id.', undefined, 'invalid_note_id');
    return this.#guard(async () => {
      await this.#store.refresh();
      const caller = this.#person(user);
      const access = caller.access.get(ref.folder);
      if (!access) throw noteNotFound();
      const target = input.folder === undefined ? { folder: ref.folder, dir: ref.dir } : this.#targetDir(caller, input.folder);
      const moved = await this.#store.exclusive(async () => {
        const current = await this.#store.read(ref);
        if (!current) throw noteNotFound();
        // Moving a note away takes it out of its folder, so that needs write access too.
        if (access !== 'write') throw readOnly();
        if (input.baseVersion !== undefined && current.version !== input.baseVersion) {
          throw conflict('This note was changed somewhere else since you opened it. Reload it and try again.', MEMORY_ERRORS.noteChanged, { currentVersion: current.version });
        }
        return this.#relocate(caller, current, target, input.title);
      });
      if (moved.id !== ref.id) {
        this.#announce(moved.folder, { action: 'moved', id: moved.id, previousId: ref.id });
        if (moved.folder !== ref.folder) this.#announce(ref.folder, { action: 'deleted', id: ref.id });
      } else {
        this.#announce(moved.folder, { action: 'updated', id: moved.id });
      }
      return toNote(moved, 'write');
    });
  }

  /**
   * Moves and/or retitles a note. Without a new title the file is moved as it
   * is; with one it is rewritten under the new title's file name, and the
   * caller becomes its author. Call inside `exclusive`.
   */
  async #relocate(caller: Caller, current: LoadedNote, target: { folder: string; dir: string }, newTitle: string | undefined): Promise<LoadedNote> {
    const from = refOf(current);
    const retitled = newTitle !== undefined && newTitle !== current.title;
    if (retitled && current.problem) throw conflict('This file cannot be read as a note, so it cannot be given a title. It can be moved or deleted.', MEMORY_ERRORS.noteUnreadable);

    let draft: NoteDraft | null = null;
    let name = current.name;
    if (retitled) {
      const limits = caller.kind === 'agent' ? AGENT_WRITE_LIMITS : PERSON_WRITE_LIMITS;
      const content = this.#prepare(
        { title: newTitle, body: current.body, tags: current.tags, keywords: current.keywords },
        keeping(limits, current, { tags: false, keywords: false }),
        { title: true, body: false },
      );
      if (content.slug !== slugify(current.name)) name = content.slug;
      draft = {
        title: content.title,
        tags: content.tags,
        author: caller.author,
        created: current.createdAt,
        updated: Math.max(Date.now(), current.updatedAt + 1),
        extra: current.extra,
        body: content.body,
        keywords: content.keywords,
      };
    }
    const to: NoteRef = { id: `${target.dir}/${name}`, folder: target.folder, dir: target.dir, name };
    if (to.id.length > MEMORY_LIMITS.noteIdChars) throw badRequest('That folder and title together are too long.', undefined, MEMORY_ERRORS.invalidTitle);
    if (to.id === from.id) return draft ? this.#store.replace(from, draft) : current;

    const taken = this.#store.findByName(target.dir, slugify(name) || name).find((other) => other.id !== from.id);
    if (taken) throw conflict('A note with this title already exists in that folder.', MEMORY_ERRORS.noteExists, { id: taken.id });
    if (target.folder !== from.folder) this.#checkRoom(target.folder, 1);
    const moved = await this.#store.move(from, to, draft);
    if (!moved) throw conflict('A note with this title already exists in that folder.', MEMORY_ERRORS.noteExists, { id: to.id });
    return moved;
  }

  async remove(user: Principal, id: string, version: string | undefined): Promise<void> {
    const ref = parseNoteId(id);
    if (!ref) throw badRequest('That is not a valid note id.', undefined, 'invalid_note_id');
    await this.#guard(async () => {
      const access = this.#person(user).access.get(ref.folder);
      if (!access) throw noteNotFound();
      await this.#store.exclusive(async () => {
        const current = await this.#store.read(ref);
        if (!current) throw noteNotFound();
        if (access !== 'write') throw readOnly();
        if (version !== undefined && current.version !== version) {
          throw conflict('This note was changed somewhere else since you opened it. Reload it before deleting.', MEMORY_ERRORS.noteChanged, { currentVersion: current.version });
        }
        if (!(await this.#store.remove(ref))) throw noteNotFound();
      });
      this.#services.audit.record({ category: 'change', action: 'memory.note.deleted', userId: user.userId, subject: ref.id });
      this.#announce(ref.folder, { action: 'deleted', id: ref.id });
    });
  }

  // ---- status and settings ----------------------------------------------------

  /** Whether assistants may use memory at all. On unless the owner turned it off. */
  agentAccess(): boolean {
    return this.#store.getState('agent_access') !== '0';
  }

  setAgentAccess(user: Principal, enabled: boolean): void {
    if (user.role !== 'owner') throw forbidden('Only the owner of this Studio can do that.', 'owner_required');
    this.#store.setState('agent_access', enabled ? '1' : '0');
    this.#services.audit.record({ category: 'change', action: 'memory.agent-access.changed', userId: user.userId, detail: enabled ? 'on' : 'off' });
  }

  /** Never throws: a store that cannot be read is exactly what this reports. */
  async status(user: Principal): Promise<MemoryStatus> {
    let problem: StoreProblem | null = null;
    try {
      await this.#store.refresh();
    } catch (error) {
      problem = error instanceof MemoryStoreError ? error.problem : 'index_error';
    }
    const owner = user.role === 'owner';
    const status: MemoryStatus = {
      healthy: problem === null,
      problem,
      notes: 0,
      folders: 0,
      withheld: 0,
      unreadable: 0,
      indexedAt: null,
      indexStale: problem !== null,
      agentAccess: true,
      location: owner ? this.#displayLocation() : null,
      skippedFiles: owner ? (this.#store.lastSync?.skippedFiles ?? 0) : null,
    };
    try {
      const scope: QueryScope = { folders: [...this.#person(user).access.keys()] };
      const flagged = this.#store.flagged(scope);
      return {
        ...status,
        notes: this.#store.count(scope),
        folders: scope.folders.length,
        withheld: flagged.withheld,
        unreadable: flagged.unreadable,
        indexedAt: this.#store.indexedAt(),
        agentAccess: this.agentAccess(),
      };
    } catch (error) {
      this.#log.error({ err: redactSecrets(describeError(error)) }, 'memory status could not read the index');
      return { ...status, healthy: false, problem: problem ?? 'index_error', indexStale: true };
    }
  }

  #displayLocation(): string {
    const home = os.homedir();
    const root = this.#store.rootDir;
    return root === home || root.startsWith(home + path.sep) ? `~${root.slice(home.length)}` : root;
  }

  async rebuild(user: Principal): Promise<MemoryReindexResponse> {
    if (user.role !== 'owner') throw forbidden('Only the owner of this Studio can do that.', 'owner_required');
    return this.#guard(async () => {
      const summary = await this.#store.rebuild();
      return { notes: summary.notes, unreadable: summary.unreadable, skippedFiles: summary.skippedFiles, tookMs: summary.tookMs };
    });
  }

  /** Brings the index in line with the files. Used at start-up; failures are reported, not thrown. */
  async warmUp(): Promise<void> {
    try {
      const summary = await this.#store.refresh({ force: true });
      this.#log.info({ notes: summary.notes, changed: summary.changed, tookMs: summary.tookMs }, 'memory index is in line with the note files');
    } catch (error) {
      this.#log.error({ err: redactSecrets(describeError(error)) }, 'memory could not be indexed at start-up');
    }
  }

  /** Resolves when the write or walk that is under way, if any, has finished. */
  async settle(): Promise<void> {
    await this.#store.exclusive(async () => {}).catch(() => undefined);
  }

  // ---- agents -----------------------------------------------------------------

  /** A note the agent addressed by id, if it is in scope. Out of scope and missing are the same answer. */
  async #agentNote(caller: Caller, rawId: string): Promise<{ note: LoadedNote; access: ProjectAccess }> {
    const candidates = rawId.endsWith('.md') ? [rawId, rawId.slice(0, -3)] : [rawId];
    for (const candidate of candidates) {
      const ref = parseNoteId(candidate.trim());
      const access = ref ? caller.access.get(ref.folder) : undefined;
      if (!ref || !access) continue;
      const note = await this.#store.read(ref);
      if (note) return { note, access };
    }
    throw noteNotFound();
  }

  /**
   * Conventions to add to an agent's standing instructions, or null while the
   * owner has assistant access switched off (then say nothing about memory).
   */
  agentGuide(): string | null {
    try {
      return this.agentAccess() ? MEMORY_AGENT_GUIDE : null;
    } catch {
      return null;
    }
  }

  /** What an agent is told about the folders it can reach. */
  describeAgentScope(run: AgentToolContext): { projectFolder: string | null; folders: { name: string; access: ProjectAccess }[] } | null {
    const caller = this.#agent(run);
    if (!caller) return null;
    return { projectFolder: caller.projectFolder, folders: [...caller.access].map(([name, access]) => ({ name, access })) };
  }

  async agentSearch(
    run: AgentToolContext,
    input: { query: string; scope: AgentScopeChoice; limit: number },
  ): Promise<{ folders: string[]; hits: { note: IndexedNote; excerpt: string }[]; total: number; withheld: number }> {
    return this.#guard(async () => {
      const caller = this.#requireAgent(run);
      const folders = this.#agentFolders(caller, input.scope);
      const query = parseQuery(input.query);
      if (query.units.length === 0) return { folders, hits: [], total: 0, withheld: 0 };
      await this.#store.refresh();
      const { ranked } = this.#rank(query, { folders });
      const usable = ranked.filter(({ note }) => note.credential === null && note.problem === null);
      const hits = usable.slice(0, Math.min(input.limit, AGENT_READ_LIMITS.searchResults)).map(({ note }) => ({
        note,
        excerpt: makeSnippet(toPlainText(note.bodyHead), query.units, AGENT_READ_LIMITS.searchExcerptChars).text,
      }));
      return { folders, hits, total: usable.length, withheld: ranked.filter(({ note }) => note.credential !== null).length };
    });
  }

  async agentList(
    run: AgentToolContext,
    input: { scope: AgentScopeChoice; tag?: string; limit: number },
  ): Promise<{ folders: { name: string; count: number }[]; notes: IndexedNote[]; total: number; withheld: number; tags: { tag: string; count: number }[] }> {
    return this.#guard(async () => {
      const caller = this.#requireAgent(run);
      const names = this.#agentFolders(caller, input.scope);
      await this.#store.refresh();
      const everything: QueryScope = { folders: names, tag: cleanTagFilter(input.tag) };
      const clean: QueryScope = { ...everything, cleanOnly: true };
      const counts = this.#store.folderCounts(clean);
      return {
        folders: names.map((name) => ({ name, count: counts.get(name) ?? 0 })),
        notes: this.#store.recent(clean, Math.min(input.limit, AGENT_READ_LIMITS.listEntries), 0),
        total: this.#store.count(clean),
        withheld: this.#store.flagged(everything).withheld,
        tags: this.#store.tags({ folders: names, cleanOnly: true }, 30),
      };
    });
  }

  async agentRead(run: AgentToolContext, input: { id: string; offset: number }): Promise<{ note: LoadedNote; text: string; from: number; to: number }> {
    return this.#guard(async () => {
      const caller = this.#requireAgent(run);
      const { note } = await this.#agentNote(caller, input.id);
      if (note.credential) {
        throw forbidden('That note is withheld because it appears to contain a credential. Tell the user it needs their attention in the memory app; do not try to obtain its contents another way.', 'memory_note_withheld');
      }
      if (note.problem) throw forbidden('That file cannot be read as a note. Tell the user it needs their attention in the memory app.', MEMORY_ERRORS.noteUnreadable);
      const from = Math.min(Math.max(0, input.offset), note.body.length);
      const to = Math.min(note.body.length, from + AGENT_READ_LIMITS.readChars);
      return { note, text: note.body.slice(from, to), from, to };
    });
  }

  /** The reason an agent may not change a note, or null when it may. Never reveals what the note says. */
  #protection(caller: Caller, note: LoadedNote): string | null {
    if (note.author === caller.author) return null;
    const writer = note.author === null ? 'has no recorded author' : note.author.startsWith('user:') ? 'was written by a person' : `was written by another assistant (${attribute(note.author, 60)})`;
    return `The note "${attribute(note.id, 200)}" ${writer}, so it is protected: you can read it but not replace, edit, move or delete it. Add a new note under a different title, or ask the user to change it.`;
  }

  #agentTargetFolder(caller: Caller, choice: 'project' | 'global' | undefined): string {
    const folder = choice === 'global' ? GLOBAL_FOLDER : choice === 'project' ? caller.projectFolder : (caller.projectFolder ?? GLOBAL_FOLDER);
    if (!folder) throw badRequest('This conversation does not belong to a project. Use scope "global", or leave scope out.', undefined, MEMORY_ERRORS.folderNotFound);
    const access = caller.access.get(folder);
    if (access === 'write') return folder;
    if (folder === GLOBAL_FOLDER) {
      throw readOnly(
        caller.projectFolder
          ? "Global memory can be changed only in conversations of this Studio's owner. Use scope \"project\" to keep the note with this project."
          : "Global memory can be changed only in conversations of this Studio's owner, so nothing can be saved from this conversation.",
      );
    }
    throw readOnly("This conversation can read this project's memory but not change it.");
  }

  #agentSubfolders(raw: string | undefined): string[] | undefined {
    if (raw === undefined) return undefined;
    const segments = splitSubfolder(raw);
    const subfolders = segments ? normaliseSubfolders(segments) : null;
    if (!subfolders) throw badRequest(`A subfolder is up to ${MEMORY_LIMITS.subfolderDepth} plain names separated by "/".`, undefined, MEMORY_ERRORS.invalidFolder);
    return subfolders;
  }

  async agentWrite(
    run: AgentToolContext,
    input: { title: string; body: string; scope?: 'project' | 'global'; subfolder?: string; tags?: readonly string[]; keywords?: readonly string[]; replace?: boolean },
  ): Promise<{ outcome: 'created' | 'replaced'; note: LoadedNote }> {
    return this.#guard(async () => {
      const caller = this.#requireAgent(run);
      const folder = this.#agentTargetFolder(caller, input.scope);
      const dir = [folder, ...(this.#agentSubfolders(input.subfolder) ?? [])].join('/');
      const content = this.#prepare({ title: input.title, body: input.body, tags: input.tags ?? [], keywords: input.keywords ?? [] }, AGENT_WRITE_LIMITS, { title: true, body: true });
      await this.#store.refresh();
      const result = await this.#store.exclusive(async (): Promise<{ outcome: 'created' | 'replaced'; note: LoadedNote }> => {
        const matches = this.#store.findByName(dir, content.slug);
        if (matches.length > 1) {
          throw conflict(
            `Several notes in that folder already answer to this title (${matches.map((match) => `"${attribute(match.id, 120)}"`).join(', ')}), so it is not clear which one is meant. Nothing was written. Choose a more specific title.`,
            'memory_note_ambiguous',
          );
        }
        const existing = matches[0] ? await this.#store.read(refOf(matches[0])) : null;
        if (!existing) return { outcome: 'created', note: await this.#createIn(caller, { folder, dir }, content) };

        const protection = this.#protection(caller, existing);
        if (protection) throw conflict(protection, 'memory_note_protected');
        if (!input.replace) {
          throw conflict(
            `You already wrote a note with this title (id "${attribute(existing.id, 200)}"). Nothing was written. Read it with memory_read, then either send the merged whole again with replace set to true, or change part of it with memory_edit.`,
            MEMORY_ERRORS.noteExists,
          );
        }
        const draft: NoteDraft = {
          title: content.title,
          tags: content.tags,
          author: caller.author,
          created: existing.createdAt,
          updated: Math.max(Date.now(), existing.updatedAt + 1),
          extra: existing.extra,
          body: content.body,
          keywords: content.keywords,
        };
        return { outcome: 'replaced', note: await this.#store.replace(refOf(existing), draft) };
      });
      this.#announce(result.note.folder, { action: result.outcome === 'created' ? 'created' : 'updated', id: result.note.id });
      return result;
    });
  }

  async agentEdit(run: AgentToolContext, input: { id: string; operation: 'append' | 'replace'; text: string; find?: string }): Promise<{ note: LoadedNote }> {
    return this.#guard(async () => {
      const caller = this.#requireAgent(run);
      const note = await this.#store.exclusive(async () => {
        const { note: current, access } = await this.#agentNote(caller, input.id);
        if (access !== 'write') throw readOnly("This conversation can read this folder's memory but not change it.");
        const protection = this.#protection(caller, current);
        if (protection) throw conflict(protection, 'memory_note_protected');
        // Answering "found" or "not found" about a withheld note would leak what it says.
        if (current.credential || current.problem) {
          throw forbidden('That note is withheld and cannot be edited in part. You may replace it as a whole with memory_write (replace: true) or delete it.', 'memory_note_withheld');
        }
        let body: string;
        if (input.operation === 'append') {
          body = `${current.body}\n\n${input.text.trim()}`;
        } else {
          const find = input.find ?? '';
          if (find === '') throw badRequest('Give the exact passage to replace in "find".', undefined, 'memory_edit_no_match');
          const occurrences = countOccurrences(current.body, find);
          if (occurrences === 0) throw badRequest('That passage is not in the note as it is now. Nothing was changed. Read the note again and copy the passage exactly.', undefined, 'memory_edit_no_match');
          if (occurrences > 1) throw badRequest(`That passage occurs ${occurrences} times in the note. Nothing was changed. Give a longer passage that occurs once.`, undefined, 'memory_edit_ambiguous');
          body = current.body.replace(find, () => input.text);
        }
        const content = this.#prepare(
          { title: current.title, body, tags: current.tags, keywords: current.keywords },
          keeping(AGENT_WRITE_LIMITS, current, { tags: false, keywords: false }),
          { title: false, body: true },
        );
        return this.#store.replace(refOf(current), {
          title: current.title,
          tags: content.tags,
          author: caller.author,
          created: current.createdAt,
          updated: Math.max(Date.now(), current.updatedAt + 1),
          extra: current.extra,
          body: content.body,
          keywords: content.keywords,
        });
      });
      this.#announce(note.folder, { action: 'updated', id: note.id });
      return { note };
    });
  }

  async agentMove(run: AgentToolContext, input: { id: string; title?: string; scope?: 'project' | 'global'; subfolder?: string }): Promise<{ note: LoadedNote; previousId: string }> {
    return this.#guard(async () => {
      const caller = this.#requireAgent(run);
      await this.#store.refresh();
      const subfolders = this.#agentSubfolders(input.subfolder);
      const result = await this.#store.exclusive(async () => {
        const { note: current, access } = await this.#agentNote(caller, input.id);
        if (access !== 'write') throw readOnly("This conversation can read this folder's memory but not change it.");
        const protection = this.#protection(caller, current);
        if (protection) throw conflict(protection, 'memory_note_protected');
        if (current.credential || current.problem) throw forbidden('That note is withheld and cannot be moved. You may delete it.', 'memory_note_withheld');
        // The model chooses "project" or "global" at most; which folder that is comes from the run.
        const folder = input.scope === undefined ? current.folder : this.#agentTargetFolder(caller, input.scope);
        const rest = subfolders ?? current.dir.split('/').slice(1);
        const moved = await this.#relocate(caller, current, { folder, dir: [folder, ...rest].join('/') }, input.title);
        return { note: moved, previousId: current.id };
      });
      if (result.note.id !== result.previousId) {
        this.#announce(result.note.folder, { action: 'moved', id: result.note.id, previousId: result.previousId });
        const previousFolder = result.previousId.split('/')[0]!;
        if (previousFolder !== result.note.folder) this.#announce(previousFolder, { action: 'deleted', id: result.previousId });
      }
      return result;
    });
  }

  async agentDelete(run: AgentToolContext, input: { id: string }): Promise<{ id: string; title: string }> {
    return this.#guard(async () => {
      const caller = this.#requireAgent(run);
      const removed = await this.#store.exclusive(async () => {
        const { note: current, access } = await this.#agentNote(caller, input.id);
        if (access !== 'write') throw readOnly("This conversation can read this folder's memory but not change it.");
        const protection = this.#protection(caller, current);
        if (protection) throw conflict(protection, 'memory_note_protected');
        if (!(await this.#store.remove(refOf(current)))) throw noteNotFound();
        return current;
      });
      this.#services.audit.record({ category: 'change', action: 'memory.note.deleted', userId: run.userId, subject: removed.id, detail: `by ${caller.author}` });
      this.#announce(removed.folder, { action: 'deleted', id: removed.id });
      return { id: removed.id, title: removed.title };
    });
  }

  // ---- background for API-model chats ---------------------------------------------

  /**
   * Background from memory for one reply of an API model.
   *
   * Give it the run's identity and the user's message; it answers with a block
   * of the most relevant notes the run may see — framed as untrusted reference
   * data — or with nothing. Append `text` to the model's instructions when
   * `state` is `attached`; in every other state just carry on.
   *
   * Guarantees:
   * - **Never throws and never takes long.** Any failure of the files or the
   *   index gives `unavailable`; a lookup that is not done after `timeoutMs`
   *   (default 1.5 s) gives `timeout`; an aborted `signal` gives `none`.
   * - **Scope** comes from `run` alone: the project's folder plus `global`,
   *   or `global` only (see the class comment).
   * - **Bounded**: at most 5 notes, 600 characters of each, 3 600 characters
   *   of note text in total, 8 000 characters for the whole block.
   * - Notes that appear to contain a credential are left out and counted in
   *   `withheld`. Note text cannot break out of the frame.
   * - When the owner has switched assistant access off the answer is `off`
   *   and the store is not consulted.
   *
   * When fewer than three notes match in a project conversation, the titles
   * of a few other recent notes of that project are listed, so the model
   * knows what it could look up with the tools.
   */
  async contextFor(run: AgentToolContext, message: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<MemoryContext> {
    const started = performance.now();
    const answer = (state: MemoryContextState, rest: Partial<MemoryContext> = {}): MemoryContext => ({
      state,
      text: null,
      notes: [],
      withheld: 0,
      ...rest,
      tookMs: Math.round(performance.now() - started),
    });
    let timer: NodeJS.Timeout | undefined;
    let stopListening = () => {};
    try {
      if (options.signal?.aborted) return answer('none');
      if (!this.agentAccess()) return answer('off');
      const work = this.#buildContext(run, message);
      // The lookup may outlive the race; whatever it does then is nobody's concern.
      work.catch(() => undefined);
      const outcome = await Promise.race([
        work,
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), Math.max(1, options.timeoutMs ?? CONTEXT_LIMITS.timeoutMs));
        }),
        new Promise<'aborted'>((resolve) => {
          const onAbort = () => resolve('aborted');
          options.signal?.addEventListener('abort', onAbort, { once: true });
          stopListening = () => options.signal?.removeEventListener('abort', onAbort);
        }),
      ]);
      if (outcome === 'timeout') return answer('timeout');
      if (outcome === 'aborted') return answer('none');
      return answer(outcome.text === null ? 'none' : 'attached', outcome);
    } catch (error) {
      this.#log.warn({ err: redactSecrets(describeError(error)) }, 'memory background could not be prepared; the reply goes on without it');
      return answer('unavailable');
    } finally {
      if (timer) clearTimeout(timer);
      stopListening();
    }
  }

  async #buildContext(run: AgentToolContext, message: string): Promise<{ text: string | null; notes: { id: string; title: string; folder: string }[]; withheld: number }> {
    const nothing = { text: null, notes: [], withheld: 0 };
    const caller = this.#agent(run);
    if (!caller) return nothing;
    const query = contextUnits(message);
    if (query.units.length === 0) return nothing;

    // Check the files, but do not hold the reply up for it: after a short wait the index is used as it is.
    let waiting: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.#store.refresh(),
        new Promise<void>((resolve) => {
          waiting = setTimeout(resolve, CONTEXT_LIMITS.refreshWaitMs);
        }),
      ]);
    } finally {
      if (waiting) clearTimeout(waiting);
    }

    const folders = [...caller.access.keys()];
    const lowered = message.slice(0, 8_000).normalize('NFC').slice(0, 4_000).toLowerCase();
    // On equal evidence the project's own note is the more specific one.
    const nearness = (note: IndexedNote) => (note.folder === caller.projectFolder ? 2 : 0);

    // Words of the note found in the message: this is what the keyword line is for.
    const boosts = new Map<string, number>();
    for (const label of this.#store.labels({ folders }, 4_000)) {
      let boost = 0;
      for (const keyword of label.keywords) if ([...keyword].length >= 2 && mentions(lowered, keyword.toLowerCase())) boost += 8;
      for (const tag of label.tags) if ([...tag].length >= 3 && mentions(lowered, tag)) boost += 4;
      const title = label.title.toLowerCase();
      if ([...title].length >= 4 && mentions(lowered, title)) boost += 10;
      if (boost > 0) boosts.set(label.id, boost);
    }

    const scored = new Map<string, { note: IndexedNote; head: string; score: number }>();
    let withheld = 0;
    for (const { note, score } of this.#rank(query, { folders }).ranked) {
      if (note.problem) continue;
      const evidence = score - 1 + (boosts.get(note.id) ?? 0);
      if (note.credential) {
        // Counted only when it would have been attached.
        if (evidence >= CONTEXT_MIN_SCORE) withheld += 1;
        continue;
      }
      scored.set(note.id, { note, head: note.bodyHead, score: evidence });
    }
    for (const [id, boost] of boosts) {
      if (scored.has(id)) continue;
      const note = this.#store.find(id);
      if (note && !note.credential && !note.problem) scored.set(id, { note, head: this.#store.bodyHead(id, 20_000), score: boost });
    }

    const chosen = [...scored.values()]
      .filter((entry) => entry.score >= CONTEXT_MIN_SCORE)
      .map((entry) => ({ ...entry, score: entry.score + nearness(entry.note) }))
      .sort((a, b) => b.score - a.score || b.note.updatedAt - a.note.updatedAt || a.note.id.localeCompare(b.note.id))
      .slice(0, CONTEXT_LIMITS.notes);
    if (chosen.length === 0) return { ...nothing, withheld };

    let room: number = CONTEXT_LIMITS.totalExcerptChars;
    const framed: { id: string; title: string; folder: string; text: string }[] = [];
    for (const { note, head } of chosen) {
      if (room < 80) break;
      const excerpt = truncate(makeSnippet(toPlainText(head), query.units, Math.min(CONTEXT_LIMITS.excerptChars, room) - 2).text, Math.min(CONTEXT_LIMITS.excerptChars, room));
      room -= excerpt.length;
      framed.push({ id: note.id, title: note.title, folder: note.folder, text: frameNote({ ...note, part: 'excerpt' }, excerpt) });
    }

    let footer: string | undefined;
    if (caller.projectFolder && framed.length < 3) {
      const attached = new Set(framed.map((entry) => entry.id));
      const titles = this.#store
        .recent({ folders: [caller.projectFolder], cleanOnly: true }, CONTEXT_LIMITS.titles + framed.length, 0)
        .filter((note) => !attached.has(note.id))
        .slice(0, CONTEXT_LIMITS.titles)
        .map((note) => `"${attribute(note.title, 80)}"`);
      if (titles.length > 0) footer = `Other recent notes of this project (titles only): ${titles.join('; ')}`;
    }

    const build = () =>
      frameBlock({
        summary: `${framed.length} note${framed.length === 1 ? '' : 's'} from memory that may bear on the user's message:`,
        notes: framed.map((entry) => entry.text),
        footer,
      });
    let text = build();
    while (text.length > CONTEXT_LIMITS.blockChars && framed.length > 0) {
      if (footer !== undefined) footer = undefined;
      else framed.pop();
      text = build();
    }
    if (framed.length === 0) return { ...nothing, withheld };
    return { text, notes: framed.map(({ id, title, folder }) => ({ id, title, folder })), withheld };
  }
}
