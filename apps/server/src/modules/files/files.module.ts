import multipart from '@fastify/multipart';
import {
  FILES_CHANGED,
  UPLOAD_FILE_FIELD,
  UPLOAD_PATH_FIELD,
  archiveQuerySchema,
  createEntryRequestSchema,
  deleteEntryRequestSchema,
  fileTreeQuerySchema,
  idSchema,
  listFilesQuerySchema,
  moveEntryRequestSchema,
  projectTopic,
  rawFileQuerySchema,
  readFileQuerySchema,
  saveFileRequestSchema,
  searchFileContentQuerySchema,
  searchFileNamesQuerySchema,
  uploadQuerySchema,
  type FilesChangedEvent,
} from '@agent-studio/protocol';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ModuleContext, StudioModule } from '../../kernel/module.js';
import type { Principal } from '../../kernel/principal.js';
import { FilesService, type UploadPart } from './files.service.js';
import { DOWNLOAD_CSP, contentDisposition } from './media.js';

declare module '../../kernel/module.js' {
  interface Services {
    files: FilesService;
  }
}

const projectParams = z.object({ projectId: idSchema });

/**
 * The files of a project. Every route names a project and a project-relative
 * path; the project check comes first (a project the caller cannot see is
 * "not found"), reading needs read access and every change needs write access.
 */
