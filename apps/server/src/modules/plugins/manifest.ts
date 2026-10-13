import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import {
  PLUGIN_LIMITS,
  PLUGIN_MANIFEST_FILE,
  pluginManifestSchema,
  type PluginManifest,
  type PluginToolSchemaNode,
} from '@agent-studio/protocol';
import { z, type ZodType } from 'zod';
import { sha256 } from '../../kernel/crypto.js';
import { unprocessable } from '../../kernel/errors.js';
import type { TreeFile } from './tree.js';

/** Turns the first few schema problems into a sentence a person can act on. */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : 'manifest'}: ${issue.message}`)
    .join('; ');
}

/** Validates the text of a `plugin.json`. Unknown keys are errors, not noise. */
export function parseManifest(text: string): PluginManifest {
  if (Buffer.byteLength(text, 'utf8') > PLUGIN_LIMITS.maxManifestBytes) {
    throw unprocessable(`${PLUGIN_MANIFEST_FILE} is too large.`, 'invalid_manifest');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw unprocessable(`${PLUGIN_MANIFEST_FILE} is not valid JSON.`, 'invalid_manifest');
  }
  const parsed = pluginManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw unprocessable(`${PLUGIN_MANIFEST_FILE} is not a valid manifest — ${describeIssues(parsed.error)}`, 'invalid_manifest', {
      issues: parsed.error.issues.slice(0, 20).map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    });
  }
  return parsed.data;
}

/** Reads and validates the manifest at the top of a plugin folder. */
export async function readManifest(directory: string): Promise<PluginManifest> {
  const file = path.join(directory, PLUGIN_MANIFEST_FILE);
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw unprocessable(`There is no ${PLUGIN_MANIFEST_FILE} at the top of that folder, so it is not a plugin.`, 'invalid_manifest');
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > PLUGIN_LIMITS.maxManifestBytes) {
      throw unprocessable(`${PLUGIN_MANIFEST_FILE} is not an ordinary file of a reasonable size.`, 'invalid_manifest');
    }
    return parseManifest(await handle.readFile('utf8'));
  } finally {
    await handle.close();
  }
}

/** Every file the manifest names must be among the plugin's files. */
export function checkManifestFiles(manifest: PluginManifest, files: readonly TreeFile[]): void {
  const present = new Set(files.map((file) => file.path));
  const missing = (what: string, file: string) =>
    unprocessable(`${PLUGIN_MANIFEST_FILE} names ${what} "${file}", but the plugin has no such file.`, 'invalid_manifest');
  if (manifest.server && !present.has(manifest.server.entry)) throw missing('the server entry', manifest.server.entry);
  for (const panel of manifest.contributes.panels) {
    if (!present.has(panel.entry)) throw missing(`the page of panel "${panel.id}"`, panel.entry);
  }
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, stable(child)]),
    );
  }
  return value;
}

/**
 * What the owner approves about a manifest: the permissions it asks for, and a
 * fingerprint of what it adds to the Studio (tools with their descriptions and
 * effects, panels, hooks, link tiles, whether it has server code). Name,
 * version, description and the like may change freely; anything here changing
 * means the approval no longer describes the plugin.
 */
export interface ApprovedSurface {
  readonly permissions: readonly string[];
  readonly contributions: string;
}

export function surfaceOf(manifest: PluginManifest): ApprovedSurface {
  return {
    permissions: [...manifest.permissions].sort(),
    contributions: sha256(
      JSON.stringify(
        stable({
          server: manifest.server !== undefined,
          tools: manifest.contributes.tools,
          panels: manifest.contributes.panels,
          hooks: [...manifest.contributes.hooks].sort(),
          linkTiles: manifest.contributes.linkTiles,
        }),
      ),
    ),
  };
}

/**
 * How a manifest differs from what was approved, in the owner's terms. Asking
 * for fewer permissions is not a difference that needs anyone's consent.
 */
export function surfaceChanges(approved: ApprovedSurface, current: PluginManifest): ('permissions-changed' | 'contributions-changed')[] {
  const reasons: ('permissions-changed' | 'contributions-changed')[] = [];
  const before = new Set(approved.permissions);
  if (current.permissions.some((permission) => !before.has(permission))) reasons.push('permissions-changed');
  if (surfaceOf(current).contributions !== approved.contributions) reasons.push('contributions-changed');
  return reasons;
}

/** Builds the validator for a tool's input from the manifest's schema. */
export function toolInputToZod(node: PluginToolSchemaNode): ZodType {
  const describe = <T extends ZodType>(schema: T): T => (node.description ? (schema.describe(node.description) as T) : schema);
  switch (node.type) {
    case 'string': {
      if (node.enum) return describe(z.enum(node.enum as [string, ...string[]]));
      let schema = z.string();
      if (node.minLength !== undefined) schema = schema.min(node.minLength);
      schema = schema.max(node.maxLength ?? 1_000_000);
      return describe(schema);
    }
    case 'number':
    case 'integer': {
      let schema = node.type === 'integer' ? z.number().int() : z.number();
      if (node.minimum !== undefined) schema = schema.min(node.minimum);
      if (node.maximum !== undefined) schema = schema.max(node.maximum);
      return describe(schema);
    }
    case 'boolean':
      return describe(z.boolean());
    case 'array': {
      let schema = z.array(toolInputToZod(node.items));
      if (node.minItems !== undefined) schema = schema.min(node.minItems);
      schema = schema.max(node.maxItems ?? 10_000);
      return describe(schema);
    }
    case 'object': {
      const required = new Set(node.required ?? []);
      // Built from entries, so that no property name can be mistaken for something else on the way.
      const shape: Record<string, ZodType> = Object.fromEntries(
        Object.entries(node.properties ?? {}).map(([name, child]) => {
          const schema = toolInputToZod(child);
          return [name, required.has(name) ? schema : schema.optional()];
        }),
      );
      // Unless a plugin says otherwise, input it did not describe is refused rather than passed on.
      return describe(node.additionalProperties === true ? z.looseObject(shape) : z.strictObject(shape));
    }
  }
}

/** Compares two versions of the form 1.2.3 (anything after "-" or "+" is ignored). */
export function compareVersions(a: string, b: string): number {
  const parts = (version: string) => version.split(/[-+]/)[0]!.split('.').map((part) => Number(part) || 0);
  const left = parts(a);
  const right = parts(b);
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}
