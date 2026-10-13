import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import {
  PLUGINS_CHANGED_EVENT,
  PLUGINS_INTERNAL_TOPIC,
  PLUGINS_TOPIC,
  PLUGIN_BUS_EVENT,
  PLUGIN_LIMITS,
  PLUGIN_PANEL_SANDBOX,
  idSchema,
  pluginToolPrefix,
  registeredPluginToolName,
  type EnablePluginRequest,
  type InstallPluginRequest,
  type OpenPluginPanelRequest,
  type PluginApprovalReason,
  type PluginContributions,
  type PluginHookEvent,
  type PluginIsolation,
  type PluginList,
  type PluginNotificationEvent,
  type PluginPanelContribution,
  type PluginPanelGrant,
  type PluginPanelRpcRequest,
  type PluginPanelRpcResponse,
  type PluginSourceList,
  type PluginStatus,
  type PluginSummary,
} from '@agent-studio/protocol';
import { z } from 'zod';
import type { AgentToolContext, AgentToolResult } from '../../kernel/agent-tools.js';
import { newId } from '../../kernel/crypto.js';
import { StudioError, badRequest, conflict, forbidden, notFound, payloadTooLarge, unavailable, unprocessable } from '../../kernel/errors.js';
import type { ModuleContext } from '../../kernel/module.js';
import { guardedRequest, readBody } from '../../kernel/net.js';
import { confine, toRelative } from '../../kernel/paths.js';
import type { Principal } from '../../kernel/principal.js';
import { redactSecrets } from '../../kernel/redact.js';
import { VERSION } from '../../kernel/version.js';
import { PANEL_SDK_PATH, panelHeaders, readPanelAsset } from './assets.js';
import { PanelGrantStore } from './grants.js';
import { PluginInstaller, type StagedPlugin } from './installer.js';
import { ISOLATION_RANK, Isolation } from './isolation.js';
import { compareVersions, readManifest, surfaceChanges, surfaceOf, toolInputToZod } from './manifest.js';
import {
  HostRefusal,
  authorize,
  checkFetchTarget,
  chosenGrant,
  effectiveToolEffect,
  isHostMethod,
  isSensitiveProjectPath,
  projectInScope,
  type ActingUser,
  type CallScope,
} from './permissions.js';
import { LogTail, PluginCallError, PluginProcess, type ExitInfo, type ProcessLimits } from './runtime.js';
import { installSdk, type SdkLocation } from './sdk-install.js';
import { PluginStorage, PluginStore, StorageError, type PluginRecord } from './store.js';
import { directorySize, hashTree } from './tree.js';
import { groupUsage } from './usage.js';

export interface PluginLimits extends ProcessLimits {
  readonly toolCallTimeoutMs: number;
  readonly panelCallTimeoutMs: number;
  readonly hookTimeoutMs: number;
  /** Calls into one plugin that may be in progress at once. */
  readonly maxConcurrentCalls: number;
  /** A process nobody has called for this long is stopped; it starts again when needed. */
  readonly idleStopMs: number;
  /** Failures within `crashWindowMs` after which the plugin is disabled. */
  readonly maxCrashes: number;
  readonly crashWindowMs: number;
  /** Wait before a failed plugin may start again; doubles with each failure up to `backoffMaxMs`. */
  readonly backoffBaseMs: number;
  readonly backoffMaxMs: number;
  readonly maxToolResultBytes: number;
  readonly fetchTimeoutMs: number;
  readonly maxFetchRequestBytes: number;
  readonly maxFetchResponseBytes: number;
  readonly maxFetchesPerMinute: number;
  readonly maxConcurrentFetches: number;
  readonly maxNotificationsPerMinute: number;
  readonly maxFileReadBytes: number;
  /** Hook events that may wait for one plugin; further ones are dropped. */
  readonly maxPendingHooks: number;
  readonly gitTimeoutMs: number;
  /** How often running processes are measured. */
  readonly watchdogIntervalMs: number;
  /** Resident memory of a plugin's whole process group. */
  readonly maxRssBytes: number;
  /** Share of one CPU a plugin may use while nobody is calling it, measured over two watchdog intervals. */
  readonly maxIdleCpuShare: number;
  /** Size of a plugin's data folder. */
  readonly maxDataBytes: number;
}

export const DEFAULT_PLUGIN_LIMITS: PluginLimits = {
  handshakeTimeoutMs: 10_000,
  maxMessageBytes: 1024 * 1024,
  maxQueuedBytes: 4 * 1024 * 1024,
  maxInvalidMessages: 20,
  maxMessagesPerSecond: 500,
  maxConcurrentHostCalls: 16,
  logTailBytes: 16 * 1024,
  stopGraceMs: 2000,
  memoryMb: 128,
  toolCallTimeoutMs: 30_000,
  panelCallTimeoutMs: 15_000,
  hookTimeoutMs: 10_000,
  maxConcurrentCalls: 16,
  idleStopMs: 10 * 60_000,
  maxCrashes: 5,
  crashWindowMs: 10 * 60_000,
  backoffBaseMs: 1000,
  backoffMaxMs: 60_000,
  maxToolResultBytes: 256 * 1024,
  fetchTimeoutMs: 10_000,
  maxFetchRequestBytes: 256 * 1024,
  maxFetchResponseBytes: 512 * 1024,
  maxFetchesPerMinute: 120,
  maxConcurrentFetches: 4,
  maxNotificationsPerMinute: 10,
  maxFileReadBytes: 512 * 1024,
  maxPendingHooks: 100,
  gitTimeoutMs: 60_000,
  watchdogIntervalMs: 5000,
  maxRssBytes: 512 * 1024 * 1024,
  maxIdleCpuShare: 0.5,
  maxDataBytes: 256 * 1024 * 1024,
};

export interface PluginsOptions {
  readonly limits?: Partial<PluginLimits>;
  /** Test seam: leave out Node's permission flags, to prove what bubblewrap does alone. */
  readonly nodePermissions?: boolean;
  /** Test seam: accept `file://` repositories, so the real `git clone` path can be exercised offline. */
  readonly allowLocalGit?: boolean;
  /** Test seam: what carries `http.fetch` once the address has been allowed. Production uses `guardedRequest`. */
  readonly fetchTransport?: typeof guardedRequest;
}

/** Everything the server remembers about a plugin only while it runs. */
interface Runtime {
  process: PluginProcess | null;
  starting: Promise<PluginProcess> | null;
  /** Calls in progress; a request from the plugin must name one of them. */
  readonly scopes: Map<string, CallScope>;
  granted: ReadonlySet<string>;
  readonly log: LogTail;
  failures: number[];
  lastFailure: { at: number; message: string } | null;
  backoffUntil: number;
  inFlight: number;
  idleTimer: NodeJS.Timeout | null;
  hookQueue: Promise<void>;
  pendingHooks: number;
  fetchStamps: number[];
  fetchesInFlight: number;
  notificationStamps: number[];
  registeredTools: string[];
  /** CPU seconds at the last measurement, and how many measurements in a row were busy while idle. */
  cpuSeconds: number | null;
  busyIdleTicks: number;
  idleSinceTick: boolean;
}

const FETCH_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
/** Request headers a plugin may set. Everything that steers the connection itself is the Studio's to set. */
const FETCH_REQUEST_HEADERS = new Set([
  'accept',
  'accept-language',
  'authorization',
  'content-type',
  'if-match',
  'if-none-match',
  'if-modified-since',
  'x-api-key',
  'x-request-id',
]);
/** Response headers passed back. Cookies in particular are not. */
const FETCH_RESPONSE_HEADERS = new Set([
  'content-type',
  'content-length',
  'content-language',
  'etag',
  'last-modified',
  'location',
  'retry-after',
  'cache-control',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
]);

