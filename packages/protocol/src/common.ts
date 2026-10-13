import { z } from 'zod';

/** Identifiers are 26 lowercase base32 characters and sort by creation time. */
export const idSchema = z.string().regex(/^[0-9a-z]{26}$/, 'Not a valid id.');
export type Id = z.infer<typeof idSchema>;

export const roleSchema = z.enum(['owner', 'member']);
export type Role = z.infer<typeof roleSchema>;

export const tokenScopeSchema = z.enum(['read', 'write', 'admin']);
export type TokenScope = z.infer<typeof tokenScopeSchema>;

/** Every failed request answers with this shape. `code` is stable and machine-readable. */
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof apiErrorSchema>;

/** Milliseconds since the Unix epoch. */
export const timestampSchema = z.number().int().nonnegative();

/** Query parameters arrive as strings; these coerce and bound the common ones. */
export const limitQuery = (fallback: number, max: number) =>
  z.coerce.number().int().min(1).max(max).default(fallback);

export const HEADER_CSRF = 'x-studio-csrf';
