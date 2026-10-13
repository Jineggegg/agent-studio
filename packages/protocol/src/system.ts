import { z } from 'zod';
import { timestampSchema } from './common.js';

export const sandboxStatusSchema = z.object({
  /** `bwrap`: agent processes cannot see the Studio's data. `none`: they run unsandboxed. */
  mode: z.enum(['bwrap', 'none']),
  reason: z.string().optional(),
});
export type SandboxStatus = z.infer<typeof sandboxStatusSchema>;

/** Something about the way this instance is configured that its owner should know. */
export const configWarningSchema = z.object({
  /** Stable identifier, e.g. "sandbox-off". */
  code: z.string(),
  severity: z.enum(['info', 'warning', 'danger']),
  /** One plain sentence for the owner. */
  message: z.string(),
  /** How to fix it, for whoever administers the machine. */
  detail: z.string(),
});
export type ConfigWarning = z.infer<typeof configWarningSchema>;

export const systemInfoSchema = z.object({
  version: z.string(),
  startedAt: timestampSchema,
  sandbox: sandboxStatusSchema,
  terminalEnabled: z.boolean(),
  // The rest is shown to the owner only.
  node: z.string().optional(),
  platform: z.string().optional(),
  publicOrigins: z.array(z.string()).optional(),
  workspaceRoots: z.array(z.string()).optional(),
  dataDir: z.string().optional(),
  warnings: z.array(configWarningSchema).optional(),
});
export type SystemInfo = z.infer<typeof systemInfoSchema>;
