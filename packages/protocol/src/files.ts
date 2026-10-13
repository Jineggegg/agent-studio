import { z } from 'zod';
import { idSchema, timestampSchema } from './common.js';

/**
 * Wire contracts for the "files" feature.
 *
 * Every file is addressed by a project id and a path relative to the
 * project's folder, written with forward slashes. The empty string (or ".")
 * is the project folder itself. Absolute paths and paths that climb out of the
 * project are refused, for reading as much as for writing.
 */

/** A project-relative path. */
export const filePathSchema = z
  .string()
  .max(4096)
  .refine((value) => !value.includes('\0'), 'That path is not valid.');

/** What the server enforces by default. `GET /api/files/limits` reports the values actually in force. */
export const FILE_LIMITS = {
  /** Largest file the text endpoints open or save. */
  maxTextBytes: 5 * 1024 * 1024,
  /** Entries returned by one directory listing. */
  maxListEntries: 5000,
  /** Depth of a whole-tree read. */
  maxTreeDepth: 10,
  /** Entries in a whole-tree read. */
  maxTreeEntries: 10_000,
  maxUploadFiles: 100,
  maxUploadFileBytes: 200 * 1024 * 1024,
  maxUploadTotalBytes: 500 * 1024 * 1024,
  maxArchiveEntries: 10_000,
  maxArchiveBytes: 1024 * 1024 * 1024,
  maxSearchResults: 50,
  maxContentMatches: 500,
} as const;

export const fileLimitsSchema = z.object({
  maxTextBytes: z.number().int(),
  maxListEntries: z.number().int(),
  maxTreeDepth: z.number().int(),
  maxTreeEntries: z.number().int(),
  maxUploadFiles: z.number().int(),
  maxUploadFileBytes: z.number().int(),
  maxUploadTotalBytes: z.number().int(),
  maxArchiveEntries: z.number().int(),
  maxArchiveBytes: z.number().int(),
  maxSearchResults: z.number().int(),
  maxContentMatches: z.number().int(),
});
export type FileLimits = z.infer<typeof fileLimitsSchema>;

// ---- listing -------------------------------------------------------------------

export const fileKindSchema = z.enum(['file', 'directory', 'symlink']);
export type FileKind = z.infer<typeof fileKindSchema>;

export const fileEntrySchema = z.object({
  name: z.string(),
  /** Project-relative, forward slashes. */
  path: z.string(),
  /** A symbolic link is always reported as `symlink`, never as what it points to. */
  kind: fileKindSchema,
  /** Bytes; 0 for directories. */
  size: z.number().nonnegative(),
  modifiedAt: timestampSchema,
  /** Permission bits, e.g. 0o644 → 420. */
  mode: z.number().int().nonnegative(),
  /** Matched by the project's ignore rules. Only present in listings that include ignored entries. */
  ignored: z.boolean(),
  /**
   * For symbolic links: what the link leads to. `outside` links point out of the
   * project and cannot be opened; `missing` links are dangling.
   */
  linkTarget: z.enum(['file', 'directory', 'missing', 'outside']).optional(),
});
export type FileEntry = z.infer<typeof fileEntrySchema>;

export const listFilesQuerySchema = z.object({
  path: filePathSchema.default(''),
  /** `show` also returns entries hidden by ignore rules, each marked `ignored`. The always-hidden folders stay hidden. */
  ignored: z.enum(['hide', 'show']).default('hide'),
});

export const fileListingSchema = z.object({
  path: z.string(),
  /** Folders first, then by name. */
  entries: z.array(fileEntrySchema),
  /** More entries exist than the server returns for one folder. */
  truncated: z.boolean(),
});
export type FileListing = z.infer<typeof fileListingSchema>;

export type FileTreeNode = FileEntry & {
  /** Present for folders that were read. */
  children?: FileTreeNode[];
  /** The folder was not read (depth or entry limit): list it on demand. */
  childrenOmitted?: boolean;
};

export const fileTreeNodeSchema: z.ZodType<FileTreeNode> = fileEntrySchema.extend({
  children: z.lazy(() => z.array(fileTreeNodeSchema)).optional(),
  childrenOmitted: z.boolean().optional(),
});

export const fileTreeQuerySchema = z.object({
  path: filePathSchema.default(''),
  depth: z.coerce.number().int().min(1).max(32).optional(),
  limit: z.coerce.number().int().min(1).max(100_000).optional(),
});

export const fileTreeSchema = z.object({
  path: z.string(),
  entries: z.array(fileTreeNodeSchema),
  entryCount: z.number().int(),
  /** The tree is incomplete; `truncatedBy` says which limit cut it. */
  truncated: z.boolean(),
  truncatedBy: z.enum(['entries', 'depth']).nullable(),
  limits: z.object({ depth: z.number().int(), entries: z.number().int() }),
});
export type FileTree = z.infer<typeof fileTreeSchema>;

// ---- searching -----------------------------------------------------------------

export const searchFileNamesQuerySchema = z.object({
  query: z.string().trim().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(200).default(10),
});

export const fileNameMatchSchema = z.object({
  path: z.string(),
  name: z.string(),
  kind: z.enum(['file', 'directory']),
});
export type FileNameMatch = z.infer<typeof fileNameMatchSchema>;

export const fileNameSearchSchema = z.object({
  query: z.string(),
  /** Best matches first: name starts with the query, name contains it, path contains it. */
  results: z.array(fileNameMatchSchema),
  /** The search stopped before it had looked at every file. */
  truncated: z.boolean(),
});
export type FileNameSearch = z.infer<typeof fileNameSearchSchema>;

