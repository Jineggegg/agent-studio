import { z } from 'zod';
import { idSchema, timestampSchema } from './common.js';

/**
 * Wire contracts for plugins.
 *
 * A plugin is a folder with a manifest (`plugin.json`). It may contribute
 * tools for agents, panels (small web pages shown in a sandboxed frame), event
 * hooks and link tiles. Its server-side code runs in a separate, isolated
 * process and can do nothing except ask the Studio through a capability API
 * that is checked against the permissions the owner granted.
 *
 * This file defines: the manifest, the permission vocabulary, the management
 * API payloads, and — in full, because the web client implements the other
 * half — the message protocol between a panel frame and the page embedding it.
 */

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const PLUGIN_LIMITS = {
  /** A plugin folder larger than this is refused at install time. */
  maxTreeBytes: 20 * 1024 * 1024,
  maxTreeFiles: 2000,
  maxManifestBytes: 256 * 1024,
  maxTools: 32,
  maxPanels: 8,
  maxLinkTiles: 16,
  maxPermissions: 32,
  /** Longest name a tool may have once it is registered as `plugin_<id>_<tool>`. */
  maxRegisteredToolName: 63,
  /** One panel request or response, as JSON text. */
  maxPanelMessageBytes: 256 * 1024,
  /** Requests one panel may have in flight; the embedding page refuses more. */
  maxPanelPendingRequests: 32,
  /** Lifetime of a panel grant. */
  panelGrantTtlMs: 60 * 60 * 1000,
} as const;

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** Path segments of the plugin API that can therefore never be a plugin id. */
export const RESERVED_PLUGIN_IDS = ['install', 'contributions', 'sources', 'panel', 'isolation'] as const;

/**
 * Names the server keeps for itself in the folder that holds the installed
 * plugins, beside the plugins' own folders (`<plugins>/<id>/`): the shared
 * SDK copy (`node_modules`), the `package.json` that makes plugin code ES
 * modules, and the temporary files those are rewritten through
 * (`package.json.<pid>.tmp`). A plugin with one of these ids would replace or
 * break what every other plugin depends on. Names starting with a dot
 * (`.staging`) are kept too; the id pattern already refuses them.
 */
export const RESERVED_PLUGIN_FOLDER_NAMES = ['package.json', 'node_modules'] as const;

/** True when a plugin with this id would sit where the server keeps something of its own. */
export function isReservedPluginFolderName(id: string): boolean {
  return id.startsWith('.') || RESERVED_PLUGIN_FOLDER_NAMES.some((name) => id === name || id.startsWith(`${name}.`));
}

/**
 * A slug (`notes-counter`) or a reverse-DNS name (`com.example.notes`):
 * lowercase letters and digits in groups joined by single dots or hyphens.
 */
export const pluginIdSchema = z
  .string()
  .min(2)
  .max(48)
  .regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/, 'Use lowercase letters, digits, dots and hyphens, starting with a letter.')
  .refine((id) => !(RESERVED_PLUGIN_IDS as readonly string[]).includes(id), 'That name is reserved.')
  .refine((id) => !isReservedPluginFolderName(id), 'That name is used by the Studio’s own files in the plugins folder.');

export const pluginToolNameSchema = z
  .string()
  .max(32)
  .regex(/^[a-z][a-z0-9_]*$/, 'Use lowercase letters, digits and underscores, starting with a letter.');

export const pluginPanelIdSchema = z
  .string()
  .max(32)
  .regex(/^[a-z][a-z0-9-]*$/, 'Use lowercase letters, digits and hyphens, starting with a letter.');

/** The name of a method a panel may call on its plugin. */
export const pluginMethodNameSchema = z
  .string()
  .max(64)
  .regex(/^[A-Za-z][A-Za-z0-9_.-]*$/, 'Not a valid method name.');

/** `com.example.notes` → `com_example_notes`: the part of a registered tool name that identifies the plugin. */
export const pluginToolPrefix = (pluginId: string): string => pluginId.replace(/[.-]/g, '_');

/** The name under which a plugin's tool is offered to agents. */
export const registeredPluginToolName = (pluginId: string, tool: string): string =>
  `plugin_${pluginToolPrefix(pluginId)}_${tool}`;

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

const HOST_NAME = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * What a plugin can ask for. Nothing is implied: a plugin that requests no
 * permission can only compute, keep its own key-value storage and write its log.
 *
 * - `notifications` — create a notification for the user a call is acting for.
 * - `projects:read` — list the projects the acting user can see and read files in them.
 * - `network:<host>` — https requests to exactly that public host name, made by
 *   the Studio on the plugin's behalf. The plugin never holds a socket.
 * - `network` — the plugin process keeps real network access: any address the
 *   server machine can reach, including services on the machine itself and the
 *   local network. Meant for the owner's own private tools.
 */
