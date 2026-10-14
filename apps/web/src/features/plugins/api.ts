import {
  type EnablePluginRequest,
  type InstallPluginRequest,
  type OpenPluginPanelRequest,
  type PluginPanelRpcResponse,
  pluginContributionsSchema,
  pluginListSchema,
  pluginPanelGrantSchema,
  pluginPanelRpcResponseSchema,
  pluginSourceListSchema,
  pluginSummarySchema,
} from '@agent-studio/protocol';
import { api } from '@/data/api';

/**
 * Every request the plugins feature makes, each validated against the
 * protocol's schema. Management is the owner's; contributions, panels and
 * their calls are for every signed-in user.
 */
const enc = encodeURIComponent;
const withSignal = (signal?: AbortSignal) => (signal ? { signal } : {});

export const pluginKeys = {
  all: ['plugins'] as const,
  list: ['plugins', 'list'] as const,
  sources: ['plugins', 'sources'] as const,
  contributions: ['plugins', 'contributions'] as const,
};

export const pluginsApi = {
  list: (signal?: AbortSignal) => api.get('/api/plugins', { schema: pluginListSchema, ...withSignal(signal) }),
  sources: (signal?: AbortSignal) => api.get('/api/plugins/sources', { schema: pluginSourceListSchema, ...withSignal(signal) }),
  get: (id: string, signal?: AbortSignal) => api.get(`/api/plugins/${enc(id)}`, { schema: pluginSummarySchema, ...withSignal(signal) }),
  /** Downloading a repository can take a while; the server stops it after its own limit. */
  install: (request: InstallPluginRequest) => api.post('/api/plugins/install', request, { schema: pluginSummarySchema, timeoutMs: 180_000 }),
  enable: (id: string, request: EnablePluginRequest) => api.post(`/api/plugins/${enc(id)}/enable`, request, { schema: pluginSummarySchema }),
  disable: (id: string) => api.post(`/api/plugins/${enc(id)}/disable`, undefined, { schema: pluginSummarySchema }),
  update: (id: string) => api.post(`/api/plugins/${enc(id)}/update`, undefined, { schema: pluginSummarySchema, timeoutMs: 180_000 }),
  uninstall: (id: string, deleteData: boolean) => api.post(`/api/plugins/${enc(id)}/uninstall`, { deleteData }),

  contributions: (signal?: AbortSignal) => api.get('/api/plugins/contributions', { schema: pluginContributionsSchema, ...withSignal(signal) }),
  openPanel: (pluginId: string, panelId: string, request: OpenPluginPanelRequest, signal?: AbortSignal) =>
    api.post(`/api/plugins/${enc(pluginId)}/panels/${enc(panelId)}/open`, request, { schema: pluginPanelGrantSchema, ...withSignal(signal) }),
  /** A panel's call to its plugin. The grant's `panel` names the open panel; it never leaves this page. */
  rpc: (pluginId: string, panel: string, method: string, params: unknown): Promise<PluginPanelRpcResponse> =>
    api.post(`/api/plugins/${enc(pluginId)}/rpc`, { panel, method, ...(params === undefined ? {} : { params }) }, { schema: pluginPanelRpcResponseSchema, timeoutMs: 45_000 }),
};
