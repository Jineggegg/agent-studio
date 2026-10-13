import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_PROJECT_PINS,
  PROJECT_OPENED,
  PROJECT_PINS_CHANGED,
  type CreateProjectRequest,
  type Project,
  type ProjectAccess,
  type ProjectFeature,
  type ProjectFeatures,
  type ProjectIcon,
  type ProjectMember,
  type UpdateProjectRequest,
} from '@agent-studio/protocol';
import type { StudioConfig } from '../../kernel/config.js';
import { newId } from '../../kernel/crypto.js';
import type { Database, Migration } from '../../kernel/database.js';
import { badRequest, conflict, forbidden, notFound, unavailable } from '../../kernel/errors.js';
import type { EventBus } from '../../kernel/events.js';
import { isInside } from '../../kernel/paths.js';
import type { Principal } from '../../kernel/principal.js';
import {
  checkAgentsAndFeatures,
  isAgentEnabled,
  isFeatureEnabled,
  normaliseLinks,
  readProjectSettings,
  type ProjectSettingsView,
} from './projects.settings.js';

export const PROJECTS_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'projects and members',
    sql: `
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        root_dir TEXT NOT NULL UNIQUE,
        icon TEXT NOT NULL DEFAULT '{}',
        settings TEXT NOT NULL DEFAULT '{}',
        created_by TEXT NOT NULL REFERENCES users(id),
        archived_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE project_members (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        access TEXT NOT NULL CHECK (access IN ('read', 'write')),
        PRIMARY KEY (project_id, user_id)
      );
      CREATE INDEX project_members_user ON project_members(user_id);
    `,
  },
  {
    version: 2,
    name: 'per-user pins and last-opened times',
    sql: `
      CREATE TABLE project_user_state (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        pin_position INTEGER,
        last_opened_at INTEGER,
        PRIMARY KEY (user_id, project_id)
      );
      CREATE INDEX project_user_state_project ON project_user_state(project_id);
    `,
  },
];

/** A project as the server holds it. `rootDir` is always a real, absolute path. */
export interface ProjectRecord {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly rootDir: string;
  readonly icon: ProjectIcon;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly createdBy: string;
  readonly archivedAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface ProjectRow {
  id: string;
  name: string;
  description: string;
  root_dir: string;
  icon: string;
  settings: string;
  created_by: string;
  archived_at: number | null;
  created_at: number;
  updated_at: number;
}

interface UserStateRow {
  project_id: string;
  pin_position: number | null;
  last_opened_at: number | null;
}

interface UserProjectState {
  readonly pinPosition: number | null;
  readonly lastOpenedAt: number | null;
}

const DEFAULT_ICON: ProjectIcon = { symbol: 'folder', color: 'blue' };

/** Folder of the scratch workspace inside the first workspace root. */
export const SCRATCH_FOLDER = 'studio-scratch';

/** Drops keys whose value is undefined, so that a partial patch never overwrites with "nothing". */
function definedOnly<T extends object>(value: T | undefined): Partial<T> {
  const result: Partial<T> = {};
  if (value === undefined) return result;
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) (result as Record<string, unknown>)[key] = entry;
  }
  return result;
}

