import { z } from 'zod';
import { idSchema, limitQuery, timestampSchema } from './common.js';
import { projectAccessSchema, projectIconSchema } from './projects.js';

/**
 * Shared memory: a long-lived store of Markdown notes that the user and every
 * assistant read and write.
 *
 * - A note is one Markdown file. Its **id** is the file's path inside the
 *   store without the `.md` extension, with forward slashes:
 *   `global/house-rules`, `my-app/decisions/deploy-rules`.
 * - The first path segment is the note's **folder**: `global`, or the folder
 *   of one project. What a caller may do is decided per folder.
 * - A folder the caller may not see answers exactly like one that does not
 *   exist (`memory_note_not_found` / `memory_folder_not_found`).
 */

/** The folder for knowledge that applies to every project. */
export const MEMORY_GLOBAL_FOLDER = 'global';

export const MEMORY_LIMITS = {
  /** Title length after runs of white space are collapsed. */
  titleChars: 120,
  /** Body length of a note saved from the app. */
  bodyChars: 64_000,
  /** Body length of a note written by an assistant. */
  agentBodyChars: 8_000,
  tags: 8,
  tagChars: 32,
  keywords: 12,
  keywordChars: 40,
  /** Notes in one top-level folder, sub-folders included. */
  notesPerFolder: 2_000,
  noteIdChars: 400,
  /** Levels of sub-folders below a top-level folder. */
  subfolderDepth: 4,
  queryChars: 200,
  listDefault: 40,
  listMax: 100,
  searchDefault: 40,
  searchMax: 40,
  /** A longer body is cut when read through the API; the file keeps everything. */
  readChars: 200_000,
  snippetChars: 240,
} as const;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * True when `value` is a relative, forward-slashed path whose every segment is
 * an ordinary name: no empty, `.` or `..` segments, nothing starting with a
 * dot, no backslashes, drive letters or control characters, no leading or
 * trailing slash or space. The server checks again; this is for early feedback.
 */
export function isSafeMemoryPath(value: string, minSegments = 1): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (CONTROL_CHARACTERS.test(value) || value.includes('\\')) return false;
  if (/^[a-zA-Z]:/.test(value)) return false;
  const segments = value.split('/');
  if (segments.length < minSegments) return false;
  return segments.every((segment) => segment.length > 0 && segment.trim() === segment && !segment.startsWith('.'));
}

/** `folder/…/name` — at least a folder and a name. */
export const memoryNoteIdSchema = z
  .string()
  .min(3)
  .max(MEMORY_LIMITS.noteIdChars)
  .refine((value) => isSafeMemoryPath(value, 2), 'Not a valid note id.');

/** A top-level folder (`my-app`) or a sub-folder inside one (`my-app/decisions`). */
export const memoryFolderPathSchema = z
  .string()
  .min(1)
  .max(300)
  .refine((value) => isSafeMemoryPath(value, 1), 'Not a valid folder.');

/** Runs of white space are collapsed first; slashes, backslashes and control characters are refused. */
export const memoryTitleSchema = z
  .string()
  .max(400)
  .transform((value) => value.replace(/\s+/g, ' ').trim())
  .pipe(
    z
      .string()
      .min(1, 'Give the note a title.')
      .max(MEMORY_LIMITS.titleChars, `Use at most ${MEMORY_LIMITS.titleChars} characters.`)
      .refine((value) => !/[/\\]/.test(value) && !CONTROL_CHARACTERS.test(value), 'A title cannot contain slashes or control characters.'),
  );

export const memoryBodySchema = z.string().min(1, 'A note needs some text.').max(MEMORY_LIMITS.bodyChars);

/** Loose on input — the server cleans tags and keywords up and keeps the first few. */
export const memoryTagsInputSchema = z.array(z.string().max(80)).max(40);
export const memoryKeywordsInputSchema = z.array(z.string().max(200)).max(40);

/**
 * Why a note appears to contain a credential. The value itself is never
 * reported anywhere.
 */
export const memoryCredentialKindSchema = z.enum([
  'private_key',
  'api_key',
  'access_token',
  'cloud_key',
  'signed_token',
  'bearer_token',
  'webhook',
  'url_password',
  'password',
  'secret_value',
  'random_string',
]);
export type MemoryCredentialKind = z.infer<typeof memoryCredentialKindSchema>;

/**
 * Why a file in the store could not be read as a note: the file system
 * refused, it is not UTF-8 text, or it is larger than the store indexes.
 * Such a file is still listed (under its file name) and can be deleted.
 */
export const memoryNoteProblemSchema = z.enum(['unreadable', 'not_text', 'too_large']);
export type MemoryNoteProblem = z.infer<typeof memoryNoteProblemSchema>;

