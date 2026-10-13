// @ts-check
import { Buffer } from 'node:buffer';
import { Console } from 'node:console';
import process from 'node:process';
import { DEFAULT_MAX_MESSAGE_BYTES, createDecoder, encodeMessage } from './framing.js';

/**
 * The server-side half of a plugin.
 *
 * A plugin's code runs in its own process. The Studio talks to it over the
 * process's standard input and output: one JSON-RPC 2.0 message per line.
 * `definePlugin` hides all of that — a plugin supplies functions and receives a
 * `host` object with the few things it may ask the Studio to do.
 *
 * @typedef {import('./types.js').PluginDefinition} PluginDefinition
 * @typedef {import('./types.js').PluginHost} PluginHost
 * @typedef {import('./types.js').PluginInfo} PluginInfo
 * @typedef {import('./types.js').PluginUser} PluginUser
 * @typedef {import('./types.js').RuntimeIo} RuntimeIo
 * @typedef {import('./types.js').PluginRuntime} PluginRuntime
 * @typedef {import('./types.js').Json} Json
 */

/** Version of the line protocol between the Studio and a plugin process. */
export const PLUGIN_PROTOCOL_VERSION = 1;

/** Longest error text sent back to the Studio. */
const MAX_ERROR_TEXT = 2000;

/** A refusal or failure reported by the Studio. `code` is stable; `message` is for people. */
export class HostError extends Error {
  /**
   * @param {string} code e.g. `permission_denied`, `no_user`, `read_only_call`, `not_found`, `too_large`
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'HostError';
    /** @type {string} */
    this.code = code;
  }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {PluginUser | null}
 */
function readUser(value) {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.displayName !== 'string') return null;
  return { id: value.id, displayName: value.displayName };
}

/**
 * @param {unknown} table
 * @param {string} what
 * @returns {Record<string, Function>}
 */
function handlerTable(table, what) {
  if (table === undefined) return {};
  if (!isRecord(table)) throw new TypeError(`definePlugin: "${what}" must be an object of functions.`);
  /** @type {Record<string, Function>} */
  const result = Object.create(null);
  for (const [name, handler] of Object.entries(table)) {
    if (typeof handler !== 'function') throw new TypeError(`definePlugin: ${what}.${name} must be a function.`);
    result[name] = handler;
  }
  return result;
}

/**
 * @param {unknown} error
 * @returns {{ code: number, message: string, data: { code: string } }}
 */
function describeFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  const code = isRecord(error) && typeof error.code === 'string' ? error.code : 'handler_failed';
  return { code: -32000, message: message.slice(0, MAX_ERROR_TEXT), data: { code } };
}

/**
 * @param {unknown} value
 * @returns {{ text: string, isError?: true }}
 */
function toToolResult(value) {
  if (typeof value === 'string') return { text: value };
  if (isRecord(value) && typeof value.text === 'string') {
    return value.isError === true ? { text: value.text, isError: true } : { text: value.text };
  }
  return { text: value === undefined ? '' : JSON.stringify(value) };
}

/**
 * Runs a plugin over the given streams. `definePlugin` is this with the
 * process's own standard streams; tests use it with in-memory ones.
 *
 * @param {PluginDefinition} definition
 * @param {RuntimeIo} io
 * @returns {PluginRuntime}
 */
