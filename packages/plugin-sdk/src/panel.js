// @ts-check
/* global window, document, ResizeObserver, TextEncoder */

/**
 * The panel side of a plugin: one dependency-free ES module for the browser.
 *
 * A panel is shown by the Studio in a sandboxed frame. It has no cookies, no
 * storage and no network; the only thing it can do beyond drawing itself is
 * exchange messages with the page that embeds it, and through that page call
 * the panel methods of its own plugin. This module is that exchange.
 *
 *     import { connectPanel } from './@studio/panel.js';
 *
 *     const studio = await connectPanel();
 *     const summary = await studio.request('summary');
 *
 * `./@studio/panel.js` is served by the Studio next to every panel's entry
 * page. A plugin may also ship its own copy of this file.
 */

export const PANEL_CHANNEL = 'agent-studio-panel';
export const PANEL_PROTOCOL_VERSION = 1;

const MAX_MESSAGE_BYTES = 256 * 1024;
const MAX_PENDING = 32;
const MAX_HEIGHT = 20000;

/** A refusal or failure of a panel request. `code` is stable; `message` is for people. */
export class PanelError extends Error {
  /**
   * @param {string} code e.g. `timeout`, `too_large`, `too_many_requests`, `panel_expired`, or a code from the plugin
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'PanelError';
    /** @type {string} */
    this.code = code;
  }
}

/**
 * Connects to the Studio page that embeds this panel and resolves once the
 * Studio has sent the panel its context.
 *
 * @param {import('./types.js').ConnectPanelOptions} [options]
 * @returns {Promise<import('./types.js').PanelConnection>}
 */
export function connectPanel(options = {}) {
  const host = window.parent;
  if (!host || host === window) {
    return Promise.reject(new PanelError('not_embedded', 'This page is not shown inside the Studio.'));
  }
  // The panel is served by the Studio itself and may only be framed by it, so
  // the address this page was loaded from names the one origin to talk to.
  const origin = window.location.origin;
  const timeoutMs = options.timeoutMs ?? 10_000;

  return new Promise((resolve, reject) => {
    /** @type {import('./types.js').PanelContextInfo | null} */
    let context = null;
    let closed = false;
    let counter = 0;
    /** @type {Map<string, { resolve: (value: any) => void, reject: (error: Error) => void, timer: number }>} */
    const pending = new Map();
    /** @type {Set<(context: import('./types.js').PanelContextInfo) => void>} */
    const listeners = new Set();

    /** @param {Record<string, unknown>} message */
    const post = (message) => {
      host.postMessage({ channel: PANEL_CHANNEL, v: PANEL_PROTOCOL_VERSION, ...message }, origin);
    };

    const close = () => {
      if (closed) return;
      closed = true;
      window.clearInterval(hello);
      window.clearTimeout(deadline);
      window.removeEventListener('message', onMessage);
      for (const entry of pending.values()) {
        window.clearTimeout(entry.timer);
        entry.reject(new PanelError('closed', 'The panel connection was closed.'));
      }
      pending.clear();
      listeners.clear();
    };

    /** @type {import('./types.js').PanelConnection} */
    const connection = {
      get context() {
        return /** @type {import('./types.js').PanelContextInfo} */ (context);
      },
      request(method, params, requestOptions = {}) {
        return new Promise((resolveRequest, rejectRequest) => {
          if (closed) return rejectRequest(new PanelError('closed', 'The panel connection was closed.'));
          if (pending.size >= MAX_PENDING) {
            return rejectRequest(new PanelError('too_many_requests', 'Too many requests are still waiting for an answer.'));
          }
          counter += 1;
          const id = `r${counter}-${Math.random().toString(36).slice(2, 10)}`;
          const message = { type: 'request', id, method, ...(params === undefined ? {} : { params }) };
          /** @type {string | undefined} */
          let text;
          try {
            text = JSON.stringify(message);
          } catch {
            text = undefined;
          }
          if (text === undefined) return rejectRequest(new PanelError('invalid_params', 'The parameters cannot be sent as JSON.'));
          if (new TextEncoder().encode(text).length > MAX_MESSAGE_BYTES) {
            return rejectRequest(new PanelError('too_large', 'That request is too large.'));
          }
          const timer = window.setTimeout(() => {
            pending.delete(id);
            rejectRequest(new PanelError('timeout', 'The Studio did not answer in time.'));
          }, requestOptions.timeoutMs ?? 30_000);
          pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
          post(message);
        });
      },
      resize(height) {
        /** @param {number} value */
        const report = (value) => post({ type: 'resize', height: Math.max(0, Math.min(MAX_HEIGHT, Math.ceil(value))) });
        if (height !== undefined) {
          report(height);
          return () => {};
        }
        const measure = () => report(document.documentElement.scrollHeight);
        measure();
        if (typeof ResizeObserver === 'undefined') return () => {};
        const observer = new ResizeObserver(measure);
        observer.observe(document.documentElement);
        return () => observer.disconnect();
      },
      onContextChange(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      close,
    };

    /** @param {MessageEvent} event */
    const onMessage = (event) => {
      // Only the embedding Studio page may speak here; anything else is ignored.
      if (event.source !== host || event.origin !== origin) return;
      const data = event.data;
      if (!data || typeof data !== 'object' || data.channel !== PANEL_CHANNEL || data.v !== PANEL_PROTOCOL_VERSION) return;

      if (data.type === 'init' || data.type === 'context') {
        if (!data.context || typeof data.context !== 'object') return;
        const first = context === null;
        /** @type {import('./types.js').PanelContextInfo} */
        const next = Object.freeze({ ...data.context });
        context = next;
        if (first) {
          window.clearInterval(hello);
          window.clearTimeout(deadline);
          resolve(connection);
          return;
        }
        for (const listener of [...listeners]) listener(next);
        return;
      }

      if (data.type === 'response' && typeof data.id === 'string') {
        const entry = pending.get(data.id);
        if (!entry) return;
        pending.delete(data.id);
        window.clearTimeout(entry.timer);
        if (data.ok === true) {
          entry.resolve(data.result);
        } else {
          const error = data.error && typeof data.error === 'object' ? data.error : {};
          entry.reject(new PanelError(String(error.code ?? 'failed'), String(error.message ?? 'The request failed.')));
        }
      }
    };

    window.addEventListener('message', onMessage);
    // The embedding page may attach its listener a moment after this script
    // runs, so the greeting is repeated until it is answered.
    const hello = window.setInterval(() => post({ type: 'ready' }), 250);
    const deadline = window.setTimeout(() => {
      close();
      reject(new PanelError('timeout', 'The Studio did not answer. Is this page shown as a panel?'));
    }, timeoutMs);
    post({ type: 'ready' });
  });
}
