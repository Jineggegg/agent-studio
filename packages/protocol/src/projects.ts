import { z } from 'zod';
import { idSchema, timestampSchema } from './common.js';

export const projectAccessSchema = z.enum(['read', 'write']);
export type ProjectAccess = z.infer<typeof projectAccessSchema>;

export const projectIconSchema = z.object({
  /** Name of an icon from the client's icon set. */
  symbol: z.string().max(40).default('folder'),
  /** One of the client's named accent colours. */
  color: z.string().max(20).default('blue'),
});
export type ProjectIcon = z.infer<typeof projectIconSchema>;

// ---- links -------------------------------------------------------------------

export const MAX_PROJECT_LINKS = 8;

/** A named website that belongs to a project: its deployment, its docs, its repository. */
export const projectLinkSchema = z.object({
  /** Stable for as long as the link exists; survives edits of label and address. */
  id: z.string(),
  label: z.string(),
  /** Always http:// or https://, never with embedded credentials. */
  url: z.string(),
  /**
   * The owner declared this address to be a service on the Studio's own machine or
   * private network. Only such links are ever probed on a private address.
   */
  local: z.boolean(),
});
export type ProjectLink = z.infer<typeof projectLinkSchema>;

export const projectLinkInputSchema = z.object({
  /** Send the id of an existing link to keep it; omit it for a new link. */
  id: z.string().max(40).optional(),
  label: z.string().trim().min(1).max(40),
  url: z.string().trim().min(1).max(500),
  /** Only the owner may set this. */
  local: z.boolean().default(false),
});
export type ProjectLinkInput = z.infer<typeof projectLinkInputSchema>;

/**
 * What a reachability probe found. The server reports only that a site
 * answered, how, and how fast — never anything it said.
 */
export const projectLinkStatusSchema = z.object({
  linkId: z.string(),
  /**
   * `ok` answered below 400; `http_error` answered with 400 or above;
   * `unreachable` did not answer in time; `blocked` the address is one the
   * server will not contact for this link (a private address on a link that is
   * not marked local, a link-local address, too many redirects).
   */
  state: z.enum(['ok', 'http_error', 'unreachable', 'blocked']),
  status: z.number().int().nullable(),
  latencyMs: z.number().int().nonnegative().nullable(),
  /** Whether the site's headers allow it to be shown in a frame; null when it did not answer. */
  frameable: z.boolean().nullable(),
  checkedAt: timestampSchema,
});
export type ProjectLinkStatus = z.infer<typeof projectLinkStatusSchema>;

export const projectLinkStatusResponseSchema = z.object({ links: z.array(projectLinkStatusSchema) });

// ---- agents and feature switches ----------------------------------------------

/** Identifier of an agent adapter ("claude-code", "codex", …). */
export const agentIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, 'Not a valid agent id.');

export const PROJECT_FEATURES = ['assistant', 'automation', 'instructions'] as const;
export const projectFeatureSchema = z.enum(PROJECT_FEATURES);
export type ProjectFeature = z.infer<typeof projectFeatureSchema>;

export const projectFeaturesSchema = z.object({
  /** Agent conversations are offered in this project. */
  assistant: z.boolean(),
  /** Schedules and other unattended work are offered in this project. */
  automation: z.boolean(),
  /**
   * The project's own instruction file is handed to agents that would not
   * load it by themselves. Today that is `CLAUDE.md` in the project's root
   * folder, for Claude Code. On unless the owner switches it off.
   */
  instructions: z.boolean(),
});
export type ProjectFeatures = z.infer<typeof projectFeaturesSchema>;

export const DEFAULT_PROJECT_FEATURES: ProjectFeatures = { assistant: true, automation: false, instructions: true };

// ---- the project ---------------------------------------------------------------