const paramsSchema = {
  key: z.object({ key: z.string() }),
  set: z.object({ key: z.string(), value: z.unknown() }),
  list: z.object({ prefix: z.string().max(128).optional(), limit: z.number().int().min(1).max(2000).optional() }),
  notify: z.object({ title: z.string().min(1).max(120), body: z.string().max(1000).default('') }),
  fetch: z.object({
    url: z.string().min(1).max(2000),
    method: z.enum(FETCH_METHODS).default('GET'),
    headers: z.record(z.string().max(64), z.string().max(4096)).default({}),
    body: z.string().optional(),
    responseType: z.enum(['text', 'base64']).default('text'),
  }),
  read: z.object({ projectId: idSchema, path: z.string().min(1).max(1000), maxBytes: z.number().int().min(1).optional() }),
};

const toolResultSchema = z.object({ text: z.string(), isError: z.boolean().optional() });

const describe = (error: unknown): string => (error instanceof Error ? error.message : 'unknown error');

/**
 * The plugin system: what is installed, what the owner approved, the
 * processes that run plugin code, and the one door through which that code
 * can ask the Studio for anything.
 */
export class PluginsService {
  readonly #context: ModuleContext;
  readonly #limits: PluginLimits;
  readonly #options: PluginsOptions;
  readonly #store: PluginStore;
  readonly #storage: PluginStorage;
  readonly #installer: PluginInstaller;
  readonly #grants: PanelGrantStore;
  readonly #runtimes = new Map<string, Runtime>();
  readonly #locks = new Map<string, Promise<unknown>>();
  readonly #pluginsDir: string;
  readonly #dataRoot: string;
  #sdk: SdkLocation | null = null;
  #isolation: Isolation | null = null;
  #ready: Promise<void> | null = null;
  #watchdog: NodeJS.Timeout | null = null;
  #closing = false;

