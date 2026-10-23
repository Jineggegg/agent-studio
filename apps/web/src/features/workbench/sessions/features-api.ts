import {
  accountProfileSchema,
  accountProfilesSchema,
  accountProfileStatusSchema,
  checkpointRestoredSchema,
  conversationGroupSchema,
  conversationGroupsSchema,
  messageCheckpointsSchema,
  sessionSchema,
  type ForkSessionRequest,
} from '@agent-studio/protocol';
import { api } from '@/data/api';
const enc = encodeURIComponent;
export const conversationKeys = {
  groups: ['conversation-groups'] as const,
  profiles: ['agent-accounts'] as const,
};
export const conversationApi = {
  groups: () => api.get('/api/conversation-groups', { schema: conversationGroupsSchema }),
  createGroup: (name: string) =>
    api.post('/api/conversation-groups', { name }, { schema: conversationGroupSchema }),
  renameGroup: (id: string, name: string) =>
    api.patch(`/api/conversation-groups/${enc(id)}`, { name }, { schema: conversationGroupSchema }),
  deleteGroup: (id: string) => api.delete(`/api/conversation-groups/${enc(id)}`),
  fork: (id: string, input: ForkSessionRequest) =>
    api.post(`/api/sessions/${enc(id)}/fork`, input, { schema: sessionSchema, timeoutMs: 60_000 }),
  checkpoints: (id: string, seq: number) =>
    api.get(`/api/sessions/${enc(id)}/messages/${seq}/checkpoints`, {
      schema: messageCheckpointsSchema,
    }),
  restore: (id: string, checkpointId: string, currentVersion: string) =>
    api.post(
      `/api/sessions/${enc(id)}/checkpoints/${enc(checkpointId)}/restore`,
      { currentVersion, confirm: true },
      { schema: checkpointRestoredSchema },
    ),
  profiles: () => api.get('/api/agent-accounts', { schema: accountProfilesSchema }),
  createProfile: (agentId: 'claude-code' | 'codex', name: string) =>
    api.post('/api/agent-accounts', { agentId, name }, { schema: accountProfileSchema }),
  selectProfile: (id: string) =>
    api.put(`/api/agent-accounts/${enc(id)}/default`, undefined, { schema: accountProfileSchema }),
  profileStatus: (id: string) =>
    api.get(`/api/agent-accounts/${enc(id)}/status`, {
      schema: accountProfileStatusSchema,
      timeoutMs: 20_000,
    }),
};
