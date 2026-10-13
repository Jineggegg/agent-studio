import {
  createProjectRequestSchema,
  idSchema,
  projectTopic,
  setProjectMemberRequestSchema,
  updateProjectRequestSchema,
} from '@agent-studio/protocol';
import { z } from 'zod';
import type { ModuleContext, StudioModule } from '../../kernel/module.js';
import { PROJECTS_MIGRATIONS, ProjectsService } from './projects.service.js';

declare module '../../kernel/module.js' {
  interface Services {
    projects: ProjectsService;
  }
}

const projectParams = z.object({ projectId: idSchema });
const memberParams = z.object({ projectId: idSchema, userId: idSchema });
const listQuery = z.object({ archived: z.enum(['include', 'exclude']).default('exclude') });

export const projectsModule: StudioModule = {
  name: 'projects',
  migrations: PROJECTS_MIGRATIONS,

  setup(context: ModuleContext) {
    const { http, realtime } = context;
    const projects = new ProjectsService(context);
    context.services.projects = projects;

    realtime.registerTopic({
      kind: 'project',
      authorize: (principal, projectId) => projects.accessOf(principal, projectId) !== null,
    });

    http.route({
      method: 'GET',
      url: '/api/projects',
      access: 'user',
      query: listQuery,
      handler: ({ user, query }) => ({ projects: projects.list(user, { includeArchived: query.archived === 'include' }) }),
    });

    http.route({
      method: 'POST',
      url: '/api/projects',
      access: 'owner',
      body: createProjectRequestSchema,
      handler: async ({ user, body, reply }) => {
        const project = await projects.create(user, body);
        void reply.status(201);
        return project;
      },
    });

    http.route({
      method: 'GET',
      url: '/api/projects/:projectId',
      access: 'user',
      params: projectParams,
      handler: ({ user, params }) => {
        const record = projects.requireAccess(user, params.projectId);
        return projects.present(record, projects.accessOf(user, params.projectId)!);
      },
    });

    http.route({
      method: 'PATCH',
      url: '/api/projects/:projectId',
      access: 'user',
      params: projectParams,
      body: updateProjectRequestSchema,
      handler: ({ user, params, body }) => projects.update(user, params.projectId, body),
    });

    http.route({
      method: 'DELETE',
      url: '/api/projects/:projectId',
      access: 'owner',
      params: projectParams,
      handler: ({ user, params }) => projects.remove(user, params.projectId),
    });

    // ---- sharing (owner only) ----
    http.route({
      method: 'GET',
      url: '/api/projects/:projectId/members',
      access: 'owner',
      params: projectParams,
      handler: ({ user, params }) => {
        projects.requireAccess(user, params.projectId);
        return { members: projects.members(params.projectId) };
      },
    });
    http.route({
      method: 'PUT',
      url: '/api/projects/:projectId/members/:userId',
      access: 'owner',
      params: memberParams,
      body: setProjectMemberRequestSchema,
      handler: ({ params, body }) => projects.setMember(params.projectId, params.userId, body.access),
    });
    http.route({
      method: 'DELETE',
      url: '/api/projects/:projectId/members/:userId',
      access: 'owner',
      params: memberParams,
      handler: ({ params }) => projects.setMember(params.projectId, params.userId, null),
    });

    void projectTopic;
  },
};
