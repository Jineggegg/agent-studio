import { z } from 'zod';
import {
  idSchema,
  reminderProposalInputSchema,
  reminderApprovalSchema,
  appLinks,
  type ReminderProposalInput,
} from '@agent-studio/protocol';
import { newId } from '../../kernel/crypto.js';
import { badRequest, conflict, notFound, forbidden } from '../../kernel/errors.js';
import type { ModuleContext } from '../../kernel/module.js';
import type { AgentToolContext } from '../../kernel/agent-tools.js';
import type { Principal } from '../../kernel/principal.js';
import type { AutomationService } from './service.js';
interface ProposalRow {
  id: string;
  project_id: string;
  user_id: string;
  proposal: string;
  created_at: number;
  expires_at: number;
}
const params = z.object({ projectId: idSchema, proposalId: idSchema });

/** Natural language is interpreted by the agent. Structured proposals still need a browser approval. */
export function registerReminderTools(
  context: ModuleContext,
  automations: AutomationService,
  now: () => number,
): void {
  const identity = (tool: AgentToolContext) => {
    const user = context.services.agents.principalFor(tool.userId);
    if (!user || !tool.projectId)
      throw forbidden('Open a project conversation before managing its reminders.');
    context.services.projects.requireAccess(user, tool.projectId, 'read');
    return { user, projectId: tool.projectId };
  };
  const preview = (user: Principal, projectId: string, input: ReminderProposalInput): number[] => {
    context.services.projects.requireAccess(user, projectId, 'write');
    if (input.operation === 'create') {
      if (input.trigger.type === 'event')
        throw badRequest('A reminder needs a time-based schedule.');
      const result = automations.preview({ timeZone: input.timeZone, trigger: input.trigger });
      return result.runs;
    }
    const item = automations.get(user, projectId, input.automationId);
    if (item.createdBy.id !== user.userId || item.action.type !== 'notify')
      throw forbidden('Only your own reminders can be changed with this tool.');
    return item.nextRunAt === null ? [] : [item.nextRunAt];
  };
  const present = (user: Principal, row: ProposalRow) => {
    const proposal = reminderProposalInputSchema.parse(JSON.parse(row.proposal));
    return {
      id: row.id,
      projectId: row.project_id,
      proposal,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      nextRuns: preview(user, row.project_id, proposal),
    };
  };
  context.agentTools.register({
    name: 'reminder_status',
    description:
      'Read this project’s reminders that belong to the current user, including timezone, schedule, pause state, and last execution. No changes.',
    input: z.strictObject({}),
    effect: 'read',
    handler: (tool) => {
      const { user, projectId } = identity(tool);
      return {
        text: JSON.stringify(
          automations
            .list(user, projectId)
            .automations.filter(
              (a) => a.createdBy.id === user.userId && a.action.type === 'notify',
            ),
        ),
      };
    },
  });
  context.agentTools.register({
    name: 'reminder_propose',
    description:
      'After the user asks for a reminder or to pause/resume one, translate their request into a structured proposal. Ask for missing dates/timezone; never invent consent or scope. This DOES NOT schedule or change anything: the person must open the project Automations screen and approve the displayed proposal. Use reminder_status to find an existing reminder. Only notify actions are supported.',
    input: reminderProposalInputSchema,
    effect: 'write',
    handler: (tool, input) => {
      const { user, projectId } = identity(tool);
      const nextRuns = preview(user, projectId, input);
      context.db.run('DELETE FROM reminder_proposals WHERE expires_at <= ?', now());
      if (
        (context.db.get<{ n: number }>(
          'SELECT count(*) AS n FROM reminder_proposals WHERE user_id = ?',
          user.userId,
        )?.n ?? 0) >= 20
      )
        throw conflict('Review or dismiss your pending reminder proposals first.');
      const id = newId(),
        at = now();
      context.db.run(
        'INSERT INTO reminder_proposals VALUES (?, ?, ?, ?, ?, ?)',
        id,
        projectId,
        user.userId,
        JSON.stringify(input),
        at,
        at + 24 * 60 * 60 * 1000,
      );
      return {
        text: JSON.stringify({
          proposalId: id,
          status: 'awaiting-human-approval',
          nextRuns,
          reviewPath: appLinks.automations(projectId),
          expiresAt: at + 24 * 60 * 60 * 1000,
        }),
      };
    },
  });
  context.http.route({
    method: 'GET',
    url: '/api/projects/:projectId/reminder-proposals',
    access: 'user',
    params: z.object({ projectId: idSchema }),
    handler: ({ user, params }) => {
      context.services.projects.requireAccess(user, params.projectId, 'read');
      const rows = context.db.all<ProposalRow>(
        'SELECT * FROM reminder_proposals WHERE user_id = ? AND project_id = ? AND expires_at > ? ORDER BY created_at',
        user.userId,
        params.projectId,
        now(),
      );
      // Proposals can outlive the target reminder. Keep them dismissible without failing the list.
      return {
        proposals: rows.map((row) => {
          try {
            return present(user, row);
          } catch {
            return {
              id: row.id,
              projectId: row.project_id,
              proposal: reminderProposalInputSchema.parse(JSON.parse(row.proposal)),
              createdAt: row.created_at,
              expiresAt: row.expires_at,
              nextRuns: [],
            };
          }
        }),
      };
    },
  });
  context.http.route({
    method: 'POST',
    url: '/api/projects/:projectId/reminder-proposals/:proposalId/approve',
    access: 'user',
    sessionOnly: true,
    params,
    body: reminderApprovalSchema,
    handler: async ({ user, params }) => {
      const row = context.db.get<ProposalRow>(
        'SELECT * FROM reminder_proposals WHERE user_id = ? AND project_id = ? AND id = ? AND expires_at > ?',
        user.userId,
        params.projectId,
        params.proposalId,
        now(),
      );
      if (!row) throw notFound('No pending reminder proposal.');
      const input = reminderProposalInputSchema.parse(JSON.parse(row.proposal));
      preview(user, params.projectId, input);
      // Consume before awaiting so concurrent confirmations cannot schedule twice.
      if (
        context.db.run(
          'DELETE FROM reminder_proposals WHERE user_id = ? AND id = ?',
          user.userId,
          row.id,
        ).changes !== 1
      )
        throw conflict('This proposal was already reviewed.');
      const result =
        input.operation === 'create'
          ? await automations.create(user, params.projectId, {
              name: input.name,
              timeZone: input.timeZone,
              trigger: input.trigger,
              action: { type: 'notify', message: input.message },
              enabled: true,
            })
          : await automations.update(user, params.projectId, input.automationId, {
              enabled: input.operation === 'resume',
            });
      context.services.audit.record({
        category: 'change',
        action: 'reminder.proposal.approved',
        userId: user.userId,
        subject: row.id,
      });
      return result;
    },
  });
  context.http.route({
    method: 'DELETE',
    url: '/api/projects/:projectId/reminder-proposals/:proposalId',
    access: 'user',
    params,
    handler: ({ user, params }) => {
      context.services.projects.requireAccess(user, params.projectId, 'read');
      context.db.run(
        'DELETE FROM reminder_proposals WHERE user_id = ? AND project_id = ? AND id = ?',
        user.userId,
        params.projectId,
        params.proposalId,
      );
    },
  });
}
