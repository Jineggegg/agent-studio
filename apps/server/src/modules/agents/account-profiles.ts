import { chmod, lstat, mkdir, readdir, realpath, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createAccountProfileSchema, idSchema, type AccountProfile } from '@agent-studio/protocol';
import { z } from 'zod';
import { newId } from '../../kernel/crypto.js';
import { badRequest, conflict, notFound } from '../../kernel/errors.js';
import { requireBrowser } from '../../kernel/http.js';
import type { ModuleContext } from '../../kernel/module.js';
import type { Principal } from '../../kernel/principal.js';
import { withDirectoryInside } from '../../kernel/paths.js';

interface ProfileRow {
  id: string;
  user_id: string;
  agent_id: 'claude-code' | 'codex';
  name: string;
  is_default: number;
  created_at: number;
}
const present = (row: ProfileRow): AccountProfile => ({
  id: row.id,
  agentId: row.agent_id,
  name: row.name,
  isDefault: row.is_default === 1,
  createdAt: row.created_at,
});
const profileParams = z.object({ profileId: idSchema });

/** Credentials are created by the provider's login program in a new empty home. They are never opened by the API. */
export class AccountProfiles {
  private readonly revoked = new Set<string>();
  private readonly pending = new Map<string, Set<Promise<void>>>();
  private readonly statusControllers = new Map<string, Set<AbortController>>();

  private async operation<T>(userId: string, work: () => Promise<T>): Promise<T> {
    if (this.revoked.has(userId))
      throw notFound('No such account profile.', 'account_profile_not_found');
    let release!: () => void;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    let jobs = this.pending.get(userId);
    if (!jobs) this.pending.set(userId, (jobs = new Set()));
    jobs.add(done);
    try {
      return await work();
    } finally {
      jobs.delete(done);
      if (jobs.size === 0) this.pending.delete(userId);
      release();
    }
  }

  /** Close status probes and await any profile directory creation before deleting credentials. */
  async stopUser(userId: string): Promise<void> {
    this.revoked.add(userId);
    for (const controller of this.statusControllers.get(userId) ?? []) controller.abort();
    const pending = this.pending.get(userId);
    if (pending) await Promise.all(pending);
  }

