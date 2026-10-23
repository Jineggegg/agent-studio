import {
  SESSION_EVENT,
  conversationGroupSchema,
  forkSessionRequestSchema,
  idSchema,
  saveConversationGroupSchema,
  sendMessageRequestSchema,
  type AttachmentRef,
  type SessionEventData,
  type SessionEventType,
} from '@agent-studio/protocol';
import { z } from 'zod';
import { newId } from '../../kernel/crypto.js';
import { badRequest, conflict, notFound } from '../../kernel/errors.js';
import type { ModuleContext } from '../../kernel/module.js';
import type { AttachmentFiles } from './attachments.js';
import type { RunService } from './runtime.js';
import type { SessionService } from './sessions.js';
import type { AgentStore } from './store.js';

const params = z.object({ sessionId: idSchema });
const groupParams = z.object({ groupId: idSchema });
const MAX_BRANCH_EVENTS = 20_000;

/** Local copies never inherit the provider's resume id or active approvals. */
export function registerConversationRoutes(
  context: ModuleContext,
  deps: {
    store: AgentStore;
    sessions: SessionService;
    runs: RunService;
    files: AttachmentFiles;
    removeSession: (id: string) => Promise<void>;
  },
): void {
  const { http, db } = context;
  const { sessions, store, runs, files } = deps;
  http.route({
    method: 'GET',
    url: '/api/conversation-groups',
    access: 'user',
    handler: ({ user }) => ({
      groups: db
        .all<{ id: string; name: string; created_at: number }>(
          'SELECT id, name, created_at FROM agent_conversation_groups WHERE user_id = ? ORDER BY name, id',
          user.userId,
        )
        .map((row) =>
          conversationGroupSchema.parse({ id: row.id, name: row.name, createdAt: row.created_at }),
        ),
    }),
  });
  http.route({
    method: 'POST',
    url: '/api/conversation-groups',
    access: 'user',
    body: saveConversationGroupSchema,
    handler: ({ user, body, reply }) => {
      if (
        db.get(
          'SELECT id FROM agent_conversation_groups WHERE user_id = ? AND name = ?',
          user.userId,
          body.name,
        )
      )
        throw conflict('A group already has that name.', 'group_exists');
      const group = { id: newId(), name: body.name, createdAt: Date.now() };
      db.run(
        'INSERT INTO agent_conversation_groups (id, user_id, name, created_at) VALUES (?, ?, ?, ?)',
        group.id,
        user.userId,
        group.name,
        group.createdAt,
      );
      void reply.status(201);
      return group;
    },
  });
  http.route({
    method: 'PATCH',
    url: '/api/conversation-groups/:groupId',
    access: 'user',
    params: groupParams,
    body: saveConversationGroupSchema,
    handler: ({ user, params: p, body }) => {
      const group = sessions.requireGroup(user, p.groupId);
      if (
        db.get(
          'SELECT id FROM agent_conversation_groups WHERE user_id = ? AND name = ? AND id != ?',
          user.userId,
          body.name,
          group.id,
        )
      )
        throw conflict('A group already has that name.', 'group_exists');
      db.run(
        'UPDATE agent_conversation_groups SET name = ? WHERE id = ? AND user_id = ?',
        body.name,
        group.id,
        user.userId,
      );
      return { id: group.id, name: body.name, createdAt: group.created_at };
    },
  });
  http.route({
    method: 'DELETE',
    url: '/api/conversation-groups/:groupId',
    access: 'user',
    params: groupParams,
    handler: ({ user, params: p }) => {
      sessions.requireGroup(user, p.groupId);
      const affected = db.all<{ id: string }>(
        'SELECT id FROM agent_sessions WHERE group_id = ? AND user_id = ?',
        p.groupId,
        user.userId,
      );
      sessions.atomic(() => {
        db.run(
          'DELETE FROM agent_conversation_groups WHERE id = ? AND user_id = ?',
          p.groupId,
          user.userId,
        );
        for (const session of affected) sessions.announceUpdate(session.id);
      });
    },
  });
  http.route({
    method: 'POST',
    url: '/api/sessions/:sessionId/fork',
    access: 'user',
    params,
    body: forkSessionRequestSchema,
    handler: async ({ user, params: p, body, reply }) => {
      const source = sessions.requireSession(user, p.sessionId, 'write').row;
      if (store.activeRun(source.id))
        throw conflict('Wait for the current run to finish before branching.', 'session_busy');
      const boundary = body.throughSeq ?? source.last_seq;
      const events = store.eventsBefore(source.id, boundary + 1, MAX_BRANCH_EVENTS + 1);
      if (events.length > MAX_BRANCH_EVENTS)
        throw badRequest(
          'This conversation is too large to branch in one operation.',
          undefined,
          'branch_too_large',
        );
      const selected = events.find((event) => event.seq === boundary);
      if (
        body.throughSeq !== undefined &&
        (!selected ||
          ![SESSION_EVENT.messageUser, SESSION_EVENT.messageAssistant].includes(
            selected.type as typeof SESSION_EVENT.messageUser,
          ))
      )
        throw notFound('No such message.', 'message_not_found');
      if (body.replacement && selected?.type !== SESSION_EVENT.messageUser)
        throw badRequest(
          'Only a user message can be edited and resent.',
          undefined,
          'not_user_message',
        );
      const included = events.filter((event) => !body.replacement || event.seq < boundary);
      const target = await sessions.create(
        user,
        {
          projectId: source.project_id,
          agentId: source.agent_id,
          permissionMode: source.permission_mode,
          ...(source.model === null ? {} : { model: source.model }),
          ...(source.effort === null ? {} : { effort: source.effort }),
          title: body.title ?? source.title,
          parentSessionId: source.id,
          groupId: source.group_id,
          accountProfileId: source.account_profile_id,
          fastMode: source.fast_mode === 1,
        },
        runs.adapter(source.agent_id),
        { seed: source.seed ?? '' },
      );
      try {
        const copied = new Map<string, AttachmentRef>();
        for (const event of included) {
          if (event.type !== SESSION_EVENT.messageUser) continue;
          const data = JSON.parse(event.data) as { attachments: AttachmentRef[] };
          for (const attachment of data.attachments) {
            if (copied.has(attachment.id)) continue;
            const clone = (
              await files.copyTo(user, [attachment.id], target.id, { history: true })
            )[0]!;
            copied.set(attachment.id, clone);
            store.markAttachmentsSent(target.id, [clone.id], Date.now());
          }
        }
        sessions.atomic(() => {
          const runIds = new Map<string, string>();
          const finished = new Set<string>();
          for (const event of included) {
            // Approval ids are live actions, not history that a new branch may answer.
            if (
              event.type === SESSION_EVENT.approvalRequested ||
              event.type === SESSION_EVENT.approvalResolved
            )
              continue;
            const data = JSON.parse(event.data) as Record<string, unknown>;
            let runId: string | null = null;
            if (event.run_id !== null) {
              runId = runIds.get(event.run_id) ?? newId();
              runIds.set(event.run_id, runId);
              data.runId = runId;
            }
            if (event.type === SESSION_EVENT.messageUser) {
              data.requestId = `branch-${newId()}`;
              data.continuesRunId = null;
              data.attachments = (data.attachments as AttachmentRef[]).map((attachment) =>
                copied.get(attachment.id)!,
              );
            }
            if (event.type === SESSION_EVENT.runFinished && runId) finished.add(runId);
            sessions.append(
              target.id,
              runId,
              event.type as SessionEventType,
              data as SessionEventData<SessionEventType>,
            );
          }
          for (const runId of runIds.values()) {
            if (!finished.has(runId))
              sessions.append(target.id, runId, SESSION_EVENT.runFinished, {
                runId,
                status: 'stopped',
                error: null,
                interruptedByRestart: false,
                durationMs: 0,
              });
          }
          store.updateSession(target.id, { forkedAtSeq: boundary, chainId: null }, Date.now());
          sessions.append(target.id, null, SESSION_EVENT.notice, {
            runId: null,
            level: 'info',
            code: 'conversation_branched',
            text: 'Copied conversation history. Future messages use a separate provider conversation; workspace files are shared and have not been restored.',
          });
          sessions.announceUpdate(target.id);
        });
        if (body.replacement)
          await runs.send(user, target.id, sendMessageRequestSchema.parse(body.replacement));
        void reply.status(201);
        return sessions.find(user, target.id);
      } catch (error) {
        await deps.removeSession(target.id);
        throw error;
      }
    },
  });
}
