import type { FastifyBaseLogger } from 'fastify';
import type { StudioConfig } from './config.js';
import type { Database, Migration } from './database.js';
import type { EventBus } from './events.js';
import type { HttpKernel } from './http.js';
import type { ProcessSupervisor, Sandbox } from './process.js';
import type { RealtimeHub } from './realtime.js';
import type { KeyRing, SecretStore } from './secrets.js';

/**
 * Services that modules offer each other. A module adds its own entry by
 * declaration merging:
 *
 *   declare module '../../kernel/module.js' {
 *     interface Services { projects: ProjectsService }
 *   }
 *
 * and assigns it during `setup`. Modules are set up in the order they are
 * listed, so a module may use the services of those listed before it during
 * setup, and any service from `start` onwards.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Services {}

export interface ModuleContext {
  readonly config: StudioConfig;
  readonly db: Database;
  readonly bus: EventBus;
  readonly log: FastifyBaseLogger;
  readonly http: HttpKernel;
  readonly realtime: RealtimeHub;
  readonly processes: ProcessSupervisor;
  readonly sandbox: Sandbox;
  readonly secrets: SecretStore;
  readonly keys: KeyRing;
  readonly services: Services;
}

export interface StudioModule {
  /** Unique; also the namespace of the module's migrations. */
  readonly name: string;
  readonly migrations?: readonly Migration[];
  /** Create services and register routes and realtime topics. */
  setup(context: ModuleContext): void | Promise<void>;
  /** Runs after every module is set up and before the server accepts connections. */
  start?(context: ModuleContext): void | Promise<void>;
  /** Runs on shutdown, in reverse order. */
  stop?(context: ModuleContext): void | Promise<void>;
}