  /** Called only after this user's processes and profile operations have settled. */
  async removeUserDirectory(userId: string): Promise<void> {
    if (!/^[0-9a-z]{26}$/.test(userId))
      throw conflict('Invalid account directory identifier.', 'profile_path_unsafe');
    // Live database references are a second guard against deleting another user's credentials.
    if (
      this.context.db.get('SELECT id FROM agent_account_profiles WHERE user_id = ? LIMIT 1', userId)
    )
      return;
    const root = path.join(this.context.config.dataDir, 'agent-accounts');
    const stat = await lstat(root).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) return;
    if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(root)) !== root)
      throw conflict('The account profile directory is not safe.', 'profile_path_unsafe');
    await withDirectoryInside(this.context.config.dataDir, root, async (directory) => {
      const target = path.join(directory, userId);
      const entry = await lstat(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!entry) return;
      if (entry.isSymbolicLink()) {
        await unlink(target);
        return;
      }
      if (!entry.isDirectory() || (await realpath(target)) !== path.join(root, userId))
        throw conflict('The account profile directory is not safe.', 'profile_path_unsafe');
      // rm unlinks symlink entries instead of visiting their targets. The parent descriptor stays
      // anchored and no process of the deleted account is permitted to be writing this tree.
      await rm(target, { recursive: true, force: true });
    });
  }

  /** Startup recovery for a crash between database deletion and credential-directory cleanup. */
  async sweepOrphans(): Promise<void> {
    const root = path.join(this.context.config.dataDir, 'agent-accounts');
    const stat = await lstat(root).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) return;
    if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(root)) !== root)
      throw conflict('The account profile directory is not safe.', 'profile_path_unsafe');
    for (const entry of await readdir(root)) {
      if (
        /^[0-9a-z]{26}$/.test(entry) &&
        !this.context.db.get(
          'SELECT id FROM agent_account_profiles WHERE user_id = ? LIMIT 1',
          entry,
        )
      )
        await this.removeUserDirectory(entry);
    }
  }
  constructor(private readonly context: ModuleContext) {}

  list(user: Principal): AccountProfile[] {
    return this.context.db
      .all<ProfileRow>(
        'SELECT * FROM agent_account_profiles WHERE user_id = ? ORDER BY agent_id, name',
        user.userId,
      )
      .map(present);
  }

  require(userId: string, profileId: string, agentId?: string): ProfileRow {
    const row = this.context.db.get<ProfileRow>(
      'SELECT * FROM agent_account_profiles WHERE id = ? AND user_id = ?',
      profileId,
      userId,
    );
    if (!row || (agentId !== undefined && row.agent_id !== agentId))
      throw notFound('No such account profile.', 'account_profile_not_found');
    return row;
  }

  resolve(userId: string, agentId: string, requested?: string | null): string | null {
    if (requested === null) return null; // Explicit host account, never rebind an existing session.
    if (requested !== undefined) return this.require(userId, requested, agentId).id;
    return (
      this.context.db.get<{ id: string }>(
        'SELECT id FROM agent_account_profiles WHERE user_id = ? AND agent_id = ? AND is_default = 1',
        userId,
        agentId,
      )?.id ?? null
    );
  }

  async environment(
    userId: string,
    profileId: string,
    agentId?: string,
  ): Promise<{ env: Record<string, string>; directory: string }> {
    return this.operation<{ env: Record<string, string>; directory: string }>(userId, async () => {
      const profile = this.require(userId, profileId, agentId);
      const root = path.join(this.context.config.dataDir, 'agent-accounts');
      const directory = path.join(root, profile.user_id, profile.id);
      // Every component is generated by the server; still refuse a symlink substituted on disk.
      for (const segment of [root, path.join(root, profile.user_id), directory]) {
        if (this.revoked.has(userId))
          throw notFound('No such account profile.', 'account_profile_not_found');
        await mkdir(segment, { recursive: true, mode: 0o700 });
        if ((await lstat(segment)).isSymbolicLink() || (await realpath(segment)) !== segment)
          throw conflict('The account profile directory is not safe.', 'profile_path_unsafe');
        await chmod(segment, 0o700);
      }
      if (this.revoked.has(userId))
        throw notFound('No such account profile.', 'account_profile_not_found');
      this.require(userId, profileId, agentId);
      const env: Record<string, string> =
        profile.agent_id === 'codex'
          ? { CODEX_HOME: directory, CODEX_SQLITE_HOME: directory }
          : { CLAUDE_CONFIG_DIR: directory };
      return {
        directory,
        env,
      };
    });
  }

  registerRoutes(): void {
    const { http, db } = this.context;
    http.route({
      method: 'GET',
      url: '/api/agent-accounts',
      access: 'user',
      handler: ({ user }) => ({ profiles: this.list(user) }),
    });
    http.route({
      method: 'POST',
      url: '/api/agent-accounts',
      access: 'owner',
      body: createAccountProfileSchema,
      handler: async ({ user, body, reply }) => {
        requireBrowser(user);
        if (
          db.get(
            'SELECT id FROM agent_account_profiles WHERE user_id = ? AND agent_id = ? AND name = ?',
            user.userId,
            body.agentId,
            body.name,
          )
        )
          throw conflict('An account profile already has that name.', 'account_profile_exists');
        const row: ProfileRow = {
          id: newId(),
          user_id: user.userId,
          agent_id: body.agentId,
          name: body.name,
          is_default: 0,
          created_at: Date.now(),
        };
        db.run(
          'INSERT INTO agent_account_profiles (id, user_id, agent_id, name, is_default, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          row.id,
          row.user_id,
          row.agent_id,
          row.name,
          row.is_default,
          row.created_at,
        );
        try {
          await this.environment(user.userId, row.id);
        } catch (error) {
          db.run('DELETE FROM agent_account_profiles WHERE id = ?', row.id);
          throw error;
        }
        void reply.status(201);
        return present(row);
      },
    });
    http.route({
      method: 'PUT',
      url: '/api/agent-accounts/:profileId/default',
      access: 'user',
      params: profileParams,
      handler: ({ user, params }) => {
        requireBrowser(user);
        const profile = this.require(user.userId, params.profileId);
        db.transaction(() => {
          db.run(
            'UPDATE agent_account_profiles SET is_default = 0 WHERE user_id = ? AND agent_id = ?',
            user.userId,
            profile.agent_id,
          );
          db.run(
            'UPDATE agent_account_profiles SET is_default = 1 WHERE id = ? AND user_id = ?',
            profile.id,
            user.userId,
          );
        });
        return { ...present(profile), isDefault: true };
      },
    });
    http.route({
      method: 'GET',
      url: '/api/agent-accounts/:profileId/status',
      access: 'user',
      params: profileParams,
      handler: async ({ user, params }) => {
        return this.status(user.userId, params.profileId);
      },
    });
  }

  async status(
    userId: string,
    profileId: string,
  ): Promise<{ signedIn: boolean | null; checkedAt: number }> {
    return this.operation(userId, async () => {
      const controller = new AbortController();
      let controllers = this.statusControllers.get(userId);
      if (!controllers) this.statusControllers.set(userId, (controllers = new Set()));
      controllers.add(controller);
      try {
        const profile = this.require(userId, profileId);
        const isolated = await this.environment(userId, profile.id);
        const file = profile.agent_id === 'codex' ? 'codex' : 'claude';
        const args =
          profile.agent_id === 'codex' ? ['login', 'status'] : ['auth', 'status', '--json'];
        const wrapped = this.context.sandbox.wrap(file, args, {
          kind: 'mask',
          writableExpose: [isolated.directory],
        });
        const env = this.context.processes.env(isolated.env);
        for (const key of Object.keys(env))
          if (/(?:API_KEY|AUTH_TOKEN|OAUTH_TOKEN)$/.test(key)) delete env[key];
        let signedIn: boolean | null = null;
        try {
          const result = await this.context.processes.run(wrapped.file, wrapped.args, {
            env,
            timeoutMs: 15_000,
            signal: controller.signal,
            maxOutputBytes: 16_384,
          });
          if (profile.agent_id === 'codex') {
            const output = `${result.stdout}\n${result.stderr}`;
            if (/not logged in|not signed in/i.test(output)) signedIn = false;
            else if (!result.timedOut && result.code === 0 && /logged in|signed in/i.test(output))
              signedIn = true;
          } else {
            const parsed = JSON.parse(result.stdout) as { loggedIn?: unknown };
            if (typeof parsed.loggedIn === 'boolean') signedIn = parsed.loggedIn;
          }
        } catch {
          /* unknown is not signed out; never return raw CLI output */
        }
        return { signedIn, checkedAt: Date.now() };
      } finally {
        controllers.delete(controller);
        if (controllers.size === 0) this.statusControllers.delete(userId);
      }
    });
  }

  async login(
    user: Principal,
    profileId: string,
    launcher: string,
  ): Promise<{ env: Record<string, string>; directory: string }> {
    const profile = this.require(user.userId, profileId);
    const allowed =
      profile.agent_id === 'codex' ? ['codex-login', 'codex-login-device'] : ['claude-login'];
    if (!allowed.includes(launcher))
      throw badRequest(
        'This sign-in command does not match the account profile.',
        undefined,
        'profile_launcher_mismatch',
      );
    return this.environment(user.userId, profileId);
  }
}
