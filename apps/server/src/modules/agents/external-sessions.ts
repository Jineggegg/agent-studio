import { constants } from 'node:fs';
import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  SESSION_EVENT,
  createExternalConversationRootSchema,
  idSchema,
  importExternalConversationSchema,
  type ExternalConversation,
} from '@agent-studio/protocol';
import { z } from 'zod';
import { newId, sha256 } from '../../kernel/crypto.js';
import { badRequest, conflict, forbidden, notFound } from '../../kernel/errors.js';
import { requireBrowser } from '../../kernel/http.js';
import type { ModuleContext } from '../../kernel/module.js';
import { confine, isInside, openInside } from '../../kernel/paths.js';
import type { Principal } from '../../kernel/principal.js';
import { redactSecrets } from '../../kernel/redact.js';
import type { RunService } from './runtime.js';
import type { SessionService } from './sessions.js';

interface Root {
  id: string;
  user_id: string;
  name: string;
  agent_id: 'claude-code' | 'codex';
  directory: string;
  created_at: number;
}
interface Source {
  info: ExternalConversation;
  relative: string;
}
const rootParams = z.object({ rootId: idSchema });
const MAX_SOURCES = 200;
const MAX_ENTRIES = 2000;
const MAX_DEPTH = 6;
const MAX_BYTES = 2 * 1024 * 1024;
const HEADER_BYTES = 64 * 1024;
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .flatMap((block) => {
            const item = object(block);
            return item &&
              ['text', 'input_text', 'output_text'].includes(String(item.type)) &&
              typeof item.text === 'string'
              ? [item.text]
              : [];
          })
          .join('\n')
      : '';

/** Public CLI JSONL formats, reduced to human/assistant prose. Tool calls, paths, system prompts and credentials never become imported actions. */
export function readExternalMessages(
  text: string,
  agent: Root['agent_id'],
): Array<{ role: 'user' | 'assistant'; text: string }> {
  const messages: Array<{ role: 'user' | 'assistant'; text: string }> = [];
  for (const line of text.split('\n')) {
    if (line.length > 200_000) continue;
    let entry: Record<string, unknown> | null;
    try {
      entry = object(JSON.parse(line));
    } catch {
      continue;
    }
    if (!entry) continue;
    const message =
      agent === 'claude-code' && (entry.type === 'user' || entry.type === 'assistant')
        ? object(entry.message)
        : agent === 'codex' && entry.type === 'response_item'
          ? object(entry.payload)
          : null;
    if (!message || (message.role !== 'user' && message.role !== 'assistant')) continue;
    if (message.type !== undefined && message.type !== 'message') continue;
    const body = redactSecrets(textOf(message.content)).trim();
    if (body && body.length <= 100_000) messages.push({ role: message.role, text: body });
    if (messages.length >= 1000) break;
  }
  return messages;
}

export class ExternalConversations {
  private readonly importing = new Set<string>();
  constructor(
    private readonly context: ModuleContext,
    private readonly sessions: SessionService,
    private readonly runs: RunService,
  ) {}

  private requireRoot(user: Principal, id: string): Root {
    const root = this.context.db.get<Root>(
      'SELECT * FROM agent_external_roots WHERE id = ? AND user_id = ?',
      id,
      user.userId,
    );
    if (!root) throw notFound('No such conversation source.', 'external_root_not_found');
    return root;
  }

  async safeRoot(directory: string): Promise<string> {
    if (!path.isAbsolute(directory) || directory.includes('\0'))
      throw badRequest('Choose an absolute transcript directory.', undefined, 'invalid_directory');
    const normalized = path.resolve(directory);
    let actual: string;
    try {
      actual = await realpath(normalized);
    } catch {
      throw notFound('The transcript directory does not exist.', 'external_root_not_found');
    }
    if (actual !== normalized || (await lstat(normalized)).isSymbolicLink())
      throw forbidden(
        'Transcript directories cannot contain symbolic links.',
        'external_path_unsafe',
      );
    if (
      !(await lstat(actual)).isDirectory() ||
      isInside(actual, this.context.config.dataDir) ||
      isInside(this.context.config.dataDir, actual)
    )
      throw forbidden(
        'Choose a transcript directory outside Cloud Harness data.',
        'external_path_unsafe',
      );
    return actual;
  }