export const projectSchema = z.object({
  id: idSchema,
  name: z.string(),
  description: z.string(),
  /** Absolute path of the working directory on the server. */
  rootDir: z.string(),
  icon: projectIconSchema,
  /** What the caller may do with this project. */
  access: projectAccessSchema,
  archived: z.boolean(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  links: z.array(projectLinkSchema),
  /** Agents offered in this project; null means every agent the Studio offers. */
  agents: z.array(agentIdSchema).nullable(),
  features: projectFeaturesSchema,
  /** The default workspace for conversations started outside any project. */
  scratch: z.boolean(),
  /** Pinned by the caller. The order of pins comes from the pins endpoint. */
  pinned: z.boolean(),
  /** When the caller last opened this project, on any device. */
  lastOpenedAt: timestampSchema.nullable(),
});
export type Project = z.infer<typeof projectSchema>;

export const projectNameSchema = z.string().trim().min(1).max(80);

const projectAgentsInput = z.array(agentIdSchema).max(20).nullable();

export const createProjectRequestSchema = z.object({
  name: projectNameSchema,
  /** Absolute path, or a path starting with "~/". Must lie inside an allowed workspace root. */
  rootDir: z.string().min(1).max(1024),
  description: z.string().max(500).default(''),
  icon: projectIconSchema.optional(),
  /** Create the directory (and missing parents) when it does not exist yet. */
  createDirectory: z.boolean().default(false),
  links: z.array(projectLinkInputSchema).max(MAX_PROJECT_LINKS).optional(),
  agents: projectAgentsInput.optional(),
  features: projectFeaturesSchema.partial().optional(),
});
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;

export const updateProjectRequestSchema = z
  .object({
    name: projectNameSchema,
    description: z.string().max(500),
    icon: projectIconSchema,
    archived: z.boolean(),
    /** Replaces the whole list. */
    links: z.array(projectLinkInputSchema).max(MAX_PROJECT_LINKS),
    /** null offers every agent again. */
    agents: projectAgentsInput,
    features: projectFeaturesSchema.partial(),
  })
  .partial();
export type UpdateProjectRequest = z.infer<typeof updateProjectRequestSchema>;

export const projectMemberSchema = z.object({
  userId: idSchema,
  username: z.string(),
  displayName: z.string(),
  access: projectAccessSchema,
});
export type ProjectMember = z.infer<typeof projectMemberSchema>;

export const setProjectMemberRequestSchema = z.object({ access: projectAccessSchema });

export const projectTopic = (projectId: string) => `project:${projectId}`;

/** Published on a project's topic when its record changes, and on a user's topic when their access does. */
export const PROJECT_CHANGED = 'project.changed';

// ---- pins and recents ------------------------------------------------------------

export const MAX_PROJECT_PINS = 50;

/** The caller's pinned projects, first pin first. Pins follow the account to every device. */
export const projectPinsSchema = z.object({
  projectIds: z
    .array(idSchema)
    .max(MAX_PROJECT_PINS)
    .refine((ids) => new Set(ids).size === ids.length, 'A project can be pinned only once.'),
});
export type ProjectPins = z.infer<typeof projectPinsSchema>;

/** Published on the user's topic with the new {@link ProjectPins}. */
export const PROJECT_PINS_CHANGED = 'projects.pins.changed';

/** Published on the user's topic with `{ projectId, lastOpenedAt }` so other devices reorder "recent". */
export const PROJECT_OPENED = 'project.opened';

// ---- choosing a folder -----------------------------------------------------------

export const folderEntrySchema = z.object({
  name: z.string(),
  /** Absolute path, usable as `rootDir` or as the next `path` to browse. */
  path: z.string(),
  /** The project that already lives in this folder, when the caller can see it. */
  projectId: idSchema.nullable(),
});
export type FolderEntry = z.infer<typeof folderEntrySchema>;

export const folderListingSchema = z.object({
  /** The folder that was listed; null when the answer is the list of workspace roots. */
  path: z.string().nullable(),
  /** The folder above, when it is still inside a workspace root. */
  parent: z.string().nullable(),
  /** Whether `path` itself may become a project. */
  selectable: z.boolean(),
  roots: z.array(folderEntrySchema),
  entries: z.array(folderEntrySchema),
  truncated: z.boolean(),
});
export type FolderListing = z.infer<typeof folderListingSchema>;

export const browseFoldersQuerySchema = z.object({ path: z.string().max(1024).optional() });

// ---- creating a project by cloning ---------------------------------------------------

export const cloneProjectRequestSchema = z.object({
  /** `https://host/owner/repo(.git)`, `ssh://[user@]host[:port]/path` or `user@host:path`. Never with a password or token inside. */
  url: z.string().trim().min(1).max(500),
  /** Existing or new folder inside a workspace root. Defaults to the first workspace root. */
  parentDir: z.string().max(1024).optional(),
  /** Folder name for the clone. Defaults to the repository's name. */
  directoryName: z.string().max(100).optional(),
  /** Display name of the project. Defaults to the folder name. */
  name: projectNameSchema.optional(),
});
export type CloneProjectRequest = z.infer<typeof cloneProjectRequestSchema>;

export const cloneJobSchema = z.object({
  id: idSchema,
  /** The address as given, safe to show. */
  url: z.string(),
  targetDir: z.string(),
  state: z.enum(['running', 'done', 'failed', 'cancelled']),
  /** What git says it is doing: "Receiving objects", "Resolving deltas", … */
  phase: z.string(),
  percent: z.number().int().min(0).max(100).nullable(),
  startedAt: timestampSchema,
  finishedAt: timestampSchema.nullable(),
  /** Present when `state` is `done`. */
  project: projectSchema.nullable(),
  /** Present when `state` is `failed`. */
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
});
export type CloneJob = z.infer<typeof cloneJobSchema>;

/** Published on the user's topic with the current {@link CloneJob} while a clone runs and when it ends. */
export const PROJECT_CLONE_UPDATED = 'project.clone.updated';
