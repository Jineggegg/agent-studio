import { constants } from 'node:fs';
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import {
  idSchema,
  miniAppInputSchema,
  miniAppCreateSchema,
  miniAppConfirmSchema,
  miniAppBuildConfirmSchema,
  miniAppProposalInputSchema,
  miniAppReviewedProposalSchema,
  type MiniApp,
  type MiniAppCreate,
} from '@agent-studio/protocol';
import { newId, randomToken, sha256 } from '../../kernel/crypto.js';
import { badRequest, conflict, forbidden, notFound } from '../../kernel/errors.js';
import type { ModuleContext, StudioModule } from '../../kernel/module.js';
import { confine, mkdirInside, openInside } from '../../kernel/paths.js';
import type { Principal } from '../../kernel/principal.js';
import { redactSecrets } from '../../kernel/redact.js';
import { collectArtifacts } from './artifacts.js';
interface AppRow {
  id: string;
  project_id: string;
  config: string;
  config_revision: number;
  state: MiniApp['state'];
  log: string;
  version: number;
  published_at: number | null;
  updated_at: number;
}
interface ProposalRow {
  id: string;
  project_id: string;
  user_id: string;
  proposal: string;
  created_at: number;
}
interface Job {
  projectId: string;
  userId: string;
  abort: AbortController;
  task: Promise<void>;
}
const projectParams = z.object({ projectId: idSchema });
const appParams = projectParams.extend({ appId: idSchema });
const proposalParams = projectParams.extend({ proposalId: idSchema });
const noApp = () => notFound('No such app.', 'app_not_found');
const present = (row: AppRow): MiniApp => ({
  ...miniAppInputSchema.parse(JSON.parse(row.config)),
  id: row.id,
  projectId: row.project_id,
  state: row.state,
  log: row.log,
  configRevision: row.config_revision,
  version: row.version,
  publishedAt: row.published_at,
  updatedAt: row.updated_at,
});

