import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { StudioConfig } from './config.js';
import { Database } from './database.js';
import { describeError } from './errors.js';
import { EventBus } from './events.js';
import { HttpKernel } from './http.js';
import type { ModuleContext, Services, StudioModule } from './module.js';
import { ProcessSupervisor, Sandbox } from './process.js';
import { RealtimeHub } from './realtime.js';
import { KeyRing, SECRETS_MIGRATIONS, SecretStore, loadMasterKey, prepareDataDir } from './secrets.js';

export interface Studio {
  readonly app: FastifyInstance;
  readonly context: ModuleContext;
  /** Starts modules and begins listening. Resolves with the address actually bound. */
  start(): Promise<{ url: string; port: number }>;
  stop(): Promise<void>;
}

/**
 * Composition root: builds the kernel, then lets each module set itself up.
 * Nothing is global — a test can create as many independent Studios as it
 * likes, each with its own data directory.
 */
export async function createStudio(config: StudioConfig, modules: readonly StudioModule[]): Promise<Studio> {
  prepareDataDir(config.dataDir);
  const db = new Database(path.join(config.dataDir, 'studio.db'));
  const keys = new KeyRing(loadMasterKey(config));
  db.migrate('kernel.secrets', SECRETS_MIGRATIONS);

  const http = new HttpKernel(config);
  const log = http.app.log;
  const bus = new EventBus();
  bus.setErrorHandler((error, event) => {
    log.error({ err: describeError(error), topic: event.topic, type: event.type }, 'event handler failed');
  });

  await http.init();
  const realtime = new RealtimeHub(http, bus, log);
  const sandbox = await Sandbox.detect(config.sandbox, [config.dataDir]);
  if (sandbox.status.mode === 'none') {
    log.warn({ reason: sandbox.status.reason }, 'agent processes will run without a sandbox');
  }

  const context: ModuleContext = {
    config,
    db,
    bus,
    log,
    http,
    realtime,
    processes: new ProcessSupervisor(config.childEnvPassthrough),
    sandbox,
    secrets: new SecretStore(db, keys),
    keys,
    services: {} as Services,
  };

  const names = new Set<string>();
  for (const module of modules) {
    if (names.has(module.name)) throw new Error(`Module "${module.name}" is listed twice.`);
    names.add(module.name);
    if (module.migrations) db.migrate(module.name, module.migrations);
  }
  for (const module of modules) await module.setup(context);
  realtime.mount();

  let started = false;
  let stopped = false;
  return {
    app: http.app,
    context,
    async start() {
      for (const module of modules) await module.start?.(context);
      started = true;
      await http.app.listen({ host: config.host, port: config.port });
      const address = http.app.server.address();
      const port = typeof address === 'object' && address ? address.port : config.port;
      const host = config.host.includes(':') ? `[${config.host}]` : config.host;
      return { url: `${config.tls ? 'https' : 'http'}://${host}:${port}`, port };
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      if (started) {
        for (const module of [...modules].reverse()) {
          try {
            await module.stop?.(context);
          } catch (error) {
            log.error({ err: describeError(error), module: module.name }, 'module failed to stop cleanly');
          }
        }
      }
      realtime.close();
      await context.processes.shutdown();
      await http.app.close();
      db.close();
    },
  };
}