export const pluginPermissionSchema = z
  .string()
  .max(280)
  .refine(
    (value) =>
      value === 'notifications' ||
      value === 'projects:read' ||
      value === 'network' ||
      (value.startsWith('network:') && HOST_NAME.test(value.slice('network:'.length))),
    'Not a permission. Known: notifications, projects:read, network:<host name>, network.',
  );
export type PluginPermission = z.infer<typeof pluginPermissionSchema>;

export type PluginPermissionKind = 'notifications' | 'projects:read' | 'network-host' | 'network-raw';

export interface PluginPermissionInfo {
  readonly permission: PluginPermission;
  readonly kind: PluginPermissionKind;
  /** For `network:<host>`. */
  readonly host?: string;
  /**
   * `low`: cannot reach anything outside the Studio. `medium`: sends data to one
   * named host, or shows things to a user. `high`: reads project files, or has
   * unrestricted network access.
   */
  readonly risk: 'low' | 'medium' | 'high';
}

/** Takes a permission apart for display. The wording itself belongs to the client. */
export function describePluginPermission(permission: PluginPermission): PluginPermissionInfo {
  if (permission === 'notifications') return { permission, kind: 'notifications', risk: 'low' };
  if (permission === 'projects:read') return { permission, kind: 'projects:read', risk: 'high' };
  if (permission === 'network') return { permission, kind: 'network-raw', risk: 'high' };
  return { permission, kind: 'network-host', host: permission.slice('network:'.length), risk: 'medium' };
}

// ---------------------------------------------------------------------------
// Tool input schemas
// ---------------------------------------------------------------------------

/**
 * The subset of JSON Schema a tool's input may use. It is deliberately small:
 * no `$ref`, no `pattern` (a plugin-supplied regular expression would run
 * inside the server), no combinators. Unknown keywords are rejected rather
 * than ignored, so a manifest never means more than the Studio enforces.
 */
export type PluginToolSchemaNode =
  | { type: 'string'; description?: string; enum?: string[]; minLength?: number; maxLength?: number }
  | { type: 'number' | 'integer'; description?: string; minimum?: number; maximum?: number }
  | { type: 'boolean'; description?: string }
  | { type: 'array'; description?: string; items: PluginToolSchemaNode; minItems?: number; maxItems?: number }
  | {
      type: 'object';
      description?: string;
      properties?: Record<string, PluginToolSchemaNode>;
      required?: string[];
      additionalProperties?: boolean;
    };

const RESERVED_KEYS = ['__proto__', 'constructor', 'prototype'];

/**
 * The first key anywhere in a JSON value that means something to JavaScript
 * objects themselves. Looked for in the raw input, because a validator may
 * drop such a key quietly — and nothing in a manifest is dropped quietly.
 */
function findReservedKey(value: unknown, depth = 0): string | null {
  if (depth > 16 || value === null || typeof value !== 'object') return null;
  for (const key of Object.keys(value)) {
    if (RESERVED_KEYS.includes(key)) return key;
    const found = findReservedKey((value as Record<string, unknown>)[key], depth + 1);
    if (found) return found;
  }
  return null;
}

const withoutReservedKeys = z.unknown().superRefine((value, context) => {
  const key = findReservedKey(value);
  if (key) context.addIssue({ code: 'custom', message: `"${key}" cannot be used as a key.` });
});

const schemaText = z.string().max(500);
const propertyName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z_][A-Za-z0-9_-]*$/, 'Not a valid property name.')
  // Names that mean something to JavaScript objects themselves are not property names here.
  .refine((name) => !['__proto__', 'constructor', 'prototype'].includes(name), 'That property name is reserved.');

const toolSchemaNode: z.ZodType<PluginToolSchemaNode> = z.lazy(() =>
  z.union([
    z.strictObject({
      type: z.literal('string'),
      description: schemaText.optional(),
      enum: z.array(z.string().max(200)).min(1).max(64).optional(),
      minLength: z.number().int().min(0).max(1_000_000).optional(),
      maxLength: z.number().int().min(0).max(1_000_000).optional(),
    }),
    z.strictObject({
      type: z.enum(['number', 'integer']),
      description: schemaText.optional(),
      minimum: z.number().optional(),
      maximum: z.number().optional(),
    }),
    z.strictObject({ type: z.literal('boolean'), description: schemaText.optional() }),
    z.strictObject({
      type: z.literal('array'),
      description: schemaText.optional(),
      items: toolSchemaNode,
      minItems: z.number().int().min(0).max(10_000).optional(),
      maxItems: z.number().int().min(0).max(10_000).optional(),
    }),
    z.strictObject({
      type: z.literal('object'),
      description: schemaText.optional(),
      properties: z.record(propertyName, toolSchemaNode).optional(),
      required: z.array(propertyName).max(64).optional(),
      additionalProperties: z.boolean().optional(),
    }),
  ]),
);