export function createMiniAppsModule(): StudioModule {
  const instances = new WeakMap<ModuleContext, { jobs: Map<string, Job>; stop: () => void }>();
  return {
    name: 'mini-apps',
    migrations: [
      {
        version: 1,
        name: 'project apps static artifacts and scoped preview grants',
        sql: `
      CREATE TABLE mini_apps (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, config TEXT NOT NULL, state TEXT NOT NULL, log TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 0, published_at INTEGER, updated_at INTEGER NOT NULL);
      CREATE INDEX mini_apps_project ON mini_apps(project_id);
      CREATE TABLE mini_app_assets (app_id TEXT NOT NULL REFERENCES mini_apps(id) ON DELETE CASCADE, path TEXT NOT NULL, mime TEXT NOT NULL, content BLOB NOT NULL, PRIMARY KEY(app_id,path));
      CREATE TABLE mini_app_grants (hash TEXT PRIMARY KEY, app_id TEXT NOT NULL REFERENCES mini_apps(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, version INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE mini_app_proposals (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, proposal TEXT NOT NULL, created_at INTEGER NOT NULL);
    `,
      },
      {
        version: 2,
        name: 'bind build approvals to reviewed app configuration',
        sql: `
          ALTER TABLE mini_apps ADD COLUMN config_revision INTEGER NOT NULL DEFAULT 1 CHECK (config_revision > 0);
          -- Older build proposals contain no reviewed snapshot and cannot authorize execution.
          DELETE FROM mini_app_proposals WHERE json_extract(proposal, '$.operation') = 'build';
        `,
      },
    ],
    setup(context) {
      const { db, http } = context,
        jobs = new Map<string, Job>();
      db.run(
        "UPDATE mini_apps SET state = 'failed', log = 'Build interrupted by server restart.' WHERE state = 'building'",
      );
      const audit = (user: Principal, action: string, id: string) =>
        context.services.audit.record({
          category: 'change',
          action,
          userId: user.userId,
          subject: id,
        });
      const project = (user: Principal, id: string, write = false) => {
        const value = context.services.projects.requireAccess(user, id, write ? 'write' : 'read');
        if (write && value.archivedAt !== null) throw conflict('This project is archived.');
        return value;
      };
      const find = (user: Principal, projectId: string, appId: string, write = false): AppRow => {
        project(user, projectId, write);
        const row = db.get<AppRow>(
          'SELECT * FROM mini_apps WHERE project_id = ? AND id = ?',
          projectId,
          appId,
        );
        if (!row) throw noApp();
        return row;
      };
      const publish = async (user: Principal, row: AppRow) => {
        const item = present(row),
          root = project(user, row.project_id, true).rootDir;
        const appRoot = await confine(root, item.directory),
          output = await confine(appRoot, item.outputDirectory);
        const assets = await collectArtifacts(root, path.relative(root, output), [
          context.config.dataDir,
        ]);
        project(user, row.project_id, true);
        db.transaction(() => {
          if (!db.get('SELECT id FROM mini_apps WHERE id = ?', row.id)) throw noApp();
          db.run('DELETE FROM mini_app_assets WHERE app_id = ?', row.id);
          db.run('DELETE FROM mini_app_grants WHERE app_id = ?', row.id);
          for (const a of assets)
            db.run(
              'INSERT INTO mini_app_assets VALUES (?, ?, ?, ?)',
              row.id,
              a.path,
              a.mime,
              a.bytes,
            );
          db.run(
            "UPDATE mini_apps SET state = 'ready', version = version + 1, published_at = ?, updated_at = ? WHERE id = ?",
            Date.now(),
            Date.now(),
            row.id,
          );
        });
      };
      const create = async (
        user: Principal,
        projectId: string,
        input: MiniAppCreate,
      ): Promise<MiniApp> => {
        const root = project(user, projectId, true).rootDir;
        if (
          (db.get<{ n: number }>(
            'SELECT count(*) AS n FROM mini_apps WHERE project_id = ?',
            projectId,
          )?.n ?? 0) >= 20
        )
          throw badRequest('At most 20 apps may be registered per project.');
        const target = await confine(root, input.directory);
        if (input.html !== undefined) {
          await mkdirInside(root, target, { excluded: [context.config.dataDir], mode: 0o700 });
          const file = await confine(
            root,
            `${input.directory === '.' ? '' : `${input.directory}/`}index.html`,
          );
          const handle = await openInside(
            root,
            file,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
            { excluded: [context.config.dataDir], mode: 0o600 },
          );
          try {
            await handle.writeFile(input.html);
          } finally {
            await handle.close();
          }
        }
        if (!(await stat(target).catch(() => null))?.isDirectory())
          throw badRequest('The app directory does not exist.');
        project(user, projectId, true);
        const config = miniAppInputSchema.parse({
          name: input.name,
          directory: input.directory,
          outputDirectory: input.outputDirectory,
          build: input.build,
        });
        const id = newId();
        db.run(
          "INSERT INTO mini_apps (id, project_id, config, state, updated_at) VALUES (?, ?, ?, 'idle', ?)",
          id,
          projectId,
          JSON.stringify(config),
          Date.now(),
        );
        audit(user, 'app.registered', id);
        return present(find(user, projectId, id));
      };
      const requireReviewedConfig = (row: AppRow, configRevision: number) => {
        if (row.config_revision !== configRevision)
          throw conflict(
            'This app configuration changed. Review the current directory, command, arguments and output before confirming again.',
            'app_config_changed',
          );
      };
      const startBuild = async (
        user: Principal,
        row: AppRow,
        configRevision: number,
      ): Promise<MiniApp> => {
        requireReviewedConfig(row, configRevision);
        const item = present(row);
        if (jobs.size) throw conflict('Another app build or publication is already running.');
        if (item.build.kind !== 'none' && context.sandbox.status.mode !== 'bwrap')
          throw forbidden(
            'A working bubblewrap sandbox is required to run builds. You may publish existing static output.',
            'app_sandbox_required',
          );
        project(user, row.project_id, true);
        const abort = new AbortController();
        db.run(
          "UPDATE mini_apps SET state = 'building', log = '', updated_at = ? WHERE id = ?",
          Date.now(),
          row.id,
        );
        const execute = async () => {
          let scratch: string | null = null;
          try {
            if (item.build.kind !== 'none') {
              const principal = context.services.agents.principalFor(user.userId);
              if (!principal) throw forbidden('The account is no longer active.');
              const root = await realpath(project(principal, row.project_id, true).rootDir),
                cwd = await confine(root, item.directory);
              scratch = await mkdtemp(path.join(os.tmpdir(), 'cloud-harness-app-'));
              const runtime = await realpath(path.dirname(path.dirname(process.execPath)));
              let file: string, argv: string[];
              if (item.build.kind === 'npm') {
                file = 'npm';
                argv = ['run', item.build.script, '--', ...item.build.args];
              } else {
                file = process.execPath;
                argv = [await confine(cwd, item.build.script), ...item.build.args];
              }
              const wrapped = context.sandbox.wrap(file, argv, {
                kind: 'isolate',
                readable: [runtime],
                writable: [root, scratch],
                network: false,
              });
              if (!wrapped.sandboxed)
                throw forbidden('Build sandbox is unavailable.', 'app_sandbox_required');
              const baseline = context.processes.env();
              const env = {
                PATH: `${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
                LANG: baseline.LANG ?? 'C.UTF-8',
                HOME: scratch,
                TMPDIR: scratch,
                XDG_CACHE_HOME: scratch,
                npm_config_cache: scratch,
                npm_config_offline: 'true',
                npm_config_audit: 'false',
                npm_config_fund: 'false',
              };
              const result = await context.processes.run(wrapped.file, wrapped.args, {
                cwd,
                env,
                timeoutMs: 5 * 60000,
                maxOutputBytes: 32000,
                signal: abort.signal,
              });
              const log = redactSecrets(
                `${result.stdout}\n${result.stderr}${result.truncated ? '\n[Output truncated]' : ''}${result.timedOut ? '\n[Build timed out]' : ''}`,
              ).slice(0, 69000);
              db.run('UPDATE mini_apps SET log = ? WHERE id = ?', log, row.id);
              if (abort.signal.aborted) throw new Error('cancelled');
              if (result.code !== 0 || result.timedOut) throw new Error('build failed');
            }
            if (abort.signal.aborted) throw new Error('cancelled');
            const principal = context.services.agents.principalFor(user.userId);
            if (!principal) throw forbidden('The account is no longer active.');
            await publish(principal, row);
            if (abort.signal.aborted) {
              db.run('DELETE FROM mini_app_assets WHERE app_id = ?', row.id);
              throw new Error('cancelled');
            }
          } catch {
            db.run(
              "UPDATE mini_apps SET state = ?, updated_at = ?, log = CASE WHEN log = '' THEN ? ELSE log END WHERE id = ?",
              abort.signal.aborted ? 'cancelled' : 'failed',
              Date.now(),
              abort.signal.aborted
                ? 'Build cancelled.'
                : 'Build or publication failed. Check the command, output path, file limits and project access.',
              row.id,
            );
          } finally {
            if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
            jobs.delete(row.id);
          }
        };
        // Defer execution until the job is registered, including static publication without a process.
        const task = Promise.resolve().then(execute);
        jobs.set(row.id, { projectId: row.project_id, userId: user.userId, abort, task });
        audit(
          user,
          item.build.kind === 'none' ? 'app.publish.confirmed' : 'app.build.confirmed',
          row.id,
        );
        return present(find(user, row.project_id, row.id));
      };
      http.route({
        method: 'GET',
        url: '/api/projects/:projectId/mini-apps',
        access: 'user',
        params: projectParams,
        handler: ({ user, params }) => {
          project(user, params.projectId);
          return {
            apps: db
              .all<AppRow>(
                'SELECT * FROM mini_apps WHERE project_id = ? ORDER BY updated_at DESC',
                params.projectId,
              )
              .map(present),
            buildAvailable: context.sandbox.status.mode === 'bwrap',
            canWrite: context.services.projects.accessOf(user, params.projectId) === 'write',
          };
        },
      });
      http.route({
        method: 'POST',
        url: '/api/projects/:projectId/mini-apps',
        access: 'user',
        sessionOnly: true,
        params: projectParams,
        body: miniAppCreateSchema,
        bodyLimit: 250000,
        handler: ({ user, params, body }) => create(user, params.projectId, body),
      });
      http.route({
        method: 'PUT',
        url: '/api/projects/:projectId/mini-apps/:appId',
        access: 'user',
        sessionOnly: true,
        params: appParams,
        body: miniAppInputSchema,
        handler: ({ user, params, body }) => {
          const row = find(user, params.projectId, params.appId, true);
          if (jobs.has(row.id)) throw conflict('Wait for this build to finish.');
          db.transaction(() => {
            db.run(
              "UPDATE mini_apps SET config = ?, config_revision = config_revision + 1, state = 'idle', log = '', published_at = NULL, updated_at = ? WHERE id = ?",
              JSON.stringify(body),
              Date.now(),
              row.id,
            );
            db.run('DELETE FROM mini_app_grants WHERE app_id = ?', row.id);
            db.run('DELETE FROM mini_app_assets WHERE app_id = ?', row.id);
          });
          return present(find(user, params.projectId, row.id));
        },
      });
      http.route({
        method: 'DELETE',
        url: '/api/projects/:projectId/mini-apps/:appId',
        access: 'user',
        sessionOnly: true,
        params: appParams,
        handler: ({ user, params }) => {
          const row = find(user, params.projectId, params.appId, true);
          if (jobs.has(row.id))
            throw conflict('Cancel the active build and wait before removing the app.');
          db.run('DELETE FROM mini_apps WHERE id = ?', row.id);
          audit(user, 'app.removed', row.id);
        },
      });
      http.route({
        method: 'POST',
        url: '/api/projects/:projectId/mini-apps/:appId/build',
        access: 'user',
        sessionOnly: true,
        params: appParams,
        body: miniAppBuildConfirmSchema,
        rateLimit: { max: 10, windowMs: 60000 },
        handler: ({ user, params, body, reply }) => {
          void reply.status(202);
          return startBuild(
            user,
            find(user, params.projectId, params.appId, true),
            body.configRevision,
          );
        },
      });
      http.route({
        method: 'POST',
        url: '/api/projects/:projectId/mini-apps/:appId/cancel',
        access: 'user',
        sessionOnly: true,
        params: appParams,
        body: miniAppConfirmSchema,
        handler: ({ user, params }) => {
          find(user, params.projectId, params.appId, true);
          jobs.get(params.appId)?.abort.abort();
          return { cancelled: true };
        },
      });
      http.route({
        method: 'POST',
        url: '/api/projects/:projectId/mini-apps/:appId/preview',
        access: 'user',
        sessionOnly: true,
        params: appParams,
        body: z.strictObject({}),
        handler: ({ user, params }) => {
          const row = find(user, params.projectId, params.appId);
          if (row.state !== 'ready')
            throw conflict('Publish a successful build before previewing.', 'app_not_ready');
          const token = randomToken(),
            expiresAt = Date.now() + 10 * 60000;
          db.transaction(() => {
            db.run(
              'DELETE FROM mini_app_grants WHERE expires_at <= ? OR (user_id = ? AND app_id = ?)',
              Date.now(),
              user.userId,
              row.id,
            );
            db.run(
              'INSERT INTO mini_app_grants VALUES (?, ?, ?, ?, ?)',
              sha256(token),
              row.id,
              user.userId,
              row.version,
              expiresAt,
            );
          });
          return { url: `/api/mini-apps/preview/${token}/index.html`, expiresAt };
        },
      });
      // Capability assets omit cookies and can be loaded by an opaque-origin sandboxed module script.
      http.route({
        method: 'GET',
        url: '/api/mini-apps/preview/:grant/*',
        access: 'self',
        params: z.object({
          grant: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
          '*': z.string().max(600),
        }),
        handler: ({ params, principal, reply, request }) => {
          const grant = db.get<{ app_id: string; user_id: string; version: number }>(
            'SELECT app_id, user_id, version FROM mini_app_grants WHERE hash = ? AND expires_at > ?',
            sha256(params.grant),
            Date.now(),
          );
          if (!grant || (principal && principal.userId !== grant.user_id)) throw noApp();
          const user = context.services.agents.principalFor(grant.user_id);
          if (!user) throw noApp();
          const row = db.get<AppRow>(
            'SELECT * FROM mini_apps WHERE id = ? AND version = ?',
            grant.app_id,
            grant.version,
          );
          if (!row || row.state !== 'ready') throw noApp();
          project(user, row.project_id);
          const assetPath = params['*'];
          if (
            !assetPath ||
            assetPath
              .split('/')
              .some((part) => !part || part === '.' || part === '..' || part.startsWith('.')) ||
            assetPath.includes('\\')
          )
            throw noApp();
          const asset = db.get<{ mime: string; content: Uint8Array }>(
            'SELECT mime, content FROM mini_app_assets WHERE app_id = ? AND path = ?',
            row.id,
            assetPath,
          );
          if (!asset) throw noApp();
          const source = `${context.http.originOf(request)}/api/mini-apps/preview/${params.grant}/`;
          const csp = `sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' ${source}; style-src 'unsafe-inline' ${source}; img-src data: blob: ${source}; font-src ${source}; connect-src 'none'; worker-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`;
          return reply
            .header('content-type', asset.mime)
            .header('content-security-policy', csp)
            .header('x-content-type-options', 'nosniff')
            .header('x-frame-options', 'SAMEORIGIN')
            .header('access-control-allow-origin', '*')
            .header('cross-origin-resource-policy', 'cross-origin')
            .header('referrer-policy', 'no-referrer')
            .header('cache-control', 'no-store')
            .send(Buffer.from(asset.content));
        },
      });
      context.agentTools.register({
        name: 'mini_app_propose',
        description:
          'Propose registering/scaffolding a static app in this project, or building an existing one. Supply project-relative directory/output paths and fixed npm script or Node argv. Generated HTML is saved only after a human approves in the Apps screen, never overwrites an existing index.html. Builds require an isolated network-disabled sandbox. This tool only proposes; it never builds or publishes by itself.',
        input: miniAppProposalInputSchema,
        effect: 'write',
        handler: (tool, input) => {
          const user = context.services.agents.principalFor(tool.userId);
          if (!user || !tool.projectId) throw forbidden('Use a project conversation.');
          project(user, tool.projectId, true);
          const buildApp =
            input.operation === 'build' ? find(user, tool.projectId, input.appId, true) : null;
          const reviewed = buildApp
            ? {
                operation: 'build',
                appId: buildApp.id,
                configRevision: buildApp.config_revision,
                config: miniAppInputSchema.parse(JSON.parse(buildApp.config)),
              }
            : input;
          db.run(
            'DELETE FROM mini_app_proposals WHERE created_at < ?',
            Date.now() - 24 * 60 * 60000,
          );
          if (
            (db.get<{ n: number }>(
              'SELECT count(*) AS n FROM mini_app_proposals WHERE user_id = ?',
              user.userId,
            )?.n ?? 0) >= 10
          )
            throw conflict('Review your pending app proposals first.');
          const id = newId();
          db.run(
            'INSERT INTO mini_app_proposals VALUES (?, ?, ?, ?, ?)',
            id,
            tool.projectId,
            user.userId,
            JSON.stringify(reviewed),
            Date.now(),
          );
          return {
            text: JSON.stringify({
              proposalId: id,
              status: 'awaiting-human-approval',
              reviewPath: `/projects/${tool.projectId}/apps`,
            }),
          };
        },
      });
      http.route({
        method: 'GET',
        url: '/api/projects/:projectId/mini-app-proposals',
        access: 'user',
        params: projectParams,
        handler: ({ user, params }) => {
          project(user, params.projectId);
          return {
            proposals: db
              .all<ProposalRow>(
                'SELECT * FROM mini_app_proposals WHERE user_id = ? AND project_id = ? AND created_at > ? ORDER BY created_at',
                user.userId,
                params.projectId,
                Date.now() - 24 * 60 * 60000,
              )
              .map((r) => ({
                id: r.id,
                proposal: miniAppReviewedProposalSchema.parse(JSON.parse(r.proposal)),
                createdAt: r.created_at,
              })),
          };
        },
      });
      http.route({
        method: 'DELETE',
        url: '/api/projects/:projectId/mini-app-proposals/:proposalId',
        access: 'user',
        params: proposalParams,
        handler: ({ user, params }) => {
          project(user, params.projectId);
          db.run(
            'DELETE FROM mini_app_proposals WHERE id = ? AND user_id = ? AND project_id = ?',
            params.proposalId,
            user.userId,
            params.projectId,
          );
        },
      });
      http.route({
        method: 'POST',
        url: '/api/projects/:projectId/mini-app-proposals/:proposalId/approve',
        access: 'user',
        sessionOnly: true,
        params: proposalParams,
        body: miniAppConfirmSchema,
        handler: async ({ user, params }) => {
          project(user, params.projectId, true);
          const row = db.get<ProposalRow>(
            'SELECT * FROM mini_app_proposals WHERE id = ? AND user_id = ? AND project_id = ? AND created_at > ?',
            params.proposalId,
            user.userId,
            params.projectId,
            Date.now() - 24 * 60 * 60000,
          );
          if (!row) throw noApp();
          const input = miniAppReviewedProposalSchema.parse(JSON.parse(row.proposal));
          const buildApp =
            input.operation === 'build' ? find(user, params.projectId, input.appId, true) : null;
          if (buildApp && input.operation === 'build')
            requireReviewedConfig(buildApp, input.configRevision);
          if (
            db.run(
              'DELETE FROM mini_app_proposals WHERE id = ? AND user_id = ?',
              row.id,
              user.userId,
            ).changes !== 1
          )
            throw conflict('This proposal was already reviewed.');
          return input.operation === 'create'
            ? create(user, params.projectId, input.app)
            : startBuild(user, buildApp!, input.configRevision);
        },
      });
      const stop = context.bus.on('project.membership.changed', (event) => {
        const data = event.data as { projectId: string; userId: string; access: string | null };
        if (data.access !== 'write')
          for (const job of jobs.values())
            if (job.projectId === data.projectId && job.userId === data.userId) job.abort.abort();
      });
      instances.set(context, { jobs, stop });
      http.app.addHook('onClose', async () => {
        for (const job of jobs.values()) job.abort.abort();
        await Promise.allSettled([...jobs.values()].map((j) => j.task));
        stop();
      });
    },
    async stop(context) {
      const instance = instances.get(context);
      if (!instance) return;
      instance.stop();
      for (const job of instance.jobs.values()) job.abort.abort();
      await Promise.allSettled([...instance.jobs.values()].map((j) => j.task));
    },
  };
}
export const miniAppsModule = createMiniAppsModule();
