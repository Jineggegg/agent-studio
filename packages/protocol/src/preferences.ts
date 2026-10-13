import { z } from 'zod';

/**
 * Account-level preferences: a small key → JSON value map that follows the
 * user to every device. Keys are namespaced by feature ("appearance.theme",
 * "home.layout"); the server stores values without interpreting them.
 */
export const preferenceKeySchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9_-]+)*$/, 'Use dotted names such as "appearance.theme".');

export const preferencesSchema = z.record(z.string(), z.unknown());
export type Preferences = z.infer<typeof preferencesSchema>;

/** A patch: keys set to null are removed. */
export const updatePreferencesRequestSchema = z.object({
  values: z.record(preferenceKeySchema, z.unknown()),
});

export const PREFERENCES_CHANGED = 'preferences.changed';
export const MAX_PREFERENCE_BYTES = 64 * 1024;
