import type { ModuleContext, StudioModule } from '../../kernel/module.js';
import { VERSION } from '../../kernel/version.js';

/** Liveness for load balancers and tunnels, and a description of the instance for signed-in clients. */
export const systemModule: StudioModule = {
  name: 'system',

  setup(context: ModuleContext) {
    const { http, config, sandbox } = context;
    const startedAt = Date.now();

    // Deliberately says nothing an anonymous visitor could use.
    http.route({
      method: 'GET',
      url: '/api/health',
      access: 'public',
      handler: () => ({ status: 'ok' }),
    });

    http.route({
      method: 'GET',
      url: '/api/system/info',
      access: 'user',
      handler: ({ user }) => ({
        version: VERSION,
        startedAt,
        sandbox: sandbox.status,
        terminalEnabled: config.terminalEnabled,
        ...(user.role === 'owner'
          ? {
              node: process.version,
              platform: process.platform,
              publicOrigins: config.publicOrigins,
              workspaceRoots: config.workspaceRoots,
            }
          : {}),
      }),
    });
  },
};
