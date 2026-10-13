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
});
export type Project = z.infer<typeof projectSchema>;

export const projectNameSchema = z.string().trim().min(1).max(80);

export const createProjectRequestSchema = z.object({
  name: projectNameSchema,
  /** Absolute path, or a path starting with "~/". Must lie inside an allowed workspace root. */
  rootDir: z.string().min(1).max(1024),
  description: z.string().max(500).default(''),
  icon: projectIconSchema.optional(),
  /** Create the directory (and missing parents) when it does not exist yet. */
  createDirectory: z.boolean().default(false),
});
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;

export const updateProjectRequestSchema = z
  .object({
    name: projectNameSchema,
    description: z.string().max(500),
    icon: projectIconSchema,
    archived: z.boolean(),
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