const MAX_SCHEMA_DEPTH = 6;
const MAX_SCHEMA_NODES = 200;

function measureSchema(node: PluginToolSchemaNode, depth: number, count: { nodes: number; deepest: number }): void {
  count.nodes += 1;
  count.deepest = Math.max(count.deepest, depth);
  if (node.type === 'array') measureSchema(node.items, depth + 1, count);
  if (node.type === 'object') {
    for (const child of Object.values(node.properties ?? {})) measureSchema(child, depth + 1, count);
  }
}

/** A tool's input: always an object at the top, at most six levels deep. */
const checkedToolSchema = toolSchemaNode.superRefine((node, context) => {
  if (node.type !== 'object') {
    context.addIssue({ code: 'custom', message: 'A tool input schema must be an object at the top level.' });
    return;
  }
  const count = { nodes: 0, deepest: 0 };
  measureSchema(node, 1, count);
  if (count.deepest > MAX_SCHEMA_DEPTH) context.addIssue({ code: 'custom', message: 'The input schema is nested too deeply.' });
  if (count.nodes > MAX_SCHEMA_NODES) context.addIssue({ code: 'custom', message: 'The input schema is too large.' });
  const checkRequired = (current: PluginToolSchemaNode): void => {
    if (current.type === 'array') checkRequired(current.items);
    if (current.type !== 'object') return;

    for (const name of current.required ?? []) {
      if (!current.properties || !Object.hasOwn(current.properties, name)) {
        context.addIssue({ code: 'custom', message: `"${name}" is required but not described.` });
      }
    }
    for (const child of Object.values(current.properties ?? {})) checkRequired(child);
  };
  checkRequired(node);
});
export const pluginToolInputSchema = withoutReservedKeys.pipe(checkedToolSchema);

// ---------------------------------------------------------------------------
// Manifest (plugin.json)
// ---------------------------------------------------------------------------

export const PLUGIN_MANIFEST_FILE = 'plugin.json';

// eslint-disable-next-line no-control-regex
const NO_CONTROL = /^[^\u0000-\u001f\u007f\u2028\u2029]*$/;
const line = (max: number) => z.string().max(max).regex(NO_CONTROL, 'Control characters are not allowed.');
const SEMVER = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,32})?(?:\+[0-9A-Za-z.-]{1,32})?$/;
const versionSchema = z.string().max(80).regex(SEMVER, 'Use a version like 1.2.3.');

/**
 * A path inside the plugin folder: forward slashes, no leading slash, no
 * segment that starts with a dot (so no `..`, no hidden files), nothing but
 * letters, digits, dots, hyphens and underscores.
 */
export const pluginRelativePathSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/, 'Use a relative path inside the plugin folder.');

/**
 * An https address as shown to and opened by a person: a host name, an
 * optional port and path. No user name or password, no backslashes, no spaces.
 */
