import { z } from 'zod';
import { idSchema } from './common.js';

export const libraryKindSchema = z.enum(['skill', 'command', 'mcp']);
export const libraryInputSchema = z
  .object({
    kind: libraryKindSchema,
    name: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9-]{0,39}$/),
    description: z.string().max(400).default(''),
    projectId: idSchema.nullable().default(null),
    content: z.string().max(32_000).default(''),
    endpoint: z.string().max(2048).default(''),
    allowPrivateNetwork: z.boolean().default(false),
    token: z.string().max(4096).optional(),
    clearToken: z.boolean().default(false),
    enabled: z.boolean().default(true),
  })
  .strict();
export type LibraryInput = z.infer<typeof libraryInputSchema>;
export const libraryItemSchema = libraryInputSchema.omit({ token: true, clearToken: true }).extend({
  id: idSchema,
  version: z.number().int().positive(),
  credentialSaved: z.boolean(),
  updatedAt: z.number(),
});
export type LibraryItem = z.infer<typeof libraryItemSchema>;
export const libraryListSchema = z.object({ items: z.array(libraryItemSchema) });
export const libraryUpdateSchema = libraryInputSchema.extend({
  version: z.number().int().positive(),
});
export const libraryListQuerySchema = z.object({ projectId: idSchema.optional() });
export const libraryToolsSchema = z.object({
  tools: z
    .array(
      z.object({
        name: z.string().max(128),
        description: z.string().max(8000).optional(),
        inputSchema: z.record(z.string(), z.unknown()),
      }),
    )
    .max(200),
});
export const libraryVersionSchema = z.object({ version: z.number().int().positive() }).strict();
