import { z } from 'zod';
import { mailAddressSchema } from './mailbox.js';
export const notificationChannelKindSchema = z.enum(['smtp', 'bark']);
const endpoint = z
  .string()
  .url()
  .max(500)
  .regex(
    /^https:\/\/(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[[0-9a-f:]+\])(?::[0-9]{1,5})?\/?$/i,
    'Use an HTTPS origin with no path, credentials or query.',
  );
export const smtpChannelInputSchema = z.strictObject({
  kind: z.literal('smtp'),
  enabled: z.boolean(),
  host: z
    .string()
    .min(1)
    .max(253)
    .regex(/^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/),
  port: z.literal(465).default(465),
  username: z
    .string()
    .min(1)
    .max(254)
    // eslint-disable-next-line no-control-regex -- Reject or remove control characters from untrusted mail data.
    .refine((s) => !/[\x00-\x1f\x7f]/.test(s)),
  password: z.string().max(4096).optional(),
  from: mailAddressSchema,
  to: mailAddressSchema,
});
export const barkChannelInputSchema = z.strictObject({
  kind: z.literal('bark'),
  enabled: z.boolean(),
  endpoint,
  deviceKey: z
    .string()
    .min(1)
    .max(512)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
});
export const notificationChannelInputSchema = z.discriminatedUnion('kind', [
  smtpChannelInputSchema,
  barkChannelInputSchema,
]);
export const externalNotificationChannelSchema = z.discriminatedUnion('kind', [
  smtpChannelInputSchema.omit({ password: true }).extend({ credentialSaved: z.boolean() }),
  barkChannelInputSchema.omit({ deviceKey: true }).extend({ credentialSaved: z.boolean() }),
]);
export const notificationChannelsSchema = z.object({
  channels: z.array(externalNotificationChannelSchema),
});
export const notificationChannelTestSchema = z.strictObject({ confirmed: z.literal(true) });
export const notificationChannelResultSchema = z.object({ accepted: z.boolean() });
export type NotificationChannelInput = z.infer<typeof notificationChannelInputSchema>;
export type ExternalNotificationChannel = z.infer<typeof externalNotificationChannelSchema>;