const HTTPS_URL = /^https:\/\/[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(?::\d{1,5})?(?:[/?#][^\s\\]*)?$/;
export const pluginHttpsUrlSchema = z
  .string()
  .max(500)
  .regex(NO_CONTROL, 'Control characters are not allowed.')
  .regex(HTTPS_URL, 'Use an https:// address without a user name or password.');

/** The name of an icon from the Studio's own set. A plugin never supplies image files for the Studio's page. */
export const pluginIconNameSchema = z.string().max(40).regex(/^[a-z][a-z0-9-]*$/, 'Use the name of a built-in icon.');

export const pluginToolEffectSchema = z.enum(['read', 'write']);
export type PluginToolEffect = z.infer<typeof pluginToolEffectSchema>;

export const pluginToolManifestSchema = z.strictObject({
  name: pluginToolNameSchema,
  /** Shown to the model, prefixed by the Studio with the plugin's name. */
  description: z.string().min(1).max(1000).regex(NO_CONTROL),
  /**
   * `read`: only returns information. `write`: changes something, so each call
   * goes through the run's permission mode. The Studio raises `read` to `write`
   * by itself for a plugin that can reach the network or notify people.
   */
  effect: pluginToolEffectSchema,
  inputSchema: pluginToolInputSchema,
});
export type PluginToolManifest = z.infer<typeof pluginToolManifestSchema>;

/** Where a panel may appear. */
export const pluginPanelSlotSchema = z.enum(['home-tile', 'project-tab', 'settings-page']);
export type PluginPanelSlot = z.infer<typeof pluginPanelSlotSchema>;

export const pluginPanelManifestSchema = z.strictObject({
  id: pluginPanelIdSchema,
  title: line(40).min(1),
  icon: pluginIconNameSchema.default('puzzle'),
  /** The panel's page. Everything it loads must sit in the same folder or below it. */
  entry: pluginRelativePathSchema.refine((value) => value.endsWith('.html'), 'A panel entry must be an .html file.'),
  slots: z
    .array(pluginPanelSlotSchema)
    .min(1)
    .max(3)
    .refine((slots) => new Set(slots).size === slots.length, 'A slot is listed twice.'),
});
export type PluginPanelManifest = z.infer<typeof pluginPanelManifestSchema>;

/**
 * Events a plugin may ask to be told about. Payloads carry identifiers only —
 * never names, paths, message text or anything about a person.
 */
export const PLUGIN_HOOK_EVENTS = ['project.created', 'project.deleted', 'run.started', 'run.finished'] as const;
export const pluginHookEventSchema = z.enum(PLUGIN_HOOK_EVENTS);
export type PluginHookEvent = z.infer<typeof pluginHookEventSchema>;

export const pluginHookPayloadSchemas = {
  'project.created': z.object({ projectId: idSchema }),
  'project.deleted': z.object({ projectId: idSchema }),
  'run.started': z.object({ runId: idSchema, sessionId: idSchema, projectId: idSchema.nullable(), agentId: z.string().max(64) }),
  'run.finished': z.object({
    runId: idSchema,
    sessionId: idSchema,
    projectId: idSchema.nullable(),
    agentId: z.string().max(64),
    status: z.string().max(32),
  }),
} as const satisfies Record<PluginHookEvent, z.ZodType>;
export type PluginHookPayload<E extends PluginHookEvent = PluginHookEvent> = z.infer<(typeof pluginHookPayloadSchemas)[E]>;

/** A home tile that opens an external address in a new tab. The owner reviews it with the permissions. */
export const pluginLinkTileManifestSchema = z.strictObject({
  id: pluginPanelIdSchema,
  title: line(40).min(1),
  icon: pluginIconNameSchema.default('link'),
  url: pluginHttpsUrlSchema,
});
export type PluginLinkTileManifest = z.infer<typeof pluginLinkTileManifestSchema>;

const unique = <T>(items: readonly T[], key: (item: T) => string): boolean => new Set(items.map(key)).size === items.length;

const manifestObjectSchema = z
  .strictObject({
    manifestVersion: z.literal(1),
    id: pluginIdSchema,
    name: line(60).min(1),
    version: versionSchema,
    description: line(500).default(''),
    author: line(120).default(''),
    /** An SPDX identifier or a short phrase, e.g. `MIT`. */
    license: z.string().max(60).regex(/^[A-Za-z0-9 .()+-]*$/, 'Use an SPDX licence identifier.').default(''),
    homepage: pluginHttpsUrlSchema.optional(),
    /** The oldest Studio version the plugin works with. */
    minStudioVersion: versionSchema.optional(),
    /** Server-side code: one ES module, started in its own isolated process when first needed. */
    server: z
      .strictObject({
        entry: pluginRelativePathSchema.refine((value) => /\.m?js$/.test(value), 'The server entry must be a .js or .mjs file.'),
      })
      .optional(),
    permissions: z
      .array(pluginPermissionSchema)
      .max(PLUGIN_LIMITS.maxPermissions)
      .default([])
      .refine((list) => new Set(list).size === list.length, 'A permission is listed twice.'),
    contributes: z
      .strictObject({
        tools: z.array(pluginToolManifestSchema).max(PLUGIN_LIMITS.maxTools).default([]),
        panels: z.array(pluginPanelManifestSchema).max(PLUGIN_LIMITS.maxPanels).default([]),
        hooks: z
          .array(pluginHookEventSchema)
          .max(PLUGIN_HOOK_EVENTS.length)
          .default([])
          .refine((list) => new Set(list).size === list.length, 'A hook is listed twice.'),
        linkTiles: z.array(pluginLinkTileManifestSchema).max(PLUGIN_LIMITS.maxLinkTiles).default([]),
      })
      .default({ tools: [], panels: [], hooks: [], linkTiles: [] }),
  })
  .superRefine((manifest, context) => {
    const { tools, panels, hooks, linkTiles } = manifest.contributes;
    const problem = (message: string, path: (string | number)[]) => context.addIssue({ code: 'custom', message, path });
    if (!unique(tools, (tool) => tool.name)) problem('Two tools share a name.', ['contributes', 'tools']);
    if (!unique(panels, (panel) => panel.id)) problem('Two panels share an id.', ['contributes', 'panels']);
    if (!unique(linkTiles, (tile) => tile.id)) problem('Two link tiles share an id.', ['contributes', 'linkTiles']);
    if (!manifest.server) {
      if (tools.length > 0) problem('Tools need server code: add "server".', ['contributes', 'tools']);
      if (hooks.length > 0) problem('Hooks need server code: add "server".', ['contributes', 'hooks']);
      if (manifest.permissions.length > 0) problem('Permissions are only used by server code: add "server".', ['permissions']);
    }
    tools.forEach((tool, index) => {
      if (registeredPluginToolName(manifest.id, tool.name).length > PLUGIN_LIMITS.maxRegisteredToolName) {
        problem('The plugin id and tool name are too long together.', ['contributes', 'tools', index, 'name']);
      }
    });
  });
/** The schema of `plugin.json`. Strict throughout: a key it does not know is an error. */
export const pluginManifestSchema = withoutReservedKeys.pipe(manifestObjectSchema);
export type PluginManifest = z.infer<typeof pluginManifestSchema>;

// ---------------------------------------------------------------------------
// Isolation
// ---------------------------------------------------------------------------

/**
 * How well plugin processes are contained on this machine.
 *
 * - `sandboxed`: bubblewrap gives the process an empty file system holding only
 *   its own code (read-only) and its data folder, no network, no view of other
 *   processes; Node's permission model restricts it again from the inside.
 * - `restricted`: only Node's permission model. Files outside the plugin's two
 *   folders, child processes, worker threads and native add-ons are refused by
 *   the runtime, but the network is not, and Node itself does not promise that
 *   this holds against code written to break out.
 * - `none`: nothing. Plugins with server code cannot be enabled unless the
 *   operator has explicitly allowed running them unsandboxed.
 */
export const pluginIsolationLevelSchema = z.enum(['sandboxed', 'restricted', 'none']);
export type PluginIsolationLevel = z.infer<typeof pluginIsolationLevelSchema>;

export const pluginIsolationSchema = z.object({
  level: pluginIsolationLevelSchema,
  bubblewrap: z.boolean(),
  nodePermissions: z.boolean(),
  /** What a plugin process is actually kept from, so the client need not guess from the level. */
  restricts: z.object({
    /** Files outside its code and data folders. */
    files: z.boolean(),
    /** Starting other programs. */
    processes: z.boolean(),
    /** Opening network connections (without the `network` permission). */
    network: z.boolean(),
    /** Seeing or signalling other processes of the server's account. */
    otherProcesses: z.boolean(),
  }),
  /** The operator's "run plugins unsandboxed" switch. */
  unsandboxedAllowed: z.boolean(),
  /** One or two plain sentences for the owner. */
  detail: z.string(),
});
export type PluginIsolation = z.infer<typeof pluginIsolationSchema>;

// ---------------------------------------------------------------------------
// Management API
// ---------------------------------------------------------------------------

/**
 * - `stopped`: not running (disabled, or enabled and waiting for its first call).
 * - `running`: its process is up.
 * - `crashed`: its process failed; `statusDetail` says how. After repeated
 *   failures the plugin is disabled as well.
 * - `needs-approval`: never approved, or what was approved is no longer what is
 *   installed (`approval.reasons`).
 * - `blocked-no-sandbox`: enabled, but this machine cannot isolate it as well
 *   as when it was approved.
 */
export const pluginStatusSchema = z.enum(['stopped', 'running', 'crashed', 'needs-approval', 'blocked-no-sandbox']);
export type PluginStatus = z.infer<typeof pluginStatusSchema>;

export const pluginApprovalReasonSchema = z.enum(['permissions-changed', 'contributions-changed', 'content-changed']);
export type PluginApprovalReason = z.infer<typeof pluginApprovalReasonSchema>;

export const pluginSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('git'), url: z.string(), ref: z.string().nullable(), commit: z.string().nullable() }),
  z.object({ kind: z.literal('directory'), name: z.string() }),
]);
export type PluginSource = z.infer<typeof pluginSourceSchema>;

