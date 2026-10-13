import type { StudioModule } from '../kernel/module.js';
import { authModule } from './auth/auth.module.js';
import { systemModule } from './system/system.module.js';

/**
 * Every module of the server, in set-up order. A module may rely on the
 * services of the modules listed before it.
 */
export const modules: readonly StudioModule[] = [authModule, systemModule];
