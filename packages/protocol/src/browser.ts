import { z } from 'zod';
import { idSchema } from './common.js';
export const browserCapabilitiesSchema = z.object({
  available: z.boolean(),
  reason: z.enum(['ready', 'disabled', 'sandbox-unavailable']),
  maxSessions: z.number().int(),
});
export const browserSessionSchema = z.object({
  id: idSchema,
  projectId: idSchema.nullable(),
  url: z.string(),
  title: z.string(),
  createdAt: z.number(),
  lastActiveAt: z.number(),
  hasScreenshot: z.boolean(),
});
export const browserSessionsSchema = z.object({ sessions: z.array(browserSessionSchema) });
export const createBrowserSchema = z
  .object({ projectId: idSchema.nullable().default(null) })
  .strict();
const urlSchema = z.string().url().max(2048);
export const browserActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('navigate'), url: urlSchema }).strict(),
  z
    .object({
      action: z.literal('click'),
      x: z.number().int().min(0).max(1279),
      y: z.number().int().min(0).max(799),
    })
    .strict(),
  z.object({ action: z.literal('type'), text: z.string().min(1).max(4000) }).strict(),
  z.object({ action: z.literal('screenshot') }).strict(),
]);
export const browserSnapshotSchema = z.object({
  session: browserSessionSchema,
  text: z.string().max(20_000),
  screenshotUrl: z.string().nullable(),
});
export type BrowserAction = z.infer<typeof browserActionSchema>;
export type BrowserSession = z.infer<typeof browserSessionSchema>;