  constructor(context: ModuleContext, options: PluginsOptions = {}) {
    this.#context = context;
    this.#options = options;
    this.#limits = { ...DEFAULT_PLUGIN_LIMITS, ...options.limits };
    this.#store = new PluginStore(context.db);
    this.#storage = new PluginStorage(context.db);
    this.#pluginsDir = path.join(context.config.dataDir, 'plugins');
    this.#dataRoot = path.join(context.config.dataDir, 'plugin-data');
    this.#installer = new PluginInstaller(context, {
      pluginsDir: this.#pluginsDir,
      gitTimeoutMs: this.#limits.gitTimeoutMs,
      allowLocalGit: options.allowLocalGit === true,
    });
    this.#grants = new PanelGrantStore({ ttlMs: PLUGIN_LIMITS.panelGrantTtlMs, maxPerUser: 64, maxTotal: 2048 });
  }

  // ---- start-up ------------------------------------------------------------

  /**
   * Prepares the folders and the SDK copy, and offers the tools of plugins
   * that are already enabled. Runs once; everything public waits for it.
   */
  ready(): Promise<void> {
    this.#ready ??= this.#initialise().catch((error: unknown) => {
      this.#ready = null;
      throw error;
    });
    return this.#ready;
  }

  async #initialise(): Promise<void> {
    await fs.mkdir(this.#pluginsDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(this.#dataRoot, { recursive: true, mode: 0o700 });
    this.#sdk = await installSdk(this.#pluginsDir);
    this.#isolation = new Isolation(this.#context, this.#sdk, { nodePermissions: this.#options.nodePermissions !== false });
    await this.#installer.cleanUp();
    const enabled = this.#store.list().filter((record) => record.enabled);
    if (enabled.length > 0) {
      const isolation = await this.#isolation.state();
      for (const record of enabled) this.#registerTools(record, isolation);
    }
  }

  async isolation(): Promise<PluginIsolation> {
    await this.ready();
    return this.#isolation!.state();
  }

  #pluginDir(id: string): string {
    return path.join(this.#pluginsDir, id);
  }

  #dataDir(id: string): string {
    return path.join(this.#dataRoot, id);
  }

  #runtime(id: string): Runtime {
    let runtime = this.#runtimes.get(id);
    if (!runtime) {
      runtime = {
        process: null,
        starting: null,
        scopes: new Map(),
        granted: new Set(),
        log: new LogTail(this.#limits.logTailBytes),
        failures: [],
        lastFailure: null,
        backoffUntil: 0,
        inFlight: 0,
        idleTimer: null,
        hookQueue: Promise.resolve(),
        pendingHooks: 0,
        fetchStamps: [],
        fetchesInFlight: 0,
        notificationStamps: [],
        registeredTools: [],
        cpuSeconds: null,
        busyIdleTicks: 0,
        idleSinceTick: true,
      };
      this.#runtimes.set(id, runtime);
    }
    return runtime;
  }

  /** One management operation per plugin at a time. */
  #locked<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(id) ?? Promise.resolve();
    const next = previous.then(work, work);
    const settled = next.catch(() => {});
    this.#locks.set(id, settled);
    void settled.then(() => {
      if (this.#locks.get(id) === settled) this.#locks.delete(id);
    });
    return next;
  }

  #require(id: string): PluginRecord {
    const record = this.#store.get(id);
    if (!record) throw notFound('No such plugin.', 'plugin_not_found');
    return record;
  }

  #audit(action: string, userId: string | null, subject: string, detail: string, address?: string | null): void {
    this.#context.services.audit.record({ category: 'change', action, userId, subject, detail, address: address ?? null });
  }

  #announce(pluginId: string): void {
    this.#context.bus.publish(PLUGINS_INTERNAL_TOPIC, PLUGIN_BUS_EVENT.changed, { pluginId });
    this.#context.bus.publish(PLUGINS_TOPIC, PLUGINS_CHANGED_EVENT, {});
  }

  // ---- what the owner sees ---------------------------------------------------

  #approval(record: PluginRecord): { state: 'none' | 'current' | 'stale'; reasons: PluginApprovalReason[] } {
    if (!record.approvedHash || !record.approvedSurface) return { state: 'none', reasons: [] };
    const reasons: PluginApprovalReason[] = surfaceChanges(record.approvedSurface, record.manifest);
    if (record.approvedHash !== record.contentHash) reasons.push('content-changed');
    return { state: reasons.length === 0 ? 'current' : 'stale', reasons };
  }

  /** Why an enabled plugin's code may not run on this machine right now, or null when it may. */
  #blockReason(record: PluginRecord, isolation: PluginIsolation): string | null {
    if (!record.manifest.server) return null;
    if (isolation.level === 'none' && !isolation.unsandboxedAllowed) {
      return 'This machine cannot isolate plugin code, so plugins with server code are not run.';
    }
    if (record.approvedIsolation && ISOLATION_RANK[isolation.level] < ISOLATION_RANK[record.approvedIsolation]) {
      return `It was approved while this machine ran plugins "${record.approvedIsolation}"; now it can only run them "${isolation.level}". Approve it again to accept that.`;
    }
    return null;
  }

  #summary(record: PluginRecord, isolation: PluginIsolation): PluginSummary {
    const { manifest } = record;
    const runtime = this.#runtimes.get(record.id);
    const approval = this.#approval(record);

    let status: PluginStatus = 'stopped';
    let statusDetail: string | null = null;
    if (!record.enabled) {
      if (record.disabledReason === 'crash-loop') {
        status = 'crashed';
        statusDetail = `Disabled after failing repeatedly. ${record.lastFailure ?? ''}`.trim();
      } else if (approval.state !== 'current') {
        status = 'needs-approval';
        statusDetail =
          approval.state === 'none'
            ? 'Not approved yet.'
            : `Changed since it was approved (${approval.reasons.join(', ')}). Review and approve it again.`;
      }
    } else {
      const blocked = this.#blockReason(record, isolation);
      if (blocked) {
        status = 'blocked-no-sandbox';
        statusDetail = blocked;
      } else if (runtime?.process?.running) {
        status = 'running';
      } else if (runtime?.lastFailure && runtime.failures.length > 0) {
        status = 'crashed';
        statusDetail = `${runtime.lastFailure.message} It will be started again when it is next needed.`;
      }
    }

    const source =
      record.source.kind === 'git'
        ? { kind: 'git' as const, url: record.source.url, ref: record.source.ref, commit: record.commit }
        : { kind: 'directory' as const, name: record.source.name };

    return {
      id: record.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      author: manifest.author,
      license: manifest.license,
      homepage: manifest.homepage ?? null,
      source,
      hasServer: manifest.server !== undefined,
      enabled: record.enabled,
      status,
      statusDetail,
      contentHash: record.contentHash,
      approval: {
        state: approval.state,
        reasons: approval.reasons,
        approvedAt: record.approvedAt,
        approvedBy: record.approvedBy,
        isolation: record.approvedIsolation,
      },
      permissions: { requested: [...manifest.permissions], granted: [...record.granted] },
      contributes: {
        tools: manifest.contributes.tools.map((tool) => ({
          name: tool.name,
          registeredName: registeredPluginToolName(record.id, tool.name),
          description: tool.description,
          declaredEffect: tool.effect,
          effect: effectiveToolEffect(tool.effect, record.granted, isolation.restricts.network),
        })),
        panels: manifest.contributes.panels,
        hooks: manifest.contributes.hooks,
        linkTiles: manifest.contributes.linkTiles,
      },
      retainedData: record.retainedData,
      logTail: runtime?.log.lines() ?? [],
      installedAt: record.installedAt,
      updatedAt: record.updatedAt,
    };
  }

  async list(): Promise<PluginList> {
    const isolation = await this.isolation();
    return {
      plugins: this.#store.list().map((record) => this.#summary(record, isolation)),
      isolation,
      sourceDirectoryConfigured: this.#context.config.pluginSourceDir !== null,
    };
  }

  async get(id: string): Promise<PluginSummary> {
    const isolation = await this.isolation();
    return this.#summary(this.#require(id), isolation);
  }

  async sources(): Promise<PluginSourceList> {
    await this.ready();
    return this.#installer.listSources(new Set(this.#store.list().map((record) => record.id)));
  }

  /** What enabled plugins add to the interface of this user. */
  contributions(user: Principal): PluginContributions {
    const result: PluginContributions = { homeTiles: [], projectTabs: [], settingsPages: [], linkTiles: [] };
    for (const record of this.#store.list()) {
      if (!record.enabled) continue;
      const { manifest } = record;
      for (const panel of manifest.contributes.panels) {
        const entry: PluginPanelContribution = {
          pluginId: record.id,
          pluginName: manifest.name,
          panelId: panel.id,
          title: panel.title,
          icon: panel.icon,
        };
        if (panel.slots.includes('home-tile')) result.homeTiles.push(entry);
        if (panel.slots.includes('project-tab')) result.projectTabs.push(entry);
        if (panel.slots.includes('settings-page') && user.role === 'owner') result.settingsPages.push(entry);
      }
      for (const tile of manifest.contributes.linkTiles) {
        result.linkTiles.push({ pluginId: record.id, pluginName: manifest.name, id: tile.id, title: tile.title, icon: tile.icon, url: tile.url });
      }
    }
    return result;
  }

  // ---- installing, approving, removing -----------------------------------------

  #checkStudioVersion(staged: StagedPlugin): void {
    const wanted = staged.manifest.minStudioVersion;
    if (wanted && compareVersions(VERSION, wanted) < 0) {
      throw unprocessable(`This plugin needs Studio ${wanted} or newer; this is ${VERSION}.`, 'studio_too_old');
    }
  }

  #fetch(source: InstallPluginRequest['source'] | PluginRecord['source']): Promise<StagedPlugin> {
    return source.kind === 'git'
      ? this.#installer.fromGit(source.url, source.ref ?? null)
      : this.#installer.fromDirectory(source.name);
  }

  /** Copies and checks a plugin. It ends up installed and **disabled**; nothing of it has run. */
  async install(user: Principal, request: InstallPluginRequest, address?: string): Promise<PluginSummary> {
    await this.ready();
    const staged = await this.#fetch(request.source);
    const id = staged.manifest.id;
    try {
      return await this.#locked(id, async () => {
        if (this.#store.get(id)) throw conflict(`A plugin with the id "${id}" is already installed.`, 'plugin_exists');
        const prefix = pluginToolPrefix(id);
        const clash = this.#store.idWithToolPrefix(prefix);
        if (clash) throw conflict(`The id "${id}" is too close to the installed plugin "${clash}".`, 'plugin_id_conflict');
        this.#checkStudioVersion(staged);

        const target = this.#pluginDir(id);
        // Not in the database, so whatever sits there is left over from an install that did not finish.
        await fs.rm(target, { recursive: true, force: true });
        const dataSize = await directorySize(this.#dataDir(id), 10);
        const retainedData = this.#storage.usage(id).keys > 0 || dataSize.bytes > 0 || !dataSize.complete;
        await fs.rename(staged.directory, target);
        const record = this.#store.insert({
          id,
          toolPrefix: prefix,
          manifest: staged.manifest,
          source: staged.source,
          commit: staged.commit,
          contentHash: staged.contentHash,
          retainedData,
          installedBy: user.userId,
        });
        const origin = staged.source.kind === 'git' ? `${staged.source.url} @ ${staged.commit ?? 'unknown'}` : `folder ${staged.source.name}`;
        this.#audit('plugin.installed', user.userId, id, `${staged.manifest.name} ${staged.manifest.version} from ${origin}; ${staged.contentHash}`, address);
        this.#announce(id);
        return this.#summary(record, await this.#isolation!.state());
      });
    } catch (error) {
      await this.#installer.discard(staged);
      throw error;
    }
  }

  /**
   * Brings the record in line with the files when they are no longer the ones
   * on record, and takes the plugin out of service: what runs must be what
   * was approved.
   */
  async #quarantine(record: PluginRecord, actualHash: string | null, why: string, whileStarting = false): Promise<PluginRecord> {
    await this.#stopProcess(record.id, whileStarting);
    this.#unregisterTools(record.id);
    this.#grants.revoke((grant) => grant.pluginId === record.id);
    const manifest = await readManifest(this.#pluginDir(record.id)).catch(() => null);
    const updated = this.#store.update(record.id, {
      enabled: false,
      disabledReason: record.enabled ? 'content-changed' : record.disabledReason,
      ...(actualHash ? { contentHash: actualHash } : {}),
      ...(manifest && manifest.id === record.id ? { manifest } : {}),
    });
    if (record.enabled) {
      this.#audit('plugin.auto-disabled', null, record.id, `The installed files are not the approved ones (${why}).`);
      this.#context.log.warn({ plugin: record.id }, 'plugin disabled: its files changed after approval');
    }
    this.#announce(record.id);
    return updated;
  }

  /** Confirms that the files on disk are exactly the approved ones. Throws — after disabling the plugin — when they are not. */
  async #verify(record: PluginRecord, whileStarting = false): Promise<void> {
    let actual: string | null = null;
    let problem: string | null = null;
    try {
      actual = await hashTree(this.#pluginDir(record.id));
    } catch (error) {
      problem = describe(error);
    }
    if (actual !== null && actual === record.approvedHash && actual === record.contentHash) return;
    await this.#quarantine(record, actual, problem ?? 'content hash differs', whileStarting);
    throw conflict('This plugin’s files changed after it was approved, so it was disabled. Review and approve it again.', 'plugin_changed');
  }

  async enable(user: Principal, id: string, request: EnablePluginRequest, address?: string): Promise<PluginSummary> {
    await this.ready();
    return this.#locked(id, async () => {
      let record = this.#require(id);
      const isolation = await this.#isolation!.state();

      let actual: string;
      try {
        actual = await hashTree(this.#pluginDir(id));
      } catch (error) {
        await this.#quarantine(record, null, describe(error));
        throw conflict(`This plugin’s files are not usable: ${describe(error)}`, 'plugin_changed');
      }
      if (actual !== record.contentHash) {
        await this.#quarantine(record, actual, 'content hash differs');
        throw conflict('This plugin’s files are not the ones on record. Look at it again before approving.', 'plugin_changed');
      }
      if (request.contentHash !== actual) {
        throw conflict('The plugin changed since you looked at it. Review it again before approving.', 'plugin_changed');
      }
      if (request.isolation !== isolation.level) {
        throw conflict('How plugins are isolated on this machine is not what you were shown. Review it again.', 'isolation_changed', {
          isolation,
        });
      }
      if (record.manifest.server && isolation.level === 'none' && !isolation.unsandboxedAllowed) {
        throw conflict(isolation.detail, 'no_sandbox');
      }
      let granted;
      try {
        granted = chosenGrant(record.manifest.permissions, request.permissions);
      } catch (error) {
        throw badRequest(describe(error), undefined, 'permission_not_requested');
      }

      await this.#stopProcess(id);
      record = this.#store.update(id, {
        enabled: true,
        disabledReason: null,
        lastFailure: null,
        granted,
        approvedHash: actual,
        approvedSurface: surfaceOf(record.manifest),
        approvedIsolation: isolation.level,
        approvedBy: user.userId,
        approvedAt: Date.now(),
      });
      const runtime = this.#runtime(id);
      runtime.failures = [];
      runtime.lastFailure = null;
      runtime.backoffUntil = 0;
      this.#registerTools(record, isolation);
      this.#audit(
        'plugin.enabled',
        user.userId,
        id,
        `granted: ${granted.length > 0 ? granted.join(', ') : 'nothing'}; isolation: ${isolation.level}; ${actual}`,
        address,
      );
      this.#announce(id);
      return this.#summary(record, isolation);
    });
  }

  async disable(user: Principal, id: string, address?: string): Promise<PluginSummary> {
    await this.ready();
    return this.#locked(id, async () => {
      this.#require(id);
      await this.#stopProcess(id);
      this.#unregisterTools(id);
      this.#grants.revoke((grant) => grant.pluginId === id);
      const record = this.#store.update(id, { enabled: false, disabledReason: null });
      this.#audit('plugin.disabled', user.userId, id, '', address);
      this.#announce(id);
      return this.#summary(record, await this.#isolation!.state());
    });
  }

  /**
   * Fetches the plugin again from where it came. The new version keeps
   * running only if it asks for nothing new and contributes nothing
   * different; otherwise it waits, disabled, for the owner to approve it.
   */
  async update(user: Principal, id: string, address?: string): Promise<PluginSummary> {
    await this.ready();
    return this.#locked(id, async () => {
      const before = this.#require(id);
      const staged = await this.#fetch(before.source);
      try {
        if (staged.manifest.id !== id) {
          throw unprocessable(`The source now holds a different plugin ("${staged.manifest.id}").`, 'plugin_id_mismatch');
        }
        this.#checkStudioVersion(staged);
        const isolation = await this.#isolation!.state();
        if (staged.contentHash === before.contentHash) {
          await this.#installer.discard(staged);
          return this.#summary(before.commit === staged.commit ? before : this.#store.update(id, { commit: staged.commit }), isolation);
        }

        await this.#stopProcess(id);
        this.#unregisterTools(id);
        this.#grants.revoke((grant) => grant.pluginId === id);

        const target = this.#pluginDir(id);
        const retired = path.join(this.#pluginsDir, '.staging', `retired-${newId()}`);
        await fs.rename(target, retired).catch(() => {});
        await fs.rename(staged.directory, target);
        await fs.rm(retired, { recursive: true, force: true });

        const approvalWasCurrent = this.#approval(before).state === 'current';
        const reasons = before.approvedSurface ? surfaceChanges(before.approvedSurface, staged.manifest) : [];
        const stillRequested = new Set(staged.manifest.permissions);
        const granted = before.granted.filter((permission) => stillRequested.has(permission));
        const keepsRunning = before.enabled && approvalWasCurrent && reasons.length === 0;

        const record = this.#store.update(id, {
          manifest: staged.manifest,
          commit: staged.commit,
          contentHash: staged.contentHash,
          granted,
          ...(keepsRunning
            ? // The owner asked for this update with a fresh sign-in: that is the approval of the new files.
              { approvedHash: staged.contentHash, approvedSurface: surfaceOf(staged.manifest), approvedBy: user.userId, approvedAt: Date.now() }
            : { enabled: false, disabledReason: before.enabled ? (reasons[0] ?? 'content-changed') : before.disabledReason }),
        });
        if (keepsRunning) this.#registerTools(record, isolation);
        this.#audit(
          'plugin.updated',
          user.userId,
          id,
          `${before.manifest.version} → ${staged.manifest.version}; ${staged.commit ?? staged.contentHash}; ` +
            (keepsRunning ? 'still enabled' : before.enabled ? `disabled until approved (${reasons.join(', ') || 'content-changed'})` : 'disabled'),
          address,
        );
        this.#announce(id);
        return this.#summary(record, isolation);
      } catch (error) {
        await this.#installer.discard(staged);
        throw error;
      }
    });
  }

  async uninstall(user: Principal, id: string, deleteData: boolean, address?: string): Promise<void> {
    await this.ready();
    await this.#locked(id, async () => {
      this.#require(id);
      await this.#stopProcess(id);
      this.#unregisterTools(id);
      this.#grants.revoke((grant) => grant.pluginId === id);
      await fs.rm(this.#pluginDir(id), { recursive: true, force: true });
      this.#store.remove(id);
      if (deleteData) {
        this.#storage.clear(id);
        await fs.rm(this.#dataDir(id), { recursive: true, force: true });
      }
      const runtime = this.#runtimes.get(id);
      if (runtime?.idleTimer) clearTimeout(runtime.idleTimer);
      this.#runtimes.delete(id);
      this.#audit('plugin.uninstalled', user.userId, id, deleteData ? 'its data was deleted' : 'its data was kept', address);
      this.#announce(id);
    });
  }

  // ---- tools for agents ------------------------------------------------------

  #unregisterTools(id: string): void {
    const runtime = this.#runtimes.get(id);
    if (!runtime) return;
    for (const name of runtime.registeredTools) this.#context.agentTools.unregister(name);
    runtime.registeredTools = [];
  }

  #registerTools(record: PluginRecord, isolation: PluginIsolation): void {
    this.#unregisterTools(record.id);
    const runtime = this.#runtime(record.id);
    const registry = this.#context.agentTools;
    for (const tool of record.manifest.contributes.tools) {
      const name = registeredPluginToolName(record.id, tool.name);
      if (registry.get(name)) {
        runtime.log.add(`[studio] the tool "${tool.name}" was not offered: the name ${name} is already taken`);
        continue;
      }
      registry.register({
        name,
        // The model is told where the tool comes from; a plugin cannot pass for part of the Studio.
        description: `[Plugin: ${record.manifest.name}] ${tool.description}`,
        input: toolInputToZod(tool.inputSchema),
        effect: effectiveToolEffect(tool.effect, record.granted, isolation.restricts.network),
        handler: (context, input) => this.#callTool(record.id, tool.name, context, input),
      });
      runtime.registeredTools.push(name);
    }
  }

  #actingUser(userId: string): ActingUser | null {
    const user = this.#context.services.auth.findUser(userId);
    if (!user || user.disabled) return null;
    return { id: user.id, displayName: user.displayName, role: user.role };
  }

  async #callTool(pluginId: string, toolName: string, context: AgentToolContext, input: unknown): Promise<AgentToolResult> {
    try {
      await this.ready();
      const record = this.#store.get(pluginId);
      const tool = record?.manifest.contributes.tools.find((candidate) => candidate.name === toolName);
      if (!record?.enabled || !tool) return { text: 'This plugin tool is not available.', isError: true };
      const user = this.#actingUser(context.userId);
      if (!user) return { text: 'The user this run belongs to is not available.', isError: true };
      const isolation = await this.#isolation!.state();
      const effect = effectiveToolEffect(tool.effect, record.granted, isolation.restricts.network);

      const raw = await this.#invoke(
        record,
        // A tool sees the run's project and nothing beyond it.
        { kind: 'tool', readOnly: effect === 'read', user, projectId: context.projectId, projectBound: true },
        'tool.call',
        {
          tool: toolName,
          input,
          context: {
            runId: context.runId,
            sessionId: context.sessionId,
            projectId: context.projectId,
            agentId: context.agentId,
            user: { id: user.id, displayName: user.displayName },
          },
        },
        this.#limits.toolCallTimeoutMs,
      );
      const parsed = toolResultSchema.safeParse(raw);
      if (!parsed.success) return { text: 'The plugin returned something that is not a tool result.', isError: true };
      const { text, isError } = parsed.data;
      const max = this.#limits.maxToolResultBytes;
      const bounded = Buffer.byteLength(text, 'utf8') > max ? `${Buffer.from(text, 'utf8').subarray(0, max).toString('utf8')}\n[cut: the result was longer than ${max} bytes]` : text;
      return isError ? { text: bounded, isError: true } : { text: bounded };
    } catch (error) {
      const message = error instanceof PluginCallError || error instanceof StudioError ? error.message : 'The plugin could not be reached.';
      if (!(error instanceof PluginCallError) && !(error instanceof StudioError)) {
        this.#context.log.error({ plugin: pluginId, err: describe(error) }, 'plugin tool call failed');
      }
      return { text: redactSecrets(message).slice(0, 2000), isError: true };
    }
  }

  // ---- processes ---------------------------------------------------------------

  #disarmIdle(runtime: Runtime): void {
    if (runtime.idleTimer) clearTimeout(runtime.idleTimer);
    runtime.idleTimer = null;
  }

  #armIdle(id: string, runtime: Runtime): void {
    this.#disarmIdle(runtime);
    runtime.idleTimer = setTimeout(() => {
      if (runtime.inFlight === 0) void this.#stopProcess(id).catch(() => {});
    }, this.#limits.idleStopMs);
    runtime.idleTimer.unref();
  }

  /** `whileStarting`: called from the start-up path itself, which must not wait for its own completion. */
  async #stopProcess(id: string, whileStarting = false): Promise<void> {
    const runtime = this.#runtimes.get(id);
    if (!runtime) return;
    this.#disarmIdle(runtime);
    const starting = whileStarting ? null : runtime.starting;
    if (starting) await starting.catch(() => {});
    const process = runtime.process;
    if (!process?.running) return;
    const scope: CallScope = { id: newId(), kind: 'stop', readOnly: false, user: null, projectId: null, projectBound: true };
    runtime.scopes.set(scope.id, scope);
    try {
      await process.stop({ scope: scope.id });
    } finally {
      runtime.scopes.delete(scope.id);
    }
  }

  #processExited(id: string, process: PluginProcess, info: ExitInfo): void {
    const runtime = this.#runtimes.get(id);
    if (!runtime) return;
    if (runtime.process === process) runtime.process = null;
    runtime.scopes.clear();
    runtime.cpuSeconds = null;
    runtime.busyIdleTicks = 0;
    if (info.expected || this.#closing) {
      runtime.log.add('[studio] stopped');
      return;
    }
    const now = Date.now();
    const limits = this.#limits;
    runtime.failures = [...runtime.failures.filter((at) => now - at < limits.crashWindowMs), now];
    const message = `The plugin process ${info.reason}.`;
    runtime.lastFailure = { at: now, message };
    runtime.backoffUntil = now + Math.min(limits.backoffMaxMs, limits.backoffBaseMs * 2 ** (runtime.failures.length - 1));
    runtime.log.add(`[studio] ${message}`);
    this.#context.log.warn({ plugin: id, reason: info.reason }, 'plugin process failed');
    if (runtime.failures.length < limits.maxCrashes) return;

    // A plugin that keeps failing is taken out of service rather than restarted for ever.
    try {
      const record = this.#store.get(id);
      if (!record?.enabled) return;
      this.#unregisterTools(id);
      this.#grants.revoke((grant) => grant.pluginId === id);
      this.#store.update(id, {
        enabled: false,
        disabledReason: 'crash-loop',
        lastFailure: `It failed ${runtime.failures.length} times within ${Math.round(limits.crashWindowMs / 60_000)} minutes; the last time: ${message}`,
      });
      runtime.log.add('[studio] disabled after repeated failures');
      this.#audit('plugin.auto-disabled', null, id, `Failed ${runtime.failures.length} times in a row. ${message}`);
      this.#announce(id);
    } catch (error) {
      this.#context.log.error({ plugin: id, err: describe(error) }, 'could not disable a failing plugin');
    }
  }

  async #start(record: PluginRecord, runtime: Runtime): Promise<PluginProcess> {
    if (!record.manifest.server) throw conflict('This plugin has no server code.', 'plugin_no_server');
    const isolationState = await this.#isolation!.state();
    const blocked = this.#blockReason(record, isolationState);
    if (blocked) throw conflict(blocked, 'plugin_blocked');
    const wait = runtime.backoffUntil - Date.now();
    if (wait > 0) {
      throw unavailable(`The plugin failed a moment ago and will be tried again in ${Math.ceil(wait / 1000)} s.`, 'plugin_backoff');
    }
    await this.#verify(record, true);

    const pluginDir = this.#pluginDir(record.id);
    const dataDir = this.#dataDir(record.id);
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    const launch = this.#isolation!.launch({
      pluginDir,
      dataDir,
      entry: path.join(pluginDir, ...record.manifest.server.entry.split('/')),
      network: record.granted.includes('network'),
      memoryMb: this.#limits.memoryMb,
    });

    runtime.granted = new Set(record.granted);
    const process: PluginProcess = new PluginProcess({
      processes: this.#context.processes,
      launch,
      limits: this.#limits,
      log: runtime.log,
      onHostRequest: (method, params) => this.#hostRequest(record.id, runtime, method, params),
      onExit: (info) => this.#processExited(record.id, process, info),
    });
    runtime.process = process;
    const scope: CallScope = { id: newId(), kind: 'start', readOnly: false, user: null, projectId: null, projectBound: true };
    runtime.scopes.set(scope.id, scope);
    try {
      await process.start({
        protocol: 1,
        scope: scope.id,
        plugin: { id: record.id, version: record.manifest.version },
        studio: { version: VERSION },
        permissions: [...record.granted],
      });
    } catch (error) {
      // Whatever the plugin said while failing to start, to the caller this is a plugin that is not there.
      const timedOut = error instanceof PluginCallError && error.code === 'timeout';
      throw new PluginCallError(timedOut ? 'timeout' : 'plugin_exited', `The plugin could not be started: ${describe(error)}`);
    } finally {
      runtime.scopes.delete(scope.id);
    }
    runtime.log.add(`[studio] started (${isolationState.level})`);
    // It runs again: the last failure is history (it still counts towards the crash-loop limit).
    runtime.lastFailure = null;
    this.#startWatchdog();
    return process;
  }

  #ensureProcess(record: PluginRecord, runtime: Runtime): Promise<PluginProcess> {
    if (runtime.process?.running && !runtime.starting) return Promise.resolve(runtime.process);
    runtime.starting ??= this.#start(record, runtime).finally(() => {
      runtime.starting = null;
    });
    return runtime.starting;
  }

  /** Calls into a plugin's process, giving the call a scope that host requests can refer to while it lasts. */
  async #invoke(
    record: PluginRecord,
    scopeInit: Omit<CallScope, 'id'>,
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    if (this.#closing) throw unavailable('The server is shutting down.', 'plugin_unavailable');
    const runtime = this.#runtime(record.id);
    if (runtime.inFlight >= this.#limits.maxConcurrentCalls) {
      throw unavailable('This plugin is busy. Try again in a moment.', 'plugin_busy');
    }
    runtime.inFlight += 1;
    runtime.idleSinceTick = false;
    this.#disarmIdle(runtime);
    const scope: CallScope = { id: newId(), ...scopeInit };
    try {
      const process = await this.#ensureProcess(record, runtime);
      runtime.scopes.set(scope.id, scope);
      return await process.call(method, { scope: scope.id, ...params }, timeoutMs);
    } finally {
      runtime.scopes.delete(scope.id);
      runtime.inFlight -= 1;
      if (runtime.inFlight === 0) this.#armIdle(record.id, runtime);
    }
  }

  #asStudioError(error: unknown): unknown {
    if (!(error instanceof PluginCallError)) return error;
    if (error.code === 'timeout') return new StudioError(504, 'plugin_timeout', error.message);
    if (error.code === 'too_large') return payloadTooLarge('That is larger than a plugin can be sent.');
    return unavailable(error.message, 'plugin_unavailable');
  }

  /** Process id of a plugin's running process group, for the watchdog and for tests. */
  processId(id: string): number | undefined {
    const process = this.#runtimes.get(id)?.process;
    return process?.running ? process.pid : undefined;
  }

  /** Resolves when every queued hook has been delivered (or dropped). */
  async settled(): Promise<void> {
    for (;;) {
      const queues = [...this.#runtimes.values()].map((runtime) => runtime.hookQueue);
      await Promise.all(queues);
      if ([...this.#runtimes.values()].every((runtime) => runtime.pendingHooks === 0)) return;
    }
  }

  /** Stops every plugin process politely. Called on shutdown. */
  async stopAll(): Promise<void> {
    this.#closing = true;
    if (this.#watchdog) clearInterval(this.#watchdog);
    this.#watchdog = null;
    await Promise.all([...this.#runtimes.keys()].map((id) => this.#stopProcess(id).catch(() => {})));
  }

  // ---- the watchdog --------------------------------------------------------------

  #startWatchdog(): void {
    if (this.#watchdog || this.#limits.watchdogIntervalMs <= 0) return;
    let dataTick = 0;
    this.#watchdog = setInterval(() => {
      dataTick += 1;
      void this.#measure(dataTick % 6 === 0).catch((error: unknown) => {
        this.#context.log.debug({ err: describe(error) }, 'plugin watchdog failed');
      });
    }, this.#limits.watchdogIntervalMs);
    this.#watchdog.unref();
  }

  /**
   * Looks at what running plugins consume. The heap cap does not cover
   * buffers, nothing caps CPU, and the data folder is on a real disk — so the
   * server measures, and ends what goes over.
   */
  async #measure(alsoData: boolean): Promise<void> {
    const limits = this.#limits;
    let anyRunning = false;
    for (const [id, runtime] of this.#runtimes) {
      const process = runtime.process;
      const pid = process?.running ? process.pid : undefined;
      if (!process || pid === undefined) continue;
      anyRunning = true;
      const usage = await groupUsage(pid);
      if (usage) {
        if (usage.rssBytes > limits.maxRssBytes) {
          process.kill(`used more memory than allowed (${Math.round(usage.rssBytes / (1024 * 1024))} MiB)`);
          continue;
        }
        const previous = runtime.cpuSeconds;
        runtime.cpuSeconds = usage.cpuSeconds;
        const idle = runtime.inFlight === 0 && runtime.idleSinceTick && !runtime.starting;
        runtime.idleSinceTick = runtime.inFlight === 0;
        if (previous !== null && idle) {
          const share = (usage.cpuSeconds - previous) / (limits.watchdogIntervalMs / 1000);
          runtime.busyIdleTicks = share > limits.maxIdleCpuShare ? runtime.busyIdleTicks + 1 : 0;
          if (runtime.busyIdleTicks >= 2) {
            process.kill('kept the processor busy while nothing had called it');
            continue;
          }
        } else {
          runtime.busyIdleTicks = 0;
        }
      }
      if (alsoData) {
        const size = await directorySize(this.#dataDir(id));
        if (size.bytes > limits.maxDataBytes || !size.complete) {
          process.kill(`filled its data folder beyond the limit (${Math.round(limits.maxDataBytes / (1024 * 1024))} MiB)`);
        }
      }
    }
    if (!anyRunning && this.#watchdog) {
      clearInterval(this.#watchdog);
      this.#watchdog = null;
    }
  }

  // ---- what a plugin may ask for ---------------------------------------------------

  #principal(user: ActingUser, pluginId: string): Principal {
    return {
      userId: user.id,
      username: '',
      displayName: user.displayName,
      role: user.role,
      via: 'token',
      credentialId: `plugin:${pluginId}`,
      scopes: ['read'],
      authenticatedAt: 0,
    };
  }

  async #hostRequest(pluginId: string, runtime: Runtime, method: string, rawParams: unknown): Promise<unknown> {
    if (!isHostMethod(method)) throw new HostRefusal('unknown_method', `The Studio has no "${method.slice(0, 64)}".`);
    const params = rawParams !== null && typeof rawParams === 'object' && !Array.isArray(rawParams) ? (rawParams as Record<string, unknown>) : {};
    const scope = typeof params.scope === 'string' ? runtime.scopes.get(params.scope) : undefined;
    if (!scope) {
      throw new HostRefusal('invalid_scope', 'The Studio only accepts requests that belong to a call still in progress.');
    }
    authorize(method, scope, runtime.granted);

    const parse = <T>(schema: z.ZodType<T>): T => {
      const parsed = schema.safeParse(params);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new HostRefusal('invalid_params', `${issue?.path.join('.') || 'params'}: ${issue?.message ?? 'not valid'}`);
      }
      return parsed.data;
    };
    const storage = <T>(work: () => T): T => {
      try {
        return work();
      } catch (error) {
        if (error instanceof StorageError) throw new HostRefusal(error.code, error.message);
        throw error;
      }
    };

    switch (method) {
      case 'host.storage.get': {
        const { key } = parse(paramsSchema.key);
        return storage(() => this.#storage.get(pluginId, key));
      }
      case 'host.storage.set': {
        const { key, value } = parse(paramsSchema.set);
        storage(() => this.#storage.set(pluginId, key, value));
        return {};
      }
      case 'host.storage.delete': {
        const { key } = parse(paramsSchema.key);
        return { deleted: storage(() => this.#storage.delete(pluginId, key)) };
      }
      case 'host.storage.list':
        return { keys: this.#storage.list(pluginId, parse(paramsSchema.list)) };
      case 'host.notify':
        return this.#notify(pluginId, runtime, scope, parse(paramsSchema.notify));
      case 'host.http.fetch':
        return this.#httpFetch(pluginId, runtime, parse(paramsSchema.fetch));
      case 'host.projects.list': {
        const principal = this.#principal(scope.user!, pluginId);
        return {
          projects: this.#context.services.projects
            .list(principal)
            .filter((project) => projectInScope(scope, project.id))
            .map((project) => ({ id: project.id, name: project.name, access: project.access })),
        };
      }
      case 'host.files.read':
        return this.#readProjectFile(pluginId, scope, parse(paramsSchema.read));
    }
  }

  #notify(pluginId: string, runtime: Runtime, scope: CallScope, params: { title: string; body: string }): Record<string, never> {
    const now = Date.now();
    runtime.notificationStamps = runtime.notificationStamps.filter((at) => now - at < 60_000);
    if (runtime.notificationStamps.length >= this.#limits.maxNotificationsPerMinute) {
      throw new HostRefusal('rate_limited', 'This plugin has sent too many notifications. Try again in a minute.');
    }
    runtime.notificationStamps.push(now);
    const record = this.#store.get(pluginId);
    const event: PluginNotificationEvent = {
      pluginId,
      pluginName: record?.manifest.name ?? pluginId,
      userId: scope.user!.id,
      title: params.title,
      body: params.body,
      projectId: scope.projectId,
    };
    // The notifications module listens for this; a plugin never writes a notification itself.
    this.#context.bus.publish(PLUGINS_INTERNAL_TOPIC, PLUGIN_BUS_EVENT.notification, event);
    return {};
  }

  async #httpFetch(pluginId: string, runtime: Runtime, params: z.infer<typeof paramsSchema.fetch>): Promise<unknown> {
    const limits = this.#limits;
    const url = checkFetchTarget(params.url, runtime.granted);
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(params.headers)) {
      const lower = name.toLowerCase();
      if (!FETCH_REQUEST_HEADERS.has(lower)) throw new HostRefusal('header_not_allowed', `A plugin cannot set the "${lower.slice(0, 40)}" header.`);
      if (/[\r\n]/.test(value)) throw new HostRefusal('invalid_params', 'Header values cannot contain line breaks.');
      headers[lower] = value;
    }
    const hasBody = params.body !== undefined;
    if (hasBody && (params.method === 'GET' || params.method === 'HEAD')) {
      throw new HostRefusal('invalid_params', `A ${params.method} request has no body.`);
    }
    if (hasBody && Buffer.byteLength(params.body!, 'utf8') > limits.maxFetchRequestBytes) {
      throw new HostRefusal('too_large', 'The request body is too large.');
    }

    const now = Date.now();
    runtime.fetchStamps = runtime.fetchStamps.filter((at) => now - at < 60_000);
    if (runtime.fetchStamps.length >= limits.maxFetchesPerMinute) {
      throw new HostRefusal('rate_limited', 'This plugin has made too many requests. Try again in a minute.');
    }
    if (runtime.fetchesInFlight >= limits.maxConcurrentFetches) {
      throw new HostRefusal('too_many_requests', 'Too many requests are already in progress.');
    }
    runtime.fetchStamps.push(now);
    runtime.fetchesInFlight += 1;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), limits.fetchTimeoutMs);
    try {
      const transport = this.#options.fetchTransport ?? guardedRequest;
      const response = await transport(url.toString(), {
        method: params.method,
        headers: {
          ...headers,
          'user-agent': `AgentStudio-Plugin/${VERSION} (${pluginId})`,
          'accept-encoding': 'identity',
          ...(hasBody ? { 'content-length': String(Buffer.byteLength(params.body!, 'utf8')) } : {}),
        },
        ...(hasBody ? { body: params.body! } : {}),
        signal: controller.signal,
        timeoutMs: limits.fetchTimeoutMs,
        // Public addresses only, checked after name resolution; https only; redirects are returned, not followed.
        policy: {},
      });
      const body = await readBody(response.body, limits.maxFetchResponseBytes);
      const passed: Record<string, string> = {};
      for (const [name, value] of Object.entries(response.headers)) {
        if (FETCH_RESPONSE_HEADERS.has(name) && typeof value === 'string') passed[name] = value.slice(0, 2000);
      }
      return params.responseType === 'base64'
        ? { status: response.status, headers: passed, body: body.toString('base64'), encoding: 'base64' }
        : { status: response.status, headers: passed, body: body.toString('utf8'), encoding: 'utf8' };
    } catch (error) {
      if (error instanceof HostRefusal) throw error;
      if (error instanceof StudioError) throw new HostRefusal(error.code, error.message);
      throw new HostRefusal('network_error', controller.signal.aborted ? 'The request took too long.' : 'The request failed.');
    } finally {
      clearTimeout(timer);
      runtime.fetchesInFlight -= 1;
    }
  }

  async #readProjectFile(pluginId: string, scope: CallScope, params: z.infer<typeof paramsSchema.read>): Promise<unknown> {
    const missing = () => new HostRefusal('project_not_found', 'No such project.');
    if (!projectInScope(scope, params.projectId)) throw missing();
    const maxBytes = Math.min(params.maxBytes ?? this.#limits.maxFileReadBytes, this.#limits.maxFileReadBytes);
    let root: string;
    let real: string;
    try {
      const project = this.#context.services.projects.requireAccess(this.#principal(scope.user!, pluginId), params.projectId, 'read');
      root = await fs.realpath(project.rootDir);
      real = await confine(root, params.path);
    } catch (error) {
      if (error instanceof StudioError) throw new HostRefusal(error.code, error.message);
      throw new HostRefusal('not_found', 'That file does not exist.');
    }
    const relative = toRelative(root, real);
    if (isSensitiveProjectPath(relative)) {
      throw new HostRefusal('path_not_allowed', 'Plugins are not given files that usually hold credentials.');
    }
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      throw new HostRefusal('not_found', 'That file does not exist.');
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new HostRefusal('not_a_file', 'That is not a file.');
      const buffer = Buffer.alloc(Math.min(stat.size, maxBytes));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const bytes = buffer.subarray(0, bytesRead);
      const truncated = stat.size > bytesRead;
      // A cut may fall inside a character: allow for up to three dangling bytes before calling it binary.
      for (let trim = 0; trim <= (truncated ? 3 : 0); trim += 1) {
        try {
          const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytes.length - trim));
          if (!content.includes('\0')) return { path: relative, size: stat.size, truncated, encoding: 'utf8', content };
          break;
        } catch {
          /* not text at this length */
        }
      }
      return { path: relative, size: stat.size, truncated, encoding: 'base64', content: bytes.toString('base64') };
    } finally {
      await handle.close();
    }
  }

  // ---- hooks ---------------------------------------------------------------------

  /** Hands an event to every enabled plugin that asked for it. Each plugin gets its events one at a time, in order. */
  dispatchHook(event: PluginHookEvent, payload: Record<string, unknown>): void {
    if (this.#closing) return;
    for (const record of this.#store.list()) {
      if (!record.enabled || !record.manifest.server || !record.manifest.contributes.hooks.includes(event)) continue;
      const runtime = this.#runtime(record.id);
      if (runtime.pendingHooks >= this.#limits.maxPendingHooks) {
        runtime.log.add(`[studio] dropped a "${event}" event: too many are waiting`);
        continue;
      }
      runtime.pendingHooks += 1;
      const id = record.id;
      runtime.hookQueue = runtime.hookQueue.then(async () => {
        try {
          const current = this.#store.get(id);
          if (!current?.enabled) return;
          // No user: whatever the hook does, it cannot reach anything that belongs to one.
          await this.#invoke(current, { kind: 'hook', readOnly: false, user: null, projectId: null, projectBound: true }, 'hook.event', { event, payload }, this.#limits.hookTimeoutMs);
        } catch (error) {
          runtime.log.add(`[studio] the "${event}" hook failed: ${describe(error)}`);
        } finally {
          runtime.pendingHooks -= 1;
        }
      });
    }
  }

  // ---- panels --------------------------------------------------------------------

  /** Ends panel grants; used when a session, a user or a project goes away. */
  revokeGrants(where: { credentialId?: string; userId?: string; projectId?: string }): void {
    this.#grants.revoke(
      (grant) =>
        (where.credentialId !== undefined && grant.credentialId === where.credentialId) ||
        (where.userId !== undefined && where.projectId === undefined && grant.userId === where.userId) ||
        (where.projectId !== undefined && grant.projectId === where.projectId && (where.userId === undefined || grant.userId === where.userId)),
    );
  }

  async openPanel(user: Principal, id: string, panelId: string, request: OpenPluginPanelRequest): Promise<PluginPanelGrant> {
    await this.ready();
    const record = this.#store.get(id);
    // A disabled plugin is, to someone who is not managing plugins, simply not there.
    if (!record?.enabled) throw notFound('No such plugin.', 'plugin_not_found');
    const panel = record.manifest.contributes.panels.find((candidate) => candidate.id === panelId);
    if (!panel || !panel.slots.includes(request.slot)) throw notFound('No such panel.', 'panel_not_found');

    if (request.slot === 'settings-page' && user.role !== 'owner') {
      throw forbidden('Only the owner of this Studio can open plugin settings.', 'owner_required');
    }
    if (request.slot === 'project-tab') {
      if (!request.projectId) throw badRequest('A project tab needs a project.', undefined, 'project_required');
      this.#context.services.projects.requireAccess(user, request.projectId, 'read');
    } else if (request.projectId) {
      throw badRequest('Only a project tab is opened for a project.', undefined, 'project_not_expected');
    }
    await this.#verify(record);

    const entry = panel.entry.split('/');
    const { token, grant } = this.#grants.mint({
      pluginId: id,
      panelId,
      slot: request.slot,
      userId: user.userId,
      credentialId: user.credentialId,
      projectId: request.projectId ?? null,
      assetRoot: path.join(this.#pluginDir(id), ...entry.slice(0, -1)),
      entryFile: entry.at(-1)!,
    });
    return {
      panel: token,
      url: `/api/plugins/panel/${token}/${grant.entryFile}`,
      expiresAt: grant.expiresAt,
      sandbox: PLUGIN_PANEL_SANDBOX,
      pluginId: id,
      panelId,
      slot: request.slot,
      projectId: grant.projectId,
    };
  }

  /** A panel file for the grant in the address, with the headers that confine it; null means "not found". */
  async panelAsset(token: string, requested: string, origin: string): Promise<{ headers: Record<string, string>; body: Buffer } | null> {
    const grant = this.#grants.resolve(token);
    if (!grant) return null;
    if (!this.#store.get(grant.pluginId)?.enabled) return null;
    const base = `${origin}/api/plugins/panel/${token}/`;
    if (requested === PANEL_SDK_PATH) {
      await this.ready();
      const body = await fs.readFile(this.#sdk!.panelFile);
      return { headers: panelHeaders(base, 'text/javascript; charset=utf-8'), body };
    }
    const asset = await readPanelAsset(grant.assetRoot, requested);
    return asset ? { headers: panelHeaders(base, asset.contentType), body: asset.body } : null;
  }

  /** Relays a call from a panel to its plugin, as the signed-in user and never with anything of theirs but id and name. */
  async panelRpc(user: Principal, id: string, request: PluginPanelRpcRequest): Promise<PluginPanelRpcResponse> {
    await this.ready();
    const grant = this.#grants.resolve(request.panel);
    // Whatever is wrong with the grant, the answer is the same.
    if (!grant || grant.pluginId !== id || grant.userId !== user.userId || grant.credentialId !== user.credentialId) {
      throw new StudioError(410, 'panel_expired', 'This panel is no longer open. Open it again.');
    }
    const record = this.#store.get(id);
    if (!record?.enabled) throw notFound('No such plugin.', 'plugin_not_found');
    if (!record.manifest.server) throw conflict('This plugin has no server code to call.', 'plugin_no_server');
    const acting = this.#actingUser(user.userId);
    if (!acting) throw forbidden();
    // Access to the project is checked on every call, not only when the panel was opened.
    if (grant.projectId) this.#context.services.projects.requireAccess(user, grant.projectId, 'read');

    const paramsText = JSON.stringify(request.params ?? null);
    if (Buffer.byteLength(paramsText, 'utf8') > PLUGIN_LIMITS.maxPanelMessageBytes) throw payloadTooLarge('That request is too large.');

    try {
      const result = await this.#invoke(
        record,
        { kind: 'panel', readOnly: false, user: acting, projectId: grant.projectId, projectBound: grant.projectId !== null },
        'panel.request',
        {
          panelId: grant.panelId,
          method: request.method,
          params: request.params,
          context: { user: { id: acting.id, displayName: acting.displayName }, projectId: grant.projectId, slot: grant.slot },
        },
        this.#limits.panelCallTimeoutMs,
      );
      if (Buffer.byteLength(JSON.stringify(result ?? null), 'utf8') > PLUGIN_LIMITS.maxPanelMessageBytes) {
        return { ok: false, error: { code: 'too_large', message: 'The plugin answered with more than a panel can be sent.' } };
      }
      return { ok: true, result: result ?? null };
    } catch (error) {
      if (error instanceof PluginCallError && error.reported) {
        return { ok: false, error: { code: error.code, message: redactSecrets(error.message).slice(0, 500) } };
      }
      throw this.#asStudioError(error);
    }
  }
}
