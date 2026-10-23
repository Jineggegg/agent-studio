import { z } from 'zod';
import { idSchema } from './common.js';
/** Portable project-relative paths. Hidden components and parent traversal are never app roots. */
export const miniAppPathSchema = z
  .string()
  .min(1)
  .max(400)
  .refine(
    (s) => s === '.' || s.split('/').every((part) => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(part)),
    'Use a relative path without hidden or parent components.',
  );
const args = z
  .array(
    z
      .string()
      .max(300)
      .refine((s) => !s.includes('\0')),
  )
  .max(20)
  .default([]);
export const miniAppBuildSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none') }),
  z.strictObject({
    kind: z.literal('npm'),
    script: z
      .string()
      .min(1)
      .max(60)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9:_-]*$/),
    args,
  }),
  z.strictObject({ kind: z.literal('node'), script: miniAppPathSchema, args }),
]);
export const miniAppInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  directory: miniAppPathSchema,
  outputDirectory: miniAppPathSchema,
  build: miniAppBuildSchema,
});
export const miniAppCreateSchema = miniAppInputSchema.extend({
  html: z.string().max(200000).optional(),
});
export const miniAppSchema = miniAppInputSchema.extend({
  id: idSchema,
  projectId: idSchema,
  state: z.enum(['idle', 'building', 'ready', 'failed', 'cancelled']),
  log: z.string().max(70000),
  /** Changes only when the reviewed configuration is edited, independently of published artifacts. */
  configRevision: z.number().int().positive(),
  version: z.number().int().nonnegative(),
  publishedAt: z.number().nullable(),
  updatedAt: z.number(),
});
export const miniAppListSchema = z.object({
  apps: z.array(miniAppSchema),
  buildAvailable: z.boolean(),
  canWrite: z.boolean(),
});
export const miniAppConfirmSchema = z.strictObject({ confirmed: z.literal(true) });
export const miniAppBuildConfirmSchema = miniAppConfirmSchema.extend({
  configRevision: z.number().int().positive(),
});
export const miniAppPreviewSchema = z.object({
  url: z.string().startsWith('/api/mini-apps/preview/'),
  expiresAt: z.number(),
});
export const miniAppProposalInputSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('create'), app: miniAppCreateSchema }),
  z.strictObject({ operation: z.literal('build'), appId: idSchema }),
]);
/** Server-captured configuration shown to the human; the agent cannot choose a replacement snapshot. */
export const miniAppReviewedProposalSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('create'), app: miniAppCreateSchema }),
  z.strictObject({
    operation: z.literal('build'),
    appId: idSchema,
    configRevision: z.number().int().positive(),
    config: miniAppInputSchema,
  }),
]);
export const miniAppProposalSchema = z.object({
  id: idSchema,
  proposal: miniAppReviewedProposalSchema,
  createdAt: z.number(),
});
export const miniAppProposalsSchema = z.object({ proposals: z.array(miniAppProposalSchema) });
export type MiniApp = z.infer<typeof miniAppSchema>;
export type MiniAppInput = z.infer<typeof miniAppInputSchema>;
export type MiniAppCreate = z.infer<typeof miniAppCreateSchema>;