export function createPluginRuntime(definition, io) {
  if (definition === null || typeof definition !== 'object') throw new TypeError('definePlugin needs an object.');
  const tools = handlerTable(definition.tools, 'tools');
  const panelMethods = handlerTable(definition.panelMethods, 'panelMethods');
  const hooks = handlerTable(definition.hooks, 'hooks');
  for (const name of ['onStart', 'onStop']) {
    const hook = /** @type {Record<string, unknown>} */ (definition)[name];
    if (hook !== undefined && typeof hook !== 'function') throw new TypeError(`definePlugin: ${name} must be a function.`);
  }

  const maxBytes = io.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
  const warn = io.warn ?? (() => {});
  /** @type {Map<number, { resolve: (value: unknown) => void, reject: (error: Error) => void }>} */
  const pending = new Map();
  let nextId = 1;
  let stopped = false;
  /** @type {PluginInfo} */
  let info = { id: '', version: '', studioVersion: '', permissions: [] };
  /** @type {(code: number) => void} */
  let resolveStopped = () => {};
  /** @type {Promise<number>} */
  const stoppedPromise = new Promise((resolve) => {
    resolveStopped = resolve;
  });

  /** @param {number} code */
  const finish = (code) => {
    if (stopped) return;
    stopped = true;
    for (const entry of pending.values()) entry.reject(new HostError('closed', 'The plugin is shutting down.'));
    pending.clear();
    resolveStopped(code);
    io.exit(code);
  };

  /** @param {unknown} message */
  const send = (message) => {
    const text = encodeMessage(message);
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new HostError('too_large', 'That is larger than one message to the Studio may be.');
    }
    io.output.write(text);
  };

  /**
   * @param {string} method
   * @param {Record<string, unknown>} params
   * @returns {Promise<any>}
   */
  const callHost = (method, params) =>
    new Promise((resolve, reject) => {
      if (stopped) {
        reject(new HostError('closed', 'The plugin is shutting down.'));
        return;
      }
      const id = nextId;
      nextId += 1;
      pending.set(id, { resolve, reject });
      try {
        send({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });

  /**
   * The capability client for one call. `scope` names that call to the Studio,
   * which is how it knows whom the plugin is acting for; it stops being
   * accepted as soon as the call has been answered.
   *
   * @param {string} scope
   * @returns {PluginHost}
   */
  const hostFor = (scope) => ({
    log(message, level = 'info') {
      try {
        send({ jsonrpc: '2.0', method: 'host.log', params: { level, message: String(message).slice(0, 4000) } });
      } catch {
        /* a log line is never worth failing for */
      }
    },
    storage: {
      async get(key) {
        const answer = await callHost('host.storage.get', { scope, key });
        return answer.found ? answer.value : undefined;
      },
      async set(key, value) {
        await callHost('host.storage.set', { scope, key, value });
      },
      async delete(key) {
        return (await callHost('host.storage.delete', { scope, key })).deleted === true;
      },
      async list(options = {}) {
        return (await callHost('host.storage.list', { scope, ...options })).keys;
      },
    },
    async notify(notification) {
      await callHost('host.notify', { scope, title: notification.title, body: notification.body ?? '' });
    },
    http: {
      fetch: (url, init = {}) => callHost('host.http.fetch', { scope, url, ...init }),
    },
    projects: {
      list: async () => (await callHost('host.projects.list', { scope })).projects,
    },
    files: {
      read: (projectId, path, options = {}) => callHost('host.files.read', { scope, projectId, path, ...options }),
    },
  });

  /**
   * @param {unknown} params
   * @returns {{ scope: string, context: Record<string, unknown>, params: Record<string, unknown> }}
   */
  const open = (params) => {
    const record = isRecord(params) ? params : {};
    return {
      scope: typeof record.scope === 'string' ? record.scope : '',
      context: isRecord(record.context) ? record.context : {},
      params: record,
    };
  };

  /**
   * @param {string} method
   * @param {unknown} rawParams
   * @returns {Promise<unknown>}
   */
  const dispatch = async (method, rawParams) => {
    const { scope, context, params } = open(rawParams);
    const host = hostFor(scope);
    const projectId = typeof context.projectId === 'string' ? context.projectId : null;

    if (method === 'initialize') {
      if (params.protocol !== PLUGIN_PROTOCOL_VERSION) {
        throw new HostError('unsupported_protocol', `This SDK speaks protocol ${PLUGIN_PROTOCOL_VERSION}.`);
      }
      const plugin = isRecord(params.plugin) ? params.plugin : {};
      const studio = isRecord(params.studio) ? params.studio : {};
      info = Object.freeze({
        id: typeof plugin.id === 'string' ? plugin.id : '',
        version: typeof plugin.version === 'string' ? plugin.version : '',
        studioVersion: typeof studio.version === 'string' ? studio.version : '',
        permissions: Object.freeze(Array.isArray(params.permissions) ? params.permissions.filter((item) => typeof item === 'string') : []),
      });
      if (definition.onStart) await definition.onStart({ host, plugin: info, user: null, projectId: null });
      return {
        protocol: PLUGIN_PROTOCOL_VERSION,
        tools: Object.keys(tools),
        panelMethods: Object.keys(panelMethods),
        hooks: Object.keys(hooks),
      };
    }

    if (method === 'tool.call') {
      const name = typeof params.tool === 'string' ? params.tool : '';
      const handler = tools[name];
      const user = readUser(context.user);
      if (!handler) throw new HostError('unknown_tool', `This plugin has no tool named "${name}".`);
      if (!user) throw new HostError('invalid_request', 'A tool call needs a user.');
      const result = await handler(isRecord(params.input) ? params.input : {}, {
        host,
        plugin: info,
        user,
        projectId,
        tool: name,
        run: {
          runId: String(context.runId ?? ''),
          sessionId: String(context.sessionId ?? ''),
          agentId: String(context.agentId ?? ''),
        },
      });
      return toToolResult(result);
    }

    if (method === 'panel.request') {
      const name = typeof params.method === 'string' ? params.method : '';
      const handler = panelMethods[name];
      const user = readUser(context.user);
      if (!handler) throw new HostError('unknown_method', `This plugin has no panel method named "${name}".`);
      if (!user) throw new HostError('invalid_request', 'A panel request needs a user.');
      const result = await handler(params.params, {
        host,
        plugin: info,
        user,
        projectId,
        method: name,
        panel: { panelId: String(params.panelId ?? ''), slot: String(context.slot ?? '') },
      });
      return result === undefined ? null : result;
    }

    if (method === 'hook.event') {
      const name = typeof params.event === 'string' ? params.event : '';
      const handler = hooks[name];
      if (handler) await handler(params.payload, { host, plugin: info, user: null, projectId: null, event: name });
      return null;
    }

    if (method === 'shutdown') {
      if (definition.onStop) await definition.onStop({ host, plugin: info, user: null, projectId: null });
      return null;
    }

    throw new HostError('unknown_method', `Unknown method "${method}".`);
  };

  /**
   * @param {string | number} id
   * @param {string} method
   * @param {unknown} params
   */
  const serve = async (id, method, params) => {
    /** @type {Record<string, unknown>} */
    let reply;
    try {
      reply = { jsonrpc: '2.0', id, result: await dispatch(method, params) };
    } catch (error) {
      reply = { jsonrpc: '2.0', id, error: describeFailure(error) };
    }
    if (stopped) return;
    try {
      send(reply);
    } catch (error) {
      // The result did not fit in one message: say so instead of saying nothing.
      send({ jsonrpc: '2.0', id, error: describeFailure(error) });
    }
    if (method === 'shutdown') finish(0);
  };

  const decoder = createDecoder({
    maxBytes,
    onProblem: (problem) => warn(`ignored a message from the Studio (${problem.kind})`),
    onMessage: (message) => {
      if (stopped) return;
      if (typeof message.method === 'string') {
        const id = message.id;
        if (typeof id !== 'string' && typeof id !== 'number') return; // a notification: none are defined
        void serve(id, message.method, message.params);
        return;
      }
      if (typeof message.id !== 'number') return;
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (isRecord(message.error)) {
        const data = isRecord(message.error.data) ? message.error.data : {};
        entry.reject(
          new HostError(
            typeof data.code === 'string' ? data.code : 'host_error',
            typeof message.error.message === 'string' ? message.error.message : 'The Studio refused the request.',
          ),
        );
      } else {
        entry.resolve(message.result);
      }
    },
  });

  io.input.on('data', (chunk) => decoder.push(chunk));
  // The Studio closing its end means it is gone or wants this process gone.
  io.input.on('end', () => finish(0));

  return { stopped: stoppedPromise };
}

let defined = false;

/**
 * Declares the plugin and starts serving the Studio. Call it once, at the top
 * level of the server entry file named in `plugin.json`.
 *
 * @param {PluginDefinition} definition
 * @returns {PluginRuntime}
 */
export function definePlugin(definition) {
  if (defined) throw new Error('definePlugin may be called only once per process.');
  defined = true;

  // Standard output belongs to the protocol. Whatever a plugin prints with
  // console.* goes to standard error, which the Studio keeps as the plugin's log.
  globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });
  process.stdout.on('error', () => process.exit(0));

  return createPluginRuntime(definition, {
    input: process.stdin,
    output: process.stdout,
    warn: (message) => process.stderr.write(`[plugin-sdk] ${message}\n`),
    exit: (code) => {
      process.exitCode = code;
      // Leave once what was written has left the process.
      process.stdout.write('', () => process.exit(code));
    },
  });
}
