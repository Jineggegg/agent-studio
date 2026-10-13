import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  PluginIsolation,
  PluginList,
  PluginPanelGrant,
  PluginPanelRpcResponse,
  PluginPanelSlot,
  PluginSummary,
} from '@agent-studio/protocol';
import type { ConfigOverrides } from '../../../src/kernel/config.js';
import { newId } from '../../../src/kernel/crypto.js';
import { Sandbox } from '../../../src/kernel/process.js';
import { modules as allModules } from '../../../src/modules/index.js';
import { createPluginsModule } from '../../../src/modules/plugins/plugins.module.js';
import type { PluginsOptions } from '../../../src/modules/plugins/service.js';
import { createTestStudio, type TestClient, type TestResponse, type TestStudio } from '../../../src/testing/harness.js';

/** The example plugin that ships with the repository. */
export const EXAMPLE_PLUGIN = fileURLToPath(new URL('../../../../../plugins/examples/notes-counter', import.meta.url));
/** A plugin that tries everything it should not be able to do. */
export const HOSTILE_PLUGIN = fileURLToPath(new URL('./hostile', import.meta.url));

let bubblewrap: Promise<boolean> | null = null;
/** Whether bubblewrap works on this machine; sandbox tests are skipped, loudly, when it does not. */
export function bubblewrapWorks(): Promise<boolean> {
  bubblewrap ??= Sandbox.detect('auto', []).then((sandbox) => sandbox.status.mode === 'bwrap');
  return bubblewrap;
}

export const SKIP_NO_BWRAP = 'SKIPPED: bubblewrap is not usable on this machine, so the sandbox itself could not be tested here.';

export interface PluginFiles {
  readonly manifest: Record<string, unknown>;
  readonly files?: Readonly<Record<string, string>>;
}

export interface PluginTestStudio extends TestStudio {
  /** The folder plugins are installed from by name. */
  readonly sourceDir: string;
  readonly pluginsDir: string;
  readonly pluginDataDir: string;
  /** Copies a ready-made plugin folder into the source folder under `name`. */
  addSource(name: string, from: string): Promise<string>;
  /** Writes a plugin into the source folder, replacing what was there. */
  writeSource(name: string, plugin: PluginFiles): Promise<string>;
  install(owner: TestClient, name: string): Promise<PluginSummary>;
  /** Approves a plugin as shown by the server, granting `permissions` (default: everything it asks for). */
  enable(owner: TestClient, id: string, permissions?: string[]): Promise<PluginSummary>;
  installAndEnable(owner: TestClient, name: string, permissions?: string[]): Promise<PluginSummary>;
  summary(owner: TestClient, id: string): Promise<PluginSummary>;
  isolation(owner: TestClient): Promise<PluginIsolation>;
  openPanel(client: TestClient, id: string, panelId: string, slot?: PluginPanelSlot, projectId?: string): Promise<PluginPanelGrant>;
  rpc<T = unknown>(client: TestClient, grant: PluginPanelGrant, method: string, params?: unknown): Promise<T>;
  rpcRaw(client: TestClient, grant: PluginPanelGrant, method: string, params?: unknown): Promise<TestResponse<PluginPanelRpcResponse>>;
  /** Calls a plugin's tool the way an agent run would. */
  callTool(userId: string, name: string, input: unknown, projectId?: string | null): Promise<{ text: string; isError?: boolean }>;
}