export const memoryNoteSummarySchema = z.object({
  id: z.string(),
  /** Top-level folder: `global` or a project's folder. */
  folder: z.string(),
  /** The directory the note is in, e.g. `my-app/decisions`. */
  path: z.string(),
  title: z.string(),
  /** Who last wrote it: `user:<username>`, `claude-code`, `codex`, `api:<provider>`…; null when unknown. */
  author: z.string().nullable(),
  tags: z.array(z.string()),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  /** The note appears to contain a credential: it is never handed to an assistant. */
  credential: memoryCredentialKindSchema.nullable(),
  problem: memoryNoteProblemSchema.nullable(),
});
export type MemoryNoteSummary = z.infer<typeof memoryNoteSummarySchema>;

/** Half-open `[start, end)` ranges of UTF-16 offsets to emphasise. */
export const memoryHighlightsSchema = z.array(z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]));
export type MemoryHighlights = z.infer<typeof memoryHighlightsSchema>;

export const memorySearchHitSchema = memoryNoteSummarySchema.extend({
  titleHighlights: memoryHighlightsSchema,
  /** Plain text (Markdown markers removed) around the best match. */
  snippet: z.object({ text: z.string(), highlights: memoryHighlightsSchema }),
});
export type MemorySearchHit = z.infer<typeof memorySearchHitSchema>;

export const memoryNoteSchema = memoryNoteSummarySchema.extend({
  /** Markdown source without the metadata header and without the keyword line. Render it as untrusted text. */
  body: z.string(),
  /** True when the body was cut at `MEMORY_LIMITS.readChars`. */
  truncated: z.boolean(),
  /** Search words from the note's trailing keyword line. */
  keywords: z.array(z.string()),
  /** Fingerprint of the file. Send it back as `baseVersion` when saving. */
  version: z.string(),
  /** What the caller may do with this note. */
  access: projectAccessSchema,
});
export type MemoryNote = z.infer<typeof memoryNoteSchema>;

export const memoryFolderSchema = z.object({
  name: z.string(),
  /** `unassigned`: a folder on disk that belongs to no current project (the owner alone sees these). */
  kind: z.enum(['global', 'project', 'unassigned']),
  project: z.object({ id: idSchema, name: z.string(), icon: projectIconSchema, archived: z.boolean() }).nullable(),
  access: projectAccessSchema,
  /** Notes in the folder, sub-folders included. */
  count: z.number().int().nonnegative(),
});
export type MemoryFolder = z.infer<typeof memoryFolderSchema>;

// ---- requests ---------------------------------------------------------------