export const pluginToolSummarySchema = z.object({
  name: pluginToolNameSchema,
  /** The name agents see. */
  registeredName: z.string(),
  description: z.string(),
  declaredEffect: pluginToolEffectSchema,
  /** What the permission engine is told; `write` whenever the granted permissions make `read` unprovable. */
  effect: pluginToolEffectSchema,
});

export const pluginSummarySchema = z.object({
  id: pluginIdSchema,
  name: z.string(),
  version: z.string(),
  description: z.string(),
  author: z.string(),
  license: z.string(),
  homepage: z.string().nullable(),
  source: pluginSourceSchema,
  hasServer: z.boolean(),
  enabled: z.boolean(),
  status: pluginStatusSchema,
  /** A sentence explaining the status when it needs one, e.g. why the process failed. */
  statusDetail: z.string().nullable(),
  /** Identifies exactly the installed files; echo it when approving so the approval covers what was reviewed. */
  contentHash: z.string(),
  approval: z.object({
    /** `none`: never approved. `current`: approved as installed. `stale`: changed since. */
    state: z.enum(['none', 'current', 'stale']),
    reasons: z.array(pluginApprovalReasonSchema),
    approvedAt: timestampSchema.nullable(),
    approvedBy: idSchema.nullable(),
    /** The isolation level in force when it was approved. */
    isolation: pluginIsolationLevelSchema.nullable(),
  }),
  permissions: z.object({
    requested: z.array(pluginPermissionSchema),
    granted: z.array(pluginPermissionSchema),
  }),
  contributes: z.object({
    tools: z.array(pluginToolSummarySchema),
    panels: z.array(pluginPanelManifestSchema),
    hooks: z.array(pluginHookEventSchema),
    linkTiles: z.array(pluginLinkTileManifestSchema),
  }),
  /** Data of an earlier installation with the same id was kept and is visible to this one. */
  retainedData: z.boolean(),
  /** The last lines the process wrote to its log and error output, secrets redacted. */
  logTail: z.array(z.string()),
  installedAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type PluginSummary = z.infer<typeof pluginSummarySchema>;

export const pluginListSchema = z.object({
  plugins: z.array(pluginSummarySchema),
  isolation: pluginIsolationSchema,
  /** Whether the operator configured a folder to install from by name. */
  sourceDirectoryConfigured: z.boolean(),
});
export type PluginList = z.infer<typeof pluginListSchema>;

/** A folder in the operator's plugin source directory. */
export const pluginSourceEntrySchema = z.object({
  name: z.string(),
  valid: z.boolean(),
  /** Why it cannot be installed, when it cannot. */
  problem: z.string().nullable(),
  id: z.string().nullable(),
  title: z.string().nullable(),
  version: z.string().nullable(),
  description: z.string().nullable(),
  installed: z.boolean(),
});
export type PluginSourceEntry = z.infer<typeof pluginSourceEntrySchema>;

export const pluginSourceListSchema = z.object({ configured: z.boolean(), entries: z.array(pluginSourceEntrySchema) });
export type PluginSourceList = z.infer<typeof pluginSourceListSchema>;

/** A branch or tag name: no leading dash, no `..`, nothing a shell or Git would treat specially. */
export const pluginGitRefSchema = z
  .string()
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, 'Not a valid branch or tag name.')
  .refine((ref) => !ref.includes('..') && !ref.includes('//') && !ref.endsWith('/') && !ref.endsWith('.lock'), 'Not a valid branch or tag name.');

export const installPluginRequestSchema = z.strictObject({
  source: z.discriminatedUnion('kind', [
    /** A folder directly inside the operator's plugin source directory. */
    z.strictObject({ kind: z.literal('directory'), name: z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/) }),
    /** A public https Git address. Never ssh, never http, never with credentials. */
    z.strictObject({ kind: z.literal('git'), url: z.string().min(1).max(500), ref: pluginGitRefSchema.optional() }),
  ]),
});
export type InstallPluginRequest = z.infer<typeof installPluginRequestSchema>;