export const searchFileContentQuerySchema = z.object({
  /** Literal text; never a pattern. */
  query: z.string().min(1).max(200),
  caseSensitive: z.enum(['true', 'false']).default('false'),
  /** Restrict the search to one folder. */
  path: filePathSchema.default(''),
  limit: z.coerce.number().int().min(1).max(2000).default(200),
});

export const fileContentMatchSchema = z.object({
  path: z.string(),
  /** 1-based. */
  line: z.number().int().positive(),
  /** The matching line, shortened when it is very long. */
  text: z.string(),
});
export type FileContentMatch = z.infer<typeof fileContentMatchSchema>;

export const fileContentSearchSchema = z.object({
  query: z.string(),
  matches: z.array(fileContentMatchSchema),
  truncated: z.boolean(),
  /** `git` searched tracked and untracked-but-not-ignored files; `scan` walked the folder. */
  engine: z.enum(['git', 'scan']),
});
export type FileContentSearch = z.infer<typeof fileContentSearchSchema>;

// ---- reading -------------------------------------------------------------------

export const readFileQuerySchema = z.object({ path: filePathSchema });

const fileFacts = {
  path: z.string(),
  size: z.number().nonnegative(),
  modifiedAt: timestampSchema,
  /**
   * Changes whenever the file does. Send it back as `baseVersion` when saving
   * so that an edit made elsewhere in the meantime is not overwritten.
   */
  version: z.string(),
};

export const fileContentSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('text'),
    ...fileFacts,
    /** Exactly the file's text (UTF-8), line endings and byte-order mark included. */
    content: z.string(),
    lineEnding: z.enum(['lf', 'crlf', 'mixed', 'none']),
  }),
  /** Not valid UTF-8 text. Offer a download or a preview instead. */
  z.object({ kind: z.literal('binary'), ...fileFacts, previewable: z.boolean(), mediaType: z.string() }),
  /** Text, but larger than the editor limit. */
  z.object({ kind: z.literal('too_large'), ...fileFacts, limit: z.number().int() }),
]);
export type FileContent = z.infer<typeof fileContentSchema>;

export const rawFileQuerySchema = z.object({
  path: filePathSchema,
  /**
   * `attachment` (default) downloads. `inline` is honoured only for an
   * allow-list of image, audio, video and PDF types and is always served
   * sandboxed; anything else answers 415.
   */
  disposition: z.enum(['attachment', 'inline']).default('attachment'),
});

export const archiveQuerySchema = z.object({ path: filePathSchema.default('') });

// ---- writing -------------------------------------------------------------------

export const saveFileRequestSchema = z.object({
  path: filePathSchema.min(1),
  content: z.string(),
  /**
   * The `version` the content was loaded with, or null when the file is
   * expected not to exist yet. A mismatch answers 409 and writes nothing.
   */
  baseVersion: z.string().max(128).nullable(),
  /** Overwrite whatever is there. Use only after the user chose to. */
  force: z.boolean().default(false),
});
export type SaveFileRequest = z.infer<typeof saveFileRequestSchema>;

export const savedFileSchema = z.object({
  path: z.string(),
  size: z.number().nonnegative(),
  modifiedAt: timestampSchema,
  version: z.string(),
  created: z.boolean(),
});
export type SavedFile = z.infer<typeof savedFileSchema>;

export const createEntryRequestSchema = z.object({
  /** Folder to create in; it must exist. */
  parent: filePathSchema.default(''),
  name: z.string().max(255),
  kind: z.enum(['file', 'directory']),
});
export type CreateEntryRequest = z.infer<typeof createEntryRequestSchema>;

export const moveEntryRequestSchema = z.object({
  from: filePathSchema.min(1),
  /** The new project-relative path. Its folder must exist; nothing is overwritten. */
  to: filePathSchema.min(1),
});
export type MoveEntryRequest = z.infer<typeof moveEntryRequestSchema>;

export const deleteEntryRequestSchema = z.object({
  path: filePathSchema.min(1),
  /** Required to delete a folder that is not empty. */
  recursive: z.boolean().default(false),
});
export type DeleteEntryRequest = z.infer<typeof deleteEntryRequestSchema>;

export const uploadQuerySchema = z.object({
  /** Folder to upload into; created when missing. */
  target: filePathSchema.default(''),
  overwrite: z.enum(['true', 'false']).default('false'),
});

/**
 * Uploads are `multipart/form-data`. Each file is a part named `file`. To
 * recreate a folder structure, send a text part named `path` (the file's
 * relative path, forward slashes) immediately before the file it belongs to.
 */
export const UPLOAD_FILE_FIELD = 'file';
export const UPLOAD_PATH_FIELD = 'path';

export const uploadSkipReasonSchema = z.enum(['invalid_name', 'outside_project', 'protected', 'exists', 'is_directory']);

export const uploadResultSchema = z.object({
  target: z.string(),
  /** How many file parts the request carried. */
  requested: z.number().int(),
  stored: z.array(z.object({ path: z.string(), size: z.number().nonnegative(), replaced: z.boolean() })),
  /** Files that were not written, each with the reason. The other files are stored regardless. */
  skipped: z.array(z.object({ name: z.string(), reason: uploadSkipReasonSchema })),
});
export type UploadResult = z.infer<typeof uploadResultSchema>;

// ---- events --------------------------------------------------------------------

/** Published on the project's topic after the Studio itself changed files. */
export const FILES_CHANGED = 'files.changed';

export const filesChangedEventSchema = z.object({
  projectId: idSchema,
  /** `tree` means "many things may have changed": re-read what is on screen. */
  kind: z.enum(['saved', 'created', 'moved', 'deleted', 'uploaded', 'tree']),
  /** Project-relative paths that changed; empty for `tree`. */
  paths: z.array(z.string()),
  /** Who did it. */
  userId: idSchema.nullable(),
});
export type FilesChangedEvent = z.infer<typeof filesChangedEventSchema>;
