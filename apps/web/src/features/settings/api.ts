import {
  type ApiToken,
  type DeviceSession,
  type LockStatus,
  type SystemInfo,
  type User,
  apiTokenSchema,
  deviceSessionSchema,
  lockStatusSchema,
  systemInfoSchema,
  userSchema,
} from '@agent-studio/protocol';
import { type UseQueryResult, useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { api } from '@/data/api';

/** Reads behind the settings pages. Writes live next to the controls that make them. */

export const settingsKeys = {
  sessions: ['auth', 'sessions'] as const,
  tokens: ['auth', 'tokens'] as const,
  passkeys: ['auth', 'passkeys'] as const,
  locks: ['auth', 'locks'] as const,
  audit: ['audit'] as const,
  users: ['users'] as const,
  system: ['system', 'info'] as const,
};

export const auditEventSchema = z.object({
  id: z.string(),
  at: z.number(),
  category: z.enum(['change', 'sign-in', 'failure']),
  action: z.string(),
  userId: z.string().nullable(),
  subject: z.string().nullable(),
  detail: z.string(),
  address: z.string().nullable(),
});
export type AuditEvent = z.infer<typeof auditEventSchema>;

export function useDeviceSessions(): UseQueryResult<DeviceSession[]> {
  return useQuery({
    queryKey: settingsKeys.sessions,
    queryFn: async ({ signal }) => (await api.get('/api/auth/sessions', { schema: z.object({ sessions: z.array(deviceSessionSchema) }), signal })).sessions,
  });
}

export function useApiTokens(): UseQueryResult<ApiToken[]> {
  return useQuery({
    queryKey: settingsKeys.tokens,
    queryFn: async ({ signal }) => (await api.get('/api/auth/tokens', { schema: z.object({ tokens: z.array(apiTokenSchema) }), signal })).tokens,
  });
}

export function useLockStatus(): UseQueryResult<LockStatus> {
  return useQuery({
    queryKey: settingsKeys.locks,
    queryFn: ({ signal }) => api.get('/api/auth/locks', { schema: lockStatusSchema, signal }),
    staleTime: 5_000,
  });
}

export function useAuditEvents(limit: number): UseQueryResult<AuditEvent[]> {
  return useQuery({
    queryKey: [...settingsKeys.audit, limit],
    queryFn: async ({ signal }) => (await api.get('/api/audit', { schema: z.object({ events: z.array(auditEventSchema) }), query: { limit }, signal })).events,
    staleTime: 5_000,
  });
}

export function useUsers(enabled = true): UseQueryResult<User[]> {
  return useQuery({
    queryKey: settingsKeys.users,
    queryFn: async ({ signal }) => (await api.get('/api/users', { schema: z.object({ users: z.array(userSchema) }), signal })).users,
    enabled,
  });
}

export function useSystemInfo(): UseQueryResult<SystemInfo> {
  return useQuery({
    queryKey: settingsKeys.system,
    queryFn: ({ signal }) => api.get('/api/system/info', { schema: systemInfoSchema, signal }),
    staleTime: 60_000,
  });
}

/** "iPhone · Safari" from a User-Agent string; null when it says nothing useful. */
export function describeUserAgent(userAgent: string | null): string | null {
  if (!userAgent) return null;
  const device = /iPhone/.test(userAgent)
    ? 'iPhone'
    : /iPad/.test(userAgent)
      ? 'iPad'
      : /Android/.test(userAgent)
        ? 'Android'
        : /Macintosh|Mac OS X/.test(userAgent)
          ? 'Mac'
          : /Windows/.test(userAgent)
            ? 'Windows'
            : /CrOS/.test(userAgent)
              ? 'ChromeOS'
              : /Linux/.test(userAgent)
                ? 'Linux'
                : null;
  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /OPR\//.test(userAgent)
      ? 'Opera'
      : /Firefox\//.test(userAgent)
        ? 'Firefox'
        : /Chrome\//.test(userAgent)
          ? 'Chrome'
          : /Safari\//.test(userAgent)
            ? 'Safari'
            : null;
  if (device && browser) return `${device} · ${browser}`;
  return device ?? browser;
}