export async function pluginStudio(
  options: { config?: ConfigOverrides; plugins?: PluginsOptions; sources?: Record<string, string> } = {},
): Promise<PluginTestStudio> {
  const sourceDir = await mkdtemp(path.join(os.tmpdir(), 'agent-studio-plugin-src-'));
  const modules = allModules.map((module) => (module.name === 'plugins' ? createPluginsModule(options.plugins ?? {}) : module));
  // 'auto': the strongest isolation this machine offers, which is what a real installation would use.
  const t = await createTestStudio({ modules, config: { pluginSourceDir: sourceDir, sandbox: 'auto', ...options.config } });

  const expectOk = <T>(response: TestResponse<T>, what: string, status = 200): T => {
    if (response.status !== status) throw new Error(`${what} answered ${response.status}: ${JSON.stringify(response.body)}`);
    return response.body;
  };

  const kit: PluginTestStudio = {
    ...t,
    sourceDir,
    pluginsDir: path.join(t.dataDir, 'plugins'),
    pluginDataDir: path.join(t.dataDir, 'plugin-data'),
    async addSource(name, from) {
      const target = path.join(sourceDir, name);
      await rm(target, { recursive: true, force: true });
      await cp(from, target, { recursive: true });
      return target;
    },
    async writeSource(name, plugin) {
      const target = path.join(sourceDir, name);
      await rm(target, { recursive: true, force: true });
      await mkdir(target, { recursive: true });
      await writeFile(path.join(target, 'plugin.json'), JSON.stringify(plugin.manifest, null, 2));
      for (const [file, content] of Object.entries(plugin.files ?? {})) {
        await mkdir(path.dirname(path.join(target, file)), { recursive: true });
        await writeFile(path.join(target, file), content);
      }
      return target;
    },
    async install(owner, name) {
      return expectOk(await owner.post<PluginSummary>('/api/plugins/install', { source: { kind: 'directory', name } }), `install ${name}`, 201);
    },
    async enable(owner, id, permissions) {
      const list = expectOk(await owner.get<PluginList>('/api/plugins'), 'list');
      const plugin = list.plugins.find((entry) => entry.id === id);
      if (!plugin) throw new Error(`${id} is not installed`);
      return expectOk(
        await owner.post<PluginSummary>(`/api/plugins/${id}/enable`, {
          permissions: permissions ?? plugin.permissions.requested,
          contentHash: plugin.contentHash,
          isolation: list.isolation.level,
        }),
        `enable ${id}`,
      );
    },
    async installAndEnable(owner, name, permissions) {
      const installed = await kit.install(owner, name);
      return kit.enable(owner, installed.id, permissions);
    },
    async summary(owner, id) {
      return expectOk(await owner.get<PluginSummary>(`/api/plugins/${id}`), `get ${id}`);
    },
    async isolation(owner) {
      return expectOk(await owner.get<PluginList>('/api/plugins'), 'list').isolation;
    },
    async openPanel(client, id, panelId, slot = 'home-tile', projectId) {
      return expectOk(
        await client.post<PluginPanelGrant>(`/api/plugins/${id}/panels/${panelId}/open`, { slot, ...(projectId ? { projectId } : {}) }),
        `open ${id}/${panelId}`,
      );
    },
    rpcRaw(client, grant, method, params) {
      return client.post<PluginPanelRpcResponse>(`/api/plugins/${grant.pluginId}/rpc`, {
        panel: grant.panel,
        method,
        ...(params === undefined ? {} : { params }),
      });
    },
    async rpc<T>(client: TestClient, grant: PluginPanelGrant, method: string, params?: unknown) {
      const body = expectOk(await kit.rpcRaw(client, grant, method, params), `rpc ${method}`);
      if (!body.ok) throw new Error(`rpc ${method} failed: ${body.error.code}: ${body.error.message}`);
      return body.result as T;
    },
    callTool(userId, name, input, projectId = null) {
      return Promise.resolve(
        t.studio.context.agentTools.call(name, { runId: newId(), sessionId: newId(), projectId, userId, agentId: 'test-agent' }, input),
      );
    },
    async close() {
      await t.close();
      await rm(sourceDir, { recursive: true, force: true });
    },
  };
  for (const [name, from] of Object.entries(options.sources ?? {})) await kit.addSource(name, from);
  return kit;
}

/**
 * Sandbox launchers, Node processes and Git commands on this machine whose
 * command line mentions `needle` (a path unique to one test studio). Whatever
 * a plugin or an install started and left behind shows up here.
 */
export async function processesMentioning(needle: string): Promise<{ pid: number; command: string }[]> {
  const found: { pid: number; command: string }[] = [];
  for (const name of await readdir('/proc')) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    const parts = await readFile(`/proc/${name}/cmdline`, 'utf8').then(
      (text) => text.split('\0'),
      () => [] as string[],
    );
    if (!['bwrap', 'node', 'git'].includes(path.basename(parts[0] ?? ''))) continue;
    const command = parts.join(' ');
    if (command.includes(needle)) found.push({ pid: Number(name), command: command.slice(0, 200) });
  }
  return found;
}

