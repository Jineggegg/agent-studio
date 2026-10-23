import { z } from 'zod';
import { automationTriggerSchema, timeZoneSchema } from './automation.js';
import { idSchema } from './common.js';
export const reminderProposalInputSchema = z.discriminatedUnion('operation', [
  z.strictObject({
    operation: z.literal('create'),
    name: z.string().trim().min(1).max(80),
    message: z.string().trim().min(1).max(240),
    timeZone: timeZoneSchema,
    trigger: automationTriggerSchema,
  }),
  z.strictObject({ operation: z.enum(['pause', 'resume']), automationId: idSchema }),
]);
export const reminderProposalSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  proposal: reminderProposalInputSchema,
  createdAt: z.number(),
  expiresAt: z.number(),
  nextRuns: z.array(z.number()),
});
export const reminderProposalsSchema = z.object({ proposals: z.array(reminderProposalSchema) });
export const reminderApprovalSchema = z.strictObject({ confirmed: z.literal(true) });
export type ReminderProposalInput = z.infer<typeof reminderProposalInputSchema>;
