import { z } from 'zod';
import { idSchema, timestampSchema } from './common.js';

export const COMPUTER_LIMITS = {
  screenshotBytes: 2 * 1024 * 1024,
  devicesPerUser: 5,
  pendingPerDevice: 10,
} as const;
export const computerActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('screenshot') }).strict(),
  z
    .object({
      kind: z.literal('click'),
      x: z.number().int().min(0).max(32767),
      y: z.number().int().min(0).max(32767),
    })
    .strict(),
  z.object({ kind: z.literal('type'), text: z.string().min(1).max(2000) }).strict(),
]);
export type ComputerAction = z.infer<typeof computerActionSchema>;
export const computerDeviceSchema = z.object({
  id: idSchema,
  name: z.string(),
  platform: z.literal('windows'),
  createdAt: timestampSchema,
  lastSeenAt: timestampSchema.nullable(),
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
});
export const computerDevicesSchema = z.object({ devices: z.array(computerDeviceSchema) });
export type ComputerDevice = z.infer<typeof computerDeviceSchema>;
export const computerPairingSchema = z.object({ token: z.string(), expiresAt: timestampSchema });
const secretToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const computerPairRequestSchema = z
  .object({
    token: secretToken,
    name: z.string().trim().min(1).max(80),
    platform: z.literal('windows'),
  })
  .strict();
export const computerPairResponseSchema = z.object({ deviceId: idSchema, token: secretToken });
export const computerProposalInputSchema = z
  .object({
    deviceId: idSchema,
    action: computerActionSchema,
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
export const computerProposalSchema = computerProposalInputSchema.extend({
  id: idSchema,
  sessionId: idSchema.nullable(),
  status: z.enum([
    'pending',
    'approved',
    'leased',
    'executing',
    'completed',
    'rejected',
    'expired',
    'failed',
  ]),
  createdAt: timestampSchema,
  expiresAt: timestampSchema,
  result: z.string().nullable(),
  screenshotAvailable: z.boolean(),
});
export type ComputerProposal = z.infer<typeof computerProposalSchema>;
export const computerProposalsSchema = z.object({ actions: z.array(computerProposalSchema) });
export const computerApproveSchema = z
  .object({ confirm: z.literal(true), action: computerActionSchema })
  .strict();
export const computerPollSchema = z
  .object({ width: z.number().int().min(1).max(32768), height: z.number().int().min(1).max(32768) })
  .strict();
export const computerLeaseSchema = z
  .object({
    action: computerActionSchema,
    id: idSchema,
    lease: secretToken,
    expiresAt: timestampSchema,
  })
  .nullable();
export const computerLeaseRequestSchema = z.object({ lease: secretToken }).strict();
export const computerCompleteSchema = computerLeaseRequestSchema
  .extend({
    success: z.boolean(),
    screenshot: z
      .string()
      .max(Math.ceil(COMPUTER_LIMITS.screenshotBytes / 3) * 4)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/)
      .optional(),
  })
  .strict();
export const computerScreenshotSchema = z.object({
  mediaType: z.literal('image/jpeg'),
  data: z.string(),
});
