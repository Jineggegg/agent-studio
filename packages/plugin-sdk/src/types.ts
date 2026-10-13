/**
 * Types of the plugin SDK. This file holds declarations only; the code lives
 * in plain JavaScript modules next to it so that a plugin can run it without
 * any build step.
 */

/** Anything that survives `JSON.stringify` unchanged. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** The person a call is made for. A plugin is told who — never given their credentials. */
export interface PluginUser {
  readonly id: string;
  readonly displayName: string;
}

export interface PluginInfo {
  readonly id: string;
  readonly version: string;
  /** The Studio's version. */
  readonly studioVersion: string;
  /** Permissions the owner granted — possibly fewer than the manifest asks for. */
  readonly permissions: readonly string[];
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** The plugin's own key-value space. Other plugins cannot see it. */
export interface HostStorage {
  /** The stored value, or `undefined` when there is none. */
  get<T extends Json = Json>(key: string): Promise<T | undefined>;
  /** Refused during a tool call whose effect is `read`. */
  set(key: string, value: Json): Promise<void>;
  /** Resolves to whether there was something to delete. */
  delete(key: string): Promise<boolean>;
  /** Keys in order, optionally only those starting with `prefix`. */
  list(options?: { prefix?: string; limit?: number }): Promise<string[]>;
}

export interface HostFetchInit {
  method?: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Only a short allow-list of header names is passed on; the rest is refused. */
  headers?: Record<string, string>;
  body?: string;
  /** How the response body is returned. Default `text`. */
  responseType?: 'text' | 'base64';
}

export interface HostFetchResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly encoding: 'utf8' | 'base64';
}

export interface HostProject {
  readonly id: string;
  readonly name: string;
  readonly access: 'read' | 'write';
}

export interface HostFile {
  /** Relative to the project folder, with forward slashes. */
  readonly path: string;
  /** Size of the whole file in bytes. */
  readonly size: number;
  /** True when the file is longer than what was returned. */
  readonly truncated: boolean;
  readonly encoding: 'utf8' | 'base64';
  readonly content: string;
}

/**
 * Everything a plugin can ask the Studio to do. Each call is checked against
 * the granted permissions and is bound to the call it was made in: once a
 * handler has returned, its `host` stops working.
 */
export interface PluginHost {
  /** Adds a line to the plugin's log, which the owner can read. Never fails. */
  log(message: string, level?: LogLevel): void;
  readonly storage: HostStorage;
  /** Needs `notifications` and a user. */
  notify(notification: { title: string; body?: string }): Promise<void>;
  readonly http: {
    /** Needs `network:<host>` for the address's host. https only, public addresses only, redirects are not followed. */
    fetch(url: string, init?: HostFetchInit): Promise<HostFetchResponse>;
  };
  readonly projects: {
    /** Needs `projects:read` and a user. Only projects that user can see. */
    list(): Promise<HostProject[]>;
  };
  readonly files: {
    /** Needs `projects:read` and a user. Text files come back as UTF-8, others as base64. */
    read(projectId: string, path: string, options?: { maxBytes?: number }): Promise<HostFile>;
  };
}

export interface CallContext {
  readonly host: PluginHost;
  readonly plugin: PluginInfo;
  /** Who the call is for; `null` for hooks and start-up, which act for nobody. */
  readonly user: PluginUser | null;
  readonly projectId: string | null;
}

export interface ToolContext extends CallContext {
  readonly user: PluginUser;
  readonly tool: string;
  readonly run: { readonly runId: string; readonly sessionId: string; readonly agentId: string };
}

export interface PanelMethodContext extends CallContext {
  readonly user: PluginUser;
  readonly method: string;
  readonly panel: { readonly panelId: string; readonly slot: 'home-tile' | 'project-tab' | 'settings-page' };
}

export interface HookPayloads {
  'project.created': { projectId: string };
  'project.deleted': { projectId: string };
  'run.started': { runId: string; sessionId: string; projectId: string | null; agentId: string };
  'run.finished': { runId: string; sessionId: string; projectId: string | null; agentId: string; status: string };
}
export type HookEvent = keyof HookPayloads;

export interface HookContext<E extends HookEvent = HookEvent> extends CallContext {
  readonly user: null;
  readonly event: E;
}

export interface LifecycleContext extends CallContext {
  readonly user: null;
}

/** What a tool hands back to the agent: text, or text marked as an error. */
export type ToolResult = string | { text: string; isError?: boolean };

type MaybePromise<T> = T | Promise<T>;

export type ToolHandler = (input: Record<string, Json>, context: ToolContext) => MaybePromise<ToolResult>;
export type PanelMethodHandler = (params: Json | undefined, context: PanelMethodContext) => MaybePromise<Json | void>;
export type HookHandler<E extends HookEvent> = (payload: HookPayloads[E], context: HookContext<E>) => MaybePromise<void>;

export interface PluginDefinition {
  /** One function per tool named in the manifest. */
  tools?: Record<string, ToolHandler>;
  /** Functions the plugin's panels can call. */
  panelMethods?: Record<string, PanelMethodHandler>;
  /** One function per hook named in the manifest. */
  hooks?: { [E in HookEvent]?: HookHandler<E> };
  /** Runs once after the process has started, before any call. */
  onStart?: (context: LifecycleContext) => MaybePromise<void>;
  /** Runs when the Studio stops the plugin politely. Keep it short: the process is ended soon after. */
  onStop?: (context: LifecycleContext) => MaybePromise<void>;
}

/** The streams a runtime talks through. `definePlugin` uses the process's own. */
export interface RuntimeIo {
  /** Bytes from the Studio. */
  readonly input: { on(event: 'data', listener: (chunk: Uint8Array | string) => void): unknown; on(event: 'end', listener: () => void): unknown };
  /** Bytes to the Studio. */
  readonly output: { write(text: string): unknown };
  /** Called when the runtime is done: after `shutdown`, or when the input ends. */
  readonly exit: (code: number) => void;
  /** Where problems with the protocol itself are reported. */
  readonly warn?: (message: string) => void;
  readonly maxMessageBytes?: number;
}

export interface PluginRuntime {
  /** Resolves with the exit code once the runtime has stopped. */
  readonly stopped: Promise<number>;
}

export type FramingProblem = { readonly kind: 'oversized' } | { readonly kind: 'invalid-json' } | { readonly kind: 'not-an-object' };

export interface Decoder {
  push(chunk: Uint8Array | string): void;
}

// ---- panel side -----------------------------------------------------------

export interface PanelContextInfo {
  readonly pluginId: string;
  readonly panelId: string;
  readonly slot: 'home-tile' | 'project-tab' | 'settings-page';
  readonly theme: 'light' | 'dark';
  readonly locale: string;
  readonly project: { readonly id: string; readonly name: string } | null;
  readonly user: { readonly displayName: string };
}

export interface PanelConnection {
  /** The latest context the Studio sent. */
  readonly context: PanelContextInfo;
  /** Calls one of the plugin's panel methods. Rejects with a `PanelError`. */
  request<T = unknown>(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<T>;
  /** Tells the Studio how tall the content is. Returns a function that stops automatic reporting when `height` is omitted. */
  resize(height?: number): () => void;
  /** Runs `listener` whenever theme, language or project change. Returns a function that removes it. */
  onContextChange(listener: (context: PanelContextInfo) => void): () => void;
  /** Stops listening. Pending requests are rejected. */
  close(): void;
}

export interface ConnectPanelOptions {
  /** How long to wait for the Studio to answer the first message. Default 10 s. */
  timeoutMs?: number;
}
