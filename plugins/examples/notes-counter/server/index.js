// The server side of the example plugin.
//
// This file runs in its own process, isolated from the Studio. It cannot open
// files or sockets; everything it does beyond computing goes through `host`,
// which every handler receives in its second argument and which works only
// while that handler is running.
//
// No build step and no node_modules: the Studio provides the SDK.
import { definePlugin } from '@agent-studio/plugin-sdk';

/** Notes are kept newest-first under one key; older ones fall off the end. */
const KEPT_NOTES = 50;

/** @param {import('@agent-studio/plugin-sdk').PluginHost} host */
async function load(host) {
  return {
    total: (await host.storage.get('total')) ?? 0,
    notes: (await host.storage.get('notes')) ?? [],
  };
}

/**
 * @param {import('@agent-studio/plugin-sdk').PluginHost} host
 * @param {string} text
 * @param {string} author
 */
async function save(host, text, author) {
  const clean = text.trim().slice(0, 500);
  if (clean === '') throw Object.assign(new Error('A note needs some text.'), { code: 'empty_note' });
  const { total, notes } = await load(host);
  const note = { number: total + 1, text: clean, author, at: Date.now() };
  await host.storage.set('notes', [note, ...notes].slice(0, KEPT_NOTES));
  await host.storage.set('total', total + 1);
  return note;
}

definePlugin({
  tools: {
    // Declared "read" in plugin.json: it may look at storage but not change it.
    // (The Studio enforces that — a storage.set in here would be refused.)
    async count_notes(input, { host }) {
      const { total, notes } = await load(host);
      const latest = notes.slice(0, typeof input.latest === 'number' ? input.latest : 3);
      const lines = latest.map((note) => `#${note.number} (${note.author}): ${note.text}`);
      return [`${total} note${total === 1 ? '' : 's'} saved.`, ...lines].join('\n');
    },

    // Declared "write": each call goes through the run's permission mode first.
    async add_note(input, { host, user }) {
      const note = await save(host, String(input.text ?? ''), user.displayName);
      return `Saved note #${note.number}.`;
    },
  },

  // What the panel can call. `user` is whoever is looking at the panel.
  panelMethods: {
    async summary(_params, { host, user, projectId }) {
      const { total, notes } = await load(host);
      return {
        greeting: `Hello, ${user.displayName}`,
        total,
        latest: notes.slice(0, 5),
        runsFinished: (await host.storage.get('runs-finished')) ?? 0,
        projectId,
      };
    },

    async add(params, { host, user }) {
      const text = params && typeof params === 'object' && !Array.isArray(params) ? params.text : undefined;
      return save(host, typeof text === 'string' ? text : '', user.displayName);
    },
  },

  hooks: {
    // Hooks run for nobody in particular: there is no user here, and the
    // payload holds identifiers only.
    async 'run.finished'(_payload, { host }) {
      const seen = (await host.storage.get('runs-finished')) ?? 0;
      await host.storage.set('runs-finished', seen + 1);
    },
  },

  onStart({ host, plugin }) {
    host.log(`notes-counter ${plugin.version} is ready`);
  },
});
