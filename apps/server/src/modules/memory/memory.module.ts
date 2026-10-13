import path from 'node:path';
import {
  createMemoryNoteRequestSchema,
  deleteMemoryNoteQuerySchema,
  memoryListQuerySchema,
  memoryNoteQuerySchema,
  memorySearchQuerySchema,
  memorySettingsRequestSchema,
  memoryTagsQuerySchema,
  moveMemoryNoteRequestSchema,
  updateMemoryNoteRequestSchema,
} from '@agent-studio/protocol';
import type { ModuleContext, StudioModule } from '../../kernel/module.js';
import { MemoryService } from './memory.service.js';
import { MEMORY_MIGRATIONS, MemoryStore } from './memory.store.js';
import { registerMemoryTools } from './memory.tools.js';

/**
 * Shared memory: Markdown notes that the user and every assistant read and
 * write.
 *
 * - `memory.store.ts`   the note files under `<dataDir>/memory` and their index
 * - `memory.service.ts` who may see and change what; `context.services.memory`
 * - `memory.tools.ts`   the tools offered to agents
 * - this file           the REST API for the app
 *
 * Saved notes are large for JSON; the two routes that carry a body allow 512 KiB.
 */
const NOTE_BODY_LIMIT = 512 * 1024;

export const memoryModule: StudioModule = {
  name: 'memory',
  migrations: MEMORY_MIGRATIONS,

  setup(context: ModuleContext) {
    const { http, bus, realtime } = context;
    const store = new MemoryStore({ db: context.db, rootDir: path.join(context.config.dataDir, 'memory'), log: context.log });
    const memory = new MemoryService(context, store);
    context.services.memory = memory;

    registerMemoryTools(context.agentTools, memory, context.log);

    // A folder's live updates go to those who may read the folder.
    realtime.registerTopic({ kind: 'memory', authorize: (principal, folder) => memory.canSee(principal, folder) });

    // A new project gets its folder name straight away, so names are handed out in the order projects are added.
    bus.on('project.created', (event) => {
      const project = context.services.projects.find((event.data as { projectId: string }).projectId);
      if (project) memory.folderOfProject(project);
    });
    // A removed project keeps its notes; its folder just stops belonging to a project.
    bus.on('project.deleted', (event) => {
      memory.releaseProject((event.data as { projectId: string }).projectId);
    });

    http.route({
      method: 'GET',
      url: '/api/memory/status',
      access: 'user',
      handler: ({ user }) => memory.status(user),
    });
    http.route({
      method: 'PUT',
      url: '/api/memory/settings',
      access: 'owner',
      body: memorySettingsRequestSchema,
      handler: ({ user, body }) => {
        memory.setAgentAccess(user, body.agentAccess);
        return memory.status(user);
      },
    });
    http.route({
      method: 'POST',
      url: '/api/memory/reindex',
      access: 'owner',
      rateLimit: { max: 6, windowMs: 60_000 },
      handler: ({ user }) => memory.rebuild(user),
    });

    http.route({
      method: 'GET',
      url: '/api/memory/folders',
      access: 'user',
      handler: ({ user }) => memory.folders(user),
    });
    http.route({
      method: 'GET',
      url: '/api/memory/notes',
      access: 'user',
      query: memoryListQuerySchema,
      handler: ({ user, query }) => memory.recent(user, query),
    });
    http.route({
      method: 'GET',
      url: '/api/memory/search',
      access: 'user',
      query: memorySearchQuerySchema,
      handler: ({ user, query }) => memory.search(user, query),
    });
    http.route({
      method: 'GET',
      url: '/api/memory/tags',
      access: 'user',
      query: memoryTagsQuerySchema,
      handler: ({ user, query }) => memory.tags(user, query.folder),
    });

    http.route({
      method: 'GET',
      url: '/api/memory/note',
      access: 'user',
      query: memoryNoteQuerySchema,
      handler: ({ user, query }) => memory.read(user, query.id),
    });
    http.route({
      method: 'POST',
      url: '/api/memory/notes',
      access: 'user',
      body: createMemoryNoteRequestSchema,
      bodyLimit: NOTE_BODY_LIMIT,
      handler: async ({ user, body, reply }) => {
        const note = await memory.create(user, body);
        void reply.status(201);
        return note;
      },
    });
    http.route({
      method: 'PUT',
      url: '/api/memory/note',
      access: 'user',
      body: updateMemoryNoteRequestSchema,
      bodyLimit: NOTE_BODY_LIMIT,
      handler: ({ user, body }) => memory.update(user, body),
    });
    http.route({
      method: 'POST',
      url: '/api/memory/note/move',
      access: 'user',
      body: moveMemoryNoteRequestSchema,
      handler: ({ user, body }) => memory.move(user, body),
    });
    http.route({
      method: 'DELETE',
      url: '/api/memory/note',
      access: 'user',
      query: deleteMemoryNoteQuerySchema,
      handler: ({ user, query }) => memory.remove(user, query.id, query.version),
    });
  },

  /** The index is brought in line with the note files before the server takes requests. A failure is logged, not fatal. */
  async start(context: ModuleContext) {
    await context.services.memory.warmUp();
  },

  /** Lets a write or a walk of the files that is under way finish before the database closes. */
  async stop(context: ModuleContext) {
    await context.services.memory.settle();
  },
};