  private async read(
    root: Root,
    relative: string,
    headerOnly: boolean,
  ): Promise<{ text: string; version: string; bytes: number; modifiedAt: number }> {
    const directory = await this.safeRoot(root.directory);
    const absolute = await confine(directory, relative);
    if (absolute !== path.join(directory, relative) || (await lstat(absolute)).isSymbolicLink())
      throw forbidden('Transcript files cannot be symbolic links.', 'external_path_unsafe');
    const handle = await openInside(directory, absolute, constants.O_RDONLY, {
      excluded: [this.context.config.dataDir],
    });
    try {
      const stats = await handle.stat({ bigint: true });
      if (!stats.isFile() || stats.size > BigInt(MAX_BYTES))
        throw badRequest(
          'The transcript is too large or is not a regular file.',
          undefined,
          'external_source_too_large',
        );
      const buffer = Buffer.alloc(
        headerOnly ? Math.min(HEADER_BYTES, Number(stats.size)) : Number(stats.size),
      );
      const result = await handle.read(buffer, 0, buffer.length, 0);
      const after = await handle.stat({ bigint: true });
      if (after.mtimeNs !== stats.mtimeNs || after.size !== stats.size)
        throw conflict('The transcript changed while it was read.', 'external_source_changed');
      return {
        text: buffer.subarray(0, result.bytesRead).toString('utf8'),
        version: sha256(`${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}`),
        bytes: Number(stats.size),
        modifiedAt: Number(stats.mtimeMs),
      };
    } finally {
      await handle.close();
    }
  }

