import { AGENT_LIMITS, type LibraryInput, type LibraryItem } from '@agent-studio/protocol';
import { badRequest, conflict, forbidden, notFound, rateLimited } from '../../kernel/errors.js';
import { newId } from '../../kernel/crypto.js';
import type { ModuleContext } from '../../kernel/module.js';
import { guardedRequest, checkUrl } from '../../kernel/net.js';
import type { Principal } from '../../kernel/principal.js';
import { redactSecrets } from '../../kernel/redact.js';
import { mcpOperation, mcpResultText } from './mcp-client.js';

interface Row {
  id: string;
  user_id: string;
  project_id: string | null;
  kind: LibraryItem['kind'];
  name: string;
  description: string;
  content: string;
  endpoint: string;
  private_network: number;
  enabled: number;
  version: number;
  updated_at: number;
}
const secret = (id: string) => `tool-library:${id}:token`;
const missing = () => notFound('That tool library entry is not available.');

export class ToolLibrary {
  readonly #active = new Set<string>();
  constructor(
    readonly context: ModuleContext,
    readonly transport: typeof guardedRequest = guardedRequest,
  ) {}

  #scope(user: Principal, projectId: string | null, access: 'read' | 'write' = 'read'): void {
    if (projectId) this.context.services.projects.requireAccess(user, projectId, access);
  }
  #row(user: Principal, id: string, access: 'read' | 'write' = 'read'): Row {
    const row = this.context.db.get<Row>(
      'SELECT * FROM tool_library WHERE id = ? AND user_id = ?',
      id,
      user.userId,
    );
    if (!row) throw missing();
    this.#scope(user, row.project_id, access);
    return row;
  }
  #present(row: Row): LibraryItem {
    return {
      id: row.id,
      kind: row.kind,
      name: row.name,
      description: row.description,
      projectId: row.project_id,
      content: row.content,
      endpoint: row.endpoint,
      allowPrivateNetwork: row.private_network === 1,
      enabled: row.enabled === 1,
      version: row.version,
      updatedAt: row.updated_at,
      credentialSaved: this.context.secrets.describe(secret(row.id)) !== null,
    };
  }
  list(user: Principal, projectId: string | null): LibraryItem[] {
    this.#scope(user, projectId);
    return this.context.db
      .all<Row>(
        'SELECT * FROM tool_library WHERE user_id = ? AND (project_id IS NULL OR project_id = ?) ORDER BY name LIMIT 500',
        user.userId,
        projectId,
      )
      .map((row) => this.#present(row));
  }
  get(user: Principal, id: string): LibraryItem {
    return this.#present(this.#row(user, id));
  }
  #validate(user: Principal, input: LibraryInput): void {
    this.#scope(user, input.projectId, 'write');
    if (input.kind === 'mcp') {
      if (input.allowPrivateNetwork && user.role !== 'owner')
        throw forbidden('Only the owner may allow private network endpoints.');
      // Even explicit private-network access uses HTTPS; no credentials over plaintext LAN HTTP.
      const url = checkUrl(input.endpoint, { allowPrivateNetwork: input.allowPrivateNetwork });
      if (url.search || url.hash)
        throw badRequest('Store credentials in the token field, not in the endpoint URL.');
      if (input.content) throw badRequest('MCP connections do not have prompt content.');
      if (input.token && /[\r\n]/.test(input.token)) throw badRequest('Invalid token.');
    } else {
      if (!input.content.trim())
        throw badRequest('Add the skill instructions or command template.');
      if (input.endpoint || input.token || input.allowPrivateNetwork)
        throw badRequest('Only MCP connections may configure an endpoint or credential.');
    }
  }
  save(user: Principal, input: LibraryInput, edit?: { id: string; version: number }): LibraryItem {
    this.#validate(user, input);
    const before = edit ? this.#row(user, edit.id, 'write') : null;
    if (before && (before.version !== edit!.version || before.kind !== input.kind))
      throw conflict('The entry changed. Reload it before saving.');
    const duplicate = this.context.db.get<{ id: string }>(
      "SELECT id FROM tool_library WHERE user_id = ? AND kind = ? AND name = ? AND coalesce(project_id,'') = ? AND id != ?",
      user.userId,
      input.kind,
      input.name,
      input.projectId ?? '',
      before?.id ?? '',
    );
    if (duplicate) throw conflict('That name is already used in this scope.');
    const count = this.context.db.get<{ count: number }>(
      'SELECT COUNT(*) AS count FROM tool_library WHERE user_id = ?',
      user.userId,
    )!.count;
    if (!before && count >= 200)
      throw badRequest('The tool library is full. Remove an entry first.');
    const id = before?.id ?? newId();
    this.context.db.transaction(() => {
      if (before) {
        this.context.db.run(
          'UPDATE tool_library SET project_id=?, name=?, description=?, content=?, endpoint=?, private_network=?, enabled=?, version=version+1, updated_at=? WHERE id=? AND user_id=?',
          input.projectId,
          input.name,
          input.description,
          input.content,
          input.endpoint,
          input.allowPrivateNetwork ? 1 : 0,
          input.enabled ? 1 : 0,
          Date.now(),
          id,
          user.userId,
        );
      } else {
        this.context.db.run(
          'INSERT INTO tool_library (id,user_id,project_id,kind,name,description,content,endpoint,private_network,enabled,version,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,1,?)',
          id,
          user.userId,
          input.projectId,
          input.kind,
          input.name,
          input.description,
          input.content,
          input.endpoint,
          input.allowPrivateNetwork ? 1 : 0,
          input.enabled ? 1 : 0,
          Date.now(),
        );
      }
      if (input.clearToken || (before && before.endpoint !== input.endpoint))
        this.context.secrets.delete(secret(id));
      if (input.token) this.context.secrets.put(secret(id), input.token);
    });
    this.context.services.audit.record({
      category: 'change',
      action: 'tool-library.saved',
      userId: user.userId,
      subject: id,
    });
    return this.get(user, id);
  }
  remove(user: Principal, id: string, version: number): void {
    if (this.#row(user, id, 'write').version !== version)
      throw conflict('The entry changed. Reload it before deleting.');
    this.context.db.transaction(() => {
      this.context.db.run('DELETE FROM tool_library WHERE id=? AND user_id=?', id, user.userId);
      this.context.secrets.delete(secret(id));
    });
    this.context.services.audit.record({
      category: 'change',
      action: 'tool-library.deleted',
      userId: user.userId,
      subject: id,
    });
  }
  /** Expansion happens once, after receipt deduplication, before durable queueing. No shell execution. */
  expand(user: Principal, projectId: string | null, text: string): string {
    const match = /^\/(skill:)?([a-z][a-z0-9-]{0,39})(?:\s+([\s\S]*))?$/.exec(text.trim());
    if (!match) return text;
    const kind = match[1] ? 'skill' : 'command';
    const entries = this.list(user, projectId).filter(
      (entry) => entry.enabled && entry.kind === kind && entry.name === match[2],
    );
    const entry = entries.find((item) => item.projectId !== null) ?? entries[0];
    if (!entry) return text;
    const args = match[3] ?? '';
    const body = entry.content.includes('$ARGUMENTS')
      ? entry.content.replaceAll('$ARGUMENTS', args)
      : `${entry.content}${args ? `\n\n${args}` : ''}`;
    const expanded = `[User-selected ${kind}: ${entry.name}]\n${body}`;
    if (expanded.length > AGENT_LIMITS.messageChars)
      throw badRequest('The expanded command is too long.');
    return expanded;
  }
  async mcp(
    user: Principal,
    id: string,
    version: number,
    method: 'tools/list' | 'tools/call',
    params: Record<string, unknown>,
    runProject?: string | null,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const authorize = () => {
      signal?.throwIfAborted();
      const current = this.context.services.agents.principalFor(user.userId);
      if (!current) throw missing();
      const row = this.#row(current, id);
      if (row.kind !== 'mcp' || !row.enabled) throw missing();
      if (runProject !== undefined && row.project_id !== null && row.project_id !== runProject)
        throw missing();
      if (row.version !== version)
        throw conflict(
          'This MCP configuration changed. List the connections and request approval again.',
        );
      if (row.private_network && current.role !== 'owner') throw forbidden();
      return row;
    };
    const row = authorize();
    if (Buffer.byteLength(JSON.stringify(params)) > 64_000)
      throw badRequest('The tool arguments are too large.');
    if (this.#active.has(user.userId) || this.#active.size >= 8) throw rateLimited(5);
    this.#active.add(user.userId);
    const token = this.context.secrets.reveal(secret(id));
    try {
      const result = await mcpOperation({
        endpoint: row.endpoint,
        token,
        policy: { allowPrivateNetwork: Boolean(row.private_network) },
        method,
        params,
        ...(signal ? { signal } : {}),
        request: (url, options) => {
          authorize();
          return this.transport(url, options);
        },
      });
      authorize();
      this.context.services.audit.record({
        category: 'change',
        action: 'tool-library.mcp.request',
        userId: user.userId,
        subject: id,
        detail: method,
      });
      if (method === 'tools/call') return mcpResultText(result, token);
      const json = JSON.stringify(result, (_key, value: unknown) =>
        typeof value === 'string'
          ? redactSecrets(token ? value.split(token).join('[redacted]') : value)
          : value,
      );
      return JSON.parse(json) as unknown;
    } finally {
      this.#active.delete(user.userId);
    }
  }
}

declare module '../../kernel/module.js' {
  interface Services {
    toolLibrary?: ToolLibrary;
  }
}
