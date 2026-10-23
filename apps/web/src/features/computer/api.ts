import {
  computerDevicesSchema,
  computerPairingSchema,
  computerProposalSchema,
  computerProposalsSchema,
  computerScreenshotSchema,
  type ComputerAction,
} from '@agent-studio/protocol';
import { api } from '@/data/api';
export const computerApi = {
  devices: () => api.get('/api/computer/devices', { schema: computerDevicesSchema }),
  pair: () => api.post('/api/computer/pairings', {}, { schema: computerPairingSchema }),
  revoke: (id: string) => api.delete(`/api/computer/devices/${encodeURIComponent(id)}`),
  actions: () => api.get('/api/computer/actions', { schema: computerProposalsSchema }),
  propose: (deviceId: string, action: ComputerAction, reason: string) =>
    api.post(
      '/api/computer/actions',
      { deviceId, action, reason },
      { schema: computerProposalSchema },
    ),
  approve: (id: string, action: ComputerAction) =>
    api.post(
      `/api/computer/actions/${encodeURIComponent(id)}/approve`,
      { confirm: true, action },
      { schema: computerProposalSchema },
    ),
  reject: (id: string) =>
    api.post(
      `/api/computer/actions/${encodeURIComponent(id)}/reject`,
      {},
      { schema: computerProposalSchema },
    ),
  screenshot: (id: string) =>
    api.get(`/api/computer/actions/${encodeURIComponent(id)}/screenshot`, {
      schema: computerScreenshotSchema,
    }),
};
