/**
 * `@agent-studio/plugin-sdk` — what the server-side code of a plugin imports.
 *
 *     import { definePlugin } from '@agent-studio/plugin-sdk';
 *
 *     definePlugin({
 *       tools: { greet: (input, { user }) => `Hello, ${user.displayName}!` },
 *     });
 *
 * The Studio provides this package to every plugin process, so a plugin needs
 * neither `node_modules` nor a build step. The browser half is a separate
 * module: `@agent-studio/plugin-sdk/panel`.
 */
export { HostError, PLUGIN_PROTOCOL_VERSION, createPluginRuntime, definePlugin } from './plugin.js';
export { DEFAULT_MAX_MESSAGE_BYTES, createDecoder, encodeMessage } from './framing.js';
export type {
  CallContext,
  Decoder,
  FramingProblem,
  HookContext,
  HookEvent,
  HookHandler,
  HookPayloads,
  HostFetchInit,
  HostFetchResponse,
  HostFile,
  HostProject,
  HostStorage,
  Json,
  LifecycleContext,
  LogLevel,
  PanelMethodContext,
  PanelMethodHandler,
  PluginDefinition,
  PluginHost,
  PluginInfo,
  PluginRuntime,
  PluginUser,
  RuntimeIo,
  ToolContext,
  ToolHandler,
  ToolResult,
} from './types.js';
