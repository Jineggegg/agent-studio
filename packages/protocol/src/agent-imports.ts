import { z } from 'zod';
import { idSchema, timestampSchema } from './common.js';
export const externalConversationRootSchema = z.object({
  id: idSchema,
  name: z.string(),
  agentId: z.enum(['claude-code', 'codex']),
  directory: z.string(),
  createdAt: timestampSchema,
});
export const externalConversationRootsSchema = z.object({
  roots: z.array(externalConversationRootSchema),
});
export const createExternalConversationRootSchema = z.object({
  name: z.string().trim().min(1).max(80),
  agentId: z.enum(['claude-code', 'codex']),
  directory: z.string().trim().min(1).max(4096),
});
export const externalConversationSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  rootId: idSchema,
  agentId: z.enum(['claude-code', 'codex']),
  title: z.string(),
  modifiedAt: timestampSchema,
  version: z.string(),
  bytes: z.number().int().nonnegative(),
});
export type ExternalConversation = z.infer<typeof externalConversationSchema>;
export const externalConversationsSchema = z.object({
  conversations: z.array(externalConversationSchema),
  limited: z.boolean(),
});
export const importExternalConversationSchema = z.object({
  sourceId: z.string().regex(/^[a-f0-9]{64}$/),
  version: z.string().min(1).max(128),
  projectId: idSchema,
});
