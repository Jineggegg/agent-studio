import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** The server's version, read from its package manifest. */
export const VERSION: string = (require('../../package.json') as { version: string }).version;
