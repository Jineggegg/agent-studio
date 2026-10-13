import { z } from 'zod';
import { idSchema, roleSchema, timestampSchema, tokenScopeSchema } from './common.js';

export const usernameSchema = z
  .string()
  .trim()
  .min(2, 'Use at least 2 characters.')
  .max(40, 'Use at most 40 characters.')
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, 'Use letters, digits, dots, dashes and underscores.');

export const PASSWORD_MIN_LENGTH = 10;
export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters.`)
  .max(256, 'Use at most 256 characters.');

export const displayNameSchema = z.string().trim().min(1).max(80);

export const userSchema = z.object({
  id: idSchema,
  username: z.string(),
  displayName: z.string(),
  role: roleSchema,
  disabled: z.boolean(),
  createdAt: timestampSchema,
});
export type User = z.infer<typeof userSchema>;

export const signInMethodSchema = z.enum(['password', 'passkey', 'setup']);
export type SignInMethod = z.infer<typeof signInMethodSchema>;

export const authStateSchema = z.object({
  /** True until the first account has been created. */
  needsSetup: z.boolean(),
  authenticated: z.boolean(),
  user: userSchema.nullable(),
  /** Echo this in the `x-studio-csrf` header on every state-changing request. */
  csrfToken: z.string().nullable(),
  session: z
    .object({
      id: idSchema,
      method: signInMethodSchema,
      authenticatedAt: timestampSchema,
      expiresAt: timestampSchema,
      /** Whether sensitive actions can proceed without confirming identity again. */
      recentlyAuthenticated: z.boolean(),
    })
    .nullable(),
  serverTime: timestampSchema,
  version: z.string(),
});
export type AuthState = z.infer<typeof authStateSchema>;

export const setupRequestSchema = z.object({
  /** Printed by the server on first start; proves the caller controls the machine. */
  setupToken: z.string().min(1).max(200),
  username: usernameSchema,
  password: passwordSchema,
  displayName: displayNameSchema.optional(),
});
export type SetupRequest = z.infer<typeof setupRequestSchema>;

export const loginRequestSchema = z.object({
  username: z.string().trim().min(1).max(100),
  password: z.string().min(1).max(256),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const reauthRequestSchema = z.object({ password: z.string().min(1).max(256) });

export const changePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: passwordSchema,
});

export const deviceSessionSchema = z.object({
  id: idSchema,
  current: z.boolean(),
  method: signInMethodSchema,
  createdAt: timestampSchema,
  lastSeenAt: timestampSchema,
  expiresAt: timestampSchema,
  userAgent: z.string().nullable(),
  ip: z.string().nullable(),
});
export type DeviceSession = z.infer<typeof deviceSessionSchema>;

export const apiTokenSchema = z.object({
  id: idSchema,
  name: z.string(),
  scopes: z.array(tokenScopeSchema),
  createdAt: timestampSchema,
  lastUsedAt: timestampSchema.nullable(),
  expiresAt: timestampSchema.nullable(),
});
export type ApiToken = z.infer<typeof apiTokenSchema>;

export const createApiTokenRequestSchema = z.object({
  name: z.string().trim().min(1).max(80),
  scopes: z.array(tokenScopeSchema).min(1),
  /** Days until the token stops working; omit for a token that does not expire. */
  expiresInDays: z.number().int().min(1).max(3650).optional(),
});

/** The secret is shown exactly once, in the response to its creation. */
export const createdApiTokenSchema = z.object({ token: z.string(), record: apiTokenSchema });
export type CreatedApiToken = z.infer<typeof createdApiTokenSchema>;

export const createUserRequestSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  displayName: displayNameSchema.optional(),
  role: roleSchema.default('member'),
});

export const updateUserRequestSchema = z
  .object({
    displayName: displayNameSchema,
    role: roleSchema,
    disabled: z.boolean(),
    password: passwordSchema,
  })
  .partial();