export const memoryListQuerySchema = z.object({
  folder: memoryFolderPathSchema.optional(),
  tag: z.string().min(1).max(80).optional(),
  limit: limitQuery(MEMORY_LIMITS.listDefault, MEMORY_LIMITS.listMax),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
export type MemoryListQuery = z.infer<typeof memoryListQuerySchema>;

export const memorySearchQuerySchema = z.object({
  /** An empty query answers with an empty list. */
  q: z.string().max(MEMORY_LIMITS.queryChars).default(''),
  folder: memoryFolderPathSchema.optional(),
  limit: limitQuery(MEMORY_LIMITS.searchDefault, MEMORY_LIMITS.searchMax),
});
export type MemorySearchQuery = z.infer<typeof memorySearchQuerySchema>;

export const memoryTagsQuerySchema = z.object({ folder: memoryFolderPathSchema.optional() });

export const memoryNoteQuerySchema = z.object({ id: memoryNoteIdSchema });

export const createMemoryNoteRequestSchema = z.object({
  /** Where to put it: a folder the caller can write, optionally with sub-folders (`my-app/decisions`). */
  folder: memoryFolderPathSchema,
  title: memoryTitleSchema,
  body: memoryBodySchema,
  tags: memoryTagsInputSchema.default([]),
  keywords: memoryKeywordsInputSchema.default([]),
});
export type CreateMemoryNoteRequest = z.infer<typeof createMemoryNoteRequestSchema>;

/**
 * Saves changes to a note. `baseVersion` is the `version` the editor loaded;
 * when the note has changed since (another device, an assistant, a hand edit)
 * the save is refused with `memory_note_changed` and nothing is written.
 * Changing the title renames the file, so the answer may carry a new id.
 */
export const updateMemoryNoteRequestSchema = z.object({
  id: memoryNoteIdSchema,
  baseVersion: z.string().min(8).max(64),
  title: memoryTitleSchema.optional(),
  body: memoryBodySchema.optional(),
  tags: memoryTagsInputSchema.optional(),
  keywords: memoryKeywordsInputSchema.optional(),
});
export type UpdateMemoryNoteRequest = z.infer<typeof updateMemoryNoteRequestSchema>;

/** Moves a note to another folder and/or gives it another title. */
export const moveMemoryNoteRequestSchema = z
  .object({
    id: memoryNoteIdSchema,
    folder: memoryFolderPathSchema.optional(),
    title: memoryTitleSchema.optional(),
    baseVersion: z.string().min(8).max(64).optional(),
  })
  .refine((value) => value.folder !== undefined || value.title !== undefined, 'Say where to move the note or what to call it.');
export type MoveMemoryNoteRequest = z.infer<typeof moveMemoryNoteRequestSchema>;

export const deleteMemoryNoteQuerySchema = z.object({
  id: memoryNoteIdSchema,
  /** When given, the note is deleted only if it still has this version. */
  version: z.string().min(8).max(64).optional(),
});

export const memorySettingsRequestSchema = z.object({
  /** Whether assistants may use memory at all. People's access is unaffected. */
  agentAccess: z.boolean(),
});

// ---- responses --------------------------------------------------------------

export const memoryFoldersResponseSchema = z.object({
  /** `global` first, then by name. */
  folders: z.array(memoryFolderSchema),
  /** Notes in all of these folders together. */
  total: z.number().int().nonnegative(),
});
export type MemoryFoldersResponse = z.infer<typeof memoryFoldersResponseSchema>;

export const memoryListResponseSchema = z.object({
  /** Newest update first. */
  notes: z.array(memoryNoteSummarySchema),
  /** Exact number of notes in the requested scope, not just the number returned. */
  total: z.number().int().nonnegative(),
});
export type MemoryListResponse = z.infer<typeof memoryListResponseSchema>;

export const memorySearchResponseSchema = z.object({
  query: z.string(),
  /** Best match first. */
  hits: z.array(memorySearchHitSchema),
  /** Notes that matched, which may be more than were returned. */
  total: z.number().int().nonnegative(),
  /** True when so many notes matched that only the best candidates were ranked. */
  capped: z.boolean(),
});
export type MemorySearchResponse = z.infer<typeof memorySearchResponseSchema>;

export const memoryTagsResponseSchema = z.object({
  tags: z.array(z.object({ tag: z.string(), count: z.number().int().positive() })),
});
export type MemoryTagsResponse = z.infer<typeof memoryTagsResponseSchema>;

export const memoryStatusSchema = z.object({
  /** False when the note files or their index cannot be read right now. */
  healthy: z.boolean(),
  problem: z.enum(['store_unreadable', 'index_error']).nullable(),
  /** Notes the caller can see. */
  notes: z.number().int().nonnegative(),
  folders: z.number().int().nonnegative(),
  /** Of those notes: withheld from assistants because they appear to contain a credential. */
  withheld: z.number().int().nonnegative(),
  /** Of those notes: files that could not be read as notes. */
  unreadable: z.number().int().nonnegative(),
  /** When the index was last brought in line with the files; null when it never was. */
  indexedAt: timestampSchema.nullable(),
  /** True when the index could not be checked against the files just now. */
  indexStale: z.boolean(),
  /** Whether assistants may use memory (the owner's switch). */
  agentAccess: z.boolean(),
  /** Where the note files live, shortened relative to the home directory. Owner only. */
  location: z.string().nullable(),
  /** Files in the store that are ignored because of their names or depth. Owner only. */
  skippedFiles: z.number().int().nonnegative().nullable(),
});
export type MemoryStatus = z.infer<typeof memoryStatusSchema>;

export const memoryReindexResponseSchema = z.object({
  notes: z.number().int().nonnegative(),
  unreadable: z.number().int().nonnegative(),
  skippedFiles: z.number().int().nonnegative(),
  tookMs: z.number().nonnegative(),
});
export type MemoryReindexResponse = z.infer<typeof memoryReindexResponseSchema>;

// ---- errors and events ------------------------------------------------------

/** Stable `error.code` values of the memory API, beyond the generic ones. */
export const MEMORY_ERRORS = {
  noteNotFound: 'memory_note_not_found',
  folderNotFound: 'memory_folder_not_found',
  readOnly: 'memory_read_only',
  /** A note with that title already exists there. `details.id` names it. */
  noteExists: 'memory_note_exists',
  /** The note changed since `baseVersion`. `details.currentVersion` is the new one. */
  noteChanged: 'memory_note_changed',
  /** The text looks like it contains a credential. `details.kind` says which kind; the value is never echoed. */
  credential: 'memory_credential',
  folderFull: 'memory_folder_full',
  /** The file cannot be read as a note, so it cannot be edited — only moved or deleted. */
  noteUnreadable: 'memory_note_unreadable',
  /** The note is longer than `MEMORY_LIMITS.readChars`: the app saw only its start, so it may not save its text. Title, tags and keywords can still be changed. */
  noteTooLong: 'memory_note_too_long_to_edit',
  invalidTitle: 'memory_invalid_title',
  invalidFolder: 'memory_invalid_folder',
  unavailable: 'memory_unavailable',
} as const;

/** Realtime topic for one top-level folder; subscribing needs read access to it. */
export const memoryTopic = (folder: string) => `memory:${folder}`;
export const MEMORY_CHANGED = 'memory.changed';
export const memoryChangedEventSchema = z.object({
  action: z.enum(['created', 'updated', 'moved', 'deleted', 'reindexed']),
  /** The note concerned; absent for `reindexed`. */
  id: z.string().optional(),
  /** For `moved`: where it was. */
  previousId: z.string().optional(),
});
export type MemoryChangedEvent = z.infer<typeof memoryChangedEventSchema>;