/**
 * The owner's approval. It names what was reviewed: the permissions granted
 * (any subset of those requested), the content hash of the files, and the
 * isolation level shown at the time. If any of them no longer matches, the
 * server answers 409 and the client shows the plugin again.
 */
export const enablePluginRequestSchema = z.strictObject({
  permissions: z.array(pluginPermissionSchema).max(PLUGIN_LIMITS.maxPermissions),
  contentHash: z.string().max(100),
  isolation: pluginIsolationLevelSchema,
});
export type EnablePluginRequest = z.infer<typeof enablePluginRequestSchema>;

export const uninstallPluginRequestSchema = z.strictObject({
  /** Also remove what the plugin stored. When false the data stays and a later plugin with the same id sees it. */
  deleteData: z.boolean().default(false),
});
export type UninstallPluginRequest = z.infer<typeof uninstallPluginRequestSchema>;

// ---------------------------------------------------------------------------
// Contributions (for every signed-in user)
// ---------------------------------------------------------------------------

export const pluginPanelContributionSchema = z.object({
  pluginId: pluginIdSchema,
  pluginName: z.string(),
  panelId: pluginPanelIdSchema,
  title: z.string(),
  icon: z.string(),
});
export type PluginPanelContribution = z.infer<typeof pluginPanelContributionSchema>;

