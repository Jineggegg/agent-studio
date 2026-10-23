import { constants } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { checkpointRestoreRequestSchema, idSchema, SESSION_EVENT } from '@agent-studio/protocol';
import { z } from 'zod';
import { newId, sha256 } from '../../kernel/crypto.js';
import { conflict, forbidden, notFound } from '../../kernel/errors.js';
import { requireBrowser } from '../../kernel/http.js';
import type { ModuleContext } from '../../kernel/module.js';
import { confine, openInside, resolveInside, withDirectoryInside } from '../../kernel/paths.js';
import type { Principal } from '../../kernel/principal.js';
import { credentialPaths } from '../../kernel/process.js';
import { redactSecrets } from '../../kernel/redact.js';
import { findCredential } from '../memory/credentials.js';
import type { AgentStore } from './store.js';
import type { SessionService } from './sessions.js';

interface CheckpointRow {
  id: string;
  session_id: string;
  run_id: string;
  user_id: string;
  path: string;
  content: string;
  created_at: number;
}
const messageParams = z.object({ sessionId: idSchema, seq: z.coerce.number().int().positive() });
const restoreParams = z.object({ sessionId: idSchema, checkpointId: idSchema });
const MAX_FILE_BYTES = 256 * 1024;
const MAX_FILES_PER_RUN = 20;
const SCOPE =
  'Existing UTF-8 files captured before approved edit tools. Shell commands, new files, binary files and edits without an explicit path are not covered. Restoring a file does not rewind conversation history.';

const CREDENTIAL_SEGMENTS = credentialPaths('/').map((entry) => entry.slice(1).split(path.sep));
function credentialPath(relative: string): boolean {
  const segments = relative
    .split(/[\\/]/)
    .filter(Boolean)
    .map((part) => part.toLowerCase());
  return segments.some(
    (part, index) =>
      ['.git', 'agent-accounts'].includes(part) ||
      CREDENTIAL_SEGMENTS.some((sensitive) =>
        sensitive.every((component, offset) => segments[index + offset] === component),
      ) ||
      /^(?:\.env(?:\..*)?|credentials[^/]*|auth\.json|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|secrets?\.(?:json|ya?ml|toml)|.*\.(?:pem|key|p12|pfx|jks|keystore))$/i.test(
        part,
      ),
  );
}
function secretContent(content: string): boolean {
  return findCredential(content) !== null || redactSecrets(content) !== content;
}

export class FileCheckpoints {
  constructor(
    private readonly context: ModuleContext,
    private readonly sessions: SessionService,
    private readonly store: AgentStore,
  ) {}

  async safePath(root: string, relative: string): Promise<string> {
    const lexical = resolveInside(root, relative);
    const real = await confine(root, relative);
    if (real !== lexical || (await lstat(real)).isSymbolicLink())
      throw forbidden('Checkpoint files cannot be symbolic links.', 'checkpoint_path_unsafe');
    if (credentialPath(relative))
      throw forbidden('Credential files cannot be checkpointed.', 'checkpoint_path_unsafe');
    return real;
  }

  private async readText(
    root: string,
    relative: string,
  ): Promise<{ content: string; version: string }> {
    const absolute = await this.safePath(root, relative);
    const handle = await openInside(root, absolute, constants.O_RDONLY | constants.O_NOFOLLOW, {
      excluded: [this.context.config.dataDir],
    });
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.size > BigInt(MAX_FILE_BYTES))
        throw forbidden('This file is outside checkpoint support.', 'checkpoint_unavailable');
      const buffer = Buffer.alloc(Number(before.size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const after = await handle.stat({ bigint: true });
      if (
        before.mtimeNs !== after.mtimeNs ||
        before.size !== after.size ||
        bytesRead !== buffer.length
      )
        throw conflict('The file changed during preview.', 'file_changed');
      const content = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      if (secretContent(content))
        throw forbidden(
          'Secret-bearing files cannot be checkpointed.',
          'checkpoint_secret_content',
        );
      if (content.includes('\0'))
        throw forbidden('Binary files cannot be checkpointed.', 'checkpoint_unavailable');
      return { content, version: sha256(`${before.mtimeNs}:${before.size}`).slice(0, 32) };
    } finally {
      await handle.close();
    }
  }

  /** Best-effort capture before an approved native edit; never claims coverage for a path that failed. */
  async capture(
    sessionId: string,
    runId: string,
    userId: string,
    projectId: string | null,
    paths: readonly string[],
  ): Promise<void> {
    if (projectId === null) return;
    const project = this.context.services.projects.find(projectId);
    if (!project) return;
    const count =
      this.context.db.get<{ count: number }>(
        'SELECT count(*) AS count FROM agent_file_checkpoints WHERE run_id = ?',
        runId,
      )?.count ?? 0;
    for (const supplied of paths.slice(0, Math.max(0, MAX_FILES_PER_RUN - count))) {
      const relative = path.isAbsolute(supplied)
        ? path.relative(project.rootDir, supplied)
        : supplied;
      if (
        this.context.db.get(
          'SELECT id FROM agent_file_checkpoints WHERE run_id = ? AND path = ?',
          runId,
          relative,
        )
      )
        continue;
      try {
        const file = await this.readText(project.rootDir, relative);
        this.context.db.run(
          'INSERT OR IGNORE INTO agent_file_checkpoints (id, session_id, run_id, user_id, path, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          newId(),
          sessionId,
          runId,
          userId,
          relative,
          file.content,
          Date.now(),
        );
      } catch {
        /* Files outside this limited support are simply absent from the preview. */
      }
    }
  }