  async discover(root: Root): Promise<{ sources: Source[]; limited: boolean }> {
    const directory = await this.safeRoot(root.directory);
    const sources: Source[] = [];
    let visited = 0;
    let limited = false;
    const walk = async (relative: string, depth: number): Promise<void> => {
      if (depth > MAX_DEPTH) {
        limited = true;
        return;
      }
      const absolute = await confine(directory, relative);
      if (absolute !== path.join(directory, relative) || (await lstat(absolute)).isSymbolicLink())
        return;
      for (const entry of await readdir(absolute, { withFileTypes: true })) {
        visited += 1;
        if (visited > MAX_ENTRIES || sources.length >= MAX_SOURCES) {
          limited = true;
          return;
        }
        if (entry.isSymbolicLink() || entry.name.startsWith('.') || entry.name === 'node_modules')
          continue;
        const child = path.join(relative, entry.name);
        if (entry.isDirectory()) await walk(child, depth + 1);
        else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          try {
            const file = await this.read(root, child, true);
            const messages = readExternalMessages(file.text, root.agent_id);
            const first = messages.find((message) => message.role === 'user');
            if (!first) continue;
            sources.push({
              relative: child,
              info: {
                id: sha256(`${root.id}:${child}`),
                rootId: root.id,
                agentId: root.agent_id,
                title: first.text.replace(/\s+/g, ' ').slice(0, 120),
                modifiedAt: file.modifiedAt,
                version: file.version,
                bytes: file.bytes,
              },
            });
          } catch {
            /* Unsupported, oversized and unsafe files are never listed. */
          }
        }
      }
    };
    await walk('', 0);
    return { sources, limited };
  }

  registerRoutes(): void {
    const { http, db } = this.context;
    http.route({
      method: 'GET',
      url: '/api/external-conversation-roots',
      access: 'owner',
      handler: ({ user }) => ({
        roots: db
          .all<Root>(
            'SELECT * FROM agent_external_roots WHERE user_id = ? ORDER BY name',
            user.userId,
          )
          .map((row) => ({
            id: row.id,
            name: row.name,
            agentId: row.agent_id,
            directory: row.directory,
            createdAt: row.created_at,
          })),
      }),
    });
    http.route({
      method: 'POST',
      url: '/api/external-conversation-roots',
      access: 'owner',
      body: createExternalConversationRootSchema,
      handler: async ({ user, body, reply }) => {
        requireBrowser(user);
        const directory = await this.safeRoot(body.directory);
        const root = {
          id: newId(),
          name: body.name,
          agentId: body.agentId,
          directory,
          createdAt: Date.now(),
        };
        db.run(
          'INSERT INTO agent_external_roots (id, user_id, name, agent_id, directory, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          root.id,
          user.userId,
          root.name,
          root.agentId,
          root.directory,
          root.createdAt,
        );
        this.context.services.audit.record({
          category: 'change',
          action: 'agent.external-root.added',
          userId: user.userId,
          subject: root.id,
          detail: root.agentId,
        });
        void reply.status(201);
        return root;
      },
    });
    http.route({
      method: 'DELETE',
      url: '/api/external-conversation-roots/:rootId',
      access: 'owner',
      params: rootParams,
      handler: ({ user, params }) => {
        requireBrowser(user);
        this.requireRoot(user, params.rootId);
        db.run(
          'DELETE FROM agent_external_roots WHERE id = ? AND user_id = ?',
          params.rootId,
          user.userId,
        );
      },
    });
    http.route({
      method: 'GET',
      url: '/api/external-conversation-roots/:rootId/conversations',
      access: 'owner',
      params: rootParams,
      handler: async ({ user, params }) => {
        const found = await this.discover(this.requireRoot(user, params.rootId));
        return {
          conversations: found.sources.map((source) => source.info),
          limited: found.limited,
        };
      },
    });
    http.route({
      method: 'POST',
      url: '/api/external-conversation-roots/:rootId/import',
      access: 'owner',
      params: rootParams,
      body: importExternalConversationSchema,
      handler: async ({ user, params, body, reply }) => {
        requireBrowser(user);
        const root = this.requireRoot(user, params.rootId);
        const lock = `${user.userId}:${body.sourceId}:${body.version}:${body.projectId}`;
        if (this.importing.has(lock))
          throw conflict('This transcript is already being imported.', 'external_import_busy');
        this.importing.add(lock);
        try {
          this.context.services.projects.requireAccess(user, body.projectId, 'write');
          const source = (await this.discover(root)).sources.find(
            (entry) => entry.info.id === body.sourceId,
          );
          if (!source)
            throw notFound('No such external conversation.', 'external_source_not_found');
          const file = await this.read(root, source.relative, false);
          if (file.version !== body.version)
            throw conflict(
              'The transcript changed. Refresh its metadata before importing.',
              'external_source_changed',
            );
          const existing = db.get<{ session_id: string }>(
            'SELECT session_id FROM agent_external_imports WHERE user_id = ? AND source_id = ? AND version = ? AND project_id = ?',
            user.userId,
            body.sourceId,
            body.version,
            body.projectId,
          );
          if (existing) return this.sessions.find(user, existing.session_id);
          const messages = readExternalMessages(file.text, root.agent_id);
          if (messages.length === 0)
            throw badRequest(
              'This file contains no supported conversation messages.',
              undefined,
              'external_source_unsupported',
            );
          const session = await this.sessions.create(
            user,
            {
              projectId: body.projectId,
              agentId: root.agent_id,
              title: source.info.title,
              permissionMode: 'ask',
            },
            this.runs.adapter(root.agent_id),
          );
          try {
            this.sessions.atomic(() => {
              let runId = newId();
              let started = false;
              const finish = () => {
                if (started)
                  this.sessions.append(session.id, runId, SESSION_EVENT.runFinished, {
                    runId,
                    status: 'completed',
                    error: null,
                    interruptedByRestart: false,
                    durationMs: 0,
                  });
              };
              for (const message of messages) {
                if (message.role === 'user') {
                  finish();
                  runId = newId();
                  started = true;
                  this.sessions.append(session.id, runId, SESSION_EVENT.messageUser, {
                    runId,
                    requestId: `import-${newId()}`,
                    origin: 'interactive',
                    text: message.text,
                    attachments: [],
                    quote: null,
                    continuesRunId: null,
                  });
                  this.sessions.append(session.id, runId, SESSION_EVENT.runStarted, {
                    runId,
                    agentId: root.agent_id,
                    model: session.model,
                    effort: null,
                    permissionMode: 'ask',
                    origin: 'interactive',
                  });
                } else {
                  if (!started) continue;
                  this.sessions.append(session.id, runId, SESSION_EVENT.messageAssistant, {
                    runId,
                    messageId: newId(),
                    text: message.text,
                    model: session.model,
                    parentToolCallId: null,
                    partial: false,
                  });
                }
              }
              finish();
              this.sessions.append(session.id, null, SESSION_EVENT.notice, {
                runId: null,
                level: 'info',
                code: 'external_import',
                text: 'Imported a read-only copy of external conversation text. Tools, approvals and native provider state were not imported. New messages start a separate provider conversation.',
              });
              db.run(
                'INSERT INTO agent_external_imports (user_id, source_id, version, project_id, session_id) VALUES (?, ?, ?, ?, ?)',
                user.userId,
                body.sourceId,
                body.version,
                body.projectId,
                session.id,
              );
              this.sessions.announceUpdate(session.id);
            });
            void reply.status(201);
            return this.sessions.find(user, session.id);
          } catch (error) {
            await this.context.services.agents.removeSession(user, session.id);
            throw error;
          }
        } finally {
          this.importing.delete(lock);
        }
      },
    });
  }
}