export const pluginLinkTileContributionSchema = z.object({
  pluginId: pluginIdSchema,
  pluginName: z.string(),
  id: pluginPanelIdSchema,
  title: z.string(),
  icon: z.string(),
  url: z.string(),
});
export type PluginLinkTileContribution = z.infer<typeof pluginLinkTileContributionSchema>;

/** What enabled plugins add to the interface. Settings pages are listed for the owner only. */
export const pluginContributionsSchema = z.object({
  homeTiles: z.array(pluginPanelContributionSchema),
  projectTabs: z.array(pluginPanelContributionSchema),
  settingsPages: z.array(pluginPanelContributionSchema),
  linkTiles: z.array(pluginLinkTileContributionSchema),
});
export type PluginContributions = z.infer<typeof pluginContributionsSchema>;

// ---------------------------------------------------------------------------
// Panels: opening and calling
// ---------------------------------------------------------------------------

/** The exact `sandbox` attribute of a panel frame. Never add `allow-same-origin`. */
export const PLUGIN_PANEL_SANDBOX = 'allow-scripts allow-forms';

export const openPluginPanelRequestSchema = z.strictObject({
  slot: pluginPanelSlotSchema,
  /** Required for `project-tab`, forbidden otherwise. */
  projectId: idSchema.optional(),
});
export type OpenPluginPanelRequest = z.infer<typeof openPluginPanelRequestSchema>;

export const pluginPanelGrantSchema = z.object({
  /** Identifies this open panel in {@link pluginPanelRpcRequestSchema}. Valid until `expiresAt`, sign-out or disable. */
  panel: z.string(),
  /** Same-origin path to put in the frame's `src`. */
  url: z.string(),
  expiresAt: timestampSchema,
  sandbox: z.literal(PLUGIN_PANEL_SANDBOX),
  pluginId: pluginIdSchema,
  panelId: pluginPanelIdSchema,
  slot: pluginPanelSlotSchema,
  projectId: idSchema.nullable(),
});
export type PluginPanelGrant = z.infer<typeof pluginPanelGrantSchema>;

export const pluginPanelRpcRequestSchema = z.strictObject({
  panel: z.string().min(20).max(200),
  method: pluginMethodNameSchema,
  params: z.unknown().optional(),
});
export type PluginPanelRpcRequest = z.infer<typeof pluginPanelRpcRequestSchema>;

export const panelErrorSchema = z.object({ code: z.string().max(64), message: z.string().max(500) });
export type PanelError = z.infer<typeof panelErrorSchema>;

/**
 * The answer to a panel call. A failure the plugin itself reports comes back
 * as `ok: false` with status 200, ready to be handed to the panel; a failure
 * of the call (not signed in, panel expired, plugin stopped, timed out) is an
 * ordinary API error.
 */
export const pluginPanelRpcResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), result: z.unknown() }),
  z.object({ ok: z.literal(false), error: panelErrorSchema }),
]);
export type PluginPanelRpcResponse = z.infer<typeof pluginPanelRpcResponseSchema>;

// ---------------------------------------------------------------------------
// Panel ↔ page message protocol
// ---------------------------------------------------------------------------

/**
 * ## How a panel talks to the Studio
 *
 * A panel is a page from the plugin's folder, shown by the web client in
 *
 *     <iframe sandbox="allow-scripts allow-forms" referrerpolicy="no-referrer" src="{grant.url}">
 *
 * The frame has an opaque origin: it has no cookies, no storage, cannot call
 * the API and — by the policy its files are served with — cannot connect to
 * anything. Its one channel is `window.postMessage` to the embedding page.
 *
 * ### The embedding page (web client) must
 *
 * 1. Obtain a grant with `POST /api/plugins/:id/panels/:panelId/open` and use
 *    its `url` and `sandbox` unchanged. Never add `allow-same-origin`,
 *    `allow-popups` or `allow-top-navigation`.
 * 2. Accept a message **only if** `event.source === frame.contentWindow` and
 *    `event.origin === 'null'` and it parses with
 *    {@link panelToHostMessageSchema}. Everything else is dropped silently —
 *    never answered, never logged with its content.
 * 3. Answer `ready` with `init`. Send `context` when theme, language or the
 *    project's name change.
 * 4. Relay `request` to `POST /api/plugins/:id/rpc` with
 *    `{ panel: grant.panel, method, params }` through the normal API client and
 *    post back one `response` with the same `id`, carrying the `ok` and
 *    `result` / `error` of the answer; when the call itself fails, answer
 *    `{ ok: false, error: { code, message } }` taken from the API error. Refuse
 *    (`ok: false`, code `too_large` / `too_many_requests`) without calling the
 *    server when the JSON text of the message exceeds
 *    `PLUGIN_LIMITS.maxPanelMessageBytes` or the panel already has
 *    `PLUGIN_LIMITS.maxPanelPendingRequests` requests in flight.
 * 5. Post to the frame with `frame.contentWindow.postMessage(message, '*')`.
 *    The target origin has to be `'*'` because an opaque origin cannot be
 *    named; therefore a message to a panel never contains a credential, a
 *    token, the grant, or anything about another user.
 * 6. Treat `resize` as a request, clamp it to the space the slot allows.
 * 7. Remove the frame when the panel closes. On an API error with code
 *    `panel_expired`, open the panel again (new grant, new frame).
 *
 * ### The panel must
 *
 * - accept a message only if `event.source === window.parent` and
 *   `event.origin === location.origin` (the address the page was loaded from),
 * - post with `window.parent.postMessage(message, location.origin)`.
 *
 * The SDK's `@agent-studio/plugin-sdk/panel` module does both.
 *
 * Every message is a plain JSON object with `channel` and `v` as below. Request
 * ids are chosen by the panel, unique among its requests in flight.
 */