  private access(user: Principal, sessionId: string, need: 'view' | 'write') {
    const access = this.sessions.requireSession(user, sessionId, need);
    if (!access.project)
      throw notFound('This conversation has no workspace.', 'checkpoint_unavailable');
    return access;
  }

  registerRoutes(): void {
    const { http, db } = this.context;
    http.route({
      method: 'GET',
      url: '/api/sessions/:sessionId/messages/:seq/checkpoints',
      access: 'user',
      params: messageParams,
      handler: async ({ user, params }) => {
        const { project } = this.access(user, params.sessionId, 'view');
        const event = this.store.eventsBefore(params.sessionId, params.seq + 1, 1)[0];
        if (
          !event ||
          event.seq !== params.seq ||
          ![SESSION_EVENT.messageUser, SESSION_EVENT.messageAssistant].includes(
            event.type as typeof SESSION_EVENT.messageUser,
          )
        )
          throw notFound('No such message.', 'message_not_found');
        const rows = db.all<CheckpointRow>(
          'SELECT * FROM agent_file_checkpoints WHERE session_id = ? AND run_id = ? AND (user_id = ? OR ? = 1)',
          params.sessionId,
          event.run_id,
          user.userId,
          user.role === 'owner' ? 1 : 0,
        );
        const files = [];
        for (const row of rows) {
          // Older rows are checked too: secret material is never returned or restored.
          if (credentialPath(row.path) || secretContent(row.content)) {
            db.run('DELETE FROM agent_file_checkpoints WHERE id = ?', row.id);
            continue;
          }
          let current: string | null = null;
          let version: string | null = null;
          let available = false;
          try {
            const file = await this.readText(project!.rootDir, row.path);
            current = file.content;
            version = file.version;
            available = true;
          } catch (error) {
            if ((error as { code?: string }).code === 'checkpoint_secret_content') continue;
            /* Removed, moved or unsafe paths cannot be restored through this preview. */
          }
          files.push({
            id: row.id,
            path: row.path,
            before: row.content,
            current,
            currentVersion: version,
            available,
            capturedAt: row.created_at,
          });
        }
        return { scope: SCOPE, files };
      },
    });
    http.route({
      method: 'POST',
      url: '/api/sessions/:sessionId/checkpoints/:checkpointId/restore',
      access: 'user',
      params: restoreParams,
      body: checkpointRestoreRequestSchema,
      handler: async ({ user, params, body }) => {
        requireBrowser(user);
        const { project } = this.access(user, params.sessionId, 'write');
        if (this.store.activeRun(params.sessionId))
          throw conflict('Stop the current run before restoring a file.', 'session_busy');
        const row = db.get<CheckpointRow>(
          'SELECT * FROM agent_file_checkpoints WHERE id = ? AND session_id = ? AND user_id = ?',
          params.checkpointId,
          params.sessionId,
          user.userId,
        );
        if (!row) throw notFound('No such file checkpoint.', 'checkpoint_not_found');
        if (credentialPath(row.path) || secretContent(row.content)) {
          db.run('DELETE FROM agent_file_checkpoints WHERE id = ?', row.id);
          throw forbidden('This file is outside checkpoint support.', 'checkpoint_unavailable');
        }
        // Never replace a newly secret-bearing file using a stale non-secret checkpoint.
        await this.readText(project!.rootDir, row.path);
        const absolute = await this.safePath(project!.rootDir, row.path);
        // Anchor the parent directory through a checked descriptor. A concurrent symlink swap cannot
        // redirect the temporary file or rename outside the project. Existing files are never truncated.
        const version = await withDirectoryInside(
          project!.rootDir,
          path.dirname(absolute),
          async (directory) => {
            const target = path.join(directory, path.basename(absolute));
            const fingerprint = async (): Promise<{ version: string; mode: number }> => {
              const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
              try {
                const stat = await handle.stat({ bigint: true });
                if (!stat.isFile())
                  throw conflict('The file is no longer a regular file.', 'file_changed');
                return {
                  version: sha256(`${stat.mtimeNs}:${stat.size}`).slice(0, 32),
                  mode: Number(stat.mode & 0o777n),
                };
              } finally {
                await handle.close();
              }
            };
            const before = await fingerprint();
            if (before.version !== body.currentVersion)
              throw conflict(
                'The file changed since this preview. Nothing was restored.',
                'file_changed',
              );
            const temporary = path.join(directory, `.checkpoint-${newId()}`);
            try {
              const handle = await open(
                temporary,
                constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
                before.mode,
              );
              try {
                await handle.writeFile(row.content, 'utf8');
                await handle.sync();
              } finally {
                await handle.close();
              }
              if ((await fingerprint()).version !== body.currentVersion)
                throw conflict(
                  'The file changed since this preview. Nothing was restored.',
                  'file_changed',
                );
              await rename(temporary, target);
              return (await fingerprint()).version;
            } finally {
              await unlink(temporary).catch(() => {});
            }
          },
          { excluded: [this.context.config.dataDir] },
        );
        this.context.services.audit.record({
          category: 'change',
          action: 'agent.checkpoint.restored',
          userId: user.userId,
          subject: project!.id,
          detail: row.path,
        });
        this.sessions.append(params.sessionId, null, SESSION_EVENT.notice, {
          runId: null,
          level: 'info',
          code: 'file_restored',
          text: `Restored ${row.path} to the captured content. Conversation history is unchanged.`,
        });
        return { restored: true, version };
      },
    });
  }
}