export const filesModule: StudioModule = {
  name: 'files',

  async setup(context: ModuleContext) {
    const { http, bus } = context;
    const files = new FilesService(context);
    context.services.files = files;

    // Uploads arrive as multipart/form-data. Another feature may have registered the parser already.
    if (!http.app.hasContentTypeParser('multipart/form-data')) {
      await http.app.register(multipart, { limits: { fieldNameSize: 100, fieldSize: 8192, headerPairs: 200 } });
    }

    const projects = () => context.services.projects;
    const readable = (user: Principal, projectId: string) => projects().requireAccess(user, projectId, 'read').rootDir;
    const writable = (user: Principal, projectId: string) => projects().requireAccess(user, projectId, 'write').rootDir;
    const changed = (projectId: string, user: Principal, kind: FilesChangedEvent['kind'], paths: string[]): void => {
      const event: FilesChangedEvent = { projectId, kind, paths, userId: user.userId };
      bus.publish(projectTopic(projectId), FILES_CHANGED, event);
    };

    const base = '/api/projects/:projectId/files';

    http.route({
      method: 'GET',
      url: '/api/files/limits',
      access: 'user',
      handler: () => ({ ...files.limits }),
    });

    // ---- looking ----
    http.route({
      method: 'GET',
      url: `${base}/list`,
      access: 'user',
      params: projectParams,
      query: listFilesQuerySchema,
      handler: ({ user, params, query }) => files.list(readable(user, params.projectId), query.path, query.ignored === 'show'),
    });
    http.route({
      method: 'GET',
      url: `${base}/tree`,
      access: 'user',
      params: projectParams,
      query: fileTreeQuerySchema,
      handler: ({ user, params, query }) => files.tree(readable(user, params.projectId), query.path, query.depth, query.limit),
    });
    http.route({
      method: 'GET',
      url: `${base}/search`,
      access: 'user',
      params: projectParams,
      query: searchFileNamesQuerySchema,
      handler: ({ user, params, query }) => files.searchNames(readable(user, params.projectId), query.query, query.limit),
    });
    http.route({
      method: 'GET',
      url: `${base}/grep`,
      access: 'user',
      params: projectParams,
      query: searchFileContentQuerySchema,
      rateLimit: { max: 120, windowMs: 60_000 },
      handler: ({ user, params, query }) =>
        files.searchContent(readable(user, params.projectId), {
          query: query.query,
          caseSensitive: query.caseSensitive === 'true',
          path: query.path,
          limit: query.limit,
        }),
    });

    // ---- reading ----
    http.route({
      method: 'GET',
      url: `${base}/content`,
      access: 'user',
      params: projectParams,
      query: readFileQuerySchema,
      handler: ({ user, params, query }) => files.read(readable(user, params.projectId), query.path),
    });
    http.route({
      method: 'GET',
      url: `${base}/raw`,
      access: 'user',
      params: projectParams,
      query: rawFileQuerySchema,
      handler: async ({ user, params, query, request, reply }) => {
        const range = typeof request.headers.range === 'string' ? request.headers.range : undefined;
        const file = await files.raw(readable(user, params.projectId), query.path, query.disposition, range);
        void reply.status(file.status).headers(file.headers);
        return file.stream;
      },
    });
    http.route({
      method: 'GET',
      url: `${base}/archive`,
      access: 'user',
      params: projectParams,
      query: archiveQuerySchema,
      rateLimit: { max: 20, windowMs: 60_000 },
      handler: async ({ user, params, query, reply }) => {
        const archive = await files.archive(readable(user, params.projectId), query.path);
        void reply.headers({
          'content-type': 'application/zip',
          'content-disposition': contentDisposition('attachment', archive.fileName),
          'content-security-policy': DOWNLOAD_CSP,
          'x-content-type-options': 'nosniff',
        });
        return archive.stream;
      },
    });

    // ---- changing ----
    http.route({
      method: 'PUT',
      url: `${base}/content`,
      access: 'user',
      params: projectParams,
      body: saveFileRequestSchema,
      // JSON escaping can roughly double the size of a text on the wire.
      bodyLimit: files.limits.maxTextBytes * 2 + 64 * 1024,
      handler: async ({ user, params, body }) => {
        const saved = await files.save(writable(user, params.projectId), body);
        changed(params.projectId, user, saved.created ? 'created' : 'saved', [saved.path]);
        return saved;
      },
    });
    http.route({
      method: 'POST',
      url: `${base}/entries`,
      access: 'user',
      params: projectParams,
      body: createEntryRequestSchema,
      handler: async ({ user, params, body, reply }) => {
        const entry = await files.create(writable(user, params.projectId), body);
        changed(params.projectId, user, 'created', [entry.path]);
        void reply.status(201);
        return entry;
      },
    });
    http.route({
      method: 'POST',
      url: `${base}/move`,
      access: 'user',
      params: projectParams,
      body: moveEntryRequestSchema,
      handler: async ({ user, params, body }) => {
        const moved = await files.move(writable(user, params.projectId), body);
        if (moved.from !== moved.entry.path) changed(params.projectId, user, 'moved', [moved.from, moved.entry.path]);
        return moved;
      },
    });
    http.route({
      method: 'POST',
      url: `${base}/delete`,
      access: 'user',
      params: projectParams,
      body: deleteEntryRequestSchema,
      handler: async ({ user, params, body }) => {
        const removed = await files.remove(writable(user, params.projectId), body);
        changed(params.projectId, user, 'deleted', [removed]);
      },
    });

    /** The file parts of a multipart request, each paired with the path declared just before it. */
    async function* uploadParts(request: FastifyRequest): AsyncGenerator<UploadPart> {
      const declared: string[] = [];
      const parts = request.parts({
        limits: {
          fileSize: files.limits.maxUploadFileBytes,
          // One more than allowed, so that the service — not the parser — words the refusal.
          files: files.limits.maxUploadFiles + 1,
          fields: files.limits.maxUploadFiles + 10,
          parts: files.limits.maxUploadFiles * 2 + 20,
          fieldSize: 8192,
        },
      });
      for await (const part of parts) {
        if (part.type === 'field') {
          if (part.fieldname === UPLOAD_PATH_FIELD && typeof part.value === 'string') declared.push(part.value);
          continue;
        }
        if (part.fieldname !== UPLOAD_FILE_FIELD) {
          part.file.resume();
          continue;
        }
        yield { name: declared.shift() ?? part.filename, stream: part.file };
      }
    }

    http.route({
      method: 'POST',
      url: `${base}/upload`,
      access: 'user',
      params: projectParams,
      query: uploadQuerySchema,
      handler: async ({ user, params, query, request }) => {
        const rootDir = writable(user, params.projectId);
        const result = await files.upload(rootDir, query.target, query.overwrite === 'true', uploadParts(request));
        if (result.stored.length > 0) changed(params.projectId, user, 'uploaded', result.stored.map((entry) => entry.path));
        return result;
      },
    });
  },
};