export const PANEL_CHANNEL = 'agent-studio-panel';
export const PANEL_PROTOCOL_VERSION = 1;

const panelEnvelope = { channel: z.literal(PANEL_CHANNEL), v: z.literal(PANEL_PROTOCOL_VERSION) };
export const panelRequestIdSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);

export const panelContextSchema = z.object({
  pluginId: pluginIdSchema,
  panelId: pluginPanelIdSchema,
  slot: pluginPanelSlotSchema,
  theme: z.enum(['light', 'dark']),
  /** BCP 47 tag of the interface language, e.g. `en` or `zh-CN`. */
  locale: z.string().max(35),
  /** The project a `project-tab` panel was opened for. */
  project: z.object({ id: idSchema, name: z.string() }).nullable(),
  user: z.object({ displayName: z.string() }),
});
export type PanelContext = z.infer<typeof panelContextSchema>;

/** Messages a panel sends to the page embedding it. */
export const panelToHostMessageSchema = z.discriminatedUnion('type', [
  /** The panel's script is running and wants its context. May be sent again; answer each time. */
  z.strictObject({ ...panelEnvelope, type: z.literal('ready') }),
  /** Call a panel method of the plugin's server code. */
  z.strictObject({
    ...panelEnvelope,
    type: z.literal('request'),
    id: panelRequestIdSchema,
    method: pluginMethodNameSchema,
    params: z.unknown().optional(),
  }),
  /** The panel's content height in CSS pixels, for slots that size to content. */
  z.strictObject({ ...panelEnvelope, type: z.literal('resize'), height: z.number().int().min(0).max(20_000) }),
]);
export type PanelToHostMessage = z.infer<typeof panelToHostMessageSchema>;

/** Messages the embedding page sends to a panel. */
export const hostToPanelMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...panelEnvelope, type: z.literal('init'), context: panelContextSchema }),
  z.strictObject({ ...panelEnvelope, type: z.literal('context'), context: panelContextSchema }),
  z.strictObject({
    ...panelEnvelope,
    type: z.literal('response'),
    id: panelRequestIdSchema,
    ok: z.boolean(),
    /** Present when `ok`. */
    result: z.unknown().optional(),
    /** Present when not `ok`. */
    error: panelErrorSchema.optional(),
  }),
]);
export type HostToPanelMessage = z.infer<typeof hostToPanelMessageSchema>;

// ---------------------------------------------------------------------------
// Internal bus events other modules may listen to
// ---------------------------------------------------------------------------

/** Topic of events the plugins module publishes for other server modules. Never visible to browsers. */
export const PLUGINS_INTERNAL_TOPIC = 'internal:plugins';

/** A realtime topic every signed-in client may subscribe to; `plugins.changed` on it means: reload contributions. */
export const PLUGINS_TOPIC = 'system:plugins';
export const PLUGINS_CHANGED_EVENT = 'plugins.changed';

export const PLUGIN_BUS_EVENT = {
  /** A plugin asked to notify a user. The notifications module turns it into a notification. */
  notification: 'plugin.notification',
  /** Installed, enabled, disabled, updated or removed: clients should reload contributions. */
  changed: 'plugin.changed',
} as const;

export const pluginNotificationEventSchema = z.object({
  pluginId: pluginIdSchema,
  pluginName: z.string(),
  /** The user the plugin was acting for when it asked. */
  userId: idSchema,
  title: z.string().max(120),
  body: z.string().max(1000),
  /** The project the call was about, when there was one. */
  projectId: idSchema.nullable(),
});
export type PluginNotificationEvent = z.infer<typeof pluginNotificationEventSchema>;