const toRecord = (row: ProjectRow): ProjectRecord => ({
  id: row.id,
  name: row.name,
  description: row.description,
  rootDir: row.root_dir,
  icon: { ...DEFAULT_ICON, ...(JSON.parse(row.icon) as Partial<ProjectIcon>) },
  settings: JSON.parse(row.settings) as Record<string, unknown>,
  createdBy: row.created_by,
  archivedAt: row.archived_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** Directories that must never become (or contain) a project. */
const SYSTEM_DIRECTORIES = ['/', '/bin', '/boot', '/dev', '/etc', '/lib', '/lib64', '/proc', '/root', '/run', '/sbin', '/sys', '/usr', '/var'];

function expandHome(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

/**
 * Projects are the unit of access control: files, Git, terminals, sessions,
 * memory and automations all belong to one, and every one of those features
 * asks this service whether the caller may touch the project.
 *
 * The owner can use every project. A member can use only the projects they
 * were added to, with the access level they were given.
 */
export class ProjectsService {
  readonly #db: Database;
  readonly #bus: EventBus;
  readonly #config: StudioConfig;

  constructor(deps: { db: Database; bus: EventBus; config: StudioConfig }) {
    this.#db = deps.db;
    this.#bus = deps.bus;
    this.#config = deps.config;
  }

  // ---- access --------------------------------------------------------------

  /** The caller's access to a project, or null when they cannot see it at all. */
  accessOf(principal: Principal, projectId: string): ProjectAccess | null {
    if (principal.role === 'owner') return 'write';
    const row = this.#db.get<{ access: ProjectAccess }>(
      'SELECT access FROM project_members WHERE project_id = ? AND user_id = ?',
      projectId,
      principal.userId,
    );
    return row?.access ?? null;
  }

  /**
   * Returns the project or throws. A project the caller cannot see answers
   * exactly like one that does not exist.
   */
  requireAccess(principal: Principal, projectId: string, level: ProjectAccess = 'read'): ProjectRecord {
    const record = this.find(projectId);
    const access = record ? this.accessOf(principal, projectId) : null;
    if (!record || !access) throw notFound('No such project.', 'project_not_found');
    if (level === 'write' && access !== 'write') {
      throw forbidden('You can view this project but not change it.', 'project_read_only');
    }
    return record;
  }

  /** Ids of every project the caller can see; `null` means all of them (the owner). */
  visibleProjectIds(principal: Principal): string[] | null {
    if (principal.role === 'owner') return null;
    return this.#db
      .all<{ project_id: string }>('SELECT project_id FROM project_members WHERE user_id = ?', principal.userId)
      .map((row) => row.project_id);
  }

  // ---- reading -------------------------------------------------------------

  /** Internal lookup with no access check. */
  find(projectId: string): ProjectRecord | null {
    const row = this.#db.get<ProjectRow>('SELECT * FROM projects WHERE id = ?', projectId);
    return row ? toRecord(row) : null;
  }

  findByRootDir(rootDir: string): ProjectRecord | null {
    const row = this.#db.get<ProjectRow>('SELECT * FROM projects WHERE root_dir = ?', rootDir);
    return row ? toRecord(row) : null;
  }

  list(principal: Principal, options: { includeArchived?: boolean } = {}): Project[] {
    const rows =
      principal.role === 'owner'
        ? this.#db.all<ProjectRow & { access: ProjectAccess }>(`SELECT p.*, 'write' AS access FROM projects p ORDER BY p.name COLLATE NOCASE`)
        : this.#db.all<ProjectRow & { access: ProjectAccess }>(
            `SELECT p.*, m.access FROM projects p JOIN project_members m ON m.project_id = p.id
             WHERE m.user_id = ? ORDER BY p.name COLLATE NOCASE`,
            principal.userId,
          );
    const state = this.#userState(principal.userId);
    return rows
      .filter((row) => options.includeArchived || row.archived_at === null)
      .map((row) => this.#present(toRecord(row), row.access, state.get(row.id)));
  }

  /**
   * The project as a client sees it. Pass the caller as `viewer` to include
   * what is personal to them (pinned, last opened); without it those fields
   * carry their defaults.
   */
  present(record: ProjectRecord, access: ProjectAccess, viewer?: Principal): Project {
    return this.#present(record, access, viewer ? this.#userState(viewer.userId, record.id).get(record.id) : undefined);
  }

  #present(record: ProjectRecord, access: ProjectAccess, state: UserProjectState | undefined): Project {
    const settings = readProjectSettings(record.settings);
    return {
      id: record.id,
      name: record.name,
      description: record.description,
      rootDir: record.rootDir,
      icon: record.icon,
      access,
      archived: record.archivedAt !== null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      links: [...settings.links],
      agents: settings.agents === null ? null : [...settings.agents],
      features: settings.features,
      scratch: settings.scratch,
      pinned: state?.pinPosition != null,
      lastOpenedAt: state?.lastOpenedAt ?? null,
    };
  }

  // ---- typed settings ------------------------------------------------------

  /** The links, enabled agents and feature switches of a project. */
  settingsOf(record: ProjectRecord): ProjectSettingsView {
    return readProjectSettings(record.settings);
  }

  /** Whether an agent may be used in this project. Agents modules must ask before starting a run. */
  isAgentEnabled(record: ProjectRecord, agentId: string): boolean {
    return isAgentEnabled(readProjectSettings(record.settings), agentId);
  }

  isFeatureEnabled(record: ProjectRecord, feature: ProjectFeature): boolean {
    return isFeatureEnabled(readProjectSettings(record.settings), feature);
  }

  // ---- what is personal to a user: pins and recents ----------------------------

  #userState(userId: string, projectId?: string): Map<string, UserProjectState> {
    const rows =
      projectId === undefined
        ? this.#db.all<UserStateRow>('SELECT project_id, pin_position, last_opened_at FROM project_user_state WHERE user_id = ?', userId)
        : this.#db.all<UserStateRow>(
            'SELECT project_id, pin_position, last_opened_at FROM project_user_state WHERE user_id = ? AND project_id = ?',
            userId,
            projectId,
          );
    return new Map(rows.map((row) => [row.project_id, { pinPosition: row.pin_position, lastOpenedAt: row.last_opened_at }]));
  }

  /** The caller's pins, first pin first. Projects the caller can no longer see are left out. */
  pins(principal: Principal): string[] {
    const visible = this.visibleProjectIds(principal);
    return this.#db
      .all<{ project_id: string }>(
        'SELECT project_id FROM project_user_state WHERE user_id = ? AND pin_position IS NOT NULL ORDER BY pin_position',
        principal.userId,
      )
      .map((row) => row.project_id)
      .filter((id) => visible === null || visible.includes(id));
  }

  /** Replaces the caller's pins. Every project must be one the caller can see. */
  setPins(principal: Principal, projectIds: readonly string[]): string[] {
    if (projectIds.length > MAX_PROJECT_PINS) throw badRequest(`At most ${MAX_PROJECT_PINS} projects can be pinned.`, undefined, 'too_many_pins');
    if (new Set(projectIds).size !== projectIds.length) throw badRequest('A project can be pinned only once.');
    for (const projectId of projectIds) this.requireAccess(principal, projectId);
    this.#db.transaction(() => {
      this.#db.run('UPDATE project_user_state SET pin_position = NULL WHERE user_id = ?', principal.userId);
      projectIds.forEach((projectId, position) => {
        this.#db.run(
          `INSERT INTO project_user_state (user_id, project_id, pin_position) VALUES (?, ?, ?)
           ON CONFLICT (user_id, project_id) DO UPDATE SET pin_position = excluded.pin_position`,
          principal.userId,
          projectId,
          position,
        );
      });
      this.#db.run('DELETE FROM project_user_state WHERE user_id = ? AND pin_position IS NULL AND last_opened_at IS NULL', principal.userId);
    });
    const pins = this.pins(principal);
    this.#bus.publish(`user:${principal.userId}`, PROJECT_PINS_CHANGED, { projectIds: pins });
    return pins;
  }

  /** Remembers that the caller opened the project now, for "recent" lists on all their devices. */
  markOpened(principal: Principal, projectId: string): number {
    this.requireAccess(principal, projectId);
    const lastOpenedAt = Date.now();
    this.#db.run(
      `INSERT INTO project_user_state (user_id, project_id, last_opened_at) VALUES (?, ?, ?)
       ON CONFLICT (user_id, project_id) DO UPDATE SET last_opened_at = excluded.last_opened_at`,
      principal.userId,
      projectId,
      lastOpenedAt,
    );
    this.#bus.publish(`user:${principal.userId}`, PROJECT_OPENED, { projectId, lastOpenedAt });
    return lastOpenedAt;
  }

  // ---- location rules ------------------------------------------------------

  /**
   * Decides whether a directory may be a project and returns its real path.
   * It must be inside an allowed workspace root (after following links), must
   * not be a system directory or the home directory itself, and must stay
   * clear of the server's own data.
   */
  async resolveRootDir(requested: string, createDirectory: boolean): Promise<string> {
    if (requested.includes('\0')) throw badRequest('That path is not valid.', undefined, 'invalid_path');
    const expanded = expandHome(requested.trim());
    if (!path.isAbsolute(expanded)) {
      throw badRequest('Give the full path of the project folder.', undefined, 'invalid_path');
    }
    const wanted = path.resolve(expanded);

    // Resolve the deepest existing ancestor so links cannot smuggle the folder elsewhere.
    let existing = wanted;
    const missing: string[] = [];
    let realExisting: string;
    for (;;) {
      try {
        realExisting = await fs.realpath(existing);
        break;
      } catch {
        const parent = path.dirname(existing);
        if (parent === existing) throw badRequest('That folder does not exist.', undefined, 'invalid_path');
        missing.unshift(path.basename(existing));
        existing = parent;
      }
    }
    const real = path.join(realExisting, ...missing);

    const roots = await Promise.all(
      this.#config.workspaceRoots.map((root) => fs.realpath(root).catch(() => path.resolve(root))),
    );
    if (!roots.some((root) => isInside(root, real))) {
      throw forbidden('Projects must live inside an allowed workspace folder.', 'outside_workspace');
    }
    const home = await fs.realpath(os.homedir()).catch(() => os.homedir());
    if (real === home || SYSTEM_DIRECTORIES.includes(real)) {
      throw forbidden('That folder is too broad to be a project. Choose a folder inside it.', 'folder_not_allowed');
    }
    const dataDir = await fs.realpath(this.#config.dataDir).catch(() => path.resolve(this.#config.dataDir));
    if (isInside(dataDir, real) || isInside(real, dataDir)) {
      throw forbidden("That folder overlaps the Studio's own data and cannot be a project.", 'folder_not_allowed');
    }

    if (missing.length > 0) {
      if (!createDirectory) throw badRequest('That folder does not exist.', undefined, 'folder_missing');
      await fs.mkdir(real, { recursive: true });
    } else if (!(await fs.stat(real)).isDirectory()) {
      throw badRequest('That path is a file, not a folder.', undefined, 'invalid_path');
    }
    return real;
  }


  /**
   * Tells every account that can see a project that the list of projects changed,
   * so launchers on other devices refresh. Sent on each watcher's own topic: an
   * account that cannot see the project learns nothing, not even that it exists.
   */
  #announce(projectId: string, change: 'created' | 'updated' | 'removed', watchers?: string[]): void {
    for (const userId of watchers ?? this.#watchers(projectId)) this.#bus.publish(`user:${userId}`, 'projects.changed', { projectId, change });
  }

  #watchers(projectId: string): string[] {
    return this.#db
      .all<{ id: string }>(
        `SELECT id FROM users WHERE role = 'owner' AND disabled = 0
         UNION SELECT user_id AS id FROM project_members WHERE project_id = ?`,
        projectId,
      )
      .map((row) => row.id);
  }

  // ---- changes -------------------------------------------------------------

  async create(principal: Principal, input: CreateProjectRequest): Promise<Project> {
    if (principal.role !== 'owner') throw forbidden('Only the owner can add projects.', 'owner_required');
    // Everything that can be refused is checked before a folder is created.
    const settings: Record<string, unknown> = {};
    const features: ProjectFeatures = { ...readProjectSettings({}).features, ...definedOnly(input.features) };
    const agents = input.agents ?? null;
    checkAgentsAndFeatures(agents, features);
    if (input.links !== undefined && input.links.length > 0) settings.links = normaliseLinks(input.links, [], true);
    if (input.agents !== undefined && input.agents !== null) settings.agents = input.agents;
    if (input.features !== undefined) settings.features = features;

    const rootDir = await this.resolveRootDir(input.rootDir, input.createDirectory);
    if (this.findByRootDir(rootDir)) throw conflict('That folder is already a project.', 'project_exists');
    const now = Date.now();
    const id = newId();
    this.#db.run(
      `INSERT INTO projects (id, name, description, root_dir, icon, settings, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.name,
      input.description,
      rootDir,
      JSON.stringify(input.icon ?? DEFAULT_ICON),
      JSON.stringify(settings),
      principal.userId,
      now,
      now,
    );
    const record = this.find(id)!;
    this.#bus.publish('internal:projects', 'project.created', { projectId: id });
    this.#announce(id, 'created');
    return this.present(record, 'write');
  }

  update(principal: Principal, projectId: string, changes: UpdateProjectRequest): Project {
    const record = this.requireAccess(principal, projectId, 'write');
    const isOwner = principal.role === 'owner';
    if (changes.archived !== undefined && !isOwner) {
      throw forbidden('Only the owner can archive a project.', 'owner_required');
    }
    // Which agents and features a project offers decides what its members may use: the owner's call.
    if ((changes.agents !== undefined || changes.features !== undefined) && !isOwner) {
      throw forbidden('Only the owner can change which agents and features a project offers.', 'owner_required');
    }

    const current = readProjectSettings(record.settings);
    const settings: Record<string, unknown> = { ...record.settings };
    if (changes.links !== undefined) {
      const links = normaliseLinks(changes.links, current.links, isOwner);
      if (links.length > 0) settings.links = links;
      else delete settings.links;
    }
    if (changes.agents !== undefined || changes.features !== undefined) {
      const agents = changes.agents === undefined ? current.agents : changes.agents;
      const features: ProjectFeatures = { ...current.features, ...definedOnly(changes.features) };
      checkAgentsAndFeatures(agents, features);
      if (agents === null) delete settings.agents;
      else settings.agents = [...agents];
      settings.features = features;
    }

    const archivedAt = changes.archived === undefined ? record.archivedAt : changes.archived ? (record.archivedAt ?? Date.now()) : null;
    this.#db.run(
      `UPDATE projects SET name = ?, description = ?, icon = ?, settings = ?, archived_at = ?, updated_at = ? WHERE id = ?`,
      changes.name ?? record.name,
      changes.description ?? record.description,
      JSON.stringify(changes.icon ?? record.icon),
      JSON.stringify(settings),
      archivedAt,
      Date.now(),
      projectId,
    );
    this.#bus.publish(`project:${projectId}`, 'project.changed', { projectId });
    this.#announce(projectId, 'updated');
    return this.present(this.find(projectId)!, 'write', principal);
  }

  /**
   * The default workspace for conversations started outside any project. It
   * is an ordinary project in a fixed folder of the first workspace root,
   * created the first time it is asked for.
   */
  async ensureScratch(principal: Principal): Promise<Project> {
    if (principal.role !== 'owner') throw forbidden('Only the owner can set up the scratch workspace.', 'owner_required');
    const marked = this.#db.get<ProjectRow>(`SELECT * FROM projects WHERE json_extract(settings, '$.scratch') = 1 ORDER BY created_at LIMIT 1`);
    let record = marked ? toRecord(marked) : null;
    if (!record) {
      const base = this.#config.workspaceRoots[0];
      if (base === undefined) throw unavailable('No workspace folder is configured, so there is nowhere to put a scratch workspace.', 'no_workspace_root');
      const rootDir = await this.resolveRootDir(path.join(base, SCRATCH_FOLDER), true);
      const existing = this.findByRootDir(rootDir);
      if (existing) {
        record = this.patchSettings(existing.id, { scratch: true });
      } else {
        const created = await this.create(principal, {
          name: 'Scratch',
          rootDir,
          description: 'Conversations that do not belong to a project start here.',
          icon: { symbol: 'spark', color: 'slate' },
          createDirectory: true,
        });
        record = this.patchSettings(created.id, { scratch: true });
      }
    }
    if (record.archivedAt !== null) {
      this.#db.run('UPDATE projects SET archived_at = NULL, updated_at = ? WHERE id = ?', Date.now(), record.id);
      this.#bus.publish(`project:${record.id}`, 'project.changed', { projectId: record.id });
      record = this.find(record.id)!;
    }
    // The folder may have been deleted by hand since; a scratch workspace without a folder is useless.
    await fs.mkdir(record.rootDir, { recursive: true });
    return this.present(record, 'write', principal);
  }

  /** Merges a feature's settings into the project's settings bag. */
  patchSettings(projectId: string, patch: Record<string, unknown>): ProjectRecord {
    const record = this.find(projectId);
    if (!record) throw notFound('No such project.', 'project_not_found');
    const settings = { ...record.settings, ...patch };
    for (const [key, value] of Object.entries(settings)) if (value === null) delete settings[key];
    this.#db.run('UPDATE projects SET settings = ?, updated_at = ? WHERE id = ?', JSON.stringify(settings), Date.now(), projectId);
    this.#bus.publish(`project:${projectId}`, 'project.changed', { projectId });
    return this.find(projectId)!;
  }

  /** Forgets the project and everything the Studio stored about it. The folder and its files are never touched. */
  remove(principal: Principal, projectId: string): void {
    if (principal.role !== 'owner') throw forbidden('Only the owner can remove projects.', 'owner_required');
    if (!this.find(projectId)) throw notFound('No such project.', 'project_not_found');
    // Announce first so features can stop running work, then let the cascade clear their rows.
    const watchers = this.#watchers(projectId);
    this.#bus.publish('internal:projects', 'project.deleting', { projectId });
    this.#db.run('DELETE FROM projects WHERE id = ?', projectId);
    this.#bus.publish('internal:projects', 'project.deleted', { projectId });
    this.#announce(projectId, 'removed', watchers);
  }

  // ---- sharing -------------------------------------------------------------

  members(projectId: string): ProjectMember[] {
    return this.#db
      .all<{ user_id: string; username: string; display_name: string; access: ProjectAccess }>(
        `SELECT m.user_id, u.username, u.display_name, m.access
         FROM project_members m JOIN users u ON u.id = m.user_id
         WHERE m.project_id = ? ORDER BY u.username COLLATE NOCASE`,
        projectId,
      )
      .map((row) => ({ userId: row.user_id, username: row.username, displayName: row.display_name, access: row.access }));
  }

  setMember(projectId: string, userId: string, access: ProjectAccess | null): void {
    if (!this.find(projectId)) throw notFound('No such project.', 'project_not_found');
    if (access === null) {
      this.#db.run('DELETE FROM project_members WHERE project_id = ? AND user_id = ?', projectId, userId);
    } else {
      const user = this.#db.get<{ role: string }>('SELECT role FROM users WHERE id = ?', userId);
      if (!user) throw notFound('No such user.');
      this.#db.run(
        `INSERT INTO project_members (project_id, user_id, access) VALUES (?, ?, ?)
         ON CONFLICT (project_id, user_id) DO UPDATE SET access = excluded.access`,
        projectId,
        userId,
        access,
      );
    }
    this.#bus.publish('internal:projects', 'project.membership.changed', { projectId, userId, access });
    this.#bus.publish(`user:${userId}`, 'project.changed', { projectId });
  }
}