/** Polls until `check` holds or the time is up. */
export async function eventually(check: () => boolean | Promise<boolean>, timeoutMs = 5000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** A minimal manifest to build test plugins from. */
export function manifest(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { manifestVersion: 1, id, name: `Test ${id}`, version: '1.0.0', ...extra };
}

/** Server code for test plugins that need no more than a few panel methods. */
export function serverCode(body: string): string {
  return `import { definePlugin } from '@agent-studio/plugin-sdk';\n${body}\n`;
}

/**
 * A plugin that does whatever a test asks of the capability API and reports
 * what happened. `call` (panel) and `probe` / `probe_read` (tools) take
 * `{ fn: 'storage.set', args: [...] }`.
 */
export function toolbox(id: string, permissions: string[] = [], extra: { version?: string; hooks?: string[]; body?: string } = {}): PluginFiles {
  const input = { type: 'object', properties: { fn: { type: 'string' } }, required: ['fn'], additionalProperties: true };
  return {
    manifest: manifest(id, {
      version: extra.version ?? '1.0.0',
      server: { entry: 'server.js' },
      permissions,
      contributes: {
        tools: [
          { name: 'probe', description: 'Runs one capability call.', effect: 'write', inputSchema: input },
          { name: 'probe_read', description: 'Runs one capability call, read-only.', effect: 'read', inputSchema: input },
        ],
        panels: [{ id: 'main', title: 'Toolbox', entry: 'panel/index.html', slots: ['home-tile', 'project-tab', 'settings-page'] }],
        hooks: extra.hooks ?? ['project.created', 'project.deleted', 'run.started', 'run.finished'],
      },
    }),
    files: {
      'server.js': serverCode(`
const run = async (host, fn, args = []) => {
  const [group, name] = fn.split('.');
  try {
    const value = name ? await host[group][name](...args) : await host[group](...args);
    return { ok: true, value: value === undefined ? null : value };
  } catch (error) {
    return { ok: false, code: error.code ?? null, message: error.message };
  }
};
const remember = (event) => async (payload, context) => {
  const seen = (await context.host.storage.get('hooks')) ?? [];
  await context.host.storage.set('hooks', [...seen, { event, payload, user: context.user, keys: Object.keys(context).sort() }]);
};
definePlugin({
  tools: {
    probe: async (input, context) => JSON.stringify({ result: await run(context.host, input.fn, input.args), user: context.user, projectId: context.projectId, run: context.run }),
    probe_read: async (input, context) => JSON.stringify({ result: await run(context.host, input.fn, input.args), user: context.user, projectId: context.projectId }),
  },
  panelMethods: {
    call: async (params, context) => ({ result: await run(context.host, params.fn, params.args), user: context.user, projectId: context.projectId, panel: context.panel }),
    whoami: (params, context) => ({ user: context.user, projectId: context.projectId, panel: context.panel, method: context.method, keys: Object.keys(context).sort(), params: params ?? null }),
    fail: () => { throw Object.assign(new Error('this did not work, token sk-abcdefghijklmnopqrstuvwx'), { code: 'custom_failure' }); },
    big: (params) => 'x'.repeat(params.bytes),
    hooks: async (_params, { host }) => (await host.storage.get('hooks')) ?? [],
    ${extra.body ?? ''}
  },
  hooks: {
    'project.created': remember('project.created'),
    'project.deleted': remember('project.deleted'),
    'run.started': remember('run.started'),
    'run.finished': remember('run.finished'),
  },
  onStart: ({ host, plugin }) => host.log('toolbox ' + plugin.id + ' ' + plugin.version + ' started with ' + JSON.stringify(plugin.permissions)),
});
`),
      'panel/index.html': '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="./style.css"></head><body><script type="module" src="./app.js"></script></body></html>',
      'panel/app.js': 'export const loaded = true;\n',
      'panel/style.css': 'body { margin: 0; }\n',
      'panel/img/dot.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
      'panel/notes.md': '# not served',
      'panel/.hidden.js': 'export {};',
    },
  };
}

export interface CapabilityAnswer<T = unknown> {
  readonly result: { ok: true; value: T } | { ok: false; code: string | null; message: string };
  readonly user: { id: string; displayName: string } | null;
  readonly projectId: string | null;
}
