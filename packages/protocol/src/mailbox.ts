import { z } from 'zod';
import { idSchema } from './common.js';

export const mailProviderSchema = z.enum(['gmail', 'outlook']);
const header = z
  .string()
  .trim()
  .max(240)
  // eslint-disable-next-line no-control-regex -- Reject or remove control characters from untrusted mail data.
  .refine((s) => !/[\r\n\x00-\x1f\x7f]/.test(s), 'Header contains control characters.');
export const mailAddressSchema = z
  .string()
  .trim()
  .email()
  .max(254)
  .regex(/^[\x21-\x7e]+$/)
  .refine((s) => !/[<>\r\n]/.test(s));
export const mailRemoteIdSchema = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^[A-Za-z0-9_+=./-]+$/)
  .refine((s) => s !== '.' && s !== '..');
export const mailCredentialsSchema = z
  .strictObject({
    accessToken: z
      .string()
      .min(1)
      .max(16384)
      // eslint-disable-next-line no-control-regex -- Reject or remove control characters from untrusted mail data.
      .regex(/^[^\s\x00-\x1f\x7f]+$/),
    refreshToken: z.string().max(16384).optional(),
    clientId: z.string().max(512).optional(),
    clientSecret: z.string().max(4096).optional(),
  })
  .refine((v) => !v.refreshToken || Boolean(v.clientId), {
    message: 'A client ID is needed to refresh tokens.',
  });
export const mailAccountInputSchema = z.strictObject({
  provider: mailProviderSchema,
  name: header.min(1),
  credentials: mailCredentialsSchema,
});
export const mailAccountSchema = z.object({
  id: idSchema,
  provider: mailProviderSchema,
  name: z.string(),
  credentialSaved: z.boolean(),
  createdAt: z.number(),
});
export const mailAccountsSchema = z.object({ accounts: z.array(mailAccountSchema) });
export const mailFolderSchema = z.object({
  id: mailRemoteIdSchema,
  name: z.string().max(512),
  unread: z.number().int().nonnegative().nullable(),
});
export const mailFoldersSchema = z.object({
  folders: z.array(mailFolderSchema),
  truncated: z.boolean(),
});
export const mailAttachmentSchema = z.object({
  id: mailRemoteIdSchema,
  name: z.string().max(512),
  size: z.number().nonnegative(),
  type: z.string().max(200),
});
export const mailMessageSchema = z.object({
  id: mailRemoteIdSchema,
  subject: z.string().max(1000),
  from: z.string().max(2000),
  to: z.string().max(4000),
  receivedAt: z.number().nullable(),
  unread: z.boolean(),
  preview: z.string().max(1000),
  text: z.string().max(500000),
  attachments: z.array(mailAttachmentSchema).max(100),
});
export const mailListSchema = z.object({
  messages: z.array(mailMessageSchema).max(25),
  cursor: z.string().nullable(),
});
export const mailSearchSchema = z.strictObject({
  folder: mailRemoteIdSchema.optional(),
  search: z.string().trim().max(240).default(''),
  cursor: z.string().max(8192).optional(),
});
export const mailDraftInputSchema = z.strictObject({
  to: z.array(mailAddressSchema).min(1).max(20),
  subject: header,
  text: z.string().max(100000),
});
export const mailDraftSchema = mailDraftInputSchema.extend({
  id: idSchema,
  accountId: idSchema,
  revision: z.number().int().positive(),
  status: z.enum(['draft', 'sending', 'sent', 'uncertain']),
  updatedAt: z.number(),
});
export const mailDraftsSchema = z.object({ drafts: z.array(mailDraftSchema) });
export const mailSendSchema = z.strictObject({
  confirmed: z.literal(true),
  revision: z.number().int().positive(),
});
export const mailSummaryInputSchema = z.strictObject({
  consent: z.literal(true),
  providerId: z.string().min(1).max(80),
  model: z.string().min(1).max(200),
});
export const mailSummarySchema = z.object({ summary: z.string().max(20000) });
export const mailLocalModelsSchema = z.object({
  providers: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      models: z.array(z.object({ id: z.string(), name: z.string() })),
    }),
  ),
});
export type MailAccount = z.infer<typeof mailAccountSchema>;
export type MailCredentials = z.infer<typeof mailCredentialsSchema>;
export type MailMessage = z.infer<typeof mailMessageSchema>;
export type MailDraftInput = z.infer<typeof mailDraftInputSchema>;
export type MailDraft = z.infer<typeof mailDraftSchema>;
export type MailSearch = z.infer<typeof mailSearchSchema>;
